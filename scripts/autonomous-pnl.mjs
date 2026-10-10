// autonomous-pnl.mjs — Will Evans's headline question:
// "Of all trades Sentinel has made completely autonomously, without manual
// intervention, what is cumulative realised net profit after every fee —
// separately for exchange and Solana on-chain?"
// Read-only: replays the journal's own FIFO attribution (same rule as the
// exec: src 'api' opens = engine, ios/web = manual; a close inherits the
// majority source of the open quantity it reduces).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const round = (x, n = 4) => Math.round((+x || 0) * 10 ** n) / 10 ** n;

// ---- exchange: replay the fills journal in order, attribute closes ----
const fills = (readJ(path.join(ROOT, 'state', 'real-fills.json'), { fills: [] }).fills || [])
  .slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
const open = {}; // sym+side -> {qty, api, web}
for (const f of fills) {
  const k = f.symbol + ':' + (f.side === 'buy' ? 'L' : 'S'), qty = +f.size || 0;
  if (f.tradeSide === 'open') {
    const c = (open[k] ||= { qty: 0, api: 0, web: 0 });
    c.qty += qty; c[(f.src || 'api') === 'api' ? 'api' : 'web'] += qty;
  } else if (f.tradeSide === 'close') {
    const c = open[k];
    if (c) {
      f._manual = c.web > c.api;
      c.qty -= qty;
      if (c.qty <= (c.web + c.api) * 1e-3) delete open[k];
    }
  }
}
const stats = (rows) => {
  const closes = rows.filter((f) => f.tradeSide === 'close');
  const fees = rows.reduce((a, f) => a + (+f.fee || 0), 0);
  const gross = closes.reduce((a, f) => a + (+f.profit || 0), 0);
  return { fills: rows.length, closes: closes.length, grossUsd: round(gross), feesUsd: round(fees), netUsd: round(gross - fees) };
};
const bot = fills.filter((f) => f.src === 'api' && !f._manual);
const manual = fills.filter((f) => (f.src && f.src !== 'api') || f._manual);
const legacy = fills.filter((f) => !f.src && !f._manual);

// ---- on-chain: every fill is autonomous by construction (bot's own wallet).
// True lane P&L = current purse − all external inflows (bootstrap capital).
const ocFills = (readJ(path.join(ROOT, 'state', 'onchain-fills.json'), { fills: [] }).fills || []);
const lane = readJ(path.join(ROOT, 'api', 'onchain-lane.json'), {});
const book = readJ(path.join(ROOT, 'state', 'onchain-book.json'), {});
const purse = +lane.purseUsd || 0;
const gasSol = +lane.sol || +lane.solGas || +lane.gasSol || 0;
const positions = (lane.positions || book.positions || []);
const posMark = positions.reduce((a, p) => a + (p.lastValueUsd || p.costUsd || 0), 0);
const posCost = positions.reduce((a, p) => a + (p.costUsd || 0), 0);
// bootstrap inflow = USDC the lane was seeded with (the USDGO→SOL→USDC chain).
// every fill since is engine-driven; stables + marks = what came back.
const BOOTSTRAP_USD = 2.09;
const bought = ocFills.filter((f) => f.side === 'buy').reduce((a, f) => a + (+f.usd || 0), 0);
const soldNum = ocFills.filter((f) => f.side === 'sell' && Number.isFinite(+f.usd)).reduce((a, f) => a + +f.usd, 0);
const out = {
  ts: Date.now(), updatedAt: new Date().toISOString(),
  question: 'cumulative realised net profit after every fee — fully autonomous trades only',
  exchange: {
    autonomous: stats(bot),
    manual: stats(manual),
    legacy: stats(legacy),
    scope: 'all fills in state/real-fills.json since go-live; src=api + FIFO-majority rule',
  },
  onchain: {
    fills: ocFills.length,
    buysUsd: round(bought, 4), sellsUsd: round(soldNum, 4),
    bootstrapUsd: BOOTSTRAP_USD,
    purseUsd: round(purse, 4),
    positionsCostUsd: round(posCost, 4), positionsMarkUsd: round(posMark, 4),
    unrealizedUsd: round(posMark - posCost, 4),
    netSinceBootstrapUsd: round(purse - BOOTSTRAP_USD, 4),
    gasSol, gasNote: 'SOL gas tracked separately — never inside the purse or P&L; per-tx fee not journaled (declared blind spot, ~lamports-scale)',
    scope: 'bot wallet is engine-only — every fill is autonomous by construction',
  },
  headline: {
    exchangeAutonomousNetUsd: stats(bot).netUsd,
    onchainNetSinceBootstrapUsd: round(purse - BOOTSTRAP_USD, 4),
    combinedUsd: round(stats(bot).netUsd + (purse - BOOTSTRAP_USD), 4),
    honesty: 'exchange = realised net after every journaled fee; onchain = purse minus seeded capital (realised + unrealised, all flows included)',
  },
};
writeJ(path.join(ROOT, 'api', 'autonomous-pnl.json'), out);
console.log('autonomous-pnl: exchange bot ' + out.exchange.autonomous.netUsd + ' (' + bot.filter(f=>f.tradeSide==='close').length + 'c) | manual ' + out.exchange.manual.netUsd + ' | onchain ' + out.headline.onchainNetSinceBootstrapUsd + ' | combined ' + out.headline.combinedUsd);
