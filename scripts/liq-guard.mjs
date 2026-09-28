// liq-guard.mjs — last-ditch survival trimmer for open futures positions.
//
// Behaviour (operator mandate):
//   * watches EVERY open position (foreign/manual included — they need the
//     net most); LIQ_GUARD_SYM seeds a symbol even while flat
//   * dormant unless mark approaches liquidation within LIQ_GUARD_ZONE_PCT
//   * fires ONE ~5% reduceOnly market close per trigger event — never a
//     cascade: re-arm requires a fresh price deterioration past the mark
//     recorded at the last trim, and a SPACING_MS floor serializes orders
//   * after a trim the deeper liquidation band lets the stop reset lower —
//     the guard re-places pos_loss at ~75% of the new band (inside the
//     executor's clamp range so nothing fights it) via place-then-cancel
//   * stops trimming a position below its min-closeable size — the residual
//     runner belongs to its stop, not to shavings
//
// Env: LIQ_GUARD=1 arms it (absent/disabled = pure dormant).  300ms loop fed
// by sanity-checked public ws tickers (REST fallback); signed position/plan
// calls only inside the watch band or on the 30s anchor refresh, fresh again
// at fire time.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const ENABLED = process.env.LIQ_GUARD === '1';
const SEED_SYM = process.env.LIQ_GUARD_SYM || 'HBARUSDT'; // watched even while flat
const TRIM_PCT = +(process.env.LIQ_GUARD_TRIM_PCT || 5);
const ZONE_PCT = +(process.env.LIQ_GUARD_ZONE_PCT || 0.8);   // % from liq = danger
const NEAR_PCT = +(process.env.LIQ_GUARD_NEAR_PCT || 2.5);   // % from liq = refresh position truth fast
const SPACING_MS = +(process.env.LIQ_GUARD_SPACING_MS || 4e3); // serialization floor between close orders
const MIN_SIZE = +(process.env.LIQ_GUARD_MIN_SIZE || 2500);  // residual floor for the seed symbol
const POLL_MS = +(process.env.LIQ_GUARD_POLL_MS || 300);
const STATE = path.join(__dirname, '..', 'state', 'liq-guard.json');
const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES', COIN = 'USDT';
const WS_URL = 'wss://ws.bitget.com/v2/ws/public';

const KEY = process.env.BITGET_API_KEY || '';
const SECRET = process.env.BITGET_API_SECRET || '';
const PASS = process.env.BITGET_PASSPHRASE || '';
const log = (...a) => console.log('[liq-guard]', ...a);

if (!ENABLED) { log('LIQ_GUARD not armed — exiting'); process.exit(0); }
if (!KEY || !SECRET || !PASS) { log('no creds — exiting'); process.exit(1); }

function hdr(method, reqPath, qs, body) {
  const ts = String(Date.now());
  const pre = ts + method + reqPath + (qs ? '?' + qs : '') + (body || '');
  return {
    'ACCESS-KEY': KEY,
    'ACCESS-SIGN': crypto.createHmac('sha256', SECRET).update(pre).digest('base64'),
    'ACCESS-PASSPHRASE': PASS,
    'ACCESS-TIMESTAMP': ts,
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
}
async function api(method, reqPath, { qs = '', body = null } = {}) {
  const b = body ? JSON.stringify(body) : '';
  const r = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
    method, headers: hdr(method, reqPath, qs, b), body: b || undefined,
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.code && j.code !== '00000') throw new Error(`${reqPath} -> ${j.code} ${j.msg || ''}`);
  return j.data;
}
const pubTicker = async (sym) => {
  const r = await fetch(`${HOST}/api/v2/mix/market/ticker?symbol=${sym}&productType=${PRODUCT}`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return +(j?.data?.[0]?.markPrice || j?.data?.[0]?.lastPr || 0);
};
const getAllPos = async () => {
  const rows = await api('GET', '/api/v2/mix/position/all-position', { qs: `productType=${PRODUCT}&marginCoin=${COIN}` });
  return (rows || []).filter((x) => +x.total > 0).map((p) => ({
    sym: p.symbol, side: p.holdSide, size: +p.total, entry: +p.openPriceAvg,
    upl: +p.unrealizedPL, liq: +p.liquidationPrice, marginMode: p.marginMode, lev: +p.leverage,
  })).filter((p) => p.liq > 0);
};
const getPlans = async (sym) =>
  api('GET', '/api/v2/mix/order/orders-plan-pending', {
    qs: `symbol=${sym}&productType=${PRODUCT}&marginCoin=${COIN}&planType=profit_loss`,
  }).then((d) => d?.entrustedList || []);
const cancelPlan = (sym, planType, orderId) =>
  api('POST', '/api/v2/mix/order/cancel-plan-order', {
    body: { symbol: sym, productType: PRODUCT, marginCoin: COIN, orderId: String(orderId), planType },
  });
const planLoss = (sym, side, trigger) =>
  api('POST', '/api/v2/mix/order/place-tpsl-order', {
    body: { symbol: sym, marginCoin: COIN, productType: PRODUCT, planType: 'pos_loss', triggerPrice: String(trigger), holdSide: side, triggerType: 'mark_price', executePrice: '0' },
  });
const closeMarket = async (sym, side, sizeStr, posMode) => {
  const base = { symbol: sym, productType: PRODUCT, marginCoin: COIN, size: sizeStr, orderType: 'market' };
  if (posMode === 'hedge')
    // hedge-mode `side` is the POSITION direction: close long = buy+close.
    // (side:'sell' asks to close a short -> 22002 'No position to close')
    return api('POST', '/api/v2/mix/order/place-order', { body: { ...base, side: side === 'long' ? 'buy' : 'sell', tradeSide: 'close', marginMode: 'crossed' } });
  try {
    return await api('POST', '/api/v2/mix/order/place-order', { body: { ...base, side: side === 'long' ? 'sell' : 'buy', reduceOnly: 'YES', marginMode: 'crossed' } });
  } catch (e) {
    if (/margin ?mode|40774/i.test(e.message)) // retry isolated convention
      return api('POST', '/api/v2/mix/order/place-order', { body: { ...base, side: side === 'long' ? 'sell' : 'buy', reduceOnly: 'YES', marginMode: 'isolated' } });
    throw e;
  }
};

// --- realtime mark feed: Bitget public WS, REST ticker stays the fallback ---
// READ-ONLY public channel — no credentials near it, cannot place orders.
//   * no ws mark accepted until a REST anchor exists; a frame >5% off the
//     anchor is rejected and the socket resyncs — a poisoned/garbled feed can
//     never reach the trigger math
//   * ws mark stale >1.5s => treated as dead; REST polling resumes
const wsMarks = new Map();   // sym -> { px, at }
const restMarks = new Map(); // sym -> { px, at }  (sanity anchor + fallback)
const subbed = new Set();
let wsRef = null, wsRetryMs = 1000;
function startWs() {
  const ws = new WebSocket(WS_URL);
  wsRef = ws;
  let ping = null, watchdog = null;
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { try { ws.terminate(); } catch {} }, 60e3); };
  ws.on('open', () => {
    wsRetryMs = 1000;
    ws.send(JSON.stringify({ op: 'subscribe', args: [...subbed].map((s) => ({ instType: PRODUCT, channel: 'ticker', instId: s })) }));
    ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 20e3);
    arm();
    log(`ws feed connected — ${subbed.size} ticker(s)`);
  });
  ws.on('message', (buf) => {
    arm();
    let m; try { m = JSON.parse(buf.toString()); } catch { return; } // 'pong' heartbeat
    const sym = m?.arg?.instId, d = m?.data?.[0];
    const px = +(d?.markPrice || d?.lastPr || 0);
    if (!sym || !(px > 0)) return;
    const anchor = restMarks.get(sym)?.px || 0;
    if (!anchor) return; // untrusted until a REST anchor exists for this symbol
    if (Math.abs(px / anchor - 1) > 0.05) {
      log(`ws ${sym} mark ${px} rejected (${(Math.abs(px / anchor - 1) * 100).toFixed(1)}% off REST anchor ${anchor}) — resyncing`);
      try { ws.terminate(); } catch {}
      return;
    }
    wsMarks.set(sym, { px, at: Date.now() });
  });
  const bye = () => {
    clearInterval(ping); clearTimeout(watchdog);
    wsMarks.clear();
    if (wsRef === ws) wsRef = null;
    setTimeout(startWs, wsRetryMs);
    wsRetryMs = Math.min(wsRetryMs * 2, 30e3);
  };
  ws.on('close', bye);
  ws.on('error', () => { try { ws.close(); } catch { bye(); } });
}
const ensureSub = (sym) => {
  if (subbed.has(sym)) return;
  subbed.add(sym);
  if (wsRef?.readyState === WebSocket.OPEN)
    try { wsRef.send(JSON.stringify({ op: 'subscribe', args: [{ instType: PRODUCT, channel: 'ticker', instId: sym }] })); } catch {}
};
const pickMark = async (sym) => {
  const w = wsMarks.get(sym);
  if (w && Date.now() - w.at < 1500) {
    const r = restMarks.get(sym);
    if (!r || Date.now() - r.at > 30e3) { // keep the sanity anchor honest while ws feeds
      const p = await pubTicker(sym).catch(() => 0);
      if (p) restMarks.set(sym, { px: p, at: Date.now() });
    }
    return w.px;
  }
  const r = restMarks.get(sym);
  if (!r || Date.now() - r.at > 3500) { // ws dead/stale — REST fallback at the old cadence
    const p = await pubTicker(sym).catch(() => 0);
    if (p) restMarks.set(sym, { px: p, at: Date.now() });
  }
  return restMarks.get(sym)?.px || 0;
};

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = (o) => { try { fs.writeFileSync(STATE + '.tmp', JSON.stringify(o)); fs.renameSync(STATE + '.tmp', STATE); } catch {} };
// outbound alerts — tg-watch drains this JSONL into Saved Messages (~30s lag)
const OUTBOX = path.join(__dirname, '..', 'state', 'tg-outbox.jsonl');
const outbox = (text) => { try { fs.appendFileSync(OUTBOX, JSON.stringify({ ts: Date.now(), text }) + '\n'); } catch {} };
// proximity ladder — alert once per tier crossed downward; reset on recovery
const ALERT_TIERS = [4, 2.5, 1.5];

// per-position trigger memory, keyed `${sym}:${side}` — survives restarts
let gates = readState().gates || {};
const trims = readState().trims || [];
let posMode = 'oneway';
const cm = {}; // sym -> contract meta

let posCache = [], posCacheAt = 0, lastStateWrite = 0;
const anyNear = () =>
  posCache.some((p) => {
    const m = wsMarks.get(p.sym)?.px || restMarks.get(p.sym)?.px || 0;
    if (!m) return true; // unknown mark — stay awake
    const g = p.side === 'long' ? (m - p.liq) / p.liq * 100 : (p.liq - m) / p.liq * 100;
    return g <= NEAR_PCT;
  });

async function tick() {
  // position discovery cadence: 2.5s while anything is near danger, else 30s
  const wantMs = posCache.length && anyNear() ? 2500 : 30e3;
  if (Date.now() - posCacheAt > wantMs) {
    const p = await getAllPos().catch(() => null);
    if (p) { posCache = p; posCacheAt = Date.now(); p.forEach((x) => ensureSub(x.sym)); }
  }
  ensureSub(SEED_SYM);

  const stOut = { at: Date.now(), positions: {}, trims };
  let dirty = false;
  for (const p of posCache) {
    const key = `${p.sym}:${p.side}`;
    const mark = await pickMark(p.sym);
    if (!mark) continue;
    const distPct = p.side === 'long' ? (mark - p.liq) / p.liq * 100 : (p.liq - mark) / p.liq * 100;
    const g = (gates[key] ||= { lastTrim: 0, lastTrimMark: null });
    // proximity ladder: alert on each tier crossed downward, re-arm above 4.5%
    const sev = ALERT_TIERS.filter((t) => distPct <= t).length;
    if (sev > (g.tier || 0)) {
      g.tier = sev;
      outbox(`⚠️ LIQ PROXIMITY — ${p.sym} ${p.side} ${distPct.toFixed(2)}% from liquidation\nmark ${mark} · liq ${p.liq} · size ${p.size} · upl $${(+p.upl).toFixed(2)}`);
    } else if (distPct > ALERT_TIERS[0] + 0.5) g.tier = 0;
    stOut.positions[key] = { size: p.size, liq: p.liq, mark, distPct: +distPct.toFixed(3), lastTrim: g.lastTrim, lastTrimMark: g.lastTrimMark };
    if (distPct > ZONE_PCT) continue;                                   // outside danger zone — dormant
    if (Date.now() - g.lastTrim < SPACING_MS) continue;                 // serialization floor
    // deterioration gate: re-arm only when price prints worse than at the
    // last trim. Waterfall => clips every ~4s; hovering in-zone => zero.
    const worse = g.lastTrimMark == null || (p.side === 'long' ? mark < g.lastTrimMark : mark > g.lastTrimMark);
    if (!worse) continue;
    const c = cm[p.sym] || {};
    const minFloor = Math.max(
      +c.minTradeNum || 0,
      ((+c.minTradeUSDT || 5) * 3) / mark,
      p.sym === SEED_SYM ? MIN_SIZE : 0,
    );
    if (p.size <= minFloor) continue; // residual rides its stop — shavings are pointless here

    // FIRE PATH — re-verify on FRESH signed truth, never the cache
    const fresh = await getAllPos().catch(() => null);
    posCache = fresh || posCache; posCacheAt = Date.now();
    const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
    if (!fp?.liq) continue;
    const fdist = fp.side === 'long' ? (mark - fp.liq) / fp.liq * 100 : (fp.liq - mark) / fp.liq * 100;
    if (fdist > ZONE_PCT || fp.size <= minFloor) continue;  // bounced / shrank between checks — stand down
    const prec = Math.pow(10, +c.sizePlace || 0);
    const q = Math.floor((fp.size * TRIM_PCT) / 100 * prec) / prec;
    if (!(q > 0) || q >= fp.size) continue;                 // never let a 'partial' equal the whole side
    log(`DANGER: ${key} mark ${mark} is ${fdist.toFixed(2)}% from liq ${fp.liq} — trimming ${q} of ${fp.size}`);
    await closeMarket(p.sym, p.side, String(q), posMode);
    g.lastTrim = Date.now();
    g.lastTrimMark = mark;
    trims.push({ at: g.lastTrim, sym: p.sym, side: p.side, size: q, mark });
    dirty = true;
    outbox(`✂️ LIQ-GUARD TRIM — ${p.sym} ${p.side}: closed ${q} of ${fp.size} @ ${mark} (${fdist.toFixed(2)}% from liq). Re-arms on a new low.`);
    // reset the stop deeper into the widened band — place new, then cancel old
    try {
      const np = (await getAllPos().catch(() => []))?.find((x) => x.sym === p.sym && x.side === p.side);
      if (np?.liq) {
        const sgn = np.side === 'long' ? 1 : -1;
        const bandPct = Math.abs(np.entry - np.liq) / np.entry * 100;
        const trig = +(np.entry * (1 - (sgn * bandPct * 0.75) / 100)).toFixed(5);
        await planLoss(p.sym, p.side, trig);
        const plans = await getPlans(p.sym);
        for (const x of plans.filter((z) => /loss/i.test(z.planType || '') && +z.triggerPrice !== trig))
          await cancelPlan(p.sym, x.planType, x.orderId).catch(() => {});
        log(`${key} stop reset -> ${trig} (liq ${np.liq}, band ${bandPct.toFixed(2)}%)`);
      }
    } catch (e) { log(`${key} stop-reset failed (exec clamp covers): ${e.message}`); }
    log(`${key} trimmed ${q} @ ${mark} — re-arms on a new low (spacing floor ${SPACING_MS / 1e3}s)`);
  }
  // legacy top-level mirror of the seed symbol for older readers
  const seed = stOut.positions[`${SEED_SYM}:long`] || stOut.positions[`${SEED_SYM}:short`];
  if (seed) Object.assign(stOut, { lastLiq: seed.liq, size: seed.size, mark: seed.mark, distPct: seed.distPct, note: 'tracking' });
  if (Date.now() - lastStateWrite > 1000 || dirty) {
    lastStateWrite = Date.now();
    writeState({ ...stOut, gates });
  }
}

async function boot() {
  const cs = await api('GET', '/api/v2/mix/market/contracts', { qs: `productType=${PRODUCT}` }).catch(() => []);
  for (const c of cs || []) cm[c.symbol] = c;
  const acc = await api('GET', '/api/v2/mix/account/account', { qs: `symbol=${SEED_SYM}&productType=${PRODUCT}&marginCoin=${COIN}` }).catch(() => null);
  const pm = acc?.posMode === 'hedge_mode' ? 'hedge' : 'oneway';
  log(`armed — all positions · trim ${TRIM_PCT}% · zone ${ZONE_PCT}% · spacing ${SPACING_MS / 1e3}s + new-low gate · seed ${SEED_SYM} min ${MIN_SIZE} · posMode ${pm}`);
  return pm;
}

let busy = false; // setInterval doesn't await ticks — lock so a slow tick can't overlap the next
const loop = async () => {
  if (busy) return;
  busy = true;
  try { await tick(); } catch (e) { log('tick error:', e.message); } finally { busy = false; }
};
boot().then((pm) => { posMode = pm; startWs(); setInterval(loop, POLL_MS); loop(); });
