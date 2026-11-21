import './load-env.mjs';
import crypto from 'node:crypto';
// Operator order 2026-11-19: deploy remaining capital into high-ATR seats.
// isolated lev, market entry, immediate pos_loss stop via place-tpsl-order
// (place-plan-order rejects pos_loss with 400172 on this account).
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
const SEATS = JSON.parse(process.env.OPEN_SEATS || '[]'); // [{sym,size,lev,stopPct|stopPx}]
// contract pricePlace drives trigger-price precision — toFixed(8) over-sets
// sub-1dp contracts and Bitget 40808s the stop (VELVET/ZEC/HYPE all bit).
const contracts = await call('GET', '/api/v2/mix/market/contracts', { qs: `productType=${PRODUCT}` });
const pricePlace = {};
for (const c of (contracts?.data || contracts || [])) pricePlace[c.symbol] = +c.pricePlace;
for (const s of SEATS) {
  const { sym, size, lev = 10, stopPct = 4.5, stopPx: absStop, side = 'long' } = s;
  const long = side === 'long';
  try {
    // leverage first (isolated)
    await call('POST', '/api/v2/mix/account/set-leverage', { body: { symbol: sym, productType: PRODUCT, marginCoin: 'USDT', leverage: String(lev), marginMode: 'isolated' } }).catch(e => console.log(sym, 'lev warn:', e.message.slice(0, 80)));
    const body = { symbol: sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', size: String(size), side: long ? 'buy' : 'sell', tradeSide: 'open', orderType: 'market', clientOid: ('ops' + Date.now().toString(36)).slice(0, 38) };
    console.log(sym, 'OPEN', size, '@~lev' + lev);
    const r = await call('POST', '/api/v2/mix/order/place-order', { body });
    console.log(sym, 'ORDER', JSON.stringify(r).slice(0, 200));
    await new Promise(r2 => setTimeout(r2, 2000));
    const pos = await call('GET', '/api/v2/mix/position/single-position', { qs: `symbol=${sym}&productType=${PRODUCT}&marginCoin=USDT` });
    const p = Array.isArray(pos) ? pos[0] : pos;
    const entry = +p?.openPriceAvg || 0;
    console.log(sym, 'FILLED entry', entry, 'size', p?.total, 'mgn', p?.marginSize);
    if (entry > 0) {
      // immediate whole-position stop — absolute stopPx if given, else ~stopPct below entry
      const dec = pricePlace[sym] ?? 2;
      // INVARIANT: stop must sit above liquidation (long). If the intended
      // stop is at/below liq, clamp it 0.5% above the liq line — a tighter
      // stop is always better than a dead one (IRYS 2026-11-20: liq 0.01945
      // sat above the 0.0193 stop; the seat would've liquidated untriggered).
      const liq = +p?.liquidationPrice || 0;
      let raw = absStop != null ? +absStop : long ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
      if (liq > 0 && (long ? raw <= liq : raw >= liq)) {
        raw = long ? liq * 1.005 : liq * 0.995;
        console.log(sym, 'stop clamped inside liq', liq);
      }
      const stopPx = raw.toFixed(dec);
      try {
        await call('POST', '/api/v2/mix/order/place-tpsl-order', { body: { symbol: sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', planType: 'pos_loss', triggerPrice: stopPx, executePrice: '0', triggerType: 'mark_price', holdSide: side, clientOid: ('opsstop' + Date.now().toString(36)).slice(0, 38) } });
        console.log(sym, 'STOP placed @', stopPx);
        // widen-only floor in state/stop-override.json so the watcher's band
        // refit can never retreat this stop tighter in the window before
        // cmd-manual-hold lands (the UNITREE wick-kill, 2026-11-20).
        try {
          const { fileURLToPath } = await import('node:url');
          const path = await import('node:path');
          const fsM = await import('node:fs');
          const ovP = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'state', 'stop-override.json');
          const ov = fsM.existsSync(ovP) ? (JSON.parse(fsM.readFileSync(ovP, 'utf8')) || {}) : {};
          const pct = +((Math.abs(entry - +stopPx) / entry) * 100).toFixed(3);
          if (pct > (+ov[sym]?.stopPct || 0)) { ov[sym] = { stopPct: pct, at: Date.now() }; fsM.writeFileSync(ovP, JSON.stringify(ov)); }
          console.log(sym, 'stop-override floor', pct + '%');
        } catch (e) { console.log(sym, 'override write fail:', e.message.slice(0, 80)); }
      } catch (e) { console.log(sym, 'STOP FAIL:', e.message.slice(0, 120)); }
    }
  } catch (e) { console.log(sym, 'ERR', e.message.slice(0, 160)); }
}
console.log('DONE');
