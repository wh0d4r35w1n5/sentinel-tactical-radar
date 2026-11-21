import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';
const X = makeExchange({ SENTINEL_EXCHANGE:'bitget', SENTINEL_EXEC:'live', ...process.env });
const pos = await X.getPos();
for (const p of pos.filter(x=>+x.total>0)) {
  const plans = await X.getPlans(p.symbol);
  const sl = plans.filter(r=>/loss|moving/i.test(r.planType||''));
  const tp = plans.filter(r=>/profit/i.test(r.planType||''));
  const entry=+p.openPriceAvg, mark=+p.markPrice;
  console.log(p.symbol,p.holdSide,'entry',entry,'mark',mark,'upl',(+p.unrealizedPL).toFixed(2));
  for (const r of sl) console.log('   STOP',r.planType,r.triggerPrice, p.holdSide==='short' ? (+r.triggerPrice<entry?'ABOVE-ENTRY-LOCKED':'below entry') : (+r.triggerPrice>entry?'ABOVE-ENTRY-LOCKED':'below entry'));
  for (const r of tp.slice(0,4)) console.log('   TP',r.planType,r.triggerPrice,'size',r.size);
}
