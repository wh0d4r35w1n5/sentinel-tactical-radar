import '/opt/sentinel/scripts/load-env.mjs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
const X = await makeExchange(process.env);
const [pos, plans] = await Promise.all([X.getPos(), X.getPlans().catch(()=>[])]);
console.log('=== POSITIONS ===');
for (const p of pos) console.log(p.symbol, p.holdSide, 'sz', p.total, 'entry', p.openPriceAvg, 'mark', p.markPrice, 'mm', p.marginMode, 'upl', p.unrealizedPL);
console.log('=== PLANS ===');
for (const q of plans) console.log(q.symbol, q.planType, '@', q.triggerPrice, 'x', q.size);
console.log('counts:', pos.length, 'pos /', plans.length, 'plans');
