/* SNAPBACK — XAUUSD range-fade strategy (standalone, not ICT Silver Bullet).

   Idea: overnight gold trades in a quiet range. In the morning, price often
   pokes JUST past that range — trapping breakout traders — then snaps back
   inside. We trade the snap-back:

     1. Measure the overnight range (Asian range for the London trade,
        London range for the NY trade).
     2. Wait for a 1m candle that BREAKS a range edge but CLOSES back
        inside — a failed breakout (the trap).
     3. Enter against the breakout at that candle's close.
          SL = just beyond the breakout extreme.
          TP = middle of the range (close, realistic target → high win rate).
     4. One trade per window per day.

   Pure logic, no I/O. Candles: { mod, day, ts, o, h, l, c } where mod is
   NY minute-of-day and day is NY day index. */
'use strict';

const round2 = x => Math.round(x * 100) / 100;

/* NY minute-of-day. rangeStart > rangeEnd means the range wraps midnight. */
const WINDOWS = [
  { name: 'London fade (Asian range)', rangeStart: 1140, rangeEnd: 120, tradeStart: 120, tradeEnd: 300 },  // range 7PM–2AM, trade 2–5 AM NY
  { name: 'NY fade (London range)',    rangeStart: 180,  rangeEnd: 480, tradeStart: 480, tradeEnd: 660 },  // range 3–8 AM, trade 8–11 AM NY
];

const DEFAULTS = {
  slBuffer: 1.5,   // $ beyond the breakout extreme
  minStop: 3,      // $ — tighter is noise
  maxStop: 40,     // $ — wider means the range is too messy, skip
  minTPDist: 2,    // $ — TP must be at least this far or there's nothing to win
  minRange: 8,     // $ — range too small → chop, skip the day
  minBreak: 0,     // $ — the poke past the range must be at least this deep
                   //     (a real trap, not tick noise)
  maxBreak: 15,    // $ — price breaking MORE than this past the range is a
                   //     real breakout, not a trap — stand aside
  maxRR: Infinity, // cap the TP distance at maxRR × risk (closer target → higher win rate)
  beTrigger: 0.3,  // ×risk — once the trade is this far in profit, move SL to
                   //     entry so it can no longer lose (0 = off). Honest:
                   //     armed on candle close, applies from the NEXT candle.
  spread: 0.4,     // $ round-trip cost modeled on every trade
};

function inWin(mod, s, e) { return s <= e ? (mod >= s && mod < e) : (mod >= s || mod < e); }

/* Honest rules: entry at trigger-candle close, TP/SL on later candle
   highs/lows, same-candle-both-hit counted as a LOSS. */
function run(candles, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const trades = [];
  let open = null;

  const state = WINDOWS.map(() => ({ key: null, hi: -Infinity, lo: Infinity, traded: false, breach: null }));

  function fire(dir, c, S, mid, windowName) {
    const entry = c.c;
    const sl = dir === -1 ? S.breach.ext + cfg.slBuffer : S.breach.ext - cfg.slBuffer;
    const risk = Math.abs(entry - sl) + cfg.spread; // spread counted as part of the risk
    // TP: middle of the range, but never further than maxRR × risk (spread pulls it closer)
    const tpDist = Math.min(Math.abs(entry - mid), cfg.maxRR * risk) - cfg.spread;
    const tp = dir === -1 ? entry - tpDist : entry + tpDist;
    const reward = tpDist;
    S.breach = null;
    S.traded = true;
    if (risk < cfg.minStop || risk > cfg.maxStop || reward < cfg.minTPDist) return;
    const t = {
      window: windowName, day: c.day, ts: c.ts, dir, side: dir === -1 ? 'SHORT' : 'LONG',
      entry: round2(entry), sl: round2(sl), tp: round2(tp),
      risk: round2(risk), rr: round2(reward / risk), status: 'OPEN', resultR: null,
    };
    trades.push(t);
    open = t;
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (open) {
      const t = open;
      if (t.dir === -1) {
        if (c.h >= t.sl) { t.status = t.beArmed ? 'SCRATCH' : 'LOSS'; open = null; }
        else if (c.l <= t.tp) { t.status = 'WIN'; open = null; }
        else if (cfg.beTrigger && !t.beArmed && t.entry - c.l >= cfg.beTrigger * t.risk) { t.beArmed = true; t.sl = t.entry; }
      } else {
        if (c.l <= t.sl) { t.status = t.beArmed ? 'SCRATCH' : 'LOSS'; open = null; }
        else if (c.h >= t.tp) { t.status = 'WIN'; open = null; }
        else if (cfg.beTrigger && !t.beArmed && c.h - t.entry >= cfg.beTrigger * t.risk) { t.beArmed = true; t.sl = t.entry; }
      }
      if (t.status !== 'OPEN')
        t.resultR = t.status === 'WIN' ? t.rr : t.status === 'SCRATCH' ? -round2(cfg.spread / t.risk) : -1;
    }

    for (let w = 0; w < WINDOWS.length; w++) {
      const W = WINDOWS[w], S = state[w];

      if (inWin(c.mod, W.rangeStart, W.rangeEnd)) {
        // building the range; key on the NY day the range ENDS (handles the midnight wrap)
        const key = W.rangeStart > W.rangeEnd && c.mod >= W.rangeStart ? c.day + 1 : c.day;
        if (key !== S.key) { S.key = key; S.hi = -Infinity; S.lo = Infinity; S.traded = false; S.breach = null; }
        if (c.h > S.hi) S.hi = c.h;
        if (c.l < S.lo) S.lo = c.l;
        continue;
      }

      if (!inWin(c.mod, W.tradeStart, W.tradeEnd)) { S.breach = null; continue; }
      if (S.key !== c.day || S.traded || open) continue;
      if (S.hi === -Infinity || S.hi - S.lo < cfg.minRange) continue;

      const mid = (S.hi + S.lo) / 2;

      if (c.h > S.hi || (S.breach && S.breach.side === -1)) {
        if (!S.breach || S.breach.side !== -1) S.breach = { side: -1, ext: c.h };
        if (c.h > S.breach.ext) S.breach.ext = c.h;
        if (S.breach.ext - S.hi > cfg.maxBreak) { S.traded = true; continue; }
        if (c.c < S.hi && S.breach.ext - S.hi >= cfg.minBreak) fire(-1, c, S, mid, W.name); // trapped buyers → SHORT
      } else if (c.l < S.lo || (S.breach && S.breach.side === 1)) {
        if (!S.breach || S.breach.side !== 1) S.breach = { side: 1, ext: c.l };
        if (c.l < S.breach.ext) S.breach.ext = c.l;
        if (S.lo - S.breach.ext > cfg.maxBreak) { S.traded = true; continue; }
        if (c.c > S.lo && S.lo - S.breach.ext >= cfg.minBreak) fire(1, c, S, mid, W.name); // trapped sellers → LONG
      }
    }
  }

  return trades;
}

module.exports = { run, WINDOWS, DEFAULTS };
