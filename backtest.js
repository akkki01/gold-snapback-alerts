/* Backtest SNAPBACK over real XAUUSD 1m candles (Dukascopy JSON format:
   array of { timestamp, open, high, low, close }).

     node backtest.js data/<file>.json [spread$]

   Spread defaults to $0.40 round trip (typical retail gold spread). */
'use strict';

const { run, WINDOWS } = require('./strategy.js');

const file = process.argv[2];
if (!file) { console.error('usage: node backtest.js <xauusd-m1.json> [spread$]'); process.exit(1); }
const spread = process.argv[3] !== undefined ? +process.argv[3] : 0.4;
const raw = require(require('path').resolve(file));

/* timestamp → NY minute-of-day / day index (DST-safe via Intl, cached per day) */
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
    const nyMin = (g('hour') % 24) * 60 + g('minute');
    const utcMin = Math.floor(ts / 60000) % 1440;
    off = nyMin - utcMin;
    if (off > 720) off -= 1440;
    if (off < -720) off += 1440;
    offsetCache.set(utcDay, off);
  }
  const m = Math.floor(ts / 60000) + off;
  return { mod: ((m % 1440) + 1440) % 1440, day: Math.floor(m / 1440) };
}

const candles = raw.map(r => {
  const { mod, day } = nyParts(r.timestamp);
  return { mod, day, ts: r.timestamp, o: r.open, h: r.high, l: r.low, c: r.close };
});
console.log(`loaded ${candles.length.toLocaleString()} 1m candles · spread modeled: $${spread.toFixed(2)}`);

const trades = run(candles, { spread });

const wins = trades.filter(t => t.status === 'WIN');
const losses = trades.filter(t => t.status === 'LOSS');
const scratches = trades.filter(t => t.status === 'SCRATCH');
const resolved = wins.length + losses.length;
const netR = trades.reduce((a, t) => a + (t.resultR || 0), 0);
const grossWin = wins.reduce((a, t) => a + t.rr, 0);
const span = `${new Date(raw[0].timestamp).toISOString().slice(0, 10)} → ${new Date(raw[raw.length - 1].timestamp).toISOString().slice(0, 10)}`;

console.log(`\n=========== SNAPBACK — real XAUUSD 1m (${span}) ===========`);
console.log(`trades: ${trades.length}  →  ${wins.length} wins / ${losses.length} losses / ${scratches.length} breakeven scratches` +
  (trades.length - resolved - scratches.length ? `  (${trades.length - resolved - scratches.length} unresolved at data end)` : ''));
if (resolved) {
  console.log(`win rate:        ${(wins.length / resolved * 100).toFixed(1)}% of decided trades  ·  only ${(losses.length / (resolved + scratches.length) * 100).toFixed(0)}% of all trades lose money`);
  console.log(`net result:      ${netR >= 0 ? '+' : ''}${netR.toFixed(1)}R  (avg ${(netR / resolved).toFixed(2)}R/trade)`);
  console.log(`profit factor:   ${losses.length ? (grossWin / losses.length).toFixed(2) : '∞'}   (R won per R lost)`);
  console.log(`at 1% risk:      ${netR >= 0 ? '+' : ''}${netR.toFixed(1)}% account move over the period (no compounding)`);
  let maxStreak = 0, streak = 0;
  for (const t of trades) {
    if (t.status === 'LOSS') { streak++; maxStreak = Math.max(maxStreak, streak); }
    else if (t.status === 'WIN') streak = 0;
  }
  console.log(`worst streak:    ${maxStreak} losses in a row`);
  console.log(`avg RR target:   ${(trades.reduce((a, t) => a + t.rr, 0) / trades.length).toFixed(2)}  ·  avg stop $${(trades.reduce((a, t) => a + t.risk, 0) / trades.length).toFixed(2)}`);
}

console.log('\n--- by window ---');
for (const W of WINDOWS) {
  const g = trades.filter(t => t.window === W.name);
  const w = g.filter(t => t.status === 'WIN').length;
  const l = g.filter(t => t.status === 'LOSS').length;
  const r = g.reduce((a, t) => a + (t.resultR || 0), 0);
  console.log(`${W.name.padEnd(28)} ${String(g.length).padStart(3)} trades  ${w}W/${l}L  net ${r >= 0 ? '+' : ''}${r.toFixed(1)}R`);
}

console.log('\n--- by month ---');
const byMonth = new Map();
for (const t of trades) {
  const mk = new Date(t.ts).toISOString().slice(0, 7);
  if (!byMonth.has(mk)) byMonth.set(mk, []);
  byMonth.get(mk).push(t);
}
for (const [mk, g] of [...byMonth.entries()].sort()) {
  const w = g.filter(t => t.status === 'WIN').length;
  const l = g.filter(t => t.status === 'LOSS').length;
  const r = g.reduce((a, t) => a + (t.resultR || 0), 0);
  console.log(`${mk}   ${String(g.length).padStart(3)} trades  ${String(w).padStart(2)}W/${String(l).padStart(2)}L  net ${r >= 0 ? '+' : ''}${r.toFixed(1)}R`);
}

console.log('\n--- last 10 trades ---');
for (const t of trades.slice(-10)) {
  console.log(`${new Date(t.ts).toISOString().slice(0, 16).replace('T', ' ')}  ${t.side.padEnd(5)} ` +
    `entry ${t.entry.toFixed(2)}  SL ${t.sl.toFixed(2)}  TP ${t.tp.toFixed(2)}  RR ${t.rr.toFixed(2)}  → ${t.status}`);
}
console.log();
