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
const pos = await X.getPos();
const p = (pos || []).find((x) => x.symbol === 'XAUUSDT' && +x.total > 0);
console.log('pos:', p ? `${p.holdSide} ${p.total} @ ${p.openPriceAvg} marginMode=${p.marginMode}` : 'none');
try {
  const r = await X.planOrder('XAUUSDT', 'pos_profit', '4074.34', '0', p.holdSide, p.marginMode);
  console.log('place pos_profit OK:', JSON.stringify(r).slice(0, 200));
} catch (e) { console.log('place ERR:', String(e).slice(0, 300)); }
for (const w of [10, 30]) {
  await new Promise((r) => setTimeout(r, w * 1000));
  const pl = await X.getPlans('XAUUSDT').catch(() => []);
  console.log(`after +${w}s:`, (pl || []).map((x) => `${x.planType}@${x.triggerPrice}`).join(' | ') || 'NONE');
}
