// CENSUS — every real episode, deterministically. No Monte Carlo, no RNG.
// For each strategy cell: iterate EVERY valid start bar in every symbol
// (train = first 60% of history, test = last 40%), apply the exit policy
// bar-by-bar, record the outcome. This is the complete set of real episodes
// the data contains — the definitive test, not a sample of one.
import fs from 'fs';

const LIB = JSON.parse(fs.readFileSync(process.env.KLIB || 'C:/Users/beaue/AppData/Local/Temp/klines-lib.json', 'utf8'));
const SYMS = Object.keys(LIB).filter((s) => LIB[s].length > 500);
const SPLIT = 0.6, MAX_BARS = 288, FEE_RT = 0.12;
const TRAIN = {}, TEST = {};
for (const s of SYMS) {
  const b = LIB[s], cut = (b.length * SPLIT) | 0;
  const mk = (arr) => ({ c: Float64Array.from(arr.map((x) => x.c)), h: Float64Array.from(arr.map((x) => x.h)), l: Float64Array.from(arr.map((x) => x.l)) });
  TRAIN[s] = mk(b.slice(0, Math.max(50, cut - MAX_BARS)));
  TEST[s] = mk(b.slice(cut));
}

function ep(K, start, p) {
  const entry = K.c[start];
  let peak = 0;
  for (let i = 1; i <= MAX_BARS && start + i < K.c.length; i++) {
    const lo = (K.l[start + i] / entry - 1) * 100;
    const hi = (K.h[start + i] / entry - 1) * 100;
    if (hi > peak) peak = hi;
    if (lo <= p.stop) return p.stop - FEE_RT;
    if (i >= p.minHold) {
      if (p.tp > 0 && hi >= p.tp) return p.tp - FEE_RT;
      const close = (K.c[start + i] / entry - 1) * 100;
      if (peak >= p.vPeak && (peak - close) / peak >= p.vGB) return close - FEE_RT;
    }
  }
  const last = Math.min(start + MAX_BARS, K.c.length - 1);
  return (K.c[last] / entry - 1) * 100 - FEE_RT;
}

function census(lib, p) {
  let n = 0, sum = 0, sq = 0, wins = 0;
  for (const s of SYMS) {
    const K = lib[s];
    for (let start = p.momLB + 1; start + 2 < K.c.length; start++) {
      if (p.momLB) {
        const roc = (K.c[start] / K.c[start - p.momLB] - 1) * 100;
        if (roc < p.momMin || roc > (p.momMax ?? 1e9)) continue;
      }
      const r = ep(K, start, p);
      n++; sum += r; sq += r * r; wins += r > 0 ? 1 : 0;
    }
  }
  const mean = sum / n, sd = Math.sqrt(Math.max(1e-9, sq / n - mean * mean));
  return { n, wr: (wins / n) * 100, mean, sqn: (mean / sd) * 10 };
}

const ENTRIES = [
  { momLB: 0, momMin: 0, tag: 'any' },
  { momLB: 24, momMin: 0, tag: 'mom24>0' },
  { momLB: 24, momMin: 1, tag: 'mom24>1%' },
  { momLB: 24, momMin: 2, tag: 'mom24>2%' },
  { momLB: 48, momMin: 0, tag: 'mom48>0' },
  { momLB: 48, momMin: 2, tag: 'mom48>2%' },
  { momLB: 24, momMin: -99, momMax: -1, tag: 'dip24<-1%' },
];
const STOPS = [0.5, 1.0, 1.5, 2.0, 3.0];
const EXITS = [
  { tp: 0.5, tag: 'tp0.5' }, { tp: 1.0, tag: 'tp1' }, { tp: 1.5, tag: 'tp1.5' },
  { tp: 2.0, tag: 'tp2' }, { tp: 3.0, tag: 'tp3' },
  { tp: 0, vGB: 0.30, tag: 'trail30' }, { tp: 0, vGB: 0.50, tag: 'trail50' },
];
const HOLDS = [0, 24];

const cells = [];
for (const en of ENTRIES) for (const st of STOPS) for (const ex of EXITS) for (const h of HOLDS)
  cells.push({ ...en, stop: -st, tp: ex.tp, vPeak: 0.35, vGB: ex.vGB || 0.40, minHold: h, tag: `${en.tag} × stop${st} × ${ex.tag} × hold${h}` });

console.log(`CENSUS: ${cells.length} cells × every real start — no RNG`);
const t0 = Date.now();
const results = [];
for (const p of cells) results.push({ p, ...census(TRAIN, p) });
results.sort((a, b) => b.sqn - a.sqn);
console.log(`train census done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${results[0].n} episodes/cell ×${cells.length} cells = ${(results[0].n * cells.length).toLocaleString()} DIRECT REAL TESTS`);

console.log('\n=== TOP 20 TRAIN (complete enumeration) ===');
for (const r of results.slice(0, 20))
  console.log(`  SQN ${r.sqn.toFixed(2).padStart(6)} | ${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}% | WR ${r.wr.toFixed(0)}% | n=${r.n} | ${r.p.tag}`);

console.log('\n=== TOP 15 — held-out TEST census (every real episode, out-of-sample) ===');
const survivors = [];
for (const r of results.slice(0, 15)) {
  const te = census(TEST, r.p);
  const ok = r.mean > 0 && te.mean > 0;
  if (ok) survivors.push({ p: r.p, tr: r, te });
  console.log(`  ${ok ? '✓' : '✗'} ${r.p.tag.padEnd(34)} | train ${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}% SQN ${r.sqn.toFixed(2)} | TEST ${te.mean >= 0 ? '+' : ''}${te.mean.toFixed(3)}% SQN ${te.sqn.toFixed(2)} n=${te.n}`);
}
console.log(`\n${survivors.length}/15 positive on BOTH halves of real history`);
for (const s of survivors.sort((a, b) => b.te.sqn - a.te.sqn).slice(0, 5))
  console.log(`  VALIDATED: ${s.p.tag} — test ${s.te.mean >= 0 ? '+' : ''}${s.te.mean.toFixed(3)}%/trade, SQN ${s.te.sqn.toFixed(2)}, WR ${s.te.wr.toFixed(0)}%, n=${s.te.n} real episodes`);
