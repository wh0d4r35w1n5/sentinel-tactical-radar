// bitget-protection.test.mjs — pin the planOrder argument contract of the
// protection sidecar against the adapter shapes bitget-exec.mjs consumes.
// Run: node scripts/bitget-protection.test.mjs
import assert from 'node:assert/strict';
import { loadCatalog, normalizePosRow, sidePlans, buildArms } from './bitget-protection.mjs';

let failed = 0;
const t = (name, fn) => {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, '-', e.message); }
};

// --- catalog: exec-catalog.json carries symbols as a plain string array ---
t('loadCatalog keys a string array by symbol', () => {
  const cm = loadCatalog(['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(Object.keys(cm).sort(), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(cm.BTCUSDT.symbol, undefined);
});
t('loadCatalog also accepts {symbol} rows', () => {
  const cm = loadCatalog([{ symbol: 'SOLUSDT', pricePlace: 2 }]);
  assert.equal(cm.SOLUSDT.pricePlace, 2);
});
t('loadCatalog tolerates null/garbage', () => {
  assert.deepEqual(loadCatalog(null), {});
  assert.deepEqual(loadCatalog([null, 42, { nosym: 1 }]), {});
});

// --- raw position rows (Bitget v2 all-position shape) ---
const rawLong = { symbol: 'BTCUSDT', holdSide: 'long', total: '1.5', openPriceAvg: '60000', marginMode: 'isolated', leverage: '10' };
t('normalizePosRow maps the raw Bitget row', () => {
  assert.deepEqual(normalizePosRow(rawLong), { symbol: 'BTCUSDT', side: 'long', size: 1.5, entry: 60000, marginMode: 'isolated' });
});
t('normalizePosRow treats cross/crossed as crossed', () => {
  assert.equal(normalizePosRow({ ...rawLong, marginMode: 'cross' }).marginMode, 'crossed');
  assert.equal(normalizePosRow({ ...rawLong, marginMode: 'Crossed' }).marginMode, 'crossed');
});
t('normalizePosRow defaults missing marginMode to isolated (never a made-up cross)', () => {
  const { marginMode, ...noMode } = rawLong;
  assert.equal(normalizePosRow(noMode).marginMode, 'isolated');
});
t('normalizePosRow skips flat/broken rows', () => {
  assert.equal(normalizePosRow({ ...rawLong, total: '0' }), null);
  assert.equal(normalizePosRow({ ...rawLong, openPriceAvg: '0' }), null);
  assert.equal(normalizePosRow({ ...rawLong, holdSide: '' }), null);
  assert.equal(normalizePosRow(null), null);
});

// --- side filtering: the other direction's plans protect nothing here ---
t('sidePlans only counts same-side plans (unscoped plans count for both)', () => {
  const plans = [
    { planType: 'pos_loss', holdSide: 'short' },
    { planType: 'pos_profit' }, // unscoped -> counts
    { planType: 'profit_plan', holdSide: 'long' },
  ];
  const sp = sidePlans(plans, 'long');
  assert.equal(sp.length, 2);
  assert.ok(!sp.some((p) => p.holdSide === 'short'));
});

// --- the planOrder argument tuples ---
const pos = normalizePosRow(rawLong);
const cm = { BTCUSDT: { pricePlace: 1, sizePlace: 3 } };

t('fresh long gets one pos_loss (size 0) + a 3-rung profit_plan ladder', () => {
  const arms = buildArms({ pos, plans: [], cm });
  assert.equal(arms.length, 4);
  const [stop, ...tps] = arms;
  assert.equal(stop.planType, 'pos_loss');
  assert.equal(stop.size, '0'); // whole-position plan — adapter omits size
  assert.equal(stop.triggerPrice, 59100); // 60000 * (1 - 1.5%) rounded to 1dp
  assert.equal(stop.holdSide, 'long');
  assert.equal(stop.marginMode, 'isolated');
  assert.deepEqual(tps.map((x) => x.planType), ['profit_plan', 'profit_plan', 'profit_plan']);
  // 2R = 3%: legs at 0.55/1.0/1.8 x of 3% -> +1.65% / +3% / +5.4%
  assert.deepEqual(tps.map((x) => x.triggerPrice), [60990, 61800, 63240]);
  // ladder sizes: 40/30/15% of 1.5 on sizePlace 3 — floor() of binary
  // floats (0.7/0.85 aren't exact) mirrors the executor's split math
  assert.deepEqual(tps.map((x) => x.size), ['0.6', '0.449', '0.226']);
  assert.ok(tps.every((x) => x.holdSide === 'long' && x.marginMode === 'isolated'));
});

t('short arms stop ABOVE entry and TPs below', () => {
  const sh = normalizePosRow({ ...rawLong, holdSide: 'short' });
  const arms = buildArms({ pos: sh, plans: [], cm });
  assert.equal(arms[0].planType, 'pos_loss');
  assert.equal(arms[0].triggerPrice, 60900); // +1.5%
  assert.ok(arms.slice(1).every((a) => a.triggerPrice < 60000));
});

t('existing same-side stop+TP -> no re-arm', () => {
  const plans = [
    { planType: 'pos_loss', holdSide: 'long', triggerPrice: '59000' },
    { planType: 'profit_plan', holdSide: 'long', triggerPrice: '61650' },
  ];
  assert.deepEqual(buildArms({ pos, plans, cm }), []);
});

t('only the OPPOSITE side protected -> still arms this side', () => {
  const plans = [{ planType: 'pos_loss', holdSide: 'short', triggerPrice: '60900' },
                 { planType: 'pos_profit', holdSide: 'short', triggerPrice: '61800' }];
  const arms = buildArms({ pos, plans, cm });
  assert.equal(arms.filter((a) => a.planType === 'pos_loss').length, 1);
  assert.equal(arms.filter((a) => /profit/.test(a.planType)).length > 0, true);
});

t('dust position (no leg >= $5) falls back to one whole-position pos_profit at 2R', () => {
  const tiny = normalizePosRow({ ...rawLong, total: '0.001', openPriceAvg: '60000' }); // $60 notional
  const arms = buildArms({ pos: tiny, plans: [], cm });
  assert.equal(arms.length, 2);
  const tp = arms.find((a) => a.planType === 'pos_profit');
  assert.ok(tp, 'expected pos_profit fallback');
  assert.equal(tp.size, '0');
  assert.equal(tp.triggerPrice, 61800); // +3%
});

t('stop-only position gets the ladder added, ladder-only gets the stop', () => {
  const stopOnly = buildArms({ pos, plans: [{ planType: 'pos_loss', holdSide: 'long' }], cm });
  assert.deepEqual(stopOnly.map((a) => a.planType), ['profit_plan', 'profit_plan', 'profit_plan']);
  const tpOnly = buildArms({ pos, plans: [{ planType: 'profit_plan', holdSide: 'long' }], cm });
  assert.deepEqual(tpOnly.map((a) => a.planType), ['pos_loss']);
});

t('marginMode passthrough: crossed position arms crossed plans', () => {
  const crossed = normalizePosRow({ ...rawLong, marginMode: 'crossed' });
  const arms = buildArms({ pos: crossed, plans: [], cm });
  assert.ok(arms.every((a) => a.marginMode === 'crossed'));
});

t('default pricePlace when catalog misses the symbol', () => {
  const arms = buildArms({ pos, plans: [], cm: {} });
  // 60000 * 0.985 = 59100 exactly; default 6dp keeps full precision
  assert.equal(arms[0].triggerPrice, 59100);
});

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
