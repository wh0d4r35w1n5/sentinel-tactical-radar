import './load-env.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// operator-clone (c=74): concentrated momentum-pullback lane.
// Pattern source: the 19-20 Oct winning longs (Q, BR).
//   Universe : top-10 by 24h volume, day change > +5%, price above 1h trendline.
//   Entry    : FIRST 5m pullback that holds above the trendline -> limit long.
//   Size     : 4% of equity at risk, -0.6% exchange stop. Max 2 positions.
//   Exits    : BE stop at +0.5%, sized profit_plan rungs +1/+2/+3%, 90min TTL.
//   Exempt   : bank-now / fade-clip never touch (seats registered manual).
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(ROOT, '..', 'state');
const STATE = path.join(STATE_DIR, 'operator-clone.json');
const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES';
const MAX_POS = 2, RISK_PCT = 4, STOP_PCT = 0.6, BE_AT = 0.5, TTL_MS = 90 * 60e3;
const TP_RUNGS = [[1.0, 0.25], [2.0, 0.25], [3.0, 0.25]]; // 25% runner rides the BE-ratchet trail — breakout capture (HUMA 09:0xZ)
const ARMED_UNTIL = process.env.OC_ARMED_UNTIL ? +process.env.OC_ARMED_UNTIL : Infinity; // epoch ms; ~6:20pm AEDT
const SKIP = new Set((process.env.OC_SKIP || 'BTCUSDT,ETHUSDT').split(','));

const key = process.env.BITGET_API_KEY, secret = process.env.BITGET_API_SECRET, pass = process.env.BITGET_PASSPHRASE;
if (!key) { console.log('NO CREDS'); process.exit(1); }
const hdr = (m, p, qs, b) => {
  const ts = String(Date.now());
  return { 'ACCESS-KEY': key, 'ACCESS-SIGN': crypto.createHmac('sha256', secret).update(ts + m.toUpperCase() + p + (qs ? '?' + qs : '') + (b || '')).digest('base64'), 'ACCESS-PASSPHRASE': pass, 'ACCESS-TIMESTAMP': ts, 'Content-Type': 'application/json', locale: 'en-US' };
};
async function call(m, p, qs = '', body = null) {
  const b = body ? JSON.stringify(body) : '';
  const r = await fetch(HOST + p + (qs ? '?' + qs : ''), { method: m, headers: hdr(m, p, qs, b), body: b || undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code && j.code !== '00000')) throw new Error(p + ' -> ' + (j.code || r.status) + ' ' + (j.msg || ''));
  return j.data;
}
const pub = async (p, qs) => (await (await fetch(HOST + p + '?' + qs)).json()).data;

const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { seats: {}, cooldown: {} };
st.cooldown ||= {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const COOLDOWN_MS = 10 * 60e3; // no re-entry on a symbol for 10min after its seat closed (EVAA churn 08:44Z)

// trade-reasons: every seat records WHY it opened so the dashboard can show
// the reasoning + per-tag proof stats (our fills, not textbook priors).
const REASONS = path.join(STATE_DIR, 'trade-reasons.json');
function noteReason(sym, tag, reason, pub) {
  try {
    const d = fs.existsSync(REASONS) ? JSON.parse(fs.readFileSync(REASONS, 'utf8')) : {};
    (d[sym] = d[sym] || []).push({ tag, reason, pub, at: Date.now() });
    if (d[sym].length > 20) d[sym] = d[sym].slice(-20);
    fs.writeFileSync(REASONS, JSON.stringify(d));
  } catch {}
}

const contracts = await call('GET', '/api/v2/mix/market/contracts', `productType=${PRODUCT}`);
const meta = {};
for (const c of (contracts?.data || contracts || [])) meta[c.symbol] = c;

function ema(v, n) { let e = v[0]; const k = 2 / (n + 1); for (let i = 1; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }
async function klines(sym, gran, n) {
  const d = await pub('/api/v2/mix/market/candles', `symbol=${sym}&productType=${PRODUCT}&granularity=${gran}&limit=${n}`);
  return (d || []).map(c => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] })).sort((a, b) => a.t - b.t);
}
const trend = (h1) => ema(h1.map(c => c.c), Math.min(20, h1.length)); // 1h EMA20 = the trend line

async function equity() {
  const a = await call('GET', '/api/v2/mix/account/account', `productType=${PRODUCT}&marginCoin=USDT&symbol=BTCUSDT`);
  return { eq: +a.accountEquity, free: +a.available };
}

async function candidates() {
  const bubbles = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'cryptobubbles.json'), 'utf8'));
  const arr = Object.entries(bubbles.bySym || {}).map(([sym, b]) => ({ sym, day: +b.day || 0, vol: +b.vol || 0 }));
  arr.sort((a, b) => b.vol - a.vol);
  const out = [];
  for (const b of arr) {
    if (SKIP.has(b.sym) || !meta[b.sym] || !(b.day > 5)) continue;
    out.push(b);
    if (out.length >= 10) break;
  }
  return out;
}

async function pullback(sym) {
  const h1 = await klines(sym, '1H', 25);
  const tr = trend(h1);
  const last = h1[h1.length - 1].c;
  if (!(last > tr)) return null;                        // must be above the 1h trend line
  const m5 = await klines(sym, '5m', 30);
  const recentHigh = Math.max(...m5.slice(-12).map(c => c.h));
  const cur = m5[m5.length - 1];
  const dip = (recentHigh - cur.c) / recentHigh * 100;  // pulled back off the 5m high
  const held = cur.l > tr;                            // pullback held above the trend line
  if (dip > 0.15 && dip < 2.5 && held) return { px: cur.c, tr, dip };
  return null;
}

async function openSeat(cand, pb, eq, free) {
  const sym = cand.sym, px = pb.px;
  const c = meta[sym];
  const dec = +c.pricePlace, vDec = +c.volumePlace, minSz = +c.minTradeNum || 1;
  let notional = (eq * RISK_PCT / 100) / (STOP_PCT / 100);   // 4% risk / 0.6% stop
  notional = Math.min(notional, free * 10 * 0.92);         // 10x isolated, margin budget
  let size = Math.floor(notional / px / (10 ** -vDec)) * (10 ** -vDec);
  if (size < minSz) throw new Error(`size ${size} < min ${minSz}`);
  await call('POST', '/api/v2/mix/account/set-leverage', '', { symbol: sym, productType: PRODUCT, marginCoin: 'USDT', leverage: '10', marginMode: 'isolated' }).catch(() => {});
  const lim = +(px * (1 - 0.0008)).toFixed(dec);           // limit just under mark — pullback fill
  await call('POST', '/api/v2/mix/order/place-order', '', { symbol: sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', size: String(size), side: 'buy', tradeSide: 'open', orderType: 'limit', price: String(lim), force: 'gtc', clientOid: ('oc' + Date.now().toString(36)).slice(0, 38) });
  noteReason(sym, 'clone-mom', `top10vol day+${(+cand.day).toFixed(1)}% >1hEMA20, dip ${(+pb.dip).toFixed(2)}% held, limit pullback`, 'mom-pullback prior ~55-60% (Q/BR 19-20 Oct +0.6/+1.3%)');
  return { sym, size, limPx: lim, at: Date.now(), filled: false, be: false };
}

async function armSeat(s, entry, liq) {
  const dec = +meta[s.sym].pricePlace;
  let stop = entry * (1 - STOP_PCT / 100);
  if (liq > 0 && stop <= liq) stop = liq * 1.005;          // stop-above-liq invariant
  await call('POST', '/api/v2/mix/order/place-tpsl-order', '', { symbol: s.sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', planType: 'pos_loss', triggerPrice: stop.toFixed(dec), executePrice: '0', triggerType: 'mark_price', holdSide: 'long' });
  s.stop = +stop.toFixed(dec);
  await Promise.all(TP_RUNGS.map(([pct, frac]) => {
    const sz = Math.max(1, Math.floor(s.size * frac));
    return call('POST', '/api/v2/mix/order/place-tpsl-order', '', { symbol: s.sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', planType: 'profit_plan', triggerPrice: (entry * (1 + pct / 100)).toFixed(dec), executePrice: (entry * (1 + pct / 100)).toFixed(dec), triggerType: 'mark_price', holdSide: 'long', size: String(sz) }).catch(e => console.log('tp', pct, e.message.slice(0, 60)));
  }));
  s.entry = entry; s.armedAt = Date.now();
}

async function cycle() {
  const now = Date.now();
  const pos = await call('GET', '/api/v2/mix/position/all-position', `productType=${PRODUCT}&marginCoin=USDT`);
  const book = {};
  for (const p of (pos || [])) book[p.symbol + ':' + p.holdSide] = p;

  // ---- manage open seats: fills, BE at +0.5%, TTL
  for (const [k, s] of Object.entries(st.seats)) {
    const p = book[k + ':long'];
    if (!s.filled) {
      if (p && +p.total > 0) { s.filled = true; s.size = +p.total; await armSeat(s, +p.openPriceAvg, +p.liquidationPrice || 0).catch(e => console.log('arm', e.message.slice(0, 80))); }
      else if (now - s.at > 6 * 60e3) { await call('POST', '/api/v2/mix/order/cancel-order', '', { symbol: s.sym, productType: PRODUCT, marginCoin: 'USDT', orderId: s.orderId }).catch(() => {}); delete st.seats[k]; }
      continue;
    }
    if (!p || +p.total === 0) { console.log(k, 'closed'); st.cooldown[k] = Date.now(); delete st.seats[k]; continue; }
    const mark = +p.markPrice, entry = +p.openPriceAvg, liq = +p.liquidationPrice || 0;
    const fav = (mark - entry) / entry * 100;
    if (!s.be && fav >= BE_AT) {                             // +0.5% -> stop to breakeven+fees
      const be = +(entry * 1.001).toFixed(+meta[s.sym].pricePlace);
      if (be > liq && be < mark) {
        await call('POST', '/api/v2/mix/order/place-tpsl-order', '', { symbol: s.sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', planType: 'pos_loss', triggerPrice: String(be), executePrice: '0', triggerType: 'mark_price', holdSide: 'long' }).then(() => { s.be = true; s.stop = be; console.log(s.sym, 'BE stop', be); }).catch(() => {});
      }
    }
    if (s.armedAt && now - s.armedAt > TTL_MS) {             // 90-min time limit
      await call('POST', '/api/v2/mix/order/place-order', '', { symbol: s.sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', size: String(p.total), side: 'sell', tradeSide: 'close', orderType: 'market' }).then(() => console.log(s.sym, 'TTL close')).catch(() => {});
    }
  }

  // ---- hunt entries while armed
  const openN = Object.keys(st.seats).length;
  // tag self-cut (Claude scoring rule): if clone-mom's own episode stats go
  // expectancy-negative after 20+ trades, the lane stops entering — the tag
  // has to re-earn deployment with fresh evidence, not vibes.
  let tagCut = false;
  try {
    const tg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8')).tags || {};
    const t = tg['clone-mom'];
    // CI-aware gate (external review): cut when the honest open-tag board shows
    // negative expectancy AND losing profit factor once the sample is real
    // (n>=10), or the old 20-ep rule. wlb<30 also trips early on deep losers.
    if (t && ((t.ep >= 10 && t.exp < -0.15 && (t.pf == null || t.pf < 0.8))
           || (t.ep >= 20 && t.exp < 0) || (t.ep >= 10 && t.wlb != null && t.wlb < 30))) tagCut = true;
  } catch {}
  if (tagCut) console.log('TAG-CUT clone-mom: honest-board expectancy negative — no new entries');
  if (now < ARMED_UNTIL && openN < MAX_POS && !tagCut) {
    const { eq, free } = await equity();
    if (free > 1.5) {
      // filter BEFORE spending candle calls; then check all pullbacks in
      // parallel — 10 sequential syms × 2 fetches was ~4-8s of a 12s cycle.
      const cands = (await candidates()).filter(c =>
        !st.seats[c.sym] && !book[c.sym + ':long'] &&
        !(st.cooldown[c.sym] && now - st.cooldown[c.sym] < COOLDOWN_MS));
      const pbs = await Promise.all(cands.map(c => pullback(c.sym).catch(() => null)));
      for (let i = 0; i < cands.length; i++) {
        if (Object.keys(st.seats).length >= MAX_POS) break;
        const cand = cands[i], pb = pbs[i];
        if (!pb) continue;
        try {
          const s = await openSeat(cand, pb, eq, free);
          st.seats[cand.sym] = s;
          console.log('OC-OPEN', cand.sym, 'day', cand.day.toFixed(1) + '%', 'dip', pb.dip.toFixed(2) + '%', 'lim', s.limPx, 'sz', s.size);
        } catch (e) { console.log('OC-FAIL', cand.sym, e.message.slice(0, 90)); }
      }
    }
  }
  save();
}

console.log('operator-clone armed until', ARMED_UNTIL === Infinity ? 'forever' : new Date(ARMED_UNTIL).toISOString());
while (true) { await cycle().catch(e => console.log('cycle err:', String(e.message || e).slice(0, 140))); await new Promise(r => setTimeout(r, 12000)); }
