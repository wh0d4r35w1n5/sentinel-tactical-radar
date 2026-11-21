import { makeExchange } from './exchange/index.mjs';
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.SENTINEL_EXEC = 'live'; process.env.SENTINEL_EXCHANGE = 'bitget'; process.env.SENTINEL_LIVE = '1';
const X = makeExchange(process.env); X.setPosMode('hedge');
for (const sym of ['MSTUUSDT', 'BERAUSDT']) {
  console.log(sym, JSON.stringify(await X.closePosition(sym, 'short').catch(e => String(e).slice(0, 80))).slice(0, 160));
  const plans = await X.getPlans(sym).catch(() => []);
  for (const pl of plans || []) {
    const oid = pl.orderId || pl.planOrderId;
    if (oid) await X.api('POST', '/api/v2/mix/order/cancel-plan-order',
      { body: { symbol: sym, productType: 'USDT-FUTURES', marginCoin: 'USDT', planType: pl.planType, orderIdList: [String(oid)] } }).catch(() => {});
  }
}
