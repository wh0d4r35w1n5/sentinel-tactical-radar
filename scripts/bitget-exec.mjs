// Sentinel live executor — routes api/live-plan.json to Bitget USDT-M futures.
//
// MODES (env SENTINEL_EXEC):
//   off    — do nothing (default)
//   shadow — no keys needed: validates the plan, writes live-shadow.json with
//            the orders it WOULD place. Always safe, runs in CI for free.
//   demo   — Bitget demo trading (paptrading:1 header): real order flow,
//            fake funds. The calibration stage between shadow and live.
//   live   — real money. Requires SENTINEL_LIVE=1 AND CONFIRM_LIVE=YES plus
//            a TRADE-ONLY API key (withdrawals disabled at Bitget).
//
// Sizing: the plan carries paper-model notional ($10k equity). Live notional
// = planNotional × (realEquityUsd / 10000), clamped to LIVE_MAX_NOTIONAL_USD
// (default 50) — the engine's risk proportions scale to the real account.
//
// Failure discipline: if an entry fills but its TP/SL plan orders fail, the
// position is closed immediately — a naked position is a worse error than a
// missed trade. Stale plans (>ttlMs) are refused entirely.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(__dirname, '..', 'api');
// zero-dep .env loader — values only populate env vars not already set
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const HOST = 'https://api.bitget.com';
const PRODUCT = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';

const MODE = (process.env.SENTINEL_EXEC || 'off').toLowerCase();
// Bitget demo trading requires a SEPARATE key created inside demo mode —
// a live key + paptrading header gets 40099 "environment incorrect".
// Demo mode reads BITGET_DEMO_*; falls back to the main set if absent.
const KEY = MODE === 'demo'
  ? (process.env.BITGET_DEMO_API_KEY || process.env.BITGET_API_KEY || '')
  : (process.env.BITGET_API_KEY || '');
const SECRET = MODE === 'demo'
  ? (process.env.BITGET_DEMO_API_SECRET || process.env.BITGET_API_SECRET || '')
  : (process.env.BITGET_API_SECRET || '');
const PASS = MODE === 'demo'
  ? (process.env.BITGET_DEMO_PASSPHRASE || process.env.BITGET_PASSPHRASE || '')
  : (process.env.BITGET_PASSPHRASE || '');
const LIVE_ARMED =
  process.env.SENTINEL_LIVE === '1' && process.env.CONFIRM_LIVE === 'YES';
const MAX_NOTIONAL = +(process.env.LIVE_MAX_NOTIONAL_USD || 50);
const MAX_POSITIONS = +(process.env.LIVE_MAX_POSITIONS || 3);
// dust-account mode: when scaled notional lands under the contract minimum,
// floor up to the exchange minimum instead of skipping — for tiny real
// accounts proving the pipeline. Requires LIVE_FLOOR_MIN=1; never default.
const FLOOR_MIN = process.env.LIVE_FLOOR_MIN === '1';
const PAPER_EQUITY = 10000; // plan notional is denominated in the $10k model

const log = (...a) => console.log('[exec]', ...a);
const round = (x, p = 6) => +(+x).toFixed(p);

// ---------- signed REST ----------
function signHeaders(method, reqPath, qs, bodyStr) {
  const ts = String(Date.now());
  const pre = ts + method.toUpperCase() + reqPath + (qs ? '?' + qs : '') + (bodyStr || '');
  const sign = crypto.createHmac('sha256', SECRET).update(pre).digest('base64');
  const h = {
    'ACCESS-KEY': KEY,
    'ACCESS-SIGN': sign,
    'ACCESS-PASSPHRASE': PASS,
    'ACCESS-TIMESTAMP': ts,
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
  if (MODE === 'demo') h.paptrading = '1'; // Bitget demo-trading header
  return h;
}
async function api(method, reqPath, { qs = '', body = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
    method,
    headers: signHeaders(method, reqPath, qs, bodyStr),
    body: bodyStr || undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && j.code !== '00000'))
    throw new Error(`${reqPath} ${method} -> ${j.code || res.status} ${j.msg || ''}`);
  return j.data;
}
const getPos = () =>
  api('GET', '/api/v2/mix/position/all-position', {
    qs: `productType=${PRODUCT}&marginCoin=${MARGIN_COIN}`,
  });
const getEquity = async () => {
  const rows = await api('GET', '/api/v2/mix/account/accounts', {
    qs: `productType=${PRODUCT}`,
  });
  const acc = (rows || []).find((a) => a.marginCoin === MARGIN_COIN) || {};
  return +(acc.usdtEquity ?? acc.equity ?? acc.available ?? 0);
};
// pending-plan query REQUIRES planType — 'profit_loss' is the umbrella that
// covers profit_plan/loss_plan/moving_plan/pos_profit/pos_loss
const getPlans = (symbol) =>
  api('GET', '/api/v2/mix/order/orders-plan-pending', {
    qs: `symbol=${symbol}&productType=${PRODUCT}&marginCoin=${MARGIN_COIN}&planType=profit_loss`,
  }).then((d) => {
    const l = d?.entrustedList || d?.orders || d;
    return Array.isArray(l) ? l : []; // never hand callers a non-array
  });
// position mode is account-wide per product type: one_way_mode needs
// reduceOnly closes; hedge_mode needs tradeSide. Passing the wrong
// convention errors (40774) — or worse, silently opens a reverse position
// instead of closing. Detect it once per run, never assume.
const getPosMode = (symbol) =>
  api('GET', '/api/v2/mix/account/account', {
    qs: `symbol=${symbol}&productType=${PRODUCT}&marginCoin=${MARGIN_COIN}`,
  }).then((d) => (d?.posMode === 'hedge_mode' ? 'hedge' : 'oneway'));

// ---------- order placement ----------
const setIsolated = (symbol) =>
  api('POST', '/api/v2/mix/account/set-margin-mode', {
    body: { symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, marginMode: 'isolated' },
  }).catch(() => {}); // already-isolated errors are harmless
const setLeverage = (symbol, leverage) =>
  api('POST', '/api/v2/mix/account/set-leverage', {
    body: { symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, leverage: String(leverage) },
  });
let POS_MODE = 'oneway'; // set by getPosMode before any order is placed
const marketOrder = (symbol, side, size, intent, extra = {}) =>
  api('POST', '/api/v2/mix/order/place-order', {
    body: {
      symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MARGIN_COIN,
      size: String(size), side, orderType: 'market',
      ...(intent === 'close'
        ? POS_MODE === 'hedge'
          ? { tradeSide: 'close' }
          : { reduceOnly: 'YES' }
        : POS_MODE === 'hedge'
          ? { tradeSide: 'open' }
          : {}),
      ...extra,
    },
  });
// TP/SL plans go through place-tpsl-order — profit_plan/loss_plan are
// illegal on place-plan-order (that endpoint is for trigger/moving orders).
// holdSide identifies the protected side; no side/orderType needed.
const planOrder = (symbol, planType, triggerPrice, size, holdSide) =>
  api('POST', '/api/v2/mix/order/place-tpsl-order', {
    body: {
      symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MARGIN_COIN,
      planType, triggerPrice: String(triggerPrice), executePrice: '0',
      triggerType: 'mark_price', size: String(size), holdSide,
    },
  });
// full-position close — dedicated endpoint, works in both position modes
// (place-order close got 22002 on hedge mode even with holdSide)
const closePosition = (symbol, holdSide) =>
  api('POST', '/api/v2/mix/order/close-positions', {
    body: { symbol, productType: PRODUCT, holdSide },
  });
// cancel-plan-order requires the SPECIFIC planType (loss_plan, profit_plan,
// pos_profit...) — 'profit_loss' is a query-only umbrella; sending it makes
// the cancel silently no-op (returns 00000, cancels nothing).
const cancelPlanOrders = (symbol, planType, orderIds) =>
  api('POST', '/api/v2/mix/order/cancel-plan-order', {
    body: {
      symbol, productType: PRODUCT, marginCoin: MARGIN_COIN,
      planType, orderIdList: orderIds.map((id) => ({ orderId: id })),
    },
  });
const cancelByType = async (symbol, pred) => {
  const plans = await getPlans(symbol).catch(() => []);
  const byType = {};
  for (const p of plans || [])
    if (p.orderId && p.planType && pred(p)) (byType[p.planType] ??= []).push(p.orderId);
  let n = 0;
  for (const [pt, ids] of Object.entries(byType)) {
    await cancelPlanOrders(symbol, pt, ids).catch(() => {});
    n += ids.length;
  }
  return n;
};
const cancelPlans = (symbol) => cancelByType(symbol, () => true);
// cancel ONLY loss plans — a blanket cancel was wiping the TP ladder off
// the exchange every time a trail ratcheted
const cancelLossPlans = (symbol) =>
  cancelByType(symbol, (p) => (p.planType || '').includes('loss') || (p.planType || '').includes('stop'));

// ---------- contracts: size rounding + minimums ----------
async function contractMap() {
  // the demo environment lists a SUBSET of the live catalog (45 vs 805
  // symbols) — fetching the live list unsigned would size orders for
  // symbols this environment can't route (40805/40034 on every attempt)
  const res = await fetch(
    `${HOST}/api/v2/mix/market/contracts?productType=${PRODUCT}`,
    { headers: MODE === 'demo' ? { paptrading: '1' } : {} }
  );
  if (!res.ok) throw new Error(`contracts fetch -> HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j.data) || !j.data.length)
    throw new Error(`contracts map empty (${j.code || res.status}) — refusing to size blind`);
  const m = {};
  for (const c of j.data || [])
    m[c.symbol] = {
      sizePlace: +c.volumePlace || 0, // volume rounding — field is volumePlace, NOT sizePlace
      pricePlace: +c.pricePlace ?? 6, // trigger/execute price precision (XRP=4, BTC=1, ...)
      minTradeNum: +c.minTradeNum || 0,
      minTradeUSDT: +c.minTradeUSDT || 0,
    };
  return m;
}
const sizeFor = (cm, symbol, notionalUsd, price) => {
  const c = cm[symbol];
  if (!c) return null;
  let size = notionalUsd / price;
  const p = Math.pow(10, c.sizePlace);
  size = Math.floor(size * p) / p;
  const minSize = Math.max(c.minTradeNum, c.minTradeUSDT / price);
  return size >= minSize ? size : null;
};

// ---------- main ----------
async function main() {
  const planPath = path.join(API_DIR, 'live-plan.json');
  const outPath = path.join(API_DIR, 'live-ledger.json');
  const state = { mode: MODE, refreshedAt: new Date().toISOString(), actions: [], errors: [] };
  // untradeable symbols persist across runs — the scanner blocks entries on
  // them, so the executor never re-attempts and never re-fails. Without the
  // merge the block would flap off every other cycle. Authoritative store is
  // exec-catalog.json (survives ledger rewrites); live-ledger kept in sync
  // for the dashboard.
  const catPath = path.join(API_DIR, 'exec-catalog.json');
  try {
    for (const f of [outPath, catPath]) {
      const prior = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (prior.mode === MODE && prior.untradeable?.length)
        state.untradeable = [...new Set([...(state.untradeable || []), ...prior.untradeable])];
    }
  } catch {}
  if (MODE === 'off') {
    log('mode=off — set SENTINEL_EXEC=shadow|demo|live');
    return;
  }
  let plan = null;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    if (MODE !== 'off') {
      state.errors.push(`live-plan.json unreadable: ${e.message}`);
      fs.writeFileSync(outPath, JSON.stringify(state));
    }
    log('no readable plan — nothing to route');
    return;
  }
  plan.orders = Array.isArray(plan.orders) ? plan.orders : [];
  plan.closes = Array.isArray(plan.closes) ? plan.closes : [];
  plan.trails = Array.isArray(plan.trails) ? plan.trails : [];
  const stale = !Number.isFinite(plan.ts) || Date.now() - plan.ts > (plan.ttlMs || 900e3);

  if (stale) {
    state.errors.push(`plan stale (${Math.round((Date.now() - plan.ts) / 6e4)}min > ${(plan.ttlMs / 6e4)|0}min) — refused`);
    fs.writeFileSync(outPath, JSON.stringify(state));
    log('stale plan — refused to route old prices');
    return;
  }
  if (MODE === 'shadow') {
    fs.writeFileSync(
      path.join(API_DIR, 'live-shadow.json'),
      JSON.stringify({ ...state, plan, note: 'would execute exactly this — no keys needed, nothing sent' })
    );
    log(`shadow: ${plan.orders.length} orders / ${plan.closes.length} closes / ${plan.trails.length} trail amends`);
    const bad = plan.orders.filter((o) => !o.symbol || !Number.isFinite(o.refEntry) || !Number.isFinite(o.notionalUsd) || !Number.isFinite(o.stopPct) || !Number.isFinite(o.targetPct) || !o.direction || !o.leverage);
    if (bad.length) log(`shadow WARNING: ${bad.length} orders missing required fields — executor would refuse them live`);
    return;
  }
  // mode whitelist — anything that isn't demo/live must never reach a
  // signed endpoint. A typo'd SENTINEL_EXEC would otherwise bypass the
  // live-arming gate entirely.
  if (MODE !== 'demo' && MODE !== 'live') {
    state.errors.push(`unknown SENTINEL_EXEC="${MODE}" — refusing (off|shadow|demo|live)`);
    fs.writeFileSync(outPath, JSON.stringify(state));
    log('unknown mode — refusing');
    return;
  }
  if (!KEY || !SECRET || !PASS) {
    state.errors.push('missing BITGET_API_KEY/SECRET/PASSPHRASE');
    fs.writeFileSync(outPath, JSON.stringify(state));
    log('no credentials — set env keys');
    return;
  }
  if (MODE === 'live' && !LIVE_ARMED) {
    state.errors.push('live requires SENTINEL_LIVE=1 AND CONFIRM_LIVE=YES');
    fs.writeFileSync(outPath, JSON.stringify(state));
    log('live mode not armed — refusing');
    return;
  }

  const cm = await contractMap();
  // persist the environment catalog + runtime rejections as a sidecar — the
  // scanner gates entries on this so it never simulates positions the active
  // environment can never hold (demo lists ~45 symbols vs live's ~800)
  try {
    fs.writeFileSync(catPath, JSON.stringify({
      mode: MODE, at: new Date().toISOString(),
      symbols: Object.keys(cm),
      untradeable: state.untradeable || [],
    }));
  } catch {}
  // probe posMode on a symbol guaranteed to exist — a bad first plan symbol
  // would otherwise fail the probe and refuse the entire run
  const probeSym = 'BTCUSDT';
  const [positions, equityUsd] = await Promise.all([
    getPos().catch((e) => (state.errors.push('positions: ' + e.message), [])),
    getEquity().catch(() => 0),
    getPosMode(probeSym)
      .then((m) => { POS_MODE = m; })
      .catch((e) => state.errors.push('posMode detect failed — fail-closed: ' + e.message)),
  ]);
  if (state.errors.some((e) => e.startsWith('posMode'))) {
    fs.writeFileSync(outPath, JSON.stringify(state));
    log('cannot determine position mode — refusing to guess close semantics');
    return;
  }
  const scale = equityUsd > 0 ? Math.min(1, equityUsd / PAPER_EQUITY) : 0;
  state.equityUsd = round(equityUsd, 2);
  state.posMode = POS_MODE;
  const rawPos = (positions || []).filter((p) => +p.total > 0);
  state.positions = rawPos.map((p) => ({
    symbol: p.symbol, side: p.holdSide, size: +p.total,
    entry: +p.openPriceAvg, upl: +p.unrealizedPL, lev: +p.leverage,
    marginMode: p.marginMode,
  }));
  // hedge-mode accounts can hold both directions on one symbol — a
  // symbol-keyed map would silently pick one and close the wrong side
  const ambiguous = new Set();
  for (const p of rawPos) {
    if (rawPos.some((q) => q.symbol === p.symbol && q.holdSide !== p.holdSide)) ambiguous.add(p.symbol);
  }
  const posBySym = new Map();
  for (const p of state.positions) {
    if (ambiguous.has(p.symbol)) continue;
    posBySym.set(p.symbol, p);
  }
  for (const s of ambiguous) state.errors.push(`${s}: both long AND short open — refusing to guess, close manually`);
  log(`${MODE}: equity $${equityUsd.toFixed(2)} | ${state.positions.length} open | scale ${scale.toFixed(3)}`);

  // ---- closes first: freeing margin and killing contradicted exposure is
  // always the priority ----
  for (const c of plan.closes) {
    const pos = posBySym.get(c.symbol);
    if (!pos) continue;
    try {
      await cancelPlans(c.symbol);
      await closePosition(c.symbol, pos.side);
      state.actions.push(`closed ${c.symbol} ${pos.side} ${pos.size}`);
      posBySym.delete(c.symbol);
    } catch (e) {
      // already flat / position gone — the sim's own exit path (stop, TP,
      // expiry) fired first; a close for a missing position is convergence
      // confirmed, not an error
      if (/22002|no position|not exist|40034/i.test(e.message))
        state.actions.push(`close ${c.symbol}: already flat`);
      else state.errors.push(`close ${c.symbol}: ${e.message}`);
    }
  }

  // ---- trail amends: cancel+replace the loss plan at the ratcheted level ----
  for (const t of plan.trails) {
    const pos = posBySym.get(t.symbol);
    if (!pos || !Number.isFinite(t.entry) || !Number.isFinite(t.stopPctFromEntry)) continue;
    // anchor the stop % to the exchange's actual fill, not the sim's entry —
    // a stop computed off a stale sim reference sits at the wrong price
    const anchor = pos.entry > 0 ? pos.entry : t.entry;
    const px = anchor * (1 + (t.direction === 'LONG' ? 1 : -1) * (t.stopPctFromEntry / 100));
    try {
      await cancelLossPlans(t.symbol); // loss plans only — the TP ladder stays
      // verify the old stops actually died — cancel returns 00000 even on a
      // silent no-op, and a leftover stop means a double-stopped position.
      // no .catch here: if we can't verify, we don't stack a new stop on top
      const leftover = (await getPlans(t.symbol))
        .filter((p) => (p.planType || '').includes('loss') || (p.planType || '').includes('stop'));
      if (leftover.length) throw new Error(`${leftover.length} stale loss plan(s) survived cancel — refusing to stack another`);
      // position total can carry more decimals than the contract accepts —
      // floor to volume precision or the replacement stop errors out and
      // the position sits at its old stop while we believe it trailed
      const tp2 = Math.pow(10, cm[t.symbol]?.sizePlace ?? 4);
      const trailSize = Math.floor(pos.size * tp2) / tp2;
      await planOrder(t.symbol, 'loss_plan', round(px, cm[t.symbol]?.pricePlace ?? 6), trailSize, pos.side);
      state.actions.push(`trailed ${t.symbol} stop -> ${round(px, 6)}`);
    } catch (e) {
      state.errors.push(`trail ${t.symbol}: ${e.message}`);
    }
  }

  // ---- entries: only when the kill-switch is clear and capacity allows ----
  if (plan.killSwitch) {
    state.actions.push('kill-switch active — no new entries');
  } else {
    let opened = 0;
    for (const o of plan.orders) {
      // ambiguous symbols are excluded from posBySym — a .has() check would
      // pass and stack a third order on a symbol already holding both sides
      if (posBySym.has(o.symbol) || ambiguous.has(o.symbol) || opened + posBySym.size >= MAX_POSITIONS) continue;
      if (!Number.isFinite(o.refEntry) || !Number.isFinite(o.notionalUsd) ||
          !Number.isFinite(o.stopPct) || !Number.isFinite(o.targetPct) ||
          !Number.isFinite(o.leverage) || (o.direction !== 'LONG' && o.direction !== 'SHORT')) {
        state.errors.push(`${o.symbol || '?'}: malformed order fields — skipped`);
        continue;
      }
      const notional = Math.min(o.notionalUsd * scale, MAX_NOTIONAL);
      // not in this environment's catalog = unroutable here — record it so
      // the scanner stops emitting entries the executor can never fill
      if (!cm[o.symbol]) {
        state.untradeable = [...new Set([...(state.untradeable || []), o.symbol])];
        state.errors.push(`${o.symbol}: absent from ${MODE} contract catalog — unroutable`);
        continue;
      }
      let size = sizeFor(cm, o.symbol, notional, o.refEntry);
      if (!size && FLOOR_MIN) {
        // floor to the contract minimum — but only if the margin needed
        // (notional/leverage) leaves >20% of equity free afterwards
        const c = cm[o.symbol];
        const minQty = Math.max(c.minTradeNum, c.minTradeUSDT / o.refEntry);
        const minNotional = minQty * o.refEntry;
        const marginNeeded = minNotional / o.leverage;
        if (marginNeeded <= equityUsd * 0.8) {
          const p = Math.pow(10, c.sizePlace);
          size = Math.ceil(minQty * p) / p; // round UP to clear the minimum
          state.actions.push(`${o.symbol}: scaled size below min — floored to contract minimum $${round(minNotional, 2)} notional`);
        }
      }
      if (!size) { state.errors.push(`${o.symbol}: size below contract minimum`); continue; }
      const sgn = o.direction === 'LONG' ? 1 : -1;
      const holdSide = o.direction === 'LONG' ? 'long' : 'short';
      const coid = `s${plan.ts}${o.symbol}`.slice(0, 38);
      try {
        await setIsolated(o.symbol);
        await setLeverage(o.symbol, o.leverage);
        await marketOrder(o.symbol, sgn > 0 ? 'buy' : 'sell', size, 'open', { clientOid: coid });
        // protective levels anchor to the ACTUAL fill, not the plan's ref
        // price — market orders slip, and a stop quoted off an unfilled
        // reference can sit on the wrong side of price
        let fill = o.refEntry;
        try {
          const pp = (await getPos()).find((x) => x.symbol === o.symbol && +x.total > 0);
          if (pp && +pp.openPriceAvg > 0) fill = +pp.openPriceAvg;
        } catch {}
        // TP ladder: 30/30/25% at 40/70/100% of target; loss plan covers the
        // FULL size (Bitget nets it as rungs fill). Rungs round DOWN to
        // contract precision — a rung too small to exist merges into the SL.
        const cp = Math.pow(10, cm[o.symbol]?.sizePlace ?? 4);
        const pp = cm[o.symbol]?.pricePlace ?? 6;
        // rungs below the contract minimum get rejected by the exchange —
        // which would trigger the emergency close on a good position.
        // A sub-minimum rung merges into the SL instead of erroring.
        const minQty = Math.max(
          cm[o.symbol]?.minTradeNum ?? 0,
          (cm[o.symbol]?.minTradeUSDT ?? 0) / fill
        );
        const tpPlans = (o.tps || []).map((tp) => {
          const rung = Math.floor(size * tp.frac * cp) / cp;
          return rung >= minQty && rung > 0
            ? planOrder(o.symbol, 'profit_plan', round(fill * (1 + sgn * tp.at * (o.targetPct / 100)), pp), rung, holdSide)
            : null;
        }).filter(Boolean);
        const slPlan = planOrder(
          o.symbol, 'loss_plan',
          round(fill * (1 - sgn * (o.stopPct / 100)), pp),
          size, holdSide
        );
        await Promise.all([...tpPlans, slPlan]);
        state.actions.push(`opened ${o.symbol} ${o.direction} ${size} @~${round(fill, 6)} lev ${o.leverage}x notional $${round(size * fill, 2)}`);
        opened++;
      } catch (e) {
        // unroutable symbols get recorded so the scanner stops emitting
        // entries the exchange can't hold: 40805 'Unsupported operation'
        // (RWA perps listed but not orderable) and 40034 'does not exist'
        // (sim priced an asset that has no futures contract — PAXGUSDT)
        if (/40805|40034|unsupported|does not exist/i.test(e.message)) {
          state.untradeable = [...new Set([...(state.untradeable || []), o.symbol])];
        }
        // entry filled but protection failed -> close immediately, never naked
        state.errors.push(`open ${o.symbol}: ${e.message} — attempting emergency close`);
        try {
          const p = posBySym.get(o.symbol) || (await getPos()).find((x) => x.symbol === o.symbol && +x.total > 0);
          if (p) {
            await cancelPlans(o.symbol);
            await closePosition(o.symbol, p.holdSide || p.side);
            state.actions.push(`emergency-closed ${o.symbol} (protection failed)`);
          }
        } catch (e2) {
          state.errors.push(`EMERGENCY CLOSE FAILED ${o.symbol}: ${e2.message}`);
        }
      }
    }
  }

  // final position snapshot — exchange state is the ledger's ground truth
  try {
    const pos2 = await getPos();
    state.positionsAfter = (pos2 || [])
      .filter((p) => +p.total > 0)
      .map((p) => ({ symbol: p.symbol, side: p.holdSide, size: +p.total, upl: +p.unrealizedPL }));
  } catch {}
  // dump pending protection plans per open symbol — the god.mjs overseer
  // audits these to prove no position is ever naked on the exchange
  try {
    state.plans = {};
    for (const p of state.positionsAfter || []) {
      state.plans[p.symbol] = (await getPlans(p.symbol).catch(() => []))
        .map((x) => ({ planType: x.planType, triggerPrice: +x.triggerPrice, size: +x.size, holdSide: x.holdSide }));
    }
  } catch {}
  fs.writeFileSync(outPath, JSON.stringify(state));
  log(`done — ${state.actions.length} actions, ${state.errors.length} errors`);
  if (state.errors.length) console.log(state.errors.join('\n'));
}

main().catch((e) => {
  console.error('[exec] fatal:', e.message);
  process.exitCode = 1;
});
