import { makeExchange } from './exchange/index.mjs';
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.SENTINEL_EXEC = 'live'; process.env.SENTINEL_EXCHANGE = 'bitget'; process.env.SENTINEL_LIVE = '1';
const X = makeExchange(process.env); X.setPosMode('hedge');
for (const sym of ['QNTUSDT', 'ARIAUSDT', 'ASTERUSDT']) {
  const tk = await X.ticker(sym);
  const mark = +((Array.isArray(tk) ? tk[0] : tk)?.lastPr || 0);
  const plans = await X.getPlans(sym).catch(() => []);
  const out = { sym, mark, plans: (plans || []).map(p => ({ t: p.planType, px: p.triggerPrice, id: p.orderId || p.planOrderId })) };
  // tighten loss leg to ~1% above mark for shorts
  const loss = (plans || []).find(p => p.planType === 'loss_plan');
  const tighter = +(mark * 1.012).toPrecision(6);
  if (loss && +loss.triggerPrice > tighter) {
    const oid = loss.orderId || loss.planOrderId;
    out.cancel = await X.api('POST', '/api/v2/mix/order/cancel-plan-order',
      { body: { symbol: sym, productType: 'USDT-FUTURES', marginCoin: 'USDT', planType: 'loss_plan', orderIdList: [String(oid)] } }).then(() => 'ok').catch(e => String(e).slice(0, 90));
    const pos = (await X.getPos()).find(p => p.symbol === sym && +p.total > 0);
    if (pos) out.newStop = JSON.stringify(await X.planOrder(sym, 'loss_plan', tighter, +pos.total, 'short')).slice(0, 140);
  }
  console.log(JSON.stringify(out));
}
