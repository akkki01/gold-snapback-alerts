/* Parameter sweep: try stop-buffer × target-cap combinations and print
   win rate / net R for each, to find a high-win-rate setting that is
   still profitable.   node sweep.js data/<file>.json */
'use strict';

const { run } = require('./strategy.js');

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
const candles = raw.map(r => {
  const { mod, day } = nyParts(r.timestamp);
  return { mod, day, ts: r.timestamp, o: r.open, h: r.high, l: r.low, c: r.close };
});

console.log('beTrigger  maxRR   trades  W/L/scr   winrate   netR     PF    worst-streak');
for (const beTrigger of [0, 0.3, 0.5, 1]) {
  for (const maxRR of [0.5, 1, 2, Infinity]) {
    const trades = run(candles, { slBuffer: 1.5, maxRR, beTrigger });
    const wins = trades.filter(t => t.status === 'WIN');
    const losses = trades.filter(t => t.status === 'LOSS');
    const resolved = wins.length + losses.length;
    if (!resolved) continue;
    const netR = trades.reduce((a, t) => a + (t.resultR || 0), 0);
    const grossWin = wins.reduce((a, t) => a + t.rr, 0);
    const pf = losses.length ? grossWin / losses.length : Infinity;
    let maxStreak = 0, streak = 0;
    for (const t of trades) {
      if (t.status === 'LOSS') { streak++; maxStreak = Math.max(maxStreak, streak); }
      else if (t.status === 'WIN') streak = 0;
    }
    const scr = trades.filter(t => t.status === 'SCRATCH').length;
    console.log(
      `${String(beTrigger).padEnd(9)} ${String(maxRR).padEnd(7)} ${String(resolved + scr).padStart(5)}  ` +
      `${`${wins.length}/${losses.length}/${scr}`.padStart(8)}  ` +
      `${(wins.length / resolved * 100).toFixed(1).padStart(6)}%  ` +
      `${(netR >= 0 ? '+' : '') + netR.toFixed(1)}R`.padStart(8) +
      `  ${pf.toFixed(2).padStart(5)}   ${maxStreak}`);
  }
}
