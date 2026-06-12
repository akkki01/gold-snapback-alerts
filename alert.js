#!/usr/bin/env node
/* ============================================================
   GOLD SNAPBACK — live Telegram alert watcher
   Completely separate from the ICT Silver Bullet system.

   Live detection re-runs the EXACT strategy.js used by the
   backtest on a merged candle stream:
     · overnight history  — Dukascopy 1m candles (lags ~1h)
     · freshest candles   — built live from spot polling
       (gold-api.com every 5s), feeds auto-aligned by offset

   Commands:
     node alert.js                 run the watcher
     node alert.js --test          send a test Telegram message
     node alert.js --dry <file>    replay a data file, print alerts
     node alert.js --for <min>     exit after N minutes (cloud runs)
     node alert.js --quiet         no startup message

   Config: config.json (gitignored) or env TELEGRAM_BOT_TOKEN /
   TELEGRAM_CHAT_ID. Optional SIGNALS_PATH appends fired alerts
   to a JSON file (used by the dashboard).
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const snap = require('./strategy.js');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const FEED_URL = 'https://api.gold-api.com/price/XAU';
const HISTORY_HOURS = 26;

/* ---------------- config / args ---------------- */

function loadConfig() {
  const def = { botToken: '', chatId: '', balance: 10000, riskPct: 1, pollSeconds: 5 };
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* no config yet */ }
  const cfg = { ...def, ...file };
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) cfg.chatId = process.env.TELEGRAM_CHAT_ID;
  return cfg;
}
const cfg = loadConfig();

const ARGV = process.argv.slice(2);
const has = f => ARGV.includes(f);
const valOf = f => { const i = ARGV.indexOf(f); return i >= 0 ? ARGV[i + 1] : null; };
const DRY = has('--dry');
const QUIET = has('--quiet');
const FOR_MIN = +(valOf('--for') || 0);
const SIGNALS_PATH = process.env.SIGNALS_PATH || null;

/* ---------------- telegram ---------------- */

async function tg(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
  return j.result;
}
async function send(text) {
  if (DRY) {
    console.log('┌─ TELEGRAM ─────────────────────────────');
    console.log(text.replace(/<[^>]+>/g, '').split('\n').map(l => '│ ' + l).join('\n'));
    console.log('└────────────────────────────────────────');
    return;
  }
  await tg('sendMessage', { chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}
let sendChain = Promise.resolve();
function queueSend(text) {
  sendChain = sendChain.then(() => send(text)).catch(e => log(`telegram send failed: ${e.message}`));
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const log = msg => console.log(`${new Date().toISOString()} ${msg}`);

/* ---------------- NY time ---------------- */

const nyFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const offsetCache = new Map();
function nyParts(ts) {
  const utcDay = Math.floor(ts / 86400000);
  let off = offsetCache.get(utcDay);
  if (off === undefined) {
    const p = nyFmt.formatToParts(new Date(ts));
    const g = t => +p.find(x => x.type === t).value;
    off = (g('hour') % 24) * 60 + g('minute') - (Math.floor(ts / 60000) % 1440);
    if (off > 720) off -= 1440;
    if (off < -720) off += 1440;
    offsetCache.set(utcDay, off);
  }
  const m = Math.floor(ts / 60000) + off;
  return { mod: ((m % 1440) + 1440) % 1440, day: Math.floor(m / 1440) };
}
function fmtClock(mod) {
  const h24 = Math.floor(mod / 60) % 24, m = mod % 60;
  const ap = h24 >= 12 ? 'PM' : 'AM', h = ((h24 + 11) % 12) + 1;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}

/* ---------------- detection: diff strategy.run() output ---------------- */

const known = new Map(); // trade ts -> { status, beArmed }
let startTs = 0;         // only alert trades born after the watcher started

function describe(t) {
  const { mod } = nyParts(t.ts);
  return `${t.side} XAUUSD · ${esc(t.window)} · ${fmtClock(mod)} NY`;
}

function signalCard(t) {
  const riskAmt = cfg.balance * cfg.riskPct / 100;
  const lots = riskAmt / (t.risk * 100); // 1 lot = 100 oz → $100 per $1 move
  return `🪤 <b>SNAPBACK — ${t.side} XAUUSD</b>\n${describe(t)}\n\n` +
    `Entry  <code>${t.entry.toFixed(2)}</code>\n` +
    `SL     <code>${t.sl.toFixed(2)}</code>  ($${t.risk.toFixed(2)} risk)\n` +
    `TP     <code>${t.tp.toFixed(2)}</code>  (${t.rr.toFixed(1)}R)\n\n` +
    `Size @ ${cfg.riskPct}% of $${cfg.balance.toLocaleString('en-US')} → ` +
    `<b>${lots.toFixed(2)} lots</b> (${(lots * 100).toFixed(1)} oz, $${riskAmt.toFixed(2)} risk)\n\n` +
    `🔒 When price reaches <code>${(t.dir === 1 ? t.entry + 0.3 * t.risk : t.entry - 0.3 * t.risk).toFixed(2)}</code>, move SL to entry.`;
}

function recordSignal(t, event) {
  if (!SIGNALS_PATH) return;
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(SIGNALS_PATH, 'utf8')); } catch { /* fresh file */ }
  arr.push({ at: new Date().toISOString(), event, ts: t.ts, window: t.window, side: t.side, entry: t.entry, sl: t.sl, tp: t.tp, risk: t.risk, rr: t.rr, status: t.status });
  fs.writeFileSync(SIGNALS_PATH, JSON.stringify(arr.slice(-500), null, 1));
}

function detect(candles) {
  const trades = snap.run(candles, {});
  for (const t of trades) {
    if (t.ts < startTs) { known.set(t.ts, { status: t.status, beArmed: !!t.beArmed }); continue; }
    const prev = known.get(t.ts);
    if (!prev) {
      known.set(t.ts, { status: t.status, beArmed: !!t.beArmed });
      log(`SIGNAL ${t.side} entry ${t.entry} SL ${t.sl} TP ${t.tp}`);
      queueSend(signalCard(t));
      recordSignal(t, 'ENTRY');
      if (t.status !== 'OPEN') announceResult(t); // resolved within the same batch
      continue;
    }
    if (!prev.beArmed && t.beArmed && t.status === 'OPEN') {
      prev.beArmed = true;
      queueSend(`🔒 <b>BREAKEVEN LOCK</b>\n${describe(t)}\nMove SL to entry <code>${t.entry.toFixed(2)}</code> — this trade can no longer lose.`);
      recordSignal(t, 'BREAKEVEN');
    }
    if (prev.status !== t.status) {
      prev.status = t.status;
      announceResult(t);
      recordSignal(t, t.status);
    }
  }
}

function announceResult(t) {
  const msg = t.status === 'WIN' ? `✅ <b>TP HIT (+${t.rr.toFixed(1)}R)</b>`
    : t.status === 'SCRATCH' ? '⚪ <b>BREAKEVEN EXIT (0R)</b>'
    : t.status === 'LOSS' ? '❌ <b>SL HIT (−1R)</b>' : null;
  if (msg) queueSend(`${msg}\n${describe(t)}\nEntry <code>${t.entry.toFixed(2)}</code> → ${t.status === 'WIN' ? `TP <code>${t.tp.toFixed(2)}</code>` : `exit <code>${t.sl.toFixed(2)}</code>`}`);
}

/* ---------------- candle assembly ---------------- */

let history = [];   // dukascopy candles (offset-corrected)
let live = [];      // candles built from spot polling
let forming = null;

function mergedCandles() {
  const seen = new Set();
  const out = [];
  for (const c of [...history, ...live].sort((a, b) => a.ts - b.ts)) {
    const key = Math.floor(c.ts / 60000);
    if (seen.has(key)) continue;
    seen.add(key);
    const { mod, day } = nyParts(c.ts);
    out.push({ mod, day, ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c });
  }
  return out;
}

function feedPrice(p, now = Date.now()) {
  const key = Math.floor(now / 60000);
  if (!forming || forming.key !== key) {
    if (forming) {
      live.push(forming);
      if (live.length > 2000) live.splice(0, 500);
      detect(mergedCandles());
    }
    forming = { key, ts: key * 60000, o: p, h: p, l: p, c: p };
  } else {
    if (p > forming.h) forming.h = p;
    if (p < forming.l) forming.l = p;
    forming.c = p;
  }
}

async function fetchHistory() {
  const { getHistoricalRates } = require('dukascopy-node');
  const to = new Date();
  const from = new Date(to.getTime() - HISTORY_HOURS * 3600 * 1000);
  // dukascopy fetches hourly chunks and silently drops ones that fail, so a
  // flaky run can return a fraction of the span — retry and keep the best
  let rows = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const got = await getHistoricalRates({
      instrument: 'xauusd', dates: { from, to }, timeframe: 'm1', format: 'json',
    });
    if (got.length > rows.length) rows = got;
    if (rows.length >= 600) break;
    log(`history attempt ${attempt}: only ${got.length} candles — retrying`);
    await new Promise(r => setTimeout(r, 5000));
  }
  const fresh = rows.map(r => ({ ts: r.timestamp, o: r.open, h: r.high, l: r.low, c: r.close }));
  // align the bid feed to the live spot feed using overlapping minutes
  const liveByMin = new Map(live.map(c => [Math.floor(c.ts / 60000), c]));
  const diffs = [];
  for (const c of fresh) {
    const m = liveByMin.get(Math.floor(c.ts / 60000));
    if (m) diffs.push(m.c - c.c);
  }
  let off = 0;
  if (diffs.length >= 3) {
    diffs.sort((a, b) => a - b);
    off = diffs[Math.floor(diffs.length / 2)];
  }
  history = fresh.map(c => ({ ts: c.ts, o: c.o + off, h: c.h + off, l: c.l + off, c: c.c + off }));
  log(`history: ${history.length} candles (${HISTORY_HOURS}h), feed offset ${off >= 0 ? '+' : ''}${off.toFixed(2)} (${diffs.length} overlaps)`);
}

/* ---------------- run modes ---------------- */

function nextWindowText(nowTs) {
  const { mod } = nyParts(nowTs);
  let best = null;
  for (const W of snap.WINDOWS) {
    if (mod >= W.tradeStart && mod < W.tradeEnd) return `${W.name} window is OPEN now`;
    let wait = W.tradeStart - mod;
    if (wait <= 0) wait += 1440;
    if (!best || wait < best.wait) best = { W, wait };
  }
  return `next: ${best.W.name} in ${Math.floor(best.wait / 60)}h ${best.wait % 60}m`;
}

async function runWatcher() {
  if (!cfg.botToken || !cfg.chatId) {
    console.error('Missing botToken/chatId — set config.json or env vars.');
    process.exit(1);
  }
  const me = await tg('getMe', {});
  log(`telegram ok — @${me.username}`);
  startTs = Date.now();

  try { await fetchHistory(); } catch (e) { log(`history fetch failed: ${e.message} — will retry`); }
  detect(mergedCandles()); // prime `known` with historical trades, all muted

  if (!QUIET) queueSend(`🟢 <b>Snapback watcher online</b>\nXAUUSD range-fade · London 2–5 AM, NY 8–11 AM NY time\n${esc(nextWindowText(Date.now()))}`);
  if (FOR_MIN > 0) {
    setTimeout(async () => {
      const openOnes = [...known.entries()].filter(([, v]) => v.status === 'OPEN');
      if (openOnes.length) queueSend('⏳ Watcher shift ending with a trade still open — keep your SL/TP orders placed; close everything by 4:55 PM NY.');
      await sendChain;
      log(`--for ${FOR_MIN}m reached — exiting`);
      setTimeout(() => process.exit(0), 5000);
    }, FOR_MIN * 60 * 1000);
  }

  // refresh history every 30 min (dukascopy publishes with ~1h lag)
  setInterval(() => fetchHistory().catch(e => log(`history refresh failed: ${e.message}`)), 30 * 60 * 1000);

  let fails = 0, lastWarn = 0;
  const poll = async () => {
    try {
      const r = await fetch(FEED_URL);
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      if (!j || !isFinite(j.price)) throw new Error('bad payload');
      feedPrice(Math.round(j.price * 100) / 100);
      fails = 0;
    } catch (e) {
      fails++;
      if (fails === 5 && Date.now() - lastWarn > 3600 * 1000) {
        lastWarn = Date.now();
        queueSend(`⚠️ price feed unreachable (${esc(e.message)}) — retrying every ${cfg.pollSeconds}s`);
      }
    }
  };
  await poll();
  setInterval(poll, cfg.pollSeconds * 1000);
  log(`watching XAUUSD every ${cfg.pollSeconds}s — ${nextWindowText(Date.now())}`);
}

async function runDry() {
  const file = ARGV[ARGV.indexOf('--dry') + 1];
  if (!file) { console.error('usage: node alert.js --dry <xauusd-m1.json>'); process.exit(1); }
  const raw = require(path.resolve(file));
  const tail = raw.slice(-3 * 1440); // replay the last ~3 days minute by minute
  console.log(`DRY RUN — replaying ${tail.length} candles through the live pipeline; alerts print below.\n`);
  startTs = tail[Math.floor(tail.length / 2)].timestamp; // alert on the second half only
  for (const r of tail) {
    live.push({ ts: r.timestamp, o: r.open, h: r.high, l: r.low, c: r.close });
    detect(mergedCandles());
    await new Promise(res => setImmediate(res));
  }
  await sendChain;
  console.log('\nDry run complete.');
}

async function runTest() {
  if (!cfg.botToken || !cfg.chatId) { console.error('Missing botToken/chatId.'); process.exit(1); }
  await send(`🧪 Snapback test message — ${new Date().toString()}`);
  console.log('Sent.');
}

process.on('unhandledRejection', e => log(`unhandled: ${e && e.message}`));

if (has('--test')) runTest();
else if (DRY) runDry();
else runWatcher();
