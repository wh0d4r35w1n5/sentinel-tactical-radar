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
import { integrityNote } from './crc32.mjs';

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
// stop-approach trims: before a position's own pos_loss can kill the WHOLE
// size, shave contract-minimum clips on new lows inside STOP_ZONE of the
// trigger and re-pin the stop deeper toward the liq edge — the position
// bleeds through the dip instead of stopping out all at once.
const STOP_TRIM = process.env.LIQ_GUARD_STOP_TRIM !== '0';
const STOP_ZONE = +(process.env.LIQ_GUARD_STOP_ZONE_PCT || 1.2); // % above stop = trim zone
const DEEPEN_BAND = +(process.env.LIQ_GUARD_DEEPEN_BAND || 0.9); // stop re-pinned at N% of liq band
// margin-loss circuit: pos_loss stops sit at ~60-80% of posted margin at
// these leverages — letting one fire delivers the whole -1R+ band as a
// tail loss (the epoch's three -$11/-$12/-$20 closes ARE the deficit).
// The floor closes at -(MAXLOSS_PCT x posted margin) — a defined ~-0.6R
// cut while the deep stop stays armed behind it as catastrophe backstop.
const MAXLOSS_PCT = +(process.env.LIQ_GUARD_MAXLOSS_PCT || 0.55);
// naked-position synthesis: an open book with NO pos_loss gets one pinned
// at the liq-band inner edge — same geometry as the deepen path.
const NAKED_SYNTH = process.env.LIQ_GUARD_NAKED_SYNTH !== '0';
const NAKED_COOLDOWN_MS = +(process.env.LIQ_GUARD_NAKED_COOLDOWN_MS || 60e3);
// rebuild gaps last seconds — nakedness must persist across guard cycles
// before it's real enough to write a plan over
const NAKED_CONFIRM_MS = +(process.env.LIQ_GUARD_NAKED_CONFIRM_MS || 9e3);
// stop-approach clips whose protective value (clipNotional x dist-to-stop)
// is under this are skipped — see the floor comment at the fire gate.
const DUST_USD = +(process.env.LIQ_GUARD_DUST_USD || 0.15);
const planCache = {}; // sym -> { at, rows } — plans change slowly, poll 20s
const STATE = path.join(__dirname, '..', 'state', 'liq-guard.json');
const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES', COIN = 'USDT';
const WS_URL = 'wss://ws.bitget.com/v2/ws/public';

// demo/paper mode: same SENTINEL_EXEC switch as the exec — the guard must
// watch the SAME account the engine trades, or demo positions run naked
// while the guard stares at an empty live book.
const MODE = (process.env.SENTINEL_EXEC || 'off').toLowerCase();
const DEMO = MODE === 'demo';
const KEY = DEMO ? (process.env.BITGET_DEMO_API_KEY || process.env.BITGET_API_KEY || '')
                 : (process.env.BITGET_API_KEY || '');
const SECRET = DEMO ? (process.env.BITGET_DEMO_API_SECRET || process.env.BITGET_API_SECRET || '')
                 : (process.env.BITGET_API_SECRET || '');
const PASS = DEMO ? (process.env.BITGET_DEMO_PASSPHRASE || process.env.BITGET_PASSPHRASE || '')
                 : (process.env.BITGET_PASSPHRASE || '');
const log = (...a) => console.log('[liq-guard]', ...a);

if (!ENABLED) { log('LIQ_GUARD not armed — exiting'); process.exit(0); }
if (!KEY || !SECRET || !PASS) { log('no creds — exiting'); process.exit(1); }

function hdr(method, reqPath, qs, body) {
  const ts = String(Date.now());
  const pre = ts + method + reqPath + (qs ? '?' + qs : '') + (body || '');
  const h = {
    'ACCESS-KEY': KEY,
    'ACCESS-SIGN': crypto.createHmac('sha256', SECRET).update(pre).digest('base64'),
    'ACCESS-PASSPHRASE': PASS,
    'ACCESS-TIMESTAMP': ts,
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
  if (DEMO) h.paptrading = '1'; // Bitget demo-trading header — same as exec
  return h;
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
    margin: +p.marginSize || 0,
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
// marginMode is mandatory — it must match the POSITION's real margin mode.
// Omitting it let Bitget default to 'isolated', which rejects with 40774 on
// crossed positions (the SNDKUSDT stop-trim failure this fixes) and silently
// invalidates the plan even when accepted (6 dead pos_loss plans proved it
// in exec). pos_loss covers the whole position — size stays omitted.
const planLoss = (sym, side, trigger, marginMode) =>
  api('POST', '/api/v2/mix/order/place-tpsl-order', {
    body: { symbol: sym, marginCoin: COIN, productType: PRODUCT, marginMode: marginMode === 'crossed' ? 'crossed' : 'isolated', planType: 'pos_loss', triggerPrice: String(trigger), holdSide: side, triggerType: 'mark_price', executePrice: '0' },
  });
const closeMarket = async (sym, side, sizeStr, posMode, marginMode) => {
  // the position's REAL margin mode — bot entries are isolated, manual
  // positions are usually crossed. A hardcoded mode gets the emergency
  // close rejected (40774) exactly when the guard exists to fire.
  const mm = marginMode === 'crossed' ? 'crossed' : 'isolated';
  const alt = mm === 'crossed' ? 'isolated' : 'crossed';
  const base = { symbol: sym, productType: PRODUCT, marginCoin: COIN, size: sizeStr, orderType: 'market' };
  // hedge-mode `side` is the POSITION direction: close long = buy+close.
  // (side:'sell' asks to close a short -> 22002 'No position to close')
  const hedgeBody = (m) => ({ ...base, side: side === 'long' ? 'buy' : 'sell', tradeSide: 'close', marginMode: m });
  const onewayBody = (m) => ({ ...base, side: side === 'long' ? 'sell' : 'buy', reduceOnly: 'YES', marginMode: m });
  // posMode detection can silently default wrong (a failed boot probe falls
  // back to 'oneway' forever — the SNDK/CLU 40774 loop was exactly that:
  // hedge account + reduceOnly). 40774 IS the mode mismatch signal, so try
  // the detected convention first, then the other — self-healing without
  // trusting the probe.
  const attempts = posMode === 'hedge'
    ? [hedgeBody(mm), hedgeBody(alt), onewayBody(mm), onewayBody(alt)]
    : [onewayBody(mm), onewayBody(alt), hedgeBody(mm), hedgeBody(alt)];
  let lastErr;
  for (const body of attempts) {
    try {
      return await api('POST', '/api/v2/mix/order/place-order', { body });
    } catch (e) {
      lastErr = e;
      // only a mode/margin mismatch justifies the next convention — a real
      // rejection (size, no-position) must surface, not be retried blind
      if (!/margin ?mode|40774/.test(e.message)) throw e;
    }
  }
  throw lastErr;
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
const API_STATE = path.join(__dirname, '..', 'api', 'liq-guard.json');
const writeState = (o) => {
  const body = JSON.stringify(o);
  try { fs.writeFileSync(STATE + '.tmp', body); fs.renameSync(STATE + '.tmp', STATE); integrityNote(STATE, body); } catch {}
  // publish to api/ too — the dashboard reads artifacts, not state/
  try { fs.writeFileSync(API_STATE, body); integrityNote(API_STATE, body); } catch {}
};
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
    if (!posModeConfirmed) posMode = await probePosMode();
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
    // new-arrival alert: a position the guard has never seen gets a
    // one-time "now watching" ping — silent arming meant the operator
    // couldn't tell a protected position from an untracked one.
    if (!g.seen) {
      g.seen = true; dirty = true;
      outbox(`👁 LIQ-GUARD armed — ${p.sym} ${p.side} ${p.size} @ ${p.entry} · ${distPct.toFixed(1)}% from liq ${p.liq} · ${p.marginMode || ''}`);
    }
    // proximity ladder: alert on each tier crossed downward, re-arm above 4.5%
    const sev = ALERT_TIERS.filter((t) => distPct <= t).length;
    if (sev > (g.tier || 0)) {
      // fresh-verify before raising the alarm — posCache can sit ~30s stale
      // when nothing is near danger, and a position the operator just closed
      // must not cry wolf. Fetch fails -> alert anyway on cached truth (a
      // network blip shouldn't silence a real proximity warning).
      const fresh = await getAllPos().catch(() => null);
      if (fresh) { posCache = fresh; posCacheAt = Date.now(); }
      const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
      const fpDist = fp ? (fp.side === 'long' ? (mark - fp.liq) / fp.liq * 100 : (fp.liq - mark) / fp.liq * 100) : null;
      if (!fresh || (fp && fpDist <= ALERT_TIERS[0])) {
        g.tier = sev;
        // boundary-flutter guard: hovering at a tier edge re-fires on every
        // re-cross — space repeats per position so Telegram stays signal,
        // not noise. A NEW deeper tier always fires immediately.
        if (Date.now() - (g.lastAlert || 0) >= 10 * 60e3 || sev > (g.lastAlertTier || 0)) {
          g.lastAlert = Date.now(); g.lastAlertTier = sev;
          const pv = fp || p, pd = fpDist ?? distPct;
          outbox(`⚠️ LIQ PROXIMITY — ${p.sym} ${p.side} ${pd.toFixed(2)}% from liquidation\nmark ${mark} · liq ${pv.liq} · size ${pv.size} · upl $${(+pv.upl).toFixed(2)}`);
        }
      }
    } else if (distPct > ALERT_TIERS[0] + 0.5) g.tier = 0;
    stOut.positions[key] = { size: p.size, liq: p.liq, mark, distPct: +distPct.toFixed(3), lastTrim: g.lastTrim, lastTrimMark: g.lastTrimMark };

    // ---- margin-loss circuit: close the whole position when mark-to-market
    // loss crosses -(MAXLOSS_PCT x posted margin). Fires BEFORE the deep
    // pos_loss band — converts tail stop-outs into bounded ~-0.6R losses.
    if (MAXLOSS_PCT > 0 && p.margin > 0 && p.upl <= -(MAXLOSS_PCT * p.margin)) {
      const fresh = await getAllPos().catch(() => null);
      const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
      if (fp && fp.margin > 0 && fp.upl <= -(MAXLOSS_PCT * fp.margin)) {
        const capUsd = (MAXLOSS_PCT * fp.margin).toFixed(2);
        try {
          await closeMarket(fp.sym, fp.side, String(fp.size), posMode, fp.marginMode);
          log(`LOSS-CAP ${key}: upl ${fp.upl.toFixed(2)} <= -${capUsd} (${(MAXLOSS_PCT * 100).toFixed(0)}% margin) — full close @ ${mark}`);
          outbox(`🛑 LOSS-CAP — ${fp.sym} ${fp.side}: upl $${fp.upl.toFixed(2)} breached -$${capUsd} floor (${(MAXLOSS_PCT * 100).toFixed(0)}% of margin). Full close @ ${mark} — bounded loss, not a band hit.`);
          g.capped = true; dirty = true;
        } catch (e) { log(`LOSS-CAP ${key} close failed: ${e.message}`); }
        continue; // position flat or closing — nothing below applies
      }
    }

    // ---- naked-stop synthesis: open position with no pos_loss gets one ----
    // Pinned at the liq-band inner edge (DEEPEN_BAND geometry — same place
    // the deepen path parks it). GOD flags naked books every cycle; the
    // flag doesn't move price, a plan does. 60s cooldown per symbol so a
    // rejected place can't spam the exchange.
    if (NAKED_SYNTH) {
      try {
        const pc = planCache[p.sym] || { at: 0, rows: [] };
        if (Date.now() - pc.at > 20000) { pc.rows = await getPlans(p.sym).catch(() => pc.rows); pc.at = Date.now(); planCache[p.sym] = pc; }
        let hasLoss = pc.rows.some((x) => /loss|stop|moving/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
        // false-naked guard: the exec's rebuild cancels plans then re-places
        // them over several seconds — a single read (cached OR fresh) can
        // land inside the teardown window. Nakedness is only real when it
        // persists across cycles (~9s > any rebuild); verify fresh each pass.
        if (!hasLoss) {
          const fresh = await getPlans(p.sym).catch(() => pc.rows);
          hasLoss = fresh.some((x) => /loss|stop|moving/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
        }
        if (hasLoss) g.nakedSeen = 0;
        const confirmedNaked = !hasLoss && (g.nakedSeen ? Date.now() - g.nakedSeen >= NAKED_CONFIRM_MS : (g.nakedSeen = Date.now(), false));
        if (confirmedNaked && p.liq > 0 && p.entry > 0 && Date.now() - (g.nakedAt || 0) >= NAKED_COOLDOWN_MS) {
          const sgn = p.side === 'long' ? 1 : -1;
          const bandPct = Math.abs(p.entry - p.liq) / p.entry * 100;
          const pxDec = +(cm[p.sym]?.pricePlace ?? 6); // parens: +x ?? 6 yields NaN on a contract-map miss
          const trig = +(p.entry * (1 - (sgn * bandPct * DEEPEN_BAND) / 100)).toFixed(pxDec);
          const sane = trig > 0 && (p.side === 'long' ? trig < mark : trig > mark);
          if (sane) {
            g.nakedAt = Date.now(); // cooldown even on success — no plan spam
            await planLoss(p.sym, p.side, trig, p.marginMode);
            pc.at = 0;
            log(`NAKED-FIX ${key}: synthesized pos_loss @ ${trig} (${bandPct.toFixed(2)}% band) — position had no stop`);
            outbox(`🩹 NAKED-FIX — ${p.sym} ${p.side} had NO stop plan. Synthesized pos_loss @ ${trig} (liq-band edge).`);
            dirty = true;
          }
        }
      } catch (e) { log(`${key} naked-synth error: ${e.message}`); }
    }

    // ---- stop-approach tier: mark nearing this position's OWN pos_loss —
    // clip the contract minimum on each new low and push the stop deeper
    // toward the liq edge. Minimum size, not percentage: the position sheds
    // risk gradually through the dip instead of dying whole at the trigger.
    if (STOP_TRIM) {
      try {
        const pc = planCache[p.sym] || { at: 0, rows: [] };
        if (Date.now() - pc.at > 20000) { pc.rows = await getPlans(p.sym).catch(() => pc.rows); pc.at = Date.now(); planCache[p.sym] = pc; }
        const loss = pc.rows.find((x) => /loss|stop|moving/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
        const trig = +loss?.triggerPrice || 0;
        const sDist = trig > 0 ? (p.side === 'long' ? (mark - trig) / trig * 100 : (trig - mark) / trig * 100) : null;
        if (sDist != null) stOut.positions[key].stopDist = +sDist.toFixed(3);
        const newLow = g.lastStopMark == null || (p.side === 'long' ? mark < g.lastStopMark : mark > g.lastStopMark);
        // sDist > 0.05 required — a mark already THROUGH the trigger means
        // the stop is mid-fire; clipping then races the exchange's close
        if (sDist != null && sDist > 0.05 && sDist <= STOP_ZONE && newLow && Date.now() - (g.lastStopTrim || 0) >= SPACING_MS) {
          // fresh-verify before firing — same discipline as the liq path
          const fresh = await getAllPos().catch(() => null);
          if (fresh) { posCache = fresh; posCacheAt = Date.now(); }
          const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
          const c = cm[p.sym] || {};
          const precN = Number.isFinite(+c.sizePlace) ? +c.sizePlace : (+c.volumePlace || 0);
          const prec = Math.pow(10, precN);
          // absolute-minimum clip: contract min, or the smallest $-sized
          // unit the exchange accepts — not a percentage of the position
          const minClip = Math.max(
            +c.minTradeNum || 0,
            Math.ceil(((+c.minTradeUSDT || 5) * 1.02) / mark * prec) / prec
          );
          // first clip of a zone-entry front-loads at 3× min (front-cut the
          // risk when it matters most); subsequent clips run at true minimum
          const clipMult = g.stopClipN ? 1 : 3;
          const q = Math.floor(minClip * clipMult * prec) / prec;
          // dust-close floor: a clip's protective value is roughly
          // clipNotional x distance-to-stop. Below ~$0.15 it saves pennies
          // but records a losing close and pays a fee — 42 such dust closes
          // this epoch cratered win-rate optics and padded the loss column.
          // Under the floor, the position just rides its stop (identical
          // worst case, cleaner tape). LIQ_GUARD_DUST_USD=0 disables.
          const clipValue = (q * mark * sDist) / 100;
          if (fp && fp.size > minClip && q > 0 && q < fp.size && clipValue >= DUST_USD) {
            await closeMarket(p.sym, p.side, String(q), posMode, fp.marginMode);
            g.lastStopTrim = Date.now(); g.lastStopMark = mark; g.stopClipN = (g.stopClipN || 0) + 1;
            trims.push({ at: g.lastStopTrim, sym: p.sym, side: p.side, size: q, mark, kind: 'stop-approach' });
            dirty = true;
            log(`STOP-TRIM ${key}: clipped ${q} of ${fp.size} @ ${mark} — ${sDist.toFixed(2)}% above stop ${trig}`);
            outbox(`✂️ STOP-TRIM — ${p.sym} ${p.side}: clipped ${q} of ${fp.size} @ ${mark} (${sDist.toFixed(2)}% above stop). Shedding, not dying.`);
            // deepen the stop toward the liq edge — place-first-then-cancel,
            // never naked; only ever moves the stop FURTHER from price
            try {
              const np = (await getAllPos().catch(() => []))?.find((x) => x.sym === p.sym && x.side === p.side);
              if (np?.liq) {
                const sgn = np.side === 'long' ? 1 : -1;
                const bandPct = Math.abs(np.entry - np.liq) / np.entry * 100;
                // trigger must land on the contract's price grid — a blanket
                // toFixed(6) violates checkBDScale (SNDK=2dp, CLU=3dp -> 40808)
                const pxDec = +(cm[p.sym]?.pricePlace ?? 6);
                const deepTrig = +(np.entry * (1 - (sgn * bandPct * DEEPEN_BAND) / 100)).toFixed(pxDec);
                // a stop past entry in the win direction is a profit lock —
                // the band edge is the LOSS side, so "deepening" would
                // release locked profit back to risk. Never touch those.
                const armedLossSide = np.side === 'long' ? trig < np.entry : trig > np.entry;
                const deeper = armedLossSide && (np.side === 'long' ? deepTrig < trig : deepTrig > trig);
                if (deeper && deepTrig > 0) {
                  await planLoss(p.sym, p.side, deepTrig, np.marginMode || p.marginMode);
                  // loss-SIDE plans only — a profit-side loss-typed plan
                  // (a lock) must never be stripped by the reset sweep
                  for (const x of (await getPlans(p.sym)).filter((z) => /loss/i.test(z.planType || '') && +z.triggerPrice !== deepTrig && (!z.holdSide || z.holdSide === p.side) && (np.side === 'long' ? +z.triggerPrice < np.entry : +z.triggerPrice > np.entry)))
                    await cancelPlan(p.sym, x.planType, x.orderId).catch(() => {});
                  pc.at = 0; // force plan refresh next tick
                  log(`${key} stop deepened -> ${deepTrig} (${bandPct.toFixed(2)}% band)`);
                }
              }
            } catch (e) { log(`${key} stop-deepen failed (stop still armed): ${e.message}`); }
          }
        } else if (sDist != null && sDist > STOP_ZONE + 0.8) {
          g.lastStopMark = null; g.stopClipN = 0; // recovered clear — re-arm gate and first-clip front-load
        }
      } catch (e) { log(`${key} stop-trim error: ${e.message}`); }
    }

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
    await closeMarket(p.sym, p.side, String(q), posMode, fp.marginMode);
    g.lastTrim = Date.now();
    g.lastTrimMark = mark;
    trims.push({ at: g.lastTrim, sym: p.sym, side: p.side, size: q, mark });
    if (trims.length > 200) trims.splice(0, trims.length - 200); // bounded history — state can't grow forever
    dirty = true;
    outbox(`✂️ LIQ-GUARD TRIM — ${p.sym} ${p.side}: closed ${q} of ${fp.size} @ ${mark} (${fdist.toFixed(2)}% from liq). Re-arms on a new low.`);
    // reset the stop deeper into the widened band — place new, then cancel old
    try {
      const np = (await getAllPos().catch(() => []))?.find((x) => x.sym === p.sym && x.side === p.side);
      if (np?.liq) {
        const sgn = np.side === 'long' ? 1 : -1;
        const bandPct = Math.abs(np.entry - np.liq) / np.entry * 100;
        const pxDec = +(cm[p.sym]?.pricePlace ?? 6);
        const trig = +(np.entry * (1 - (sgn * bandPct * 0.75) / 100)).toFixed(pxDec);
        await planLoss(p.sym, p.side, trig, np.marginMode || p.marginMode);
        const plans = await getPlans(p.sym);
        // holdSide filter is mandatory in hedge mode — an unfiltered cancel
        // would strip the OTHER side's stop while resetting this one. The
        // loss-side trigger test does the same for profit locks on THIS side.
        for (const x of plans.filter((z) => /loss/i.test(z.planType || '') && +z.triggerPrice !== trig && (!z.holdSide || z.holdSide === p.side) && (p.side === 'long' ? +z.triggerPrice < np.entry : +z.triggerPrice > np.entry)))
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

// posMode probe — a failed probe used to silently default 'oneway' forever,
// which fires 40774 on every trim of a hedge-mode account. The demo env
// lists a SUBSET of symbols — probing on the seed (HBARUSDT) 40034s there,
// so probe on a symbol the contract map actually contains. Retry at boot,
// and if still unknown mark it unconfirmed so tick() keeps re-probing.
let posModeConfirmed = false, probeLogged = false;
const probePosMode = async () => {
  const sym = cm[SEED_SYM] ? SEED_SYM : Object.keys(cm)[0] || SEED_SYM;
  const acc = await api('GET', '/api/v2/mix/account/account', { qs: `symbol=${sym}&productType=${PRODUCT}&marginCoin=${COIN}` })
    .catch((e) => { if (!probeLogged) { probeLogged = true; log(`posMode probe on ${sym}: ${e.message}`); } return null; });
  if (acc?.posMode) { posModeConfirmed = true; return acc.posMode === 'hedge_mode' ? 'hedge' : 'oneway'; }
  return posMode;
};

async function boot() {
  const cs = await api('GET', '/api/v2/mix/market/contracts', { qs: `productType=${PRODUCT}` }).catch(() => []);
  for (const c of cs || []) cm[c.symbol] = c;
  let pm = posMode;
  for (let i = 0; i < 3 && !posModeConfirmed; i++) {
    pm = await probePosMode();
    if (!posModeConfirmed) await new Promise((r) => setTimeout(r, 1500));
  }
  log(`armed — all positions · trim ${TRIM_PCT}% · zone ${ZONE_PCT}% · spacing ${SPACING_MS / 1e3}s + new-low gate · seed ${SEED_SYM} min ${MIN_SIZE} · posMode ${pm}${posModeConfirmed ? '' : ' (UNCONFIRMED — probing every cycle)'}`);
  return pm;
}

let busy = false; // setInterval doesn't await ticks — lock so a slow tick can't overlap the next
const loop = async () => {
  if (busy) return;
  busy = true;
  try { await tick(); } catch (e) { log('tick error:', e.message); } finally { busy = false; }
};
boot().then((pm) => { posMode = pm; startWs(); setInterval(loop, POLL_MS); loop(); });
