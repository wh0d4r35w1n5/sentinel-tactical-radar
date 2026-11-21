import './load-env.mjs';
import crypto from 'node:crypto';
// Operator order 2026-11-19: increase position size on green seats (double).
// Market open-side add, same pattern as _btc-add-tharp.mjs. Watcher re-arms
// stop+ladder on size drift next cycle.
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
const SYMS = (process.env.ADD_SYMS || 'XAGUSDT').split(',');
const MULT = +(process.env.ADD_MULT || 1); // add = current size * MULT
for (const SYM of SYMS) {
  try {
    const pos = await call('GET', '/api/v2/mix/position/single-position', { qs: `symbol=${SYM}&productType=${PRODUCT}&marginCoin=USDT` });
    const p = Array.isArray(pos) ? pos[0] : pos;
    const curSize = +p?.total || 0;
    if (curSize <= 0) { console.log(SYM, 'FLAT — skip'); continue; }
    // size decimals from current size frac length
    const frac = String(curSize).split('.')[1] || '';
    const sizeDec = Math.max(frac.length, 2);
    let addSize = +(curSize * MULT).toFixed(sizeDec);
    if (addSize <= 0) { console.log(SYM, 'NO ADD'); continue; }
    const body = { symbol: SYM, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', size: String(addSize), side: 'buy', tradeSide: 'open', orderType: 'market', clientOid: ('opadd' + Date.now().toString(36)).slice(0, 38) };
    console.log(SYM, 'cur', curSize, '-> add', addSize, '(x' + MULT + ')');
    const r = await call('POST', '/api/v2/mix/order/place-order', { body });
    console.log(SYM, 'ORDER', JSON.stringify(r).slice(0, 300));
    await new Promise(r2 => setTimeout(r2, 2000));
    const pos2 = await call('GET', '/api/v2/mix/position/single-position', { qs: `symbol=${SYM}&productType=${PRODUCT}&marginCoin=USDT` });
    const p2 = Array.isArray(pos2) ? pos2[0] : pos2;
    console.log(SYM, 'NOW size', p2?.total, 'entry', p2?.openPriceAvg, 'mgn', p2?.marginSize, 'ct', p2?.cTime);
  } catch (e) { console.log(SYM, 'ERR', e.message); }
}
console.log('DONE');
