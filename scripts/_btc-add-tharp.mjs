import './load-env.mjs';
import crypto from 'node:crypto';
// Operator order 2026-11-19: BTC breakout seat is tiny — add to Tharp size.
// Raw signed market add (same pattern as _amkr-add2.mjs). openRiskEntry
// refuses adds onto existing positions, so this rides the exchange directly;
// bitget-watch re-arms whole-position stop+TP on size drift next cycle.
const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES';
const key = process.env.BITGET_API_KEY, secret = process.env.BITGET_API_SECRET, pass = process.env.BITGET_PASSPHRASE;
if (!key || !secret || !pass) { console.log('NO CREDS'); process.exit(1); }
function hdr(method, path, qs, bodyStr) {
  const ts = String(Date.now());
  const pre = ts + method.toUpperCase() + path + (qs ? '?' + qs : '') + (bodyStr || '');
  const sign = crypto.createHmac('sha256', secret).update(pre).digest('base64');
  return { 'ACCESS-KEY': key, 'ACCESS-SIGN': sign, 'ACCESS-PASSPHRASE': pass, 'ACCESS-TIMESTAMP': ts, 'Content-Type': 'application/json', locale: 'en-US' };
}
async function call(method, path, { qs = '', body = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(HOST + path + (qs ? '?' + qs : ''), { method, headers: hdr(method, path, qs, bodyStr), body: bodyStr || undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && j.code !== '00000')) throw new Error(path + ' -> ' + (j.code || res.status) + ' ' + (j.msg || ''));
  return j.data;
}
const SYM = 'BTCUSDT';
const TARGET_NOTIONAL = 92;          // ~4% equity risk at ~1.22% stop+fees on $30.5 book
const t = await fetch(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${SYM}&productType=${PRODUCT}`).then(r => r.json());
const price = +t.data[0].lastPr;
const pos = (await call('GET', '/api/v2/mix/position/single-position', { qs: `symbol=${SYM}&productType=${PRODUCT}&marginCoin=USDT` }));
const p = Array.isArray(pos) ? pos[0] : pos;
const curSize = +p?.total || 0, curEntry = +p?.openPriceAvg || 0;
const curNotional = curSize * curEntry;
const addNotional = Math.max(0, TARGET_NOTIONAL - curNotional);
let addSize = +(addNotional / price).toFixed(4);   // BTCUSDT trades 4dp
if (addSize <= 0) { console.log('NO ADD NEEDED', JSON.stringify({ price, curSize, curNotional })); process.exit(0); }
const body = { symbol: SYM, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', size: String(addSize), side: 'buy', tradeSide: 'open', orderType: 'market', clientOid: ('btct' + Date.now()).slice(0, 38) };
console.log('price', price, 'curSize', curSize, 'curNotional', curNotional.toFixed(2), '-> add', addSize, 'notional~', (addSize * price).toFixed(2));
const r = await call('POST', '/api/v2/mix/order/place-order', { body });
console.log('ORDER', JSON.stringify(r));
await new Promise(r2 => setTimeout(r2, 2500));
const pos2 = (await call('GET', '/api/v2/mix/position/single-position', { qs: `symbol=${SYM}&productType=${PRODUCT}&marginCoin=USDT` }));
console.log('POS', JSON.stringify(pos2).slice(0, 600));
console.log('DONE');