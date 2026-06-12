# Gold Snapback

A standalone XAUUSD (gold) strategy. **Not related to the ICT Silver Bullet project** — different folder, different logic.

## The idea, in plain words

Overnight, gold usually trades inside a quiet range. In the morning (London open, then New York open), price often pokes **just past** the edge of that range. Traders who buy that "breakout" get trapped — and price snaps back inside the range. We trade the snap-back.

1. **Measure the overnight range** (Asian range for the London trade, London range for the NY trade).
2. **Wait for the trap**: a 1-minute candle breaks the range edge but **closes back inside**.
3. **Enter against the breakout** at that candle's close.
   - Stop-loss: just beyond the breakout's furthest point (+$1.50 buffer).
   - Target: the **middle of the range**.
4. **Safety lock**: once the trade is 30% of the way to the stop distance in profit, the stop moves to the entry price — the trade can no longer lose.
5. One trade per window per day. If price breaks more than $15 past the range, it's a real breakout — we stand aside.

## Backtest — real data, honest rules

Tested on 233,280 real 1-minute candles (Jan 1 – Jun 11, 2026). Honest rules: entry at candle close, same-candle TP+SL conflicts counted as losses, $0.40 spread charged on every trade.

| | |
|---|---|
| Trades | 125 (16 win / 36 lose / 73 breakeven) |
| Trades that lose money | **29%** |
| Net result | **+12.5R** (+12.5% at 1% risk per trade) |
| Profit factor | 1.50 |
| Worst losing streak | 5 |

## The honest truth about "win rate"

We tested a high-win-rate version too: take profit very close → **70% win rate** … and it made **almost zero money** (+0.8R in 5.5 months), because the rare losses were as big as many wins combined. The market does not pay for being right often; it pays for winning big when you're right. This version wins big rarely (the average winner is ~4.5× the risk) and uses the breakeven lock so that 58% of trades end as harmless scratches.

To run the high-win-rate version anyway: it's `maxRR: 0.5` in `strategy.js` — see `sweep.js` output for the full comparison.

## Run it

```
node backtest.js data/xauusd-m1-bid-2026-01-01-2026-06-12.json   # full report
node sweep.js    data/xauusd-m1-bid-2026-01-01-2026-06-12.json   # compare settings
```

Fresh data: `npx dukascopy-node -i xauusd -from 2026-01-01 -to 2026-06-12 -t m1 -f json -dir ./data`

## Warnings

- 5.5 months is a short test, and settings were chosen by looking at this same data (overfitting risk). May–June were losing months.
- Past results never guarantee future results. Paper-trade before risking real money.
