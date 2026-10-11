// 1M-episode paper-trading engine — replays REAL Bitget 5m paths bar-by-bar.
// Each episode: enter long at a random (symbol, start) in the kline library,
// then apply the exit policy tick-by-tick with intrabar stop/TP resolution.
//
// Arm A "DISCOVERED": hard stop -1%, TP +1% armed ONLY after 120min hold
//   (the min-hold rule), giveback vanish 40% of peak (peak>=0.35%) after
//   min-hold, 24h hard cap. Taker fees both ways (0.12% RT) — conservative.
// Arm B "SCALPER": same geometry but NO min-hold — TP/vanish fire from bar 1.
//   This is the pre-discovery behavior.
import fs from 'fs';

const LIB = JSON.parse(fs.readFileSync(process.env.KLIB || 'C:/Users/beaue/AppData/Local/Temp/klines-lib.json', 'utf8'));
const SYMS = Object.keys(LIB).filter((s) => LIB[s].length > 400);
for (const s of SYMS) {
  const b = LIB[s];
  LIB[s] = { ts: Float64Array.from(b.map((x) => x.ts)), o: Float64Array.from(b.map((x) => x.o)), h: Float64Array.from(b.map((x) => x.h)), l: Float64Array.from(b.map((x) => x.l)), c: Float64Array.from(b.map((x) => x.c)) };
}

const FEE_RT = 0.12;            // taker round-trip %
const STOP = -1.0, TP = 1.0;    // discovered flat-1:1 @1%
const MIN_HOLD_BARS = 24;       // 120min at 5m
const VANISH_PEAK = 0.35, VANISH_GB = 0.40;
const MAX_BARS = 288;           // 24h cap

function runEpisode(minHold, momLookback) {
  const s = SYMS[(Math.random() * SYMS.length) | 0];
  const K = LIB[s];
  let start = -1;
  for (let tries = 0; tries < 40; tries++) {
    const c = (momLookback + 1) + ((Math.random() * (K.c.length - MAX_BARS - momLookback - 2)) | 0);
    if (!momLookback || K.c[c] > K.c[c - momLookback]) { start = c; break; }
  }
  if (start < 0) return { ret: 0, bars: 0, exit: 'skip' };
  const entry = K.c[start];
  let peak = 0;
  for (let i = 1; i <= MAX_BARS; i++) {
    const bar = K.c[start + i];
    const lo = (K.l[start + i] / entry - 1) * 100;
    const hi = (K.h[start + i] / entry - 1) * 100;
    if (hi > peak) peak = hi;
    const barsIn = i;
    const holdOk = barsIn >= minHold;
    // hard stop always live — intrabar low touches first (conservative: stop wins ties)
    if (lo <= STOP) return { ret: STOP - FEE_RT, bars: barsIn, exit: 'stop' };
    if (holdOk) {
      if (hi >= TP) return { ret: TP - FEE_RT, bars: barsIn, exit: 'tp' };
      const close = (bar / entry - 1) * 100;
      if (peak >= VANISH_PEAK && (peak - close) / peak >= VANISH_GB) return { ret: close - FEE_RT, bars: barsIn, exit: 'vanish' };
    }
  }
  const close = (K.c[Math.min(start + MAX_BARS, K.c.length - 1)] / entry - 1) * 100;
  return { ret: close - FEE_RT, bars: MAX_BARS, exit: 'cap' };
}

const N = 1e6;
for (const [name, minHold, mom] of [
  ['RANDOM entry + min-hold', MIN_HOLD_BARS, 0],
  ['RANDOM entry + scalp exits', 0, 0],
  ['MOMENTUM entry + min-hold', MIN_HOLD_BARS, 24],
  ['MOMENTUM entry + scalp exits', 0, 24],
]) {
  let wins = 0, sum = 0, sumSq = 0, sumBars = 0;
  const exits = { stop: 0, tp: 0, vanish: 0, cap: 0 };
  const durWins = { '<30m': [0, 0], '30-120m': [0, 0], '>120m': [0, 0] };
  let n = 0;
  for (let i = 0; i < N; i++) {
    const e = runEpisode(minHold, mom);
    if (e.exit === 'skip') continue;
    n++;
    wins += e.ret > 0 ? 1 : 0;
    sum += e.ret; sumSq += e.ret * e.ret; sumBars += e.bars;
    exits[e.exit]++;
    const d = e.bars < 6 ? '<30m' : e.bars < 24 ? '30-120m' : '>120m';
    durWins[d][0]++; durWins[d][1] += e.ret > 0 ? 1 : 0;
  }
  const mean = sum / n, sd = Math.sqrt(sumSq / n - mean * mean);
  const sqn = (mean / sd) * Math.sqrt(100);
  console.log(`\n=== ${name} — ${n.toLocaleString()} episodes ===`);
  console.log(`  WR ${((wins / n) * 100).toFixed(1)}% | mean ${mean >= 0 ? '+' : ''}${mean.toFixed(3)}%/trade | sd ${sd.toFixed(3)} | SQN100 ${sqn.toFixed(2)} | avg hold ${(sumBars / n * 5).toFixed(0)}min`);
  console.log(`  exits: ${Object.entries(exits).map(([k, v]) => `${k} ${((v / n) * 100).toFixed(0)}%`).join(' · ')}`);
  console.log(`  hold-time WR: ${Object.entries(durWins).map(([k, [n, w]]) => `${k} ${n ? ((w / n) * 100).toFixed(0) : '-'}%`).join(' · ')}`);
}
