#!/usr/bin/env node
// rr-backtest.mjs — empirical replay of every candidate R:R ladder over
// ALL accumulated trade excursions (state/mae-mfe.json episodes) plus the
// realized close record across every fills journal ever written.
//
// For each episode we know the path envelope (MAE/MFE %, entry, exit) but
// not the tick order, so each (profile, stopPct) is replayed under three
// orderings: PESSIMISTIC (any reachable stop kills first), OPTIMISTIC
// (every reachable leg banks), and BLEND (ambiguous legs weighted by the
// diffusion first-passage share 1/(1+m)). Truth lives inside the envelope.
// Output: api/rr-backtest.json + console table.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeCheckedJson } from './crc32.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = (f) => path.join(ROOT, 'state', f);
const A = (f) => path.join(ROOT, 'api', f);
const FEE_RT_PCT = 0.12;
const BE_LOCK_PCT = 0.3;

const episodes = (() => {
  try { return (JSON.parse(fs.readFileSync(S('mae-mfe.json'), 'utf8')).episodes || []); } catch { return []; }
})();
const seen = new Set();
const closes = [];
for (const f of ['real-fills.json', 'real-fills.live-archive.json', 'demo-fills.pretest.json', 'demo-fills.json']) {
  try {
    for (const x of JSON.parse(fs.readFileSync(S(f), 'utf8')).fills || []) {
      if (x.tradeSide !== 'close') continue;
      const k = x.tradeId || `${x.ts}:${x.symbol}:${x.size}`;
      if (seen.has(k)) continue;
      seen.add(k); closes.push(x);
    }
  } catch {}
}
const closeWins = closes.filter((x) => (+x.profit || 0) - (+x.fee || 0) > 0).length;
const closeNet = closes.reduce((a, x) => a + (+x.profit || 0) - (+x.fee || 0), 0);

const PROFILES = {
  'current-40/30/15 @0.55/1/1.8R': { legs: [[0.55, .40], [1.0, .30], [1.8, .15]], moon: .15 },
  'flat 1:1 whole-pos':            { legs: [[1.0, 1.0]], moon: 0 },
  'flat 1:2 whole-pos':            { legs: [[2.0, 1.0]], moon: 0 },
  'flat 1:3 whole-pos':            { legs: [[3.0, 1.0]], moon: 0 },
  'stair 25/30/30 @1/2/3R +15run': { legs: [[1.0, .25], [2.0, .30], [3.0, .30]], moon: .15 },
  'runner 20/30/35 @1.5/3/5R +15': { legs: [[1.5, .20], [3.0, .30], [5.0, .35]], moon: .15 },
  'hybrid 30/30/25 @0.8/1.8/3.5R': { legs: [[0.8, .30], [1.8, .30], [3.5, .25]], moon: .15 },
  'sniper 15/25/45 @2/4/7R +15':   { legs: [[2.0, .15], [4.0, .25], [7.0, .45]], moon: .15 },
  'tightstop 30/30/25 @0.7/1.5/3R':{ legs: [[0.7, .30], [1.5, .30], [3.0, .25]], moon: .15 },
};
const STOP_PCTS = [1.0, 1.5, 2.0, 3.0];

// one episode, one ladder, one ordering rule -> R outcome
function replay(ep, prof, s, mode) {
  const feeR = FEE_RT_PCT / s, beLockR = BE_LOCK_PCT / s;
  const sgn = ep.side === 'long' ? 1 : -1;
  const realizedR = ((ep.exit - ep.entry) / ep.entry) * sgn * 100 / s; // actual exit for residual
  const stopReach = ep.maePct >= s;
  const legs = prof.legs;
  let bankedR = 0, used = 0, lockR = -1;
  for (let k = 0; k < legs.length; k++) {
    const [m, a] = legs[k];
    const reach = ep.mfePct >= m * s;
    let hit;
    if (!reach) hit = false;
    else if (!stopReach) hit = true;                    // leg in range, stop wasn't — fills
    else if (mode === 'opt') hit = true;                // ordering ambiguity -> leg wins
    else if (mode === 'pess') hit = false;              // stop wins
    else hit = null;                                    // blend -> weight by 1/(1+m)
    const w = hit === null ? 1 / (1 + m) : hit ? 1 : 0;
    bankedR += a * m * w;
    used += a * w;
    if (w > 0) lockR = Math.max(lockR, k === 0 ? beLockR : legs[k - 1][0]);
  }
  // residual rides on only the UNBANKED fraction — `used` accumulates the
  // allocation already paid out by hit legs (optimizer's rem = 1 - used)
  const remR = (stopReach ? lockR : realizedR) * Math.max(0, 1 - used);
  return bankedR + remR - feeR;
}

const rows = [];
for (const [name, prof] of Object.entries(PROFILES))
  for (const s of STOP_PCTS) {
    const cell = { profile: name, stopPct: s };
    for (const mode of ['pess', 'blend', 'opt']) {
      const rs = episodes.map((e) => replay(e, prof, s, mode));
      const e = rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
      const wr = rs.filter((r) => r > 0).length / (rs.length || 1);
      cell[mode] = { eR: +e.toFixed(4), wr: +wr.toFixed(3) };
    }
    cell.score = +(cell.blend.eR * (1 + cell.blend.wr)).toFixed(4);
    rows.push(cell);
  }
rows.sort((a, b) => b.blend.eR - a.blend.eR);

// as-traded baseline: what the engine actually captured per episode
const asTraded = episodes.map((e) => {
  const sgn = e.side === 'long' ? 1 : -1;
  return ((e.exit - e.entry) / e.entry) * sgn * 100;
});
const asTradedMean = asTraded.reduce((a, b) => a + b, 0) / (asTraded.length || 1);

// empirical edge fit: pooled conditional hit-rate at observed mfe/mae pairs
// p_hit(m·s | episode) ~ reach share where mfe >= m*s — fitted scalar edge
// for the diffusion form edge/(1+m) via least squares over the episode set.
let num = 0, den = 0;
for (const s of STOP_PCTS)
  for (const e of episodes)
    for (const m of [0.5, 0.7, 1.0, 1.5, 2.0, 3.0]) {
      const obs = e.mfePct >= m * s ? 1 : 0;
      const pred01 = 1 / (1 + m);          // unit-edge prediction
      num += obs * pred01; den += pred01 * pred01;
    }
const edgeFit = episodes.length >= 20 ? Math.min(2, Math.max(0.1, num / den)) : null;

const out = {
  refreshedAt: new Date().toISOString(),
  episodes: episodes.length,
  closes: closes.length,
  observed: {
    episodeWinShare: +(episodes.filter((e) => ((e.exit - e.entry) / e.entry) * (e.side === 'long' ? 1 : -1) > 0).length / (episodes.length || 1)).toFixed(3),
    episodeMeanPct: +asTradedMean.toFixed(3),
    closeWinShare: +(closeWins / (closes.length || 1)).toFixed(3),
    closeNetUsd: +closeNet.toFixed(2),
    medMaePct: episodes.map((e) => e.maePct).sort((a, b) => a - b)[Math.floor(episodes.length / 2)] ?? null,
    medMfePct: episodes.map((e) => e.mfePct).sort((a, b) => a - b)[Math.floor(episodes.length / 2)] ?? null,
  },
  edgeEmpirical: edgeFit == null ? null : +edgeFit.toFixed(3),
  ranked: rows,
  winnerBlend: rows[0] || null,
  note: 'n=43 episodes — small-sample; blend uses diffusion weight 1/(1+m) only where path order is ambiguous. Envelope [pess,opt] bounds truth. MFE measured during engine holding period — deeper counterfactual legs may undercount.',
};
fs.mkdirSync(A(''), { recursive: true });
writeCheckedJson(A('rr-backtest.json'), out);

console.log(`episodes=${episodes.length} closes=${closes.length} | epWin=${(out.observed.episodeWinShare * 100).toFixed(1)}% closeWin=${(out.observed.closeWinShare * 100).toFixed(1)}% | epMean=${asTradedMean.toFixed(2)}% netCloses=$${closeNet.toFixed(0)} | edgeFit=${edgeFit == null ? 'n/a' : edgeFit.toFixed(2)}`);
console.log('RANKED (blend E[R] | pess..opt envelope):');
for (const r of rows.slice(0, 14))
  console.log(`${r.blend.eR >= 0 ? '+' : ''}${r.blend.eR}R | wr ${(r.blend.wr * 100).toFixed(0)}% | env ${r.pess.eR}..${r.opt.eR} | ${r.profile} @${r.stopPct}%`);
