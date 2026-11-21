// CENSUS v2 — expanded strategy space, complete enumeration, no RNG.
// Entry families: momentum ROC, pullback-in-uptrend, acceleration,
// RSI-band, hour-of-day. Exits: fixed TP, giveback trail, breakeven-lock,
// trail-arm thresholds, min-hold. Train = first 60% of history (fit),
// test = last 40% (held-out validation). Only dual-positive cells count.
import fs from 'fs';

const LIB = JSON.parse(fs.readFileSync(process.env.KLIB || 'C:/Users/beaue/AppData/Local/Temp/klines-lib.json', 'utf8'));
const SYMS = Object.keys(LIB).filter((s) => LIB[s].length > 500);
const SPLIT = 0.6, MAX_BARS = 288, FEE_RT = 0.12;
const TRAIN = {}, TEST = {};
for (const s of SYMS) {
  const b = LIB[s], cut = (b.length * SPLIT) | 0;
  const mk = (arr) => ({
    ts: Float64Array.from(arr.map((x) => x.ts)),
    c: Float64Array.from(arr.map((x) => x.c)),
    h: Float64Array.from(arr.map((x) => x.h)),
    l: Float64Array.from(arr.map((x) => x.l)),
  });
  TRAIN[s] = mk(b.slice(0, Math.max(60, cut - MAX_BARS)));
  TEST[s] = mk(b.slice(cut));
}

// entry predicates — evaluated at start bar i on series K
const pred = {
  mom24gt1: (K, i) => K.c[i] / K.c[i - 24] - 1 > 0.01,
  mom24gt2: (K, i) => K.c[i] / K.c[i - 24] - 1 > 0.02,
  mom48gt0: (K, i) => K.c[i] / K.c[i - 48] - 1 > 0,
  pullback: (K, i) => K.c[i] / K.c[i - 48] - 1 > 0 && K.c[i] / K.c[i - 6] - 1 < -0.003,
  accel: (K, i) => K.c[i] / K.c[i - 24] - 1 > 0.01 && K.c[i] / K.c[i - 6] - 1 > 0,
  dip24: (K, i) => K.c[i] / K.c[i - 24] - 1 < -0.01,
  rsiLo: (K, i) => rsi(K, i) < 35,
  rsiHi: (K, i) => rsi(K, i) > 65,
  asiaHr: (K, i) => { const h = new Date(+K.ts[i]).getUTCHours(); return h >= 0 && h < 8; },
  usHr: (K, i) => { const h = new Date(+K.ts[i]).getUTCHours(); return h >= 13 && h < 21; },
};
function rsi(K, i) {
  let g = 0, l = 0;
  for (let j = i - 13; j <= i; j++) { const d = K.c[j] - K.c[j - 1]; if (d > 0) g += d; else l -= d; }
  return l === 0 ? 100 : (g / (g + l)) * 100;
}
const LB = 49; // max lookback

function ep(K, start, p) {
  const entry = K.c[start];
  let peak = 0, floor = p.stop;
  for (let i = 1; i <= MAX_BARS && start + i < K.c.length; i++) {
    const lo = (K.l[start + i] / entry - 1) * 100;
    const hi = (K.h[start + i] / entry - 1) * 100;
    if (hi > peak) peak = hi;
    if (p.beArm > 0 && peak >= p.beArm && floor < p.beLock) floor = p.beLock;
    if (lo <= floor) return floor - FEE_RT;
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
    for (let i = LB; i + 2 < K.c.length; i++) {
      if (p.pred && !p.pred(K, i)) continue;
      const r = ep(K, i, p);
      n++; sum += r; sq += r * r; wins += r > 0 ? 1 : 0;
    }
  }
  if (n < 30) return { n, wr: 0, mean: -9, sqn: -9 };
  const mean = sum / n, sd = Math.sqrt(Math.max(1e-9, sq / n - mean * mean));
  return { n, wr: (wins / n) * 100, mean, sqn: (mean / sd) * 10 };
}

const cells = [];
const entries = Object.entries(pred).map(([tag, f]) => ({ pred: f, tag })).concat([{ pred: null, tag: 'any' }]);
for (const en of entries)
  for (const st of [0.5, 1, 1.5, 2, 3, 4])
    for (const ex of [
      { tp: 1, tag: 'tp1' }, { tp: 2, tag: 'tp2' }, { tp: 3, tag: 'tp3' },
      { tp: 0, vGB: 0.25, vPeak: 0.35, tag: 'tr25' }, { tp: 0, vGB: 0.35, vPeak: 0.35, tag: 'tr35' },
      { tp: 0, vGB: 0.50, vPeak: 0.35, tag: 'tr50' }, { tp: 0, vGB: 0.50, vPeak: 1.0, tag: 'tr50p1' },
      { tp: 0, vGB: 0.60, vPeak: 0.35, tag: 'tr60' },
      { tp: 0, vGB: 0.40, vPeak: 0.35, beArm: 0.8, beLock: 0.1, tag: 'tr40be' },
    ])
      for (const h of [0, 24])
        cells.push({ ...en, stop: -st, tp: ex.tp, vPeak: ex.vPeak || 0.35, vGB: ex.vGB || 0.4, beArm: ex.beArm || 0, beLock: ex.beLock || 0, minHold: h, tag: `${en.tag}×s${st}×${ex.tag}×h${h}` });

console.log(`CENSUS v2: ${cells.length} cells × full enumeration`);
const t0 = Date.now();
const results = cells.map((p) => ({ p, ...census(TRAIN, p) })).filter((r) => r.n >= 30);
results.sort((a, b) => b.sqn - a.sqn);
console.log(`train done ${((Date.now() - t0) / 1000).toFixed(0)}s | ~${results[0].n.toLocaleString()} eps/cell → ${(results.reduce((a, r) => a + r.n, 0)).toLocaleString()} DIRECT REAL TESTS`);

console.log('\n=== TOP 25 TRAIN ===');
for (const r of results.slice(0, 25))
  console.log(`  SQN ${r.sqn.toFixed(2).padStart(6)} | ${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}% | WR ${r.wr.toFixed(0)}% | n=${r.n} | ${r.p.tag}`);

console.log('\n=== TOP 15 — held-out TEST census ===');
const survivors = [];
for (const r of results.slice(0, 15)) {
  const te = census(TEST, r.p);
  const ok = r.mean > 0 && te.mean > 0;
  if (ok && te.n >= 30) survivors.push({ p: r.p, tr: r, te });
  console.log(`  ${ok ? '✓' : '✗'} ${r.p.tag.padEnd(28)} | train ${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)}% SQN ${r.sqn.toFixed(2)} | TEST ${te.mean >= 0 ? '+' : ''}${te.mean.toFixed(3)}% SQN ${te.sqn.toFixed(2)} n=${te.n}`);
}
console.log(`\n${survivors.length}/15 positive on BOTH halves`);
for (const s of survivors.sort((a, b) => b.te.sqn - a.te.sqn).slice(0, 8))
  console.log(`  VALIDATED: ${s.p.tag} — test ${s.te.mean >= 0 ? '+' : ''}${s.te.mean.toFixed(3)}%/trade SQN ${s.te.sqn.toFixed(2)} WR ${s.te.wr.toFixed(0)}% n=${s.te.n}`);
