import fs from 'node:fs';
import { makeExchange } from './exchange/index.mjs';
for (const p of ['.env', '/opt/sentinel/.env']) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
    break;
  } catch {}
}
const X = makeExchange(process.env);
const pos = await X.getPos();
for (const sym of ['ETHUSDT', 'SUIUSDT', 'ADAUSDT', 'XAUUSDT']) {
  const p = (pos || []).find((x) => x.symbol === sym && +x.total > 0);
  const plans = await X.getPlans(sym).catch(() => []);
  console.log(sym, 'entry', p?.openPriceAvg, 'liq', p?.liquidationPrice);
  for (const x of plans || []) console.log('  ', x.planType, x.triggerPrice, 'sz', x.size, x.holdSide || '');
}
