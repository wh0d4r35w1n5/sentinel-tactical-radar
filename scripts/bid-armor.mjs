// bid-armor.mjs — every open seat must have staggered TP rungs + a reason tag.
// Runs forever (30s). Detects positions lacking pos_profit plans and attaches
// the ladder automatically. Doctrine: partials + runner, never single-TP.
import fs from 'node:fs';
import crypto from 'node:crypto';

for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES';
const KEY = process.env.BITGET_API_KEY || process.env.BITGET_KEY;
const SEC = process.env.BITGET_API_SECRET || process.env.BITGET_SECRET;
const PAS = process.env.BITGET_API_PASSPHRASE || process.env.BITGET_PASSPHRASE;
const REASONS = '/opt/sentinel/state/trade-reasons.json';
const SEEN = '/opt/sentinel/state/bid-armor-seen.json';
const log = (...a) => console.log(`[armor ${new Date().toISOString().slice(11, 19)}]`, ...a);

const hdr = (method, path, qs, body) => {
  const ts = Date.now().toString();
  return {
    'ACCESS-KEY': KEY,
    'ACCESS-SIGN': crypto.createHmac('sha256', SEC).update(ts + method.toUpperCase() + path + (qs ? '?' + qs : '') + body).digest('base64'),
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// rung targets: structure-aware fallback ladder (+4% / +9% / +15% runner)
const rungsFor = (entry, size, sizePlace = 3) => {
  const step = 10 ** -sizePlace;
  const minSz = step;
  const rungs = [];
  const pct = [[0.04, 0.33], [0.09, 0.33], [0.15, 0.34]];
  for (const [tp, frac] of pct) {
    const sz = Math.floor(size * frac / step) * step;
    if (sz >= minSz) rungs.push({ sz: +sz.toFixed(sizePlace), px: +(entry * (1 + tp)).toFixed(6) });
  }
  // if size too small to split: single rung at +7% covering all — still a TP
  if (!rungs.length) rungs.push({ sz: size, px: +(entry * 1.07).toFixed(6) });
  return rungs;
};

async function cycle() {
  const pos = await call('GET', '/api/v2/mix/position/all-position', { qs: `productType=${PRODUCT}&marginCoin=USDT` }).catch(() => []);
  const contracts = await call('GET', '/api/v2/mix/market/contracts', { qs: `productType=${PRODUCT}` }).catch(() => ({}));
  const cmap = {};
  for (const c of contracts?.data || contracts || []) cmap[c.symbol] = c;
  const seen = fs.existsSync(SEEN) ? JSON.parse(fs.readFileSync(SEEN, 'utf8')) : {};

  for (const p of pos || []) {
    const sym = p.symbol, side = p.holdSide;
    const size = +p.total, entry = +p.openPriceAvg || +p.markPrice;
    // existing pos_profit plans?
    const plans = await call('GET', '/api/v2/mix/order/orders-plan-pending', { qs: `productType=${PRODUCT}&symbol=${sym}&planType=pos_profit` }).catch(() => []);
    const pl = plans?.entrustedList || [];
    const covered = pl.reduce((a, o) => a + (+o.size || size), 0);
    if (covered >= size * 0.95) continue; // ladder already covers the seat

    const sp = +(cmap[sym]?.sizePlace ?? 3);
    const rungs = rungsFor(entry, size, sp);
    for (const r of rungs) {
      await call('POST', '/api/v2/mix/order/place-tpsl-order', {
        body: {
          symbol: sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT',
          planType: 'pos_profit', triggerPrice: String(r.px), executePrice: '0',
          triggerType: 'mark_price', holdSide: side, size: String(r.sz),
          clientOid: ('tp' + Date.now().toString(36) + Math.floor(Math.random() * 999)).slice(0, 38),
        },
      }).then(() => log(sym, 'TP rung', r.sz, '@', r.px)).catch(e => log(sym, 'TP fail', r.px, e.message.slice(0, 70)));
      await sleep(150);
    }
    // ensure a stop exists too — naked downside is worse than naked upside
    const sls = await call('GET', '/api/v2/mix/order/orders-plan-pending', { qs: `productType=${PRODUCT}&symbol=${sym}&planType=pos_loss` }).catch(() => []);
    if (!(sls?.entrustedList || []).length) {
      const slPx = +(entry * 0.975).toFixed(6);
      await call('POST', '/api/v2/mix/order/place-tpsl-order', {
        body: {
          symbol: sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT',
          planType: 'pos_loss', triggerPrice: String(slPx), executePrice: '0',
          triggerType: 'mark_price', holdSide: side,
          clientOid: ('sl' + Date.now().toString(36)).slice(0, 38),
        },
      }).then(() => log(sym, 'SL backstop', slPx)).catch(e => log(sym, 'SL fail', e.message.slice(0, 70)));
    }
    // reason tag once per seat instance
    const k = `${sym}:${side}:${entry}`;
    if (!seen[k]) {
      seen[k] = Date.now();
      try {
        const reasons = JSON.parse(fs.readFileSync(REASONS, 'utf8'));
        (reasons[sym] = reasons[sym] || []).push({
          tag: 'bid-fill', reason: 'resting limit filled — armor auto-attached (staggered TP + SL backstop)',
          pub: 'dip-bid structure', at: Date.now(),
        });
        fs.writeFileSync(REASONS, JSON.stringify(reasons));
      } catch {}
      fs.writeFileSync(SEEN, JSON.stringify(seen));
      log(sym, 'armored + tagged');
    }
  }
}

log('bid-armor live');
for (;;) { try { await cycle(); } catch (e) { log('cycle err:', e.message.slice(0, 100)); } await sleep(30000); }
