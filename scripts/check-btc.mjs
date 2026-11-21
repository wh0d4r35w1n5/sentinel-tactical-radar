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
console.log('all positions raw:');
for (const p of pos || []) console.log(p.symbol, p.holdSide, 'total', p.total, 'upl', p.unrealizedPL);
const btc = (pos || []).find((x) => x.symbol === 'BTCUSDT');
console.log('BTC row:', btc ? JSON.stringify(btc).slice(0, 400) : 'NONE — closed');
// recent BTC fills
const fills = await X.getFills().catch(() => []);
for (const f of (fills || []).filter((x) => x.symbol === 'BTCUSDT').slice(-5))
  console.log('BTC fill:', f.side, f.size, '@', f.price, 'profit', f.profit, f.tradeSide, new Date(+f.ts).toISOString());
// XAU plans
const xpl = await X.getPlans('XAUUSDT').catch(() => []);
for (const x of xpl || []) console.log('XAU plan:', x.planType, x.triggerPrice, 'sz', x.size);
