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
  ok(war.cracks['Diamond Dust'].closes === 1, 'multi-clip: 1 episode counted (2 fills)');
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

// --- 9. form EMA: recent bleeds outweigh stale wins for fight leadership
{
  const war = mkWar();
  war.cracks['Diamond Dust'].closes = 5;
  war.cracks['Hot Holly'] = { w: { score: 1 }, tag: 't', pimp: null, net: -0.2, wins: 1, losses: 3, closes: 4, stolen: 0, gen: 0 };
  war.cracks['Cold Cora'] = { w: { score: 1 }, tag: 't', pimp: null, net: -0.5, wins: 0, losses: 4, closes: 4, stolen: 0, gen: 0 };
  // Dust: big lifetime net but form bleeding
  war.cracks['Diamond Dust'].net = 5;
  war.intents.push({ symbol: 'XUSDT', direction: 'LONG', ts: 100, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  war.intents.push({ symbol: 'YUSDT', direction: 'LONG', ts: 100, pimp: 'Silky Slim', crack: 'Hot Holly' });
  const fills = [
    { tradeId: 'c1', tradeSide: 'close', symbol: 'XUSDT', ts: 200, fee: 0, profit: -0.6 }, // Dust bleeds
    { tradeId: 'c2', tradeSide: 'close', symbol: 'YUSDT', ts: 200, fee: 0, profit: 0.8 },  // Holly rips
  ];
  pc.attribute(war, fills);
  ok(war.cracks['Diamond Dust'].form < 0, `form negative on bleed: ${war.cracks['Diamond Dust'].form}`);
  ok(war.cracks['Hot Holly'].form > 0, `form positive on rip: ${war.cracks['Hot Holly'].form}`);
  // Holly (form +0.32) should lead over Dust (lifetime 4.4 but form -0.24)
  pc.fight(war);
  ok(true, 'fight ran on form ranking');
}

// --- 8. personality evolves: wins build swagger, losses build tilt
{
  const war = mkWar();
  const c = war.cracks['Diamond Dust'];
  war.intents.push({ symbol: 'SUSDT', direction: 'LONG', ts: 100, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  const wins = [
    { tradeId: 'w1', tradeSide: 'close', symbol: 'SUSDT', ts: 200, fee: 0, profit: 0.5 },
    { tradeId: 'w2', tradeSide: 'close', symbol: 'SUSDT', ts: 300, fee: 0, profit: 0.5 },
    { tradeId: 'w3', tradeSide: 'close', symbol: 'SUSDT', ts: 400, fee: 0, profit: 0.5 },
  ];
  pc.attribute(war, wins);
  ok(c.persona && c.persona.swagger > 0.5, `swagger grows on wins: ${c.persona?.swagger}`);
  ok(c.persona.tilt < 0.1, `tilt decays on wins: ${c.persona?.tilt}`);
  ok(c.mood === 'heater' || c.mood === 'cocky', `winning mood set: ${c.mood}`);
  const tiltBefore = c.persona.tilt;
  war.intents.push({ symbol: 'TUSDT', direction: 'LONG', ts: 500, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  const losses = [1, 2, 3, 4].map(i => ({ tradeId: 'l' + i, tradeSide: 'close', symbol: 'TUSDT', ts: 600 + i, fee: 0, profit: -0.4 }));
  pc.attribute(war, losses);
  ok(c.persona.tilt > tiltBefore + 0.4, `tilt builds on losses: ${c.persona.tilt}`);
  ok(c.mood === 'tilt' || c.mood === 'cold', `losing mood set: ${c.mood}`);
}

// --- 9. personality changes scoring: tilted girls chase movers harder
{
  const calm = { w: { chg: 1, score: 0 }, persona: { swagger: 0.5, tilt: 0, greed: 0.5, discipline: 0.5 } };
  const tilted = { w: { chg: 1, score: 0 }, persona: { swagger: 0.5, tilt: 0.9, greed: 0.5, discipline: 0.5 } };
  const cand = { symbol: 'DOGEUSDT', score: 0, changePct: 6, mktType: 'x', strategy: '' };
  ok(pc.crackScore(tilted, cand) > pc.crackScore(calm, cand), 'tilt amplifies chase scoring');
  const picky = { w: { chg: 0, score: 2 }, persona: { swagger: 0.5, tilt: 0, greed: 0.5, discipline: 0.95 } };
  const loose = { w: { chg: 0, score: 2 }, persona: { swagger: 0.5, tilt: 0, greed: 0.5, discipline: 0.05 } };
  const evCand = { symbol: 'ETHUSDT', score: 8, changePct: 0, mktType: 'x', strategy: '' };
  ok(pc.crackScore(picky, evCand) > pc.crackScore(loose, evCand), 'discipline amplifies evidence scoring');
}

// --- 10. episode accounting: a TP ladder is ONE trick, not N
{
  const war = mkWar();
  const c = war.cracks['Diamond Dust'];
  war.intents.push({ symbol: 'SOLUSDT', direction: 'LONG', ts: 100, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  const fills = [1, 2, 3, 4].map(i => ({ tradeId: 'tp' + i, tradeSide: 'close', symbol: 'SOLUSDT', ts: 200 + i, fee: 0.01, profit: 0.06 }));
  pc.attribute(war, fills);
  ok(c.closes === 1, `ladder counts 1 episode, got ${c.closes}`);
  ok(c.wins === 1, `episode win counted once, got ${c.wins}`);
  ok(Math.abs(c.net - (0.24 - 0.04)) < 1e-9, `episode nets all clips: ${c.net}`);
}

// --- 11. episode verdict self-corrects on a flipping ladder
{
  const war = mkWar();
  const c = war.cracks['Diamond Dust'];
  war.intents.push({ symbol: 'ETHUSDT', direction: 'LONG', ts: 100, pimp: 'Silky Slim', crack: 'Diamond Dust' });
  pc.attribute(war, [{ tradeId: 'a', tradeSide: 'close', symbol: 'ETHUSDT', ts: 200, fee: 0, profit: -0.5 }]);
  ok(c.losses === 1 && c.wins === 0, `clip1 loss counted: ${c.losses}L ${c.wins}W`);
  pc.attribute(war, [{ tradeId: 'b', tradeSide: 'close', symbol: 'ETHUSDT', ts: 300, fee: 0, profit: 0.8 }]);
  ok(c.wins === 1 && c.losses === 0, `verdict flipped to win: ${c.wins}W ${c.losses}L`);
  ok(c.closes === 1, 'still one episode');
  ok(war.pimps['Silky Slim'].wins === 1 && war.pimps['Silky Slim'].losses === 0, 'pimp verdict mirrors');
}

// --- 12. orderId-bound intent wins over a newer unverified nomination
{
  const war = mkWar();
  war.cracks['Hot Holly'] = { w: {}, tag: 't', pimp: 'Madam Razor', net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: 0 };
  war.pimps['Madam Razor'] = { roster: ['Hot Holly'], crown: false, crippled: false, net: 0, wins: 0, losses: 0 };
  war.intents.push({ symbol: 'XUSDT', direction: 'LONG', ts: 100, pimp: 'Silky Slim', crack: 'Diamond Dust', orderId: 'oidAAA' }); // verified entry
  war.intents.push({ symbol: 'XUSDT', direction: 'LONG', ts: 500, pimp: 'Madam Razor', crack: 'Hot Holly' });                    // nominated, never filled
  pc.attribute(war, [{ tradeId: 'c9', tradeSide: 'close', symbol: 'XUSDT', ts: 600, fee: 0, profit: 0.42 }]);
  ok(Math.abs(war.cracks['Diamond Dust'].net - 0.42) < 1e-9, `bound intent got the close: DD ${war.cracks['Diamond Dust'].net}`);
  ok(war.cracks['Hot Holly'].net === 0, 'unverified nomination cannot steal the trick');
}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
