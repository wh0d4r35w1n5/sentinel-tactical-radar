// batch-sim.cjs — doctrine testbed on Beau's ALPHA engine.
// Runs N seeds per configuration, reports ruin rate / median return / maxDD /
// Sharpe. Each variant maps to a real SENTINEL lesson (ENSO, correlation cap,
// breakers, risk caps). Usage: node batch-sim.cjs [seeds]
const Sim = require('./sim.js');

const SEEDS = +process.argv[2] || 300;
const DAYS = 120;

const MOM = (i, extra = {}) => ({ instrument: i, strategy: 'MOMENTUM', param: 20, alloc: 0.25, lev: 1, ...extra });

const CONFIGS = {
  // The ENSO trade: all-in one correlated momentum bet, no real breaker.
  'ENSO-style (1x mom, 100%, no breaker)': { slots: [{ instrument: 'MEME', strategy: 'MOMENTUM', param: 20, alloc: 1.0, lev: 3, ddLimit: 0.9 }] },
  // JTO/CLSK/SPCX lesson: same beta four times = one bet wearing four hats.
  'correlated beta (4x momentum)': { slots: [MOM('SPX'), MOM('BTC'), MOM('MEME'), MOM('OIL')] },
  // Doctrine book: diversified strategies, real breakers.
  'doctrine (diversified + breakers)': {
    slots: [
      { instrument: 'SPX', strategy: 'MOMENTUM', param: 20, alloc: 0.25, lev: 1, ddLimit: 0.15 },
      { instrument: 'BOND', strategy: 'MEAN_REV', param: 30, alloc: 0.25, lev: 1, ddLimit: 0.12 },
      { instrument: 'GOLD', strategy: 'CARRY', param: 0, alloc: 0.25, lev: 1, ddLimit: 0.10 },
      { instrument: 'BTC', strategy: 'SENTIMENT', param: 7, alloc: 0.25, lev: 1, ddLimit: 0.18 },
    ],
  },
  // Same doctrine, breakers removed — measures what the brake is worth.
  'doctrine, breakers OFF': {
    slots: [
      { instrument: 'SPX', strategy: 'MOMENTUM', param: 20, alloc: 0.25, lev: 1, ddLimit: 9 },
      { instrument: 'BOND', strategy: 'MEAN_REV', param: 30, alloc: 0.25, lev: 1, ddLimit: 9 },
      { instrument: 'GOLD', strategy: 'CARRY', param: 0, alloc: 0.25, lev: 1, ddLimit: 9 },
      { instrument: 'BTC', strategy: 'SENTIMENT', param: 7, alloc: 0.25, lev: 1, ddLimit: 9 },
    ],
  },
  // Diversified but leveraged hard — lev cap check.
  'doctrine @ 3x lev': {
    slots: [
      { instrument: 'SPX', strategy: 'MOMENTUM', param: 20, alloc: 0.25, lev: 3, ddLimit: 0.15 },
      { instrument: 'BOND', strategy: 'MEAN_REV', param: 30, alloc: 0.25, lev: 3, ddLimit: 0.12 },
      { instrument: 'GOLD', strategy: 'CARRY', param: 0, alloc: 0.25, lev: 3, ddLimit: 0.10 },
      { instrument: 'BTC', strategy: 'SENTIMENT', param: 7, alloc: 0.25, lev: 3, ddLimit: 0.18 },
    ],
  },
};

const pct = (a, d = 1) => (a * 100).toFixed(d) + '%';
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log(`ALPHA doctrine testbed — ${SEEDS} seeds x ${DAYS}d mandate per config\n`);
console.log('config'.padEnd(42), 'ruin%', 'medRet', 'medMaxDD', 'medSharpe');
console.log('-'.repeat(78));

const out = {};
for (const [name, cfg] of Object.entries(CONFIGS)) {
  const ruins = [], rets = [], dds = [], sharpes = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = new Sim.Game({ seed, maxDay: DAYS, slots: cfg.slots });
    while (!g.over) g.step();
    const r = g.result;
    ruins.push(r.status === 'LIQUIDATED' ? 1 : 0);
    rets.push(r.totalRet); dds.push(r.maxDD); sharpes.push(r.sharpe);
  }
  out[name] = { ruin: ruins.reduce((a, b) => a + b) / SEEDS, medRet: med(rets), medDD: med(dds), medSharpe: med(sharpes) };
  const r = out[name];
  console.log(name.padEnd(42), pct(r.ruin, 0).padStart(5), pct(r.medRet).padStart(7), pct(r.medDD).padStart(8), r.medSharpe.toFixed(2).padStart(9));
}
console.log('\nread: ruin% = seeds that hit the 50% liquidate line; the doctrine');
console.log('row should dominate on ruin + DD even if raw-return rows out-gain it.');
