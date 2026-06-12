'use strict';

const $ = id => document.getElementById(id);
const fmtR = r => `${r >= 0 ? '+' : ''}${r.toFixed(1)}R`;
const cls = r => r > 0 ? 'good' : r < 0 ? 'bad' : 'flat';

/* NY clock helpers */
function nyNow() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const g = t => +p.find(x => x.type === t).value;
  return (g('hour') % 24) * 60 + g('minute');
}
const WINDOWS = [
  { name: 'London fade', start: 120, end: 300 },
  { name: 'NY fade', start: 480, end: 660 },
];
function windowText() {
  const mod = nyNow();
  let best = null;
  for (const w of WINDOWS) {
    if (mod >= w.start && mod < w.end) return `🟢 ${w.name} window OPEN now`;
    let wait = w.start - mod;
    if (wait <= 0) wait += 1440;
    if (!best || wait < best.wait) best = { w, wait };
  }
  return `next window: ${best.w.name} in ${Math.floor(best.wait / 60)}h ${best.wait % 60}m`;
}

/* live price */
async function tick() {
  $('nextWindow').textContent = windowText();
  try {
    const r = await fetch('https://api.gold-api.com/price/XAU');
    const j = await r.json();
    $('livePrice').textContent = '$' + j.price.toFixed(2);
    $('liveWhen').textContent = 'live gold · ' + new Date(j.updatedAt).toLocaleTimeString();
  } catch { $('liveWhen').textContent = 'live price unavailable'; }
}
tick();
setInterval(tick, 15000);

/* dashboard from report.json */
function card(k, v, c = '') { return `<div class="card"><div class="v ${c}">${v}</div><div class="k">${k}</div></div>`; }

function drawEquity(eq) {
  const cv = $('equity'), ctx = cv.getContext('2d');
  cv.width = cv.clientWidth * devicePixelRatio; cv.height = 220 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const W = cv.clientWidth, H = 220, pad = 28;
  const rs = eq.map(e => e.r);
  const min = Math.min(0, ...rs), max = Math.max(1, ...rs);
  const x = i => pad + (W - pad - 8) * i / Math.max(1, eq.length - 1);
  const y = r => H - 20 - (H - 40) * (r - min) / (max - min);
  ctx.strokeStyle = '#21262d';
  ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(W - 8, y(0)); ctx.stroke();
  ctx.fillStyle = '#8b949e'; ctx.font = '11px sans-serif';
  ctx.fillText('0R', 4, y(0) + 4); ctx.fillText(fmtR(max), 4, y(max) + 4);
  ctx.strokeStyle = '#ffd75e'; ctx.lineWidth = 2; ctx.beginPath();
  eq.forEach((e, i) => i ? ctx.lineTo(x(i), y(e.r)) : ctx.moveTo(x(i), y(e.r)));
  ctx.stroke();
}

function drawMonths(byMonth) {
  const cv = $('months'), ctx = cv.getContext('2d');
  cv.width = cv.clientWidth * devicePixelRatio; cv.height = 180 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const W = cv.clientWidth, H = 180;
  const entries = Object.entries(byMonth);
  const max = Math.max(...entries.map(([, r]) => Math.abs(r)), 1);
  const bw = (W - 20) / entries.length;
  const y0 = H / 2 + 10;
  entries.forEach(([m, r], i) => {
    const h = (H / 2 - 30) * Math.abs(r) / max;
    ctx.fillStyle = r >= 0 ? '#3fb950' : '#f85149';
    ctx.fillRect(10 + i * bw + 4, r >= 0 ? y0 - h : y0, bw - 8, Math.max(2, h));
    ctx.fillStyle = '#8b949e'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(m.slice(5), 10 + i * bw + bw / 2, H - 4);
    ctx.fillText(fmtR(r), 10 + i * bw + bw / 2, r >= 0 ? y0 - h - 6 : y0 + h + 12);
  });
}

async function loadReport() {
  let rep;
  try { rep = await (await fetch('report.json')).json(); }
  catch { $('cards').innerHTML = '<p class="sub">report.json not found — run: node report.js data/&lt;file&gt;.json</p>'; return; }
  const s = rep.stats;
  $('spanLabel').textContent = `${rep.span.from} → ${rep.span.to} · ${rep.candles.toLocaleString()} real 1m candles`;
  $('cards').innerHTML =
    card('net result (1% risk)', fmtR(s.netR), cls(s.netR)) +
    card('trades', s.trades) +
    card('win / lose / breakeven', `${s.wins} / ${s.losses} / ${s.scratches}`) +
    card('trades that lose money', s.loseRate + '%', 'flat') +
    card('profit factor', s.profitFactor, cls(s.profitFactor - 1)) +
    card('worst losing streak', s.worstStreak, 'flat') +
    card('max drawdown', s.maxDrawdownR + 'R', 'bad');
  drawEquity(rep.equity);
  drawMonths(rep.byMonth);
  const tb = $('trades').querySelector('tbody');
  tb.innerHTML = rep.trades.slice().reverse().map(t => {
    const d = new Date(t.ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<tr><td>${d}</td><td>${t.window.replace(/ \(.*/, '')}</td><td>${t.side}</td>` +
      `<td>${t.entry.toFixed(2)}</td><td>${t.sl.toFixed(2)}</td><td>${t.tp.toFixed(2)}</td>` +
      `<td>${t.rr.toFixed(1)}</td><td class="${cls(t.resultR)}">${t.status} ${fmtR(t.resultR)}</td></tr>`;
  }).join('');
}
loadReport();

/* live alerts from the cloud watcher (if signals.json exists) */
async function loadSignals() {
  try {
    const sigs = await (await fetch('signals.json')).json();
    if (!Array.isArray(sigs) || !sigs.length) return;
    $('signals').innerHTML = sigs.slice().reverse().map(s => {
      const d = new Date(s.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<div class="sig ${s.event}"><b>${s.event}</b> · ${s.side} · ${d} NY<br>` +
        `entry ${s.entry.toFixed(2)} · SL ${s.sl.toFixed(2)} · TP ${s.tp.toFixed(2)} (${s.rr.toFixed(1)}R)</div>`;
    }).join('');
  } catch { /* no signals yet */ }
}
loadSignals();
setInterval(loadSignals, 60000);
