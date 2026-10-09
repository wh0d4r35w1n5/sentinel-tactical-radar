// regression harness — run: node test-pimpcity.mjs
import * as pc from './scripts/pimpcity.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', name); } };

const mkWar = () => {
  const war = { pimps: {}, cracks: {}, retired: {}, intents: [], drama: [], gen: 0 };
  war.pimps['Silky Slim'] = { roster: ['Diamond Dust'], crown: false, crippled: false, net: 0, wins: 0, losses: 0 };
  war.cracks['Diamond Dust'] = { w: { score: 1 }, tag: 't', pimp: 'Silky Slim', net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: 0 };
  return war;
};

// --- 1. round-trip fee truth: close must charge entry fee too
{
  const war = mkWar();
  war.intents.push({ symbol: 'SOLUSDT', direction: 'LONG', ts: 1000, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  const fills = [
    { tradeId: 'o1', tradeSide: 'open', symbol: 'SOLUSDT', ts: 1100, fee: 0.05, profit: 0 },
    { tradeId: 'c1', tradeSide: 'close', symbol: 'SOLUSDT', ts: 2000, fee: 0.05, profit: 0.40 },
  ];
  pc.attribute(war, fills);
  ok(Math.abs(war.cracks['Diamond Dust'].net - 0.30) < 1e-9, `round-trip fee: expected 0.30 got ${war.cracks['Diamond Dust'].net}`);
  ok(war.cracks['Diamond Dust'].wins === 1, 'round-trip win counted');
}

// --- 2. multi-clip close: entry fee charged ONCE, both clips score
{
  const war = mkWar();
  war.intents.push({ symbol: 'ETHUSDT', direction: 'LONG', ts: 1000, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  const fills = [
    { tradeId: 'o1', tradeSide: 'open', symbol: 'ETHUSDT', ts: 1100, fee: 0.06, profit: 0 },
    { tradeId: 'c1', tradeSide: 'close', symbol: 'ETHUSDT', ts: 2000, fee: 0.03, profit: 0.20 },
    { tradeId: 'c2', tradeSide: 'close', symbol: 'ETHUSDT', ts: 2100, fee: 0.03, profit: 0.15 },
  ];
  pc.attribute(war, fills);
  const expected = 0.20 - 0.03 + 0.15 - 0.03 - 0.06; // 0.23
  ok(Math.abs(war.cracks['Diamond Dust'].net - expected) < 1e-9, `multi-clip: expected ${expected} got ${war.cracks['Diamond Dust'].net}`);
  ok(war.cracks['Diamond Dust'].closes === 2, 'multi-clip: 2 closes counted');
}

// --- 3. retired girl's late close still lands on her archived record
{
  const war = mkWar();
  war.intents.push({ symbol: 'BTCUSDT', direction: 'LONG', ts: 1000, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  // retire her: move record to retired, remove from active
  war.retired['Diamond Dust'] = { ...war.cracks['Diamond Dust'], retiredAt: Date.now() };
  delete war.cracks['Diamond Dust'];
  war.pimps['Silky Slim'].roster = [];
  const fills = [{ tradeId: 'c9', tradeSide: 'close', symbol: 'BTCUSDT', ts: 2000, fee: 0.02, profit: 0.10 }];
  pc.attribute(war, fills);
  ok(Math.abs(war.retired['Diamond Dust'].net - 0.08) < 1e-9, `retired attr: expected 0.08 got ${war.retired['Diamond Dust'].net}`);
  ok(Math.abs(war.pimps['Silky Slim'].net - 0.08) < 1e-9, 'retired attr: pimp still credited');
}

// --- 4. no intent → no attribution (fill recorded as seen, no phantom credit)
{
  const war = mkWar();
  const fills = [{ tradeId: 'cx', tradeSide: 'close', symbol: 'DOGEUSDT', ts: 2000, fee: 0.01, profit: 0.5 }];
  pc.attribute(war, fills);
  ok(war.cracks['Diamond Dust'].net === 0, 'no-intent: no credit');
}

// --- 5. duplicate close doesn't double-count
{
  const war = mkWar();
  war.intents.push({ symbol: 'SOLUSDT', direction: 'LONG', ts: 1000, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  const f = { tradeId: 'c1', tradeSide: 'close', symbol: 'SOLUSDT', ts: 2000, fee: 0.05, profit: 0.40 };
  pc.attribute(war, [f]);
  pc.attribute(war, [f]);
  ok(war.cracks['Diamond Dust'].closes === 1, 'dedup: close counted once');
}

// --- 6. NaN playbook protection through steal + mutant paths
{
  const war = mkWar();
  war.cracks['Loser Lola'] = { w: { score: 1, strat: 'Momentum' }, tag: 't', pimp: 'Silky Slim', net: -1, wins: 0, losses: 5, closes: 5, stolen: 0, gen: 0 };
  war.cracks['Bad Beth'] = { w: { score: 1 }, tag: 't', pimp: 'Silky Slim', net: -0.8, wins: 0, losses: 4, closes: 4, stolen: 0, gen: 0 };
  war.cracks['Diamond Dust'].net = 2; war.cracks['Diamond Dust'].wins = 5; war.cracks['Diamond Dust'].closes = 5;
  war.cracks['Diamond Dust'].w.strat = 'Momentum|Ignition';
  war.pimps['Madam Razor'] = { roster: ['Bad Beth'], crown: false, crippled: false, net: -1, wins: 0, losses: 1 };
  war.pimps['Cold Cash Cole'] = { roster: ['Loser Lola'], crown: false, crippled: false, net: 0, wins: 0, losses: 0 };
  war.cracks['Bad Beth'].pimp = 'Madam Razor'; war.cracks['Loser Lola'].pimp = 'Cold Cash Cole';
  pc.fight(war);
  for (const [n, c] of Object.entries(war.cracks)) {
    for (const [k, v] of Object.entries(c.w)) ok(!Number.isNaN(+v) || typeof v !== 'number', `no NaN in ${n}.w.${k}`);
    if (typeof c.w.strat === 'string') ok(!Number.isNaN(+c.w.score), `${n} numeric w intact`);
  }
}

// --- 7. free agents nominate and get credited without a pimp
{
  const war = mkWar();
  war.cracks['Fastlane Faye'] = { w: { score: 1.2, chg: 5, mom: 2, stratW: 8, strat: 'Momentum' }, tag: 't', pimp: null, net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: 0 };
  const cand = [{ symbol: 'PUMPUSDT', score: 8, changePct: 9, mktType: 'side-normal', strategy: 'Momentum' }];
  const noms = pc.nominate(war, cand, 1);
  const fa = noms.find((n) => n.crack === 'Fastlane Faye');
  ok(!!fa, 'free agent nominates');
  ok(fa && fa.pimp === null, 'free agent nom has no pimp');
  // attribution credits her, no pimp row touched
  war.intents.push({ symbol: 'PUMPUSDT', direction: 'LONG', ts: 1000, pimp: null, crack: 'Fastlane Faye' });
  pc.attribute(war, [{ tradeId: 'o1', tradeSide: 'open', symbol: 'PUMPUSDT', ts: 1100, fee: 0.02, profit: 0 }, { tradeId: 'c1', tradeSide: 'close', symbol: 'PUMPUSDT', ts: 2000, fee: 0.02, profit: 0.30 }]);
  ok(Math.abs(war.cracks['Fastlane Faye'].net - 0.26) < 1e-9, `freelance attr: expected 0.26 got ${war.cracks['Fastlane Faye'].net}`);
  ok(war.pimps['Silky Slim'].net === 0, 'freelance attr: no pimp cut');
}

// --- 8. loadWar injects new stable girls into saved wars as free agents
{
  const war = pc.loadWar();
  for (const n of ['Fastlane Faye', 'Bolt Betsy', 'Sprint Santana'])
    ok(!!war.cracks[n], `loadWar merged ${n}`);
}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
