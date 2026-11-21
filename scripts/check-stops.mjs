import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';
const X = makeExchange(process.env);
const pos = await X.getPos();
for (const p of pos || []) {
  if (!(+p.total > 0)) continue;
  const plans = await X.getPlans(p.symbol).catch(() => []);
  console.log(p.symbol, p.holdSide || p.side, 'entry', p.openPriceAvg, 'mark', p.markPrice);
  for (const s of plans || []) {
    const t = String(s.planType || '');
    if (/loss|profit/i.test(t)) console.log('  ', t, s.triggerPrice, s.size);
  }
}
process.exit(0);
