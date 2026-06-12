/* Generate report.json for the dashboard from a backtest run.
     node report.js data/<file>.json */
'use strict';

const { run } = require('./strategy.js');

const file = process.argv[2];
if (!file) { console.error('usage: node report.js <xauusd-m1.json>'); process.exit(1); }
const raw = require(require('path').resolve(file));

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

const trades = run(candles, {});
const wins = trades.filter(t => t.status === 'WIN');
const losses = trades.filter(t => t.status === 'LOSS');
const scratches = trades.filter(t => t.status === 'SCRATCH');
const netR = trades.reduce((a, t) => a + (t.resultR || 0), 0);
const grossW = wins.reduce((a, t) => a + t.rr, 0);

let eq = 0, peak = 0, maxDD = 0, maxStreak = 0, streak = 0;
const equity = [];
for (const t of trades) {
  eq += t.resultR || 0;
  peak = Math.max(peak, eq);
  maxDD = Math.max(maxDD, peak - eq);
  if (t.status === 'LOSS') { streak++; maxStreak = Math.max(maxStreak, streak); }
  else if (t.status === 'WIN') streak = 0;
  equity.push({ ts: t.ts, r: Math.round(eq * 100) / 100 });
}

const byMonth = {};
for (const t of trades) {
  const mk = new Date(t.ts).toISOString().slice(0, 7);
  byMonth[mk] = Math.round(((byMonth[mk] || 0) + (t.resultR || 0)) * 100) / 100;
}

const report = {
  generated: new Date().toISOString(),
  span: { from: new Date(raw[0].timestamp).toISOString().slice(0, 10), to: new Date(raw[raw.length - 1].timestamp).toISOString().slice(0, 10) },
  candles: raw.length,
  stats: {
    trades: trades.length, wins: wins.length, losses: losses.length, scratches: scratches.length,
    winRate: Math.round(wins.length / (wins.length + losses.length) * 1000) / 10,
    loseRate: Math.round(losses.length / trades.length * 1000) / 10,
    netR: Math.round(netR * 10) / 10,
    profitFactor: Math.round(grossW / losses.length * 100) / 100,
    maxDrawdownR: Math.round(maxDD * 10) / 10,
    worstStreak: maxStreak,
  },
  byMonth,
  equity,
  trades: trades.map(t => ({
    ts: t.ts, window: t.window, side: t.side, entry: t.entry, sl: t.sl, tp: t.tp,
    risk: t.risk, rr: t.rr, status: t.status, resultR: Math.round((t.resultR || 0) * 100) / 100,
  })),
};

require('fs').writeFileSync(require('path').join(__dirname, 'report.json'), JSON.stringify(report));
console.log(`report.json written — ${trades.length} trades, net ${netR >= 0 ? '+' : ''}${netR.toFixed(1)}R`);
