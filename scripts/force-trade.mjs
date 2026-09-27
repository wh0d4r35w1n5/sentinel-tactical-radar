// manual override: force-enter a position NOW.
// usage: node force-trade.mjs SYMBOLUSDT LONG|SHORT [stopPct=0.9] [tgtPct=4.0]
import crypto from 'node:crypto';
import fs from 'node:fs';
try {
  for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES', MC = 'USDT';
const KEY = process.env.BITGET_API_KEY, SECRET = process.env.BITGET_API_SECRET, PASS = process.env.BITGET_PASSPHRASE;
const hdr = (m, p, qs, b) => {
  const ts = String(Date.now());
  return { 'ACCESS-KEY': KEY, 'ACCESS-SIGN': crypto.createHmac('sha256', SECRET).update(ts + m + p + (qs ? '?' + qs : '') + (b || '')).digest('base64'), 'ACCESS-PASSPHRASE': PASS, 'ACCESS-TIMESTAMP': ts, 'Content-Type': 'application/json', locale: 'en-US' };
};
const api = async (m, p, { qs = '', body = null } = {}) => {
  const b = body ? JSON.stringify(body) : '';
  const r = await fetch(HOST + p + (qs ? '?' + qs : ''), { method: m, headers: hdr(m, p, qs, b), body: b || undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code && j.code !== '00000')) throw new Error(`${p} ${m} -> ${j.code || r.status} ${j.msg}`);
  return j.data;
};
const SYM = process.argv[2] || 'NEARUSDT';
const DIR = (process.argv[3] || 'LONG').toUpperCase();
const SGN = DIR === 'LONG' ? 1 : -1;
const HOLD = DIR === 'LONG' ? 'long' : 'short';
const BUYSIDE = DIR === 'LONG' ? 'buy' : 'sell';
const stopPct = +(process.argv[4] || 0.9);
const tgtPct = +(process.argv[5] || 4.0);
// 1. cancel any plans + close any existing position on the symbol
const plans = await api('GET', '/api/v2/mix/order/orders-plan-pending', { qs: `symbol=${SYM}&productType=${PRODUCT}&marginCoin=${MC}&planType=profit_loss` });
const byType = {};
for (const pl of plans?.entrustedList || []) if (pl.orderId && pl.planType) (byType[pl.planType] ??= []).push(pl.orderId);
for (const [pt, ids] of Object.entries(byType))
  await api('POST', '/api/v2/mix/order/cancel-plan-order', { body: { symbol: SYM, productType: PRODUCT, marginCoin: MC, planType: pt, orderIdList: ids.map((id) => ({ orderId: id })) } });
const pos = await api('GET', '/api/v2/mix/position/all-position', { qs: `productType=${PRODUCT}&marginCoin=${MC}` });
const np = (pos || []).find((p) => p.symbol === SYM && +p.total > 0);
if (np) {
  await api('POST', '/api/v2/mix/order/close-positions', { body: { symbol: SYM, productType: PRODUCT, holdSide: np.holdSide } });
  console.log('closed existing', np.holdSide, np.total, '@', np.openPriceAvg);
}
// 2. size: ~85% available margin, highest leverage whose stop fits the liq band
const accts = await api('GET', '/api/v2/mix/account/accounts', { qs: `productType=${PRODUCT}` });
const acct = (accts || []).find((a) => a.marginCoin === MC) || {};
const avail = +acct.available;
const ctr = (await (await fetch(`${HOST}/api/v2/mix/market/contracts?productType=${PRODUCT}`)).json()).data.find((c) => c.symbol === SYM);
const tick = await api('GET', '/api/v2/mix/market/ticker', { qs: `symbol=${SYM}&productType=${PRODUCT}` });
const px = +(Array.isArray(tick) ? tick[0].lastPr : tick.lastPr);
const lev = Math.min(+ctr.maxLever, Math.floor(80 / (stopPct + 0.64)));
const prec = Math.pow(10, +ctr.volumePlace || 0);
const minQ = Math.max(+ctr.minTradeNum, (+ctr.minTradeUSDT || 0) / px);
console.log(`equity $${(+acct.usdtEquity).toFixed(2)} avail $${avail.toFixed(2)} | ${SYM} px ${px} | lev ${lev}x`);
// 3. open — FORCE_MARGIN_USD pins an absolute margin budget (e.g. 50% of
// equity per leg of a two-trade deployment); otherwise retry the ladder
await api('POST', '/api/v2/mix/account/set-margin-mode', { body: { symbol: SYM, productType: PRODUCT, marginCoin: MC, marginMode: 'isolated' } }).catch(() => {});
await api('POST', '/api/v2/mix/account/set-leverage', { body: { symbol: SYM, productType: PRODUCT, marginCoin: MC, leverage: String(lev) } });
const FIXED = +process.env.FORCE_MARGIN_USD || 0;
let size = 0, done = false;
const fracs = FIXED ? [Math.min(FIXED / avail, 0.97), Math.min(FIXED / avail, 0.97) * 0.95] : [0.85, 0.80, 0.75, 0.70, 0.60];
for (const frac of fracs) {
  size = Math.max(Math.floor((avail * frac * lev) / px * prec) / prec, Math.ceil(minQ * prec) / prec);
  try {
    await api('POST', '/api/v2/mix/order/place-order', { body: { symbol: SYM, productType: PRODUCT, marginMode: 'isolated', marginCoin: MC, size: String(size), side: BUYSIDE, orderType: 'market', tradeSide: 'open' } });
    console.log('filled at', (frac * 100).toFixed(0) + '% of avail — size', size, '~$' + (size * px).toFixed(2), 'notional, ~$' + (size * px / lev).toFixed(2), 'margin');
    done = true; break;
  } catch (e) { console.log('attempt', (frac * 100).toFixed(0) + '% rejected:', e.message); }
}
if (!done) throw new Error('all size attempts rejected');
// 4. mandatory exchange-side protection — never naked
const pos2 = await api('GET', '/api/v2/mix/position/all-position', { qs: `productType=${PRODUCT}&marginCoin=${MC}` });
const lp = (pos2 || []).find((p) => p.symbol === SYM && +p.total > 0);
const fill = +lp.openPriceAvg, pp = +ctr.pricePlace || 4;
await api('POST', '/api/v2/mix/order/place-tpsl-order', { body: { symbol: SYM, productType: PRODUCT, marginMode: 'isolated', marginCoin: MC, planType: 'profit_plan', triggerPrice: (fill * (1 + SGN * tgtPct / 100)).toFixed(pp), executePrice: '0', triggerType: 'mark_price', size: String(lp.total), holdSide: HOLD } });
await api('POST', '/api/v2/mix/order/place-tpsl-order', { body: { symbol: SYM, productType: PRODUCT, marginMode: 'isolated', marginCoin: MC, planType: 'loss_plan', triggerPrice: (fill * (1 - SGN * stopPct / 100)).toFixed(pp), executePrice: '0', triggerType: 'mark_price', size: String(lp.total), holdSide: HOLD } });
console.log(`${DIR} ${SYM} ${lp.total} @ ${fill} lev ${lev}x margin ~$${(lp.total * fill / lev).toFixed(2)} | TP ${SGN * tgtPct}% @ ${(fill * (1 + SGN * tgtPct / 100)).toFixed(pp)} | SL ${-SGN * stopPct}% @ ${(fill * (1 - SGN * stopPct / 100)).toFixed(pp)}`);
