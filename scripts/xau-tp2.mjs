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
try {
  const r = await X.limitOrder('XAUUSDT', 'buy', '0.01', '4074.34', { tradeSide: 'close' });
  console.log('limit TP OK:', JSON.stringify(r).slice(0, 200));
} catch (e) { console.log('limit TP ERR:', String(e).slice(0, 300)); }
await new Promise((r) => setTimeout(r, 8000));
const po = await X.pendingOrders('XAUUSDT').catch((e) => ['ERR ' + String(e).slice(0, 100)]);
console.log('pending orders:', JSON.stringify(po).slice(0, 500));
