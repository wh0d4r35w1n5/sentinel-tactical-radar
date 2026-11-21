import fs from 'node:fs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_EXEC = 'live';
const X = makeExchange(process.env);
const pm = await X.getPosMode('BTCUSDT').catch(() => null);
if (pm) X.setPosMode?.(pm);
const pos = await X.getPos();
const p = (pos || []).find((x) => x.symbol === 'XAUUSDT' && +x.total > 0);
if (!p) { console.log('XAU flat — abort'); process.exit(0); }
const side = p.holdSide;
const mm = p.marginMode === 'crossed' ? 'crossed' : 'isolated';
console.log('before:', side, p.total, '@', p.openPriceAvg);
// top up +0.01 so a 0.01 TP leg sits under position size (full-size legs get
// silently invalidated alongside the whole-cover pos_loss)
if (+p.total < 0.02) {
  await X.marketOrder('XAUUSDT', 'sell', '0.01', 'open');
  console.log('topped up +0.01 short');
  await new Promise((r) => setTimeout(r, 3000));
}
const np = (await X.getPos()).find((x) => x.symbol === 'XAUUSDT' && +x.total > 0);
const entry = +np.openPriceAvg;
const tp1 = +(entry * (1 - 0.015)).toFixed(2);
const tp2 = +(entry * (1 - 0.035)).toFixed(2);
await X.planOrder('XAUUSDT', 'profit_plan', String(tp1), '0.01', side, mm);
console.log('TP leg 0.01 @', tp1);
// keep the stop tight at +1.5% of the NEW blended entry
const sl = +(entry * 1.015).toFixed(2);
await X.planOrder('XAUUSDT', 'pos_loss', String(sl), '0', side, mm);
console.log('SL re-pinned @', sl, '(new blended entry', entry + ')');
// retire stale plans
const rows = await X.getPlans('XAUUSDT').catch(() => []);
for (const x of rows || []) {
  const id = x.orderId || x.planId || x.id;
  const tp = +x.triggerPrice;
  if (!id) continue;
  if (/loss/i.test(x.planType || '') && tp !== sl) await X.cancelPlanOrders('XAUUSDT', x.planType, [String(id)]).catch(() => {});
  if (/profit/i.test(x.planType || '') && tp !== tp1 && tp !== tp2) await X.cancelPlanOrders('XAUUSDT', x.planType, [String(id)]).catch(() => {});
}
await new Promise((r) => setTimeout(r, 15000));
const pl = await X.getPlans('XAUUSDT').catch(() => []);
console.log('final plans:', (pl || []).map((x) => `${x.planType}@${x.triggerPrice} sz${x.size}`).join(' | ') || 'NONE');
