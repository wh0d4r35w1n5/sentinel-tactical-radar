import fs from 'node:fs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_EXEC = 'live';
const X = makeExchange(process.env);
const pos = await X.getPos();
const p = (pos || []).find((x) => x.symbol === 'NMRUSDT' && +x.total > 0);
if (!p) { console.log('NMR flat'); process.exit(0); }
console.log('NMR:', JSON.stringify(p).slice(0, 500));
const cmap = await X.contractMap();
const c = cmap.NMRUSDT || {};
console.log('contract:', 'minTradeNum', c.minTradeNum, 'minTradeUSDT', c.minTradeUSDT, 'sizePlace', c.sizePlace, 'pricePlace', c.pricePlace, 'maxLev', c.maxLev);
const pl = await X.getPlans('NMRUSDT').catch(() => []);
for (const x of pl || []) console.log('plan:', x.planType, x.triggerPrice, 'sz', x.size);
const t = await X.ticker('NMRUSDT');
const r = Array.isArray(t) ? t[0] : t;
console.log('mark', r.markPrice || r.lastPr);
// what fraction of position is a min clip?
const minClip = Math.max(+c.minTradeNum || 0, (+c.minTradeUSDT || 0) / (+p.openPriceAvg));
console.log('minClip', minClip, 'vs size', p.total, '=', (+p.total > 0 ? (minClip / +p.total * 100).toFixed(1) + '%' : '?'));
