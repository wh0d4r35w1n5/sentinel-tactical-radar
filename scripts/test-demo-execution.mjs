// No credentials or exchange traffic: regressions for money/accounting failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fifoEpisodes, episodeStats, familyStats } from './trade-episodes.mjs';
import { demoSize, executeDemoEntry, reconcileDemoEntries } from './demo-execution.mjs';

const fill = (tradeSide, side, size, price, ts, profit = 0, fee = 1) =>
  ({ symbol: 'TESTUSDT', tradeSide, side, size, price, ts, profit, fee, notionalUsd: size * price, src: 'api' });
test('Bybit normalized long closes include both fees and do not invent shorts', () => {
  const rows = fifoEpisodes([fill('open', 'buy', 10, 10, 1), fill('close', 'buy', 10, 11, 2, 10)], { positionSide: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dir, 'long');
  assert.equal(rows[0].netUsd, 8);
  assert.equal(episodeStats(rows).open, 0);
});
test('shorts and one-way Bitget order-side closes pair independently', () => {
  assert.equal(fifoEpisodes([fill('open', 'sell', 10, 10, 1), fill('close', 'sell', 10, 9, 2, 10)], { positionSide: true })[0].netUsd, 8);
  assert.equal(episodeStats(fifoEpisodes([fill('open', 'buy', 10, 10, 1), fill('close', 'sell', 10, 11, 2, 10)])).open, 0);
});
test('partial exits leave a position open until the final quantity closes', () => {
  const rows = [fill('open', 'buy', 100, 10, 1), fill('close', 'buy', 99.5, 11, 2, 99.5)];
  assert.equal(episodeStats(fifoEpisodes(rows, { positionSide: true })).episodes, 0);
  rows.push(fill('close', 'buy', 0.5, 11, 3, 0.5));
  assert.equal(episodeStats(fifoEpisodes(rows, { positionSide: true })).episodes, 1);
});
test('unmatched closes cannot become profitable strategy observations', () => {
  const rows = fifoEpisodes([fill('close', 'buy', 10, 11, 2, 10)], { positionSide: true });
  assert.equal(episodeStats(rows).episodes, 0);
  assert.equal(episodeStats(rows).unmatchedCloses, 1);
  assert.deepEqual(familyStats(rows), {});
});
test('family returns use notional, never stop-risk dollars', () => {
  assert.equal(familyStats([{ netUsd: 10, fees: 2, notional: 1000, riskUsd: 20, strat: 'cell' }]).cell.meanRetPct, 1);
});
test('repeat positions cannot inherit a prior negative quantity', () => {
  const rows = [fill('close', 'buy', 10, 11, 1, 10), fill('open', 'buy', 10, 10, 2), fill('close', 'buy', 10, 11, 3, 10)];
  const stats = episodeStats(fifoEpisodes(rows, { positionSide: true }));
  assert.equal(stats.episodes, 1);
  assert.equal(stats.unmatchedCloses, 1);
});
const contract = { sizePlace: 0, sizeMultiplier: 1, minTradeNum: 1, minTradeUSDT: 5 };
test('minimum order and lot-step rounding never bypass margin/notional/risk caps', () => {
  const opts = { wanted: 1e8, price: 1, stopPrice: 0.99, leverage: 25, contract };
  const size = demoSize(opts);
  assert.ok(size <= 1500 && size / 25 <= 150 && size * 0.0117 <= 15);
  assert.equal(demoSize({ ...opts, contract: { ...contract, minTradeNum: 2000 } }), 0);
  assert.equal(demoSize({ ...opts, contract: { ...contract, sizeMultiplier: 10 } }) % 10, 0);
});
function fixture(t, behavior = 'partial') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-demo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orders = [], statuses = new Map();
  const X = {
    name: 'bybit', host: 'https://api-demo.bybit.com',
    getPos: async () => [], pendingOrders: async () => [],
    ticker: async () => [{ bidPr: '10', askPr: '10.01' }],
    limitOrder: async (symbol, side, qty, price, extra) => {
      orders.push({ kind: 'Limit', qty, extra });
      if (behavior === 'timeout') throw new Error('network timeout');
      if (behavior === 'agreement') throw new Error('/v5/order/create POST -> 110123 Trading Terms required');
      statuses.set(extra.clientOid, { orderId: extra.clientOid, orderStatus: behavior === 'rejected' ? 'Rejected' : 'New', cumExecQty: '0' });
      return { orderId: extra.clientOid };
    },
    marketOrder: async (symbol, side, qty, intent, extra) => {
      orders.push({ kind: 'Market', qty, extra });
      statuses.set(extra.clientOid, { orderId: extra.clientOid, orderStatus: 'Filled', cumExecQty: String(qty), cumExecValue: String(qty * 10.01) });
      return { orderId: extra.clientOid };
    },
    getOrder: async (symbol, order) => statuses.get(order.clientOid) || null,
    cancelOrder: async (symbol, id) => {
      if (behavior === 'unknown') throw new Error('cancel timeout');
      statuses.set(id, { orderId: id, orderStatus: 'Cancelled', cumExecQty: '6', cumExecValue: '60' });
    },
  };
  const options = { X, symbol: 'TESTUSDT', side: 'buy', wanted: 10, referencePrice: 10,
    stopPrice: 9, targetPct: 5, leverage: 10, contract,
    pendingFile: path.join(dir, 'pending.json'), pause: async () => {} };
  return { X, orders, options, statuses };
}
test('cancellation-race partial fill is subtracted before market fallback', async (t) => {
  const { orders, options } = fixture(t);
  const r = await executeDemoEntry(options);
  assert.equal(r.filled, 10);
  assert.equal(r.makerFilled, 6);
  assert.equal(orders[1].qty, 4);
  for (const o of orders) assert.equal(o.extra.stopLoss, '9');
  assert.deepEqual(JSON.parse(fs.readFileSync(options.pendingFile)), {});
});
test('post-only rejection is not mistaken for a fill', async (t) => {
  const { orders, options } = fixture(t, 'rejected');
  const r = await executeDemoEntry(options);
  assert.equal(r.makerFilled, 0);
  assert.equal(orders[1].qty, 10);
});
test('unconfirmed cancellation blocks fallback and survives process restart', async (t) => {
  const { orders, options } = fixture(t, 'unknown');
  await assert.rejects(executeDemoEntry(options), /unresolved demo order/);
  assert.equal(orders.length, 1);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(options.pendingFile))).length, 1);
  assert.equal((await reconcileDemoEntries(options.X, options.pendingFile, async () => {})).length, 1);
  await assert.rejects(executeDemoEntry(options), /unresolved demo orders/);
});
test('ambiguous POST failure never causes a second entry', async (t) => {
  const { orders, options } = fixture(t, 'timeout');
  await assert.rejects(executeDemoEntry(options), /network timeout/);
  assert.equal(orders.length, 1);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(options.pendingFile))).length, 1);
});
test('contract-agreement rejection leaves no phantom pending order and never retries', async (t) => {
  const { orders, options } = fixture(t, 'agreement');
  await assert.rejects(executeDemoEntry(options), /Trading Terms required/);
  assert.equal(orders.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.pendingFile)), {});
});
test('live host and pre-existing position are refused before submission', async (t) => {
  const { X, orders, options } = fixture(t);
  X.host = 'https://api.bybit.com';
  await assert.rejects(executeDemoEntry(options), /requires Bybit demo/);
  X.host = 'https://api-demo.bybit.com';
  X.getPos = async () => [{ symbol: 'TESTUSDT', total: '1' }];
  await assert.rejects(executeDemoEntry(options), /top-up refused/);
  assert.equal(orders.length, 0);
});
test('completed scanner work does not keep a nine-minute deadline alive', () => {
  const source = fs.readFileSync(new URL('./build-scanner.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const hardRace ='), end = source.indexOf('const tfetch =', start);
  assert.ok(start > 0 && end > start);
  const result = spawnSync(process.execPath, ['-e', source.slice(start, end) + '\nhardRace(Promise.resolve(), 540000);'], { timeout: 2000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});
