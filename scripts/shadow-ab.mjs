// shadow-ab.mjs — the three-way shadow experiment (Will Evans M3).
// Original Sentinel vs Current Sentinel vs simple benchmark, replayed over
// the SAME labeled eval journal with realistic costs. No hype — net/DD/fees.
// Emits api/shadow-ab.json — the chart is the report.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = path.join(ROOT, 'api');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

const recs = [];
for (const f of ['history/eval-2026-09.json', 'history/eval-2026-10.json', 'signal-eval.json']) {
  const d = readJ(path.join(API, f), null);
  for (const x of d?.records || (Array.isArray(d) ? d : [])) if (x?.runTs && x.fwd24h != null) recs.push(x);
}
const seen = new Set();
const evals = recs.filter((r) => { const k = r.key || `${r.runTs}|${r.asset}|${r.direction}`; return !seen.has(k) && seen.add(k); }).sort((a, b) => a.runTs - b.runTs);

const COST_PCT = 0.17; // taker×2 + spread — same cost model as attribution
const NOTIONAL = 20;   // micro-book clip: $20 notional per shadow position
const dirSign = (r) => (r.direction === 'SHORT' ? -1 : 1);
const day = (ts) => Math.floor(ts / 864e5);

// strategies that existed in the v1.0 master baseline — "original Sentinel"
const ORIG_STRATS = new Set(['Liquidity Sweep', 'Key Level SFP', 'Wyckoff JTC', 'Elliott W5 Short', 'Elliott W5 Bottom', 'TS Momentum', 'VWAP Reversion']);

// benchmark leg — reconstruct the index return each record was judged
// against: benchFwd ≈ fwd − alpha. Daily bench = median across records.
const benchByDay = {};
for (const r of evals) {
  if (r.alpha24h == null || r.fwd24h == null) continue;
  const benchRet = r.fwd24h - r.alpha24h;
  (benchByDay[day(r.runTs)] ??= []).push(benchRet);
}
const benchDayRet = Object.fromEntries(Object.entries(benchByDay).map(([d, a]) => { a.sort((x, y) => x - y); return [d, a[Math.floor(a.length / 2)]]; }));

function runVariant(name, takeSignal, maxPerDay, opts = {}) {
  let equity = 100, peak = 100, maxDD = 0, trades = 0, wins = 0, fees = 0;
  const curve = [], byDayTaken = {};
  const days = [...new Set(evals.map((r) => day(r.runTs)))].sort();
  for (const d of days) {
    const todays = evals.filter((r) => day(r.runTs) === d && takeSignal(r));
    // rank by score, dedupe per asset+direction — one position per episode
    const seen2 = new Set();
    const picks = todays.sort((a, b) => (b.score || 0) - (a.score || 0)).filter((r) => { const k = r.asset + r.direction; return !seen2.has(k) && seen2.add(k); }).slice(0, maxPerDay);
    let dayPnl = 0;
    for (const r of picks) {
      const net = NOTIONAL * (dirSign(r) * r.fwd24h / 100 - COST_PCT / 100);
      dayPnl += net; trades++; wins += net > 0 ? 1 : 0; fees += NOTIONAL * COST_PCT / 100;
    }
    // benchmark leg compounds the index every day regardless
    const benchRet = opts.bench ? (benchDayRet[d] || 0) / 100 : 0;
    equity += opts.bench ? equity * benchRet : dayPnl;
    peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak > 0 ? (peak - equity) / peak : 0);
    byDayTaken[d] = picks.length;
    curve.push({ d, eq: +equity.toFixed(3), n: picks.length });
  }
  return { name, startUsd: 100, endUsd: +equity.toFixed(3), retPct: +(equity - 100).toFixed(2), maxDDPct: +(maxDD * 100).toFixed(1), trades, winRate: trades ? +(wins / trades * 100).toFixed(1) : null, feesUsd: +fees.toFixed(2), avgTradesDay: +(trades / Math.max(days.length, 1)).toFixed(2), curve };
}

const variants = [
  runVariant('V0 original', (r) => ORIG_STRATS.has(r.strategy) && (r.score || 0) >= 75, 3),
  runVariant('V1 current', (r) => (r.score || 0) >= 65, 3),
  runVariant('V2 evidence-only', (r) => r.strategy === 'PA Quartile' && (r.score || 0) >= 65, 3),
  runVariant('BENCH market', () => true, 0, { bench: true }),
];

// head-to-head stats over identical days
const days = [...new Set(evals.map((r) => day(r.runTs)))].sort();
writeJ(path.join(API, 'shadow-ab.json'), {
  ts: Date.now(), updatedAt: new Date().toISOString(),
  method: `replay labeled evals; one position per asset+direction/day; $${NOTIONAL} notional/clip; cost ${COST_PCT}% round-trip incl spread; hold = signal's realized 24h outcome; V0 = baseline strategies score≥75; V1 = all strategies score≥65 (live gate); V2 = PA-Quartile-only score≥65 (evidence policy); BENCH = index long via fwd−alpha reconstruction`,
  days: days.length, evalsLabeled: evals.length,
  variants: Object.fromEntries(variants.map((v) => [v.name, v])),
  verdict: 'net of modeled costs over identical tape — the line that ends highest with tolerable DD wins',
});
const v = Object.fromEntries(variants.map((x) => [x.name, `${x.endUsd} (${x.retPct}%) DD${x.maxDDPct}% n${x.trades}`]));
console.log('shadow-ab:', JSON.stringify(v));
