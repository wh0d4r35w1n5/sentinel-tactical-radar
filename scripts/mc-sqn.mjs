#!/usr/bin/env node
// mc-sqn.mjs — 1T-draw bootstrap MC maximizing Van Tharp SQN across the
// counterfactual exit-policy grid. Two-layer answer per cell:
//   (a) ANALYTIC SQN_100 = (E[R]/sd(R))*sqrt(100) — exact moments of the
//       empirical R distribution, no simulation error at all;
//   (b) bootstrap CI on SQN_100 via episode-level resampling (cluster-aware —
//       the 3 orderings of an episode move together) + the equity-path
//       bootstrap for P(profit)/ruin/median end-equity.
// worker_threads across cores; streaming aggregates; constant memory.
// MC_SIMS env sets total trade-draws (default 1e12). Nice/ionice on the box.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = (f) => path.join(ROOT, 'state', f);
const A = (f) => path.join(ROOT, 'api', f);

const N_TRADES = 200;
const RISK_F = 0.05;
const RUIN_DD = 0.50;
const SIMS_TARGET = +(process.env.MC_SIMS || 1e12);
const SQN_BOOT = 100000;              // episode-resamples per cell for SQN CI
const FEE_MODELS = { taker: 0.12, maker: 0.04 };
const BE_LOCK_PCT = 0.3;
const PROFILES = {
  'flat-1:0.5':                      { legs: [[0.5, 1.0]], moon: 0 },
  'flat-1:0.75':                     { legs: [[0.75, 1.0]], moon: 0 },
  'flat-1:1':                        { legs: [[1.0, 1.0]], moon: 0 },
  'flat-1:1.5':                      { legs: [[1.5, 1.0]], moon: 0 },
  'flat-1:2':                        { legs: [[2.0, 1.0]], moon: 0 },
  'flat-1:2.5':                      { legs: [[2.5, 1.0]], moon: 0 },
  'flat-1:3':                        { legs: [[3.0, 1.0]], moon: 0 },
  'current-40/30/15@0.55/1/1.8R':    { legs: [[0.55, .40], [1.0, .30], [1.8, .15]], moon: .15 },
  'stair-25/30/30@1/2/3R+15':        { legs: [[1.0, .25], [2.0, .30], [3.0, .30]], moon: .15 },
  'runner-20/30/35@1.5/3/5R+15':     { legs: [[1.5, .20], [3.0, .30], [5.0, .35]], moon: .15 },
  'sniper-15/25/45@2/4/7R+15':       { legs: [[2.0, .15], [4.0, .25], [7.0, .45]], moon: .15 },
  'crackwhore-35/30/20@.15/.35/.7R': { legs: [[0.15, .35], [0.35, .30], [0.7, .20]], moon: .15 },
};
const STOP_PCTS = [0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0];

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

if (!isMainThread) {
  // ---- worker: process assigned cells ------------------------------------
  const { cells, gridSlice } = workerData;
  const out = [];
  let simsTotal = 0;
  for (const g of gridSlice) {
    const eps = cells[g.cell];
    // per-episode 3-ordering R values → dist + per-ep partial sums (for the
    // O(1) SQN bootstrap: resample episodes, pool their fixed triples)
    const epS1 = new Float64Array(eps.length), epS2 = new Float64Array(eps.length);
    const dist = new Float64Array(eps.length * 3);
    let di = 0;
    for (let i = 0; i < eps.length; i++) {
      let s1 = 0, s2 = 0;
      for (const mode of ['pess', 'blend', 'opt']) {
        const r = replay(eps[i], g.prof, g.s, g.feePct, mode);
        dist[di++] = r; s1 += r; s2 += r * r;
      }
      epS1[i] = s1; epS2[i] = s2;
    }
    const dn = dist.length, ne = eps.length;
    // exact moments → analytic SQN_100
    let tS1 = 0, tS2 = 0;
    for (const r of dist) { tS1 += r; tS2 += r * r; }
    const mR = tS1 / dn, sdR = Math.sqrt(Math.max(1e-12, tS2 / dn - mR * mR));
    const sqn = (mR / sdR) * 10;
    // SQN CI — resample episodes, pool triples
    const boot = new Float64Array(SQN_BOOT);
    for (let b = 0; b < SQN_BOOT; b++) {
      let b1 = 0, b2 = 0;
      for (let k = 0; k < ne; k++) { const i = (Math.random() * ne) | 0; b1 += epS1[i]; b2 += epS2[i]; }
      const bm = b1 / (3 * ne), bv = Math.max(1e-12, b2 / (3 * ne) - bm * bm);
      boot[b] = (bm / Math.sqrt(bv)) * 10;
    }
    boot.sort();
    const sqnLo = boot[(SQN_BOOT * 0.025) | 0], sqnHi = boot[(SQN_BOOT * 0.975) | 0];
    // equity-path bootstrap
    const paths = Math.max(2000, Math.floor(g.simsPer / N_TRADES));
    let profitPaths = 0, ruinPaths = 0, sumEnd = 0, sumEnd2 = 0;
    const ends = new Float64Array(paths);
    for (let p = 0; p < paths; p++) {
      let eq = 1, peak = 1, maxDd = 0;
      for (let t = 0; t < N_TRADES; t++) {
        eq *= 1 + RISK_F * dist[(Math.random() * dn) | 0];
        if (eq > peak) peak = eq;
        const dd = (peak - eq) / peak;
        if (dd > maxDd) maxDd = dd;
      }
      ends[p] = eq;
      if (eq > 1) profitPaths++;
      if (maxDd >= RUIN_DD) ruinPaths++;
      sumEnd += eq; sumEnd2 += eq * eq;
    }
    simsTotal += paths * N_TRADES;
    ends.sort();
    const mEnd = sumEnd / paths, sdEnd = Math.sqrt(Math.max(0, sumEnd2 / paths - mEnd * mEnd));
    const kelly = mR / (sdR * sdR);
    out.push({
      cell: g.cell, n: ne, profile: g.pname, stopPct: g.s, fee: g.feeName,
      eR: +mR.toFixed(5), sdR: +sdR.toFixed(4), sqn100: +sqn.toFixed(3),
      sqnLo: +sqnLo.toFixed(3), sqnHi: +sqnHi.toFixed(3),
      pProfit: +(profitPaths / paths).toFixed(4), pRuin: +(ruinPaths / paths).toFixed(4),
      medEndPct: +((ends[paths >> 1] - 1) * 100).toFixed(2),
      p5EndPct: +((ends[(paths * 0.05) | 0] - 1) * 100).toFixed(2),
      meanEndPct: +((mEnd - 1) * 100).toFixed(2),
      kellyF: +kelly.toFixed(3), sims: paths * N_TRADES,
    });
  }
  parentPort.postMessage({ out, simsTotal });
} else {
  // ---- master: data, grid, workers, merge --------------------------------
  const episodes = (JSON.parse(fs.readFileSync(S('mae-mfe.json'), 'utf8')).episodes || [])
    .filter((e) => +e.entry > 0 && Number.isFinite(+e.exit) && Number.isFinite(+e.maePct) && Number.isFinite(+e.mfePct));
  const cellOf = (e) => e.strat || 'unattributed';
  const cells = {};
  for (const e of episodes) (cells[cellOf(e)] ||= []).push(e);
  cells.__all = episodes;

  const grid = [];
  for (const [cell, eps] of Object.entries(cells))
    if (eps.length >= 2)
      for (const [pname, prof] of Object.entries(PROFILES))
        for (const s of STOP_PCTS)
          for (const [feeName, feePct] of Object.entries(FEE_MODELS))
            grid.push({ cell, pname, prof, s, feeName, feePct });
  const simsPer = Math.max(100e6, Math.floor(SIMS_TARGET / grid.length));
  const NW = Math.max(1, Math.min(2, os.cpus().length));
  console.log(`sqn grid: ${grid.length} cells × ${(simsPer / 1e6).toFixed(0)}M trades = ~${(simsPer * grid.length / 1e12).toFixed(2)}T draws across ${NW} workers`);

  const t0 = Date.now();
  const slices = Array.from({ length: NW }, () => []);
  grid.forEach((g, i) => slices[i % NW].push({ ...g, simsPer }));
  const results = await Promise.all(slices.map((sl) => new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { cells, gridSlice: sl } });
    w.once('message', res); w.once('error', rej);
  })));
  const out = results.flatMap((r) => r.out);
  const simsTotal = results.reduce((a, r) => a + r.simsTotal, 0);

  out.sort((a, b) => b.sqn100 - a.sqn100);
  const res = {
    refreshedAt: new Date().toISOString(),
    model: `analytic SQN_100 = (E[R]/sdR)*10 on empirical R dist; ${SQN_BOOT / 1e3}k-episode-resample CI; bootstrap ${N_TRADES}-trade paths @ ${RISK_F * 100}%/trade, ruin >=${RUIN_DD * 100}% DD`,
    episodes: episodes.length, simsTotal, wallMs: Date.now() - t0,
    note: 'counterfactual exit-policy grid over observed entry flow; SQN ranked — Van Tharp: SQN>2 decent, >3 good, >5 excellent, >7 Holy Grail',
    rankedBySqn: out.slice(0, 40),
    rankedByER: [...out].sort((a, b) => b.eR - a.eR).slice(0, 20),
  };
  fs.writeFileSync(A('mc-sqn.json'), JSON.stringify(res, null, 1));
  console.log(`done: ${(simsTotal / 1e12).toFixed(2)}T draws in ${((Date.now() - t0) / 1000).toFixed(0)}s → api/mc-sqn.json`);
  for (const o of out.slice(0, 15))
    console.log(`SQN ${o.sqn100 >= 0 ? '+' : ''}${o.sqn100} [${o.sqnLo}..${o.sqnHi}] | ${o.eR >= 0 ? '+' : ''}${o.eR}R | pProfit ${(o.pProfit * 100).toFixed(0)}% ruin ${(o.pRuin * 100).toFixed(1)}% | ${o.cell} ${o.profile} @${o.stopPct}% ${o.fee}`);
}
