// verify-demo.mjs — exchange-adapter acceptance run for a NEW driver.
// Read-only by default; --write enables a controlled order lifecycle
// (min-size market order → stop+TP → cancel/close → fills reconcile).
//
//   SENTINEL_EXEC=demo SENTINEL_EXCHANGE=bybit node scripts/exchange/verify-demo.mjs
//   ... --write            # also runs the order lifecycle (demo only)
//
// Exits nonzero on any failed check. Never runs in live mode.
import './../load-env.mjs';
import { makeExchange } from './index.mjs';

const WRITE = process.argv.includes('--write');
const MODE = (process.env.SENTINEL_EXEC || 'off').toLowerCase();
const X = makeExchange(process.env);

if (MODE !== 'demo') {
  console.error(`refusing: SENTINEL_EXEC=${MODE} — this script is demo-only`);
  process.exit(1);
}
console.log(`driver=${X.name} host=${X.host}`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ---------- read-only ----------
const cm = await X.contractMap().catch((e) => (console.log('contractMap:', e.message), null));
ok('contractMap', !!cm && Object.keys(cm).length > 10, cm && `${Object.keys(cm).length} contracts`);
const probe = 'BTCUSDT';
ok('contract meta sane', cm?.[probe]?.sizePlace >= 0 && +cm?.[probe]?.minTradeUSDT > 0, JSON.stringify(cm?.[probe]));

const tk = await X.ticker(probe).catch((e) => (console.log('ticker:', e.message), null));
const t0 = Array.isArray(tk) ? tk[0] : tk;
ok('ticker', +(t0?.lastPr || 0) > 0, `last=${t0?.lastPr}`);

const acct = await X.getAccount().catch((e) => (console.log('account:', e.message), null));
ok('account (auth)', !!acct && acct.equity >= 0, acct && `equity=${acct.equity} avail=${acct.available}`);

const pos = await X.getPos().catch((e) => (console.log('positions:', e.message), null));
ok('positions', Array.isArray(pos), pos && `${pos.length} open`);
for (const p of pos || [])
  ok(`  pos ${p.symbol} ${p.holdSide || p.side}`, +p.total > 0 && +p.openPriceAvg > 0,
    `size=${p.total} entry=${p.openPriceAvg} upl=${p.unrealizedPL} lev=${p.leverage} ${p.marginMode}`);

const pm = await X.getPosMode(probe).catch((e) => (console.log('posMode:', e.message), null));
ok('posMode', pm === 'hedge' || pm === 'oneway', pm);

const plans = await X.getPlans(probe).catch(() => []);
ok('plans listable', Array.isArray(plans), `${plans.length} on ${probe}`);

const fills = await X.getFills().catch((e) => (console.log('fills:', e.message), null));
ok('fills', Array.isArray(fills), fills && `${fills.length} in 48h`);
for (const f of (fills || []).slice(0, 3))
  ok(`  fill ${f.symbol}`, !!f.tradeId && +f.price > 0, `${f.tradeSide} ${f.side} ${f.baseVolume || f.size} @ ${f.price}`);

if (!WRITE || !acct?.equity) {
  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed${WRITE ? '' : ' (read-only; add --write for order lifecycle)'}`);
  process.exit(fail ? 1 : 0);
}

// ---------- write lifecycle (demo funds only) ----------
console.log('\n-- write lifecycle (min-size, fully reversed) --');
// smallest minTradeUSDT contract with sane tick size, prefer majors for book depth
const pick = ['ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BTCUSDT']
  .find((s) => cm[s] && +cm[s].minTradeUSDT <= 10 && cm[s].maxLev >= 10) || probe;
const c = cm[pick];
const px = +((await X.ticker(pick))?.[0]?.lastPr || 0);
const notional = Math.max(+c.minTradeUSDT * 1.2, 5);
const size = Math.max(+c.minTradeNum, Math.floor((notional / px) * 10 ** c.sizePlace) / 10 ** c.sizePlace);
ok('sizing', size > 0, `${pick} ${size} @ ~${px} ($${(size * px).toFixed(2)} notional)`);
if (!size) process.exit(1);

await X.setIsolated(pick);
await X.setLeverage(pick, 5).catch((e) => console.log('  leverage:', e.message));

const before = (await X.getPos()).find((p) => p.symbol === pick);
if (before) { console.log(`  ${pick} already has a position — refusing write test on a live book`); process.exit(1); }

const ord = await X.marketOrder(pick, 'buy', size, 'open').catch((e) => (console.log('  order:', e.message), null));
ok('market open', !!ord);

await new Promise((r) => setTimeout(r, 1500));
const after = (await X.getPos()).find((p) => p.symbol === pick);
ok('position visible', !!after && +after.total >= size * 0.99,
  after && `size=${after.total} entry=${after.openPriceAvg}`);

if (after) {
  const stop = +(after.openPriceAvg * 0.97).toFixed(c.pricePlace);
  const tp = +(after.openPriceAvg * 1.03).toFixed(c.pricePlace);
  await X.planOrder(pick, 'pos_loss', stop, '0', 'long', 'isolated').then(() => ok('pos_loss armed', true, `@${stop}`)).catch((e) => ok('pos_loss armed', false, e.message));
  await X.planOrder(pick, 'pos_profit', tp, '0', 'long', 'isolated').then(() => ok('pos_profit armed', true, `@${tp}`)).catch((e) => ok('pos_profit armed', false, e.message));
  const pl = await X.getPlans(pick);
  ok('plans visible', pl.some((p) => p.planType === 'pos_loss') && pl.some((p) => p.planType === 'pos_profit'),
    pl.map((p) => `${p.planType}@${p.triggerPrice}`).join(' '));

  await X.closePosition(pick, 'long').catch((e) => ok('close', false, e.message));
  await new Promise((r) => setTimeout(r, 1500));
  const gone = !(await X.getPos()).some((p) => p.symbol === pick && +p.total > 0);
  ok('position flat', gone);

  // cancel any orphan protection left behind
  for (const pl2 of await X.getPlans(pick))
    await X.cancelPlanOrders(pick, pl2.planType, [pl2.orderId]).catch(() => {});

  let mine = [];
  for (let i = 0; i < 8 && mine.length < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    mine = (await X.getFills()).filter(
      (f) => f.symbol === pick && Date.now() - +f.cTime < 120e3);
  }
  ok('fills journaled', mine.length >= 2, `${mine.length} fills`);
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
