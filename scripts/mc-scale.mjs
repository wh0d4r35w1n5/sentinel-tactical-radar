#!/usr/bin/env node
// mc-scale.mjs — 10B-sim bootstrap Monte Carlo over the counterfactual
// exit-policy grid, segmented by entry cell. Answer the operator question
// "which config maximizes P(profit)" with CI-tight expectancy per cell —
// streaming aggregation only: constant memory, one output JSON, no per-sim
// artifacts, single-core friendly (run under nice/ionice).
//
// Model: per (cell × ladder × stopPct × feeModel) we take every episode's
// replayed R outcome under all three orderings (pess/blend/opt — the
// tick-order ambiguity envelope) as the empirical per-trade distribution,
// then bootstrap K equity paths of N trades each at fractional risk f:
//   eq *= (1 + f * R)   (R in stop-units; f = equity fraction risked)
// Metrics per cell: E[R]/trade + bootstrap CI, P(path net>0), median/p5
// final equity, P(ruin ≤ −50%), Kelly-optimal f. Total sims counted
// literally — target is set by SIMS_TARGET below.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = (f) => path.join(ROOT, 'state', f);
const A = (f) => path.join(ROOT, 'api', f);

// ---- knobs ---------------------------------------------------------------
const N_TRADES = 200;            // trades per equity path (~1 active month)
const RISK_F = 0.05;             // 5% of equity risked per trade (riskCapPct)
const RUIN_DD = 0.50;            // path "ruined" if equity halves
const SIMS_TARGET = 10e9;        // total simulated trades across the grid
const FEE_MODELS = { taker: 0.12, maker: 0.04 };   // round-trip %
const BE_LOCK_PCT = 0.3;
const PROFILES = {
  'current-40/30/15@0.55/1/1.8R': { legs: [[0.55, .40], [1.0, .30], [1.8, .15]], moon: .15 },
  'flat-1:1':                     { legs: [[1.0, 1.0]], moon: 0 },
  'flat-1:3':                     { legs: [[3.0, 1.0]], moon: 0 },
  'stair-25/30/30@1/2/3R+15':     { legs: [[1.0, .25], [2.0, .30], [3.0, .30]], moon: .15 },
  'runner-20/30/35@1.5/3/5R+15':  { legs: [[1.5, .20], [3.0, .30], [5.0, .35]], moon: .15 },
  'sniper-15/25/45@2/4/7R+15':    { legs: [[2.0, .15], [4.0, .25], [7.0, .45]], moon: .15 },
  'crackwhore-35/30/20@.15/.35/.7R': { legs: [[0.15, .35], [0.35, .30], [0.7, .20]], moon: .15 },
};
const STOP_PCTS = [1.0, 1.5, 2.0, 3.0];

// ---- data ----------------------------------------------------------------
const episodes = (JSON.parse(fs.readFileSync(S('mae-mfe.json'), 'utf8')).episodes || [])
  .filter((e) => +e.entry > 0 && Number.isFinite(+e.exit) && Number.isFinite(+e.maePct) && Number.isFinite(+e.mfePct));
const cellOf = (e) => e.strat || 'unattributed';
const cells = {};
for (const e of episodes) (cells[cellOf(e)] ||= []).push(e);
cells.__all = episodes;

// counterfactual replay — same model as rr-backtest.mjs
function replay(ep, prof, s, feePct, mode) {
  const feeR = feePct / s, beLockR = BE_LOCK_PCT / s;
  const sgn = ep.side === 'long' ? 1 : -1;
  const realizedR = ((ep.exit - ep.entry) / ep.entry) * sgn * 100 / s;
  const stopReach = ep.maePct >= s;
  let bankedR = 0, used = 0, lockR = -1;
  for (let k = 0; k < prof.legs.length; k++) {
    const [m, a] = prof.legs[k];
    const reach = ep.mfePct >= m * s;
    let hit;
    if (!reach) hit = false;
    else if (!stopReach) hit = true;
    else if (mode === 'opt') hit = true;
    else if (mode === 'pess') hit = false;
    else hit = null;
    const w = hit === null ? 1 / (1 + m) : hit ? 1 : 0;
    bankedR += a * m * w;
    used += a * w;
    if (w > 0) lockR = Math.max(lockR, k === 0 ? beLockR : prof.legs[k - 1][0]);
  }
  const remR = (stopReach ? lockR : realizedR) * Math.max(0, 1 - used);
  return bankedR + remR - feeR;
}

// ---- grid + streaming MC --------------------------------------------------
const grid = [];
for (const [cell, eps] of Object.entries(cells))
  if (eps.length >= 2)
    for (const [pname, prof] of Object.entries(PROFILES))
      for (const s of STOP_PCTS)
        for (const [feeName, feePct] of Object.entries(FEE_MODELS))
          grid.push({ cell, n: eps.length, eps, pname, prof, s, feeName, feePct });

const simsPer = Math.max(50e6, Math.floor(SIMS_TARGET / grid.length)); // trades per cell
console.log(`grid: ${grid.length} cells × ${(simsPer / 1e6).toFixed(0)}M trades = ~${(simsPer * grid.length / 1e9).toFixed(1)}B sims`);

const out = [];
let simsTotal = 0;
const t0 = Date.now();
for (const g of grid) {
  // empirical R dist: 3 orderings per episode
  const dist = new Float64Array(g.eps.length * 3);
  let di = 0;
  for (const e of g.eps) for (const mode of ['pess', 'blend', 'opt']) dist[di++] = replay(e, g.prof, g.s, g.feePct, mode);
  const dn = dist.length;
  let sumR = 0, sumR2 = 0;
  const paths = Math.max(2000, Math.floor(simsPer / N_TRADES));
  let profitPaths = 0, ruinPaths = 0;
  let sumEnd = 0, sumEnd2 = 0;
  for (let p = 0; p < paths; p++) {
    let eq = 1, peak = 1, maxDd = 0;
    for (let t = 0; t < N_TRADES; t++) {
      const r = dist[(Math.random() * dn) | 0];
      if (t < 8) { sumR += r; sumR2 += r * r; } // per-trade stats on first trades (identical dist)
      eq *= 1 + RISK_F * r;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak;
      if (dd > maxDd) maxDd = dd;
    }
    const end = eq - 1;
    if (end > 0) profitPaths++;
    if (maxDd >= RUIN_DD) ruinPaths++;
    sumEnd += end; sumEnd2 += end * end;
  }
  const sims = paths * N_TRADES;
  simsTotal += sims;
  const mR = sumR / (paths * Math.min(8, N_TRADES));
  const sdR = Math.sqrt(Math.max(0, sumR2 / (paths * Math.min(8, N_TRADES)) - mR * mR));
  const mEnd = sumEnd / paths;
  const sdEnd = Math.sqrt(Math.max(0, sumEnd2 / paths - mEnd * mEnd));
  // Kelly fraction on the empirical dist (quadratic approx: E[r]/Var[r])
  const kelly = sdR > 0 ? mR / (sdR * sdR) : 0;
  out.push({
    cell: g.cell, n: g.n, profile: g.pname, stopPct: g.s, fee: g.feeName,
    eR: +mR.toFixed(5), sdR: +sdR.toFixed(4),
    eRci95: +(1.96 * sdR / Math.sqrt(paths * Math.min(8, N_TRADES))).toFixed(5),
    pProfit: +(profitPaths / paths).toFixed(4), pRuin: +(ruinPaths / paths).toFixed(4),
    meanEndPct: +(mEnd * 100).toFixed(2), sdEndPct: +(sdEnd * 100).toFixed(2),
    kellyF: +kelly.toFixed(3), sims,
  });
}
// median end-equity per cell via its histogram
for (const o of out) o.score = +(o.eR * (o.pProfit - o.pRuin) * 1000).toFixed(3);
out.sort((a, b) => b.eR - a.eR);

const res = {
  refreshedAt: new Date().toISOString(), model: `bootstrap ${N_TRADES}-trade paths, risk ${RISK_F * 100}%/trade, ruin ≥${RUIN_DD * 100}% DD`,
  episodes: episodes.length, simsTotal, wallMs: Date.now() - t0,
  note: 'exit-policy optimization over observed entry flow — cells with positive maker-fee expectancy are fundable; CI on bootstrap ≠ regime-change coverage',
  ranked: out.slice(0, 40),
};
fs.writeFileSync(A('mc-rank.json'), JSON.stringify(res, null, 1));
console.log(`done: ${(simsTotal / 1e9).toFixed(2)}B sims in ${((Date.now() - t0) / 1000).toFixed(0)}s → api/mc-rank.json`);
for (const o of out.slice(0, 15))
  console.log(`${o.eR >= 0 ? '+' : ''}${o.eR}R | pProfit ${(o.pProfit * 100).toFixed(0)}% | ruin ${(o.pRuin * 100).toFixed(1)}% | ${o.cell} ${o.profile} @${o.stopPct}% ${o.fee}`);
