/* CONTENDERS — head-to-head backtest of internet-famous gold strategies
   against real XAUUSD 1m data, all under the same honest rules:
     · entry at signal-candle close, $0.40 spread per round trip
     · exits checked on 1m highs/lows, SL checked before TP (both-hit = LOSS)
     · all positions force-closed 4:55 PM NY (no overnight risk)

     node contenders.js data/<file>.json

   Strategies:
     ORB      — NY opening range breakout (9:30–10:00 range, trade the break,
                trail with 2.5×ATR chandelier stop)
     EMA-PB   — 15m trend rider: EMA20 over/under EMA50 sets the trend, enter
                when price pulls back to EMA20 and closes back with the trend,
                trail with 2.5×ATR
     SNAPBACK — the range-fade in strategy.js (baseline)                       */
'use strict';

const snap = require('./strategy.js');

const SPREAD = 0.4;
const EOD = 1015; // 4:55 PM NY — flatten everything

/* ---------- load + NY time ---------- */
const raw = require(require('path').resolve(process.argv[2]));
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const offsetCache = new Map();
function nyParts(ts) {
  const utcDay = Math.floor(ts / 86400000);
  let off = offsetCache.get(utcDay);
  if (off === undefined) {
    const p = fmt.formatToParts(new Date(ts));
    const g = t => +p.find(x => x.type === t).value;
    off = (g('hour') % 24) * 60 + g('minute') - (Math.floor(ts / 60000) % 1440);
    if (off > 720) off -= 1440;
    if (off < -720) off += 1440;
    offsetCache.set(utcDay, off);
  }
  const m = Math.floor(ts / 60000) + off;
  return { mod: ((m % 1440) + 1440) % 1440, day: Math.floor(m / 1440) };
}
const M1 = raw.map(r => {
  const { mod, day } = nyParts(r.timestamp);
  return { mod, day, ts: r.timestamp, o: r.open, h: r.high, l: r.low, c: r.close };
});
console.log(`loaded ${M1.length.toLocaleString()} 1m candles · spread $${SPREAD} · all exits on 1m, EOD flat at 4:55 PM NY\n`);

/* ---------- aggregate to N-minute candles (NY-aligned) ---------- */
function aggregate(n) {
  const out = [];
  let cur = null;
  for (const c of M1) {
    const key = c.day * 1440 + Math.floor(c.mod / n);
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur);
      cur = { key, day: c.day, mod: Math.floor(c.mod / n) * n, ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, i1: null };
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function atrSeries(tf, period) {
  const atr = new Array(tf.length).fill(null);
  let sum = 0;
  for (let i = 1; i < tf.length; i++) {
    const tr = Math.max(tf[i].h - tf[i].l, Math.abs(tf[i].h - tf[i - 1].c), Math.abs(tf[i].l - tf[i - 1].c));
    if (i <= period) { sum += tr; if (i === period) atr[i] = sum / period; }
    else atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }
  return atr;
}

function emaSeries(tf, period) {
  const k = 2 / (period + 1);
  const ema = new Array(tf.length).fill(null);
  let s = 0;
  for (let i = 0; i < tf.length; i++) {
    if (i < period) { s += tf[i].c; if (i === period - 1) ema[i] = s / period; }
    else ema[i] = tf[i].c * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

/* ---------- shared 1m execution harness ----------
   strategy = { onBar(tfIdx) -> order | null } run over an aggregated TF;
   orders: { dir, entry (close), sl, trailATR (or null), tp (or null) }
   Trailing: chandelier — best close since entry ∓ trailATR; updated on each
   1m close AFTER exit checks (no lookahead).                                 */
function execute(tf, makeSignal, name) {
  // map each aggregated bar to the 1m index where it CLOSES
  const closeIdx = new Map(); // tf index -> last 1m index inside that bar
  {
    let j = 0;
    for (let i = 0; i < tf.length; i++) {
      const next = tf[i + 1];
      while (j < M1.length && (!next || M1[j].ts < next.ts)) j++;
      closeIdx.set(i, j - 1);
    }
  }
  const trades = [];
  let open = null;
  let ti = 0;
  for (let i = 0; i < M1.length; i++) {
    const c = M1[i];
    if (open) {
      const t = open;
      let done = null;
      if (t.dir === 1) {
        if (c.l <= t.sl) done = ['SL', t.sl];
        else if (t.tp && c.h >= t.tp) done = ['TP', t.tp];
      } else {
        if (c.h >= t.sl) done = ['SL', t.sl];
        else if (t.tp && c.l <= t.tp) done = ['TP', t.tp];
      }
      if (!done && c.mod >= EOD && c.mod < 1140) done = ['EOD', c.c];
      if (done) {
        const exit = done[1];
        t.exitTs = c.ts;
        t.pnl = (exit - t.entry) * t.dir - SPREAD;
        t.resultR = t.pnl / t.risk0;
        t.status = t.pnl > 0 ? 'WIN' : 'LOSS';
        t.via = done[0];
        open = null;
      } else if (t.trailATR) {
        const best = t.dir === 1 ? Math.max(t.best, c.c) : Math.min(t.best, c.c);
        t.best = best;
        const trail = t.dir === 1 ? best - t.trailATR : best + t.trailATR;
        if (t.dir === 1 ? trail > t.sl : trail < t.sl) t.sl = trail;
      }
    }
    // advance aggregated clock; signal fires at the bar's closing 1m candle
    while (ti < tf.length && closeIdx.get(ti) === i) {
      if (!open && c.mod < EOD) {
        const ord = makeSignal(ti);
        if (ord) {
          const risk0 = Math.abs(ord.entry - ord.sl) + SPREAD;
          open = Object.assign({ ts: c.ts, day: c.day, risk0, best: ord.entry, status: 'OPEN' }, ord);
          trades.push(open);
        }
      }
      ti++;
    }
  }
  if (open) { open.status = 'LOSS'; open.resultR = 0; open.via = 'open@end'; }
  return { name, trades };
}

/* ---------- strategy 1: NY Opening Range Breakout (5m bars) ---------- */
function orb() {
  const tf = aggregate(5);
  const atr = atrSeries(tf, 14);
  const state = { day: null, hi: null, lo: null, fired: false };
  return execute(tf, i => {
    const b = tf[i];
    if (b.day !== state.day) Object.assign(state, { day: b.day, hi: -Infinity, lo: Infinity, fired: false, have: 0 });
    if (b.mod >= 570 && b.mod < 600) { // 9:30–10:00 range
      state.hi = Math.max(state.hi, b.h); state.lo = Math.min(state.lo, b.l); state.have++;
      return null;
    }
    if (state.fired || state.have < 6 || b.mod < 600 || b.mod >= 840) return null; // trade 10:00–2 PM only
    if (state.hi - state.lo < 3) { state.fired = true; return null; }              // dead range — skip day
    if (b.c > state.hi) {
      state.fired = true;
      return { dir: 1, entry: b.c, sl: state.lo - 1, trailATR: 2.5 * atr[i], tp: null, window: 'ORB' };
    }
    if (b.c < state.lo) {
      state.fired = true;
      return { dir: -1, entry: b.c, sl: state.hi + 1, trailATR: 2.5 * atr[i], tp: null, window: 'ORB' };
    }
    return null;
  }, 'ORB — NY open breakout, ATR trail');
}

/* ---------- strategy 2: EMA trend rider with pullback (15m bars) ---------- */
function emaPullback() {
  const tf = aggregate(15);
  const e20 = emaSeries(tf, 20), e50 = emaSeries(tf, 50);
  const atr = atrSeries(tf, 14);
  const cool = { day: null, count: 0 };
  return execute(tf, i => {
    if (i < 51 || !atr[i]) return null;
    const b = tf[i], p = tf[i - 1];
    if (b.mod < 180 || b.mod >= 840) return null; // trade 3 AM–2 PM NY
    if (cool.day !== b.day) { cool.day = b.day; cool.count = 0; }
    if (cool.count >= 2) return null;             // max 2 entries/day
    const up = e20[i] > e50[i], dn = e20[i] < e50[i];
    if (up && p.l <= e20[i - 1] && b.c > e20[i] && b.c > b.o) {
      cool.count++;
      return { dir: 1, entry: b.c, sl: Math.min(p.l, b.l) - 0.5 * atr[i], trailATR: 2.5 * atr[i], tp: null, window: 'EMA' };
    }
    if (dn && p.h >= e20[i - 1] && b.c < e20[i] && b.c < b.o) {
      cool.count++;
      return { dir: -1, entry: b.c, sl: Math.max(p.h, b.h) + 0.5 * atr[i], trailATR: 2.5 * atr[i], tp: null, window: 'EMA' };
    }
    return null;
  }, 'EMA-PB — 15m trend pullback, ATR trail');
}

/* ---------- report ---------- */
function report({ name, trades }) {
  const wins = trades.filter(t => t.resultR > 0);
  const losses = trades.filter(t => t.resultR <= 0);
  const netR = trades.reduce((a, t) => a + (t.resultR || 0), 0);
  const grossW = wins.reduce((a, t) => a + t.resultR, 0);
  const grossL = -losses.reduce((a, t) => a + t.resultR, 0);
  let maxStreak = 0, streak = 0, eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    if (t.resultR <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
    eq += t.resultR; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
  }
  console.log(`${name}`);
  console.log(`  trades ${trades.length}  ·  win rate ${(wins.length / trades.length * 100).toFixed(1)}%  ·  net ${netR >= 0 ? '+' : ''}${netR.toFixed(1)}R  ·  PF ${grossL ? (grossW / grossL).toFixed(2) : '∞'}  ·  worst streak ${maxStreak}  ·  max drawdown ${maxDD.toFixed(1)}R`);
  console.log(`  at 1% risk: ${netR >= 0 ? '+' : ''}${netR.toFixed(1)}%  ·  at 2%: ${netR >= 0 ? '+' : ''}${(netR * 2).toFixed(1)}%  ·  risk needed for +50%: ${netR > 0 ? (50 / netR).toFixed(1) + '%/trade (drawdown would be ' + (maxDD * 50 / netR).toFixed(0) + '%)' : 'n/a (strategy lost)'}`);
  const byMonth = new Map();
  for (const t of trades) {
    const mk = new Date(t.ts).toISOString().slice(0, 7);
    byMonth.set(mk, (byMonth.get(mk) || 0) + t.resultR);
  }
  console.log('  by month: ' + [...byMonth.entries()].sort().map(([m, r]) => `${m.slice(5)}: ${r >= 0 ? '+' : ''}${r.toFixed(1)}R`).join('  '));
  console.log();
}

report(orb());
report(emaPullback());

/* snapback baseline via its own honest engine */
{
  const trades = snap.run(M1, {});
  const wins = trades.filter(t => t.status === 'WIN');
  const losses = trades.filter(t => t.status === 'LOSS');
  const netR = trades.reduce((a, t) => a + (t.resultR || 0), 0);
  let maxStreak = 0, streak = 0, eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    if (t.status === 'LOSS') { streak++; maxStreak = Math.max(maxStreak, streak); } else if (t.status === 'WIN') streak = 0;
    eq += t.resultR || 0; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
  }
  const grossW = wins.reduce((a, t) => a + t.rr, 0);
  console.log(`SNAPBACK — range fade (baseline)`);
  console.log(`  trades ${trades.length}  ·  win rate ${(wins.length / (wins.length + losses.length) * 100).toFixed(1)}% of decided  ·  net ${netR >= 0 ? '+' : ''}${netR.toFixed(1)}R  ·  PF ${(grossW / losses.length).toFixed(2)}  ·  worst streak ${maxStreak}  ·  max drawdown ${maxDD.toFixed(1)}R`);
  console.log(`  at 1% risk: ${netR >= 0 ? '+' : ''}${netR.toFixed(1)}%  ·  at 2%: ${netR >= 0 ? '+' : ''}${(netR * 2).toFixed(1)}%  ·  risk needed for +50%: ${netR > 0 ? (50 / netR).toFixed(1) + '%/trade (drawdown would be ' + (maxDD * 50 / netR).toFixed(0) + '%)' : 'n/a'}`);
}
