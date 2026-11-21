// market-deploy.mjs — operator market seat with preset SL (armor adds TPs).
// Usage: node market-deploy.mjs SYMBOL SIZE LEVERAGE STOPPX
import fs from 'node:fs';
import crypto from 'node:crypto';

for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const HOST = 'https://api.bitget.com';
const KEY = process.env.BITGET_API_KEY || process.env.BITGET_KEY;
const SEC = process.env.BITGET_API_SECRET || process.env.BITGET_SECRET;
const PAS = process.env.BITGET_API_PASSPHRASE || process.env.BITGET_PASSPHRASE;
const PRODUCT = 'USDT-FUTURES';

const hdr = (method, path, qs, body) => {
  const ts = Date.now().toString();
  return {
    'ACCESS-KEY': KEY, 'ACCESS-SIGN': crypto.createHmac('sha256', SEC).update(ts + method.toUpperCase() + path + (qs ? '?' + qs : '') + body).digest('base64'),
    'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': PAS, 'Content-Type': 'application/json', locale: 'en-US',
  };
};
async function call(method, path, { qs = '', body = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(HOST + path + (qs ? '?' + qs : ''), { method, headers: hdr(method, path, qs, bodyStr), body: bodyStr || undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && j.code !== '00000')) throw new Error(path + ' -> ' + (j.code || res.status) + ' ' + (j.msg || ''));
  return j.data;
}

const [sym, size, lev, stopPx] = process.argv.slice(2);
if (!sym || !size || !lev || !stopPx) { console.log('usage: sym size lev stopPx'); process.exit(1); }

await call('POST', '/api/v2/mix/account/set-leverage', {
  body: { symbol: sym, productType: PRODUCT, marginCoin: 'USDT', leverage: String(lev), marginMode: 'isolated' },
}).catch(e => console.log('lev warn:', e.message.slice(0, 80)));

const body = {
  symbol: sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT',
  size: String(size), side: 'buy', tradeSide: 'open', orderType: 'market',
  presetStopLossPrice: String(stopPx),
  clientOid: ('mkt' + Date.now().toString(36)).slice(0, 38),
};
const r = await call('POST', '/api/v2/mix/order/place-order', { body });
console.log('SEAT OPEN', sym, 'sz', size, 'lev', lev, 'presetSL', stopPx, 'orderId', r?.orderId || r);
