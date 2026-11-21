// jackpot.cjs — mine the ALPHA engine for jackpot structure.
// Stage 1: N random configs x SEEDS1 seeds, keep {medRet, medSharpe, ruin, p90, p99}.
// Stage 2: top-K by (medSharpe s.t. ruin<=2%) confirmed at SEEDS2 seeds (out-of-sample range).
// Stage 3: on the winner's best seeds, ablate each slot -> which engine makes the jackpot.
const Sim = require('./sim.js');

const INSTR = Object.keys(Sim.INSTRUMENTS);
const STRATS = Object.keys(Sim.STRATEGIES);
const P = (s) => Sim.STRATEGIES[s].param;
const R = (a, b) => a + Math.random() * (b - a);
const RI = (a, b) => Math.floor(R(a, b + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function randSlot() {
  const strategy = pick(STRATS);
  const p = P(strategy);
  return {
    instrument: pick(INSTR), strategy,
    param: p ? RI(p.min, p.max) : 0,
    alloc: 0, ddLimit: R(0.08, 0.25), lev: pick([1, 1, 1, 1, 2, 2, 3]),
  };
}
function randConfig() {
  const n = RI(2, 5), slots = [];
  for (let i = 0; i < n; i++) slots.push(randSlot());
  let sum = 0;
  for (const s of slots) { s.alloc = R(0.05, 0.6); sum += s.alloc; }
  const f = Math.min(1, 1 / sum) * R(0.55, 1.0);
  for (const s of slots) s.alloc *= f;
  return { slots };
}
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const med = (xs) => q(xs, 0.5);

function evalConfig(cfg, seeds, seedBase = 1, keepRuns = false) {
  const rets = [], dds = [], sharpes = [], runs = [];
  let ruin = 0;
  for (let i = 0; i < seeds; i++) {
    const g = new Sim.Game({ seed: seedBase + i, slots: cfg.slots });
    while (!g.over) g.step();
    const r = g.result;
    if (r.status === 'LIQUIDATED') ruin++;
    rets.push(r.totalRet); dds.push(r.maxDD); sharpes.push(r.sharpe);
    if (keepRuns) runs.push({ seed: seedBase + i, ret: r.totalRet });
  }
  rets.sort((a, b) => a - b);
  return { ruin: ruin / seeds, medRet: med(rets), medDD: med(dds), medSharpe: med(sharpes), p90: q(rets, 0.9), p99: q(rets, 0.99), runs };
}
const fmt = (cfg) => cfg.slots.map(s => `${(s.alloc * 100).toFixed(0)}% ${s.instrument}/${s.strategy}${s.param ? '(' + s.param + ')' : ''}${s.lev > 1 ? ' x' + s.lev : ''} dd${(s.ddLimit * 100).toFixed(0)}`).join(' | ');

const N1 = +(process.argv[2] || 4000), SEEDS1 = +(process.argv[3] || 30), SEEDS2 = +(process.argv[4] || 300), TOPK = +(process.argv[5] || 12);
console.log(`stage1: ${N1} configs x ${SEEDS1} seeds`);
const scored = [];
for (let i = 0; i < N1; i++) {
  const cfg = randConfig();
  const e = evalConfig(cfg, SEEDS1);
  if (e.ruin <= 0.03) scored.push({ cfg, ...e });
}
scored.sort((a, b) => b.medSharpe - a.medSharpe);
const jackpotSort = [...scored].sort((a, b) => b.p90 - a.p90);
console.log(`  survivors ${scored.length}/${N1} (ruin<=3%)`);
console.log('\nbest jackpot-hunters (p90):');
for (const t of jackpotSort.slice(0, 5)) console.log(`  p90 ${(t.p90 * 100).toFixed(1)}% p99 ${(t.p99 * 100).toFixed(1)}% med ${(t.medRet * 100).toFixed(1)}% sharpe ${t.medSharpe.toFixed(2)} :: ${fmt(t.cfg)}`);

console.log(`\nstage2: top ${TOPK} by sharpe x ${SEEDS2} fresh seeds`);
const finals = [];
for (const t of scored.slice(0, TOPK)) {
  const e = evalConfig(t.cfg, SEEDS2, 777000, true);
  finals.push({ cfg: t.cfg, ...e });
}
finals.sort((a, b) => b.medSharpe - a.medSharpe);
const win = finals[0];
console.log(`\nWINNER  sharpe ${win.medSharpe.toFixed(2)}  med ${(win.medRet * 100).toFixed(1)}%  p90 ${(win.p90 * 100).toFixed(1)}%  p99 ${(win.p99 * 100).toFixed(1)}%  dd ${(win.medDD * 100).toFixed(1)}%  ruin ${(win.ruin * 100).toFixed(1)}%`);
console.log(`  ${fmt(win.cfg)}`);

// stage3 — jackpot attribution: on the winner's top-8 seeds, kill one slot at a time
const topSeeds = [...win.runs].sort((a, b) => b.ret - a.ret).slice(0, 8);
console.log('\nstage3: jackpot attribution on top-8 seeds');
for (const { seed, ret } of topSeeds) {
  const line = [`seed ${seed}: +${(ret * 100).toFixed(1)}%`];
  for (let k = 0; k < win.cfg.slots.length; k++) {
    const ab = { slots: win.cfg.slots.filter((_, j) => j !== k) };
    const g = new Sim.Game({ seed, slots: ab.slots });
    while (!g.over) g.step();
    const delta = ret - g.result.totalRet;
    const s = win.cfg.slots[k];
    line.push(`  -${s.instrument}/${s.strategy}${s.param ? '(' + s.param + ')' : ''} ${(s.alloc * 100).toFixed(0)}%${s.lev > 1 ? ' x' + s.lev : ''}: ${delta >= 0 ? '-' : '+'}${(Math.abs(delta) * 100).toFixed(1)}pts`);
  }
  console.log(line.join('\n'));
}

// aggregate: how often does each (instrument,strategy) appear in top-decile configs?
const decile = scored.slice(0, Math.max(10, Math.floor(scored.length / 10)));
const freq = {};
for (const t of decile) for (const s of t.cfg.slots) {
  const k = `${s.instrument}/${s.strategy}`;
  freq[k] = freq[k] || { n: 0, alloc: 0, lev: 0 };
  freq[k].n++; freq[k].alloc += s.alloc; freq[k].lev += s.lev;
}
console.log('\ntop-decile config anatomy (slot presence / avg alloc / avg lev):');
Object.entries(freq).sort((a, b) => b[1].n - a[1].n).slice(0, 12).forEach(([k, v]) =>
  console.log(`  ${k.padEnd(28)} n=${v.n} avgAlloc=${(v.alloc / v.n * 100).toFixed(0)}% avgLev=${(v.lev / v.n).toFixed(1)}`));
