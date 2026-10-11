// Strategy discovery on REAL market paths — entry filters × exit geometry.
// Train/test split is TEMPORAL (first 60% of each symbol's history = train,
// last 40% = held-out test). A cell only counts if it replicates on test —
// this is the anti-selection-bias harness the +7.7 needed the first time.
import fs from 'fs';

const LIB = JSON.parse(fs.readFileSync(process.env.KLIB || 'C:/Users/beaue/AppData/Local/Temp/klines-lib.json', 'utf8'));
const SYMS = Object.keys(LIB).filter((s) => LIB[s].length > 500);
const SPLIT = 0.6;
const TRAIN = {}, TEST = {};
for (const s of SYMS) {
  const b = LIB[s], cut = (b.length * SPLIT) | 0;
  const mk = (arr) => ({ c: Float64Array.from(arr.map((x) => x.c)), h: Float64Array.from(arr.map((x) => x.h)), l: Float64Array.from(arr.map((x) => x.l)) });
  TRAIN[s] = mk(b.slice(0, cut)); TEST[s] = mk(b.slice(cut));
}

const FEE_RT = 0.12;
const MAX_BARS = 288;

function ep(K, start, p) {
  const entry = K.c[start];
  let peak = 0;
  for (let i = 1; i <= MAX_BARS && start + i < K.c.length; i++) {
    const lo = (K.l[start + i] / entry - 1) * 100;
    const hi = (K.h[start + i] / entry - 1) * 100;
    if (hi > peak) peak = hi;
    if (lo <= p.stop) return { ret: p.stop - FEE_RT, bars: i };
    if (i >= p.minHold) {
      if (p.tp > 0 && hi >= p.tp) return { ret: p.tp - FEE_RT, bars: i };
      const close = (K.c[start + i] / entry - 1) * 100;
      if (peak >= p.vPeak && (peak - close) / peak >= p.vGB) return { ret: close - FEE_RT, bars: i };
    }
  }
  const last = Math.min(start + MAX_BARS, K.c.length - 1);
  return { ret: (K.c[last] / entry - 1) * 100 - FEE_RT, bars: last - start };
}

function sample(lib, p, n) {
  let sum = 0, sq = 0, wins = 0, used = 0;
  for (let i = 0; i < n; i++) {
    const s = SYMS[(Math.random() * SYMS.length) | 0];
    const K = lib[s];
    let start = -1;
    for (let t = 0; t < 30; t++) {
      const c = p.momLB + 1 + ((Math.random() * (K.c.length - MAX_BARS - p.momLB - 2)) | 0);
      const roc = (K.c[c] / K.c[c - p.momLB] - 1) * 100;
      if (p.momLB === 0 || (roc >= p.momMin && roc <= (p.momMax ?? 1e9))) { start = c; break; }
    }
    if (start < 0) continue;
    const e = ep(K, start, p);
    used++; sum += e.ret; sq += e.ret * e.ret; wins += e.ret > 0 ? 1 : 0;
  }
  const mean = sum / used, sd = Math.sqrt(Math.max(1e-9, sq / used - mean * mean));
  return { n: used, wr: (wins / used) * 100, mean, sqn: (mean / sd) * 10 };
}

const ENTRIES = [
  { momLB: 0, momMin: 0, tag: 'any' },
  { momLB: 24, momMin: 0, tag: 'mom24>0' },
  { momLB: 24, momMin: 1, tag: 'mom24>1%' },
  { momLB: 48, momMin: 0, tag: 'mom48>0' },
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
for (const en of ENTRIES) for (const st of STOPS) for (const ex of EXITS) for (const h of HOLDS) {
  cells.push({ ...en, stop: -st, tp: ex.tp, vPeak: 0.35, vGB: ex.vGB || 0.40, minHold: h, tag: `${en.tag} × stop${st} × ${ex.tag} × hold${h}` });
}

console.log(`sweeping ${cells.length} cells × 60k eps on TRAIN...`);
const results = [];
for (const p of cells) {
  const r = sample(TRAIN, p, 60000);
  results.push({ p, ...r });
}
results.sort((a, b) => b.sqn - a.sqn);
console.log('\n=== TOP 25 TRAIN ===');
for (const r of results.slice(0, 25)) console.log(`  SQN ${r.sqn.toFixed(2).padStart(6)} | ${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}% | WR ${r.wr.toFixed(0)}% | ${r.p.tag}`);

console.log('\n=== TOP 15 — 500k-eps validation on TRAIN + held-out TEST ===');
const survivors = [];
for (const r of results.slice(0, 15)) {
  const tr = sample(TRAIN, r.p, 500000);
  const te = sample(TEST, r.p, 500000);
  const ok = tr.mean > 0 && te.mean > 0;
  if (ok) survivors.push({ p: r.p, tr, te });
  console.log(`  ${ok ? '✓' : '✗'} ${r.p.tag.padEnd(32)} | train ${tr.mean >= 0 ? '+' : ''}${tr.mean.toFixed(3)}% SQN ${tr.sqn.toFixed(2)} | TEST ${te.mean >= 0 ? '+' : ''}${te.mean.toFixed(3)}% SQN ${te.sqn.toFixed(2)}`);
}
console.log(`\n${survivors.length}/15 replicated positive on held-out test`);
if (survivors.length) {
  const best = survivors.sort((a, b) => b.te.sqn - a.te.sqn)[0];
  console.log(`BEST VALIDATED: ${best.p.tag} — test SQN ${best.te.sqn.toFixed(2)}, ${best.te.mean >= 0 ? '+' : ''}${best.te.mean.toFixed(3)}%/trade, WR ${best.te.wr.toFixed(0)}%`);
}
