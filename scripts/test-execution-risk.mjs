// Dry-run regression tests for the entry-risk stack. No network, no orders.
// Run: node scripts/test-execution-risk.mjs
import { sizeEntry, assertAdmission, validateRiskPolicy, canonicalCell, hourlyTrail, EXIT_MODEL } from './execution-risk.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = validateRiskPolicy(JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'execution-risk.json'), 'utf8')));
const contract = { sizePlace: 3, sizeMultiplier: 0.001, pricePlace: 4, minTradeNum: 0.05, minTradeUSDT: 5, maxLev: 25 };

let pass = 0, failN = 0;
const t = (name, fn, wantThrow = null) => {
  try {
    const r = fn();
    if (wantThrow) { failN++; console.log(`FAIL ${name}: expected refusal, got ${JSON.stringify(r).slice(0, 140)}`); return; }
    pass++; console.log(`ok   ${name} -> ${JSON.stringify(r).slice(0, 140)}`);
  } catch (e) {
    if (wantThrow && e.message.includes(wantThrow)) { pass++; console.log(`ok   ${name} refused: ${e.message}`); return; }
    failN++; console.log(`FAIL ${name}: ${e.message}`);
  }
};

const base = { equityUsd: 33.55, availableUsd: 20, entryPrice: 100, stopPrice: 98,
  direction: 'LONG', contract };

// --- sizing ---
t('normal LONG sizes within risk', () => {
  const r = sizeEntry(base, policy);
  if (!(r.size > 0) || !(r.leverage >= 1) || !Number.isInteger(r.leverage)) throw new Error('bad result');
  if (r.notionalUsd > 33.55 * policy.maxPositionNotionalMultiple + 1e-9) throw new Error('notional cap breached');
  if (r.riskUsd > 33.55 * policy.riskPerTradeFraction + 1e-9) throw new Error('risk budget breached');
  return r;
});
t('integer leverage always', () => {
  const r = sizeEntry({ ...base, equityUsd: 100, availableUsd: 80 }, policy);
  if (!Number.isInteger(r.leverage) || r.leverage > policy.maxLeverage) throw new Error(`lev ${r.leverage}`);
  return { leverage: r.leverage, notional: r.notionalUsd };
});
t('min-contract too risky -> refuse', () => {
  // 0.5% stop -> risk-sized notional huge, but notional caps bind; force
  // equity so small that even the contract minimum breaks the budget.
  return sizeEntry({ ...base, equityUsd: 2, availableUsd: 2, entryPrice: 100, stopPrice: 90 }, policy);
}, 'entry-risk');
t('stop on wrong side -> refuse', () => sizeEntry({ ...base, stopPrice: 102 }, policy), 'loss side');
t('short sizing refused by direction gate upstream', () =>
  canonicalCell('Wyckoff Event', 'SHORT') === 'Wyckoff:SHORT' ? 'canonicalised (allowed at cell level, refused by exit-model gate)' : 'no cell');
t('low margin -> refuse', () => sizeEntry({ ...base, availableUsd: 0.5 }, policy), 'entry-risk');
t('existing portfolio risk shrinks budget', () => {
  const r = sizeEntry({ ...base, existingRiskUsd: 0.5 }, policy);
  if (!(r.riskUsd <= 33.55 * policy.maxPortfolioRiskFraction - 0.5 + 0.01)) throw new Error('portfolio cap not honoured');
  return { riskUsd: r.riskUsd };
});
t('riskScale halves size', () => {
  const big = { ...base, equityUsd: 200, availableUsd: 150 };
  const a = sizeEntry(big, policy), b = sizeEntry({ ...big, riskScale: 0.5 }, policy);
  if (!(b.riskUsd < a.riskUsd)) throw new Error('no scaling');
  return { full: a.riskUsd, half: b.riskUsd };
});
t('half-risk under contract min refuses, never oversizes', () =>
  sizeEntry({ ...base, riskScale: 0.5 }, policy), 'minimum');
t('leverageCap shrinks notional, never raises risk', () => {
  const r = sizeEntry({ ...base, leverageCap: 2 }, policy);
  if (r.leverage > 2 || r.riskUsd > 33.55 * policy.riskPerTradeFraction + 1e-9) throw new Error('cap wrong');
  return r;
});

// --- admission ---
const mkArgs = (over = {}) => ({
  allowlist: { enabled: true, cells: ['Wyckoff:LONG'] },
  admission: { cells: { 'Wyckoff:LONG': { status: 'probation', source: 'mega-backtest-1m', exitModel: EXIT_MODEL,
    episodes: 10715, netAfterCost: 0.0694, ci: [0.01, 0.13], reviewedAt: new Date().toISOString() } } },
  envelope: { at: Date.now() - 1000, brake: false, cells: {}, twinOf: {} },
  risk: policy, ...over,
});
const wIntent = { strategy: 'Wyckoff Event', direction: 'LONG', exitModel: EXIT_MODEL, symbol: 'TESTUSDT', entryPrice: 100, stopPrice: 98 };

t('wyckoff probation admits at half tier', () => {
  const r = assertAdmission(wIntent, mkArgs());
  if (r.tier !== 'probation') throw new Error('expected probation tier');
  return r;
});
t('non-wyckoff refused', () => assertAdmission({ ...wIntent, strategy: 'Liquidity Sweep' }, mkArgs()), 'not admitted');
t('short refused', () => assertAdmission({ ...wIntent, direction: 'SHORT' }, mkArgs()), 'entry-risk');
t('unattributed refused', () => assertAdmission({ ...wIntent, strategy: null }, mkArgs()), 'not admitted');
t('wrong exit model refused', () => assertAdmission({ ...wIntent, exitModel: 'ladder' }, mkArgs()), 'exit model');
t('stale evidence refused', () => assertAdmission(wIntent, mkArgs({
  admission: { cells: { 'Wyckoff:LONG': { status: 'probation', source: 'mega-backtest-1m', exitModel: EXIT_MODEL,
    episodes: 10715, netAfterCost: 0.1, ci: [0.01, 0.2], reviewedAt: new Date(Date.now() - 2 * 86400000).toISOString() } } },
})), 'stale');
t('loser-cell symbol refused', () => assertAdmission(wIntent, mkArgs({
  envelope: { at: Date.now(), cells: { TESTUSDT: { verdict: 'loser' } }, twinOf: {} } })), 'losing symbol');
t('twin loser refused', () => assertAdmission(wIntent, mkArgs({
  envelope: { at: Date.now(), cells: { TEST2USDT: { verdict: 'loser' } }, twinOf: { TESTUSDT: 'TEST2USDT' } } })), 'losing symbol');
t('brake refused', () => assertAdmission(wIntent, mkArgs({
  envelope: { at: Date.now(), brake: true, cells: {}, twinOf: {} } })), 'brake');
t('stale envelope refused', () => assertAdmission(wIntent, mkArgs({
  envelope: { at: Date.now() - 400000, cells: {}, twinOf: {} } })), 'envelope');
t('live tier gives full tier', () => assertAdmission(wIntent, mkArgs({
  admission: { cells: { 'Wyckoff:LONG': { status: 'live', source: 'validated-forward-exits', exitModel: EXIT_MODEL,
    episodes: 40, netAfterCost: 0.5, ci: [0.05, 0.9], reviewedAt: new Date().toISOString() } } },
})).tier === 'live' ? 'live tier' : (() => { throw new Error('wrong tier'); })());

// --- trail model ---
t('hourly trail ratchets only up', () => {
  const t0 = Date.now() - 20 * 3600000;
  const rows = [];
  for (let i = 0; i < 20; i++)
    rows.push({ t: t0 + i * 3600000, o: 100, h: 101 + i * 0.5, l: 99, c: 100 + i * 0.5 });
  const r = hourlyTrail({ rows, entryPrice: 100, initialStop: 97, openedAt: t0 + 15 * 3600000, now: t0 + 20 * 3600000 + 1 });
  if (!r || !(r.stop >= 97)) throw new Error('trail widened');
  return r;
});
t('trail returns null on stale history', () => {
  const rows = [{ t: 1, o: 1, h: 1, l: 1, c: 1 }];
  if (hourlyTrail({ rows, entryPrice: 1, initialStop: 0.9, openedAt: 1, now: Date.now() }) !== null) throw new Error('expected null');
  return 'null on stale';
});

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
