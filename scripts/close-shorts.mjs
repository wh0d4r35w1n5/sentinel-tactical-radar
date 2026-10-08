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
const SYMS = process.argv.slice(2).length ? process.argv.slice(2) : ['ETHUSDT', 'SUIUSDT', 'ADAUSDT'];
const pos = await X.getPos();
for (const sym of SYMS) {
  const p = (pos || []).find((x) => x.symbol === sym && +x.total > 0);
  if (!p) { console.log(sym, 'no open position — skip'); continue; }
  const side = p.holdSide || 'short';
  const upl = +p.unrealizedPL || 0;
  try {
    const plans = await X.getPlans(sym).catch(() => []);
    for (const x of plans || []) {
      const id = x.orderId || x.planId || x.id;
      if (id) await X.cancelPlanOrders(sym, x.planType, [String(id)]).catch(() => {});
    }
    await X.closePosition(sym, side);
    console.log(sym, 'closed', side, 'sz', p.total, 'upl', upl.toFixed(3));
  } catch (e) {
    console.log(sym, 'CLOSE FAILED:', String(e).slice(0, 200));
  }
}
