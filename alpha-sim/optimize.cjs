// optimize.cjs — mine the ALPHA engine for the best-performing desk config.
// Random-search slots configs; score = median total return across seeds,
// hard-killed if ruin rate > 2%. Two-stage: coarse 40-seed pass, then
// 200-seed confirm on the top 10.
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
    instrument: pick(INSTR),
    strategy,
    param: p ? RI(p.min, p.max) : 0,
    alloc: 0, ddLimit: R(0.08, 0.25), lev: pick([1, 1, 1, 2, 2, 3]),
  };
}
function randConfig() {
  const n = RI(2, 5);
  const slots = [];
  for (let i = 0; i < n; i++) slots.push(randSlot());
  let sum = 0;
  for (const s of slots) { s.alloc = R(0.05, 0.6); sum += s.alloc; }
  const f = Math.min(1, 1 / sum) * R(0.6, 1.0);
  for (const s of slots) s.alloc *= f;
  return { slots };
}
function med(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

function evalConfig(cfg, seeds, seedBase = 1) {
  const rets = [], dds = [], sharpes = [];
  let ruin = 0;
  for (let i = 0; i < seeds; i++) {
    const g = new Sim.Game({ seed: seedBase + i, slots: cfg.slots });
    while (!g.over) g.step();
    const r = g.result;
    if (r.status === 'LIQUIDATED') ruin++;
    rets.push(r.totalRet); dds.push(r.maxDD); sharpes.push(r.sharpe);
  }
  return { ruin: ruin / seeds, medRet: med(rets), medDD: med(dds), medSharpe: med(sharpes) };
}

const N1 = +(process.argv[2] || 2000);
const scored = [];
for (let i = 0; i < N1; i++) {
  const cfg = randConfig();
  const e = evalConfig(cfg, 40);
  if (e.ruin <= 0.02) scored.push({ cfg, ...e });
}
scored.sort((a, b) => b.medSharpe - a.medSharpe);
let pool = scored.slice(0, 20);
console.log(`pass1: ${scored.length}/${N1} configs survived ruin<=2% — hillclimbing top ${pool.length}`);

// ---- pass 2: hillclimb — mutate each survivor (jitter alloc/param/lev) ----
function mutate(cfg) {
  const slots = cfg.slots.map(s => ({ ...s }));
  const i = RI(0, slots.length - 1), s = slots[i];
  const which = pick(['alloc', 'param', 'lev', 'dd', 'add', 'drop']);
  if (which === 'alloc') s.alloc = Math.max(0.01, s.alloc * R(0.6, 1.6));
  if (which === 'param' && P(s.strategy)) s.param = Math.max(P(s.strategy).min, Math.min(P(s.strategy).max, s.param + RI(-8, 8)));
  if (which === 'lev') s.lev = pick([1, 1, 2, 2, 3, 4]);
  if (which === 'dd') s.ddLimit = R(0.06, 0.28);
  if (which === 'add' && slots.length < 6) slots.push(randSlot());
  if (which === 'drop' && slots.length > 2) slots.splice(RI(0, slots.length - 1), 1);
  let sum = slots.reduce((a, x) => a + x.alloc, 0) || 1;
  for (const x of slots) x.alloc /= sum;
  return { slots };
}
for (let round = 0; round < 3; round++) {
  const cand = [...pool];
  for (const t of pool) for (let k = 0; k < 6; k++) cand.push({ cfg: mutate(t.cfg) });
  const scored2 = [];
  for (const c of cand) {
    const e = evalConfig(c.cfg || c, 40);
    if (e.ruin <= 0.02) scored2.push({ cfg: c.cfg || c, ...e });
  }
  scored2.sort((a, b) => b.medSharpe - a.medSharpe);
  pool = scored2.slice(0, 20);
  console.log(`  round ${round + 1}: best sharpe ${pool[0].medSharpe.toFixed(2)}`);
}

console.log('\nfinal — 300-seed confirm on top 10:');
for (const t of pool.slice(0, 10)) {
  const e2 = evalConfig(t.cfg, 300, 50000);
  Object.assign(t, { conf: e2 });
  console.log(
    `sharpe ${e2.medSharpe.toFixed(2)} ret ${(e2.medRet * 100).toFixed(1)}% dd ${(e2.medDD * 100).toFixed(1)}% ruin ${(e2.ruin * 100).toFixed(0)}% :: ` +
    t.cfg.slots.map(s => `${(s.alloc * 100).toFixed(0)}% ${s.instrument}/${s.strategy}${s.param ? '(' + s.param + ')' : ''}${s.lev > 1 ? ' x' + s.lev : ''} dd${(s.ddLimit * 100).toFixed(0)}`).join(' | ')
  );
}
