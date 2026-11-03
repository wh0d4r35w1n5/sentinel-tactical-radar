#!/usr/bin/env node
// mc-find.mjs — max-SQN DISCOVERY engine: sweeps entry-side filter subsets
// × exit profiles × stop widths × fee models and ranks by analytic SQN_100.
// Exact empirical moments — no MC noise. Filters with n<MIN_N episodes are
// dropped; the top of the board is the system's highest-quality niche.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = (f) => path.join(ROOT, 'state', f);
const A = (f) => path.join(ROOT, 'api', f);

const MIN_N = +(process.env.MC_FIND_MIN_N || 6);
const FEE_MODELS = { taker: 0.12, maker: 0.04 };
const BE_LOCK_PCT = 0.3;
const PROFILES = {
  'flat-1:0.5':  { legs: [[0.5, 1.0]], moon: 0 },
  'flat-1:0.75': { legs: [[0.75, 1.0]], moon: 0 },
  'flat-1:1':    { legs: [[1.0, 1.0]], moon: 0 },
  'flat-1:1.5':  { legs: [[1.5, 1.0]], moon: 0 },
  'flat-1:2':    { legs: [[2.0, 1.0]], moon: 0 },
  'flat-1:3':    { legs: [[3.0, 1.0]], moon: 0 },
  'flat-1:4':    { legs: [[4.0, 1.0]], moon: 0 },
  'flat-1:6':    { legs: [[6.0, 1.0]], moon: 0 },
  'current-ladder': { legs: [[0.55, .40], [1.0, .30], [1.8, .15]], moon: .15 },
  'stair-1/2/3+15': { legs: [[1.0, .25], [2.0, .30], [3.0, .30]], moon: .15 },
  'runner-1.5/3/5+15': { legs: [[1.5, .20], [3.0, .30], [5.0, .35]], moon: .15 },
  'runner-2/4/8+15':   { legs: [[2.0, .20], [4.0, .30], [8.0, .35]], moon: .15 },
  'sniper-2/4/7+15':   { legs: [[2.0, .15], [4.0, .25], [7.0, .45]], moon: .15 },
  'scalp-.15/.35/.7':  { legs: [[0.15, .35], [0.35, .30], [0.7, .20]], moon: .15 },
};
const STOP_PCTS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];

const MAJORS = new Set(['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','NEARUSDT','LTCUSDT','BCHUSDT','AVAXUSDT','DOTUSDT','ATOMUSDT','UNIUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT','TIAUSDT','SUIUSDT','SEIUSDT']);
const MEMES = new Set(['PEPEUSDT','WIFUSDT','BONKUSDT','FARTCOINUSDT','USELESSUSDT','MOODENGUSDT','PNUTUSDT','MEWUSDT','ACTUSDT','GOATUSDT','NEIROUSDT','BRETTUSDT','POPCATUSDT','FLOKIUSDT','SHIBUSDT','MEMEUSDT','CHIPUSDT','MAGICUSDT','SUSDT']);

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
    bankedR += a * m * w; used += a * w;
    if (w > 0) lockR = Math.max(lockR, k === 0 ? beLockR : prof.legs[k - 1][0]);
  }
  const remR = (stopReach ? lockR : realizedR) * Math.max(0, 1 - used);
  return bankedR + remR - feeR;
}

const episodes = (JSON.parse(fs.readFileSync(S('mae-mfe.json'), 'utf8')).episodes || [])
  .filter((e) => +e.entry > 0 && Number.isFinite(+e.exit) && Number.isFinite(+e.maePct) && Number.isFinite(+e.mfePct));

// ---- entry-side filter space ----------------------------------------------
const FILTERS = { all: () => true };
for (const side of ['long', 'short']) FILTERS[`side=${side}`] = (e) => e.side === side;
FILTERS['class=majors'] = (e) => MAJORS.has(e.sym);
FILTERS['class=memes']  = (e) => MEMES.has(e.sym);
FILTERS['class=alts']   = (e) => !MAJORS.has(e.sym) && !MEMES.has(e.sym);
for (const [band, lo, hi] of [['dur<5', 0, 5], ['dur5-30', 5, 30], ['dur30-120', 30, 120], ['dur>120', 120, 1e9]])
  FILTERS[band] = (e) => +e.durMin >= lo && +e.durMin < hi;
for (const [band, lo, hi] of [['utc0-8', 0, 8], ['utc8-16', 8, 16], ['utc16-24', 16, 24]])
  FILTERS[band] = (e) => { const h = new Date(+e.ts).getUTCHours(); return h >= lo && h < hi; };
const strats = [...new Set(episodes.map((e) => e.strat || 'unattributed'))];
for (const st of strats) FILTERS[`strat=${st}`] = (e) => (e.strat || 'unattributed') === st;
const syms = [...new Set(episodes.map((e) => e.sym))];
for (const sy of syms) FILTERS[`sym=${sy}`] = (e) => e.sym === sy;
// two-factor combos that matter for style
FILTERS['long+memes'] = (e) => e.side === 'long' && MEMES.has(e.sym);
FILTERS['long+alts']  = (e) => e.side === 'long' && !MAJORS.has(e.sym) && !MEMES.has(e.sym);
FILTERS['long+majors']= (e) => e.side === 'long' && MAJORS.has(e.sym);
for (const st of strats) FILTERS[`long+${st}`] = (e) => e.side === 'long' && (e.strat || 'unattributed') === st;

const subsets = {};
for (const [name, fn] of Object.entries(FILTERS)) {
  const eps = episodes.filter(fn);
  if (eps.length >= MIN_N) subsets[name] = eps;
}

const out = [];
for (const [fname, eps] of Object.entries(subsets)) {
  for (const [pname, prof] of Object.entries(PROFILES)) {
    for (const s of STOP_PCTS) {
      for (const [feeName, feePct] of Object.entries(FEE_MODELS)) {
        // 3 orderings per episode — same blend as mc-sqn
        const dist = [];
        for (const ep of eps) for (const mode of ['pess', 'blend', 'opt']) dist.push(replay(ep, prof, s, feePct, mode));
        const n = dist.length, mR = dist.reduce((a, r) => a + r, 0) / n;
        const sd = Math.sqrt(Math.max(1e-12, dist.reduce((a, r) => a + r * r, 0) / n - mR * mR));
        const wins = dist.filter((r) => r > 0).length / n;
        out.push({ filter: fname, nEps: eps.length, profile: pname, stopPct: s, fee: feeName,
          eR: +mR.toFixed(4), sdR: +sd.toFixed(4), sqn100: +((mR / sd) * 10).toFixed(3), wr: +wins.toFixed(3) });
      }
    }
  }
}
out.sort((a, b) => b.sqn100 - a.sqn100);
const res = {
  refreshedAt: new Date().toISOString(),
  model: 'analytic SQN_100 = (E[R]/sdR)*10 over empirical R dist (3-ordering blend); entry-filter × profile × stop × fee discovery sweep',
  episodes: episodes.length, subsetsScored: Object.keys(subsets).length, cells: out.length, minN: MIN_N,
  caveat: 'max-SQN over a large filter grid is selection-biased upward; treat the winner as a HYPOTHESIS to forward-test, not a guarantee. n>=30 preferred for trust.',
  top40: out.slice(0, 40),
  worst10: out.slice(-10),
};
fs.writeFileSync(A('mc-find.json'), JSON.stringify(res, null, 1));
console.log(`swept ${Object.keys(subsets).length} subsets × ${Object.keys(PROFILES).length} profiles × ${STOP_PCTS.length} stops × 2 fees = ${out.length} cells on ${episodes.length} episodes`);
console.log('\n=== TOP 15 BY SQN ===');
for (const o of out.slice(0, 15))
  console.log(`SQN ${o.sqn100 >= 0 ? '+' : ''}${o.sqn100} | ${o.eR >= 0 ? '+' : ''}${o.eR}R wr${(o.wr * 100).toFixed(0)}% n${o.nEps} | ${o.filter} × ${o.profile} @${o.stopPct}% ${o.fee}`);
