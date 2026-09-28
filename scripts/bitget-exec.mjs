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
// Sizing (mandate): deploy ALL free margin evenly across the target slots —
// LIVE_TARGET_POSITIONS (default 4) gives ~25% of balance per trade, up to
// LIVE_MAX_POSITIONS (default 10) concurrent. Leverage = contract maxLever
// bounded by the liquidation band (lev <= 80/(stopPct+0.64)) so the stop
// always fires before liquidation. Exits run a staggered TP ladder
// (40/30/15 banks at 0.55x/1.0x/runnerMult of target) with the ~15% moon
// bag left unplanned to ride a trailing stop; the stop ratchets up as each
// bank level approaches. Positions missing protection legs get them
// repaired; positions exceeding their slot margin get partially closed to
// free balance for the other slots.
//
// Failure discipline: if an entry fills but its TP/SL plan orders fail, the
// position is closed immediately — a naked position is a worse error than a
// missed trade. Stale plans (>ttlMs) are refused entirely.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-env.mjs'; // canonical .env loader (audit F2) — every env-reading script imports this

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(__dirname, '..', 'api');
// atomic artifact writes — a mid-write kill must never leave a truncated
// live-ledger.json (god audits it; the scanner's heat math reads it)
const writeJson = (file, obj) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
};

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
// SENTINEL_RISK_PROFILE=max: maximum aggression — kill-switch at 35% DD and
// daily halt at 25% (defaults 8/6). Below those floors the book still stands
// down — a wipeout spiral isn't risk, it's the end of the book.
const RISK_MAX = process.env.SENTINEL_RISK_PROFILE === 'max';
const MAX_POSITIONS = +(process.env.LIVE_MAX_POSITIONS || (RISK_MAX ? 12 : 10));
const TARGET_POSITIONS = +(process.env.LIVE_TARGET_POSITIONS || 4);
const DD_KILL = +(process.env.SENTINEL_DD_KILL_PCT || (RISK_MAX ? 35 : 8));
// EXEC_EARLY_CUTS — the verdict-ladder time/redness cuts ('scalp-timeout').
// Operator mandate: positions exit via exchange TP/SL or manual flatten ONLY
// — early closes pay a taker fee to second-guess a bounded plan. Set '1' to
// re-enable the TrendRider time-cut mechanics.
const EARLY_CUTS = process.env.EXEC_EARLY_CUTS === '1';
// dust-floor for synthesized TP ladders — a tranche under this notional costs
// more in fee friction than the level is worth (audit F3: HBAR was churning
// $5-28 fills). Legs below the floor fold into the moon bag.
const MIN_TRANCHE_USD = +(process.env.EXEC_MIN_TRANCHE_USD || 25);
const DAILY_HALT = +(process.env.SENTINEL_DAILY_HALT_PCT || (RISK_MAX ? 25 : 6));
// dust-account mode: when scaled notional lands under the contract minimum,
// floor up to the exchange minimum instead of skipping — for tiny real
// accounts proving the pipeline. Requires LIVE_FLOOR_MIN=1; never default.
const FLOOR_MIN = process.env.LIVE_FLOOR_MIN === '1';
// user mandate: longs only — SENTINEL_LONG_ONLY=1 refuses every SHORT order
// at routing time (defense-in-depth under the scanner's shorts-banned gate).
const LONG_ONLY = process.env.SENTINEL_LONG_ONLY === '1';
// idempotent-order window: a signal that already produced an entry attempt
// inside this horizon is a replay, not a new opportunity — skip it.
const ENTRY_DEDUP_MS = +(process.env.SENTINEL_ENTRY_DEDUP_MS || 10 * 60e3);
// min-hold on scanner-driven closes: a managed position younger than this
// can't be closed by plan emissions — exchange-side SL/TP still fire.
const MIN_HOLD_MS = +(process.env.SENTINEL_MIN_HOLD_MS || 10 * 60e3);
// manually-placed positions the executor must NOT auto-manage — no
// rebalance, decay, flip, or scalp-timeout exits. Exchange-side TP/SL
// still protect them; the ledger still reports them.
const MANUAL = new Set(
  (process.env.SENTINEL_MANUAL_HOLD || '').split(',').map((s) => s.trim()).filter(Boolean)
);
const PAPER_EQUITY = 10000; // plan notional is denominated in the $10k model
// core-carry: dead capital is dead capital. When the signal queue leaves
// free margin above the floor, deploy the remainder into a protected
// low-lev LONG on a liquid major — a carry position with its own TP/SL,
// not an idle balance. Capped gearing (default 8x) on purpose: the core
// exists to hold exposure, not to gamble the book.
const CORE_LEV = +(process.env.SENTINEL_CORE_LEV || 8);
const CORE_FLOOR_PCT = +(process.env.SENTINEL_CORE_FLOOR_PCT || 0.15);
const CORE_FLOOR_USD = +(process.env.SENTINEL_CORE_FLOOR_USD || 8);
const CORE_STOP_PCT = +(process.env.SENTINEL_CORE_STOP_PCT || 3);
const CORE_TARGET_PCT = +(process.env.SENTINEL_CORE_TARGET_PCT || 5.5);
const CORE_SYMS = (process.env.SENTINEL_CORE_SYMS || 'ETHUSDT,BTCUSDT')
  .split(',').map((x) => x.trim()).filter(Boolean);

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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
        method,
        headers: signHeaders(method, reqPath, qs, bodyStr),
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(15000), // a hung call must not stall the cycle
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || (j.code && j.code !== '00000'))
        throw new Error(`${reqPath} ${method} -> ${j.code || res.status} ${j.msg || ''}`);
      return j.data;
    } catch (e) {
      // retry only transport failures on GETs — API rejections carry the
      // '->' marker, and a retried POST could double-fill an order that
      // actually executed before its response was lost
      if (attempt === 1 || e.message.includes('->') || method !== 'GET') throw e;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}
const getPos = () =>
  api('GET', '/api/v2/mix/position/all-position', {
    qs: `productType=${PRODUCT}&marginCoin=${MARGIN_COIN}`,
  });
const getAccount = async () => {
  const rows = await api('GET', '/api/v2/mix/account/accounts', {
    qs: `productType=${PRODUCT}`,
  });
  const acc = (rows || []).find((a) => a.marginCoin === MARGIN_COIN) || {};
  return {
    equity: +(acc.usdtEquity ?? acc.equity ?? acc.available ?? 0),
    available: +(acc.available ?? acc.usdtEquity ?? 0),
  };
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
// EXEC_MAKER_ENTRIES (default ON — fee mandate: save max on fees). Entries
// route through a post-only limit at touch when the book allows (maker
// ~0.02% vs taker ~0.06%); an unfilled/rejected attempt falls back to market
// for the REMAINDER — a certified entry is never sacrificed for a bp.
const MAKER_ENTRIES = process.env.EXEC_MAKER_ENTRIES !== '0';
const limitOrder = (symbol, side, size, price, extra = {}) =>
  api('POST', '/api/v2/mix/order/place-order', {
    body: {
      symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MARGIN_COIN,
      size: String(size), side, orderType: 'limit', price: String(price),
      timeInForceValue: 'post_only',
      ...(POS_MODE === 'hedge' ? { tradeSide: 'open' } : {}),
      ...extra,
    },
  });
const pendingOrders = (symbol) =>
  api('GET', '/api/v2/mix/order/orders-pending', { qs: `symbol=${symbol}&productType=${PRODUCT}` })
    .then((d) => { const l = d?.orders || d?.entrustedList || d; return Array.isArray(l) ? l : []; });
// TP/SL plans go through place-tpsl-order — profit_plan/loss_plan are
// illegal on place-plan-order (that endpoint is for trigger/moving orders).
// holdSide identifies the protected side; no side/orderType needed.
const planOrder = (symbol, planType, triggerPrice, size, holdSide) =>
  api('POST', '/api/v2/mix/order/place-tpsl-order', {
    body: {
      symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MARGIN_COIN,
      planType, triggerPrice: String(triggerPrice), executePrice: /profit/.test(planType) ? String(triggerPrice) : '0', // TP legs limit@trigger — fee mandate; loss legs market (must fill)
      triggerType: 'mark_price', holdSide,
      // pos_profit/pos_loss cover the whole position — the API wants size
      // OMITTED for those, not a literal '0' (a zero-size param can read as
      // an invalid order, not "full position")
      ...(size === '0' || size == null ? {} : { size: String(size) }),
    },
  });
// Transient placement errors: 43023 'Insufficient position' fires when the
// position index hasn't caught up to a fresh fill; 43059 'Request failed'
// is Bitget's generic transient. Retry up to 2x with backoff before
// declaring protection failed (the emergency-close path relies on this
// being a real failure, not an indexing race or endpoint blip).
const planWithRetry = async (fn) => {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!/43023|43059/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
};
// recent fills — the REAL trade journal: every actual fill the exchange
// recorded, deduped into state/real-fills.json so the public ledger shows
// real entries/exits with real fees, not just the sim's paper model
const getFills = () =>
  api('GET', '/api/v2/mix/order/fills', {
    // bounded window — an unbounded 'latest 100' can miss today's fills when
    // a churn burst fills the window with plan-order traffic
    qs: `productType=${PRODUCT}&limit=100&startTime=${Date.now() - 48 * 3600e3}`,
  }).then((d) => {
    const l = d?.fillList || d?.fills || d;
    return Array.isArray(l) ? l : [];
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
// cancel ONLY loss-side plans — a blanket cancel was wiping the TP ladder
// off the exchange every time a trail ratcheted. 'moving_plan' is Bitget's
// trailing-stop type — it stops the same side a loss plan does, so it must
// match too (a /loss|stop/ regex alone leaves it orphaned).
const cancelLossPlans = (symbol) =>
  cancelByType(symbol, (p) => /loss|stop|moving/i.test(p.planType || ''));

// ---------- contracts: size rounding + minimums ----------
async function contractMap() {
  // the demo environment lists a SUBSET of the live catalog (45 vs 805
  // symbols) — fetching the live list unsigned would size orders for
  // symbols this environment can't route (40805/40034 on every attempt)
  const res = await fetch(
    `${HOST}/api/v2/mix/market/contracts?productType=${PRODUCT}`,
    {
      headers: MODE === 'demo' ? { paptrading: '1' } : {},
      signal: AbortSignal.timeout(15000),
    }
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
      maxLev: +c.maxLever || 0,
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
  const tRun = Date.now();
  const planPath = path.join(API_DIR, 'live-plan.json');
  const outPath = path.join(API_DIR, 'live-ledger.json');
  const state = { mode: MODE, refreshedAt: new Date().toISOString(), actions: [], errors: [] };
  // untradeable symbols persist across runs — the scanner blocks entries on
  // them, so the executor never re-attempts and never re-fails. Without the
  // merge the block would flap off every other cycle. Authoritative store is
  // exec-catalog.json (survives ledger rewrites); live-ledger kept in sync
  // for the dashboard.
  const catPath = path.join(API_DIR, 'exec-catalog.json');
  const priorPlanSyms = new Set();
  // engine-managed symbols: positions THIS executor entered (persisted in
  // the ledger across restarts). A symbol not in the set is a foreign
  // position — opened manually on the app/exchange — which we arm with
  // protection but never expose to scanner-driven exits.
  const managed = new Set();
  try {
    for (const f of [outPath, catPath]) {
      const prior = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (prior.mode === MODE && prior.untradeable?.length)
        state.untradeable = [...new Set([...(state.untradeable || []), ...prior.untradeable])];
      // protection-failure circuit breaker rides in the ledger: after a
      // TPSL placement failure that forced an emergency close, entries halt
      // until the timestamp — one 30min probe costs a fee, a 15s probe loop
      // drains the account on retries that can't succeed
      if (prior.mode === MODE && Number.isFinite(prior.protectionHaltUntil))
        state.protectionHaltUntil = Math.max(state.protectionHaltUntil || 0, prior.protectionHaltUntil);
      // entry-attempt log rides the ledger too — the fills journal lags
      // ~30s behind live order routing, so a probe loop can slip extra
      // opens under the rate cap before the fills ever record. Attempts
      // (not fills) are what cost fees; count them locally.
      if (prior.mode === MODE && Array.isArray(prior.entriesLog))
        state.entriesLog = prior.entriesLog.filter(
          // entries may be bare timestamps (legacy) or {ts,symbol,direction}.
          // 24h retention — the hourly cap filters to the window itself; a
          // true DAILY cap needs the whole day's attempts retained.
          (e) => Number.isFinite(e.ts ?? e) && Date.now() - (e.ts ?? e) < 24 * 3600e3
        );
      // symbols that carried pending plans last cycle — orphan-plan sweep
      // uses this to find triggers still live on symbols now flat
      if (prior.mode === MODE && prior.plans)
        for (const s of Object.keys(prior.plans)) priorPlanSyms.add(s);
      if (prior.mode === MODE && Array.isArray(prior.managed))
        for (const s of prior.managed) managed.add(s);
    }
  } catch {}
  if (MODE === 'off') {
    log('mode=off — set SENTINEL_EXEC=shadow|demo|live');
    return;
  }
  // ---- run lock: cycles spawn on a fixed timer, but a run's network
  // latency can outlive its slot. One live run at a time — exchange-side
  // plans keep every position protected while a cycle is skipped.
  const lockPath = path.join(__dirname, '..', 'state', 'exec.lock');
  try {
    const lk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    let alive = false;
    if (Number.isFinite(lk.pid) && Date.now() - (lk.ts || 0) < 180e3) {
      try { process.kill(lk.pid, 0); alive = true; }
      catch (e) { alive = e.code === 'EPERM'; }
    }
    if (alive) {
      log(`prior run still working (pid ${lk.pid}, ${Math.round((Date.now() - lk.ts) / 1e3)}s) — skipping cycle`);
      return;
    }
  } catch {}
  try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(lockPath); } catch {} });
  let plan = null;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    if (MODE !== 'off') {
      state.errors.push(`live-plan.json unreadable: ${e.message}`);
      writeJson(outPath, state);
    }
    log('no readable plan — nothing to route');
    return;
  }
  plan.orders = Array.isArray(plan.orders) ? plan.orders : [];
  plan.closes = Array.isArray(plan.closes) ? plan.closes : [];
  plan.trails = Array.isArray(plan.trails) ? plan.trails : [];
  state.planAgeMs = Number.isFinite(plan.ts) ? Date.now() - plan.ts : null;
  // gate-reject transparency: the scanner now tells us WHY each candidate
  // was stood down — surface the counts so "nothing opened" has a reason
  // attached instead of silence
  if (Array.isArray(plan.rejects) && plan.rejects.length)
    state.rejects = plan.rejects.slice(0, 12);
  const stale = !Number.isFinite(plan.ts) || Date.now() - plan.ts > (plan.ttlMs || 900e3);

  if (stale) {
    state.errors.push(`plan stale (${Math.round((Date.now() - plan.ts) / 6e4)}min > ${(plan.ttlMs / 6e4)|0}min) — refused`);
    writeJson(outPath, state);
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
    writeJson(outPath, state);
    log('unknown mode — refusing');
    return;
  }
  if (!KEY || !SECRET || !PASS) {
    state.errors.push('missing BITGET_API_KEY/SECRET/PASSPHRASE');
    writeJson(outPath, state);
    log('no credentials — set env keys');
    return;
  }
  if (MODE === 'live' && !LIVE_ARMED) {
    state.errors.push('live requires SENTINEL_LIVE=1 AND CONFIRM_LIVE=YES');
    writeJson(outPath, state);
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
  const [positions, acct] = await Promise.all([
    getPos().catch((e) => (state.errors.push('positions: ' + e.message), [])),
    getAccount().catch(() => ({ equity: 0, available: 0 })),
    getPosMode(probeSym)
      .then((m) => { POS_MODE = m; })
      .catch((e) => state.errors.push('posMode detect failed — fail-closed: ' + e.message)),
  ]);
  if (state.errors.some((e) => e.startsWith('posMode'))) {
    writeJson(outPath, state);
    log('cannot determine position mode — refusing to guess close semantics');
    return;
  }
  const equityUsd = acct.equity;
  let marginFree = acct.available;
  const scale = equityUsd > 0 ? Math.min(1, equityUsd / PAPER_EQUITY) : 0;
  state.equityUsd = round(equityUsd, 2);
  state.marginFreeUsd = round(marginFree, 2);
  state.posMode = POS_MODE;
  const rawPos = (positions || []).filter((p) => +p.total > 0);
  // a MANUAL_HOLD on a flat symbol silently exempts future auto-entries from
  // management — flag it so the exemption can't linger forgotten
  state.manualHoldStale = [...MANUAL].filter((s) => !rawPos.some((p) => p.symbol === s && +p.total > 0));
  state.manualHoldActive = [...MANUAL].filter((s) => rawPos.some((p) => p.symbol === s && +p.total > 0));
  state.positions = rawPos.map((p) => ({
    symbol: p.symbol, side: p.holdSide, size: +p.total,
    entry: +p.openPriceAvg, upl: +p.unrealizedPL, lev: +p.leverage,
    marginMode: p.marginMode, cTime: +(p.cTime || 0), liq: +p.liquidationPrice || 0,
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

  // prune managed to still-open symbols — if the engine's position is flat
  // and the user re-opens the same symbol by hand, the new one is foreign
  // and must not inherit engine exits. Publish for the ledger persist.
  for (const s of [...managed]) if (!posBySym.has(s)) managed.delete(s);
  // foreign = open on the exchange but not engine-entered and not
  // MANUAL-whitelisted — protection synthesis applies, scanner exits do not.
  const foreign = (sym) => !managed.has(sym) && !MANUAL.has(sym);

  // ---- operator panic flatten: state/cmd-flatten.json (telegram C2,
  // CONFIRM-gated at the source) closes EVERY open position — engine,
  // manual, foreign — at market. One-shot: the flag self-clears after the
  // sweep so a stale file can't flatten a future book.
  const flatPath = path.join(__dirname, '..', 'state', 'cmd-flatten.json');
  let cmdFlat = null;
  try { const c = JSON.parse(fs.readFileSync(flatPath, 'utf8')); if (c.flatten) cmdFlat = c; } catch {}
  if (cmdFlat) {
    try {
      fs.writeFileSync(flatPath, JSON.stringify({ flatten: false, doneAt: new Date().toISOString(), positions: posBySym.size }));
    } catch {}
    for (const [sym, p] of posBySym) {
      try {
        await cancelPlans(sym);
        await closePosition(sym, p.side);
        state.actions.push(`flatten: closed ${sym} ${p.side} ${p.size}`);
        posBySym.delete(sym);
      } catch (e) { state.errors.push(`flatten ${sym}: ${e.message}`); }
    }
  }

  // ---- closes first: freeing margin and killing contradicted exposure is
  // always the priority ----
  // EXEC_SCANNER_CLOSES=0 (operator mandate): scanner/sim closes are OFF —
  // a sim ledger settle is paper bookkeeping; it must not spend real taker
  // fees cancelling a protected position. Real exits = exchange TP/SL +
  // manual flatten only. The stop IS the exit decision, made in advance.
  if (process.env.EXEC_SCANNER_CLOSES !== '0')
  for (const c of plan.closes) {
    // manual-hold and foreign positions are exempt from scanner-driven
    // exits — a paper ledger expiry/reversal must not kill a deliberately
    // held position, nor one the user opened outside the engine
    if (MANUAL.has(c.symbol) || foreign(c.symbol)) {
      state.actions.push(`close ${c.symbol} skipped — ${MANUAL.has(c.symbol) ? 'manual hold' : 'foreign position'}`);
      continue;
    }
    const pos = posBySym.get(c.symbol);
    if (!pos) continue;
    // min-hold: a scanner close inside the floor is the flip-flop vector —
    // the position was opened seconds ago and never got to be a trade.
    // The exchange-side SL covers a genuine dump meanwhile; nothing the
    // scanner says at <10min age is worth two more taker fees.
    if (pos.cTime && Date.now() - pos.cTime < MIN_HOLD_MS) {
      state.actions.push(`close ${c.symbol} ignored — position ${Math.round((Date.now() - pos.cTime) / 1e3)}s old (< ${Math.round(MIN_HOLD_MS / 1e3)}s min-hold)`);
      continue;
    }
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

  // trailing stops removed by mandate — stops stay where the entry set them

  // ---- real-equity drawdown guard: the kill-switch keys off the ACTUAL
  // account equity curve (peak persisted across runs), not the sim ledger —
  // sim bookkeeping diverges from exchange truth and must not gate money.
  // The same file keeps a rolling equity tape so a rolling-24h loss halt
  // exists too — max daily drawdown is the rail the teardown flagged missing.
  // mode-scoped DD tape: demo equity must never contaminate the live
  // drawdown series — a $10k demo peak against a $6 live book reads as a
  // permanent ~99.9% wipeout and trips every DD rail on return to live.
  const peakPath = path.join(__dirname, '..', 'state', `equity-peak-${MODE}.json`);
  let eqTrack = { peak: equityUsd, samples: [] };
  try {
    const prior = JSON.parse(fs.readFileSync(peakPath, 'utf8'));
    eqTrack.peak = Math.max(equityUsd, +prior.peak || 0);
    eqTrack.samples = Array.isArray(prior.samples) ? prior.samples : [];
  } catch {}
  const nowMs = Date.now();
  // a failed account read returns equity=0 — pushing that sample would fake
  // a total wipeout on the rolling DD tape. Only record real reads.
  if (equityUsd > 0) eqTrack.samples.push([nowMs, equityUsd]);
  eqTrack.samples = eqTrack.samples.filter(([t]) => nowMs - t < 36e5 * 24.5).slice(-7000);
  try { writeJson(peakPath, { peak: eqTrack.peak, samples: eqTrack.samples, at: new Date().toISOString() }); } catch {}
  const realDdPct = eqTrack.peak > 0 ? ((eqTrack.peak - equityUsd) / eqTrack.peak) * 100 : 0;
  const peak24 = Math.max(equityUsd, ...eqTrack.samples.filter(([t]) => nowMs - t <= 36e5 * 24).map(([, q]) => q));
  const dd24 = peak24 > 0 ? ((peak24 - equityUsd) / peak24) * 100 : 0;
  state.ddPct = round(realDdPct, 2);
  state.dd24Pct = round(dd24, 2);
  const MIN_TRADE_EQUITY = +(process.env.SENTINEL_MIN_EQUITY || 5.5);
  // ---- operator halt: state/cmd-halt.json written by the telegram C2 —
  // joins the same rail as the kill-switch: entries only, existing
  // positions keep their stops/management
  const cmdHalt = (() => {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'cmd-halt.json'), 'utf8')); return c.halted ? c : null; }
    catch { return null; }
  })();
  const entriesBlocked =
    cmdHalt ? `operator halt — ${cmdHalt.reason || 'manual'} (telegram ${cmdHalt.at || ''})`
    : realDdPct >= DD_KILL ? `kill-switch (real equity dd ${state.ddPct}% >= ${DD_KILL}%)`
    : dd24 >= DAILY_HALT ? `daily-loss halt (equity -${state.dd24Pct}% in rolling 24h >= ${DAILY_HALT}%)`
    // Buffett rule #1 enforced mechanically: below the survival floor the
    // account can't post margin for even two contract-min positions —
    // every further entry is just donating fees. Preserve the last chip.
    : equityUsd < MIN_TRADE_EQUITY ? `equity floor ($${round(equityUsd,2)} < $${MIN_TRADE_EQUITY} — capital preservation, entries halted)`
    : null;

  // published risk rails — the machine-readable answer to "where are the
  // kill-switches / position limits / disconnect handling" — rendered on
  // the dashboard and exported with the ledger.
  state.risk = {
    riskProfile: RISK_MAX ? 'max' : 'default',
    riskMultiplier: +(process.env.SENTINEL_RISK_MUL || (RISK_MAX ? 3 : 1)),
    sizingUsd: `all free margin / ${TARGET_POSITIONS} target slots (~${round(100 / TARGET_POSITIONS, 1)}% equity each) × risk multiplier`,
    maxPositions: MAX_POSITIONS,
    leverageRule: 'contract maxLever, bounded so the stop stays inside the liq band: lev <= 80/(stopPct+0.64)',
    killSwitchPct: DD_KILL,
    dailyHaltPct: DAILY_HALT,
    ddPct: state.ddPct,
    dd24Pct: state.dd24Pct,
    protectionRule: 'exactly one TP + one SL per position; orphan positions get protection synthesized; entry emergency-closes if protection placement fails — never naked',
    rebalanceRule: 'a position holding > slot margin gets partially closed to free balance for other slots',
    disconnectRule: 'TP/SL are exchange-side plan orders — a VPS/network outage cannot leave a position unprotected',
  };

  // ---- margin rebalance: a single position may not hold more margin than
  // the per-position cap. Slot-share trimming (equity/TARGET_POSITIONS)
  // fought the entry sizer — it deployed at the 85% cap, then rebalance
  // burned a reduce-fee cutting it to 24% AND orphaned the plan sizes
  // (the drift that left the stop oversized and unfireable). The cap IS
  // the sizing mandate; rebalance only enforces it.
  const slotMargin = equityUsd * +(process.env.SENTINEL_POS_CAP_PCT || 0.85);
  for (const p of posBySym.values()) {
    if (MANUAL.has(p.symbol) || foreign(p.symbol)) continue;
    try {
      const levNow = Math.max(1, p.lev || 1);
      const marginEst = (p.size * p.entry) / levNow;
      const excess = marginEst - slotMargin;
      if (excess <= Math.max(0.5, slotMargin * 0.15)) continue;
      const c = cm[p.symbol];
      if (!c) { state.errors.push(`${p.symbol}: no contract meta — cannot rebalance`); continue; }
      const prec = Math.pow(10, c.sizePlace);
      const closeSize = Math.floor(((excess * levNow) / p.entry) * prec) / prec;
      const remain = p.size - closeSize;
      const minSz = Math.max(c.minTradeNum, c.minTradeUSDT / p.entry);
      if (closeSize < minSz) continue;
      if (remain > 0 && remain < minSz) {
        // remainder dust — close the whole slot instead of leaving an
        // un-closeable stub
        await closePosition(p.symbol, p.side);
        state.actions.push(`rebalanced ${p.symbol}: closed fully (remainder under min ${minSz})`);
      } else {
        // close-positions ignores `size` (whole-side only — a 'partial' call
        // flattened a live position). True partial = place-order market close:
        // hedge mode needs side = POSITION direction (close long = buy+close).
        await api('POST', '/api/v2/mix/order/place-order', {
          body: {
            symbol: p.symbol, productType: PRODUCT, marginCoin: MARGIN_COIN,
            size: String(closeSize), orderType: 'market',
            marginMode: p.marginMode === 'crossed' ? 'crossed' : 'isolated',
            ...(POS_MODE === 'hedge'
              ? { side: p.side === 'long' ? 'buy' : 'sell', tradeSide: 'close' }
              : { side: p.side === 'long' ? 'sell' : 'buy', reduceOnly: 'YES' }),
          },
        });
        state.actions.push(`rebalanced ${p.symbol}: closed ${closeSize}/${p.size} — margin ~$${round(marginEst, 2)} -> slot ~$${round(slotMargin, 2)}`);
        p.size -= closeSize;
        p.marginFreed = (closeSize * p.entry) / levNow;
        marginFree += p.marginFreed;
      }
    } catch (e) {
      state.errors.push(`rebalance ${p.symbol}: ${e.message}`);
    }
  }

  // ---- thesis-decay exit: prospective eval shows direction accuracy
  // decays 62%@1h -> 48%@24h — a position still underwater DECAY_HOURS in
  // has a dead thesis. Closing it converts an expected -1R stop-out into a
  // smaller realized loss AND frees margin for fresher signals. This is
  // not a trailing stop: TP/SL plans stay exactly as placed on every
  // position that hasn't gone stale.
  const DECAY_MS = (+(process.env.EXEC_DECAY_HOURS || 5)) * 3600e3;
  for (const p of posBySym.values()) {
    if (MANUAL.has(p.symbol) || foreign(p.symbol)) continue;
    try {
      if (!p.cTime) continue;
      const ageMs = Date.now() - p.cTime;
      if (ageMs < DECAY_MS) continue;
      const notionalUsd = p.size * p.entry;
      const pnlPct = notionalUsd > 0 ? (p.upl / notionalUsd) * 100 : 0;
      if (pnlPct >= 0) continue; // profitable = thesis working, leave it
      await closePosition(p.symbol, p.side);
      state.actions.push(
        `decay-exit ${p.symbol}: age ${(ageMs / 36e5).toFixed(1)}h uPnL ${round(pnlPct, 2)}% — thesis stale, margin recycled`
      );
      posBySym.delete(p.symbol);
    } catch (e) {
      state.errors.push(`decay-exit ${p.symbol}: ${e.message}`);
    }
  }

  // ---- thesis-flip exit: if the freshest scan emitted a graded liquidity
  // sweep or SFP AGAINST an open position's direction, the thesis is dead —
  // exit now rather than donating the full stop distance. The scanner emits
  // plan.thesisFlips from its signal set regardless of the order gates.
  // Minimum age: a position younger than this is still within the entry
  // candle's noise — signal whipsaw between scans is not thesis death.
  const FLIP_MIN_AGE_MS = (+(process.env.EXEC_FLIP_MIN_MIN || 15)) * 60e3;
  try {
    const flips = new Map(
      (plan.thesisFlips || []).map((f) => [f.symbol, f.direction])
    );
    for (const p of posBySym.values()) {
      if (MANUAL.has(p.symbol) || foreign(p.symbol)) continue;
      const flip = flips.get(p.symbol);
      const posDir = p.side === 'long' ? 'LONG' : 'SHORT';
      if (!flip || flip === posDir) continue;
      // Young positions are managed by their stop — a flip signal that
      // whipsaws within minutes is noise, not thesis death. Only an
      // opposing signal against a mature position counts as a flip.
      if (Date.now() - Number(p.cTime) < FLIP_MIN_AGE_MS) continue;
      await closePosition(p.symbol, p.side);
      state.actions.push(
        `thesis-flip ${p.symbol}: fresh ${flip} signal vs open ${posDir} — exited before stop`
      );
      posBySym.delete(p.symbol);
    }
  } catch (e) {
    state.errors.push(`thesis-flip: ${e.message}`);
  }

  // ---- loss-streak cooldown: a symbol whose last two closed trades were
  // losers goes on a 6h entry timeout — repeated bleed on one name is a
  // signal the engine's model of that market is wrong right now.
  const cooledSym = new Set();
  try {
    const fj =
      JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'state', 'real-fills.json'), 'utf8')
      ).fills || [];
    const bySym = {};
    for (const f of fj) {
      if (!(f.tradeSide === 'close' || (f.profit || 0) !== 0)) continue;
      // a close within ±0.1% of notional is a scratch (fee drag on a
      // near-breakeven exit — e.g. an emergency close after a protection
      // placement failure), not a market verdict. Neither a loser nor a
      // streak-breaker: it carries no information about direction, so it
      // must not arm — or reset — the loss-streak cooldown.
      const notional = (+f.price || 0) * (+f.size || 0);
      if (notional > 0 && Math.abs(f.profit || 0) <= 0.001 * notional) continue;
      (bySym[f.symbol] = bySym[f.symbol] || []).push(f);
    }
    for (const [s, arr] of Object.entries(bySym)) {
      const last2 = arr.slice(0, 2);
      if (
        last2.length === 2 &&
        last2.every((x) => (x.profit || 0) < 0) &&
        Date.now() - last2[0].ts < 6 * 3600e3
      )
        cooledSym.add(s);
    }
  } catch {}

  // ---- universal re-entry cooldown + daily fee-burn governor ----
  // ANY close on a symbol benches re-entry for the cooldown window — the
  // churn autopsy showed open->close->open loops at 15-90s spacing; a flat
  // cooldown makes that loop structurally impossible regardless of which
  // layer emitted the closes.
  const REENTRY_MS = +(process.env.SENTINEL_REENTRY_COOLDOWN_MS || 60 * 60e3);
  const lastCloseBySym = {};
  let feesToday = 0;
  try {
    const fj =
      JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'state', 'real-fills.json'), 'utf8')
      ).fills || [];
    const dayStart = new Date().setUTCHours(0, 0, 0, 0);
    for (const f of fj) {
      if (f.tradeSide === 'close')
        lastCloseBySym[f.symbol] = Math.max(lastCloseBySym[f.symbol] || 0, +f.ts || 0);
      if (+f.ts >= dayStart) feesToday += +f.fee || 0;
    }
  } catch {}
  // fee-burn halt: commissions >5% of equity in a day stands the book
  // down — a fee-churn day is always a regime the engine can't read, and
  // the only winning move is to stop paying.
  const FEE_HALT_PCT = +(process.env.SENTINEL_FEE_HALT_PCT || 0.05);
  const feeHalted = equityUsd > 0 && feesToday >= equityUsd * FEE_HALT_PCT;

  // ---- regime-chop gate: trailing-4h closes running negative net means the
  // tape is unreadable for this engine right now — stand new entries down
  // until the window clears, instead of feeding it fees. Core-carry margin
  // deployment is exempt (it's not a swing trade).
  const REGIME_MIN_CLOSES = +(process.env.SENTINEL_REGIME_MIN_CLOSES || 6);
  const REGIME_WINDOW_MS = +(process.env.SENTINEL_REGIME_WINDOW_MS || 4 * 3600e3);
  let regimeNet = 0, regimeCloses = 0;
  try {
    const fj4 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'real-fills.json'), 'utf8')).fills || [];
    for (const f of fj4) {
      if (Date.now() - (+f.ts || 0) > REGIME_WINDOW_MS) continue;
      if (f.tradeSide === 'close') { regimeCloses++; regimeNet += (f.profit || 0) - (f.fee || 0); }
    }
  } catch {}
  const regimeChop = +(process.env.SENTINEL_REGIME_GATE || 1) && regimeCloses >= REGIME_MIN_CLOSES && regimeNet < 0;
  if (regimeChop) state.actions.push(`regime-chop armed — ${regimeCloses} closes net ${round(regimeNet, 2)} in ${Math.round(REGIME_WINDOW_MS / 3600e3)}h — new entries standing down`);

  // ---- correlation cluster cap: corr>=0.6 in the same direction is ONE
  // bet. correlation.json's own contract — nothing enforced it until now.
  const CORR_MIN = +(process.env.SENTINEL_CORR_MIN || 0.6);
  const corrMap = {};
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'correlation.json'), 'utf8'));
    const A = cj.boardAssets || [], Mx = cj.boardMatrix || [];
    A.forEach((a, i) => A.forEach((b, j) => {
      if (i !== j && Math.abs(+(Mx[i]?.[j] || 0)) >= CORR_MIN) (corrMap[a + 'USDT'] ||= {})[b + 'USDT'] = +Mx[i][j];
    }));
  } catch {}

  // ---- funding hostility: positive rate => longs pay shorts. An entry that
  // pays funding every 8h starts life bleeding — veto past the threshold.
  const FUND_VETO = +(process.env.SENTINEL_FUNDING_VETO_PCT || 0.03);
  const fundMap = {};
  try {
    const fj2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'funding.json'), 'utf8'));
    for (const r of fj2.rows || fj2.best || []) if (r.asset && Number.isFinite(+r.ratePct)) fundMap[r.asset + 'USDT'] = +r.ratePct;
  } catch {}

  // ---- entry rate cap — rolling 1h window, not a calendar cliff: a scalp
  // regime turns positions over fast, so the guard limits RATE not daily
  // total. Max 3 new entries per rolling hour stops fee-churn sprays while
  // the book never sits dead waiting for a window to drain.
  const windowStart = Date.now() - 3600e3;
  let entriesThisHour = 0;
  let entriesThisDay = 0;
  try {
    const fj =
      JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'state', 'real-fills.json'), 'utf8')
      ).fills || [];
    for (const f of fj)
      // opens only — a scratch close (profit 0, tradeSide missing) must not
      // eat the rate budget the same way a real entry does
      if ((f.tradeSide === 'open' || (f.tradeSide == null && (f.profit || 0) === 0)) && f.ts >= windowStart)
        entriesThisHour++;
    // journaled fills lag live opens by up to ~30s; the local attempt log
    // (persisted via ledger) sees them immediately — take the higher count
    entriesThisHour = Math.max(
      entriesThisHour,
      (state.entriesLog || []).filter((e) => Date.now() - (e.ts ?? e) < 3600e3).length
    );
    entriesThisDay = Math.max(
      entriesThisDay,
      (state.entriesLog || []).filter((e) => Date.now() - (e.ts ?? e) < 24 * 3600e3).length
    );
  } catch {}
  // EXEC_MAX_ENTRIES_DAY now means what it says — the old wiring let 'day'
  // act as the HOURLY cap: 99 opens in 38h on a $65 book.
  const MAX_ENTRIES_HOUR = +(process.env.EXEC_MAX_ENTRIES_HOUR || 3);
  const MAX_ENTRIES_DAY = +(process.env.EXEC_MAX_ENTRIES_DAY || 8);

  // ---- protection repair: EVERY open position must carry a loss plan AND
  // a staggered take-profit ladder — never a single take-profit level.
  // Orphaned/manual positions get synthesized protection: stop distance is
  // inferred from an existing loss plan, else 1.2%; the TP ladder anchors
  // at 2R of that distance.
  // Staggered TP tranches — the mandate: EVERY position (managed, manual,
  // foreign, hedged) banks in levels, never one take-profit. 40% at 0.55x
  // of the position's target distance, 30% at 1.0x, 15% at 1.8x; the last
  // ~15% stays unplanned as the moon bag riding the stop. baseDistPct is
  // the position's TP distance: the signal target on managed entries, the
  // trader's own trigger distance on a retrofit, 2R when synthesized.
  // Returns legs placed; 0 = too small to split, caller falls back to one
  // full-size pos_profit.
  const placeTpLadder = async (p, baseDistPct) => {
    const sgn = p.side === 'long' ? 1 : -1;
    const sp = Math.pow(10, cm[p.symbol]?.sizePlace ?? 4);
    const pp = cm[p.symbol]?.pricePlace ?? 6;
    // cumulative-difference allocation — tranche_i = floor(size*cum[i+1]) -
    // floor(size*cum[i]): rounding residue lands in the moon bag, not lost
    const cum = [0, 0.40, 0.70, 0.85];
    const mults = [0.55, 1.0, 1.8];
    const legs = [];
    for (let i = 0; i < 3; i++) {
      const tsize =
        (Math.floor(p.size * cum[i + 1] * sp) - Math.floor(p.size * cum[i] * sp)) / sp;
      if (tsize > 0 && tsize * p.entry >= MIN_TRANCHE_USD)
        legs.push({
          tsize,
          px: round(p.entry * (1 + (sgn * baseDistPct * mults[i]) / 100), pp),
        });
    }
    if (legs.length < 2) return 0;
    for (const l of legs)
      await planOrder(p.symbol, 'profit_plan', l.px, String(l.tsize), p.side);
    return legs.length;
  };
  // Prefetch all pending plans in parallel — a serial await-per-symbol made
  // each position pay a full round-trip inside the loop (~200ms × N symbols).
  const planCache = new Map();
  await Promise.all(
    [...posBySym.keys(), ...ambiguous].map(async (sym) =>
      planCache.set(sym, await getPlans(sym).catch(() => []))
    )
  );
  const plansOf = (sym) => planCache.get(sym) || [];
  // ---- orphan-plan sweep: triggers left live on a symbol that went flat
  // (emergency close, stop fill, manual close between cycles) either
  // trigger-reject forever or — worse — fire a close-side order into a
  // NEW unrelated position on that symbol. Cancel them.
  for (const sym of priorPlanSyms) {
    if (posBySym.has(sym) || ambiguous.has(sym) || MANUAL.has(sym)) continue;
    try {
      const stale = await getPlans(sym).catch(() => []);
      if (stale.length) {
        await cancelPlans(sym);
        state.actions.push(`swept ${stale.length} orphan plan(s) on flat ${sym}`);
      }
    } catch (e) {
      state.errors.push(`orphan-sweep ${sym}: ${e.message}`);
    }
  }
  for (const p of posBySym.values()) {
    try {
      // foreign positions (app/exchange/manual opens) get the same hands-off
      // treatment as MANUAL_HOLD: armed with synthesized protection, but no
      // ratchets, time-cuts, or scanner-driven exits — the staggered TP
      // ladder still applies (mandate: every position banks in levels).
      // The user's trade is the user's trade — the engine guards it, it
      // doesn't manage it.
      const manualHold = MANUAL.has(p.symbol) || foreign(p.symbol);
      const existing = plansOf(p.symbol);
      // 'moving_plan' (trailing stop) IS loss protection — without it in the
      // regex the repair loop would stack a second stop on a trailed position
      const lossPlan = existing.find((x) => /loss|stop|moving/i.test(x.planType || ''));
      const profitPlan = existing.find((x) => /profit/i.test(x.planType || ''));
      const hasProfit = !!profitPlan;
      // breakeven ratchet — "no one went broke taking profit": with the TP
      // ladder live, progress is measured against the NEAREST profit
      // trigger, so the tranche-1 fill (0.55x target) is the ratchet point.
      // After TP1 banks, the stop moves to entry + ~0.2% (covers round-trip
      // fees) — tranches 2-3 are then free runners: worst case scratch,
      // upside runs to 1.8x target. Legacy single-TP positions ratchet at
      // ~90% to their only target.
      const profitPlans = existing.filter((x) => /profit/i.test(x.planType || ''));
      // plan-size drift: after a rebalance or TP-tranche bank the pending
      // plans still quote the OLD size — and Bitget counts CUMULATIVE
      // pending plan qty against the position, so any oversized leftover
      // 43023-blocks every new placement (observed live: 0.55 of plans on
      // a 0.09 position). Only a full teardown rebuilds capacity: cancel
      // every pending plan, then re-place whole-position protection
      // (pos_loss/pos_profit omit size = cover all). The retrofit ladder
      // re-splits the TP next cycle.
      const sp = Math.pow(10, cm[p.symbol]?.sizePlace ?? 4);
      const sizeStr = String(Math.floor(p.size * sp) / sp);
      const planQty = existing.reduce((a, x) => a + (+x.size || 0), 0);
      const planDrift =
        p.size > 0 &&
        (planQty > p.size * 1.001 ||
          (lossPlan &&
            /loss_plan|moving_plan/i.test(lossPlan.planType || '') &&
            Number.isFinite(+lossPlan.size) && +lossPlan.size > p.size));
      if (planDrift) {
        let trig = lossPlan && +lossPlan.triggerPrice > 0 ? +lossPlan.triggerPrice : null;
        const sgn = p.side === 'long' ? 1 : -1;
        const pp0 = cm[p.symbol]?.pricePlace ?? 6;
        let stopPct = trig ? (Math.abs(p.entry - trig) / p.entry) * 100 : 0;
        // a drifted stop parked past the liquidation band protects nothing —
        // the rebuild must clamp it inside the band, not re-place the defect
        const liqPct = p.liq > 0 ? (Math.abs(p.entry - p.liq) / p.entry) * 100 : 0;
        if (!stopPct) stopPct = Math.max(1.2, Math.min(liqPct * 0.7, 5)); // mandate: band room, not a fixed tight stop
        if (liqPct > 0 && stopPct >= liqPct * 0.8) {
          stopPct = Math.max(liqPct * 0.75, 0.05);
          trig = round(p.entry * (1 - (sgn * stopPct) / 100), pp0);
        }
        try {
          await cancelPlans(p.symbol);
          await planWithRetry(() =>
            planOrder(p.symbol, 'pos_loss',
              trig || round(p.entry * (1 - (sgn * stopPct) / 100), pp0), '0', p.side));
          // preserve the trader's own TP trigger if one was armed — the
          // rebuild fixes SIZE drift, it doesn't get to rewrite the target
          const keepTp = profitPlan && +profitPlan.triggerPrice > 0 ? +profitPlan.triggerPrice : null;
          await planWithRetry(() =>
            planOrder(p.symbol, 'pos_profit',
              keepTp || round(p.entry * (1 + (sgn * 2 * stopPct) / 100), pp0), '0', p.side));
          state.actions.push(
            `resynced ${p.symbol}: rebuilt whole-position protection (pending plan qty ${round(planQty, 4)} > size ${p.size})`
          );
        } catch (e) {
          state.errors.push(`resync ${p.symbol}: ${e.message}`);
        }
        continue;
      }
      if (lossPlan && p.size > 0 && !manualHold) {
        const sgn = p.side === 'long' ? 1 : -1;
        const mark = p.entry + (sgn * p.upl) / p.size; // entry + realized move
        // nearest profit trigger in the trade direction = next bank level
        const nearTp = profitPlans
          .map((x) => +x.triggerPrice)
          .filter((t) => t > 0 && (sgn === 1 ? t > p.entry : t < p.entry))
          .sort((a, b) => (sgn === 1 ? a - b : b - a))[0];
        const slTrig = +lossPlan.triggerPrice;
        const dist = nearTp ? Math.abs(nearTp - p.entry) : 0;
        const prog = dist > 0 ? (sgn * (mark - p.entry)) / dist : 0;
        const pp = cm[p.symbol]?.pricePlace ?? 6;
        let wantPx = null, why = null;
        if (profitPlans.length && prog >= 0.9) {
          // ratchet tiers — the stop locks ~55% of the NEXT bank level once
          // price is within 10% of it, then keeps climbing: near TP1 the
          // stop lands at entry+0.30xT; near TP2 it locks TP1; near TP3 it
          // locks TP2. Only ever moves in the trade's favor.
          const lockPct = Math.max(0.25, 0.55 * ((dist / p.entry) * 100));
          wantPx = round(p.entry * (1 + (sgn * lockPct) / 100), pp);
          why = `ratchet ${p.symbol}: ${round(prog * 100, 0)}% to next TP — stop locked at +${round(lockPct, 2)}% (${wantPx})`;
        } else if (!profitPlans.length && sgn * (mark - p.entry) > 0) {
          // moon-bag trail — all TP tranches banked, the leftover runner has
          // no target. Trail the stop 1.0% under price every cycle: the last
          // piece rides until the move actually reverses, never a fixed cap.
          wantPx = round(mark * (1 - (sgn * 1.0) / 100), pp);
          why = `trail ${p.symbol}: stop following winner @ ${wantPx}`;
        }
        const slBetter =
          wantPx != null && slTrig > 0 &&
          (sgn === 1 ? wantPx > slTrig : wantPx < slTrig);
        if (wantPx != null && slBetter) {
          const planId = lossPlan.orderId || lossPlan.planId || lossPlan.id;
          const newSize = /pos_/.test(lossPlan.planType) ? '0' : sizeStr;
          // place-then-cancel — cancel-first leaves the position naked for
          // ~200ms every ratchet. If the exchange refuses a second stop on
          // the same side, fall back to the old order (cancel then place).
          try {
            await planOrder(p.symbol, lossPlan.planType, wantPx, newSize, p.side);
            if (planId) await cancelPlanOrders(p.symbol, lossPlan.planType, [String(planId)]);
          } catch {
            if (planId) await cancelPlanOrders(p.symbol, lossPlan.planType, [String(planId)]);
            await planOrder(p.symbol, lossPlan.planType, wantPx, newSize, p.side);
          }
          state.actions.push(why);
        }
        // verdict ladder — hours-scale to match the 1h signal horizon:
        //   216s : genuinely adverse (>0.4% on notional) -> thesis instantly
        //          wrong, cut before the chop even develops
        //   2h   : still >60% of stop depth underwater -> early loss cut
        //   4h   : still >35% of stop depth underwater -> early loss cut
        //   90m  : <35% to next TP and not green -> stall, cut
        //   4h   : <65% progress and not meaningfully green -> deadline, cut
        // Anything that clears all five is a live runner the
        // ladder/moon-bag trail manages.
        // Runner exemption: once tranches start banking, progress-to-next-TP
        // resets and a moon bag carries prog=0 — gates that only read prog
        // would murder winners. The upl guard spares anything actually green;
        // a position with NO remaining profit plans (all banked) answers to
        // the trail, not the stall clock.
        const uplPct = (p.upl / (p.size * p.entry)) * 100;
        const ageMs = p.cTime ? Date.now() - p.cTime : 0;
        const runnerMode = !profitPlans.length;
        // the 216s gate must clear the FEE-NOISE band, not any redness: a
        // 59x taker fill opens ~-0.12% red on notional instantly, so 'red
        // at all' auto-executed every chop market entry at +4min — the
        // scalp-churn loop that burned the account on fees (observed live).
        // Cut only when the move against us is genuine: >0.4% adverse on
        // notional — past halfway to a typical 0.7% stop. Anything less is
        // noise the exchange-side SL already manages.
        // Time×loss cascade (TrendRider's verified mechanic — PF 1.03→1.41,
        // maxDD −6.1%→−1.4% in their A/B): kill positions STILL deep-red
        // hours after entry. Depth thresholds scale to this position's own
        // stop distance (60% at 2h, 35% at 4h) — a 1h-candle thesis needs
        // hours to work, so progress deadlines run at hours scale, not the
        // old 15/45-minute churn window that killed developing winners.
        const slDepthPct =
          slTrig > 0 ? (Math.abs(slTrig - p.entry) / p.entry) * 100 : 0;
        const scalpDead = !EARLY_CUTS ? null
          : ageMs > 216e3 && uplPct < -0.4
            ? `red ${round(uplPct, 2)}% at ${(ageMs / 1e3).toFixed(0)}s`
            : slDepthPct > 0 && ageMs > 2 * 3600e3 && uplPct < -slDepthPct * 0.6
            ? `still ${round(uplPct, 2)}% past 60% of stop depth at 2h — early loss cut`
            : slDepthPct > 0 && ageMs > 4 * 3600e3 && uplPct < -slDepthPct * 0.35
            ? `still ${round(uplPct, 2)}% past 35% of stop depth at 4h — early loss cut`
            : !runnerMode && ageMs > 90 * 60e3 && prog < 0.35 && uplPct < 0.3
            ? `${round(prog * 100, 0)}% progress at ${(ageMs / 60e3).toFixed(0)}m`
            : !runnerMode && ageMs > 4 * 3600e3 && prog < 0.65 && uplPct < 0.8
            ? `${round(prog * 100, 0)}% progress at ${(ageMs / 60e3).toFixed(0)}m`
            : null;
        if (scalpDead) {
          await closePosition(p.symbol, p.side);
          state.actions.push(`scalp-timeout ${p.symbol}: ${scalpDead} — margin recycled`);
          posBySym.delete(p.symbol);
          continue;
        }
      }
      // retrofit: an open position still carrying ONE full-size profit plan
      // gets the staggered ladder — tranches placed BEFORE cancelling the
      // original TP so the position is never uncovered. Applies to managed,
      // manual, and foreign positions alike — the trader's own TP distance
      // is preserved as the middle rung (0.55x/1.0x/1.8x tranches). A
      // position too small to split into >=2 tranches keeps its single TP.
      if (profitPlans.length === 1 && p.size > 0) {
        const tpTrig = +profitPlans[0].triggerPrice;
        const distPct = tpTrig > 0 ? (Math.abs(tpTrig - p.entry) / p.entry) * 100 : 0;
        if (distPct > 0) {
          const pid = profitPlans[0].orderId || profitPlans[0].planId || profitPlans[0].id;
          const placed = await placeTpLadder(p, distPct);
          if (placed >= 2) {
            if (pid) {
              try {
                await cancelPlanOrders(p.symbol, profitPlans[0].planType, [String(pid)]);
              } catch (e) {
                state.errors.push(`ladder-cancel ${p.symbol}: ${e.message}`);
              }
            }
            state.actions.push(
              `laddered ${p.symbol}${manualHold ? ' (manual/foreign)' : ''}: TP split ${placed} ways @ ${round(distPct * 0.55, 2)}/${round(distPct, 2)}/${round(distPct * 1.8, 2)}% + moon bag`
            );
          }
        }
      }
      // band re-check — runs even on fully-armed positions: isolated-margin
      // liq creeps toward entry as funding/fees accrue, so a stop that was
      // inside the band at placement can end up past it and never fire. A
      // stop that can't beat liquidation protects nothing — rebuild it.
      const bandPct = p.liq > 0
        ? (Math.abs(p.entry - p.liq) / p.entry) * 100
        : (p.lev > 0 ? Math.max(0.2, 90 / p.lev) : 0); // liq field absent → estimate band from leverage
      if (lossPlan && bandPct > 0) {
        const armedStopPct = (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100;
        if (armedStopPct >= bandPct * 0.8) {
          const sgn0 = p.side === 'long' ? 1 : -1;
          const pp0 = cm[p.symbol]?.pricePlace ?? 6;
          const newStop = round(p.entry * (1 - (sgn0 * Math.max(bandPct * 0.75, 0.05)) / 100), pp0);
          try {
            await cancelPlanOrders(p.symbol, lossPlan.planType, [String(lossPlan.orderId || lossPlan.planId)]);
            await planWithRetry(() => planOrder(p.symbol, 'pos_loss', newStop, '0', p.side));
            state.actions.push(`re-banded ${p.symbol}: stop ${+lossPlan.triggerPrice} at/past liq edge (${round(bandPct, 2)}% band) -> ${newStop}`);
          } catch (e) {
            state.errors.push(`re-band ${p.symbol}: ${e.message}`);
          }
        }
      }
      if (manualHold && lossPlan && bandPct > 1.5) {
        const armedPct = (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100;
        if (armedPct < bandPct * 0.5) {
          const sgn2 = p.side === 'long' ? 1 : -1;
          const pp2 = cm[p.symbol]?.pricePlace ?? 6;
          const wStop = round(p.entry * (1 - (sgn2 * bandPct * 0.7) / 100), pp2);
          try {
            await planOrder(p.symbol, 'pos_loss', wStop, '0', p.side);
            await cancelPlanOrders(p.symbol, lossPlan.planType, [String(lossPlan.orderId || lossPlan.planId)]);
            state.actions.push(`widened ${p.symbol} stop ${round(armedPct, 2)}% -> ${round(bandPct * 0.7, 2)}% — using the room the band affords`);
          } catch (e) { state.errors.push(`widen ${p.symbol}: ${e.message}`); }
        }
      }
      if (lossPlan && hasProfit) continue;
      const sgn = p.side === 'long' ? 1 : -1;
      const pp = cm[p.symbol]?.pricePlace ?? 6;
      let stopPct = lossPlan && +lossPlan.triggerPrice > 0
        ? (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100
        : 0;
      // the synthesized stop must fire BEFORE liquidation or it protects
      // nothing — 100x liq sits ~0.9% out, under the 1.2% default. Clamp to
      // 80% of the entry→liq distance (same bound entry sizing uses).
      const liqPct = bandPct;
      if (!stopPct) stopPct = Math.max(1.2, Math.min(liqPct * 0.7, 5)); // mandate: band room, not a fixed tight stop
      if (liqPct > 0 && stopPct >= liqPct * 0.8) {
        const raw = stopPct;
        stopPct = Math.max(liqPct * 0.75, 0.05); // never tighter than 0.05%
        state.actions.push(`clamped ${p.symbol} synth stop ${round(raw, 2)}% -> ${round(stopPct, 2)}% (liq ${round(liqPct, 2)}% away)`);
      }
      if (!lossPlan) {
        await planOrder(p.symbol, 'pos_loss',
          round(p.entry * (1 - (sgn * stopPct) / 100), pp), '0', p.side);
        state.actions.push(`repaired ${p.symbol}: added pos_loss @ ${round(p.entry * (1 - (sgn * stopPct) / 100), pp)}`);
      }
      if (!hasProfit) {
        // staggered TPs even on synthesized protection — 2R is the base
        // distance, so tranches land at ~1.1R/2R/3.6R + the moon bag.
        // Too small to split -> one whole-position pos_profit as before.
        const placed = await placeTpLadder(p, 2 * stopPct);
        if (placed >= 2) {
          state.actions.push(
            `repaired ${p.symbol}: TP ladder ${placed} legs @ ${round(2 * stopPct * 0.55, 2)}/${round(2 * stopPct, 2)}/${round(2 * stopPct * 1.8, 2)}% + moon bag`
          );
        } else {
          const tpPrice = round(p.entry * (1 + (sgn * 2 * stopPct) / 100), pp);
          try {
            await planOrder(p.symbol, 'pos_profit', tpPrice, '0', p.side);
          } catch {
            await planOrder(p.symbol, 'pos_profit', tpPrice, String(p.size), p.side);
          }
          state.actions.push(`repaired ${p.symbol}: added pos_profit @ ${tpPrice}`);
        }
      }
    } catch (e) {
      state.errors.push(`protect ${p.symbol}: ${e.message}`);
    }
  }

  // ambiguous (dual-sided hedge) positions get NO auto-management — no
  // exits, no ratchets — but they still deserve protection: repair missing
  // TP/SL legs so they can't sit naked on the exchange.
  for (const p of state.positions) {
    if (!ambiguous.has(p.symbol)) continue;
    try {
      const existing = plansOf(p.symbol);
      const sgn = p.side === 'long' ? 1 : -1;
      const pp = cm[p.symbol]?.pricePlace ?? 6;
      const lossPlan = existing.find((x) => /loss|stop|moving/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
      const hasProfit = existing.some((x) => /profit/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
      let stopPct = lossPlan && +lossPlan.triggerPrice > 0
        ? (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100
        : 0;
      const liqPct = p.liq > 0
        ? (Math.abs(p.entry - p.liq) / p.entry) * 100
        : (p.lev > 0 ? Math.max(0.2, 90 / p.lev) : 0);
      if (!stopPct) stopPct = Math.max(1.2, Math.min(liqPct * 0.7, 5)); // mandate: band room, not a fixed tight stop
      if (liqPct > 0 && stopPct >= liqPct * 0.8) stopPct = Math.max(liqPct * 0.75, 0.05);
      if (!lossPlan) {
        await planOrder(p.symbol, 'pos_loss',
          round(p.entry * (1 - (sgn * stopPct) / 100), pp), '0', p.side);
        state.actions.push(`protected ${p.symbol} ${p.side} (hedged): added pos_loss`);
      }
      if (!hasProfit) {
        const placed = await placeTpLadder(p, 2 * stopPct);
        if (placed >= 2) {
          state.actions.push(`protected ${p.symbol} ${p.side} (hedged): TP ladder ${placed} legs`);
        } else {
          await planOrder(p.symbol, 'pos_profit',
            round(p.entry * (1 + (sgn * 2 * stopPct) / 100), pp), '0', p.side);
          state.actions.push(`protected ${p.symbol} ${p.side} (hedged): added pos_profit`);
        }
      }
    } catch (e) {
      state.errors.push(`protect ${p.symbol} ${p.side} (hedged): ${e.message}`);
    }
  }

  // ---- entries: only when the real drawdown guards are clear and capacity
  // allows — plan.killSwitch is sim-derived and logged for reference only ----
  const protectionHalted =
    Number.isFinite(state.protectionHaltUntil) && Date.now() < state.protectionHaltUntil;
  if (protectionHalted) {
    state.actions.push(
      `protection-halt until ${new Date(state.protectionHaltUntil).toISOString().slice(11, 19)}Z — TPSL placement failed earlier, entries paused (no naked probes)`
    );
  }
  if (protectionHalted || entriesBlocked) {
    if (entriesBlocked) state.actions.push(`${entriesBlocked} — no new entries`);
  } else {
    let opened = 0;
    const openedSym = new Set(); // a dup symbol in the plan must not stack
    // ---- core-carry injection: the mandate is deployment. Margin that
    // qualifies for no signal still works — appended LAST in the queue so
    // real signals take their share first, then the remainder deploys into
    // a protected carry instead of sitting as dead balance. It rides every
    // in-loop gate (dedup, cooldown, RR, drift, rate caps, catalog) like a
    // normal order.
    if (marginFree > Math.max(equityUsd * CORE_FLOOR_PCT, CORE_FLOOR_USD)) {
      for (const sym of CORE_SYMS) {
        if (posBySym.has(sym) || ambiguous.has(sym) || MANUAL.has(sym) || !cm[sym]) continue;
        try {
          const tk = await api('GET', '/api/v2/mix/market/ticker', {
            qs: 'symbol=' + sym + '&productType=' + PRODUCT,
          });
          const last = +(Array.isArray(tk) ? tk[0].lastPr : tk?.lastPr);
          if (!(last > 0)) continue;
          plan.orders.push({
            symbol: sym, direction: 'LONG', refEntry: last,
            notionalUsd: round(marginFree, 2),
            stopPct: CORE_STOP_PCT, targetPct: CORE_TARGET_PCT,
            leverage: CORE_LEV, conv: 1, runnerMult: 1.8,
            strategy: 'core-carry', core: true,
          });
          state.actions.push('core-carry: deploying $' + round(marginFree, 2) + ' idle margin into ' + sym + ' long @ lev<=' + CORE_LEV);
        } catch (e) { /* ticker unreadable — try next symbol */ }
        break; // one core order per cycle — first eligible symbol wins
      }
    }
    for (const [oi, o] of plan.orders.entries()) {
      // ambiguous symbols are excluded from posBySym — a .has() check would
      // pass and stack a third order on a symbol already holding both sides
      if (posBySym.has(o.symbol) || openedSym.has(o.symbol) || ambiguous.has(o.symbol) || opened + posBySym.size >= MAX_POSITIONS) continue;
      // MANUAL_HOLD is a hands-off claim on the SYMBOL, not just the open
      // position — an auto-entry on a held symbol would open then go
      // unmanaged (management exempts itself by design). Entries blocked.
      if (MANUAL.has(o.symbol)) {
        state.actions.push(`${o.symbol}: manual-hold symbol — entry skipped (symbol is hands-off)`);
        continue;
      }
      if (cooledSym.has(o.symbol)) {
        state.actions.push(`${o.symbol}: cooldown — last two closes were losers, 6h timeout`);
        continue;
      }
      if (entriesThisHour >= MAX_ENTRIES_HOUR || entriesThisDay >= MAX_ENTRIES_DAY) {
        state.actions.push(`entry rate cap (${entriesThisHour}/${MAX_ENTRIES_HOUR}/h · ${entriesThisDay}/${MAX_ENTRIES_DAY}/day) — standing down`);
        break;
      }
      if (feeHalted) {
        state.actions.push(`fee-burn halt — ${round(feesToday, 2)} commissions today >= ${round(FEE_HALT_PCT * 100, 1)}% of equity — standing down`);
        break;
      }
      const lastClose = lastCloseBySym[o.symbol];
      if (lastClose && Date.now() - lastClose < REENTRY_MS) {
        state.actions.push(`${o.symbol}: re-entry cooldown — closed ${Math.round((Date.now() - lastClose) / 6e4)}m ago (< ${Math.round(REENTRY_MS / 6e4)}m)`);
        continue;
      }
      if (!Number.isFinite(o.refEntry) || !Number.isFinite(o.notionalUsd) ||
          !Number.isFinite(o.stopPct) || !Number.isFinite(o.targetPct) ||
          !Number.isFinite(o.leverage) || (o.direction !== 'LONG' && o.direction !== 'SHORT')) {
        state.errors.push(`${o.symbol || '?'}: malformed order fields — skipped`);
        continue;
      }
      // user mandate: no shorts — hard refusal independent of scanner gating,
      // so a stale or hand-built plan can never route a short entry.
      if (LONG_ONLY && o.direction === 'SHORT') {
        state.actions.push(`${o.symbol}: SHORT blocked — longs-only mandate`);
        continue;
      }
      if (!o.core) { // mandate roles (core-carry deploys) are exempt from tape gates
        if (regimeChop) {
          state.actions.push(`${o.symbol} ${o.direction}: regime-chop — entries halted this window`);
          (state.rejects = state.rejects || []).push({ symbol: o.symbol, direction: o.direction, score: o.score, gates: ['regime-chop'] });
          continue;
        }
        const corrHit = Object.entries(corrMap[o.symbol] || {}).find(([s2]) => {
          const pv = posBySym.get(s2);
          const sd = pv?.side || pv?.holdSide;
          return sd === (o.direction === 'LONG' ? 'long' : 'short');
        });
        if (corrHit) {
          state.actions.push(`${o.symbol} ${o.direction}: corr-cluster — ${corrHit[0]} already held same direction (rho ${corrHit[1]})`);
          (state.rejects = state.rejects || []).push({ symbol: o.symbol, direction: o.direction, score: o.score, gates: ['corr-cluster'] });
          continue;
        }
        const fr = fundMap[o.symbol];
        if (fr != null && ((o.direction === 'LONG' && fr > FUND_VETO) || (o.direction === 'SHORT' && fr < -FUND_VETO))) {
          state.actions.push(`${o.symbol} ${o.direction}: funding ${fr}%/8h hostile — vetoed`);
          (state.rejects = state.rejects || []).push({ symbol: o.symbol, direction: o.direction, score: o.score, gates: ['funding-hostile'] });
          continue;
        }
      }
      // idempotent execution: the same signal must physically be unable to
      // fire twice. A prior attempt on this symbol+direction inside the
      // dedup window means this order is a replay (fill-index lag, plan
      // re-emission, loop restart) — skip it.
      if ((state.entriesLog || []).some(
        (e) => e.symbol === o.symbol && e.direction === o.direction &&
               Date.now() - e.ts < ENTRY_DEDUP_MS
      )) {
        state.actions.push(`${o.symbol} ${o.direction}: duplicate signal — idempotent skip`);
        continue;
      }
      // ≥RR_MIN net R:R defense — the scanner stamps netRR/costPct; recompute
      // here with a conservative cost floor (0.12% RT fees + 0.08 slip +
      // 0.1 spread = 0.30%) so a stale/noncompliant plan can never route.
      {
        const RR_MIN = +(process.env.SENTINEL_MIN_RR || 2);
        // floor at UNAVOIDABLE cost only: taker RT 0.12 + modeled slip 0.08 =
        // 0.20%. The 0.30% floor invented a spread the scanner measured as
        // ~0 on liquid majors — every marginal plan died at ~2.4:1 effective.
        // Scanner-stamped costPct (spread + funding) rides on top.
        const cost = Math.max(Number.isFinite(o.costPct) ? o.costPct : 0, 0.20);
        const netRR = (o.targetPct - cost) / (o.stopPct + cost);
        if (!(netRR >= RR_MIN)) {
          state.actions.push(`${o.symbol}: net R:R ${netRR.toFixed(2)} < ${RR_MIN}:1 after costs — rejected`);
          continue;
        }
      }
      // drift guard — the plan can be up to 15min old; a market order at a
      // price that already ran past the modeled entry breaks the 3:1
      // geometry the scanner certified. Chase-fade tolerance: 0.6%.
      try {
        const tk = await api('GET', '/api/v2/mix/market/ticker', {
          qs: `symbol=${o.symbol}&productType=${PRODUCT}`,
        });
        const last = +(Array.isArray(tk) ? tk[0].lastPr : tk?.lastPr);
        const drift = (o.direction === 'LONG' ? last - o.refEntry : o.refEntry - last) / o.refEntry;
        if (last > 0 && drift > 0.006) {
          state.actions.push(`${o.symbol}: price ran ${round(drift * 100, 2)}% past ref entry — skipped (chasing = worse R:R)`);
          continue;
        }
        // trigger-side sanity: if mark already sits beyond the modeled stop,
        // the SL trigger is wrong-side the instant it lands (Bitget 43023 /
        // instant trigger) — the position is born dead; if it's already past
        // the target there's nothing left to capture. Either way: skip.
        const sgn0 = o.direction === 'LONG' ? 1 : -1;
        const slTrig = o.refEntry * (1 - sgn0 * (o.stopPct / 100));
        const tpTrig = o.refEntry * (1 + sgn0 * (o.targetPct / 100));
        if (last > 0 && (sgn0 === 1 ? last <= slTrig : last >= slTrig)) {
          state.actions.push(`${o.symbol}: mark already through modeled stop (${last} vs ${round(slTrig, 6)}) — skipped`);
          continue;
        }
        if (last > 0 && (sgn0 === 1 ? last >= tpTrig : last <= tpTrig)) {
          state.actions.push(`${o.symbol}: mark already through modeled target (${last} vs ${round(tpTrig, 6)}) — skipped`);
          continue;
        }
      } catch {} // ticker unreadable — proceed on the plan's own staleness TTL
      // not in this environment's catalog = unroutable here — record it so
      // the scanner stops emitting entries the executor can never fill
      if (!cm[o.symbol]) {
        state.untradeable = [...new Set([...(state.untradeable || []), o.symbol])];
        state.errors.push(`${o.symbol}: absent from ${MODE} contract catalog — unroutable`);
        continue;
      }
      // sizing: deploy ALL free margin evenly across the remaining target
      // slots (~25% of balance per trade at the 4-slot target); once the
      // target is met, leftovers spread across any remaining max slots.
      const openNow = posBySym.size + opened;
      const slotsLeft = Math.max(0, MAX_POSITIONS - openNow);
      const targetLeft = Math.max(0, TARGET_POSITIONS - openNow);
      // denominator counts REMAINING plan orders, not a static slot count —
      // orders skipped by the gates free their share forward, and the last
      // eligible order deploys everything that's left. No idle margin.
      const ordersLeft = Math.max(1, plan.orders.length - oi);
      const denom = Math.min(
        Math.max(1, targetLeft > 0 ? targetLeft : slotsLeft),
        ordersLeft
      );
      // risk multiplier: max profile (or SENTINEL_RISK_MUL) puts 3x the
      // per-slot share on each order — same slot logic, triple the slice.
      // Capped at the full free margin after the fee reserve either way.
      // Equity-curve throttle: while the book runs >10% below its real
      // peak the multiplier halves — protect capital during a bleed, press
      // it during equity highs. Sizing still uses whatever margin is free.
      const riskMul =
        +(process.env.SENTINEL_RISK_MUL || (RISK_MAX ? 3 : 1)) *
        ((state.ddPct ?? 0) > 10 ? 0.5 : 1);
      // leverage: contract max, bounded so the designed stop still sits
      // inside the liquidation band — lev <= 80/(stopPct + 0.64) keeps the
      // stop at <=80% of the band edge, otherwise liquidation fires first.
      const lev = Math.max(
        1,
        Math.min(
          cm[o.symbol].maxLev || 125,
          Math.floor(80 / (o.stopPct + 0.64)),
          +(process.env.SENTINEL_MAX_LEV || 40), // account ceiling — the max-safety profile pins it lower
          o.core ? CORE_LEV : Infinity // carry runs capped gearing, not signal lev
        )
      );
      // fee headroom: Bitget charges the taker fee on NOTIONAL from free
      // balance — at 37x the round-trip (open taker + conditional exit)
      // eats ~4.4% of the margin slice. Sizing to 100% of marginFree was
      // the source of the 40762 'order amount exceeds the balance'
      // rejections — the fee landed on top of a fully-deployed balance.
      const FEE_RT = 0.0012; // 0.06% taker x2 sides of notional
      // over-reserve fees 30% — exact-fit sizing still produced 40762
      // 'order amount exceeds the balance' rejections (rate-tier and
      // rounding slop land the fee on top of a fully-deployed balance)
      // conviction-weighted deployment — the plan stamps each order with
      // its strategy's measured forward-alpha tier: proven-edge setups take
      // their full slot, unproven ones take a probe-size fraction. The
      // per-position cap below stays the absolute ceiling either way.
      const convMul = Math.min(1.1, Math.max(0.2, +(o.conv ?? 1)));
      const marginUsd = Math.min(
        (Math.min(riskMul / denom, 1) * marginFree) / (1 + lev * FEE_RT * 1.3) * convMul,
        // single-position margin cap — 85%: near-full aggression on a
        // qualifying shot while still banking one reload. Ruin is the only
        // unrecoverable outcome; every other loss is tuition.
        equityUsd * +(process.env.SENTINEL_POS_CAP_PCT || 0.85)
      );
      // effective-notional cap: margin_cap × lev ≈ 50x equity → the 0.12%
      // round-trip eats ~6% of equity per trade while measured signal
      // expectancy is +0.05%/trade — structurally unbeatable. Every
      // live-verified public strategy runs <=5x effective notional for
      // exactly this reason. Cap is env-tunable (0/absent = legacy uncapped).
      const NOTIONAL_MULT_CAP = +(process.env.SENTINEL_MAX_NOTIONAL_MULT || 0) || Infinity;
      const notional = Math.min(marginUsd * lev, equityUsd * NOTIONAL_MULT_CAP);
      let size = sizeFor(cm, o.symbol, notional, o.refEntry);
      let minMarginNeeded = null;
      if (!size && FLOOR_MIN) {
        // floor to the contract minimum — but only if the margin needed
        // (notional/leverage) leaves >20% of equity free afterwards
        const c = cm[o.symbol];
        const minQty = Math.max(c.minTradeNum, c.minTradeUSDT / o.refEntry);
        const minNotional = minQty * o.refEntry;
        const marginNeeded = minNotional / lev;
        minMarginNeeded = marginNeeded + minNotional * 0.0006;
        // margin must cover size AND the open taker fee on that notional —
        // out of FREE margin, not equity: comparing against equity*0.8 while
        // marginFree was ~0 was the recurring 40762 'exceeds the balance'
        // spam. Reserve 20% of equity in the default profile; max profile
        // spends down to fees-only.
        const feeNeeded = minNotional * 0.0006;
        const budget = marginFree - (RISK_MAX ? 0 : equityUsd * 0.2);
        if (marginNeeded + feeNeeded <= budget) {
          const p = Math.pow(10, c.sizePlace);
          size = Math.ceil(minQty * p) / p; // round UP to clear the minimum
          state.actions.push(`${o.symbol}: scaled size below min — floored to contract minimum $${round(minNotional, 2)} notional`);
        }
      }
      if (!size) {
        // can't fund even the contract minimum from free margin = fully
        // deployed, not a fault — log as an action, not an error
        const msg = `${o.symbol}: insufficient free margin for contract minimum — skipped`;
        ((minMarginNeeded ?? Infinity) > marginFree ? state.actions : state.errors).push(msg);
        continue;
      }
      const sgn = o.direction === 'LONG' ? 1 : -1;
      const holdSide = o.direction === 'LONG' ? 'long' : 'short';
      const coid = `s${plan.ts}${o.symbol}`.slice(0, 38);
      const t0 = Date.now();
      try {
        await setIsolated(o.symbol);
        await setLeverage(o.symbol, lev);
        let needSize = size;
        if (MAKER_ENTRIES) {
          try {
            const q = await api('GET', '/api/v2/mix/market/ticker', { qs: `symbol=${o.symbol}&productType=${PRODUCT}` });
            const tk = Array.isArray(q) ? q[0] : q;
            const touch = sgn > 0 ? +tk?.bidPr : +tk?.askPr; // join own side — post-only, never crosses
            if (touch > 0) {
              const lo = await limitOrder(o.symbol, sgn > 0 ? 'buy' : 'sell', size, round(touch, cm[o.symbol]?.pricePlace ?? 6), { clientOid: coid });
              const oid = String(lo?.orderId || '');
              await new Promise((r) => setTimeout(r, 1200));
              const still = (await pendingOrders(o.symbol).catch(() => [])).find((x) => String(x.orderId) === oid);
              if (still) {
                const filled = +(still.filledVolume ?? still.filledQty ?? 0) || 0;
                const sp2 = Math.pow(10, cm[o.symbol]?.sizePlace ?? 4);
                needSize = filled > 0 ? Math.floor((size - filled) * sp2) / sp2 : size;
                await api('POST', '/api/v2/mix/order/cancel-order', { body: { symbol: o.symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, orderId: oid } }).catch(() => {});
              } else needSize = 0;
            }
          } catch { /* limit path failed — taker covers full size below */ }
        }
        if (needSize > 0)
          await marketOrder(o.symbol, sgn > 0 ? 'buy' : 'sell', needSize, 'open', { clientOid: (coid + 'm').slice(0, 38) });
        else state.actions.push(`${o.symbol}: maker fill — taker fee saved`);
        // record the attempt immediately — the fills journal won't see this
        // for ~30s, and the rate cap must count it now (probe loops burn
        // fees per attempt, not per recorded fill)
        (state.entriesLog = state.entriesLog || []).push({
          ts: Date.now(), symbol: o.symbol, direction: o.direction,
          strategy: o.strategy || null,
        });
        // commit the attempt NOW — the ledger normally writes at run end;
        // a mid-run kill must still leave this entry visible to the next
        // cycle's dedup/rate caps (belt-and-suspenders under the run lock)
        try { writeJson(outPath, state); } catch {}
        managed.add(o.symbol); // engine-entered — exits apply to managed only
        entriesThisHour++;
        // protective levels anchor to the ACTUAL fill, not the plan's ref
        // price — market orders slip, and a stop quoted off an unfilled
        // reference can sit on the wrong side of price. Same for SIZE: a
        // partial fill must not leave plans quoting the intended size (they
        // trigger-reject 43023) — size protection off what actually filled.
        let fill = o.refEntry, filledSize = size;
        // Bitget's position index trails the fill by seconds — TPSL placed
        // on a not-yet-indexed position returns 43023 and trips the
        // emergency close at full round-trip fees (observed live). Poll
        // until the position is visible before placing protection.
        let pp2 = null;
        for (let i = 0; i < 9 && !pp2; i++) {
          const ps = await getPos().catch(() => []);
          pp2 = ps.find(
            (x) =>
              x.symbol === o.symbol && +x.total > 0 &&
              (!x.holdSide || x.holdSide === (o.direction === 'LONG' ? 'long' : 'short'))
          );
          if (!pp2) await new Promise((r) => setTimeout(r, 1000));
        }
        if (pp2) {
          if (+pp2.openPriceAvg > 0) fill = +pp2.openPriceAvg;
          filledSize = Math.min(size, +pp2.total);
          if (filledSize < size)
            state.actions.push(`partial fill ${o.symbol}: ${filledSize}/${size}`);
        } else {
          state.actions.push(`${o.symbol}: position not visible after 8s — protecting on intended size`);
        }
        // query failed silently (network blip) — proceed on intended size;
        // a confirmed zero-position is handled below when plans land on
        // nothing (exchange rejects with no-position errors, caught by the
        // emergency-close path as benign)
        // staggered TP ladder (reinstated): 45% banks at 0.55x target —
        // first-passage probability of a nearer level is strictly higher,
        // and once it fills the breakeven ratchet makes tranches 2-3 free
        // runners — 35% at the original target, 20% runner at 1.8x target
        // captures the tail a single TP forfeits. EV = sum over tranches of
        // P(reach)*size*dist; the ratchet zeroes post-TP1 downside, so the
        // ladder dominates single-TP for any distribution with a tail.
        const pp = cm[o.symbol]?.pricePlace ?? 6;
        const sp = Math.pow(10, cm[o.symbol]?.sizePlace ?? 4);
        const minQty = Math.max(
          cm[o.symbol]?.minTradeNum || 0,
          (cm[o.symbol]?.minTradeUSDT || 0) / fill
        );
        // plan orders accept sub-minimum sizes (conditional triggers aren't
        // market entries — verified live) — the only real constraints are
        // tranche-1 clearing round-trip fees and nonzero sizes after rounding
        const ladder = o.targetPct * 0.55 >= 0.9;
        // runner distance scales with signal confluence — strong setups
        // earn a longer tail (1.6x..2.4x), weak ones bank sooner
        const runnerMult = Math.max(1.2, +(o.runnerMult || 1.8));
        // plan thunks — executed SEQUENTIALLY below. Concurrent
        // place-tpsl-order calls on one fresh position race Bitget's
        // position index (43023/43059 observed live) and the loss plan
        // goes FIRST: if ordering ever constrains placement, the stop is
        // already on the exchange before any TP exists.
        const plans = [];
        plans.push(() =>
          planWithRetry(() =>
            planOrder(
              o.symbol, 'loss_plan',
              round(fill * (1 - sgn * (o.stopPct / 100)), pp),
              filledSize, holdSide
            )
          )
        );
        if (ladder) {
          // 40/30/15 staggered banks — the leftover ~15% is the moon bag:
          // deliberately given NO profit plan so it rides the trailing stop
          // and lets a real winner run past every target
          const cum = [0, 0.40, 0.70, 0.85];
          const mults = [0.55, 1.0, runnerMult];
          const trancheSizes = [];
          for (let i = 0; i < 3; i++) {
            const tsize =
              (Math.floor(filledSize * cum[i + 1] * sp) - Math.floor(filledSize * cum[i] * sp)) / sp;
            if (tsize > 0) trancheSizes.push({ tsize, mult: mults[i] });
          }
          // a single surviving tranche protects only a fraction of the
          // position — fall back to one full-size TP instead
          if (trancheSizes.length >= 2) {
            for (const tr of trancheSizes)
              plans.push(() =>
                planWithRetry(() =>
                  planOrder(
                    o.symbol, 'profit_plan',
                    round(fill * (1 + sgn * (o.targetPct * tr.mult) / 100), pp),
                    String(tr.tsize), holdSide
                  )
                )
              );
          } else {
            plans.push(() =>
              planWithRetry(() =>
                planOrder(
                  o.symbol, 'profit_plan',
                  round(fill * (1 + sgn * (o.targetPct / 100)), pp),
                  filledSize, holdSide
                )
              )
            );
          }
        } else {
          plans.push(() =>
            planWithRetry(() =>
              planOrder(
                o.symbol, 'profit_plan',
                round(fill * (1 + sgn * (o.targetPct / 100)), pp),
                filledSize, holdSide
              )
            )
          );
        }
        for (const fn of plans) await fn();
        const usedMargin = (filledSize * fill) / lev;
        marginFree = Math.max(0, marginFree - usedMargin);
        // observable execution quality: slippage vs the scanner's reference
        // print + how long the fill took to confirm — the journal that
        // proves whether modeled SLIP_PCT matches reality
        const slipPct = ((fill - o.refEntry) / o.refEntry) * 100 * sgn;
        state.actions.push(
          `opened ${o.symbol} ${o.direction} ${filledSize} @~${round(fill, 6)} lev ${lev}x margin $${round(usedMargin, 2)} notional $${round(filledSize * fill, 2)} · slip ${slipPct >= 0 ? '+' : ''}${round(slipPct, 3)}% · ${Date.now() - t0}ms`
        );
        opened++;
        openedSym.add(o.symbol);
      } catch (e) {
        // unroutable symbols get recorded so the scanner stops emitting
        // entries the exchange can't hold: 40805 'Unsupported operation'
        // (RWA perps listed but not orderable) and 40034 'does not exist'
        // (sim priced an asset that has no futures contract — PAXGUSDT)
        if (/40805|40034|unsupported|does not exist/i.test(e.message)) {
          state.untradeable = [...new Set([...(state.untradeable || []), o.symbol])];
        }
        // Two distinct failures share this catch: the market order rejected
        // (40762 et al — NO position exists, nothing to protect, don't arm
        // the halt) vs a fill followed by protection failure (naked on the
        // exchange — emergency close + 30min entry halt so the next cycle
        // doesn't re-probe at full round-trip fees).
        const p = posBySym.get(o.symbol) ||
          (await getPos().catch(() => [])).find((x) => x.symbol === o.symbol && +x.total > 0);
        if (!p) {
          state.errors.push(`open ${o.symbol}: ${e.message}`);
          continue;
        }
        state.protectionHaltUntil = Date.now() + 30 * 60e3;
        state.errors.push(`open ${o.symbol}: ${e.message} — attempting emergency close`);
        try {
          await cancelPlans(o.symbol);
          await closePosition(o.symbol, p.holdSide || p.side);
          state.actions.push(`emergency-closed ${o.symbol} (protection failed)`);
        } catch (e2) {
          state.errors.push(`EMERGENCY CLOSE FAILED ${o.symbol}: ${e2.message}`);
        }
        break; // one failed probe is enough — don't burn fees probing the rest
      }
    }
  }

  // ---- real fill journal: pull the exchange's fill list, dedupe into a
  // persistent store, expose the last 50 on the ledger. This is the actual
  // track record — fees and profits as charged, not modeled.
  try {
    const fillsPath = path.join(__dirname, '..', 'state', 'real-fills.json');
    let store = { fills: [] };
    try { store = JSON.parse(fs.readFileSync(fillsPath, 'utf8')); } catch {}
    if (!Array.isArray(store.fills)) store.fills = [];
    const seen = new Set(store.fills.map((f) => f.tradeId));
    const byId = new Map(store.fills.map((f) => [f.tradeId, f]));
    let added = 0;
    let repaired = 0;
    for (const f of await getFills().catch(() => [])) {
      const id = f.tradeId || f.fillId || `${f.orderId}:${f.cTime}`;
      if (!id) continue;
      const fee = Math.abs(+((f.feeDetail || [])[0]?.totalFee ?? f.fee ?? f.totalFee ?? 0));
      const size = +(f.baseVolume ?? f.size ?? f.volume ?? f.qty ?? 0);
      // backfill: entries recorded before the feeDetail/baseVolume fix
      // carry fee=0/size=0 — patch them from the exchange record
      if (seen.has(id)) {
        const old = byId.get(id);
        if (old && (!old.fee || !old.size)) {
          if (!old.fee) old.fee = fee;
          if (!old.size) old.size = size;
          if (f.quoteVolume) old.notionalUsd = +f.quoteVolume;
          if (f.tradeSide) old.tradeSide = f.tradeSide;
          if (f.enterPointSource) old.src = f.enterPointSource;
          repaired++;
        }
        continue;
      }
      seen.add(id);
      store.fills.unshift({
        tradeId: id,
        symbol: f.symbol,
        side: f.side,
        price: +f.price,
        size,
        notionalUsd: +(f.quoteVolume ?? 0),
        fee,
        profit: +(f.profit ?? 0),
        tradeSide: f.tradeSide || null,
        src: f.enterPointSource || null, // 'api' = bot · 'ios'/'android'/'web' = manual
        ts: +(f.cTime ?? f.uTime ?? Date.now()),
      });
      added++;
    }
    if (added || repaired) {
      // newest-first is REQUIRED downstream (cooldown slices [0,2], the
      // rolling entry window, the journal) — unshift order depends on the
      // API's return direction, so sort explicitly rather than trust it
      store.fills.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      store.fills = store.fills.slice(0, 400);
      writeJson(fillsPath, store);
    }
    state.realFills = store.fills.slice(0, 50);
    state.realFillCount = store.fills.length;
    // realized scoreboard from the exchange's own record — close fills
    // carry realized profit; net-of-fee win rate is the number that matters
    const closes = store.fills.filter((f) => f.tradeSide === 'close' || (f.profit || 0) !== 0);
    const netCloses = closes.filter((f) => f.profit != null);
    const allFees = store.fills.reduce((a, f) => a + (f.fee || 0), 0);
    // a fill's true cost = its own fee + the ~0.06% taker on its entry side —
    // close-side-only accounting was flattering the record by ~40% of costs
    const netOfFee = (f) => f.profit - (f.fee || 0) - (f.notionalUsd || 0) * 0.0006;
    const wins = netCloses.filter((f) => netOfFee(f) > 0);
    const grossW = wins.reduce((a, f) => a + netOfFee(f), 0);
    const grossL = Math.abs(
      netCloses.filter((f) => netOfFee(f) <= 0).reduce((a, f) => a + netOfFee(f), 0)
    );
    const statsFor = (rows) => {
      const cl = rows.filter((f) => f.tradeSide === 'close' || (f.profit || 0) !== 0).filter((f) => f.profit != null);
      const fees = rows.reduce((a, f) => a + (f.fee || 0), 0);
      const w = cl.filter((f) => netOfFee(f) > 0);
      const gW = w.reduce((a, f) => a + netOfFee(f), 0);
      const gL = Math.abs(cl.filter((f) => netOfFee(f) <= 0).reduce((a, f) => a + netOfFee(f), 0));
      return {
        closes: cl.length,
        winRatePct: cl.length ? round((w.length / cl.length) * 100, 1) : null,
        netUsd: round(cl.reduce((a, f) => a + f.profit, 0) - fees, 4),
        feesUsd: round(fees, 4),
        profitFactor: gL > 0 ? round(gW / gL, 2) : null,
      };
    };
    state.realizedStats = {
      // scope: every close-side fill incl. foreign/manual fills — the raw
      // journal total. trades-taken.json episodes aggregate differently.
      scope: 'all close fills (incl. foreign)',
      closes: netCloses.length,
      winRatePct: netCloses.length ? round((wins.length / netCloses.length) * 100, 1) : null,
      // bottom line = realized profit minus EVERY fee on record — the old
      // netUsd only deducted close-side fees, hiding the entry toll
      netUsd: round(netCloses.reduce((a, f) => a + f.profit, 0) - allFees, 4),
      feesUsd: round(allFees, 4),
      profitFactor: grossL > 0 ? round(grossW / grossL, 2) : null,
      // attribution split: enterPointSource 'api' = this engine; ios/android/
      // web = manual account trading; null = legacy fill recorded pre-tag
      bySource: {
        bot: statsFor(store.fills.filter((f) => f.src === 'api')),
        manual: statsFor(store.fills.filter((f) => f.src && f.src !== 'api')),
        legacy: statsFor(store.fills.filter((f) => !f.src)),
      },
    };
  } catch (e) {
    state.errors.push(`fills journal: ${e.message}`);
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
    await Promise.all(
      (state.positionsAfter || []).map(async (p) => {
        state.plans[p.symbol] = (await getPlans(p.symbol).catch(() => []))
          .map((x) => ({ planType: x.planType, triggerPrice: +x.triggerPrice, size: +x.size, holdSide: x.holdSide }));
      })
    );
  } catch {}
  state.cycleMs = Date.now() - tRun;
  state.refreshedAt = new Date().toISOString(); // freshness = write time, not run start
  state.managed = [...managed]; // materialize at write time — entries late in the cycle count
  // ---- gate-reject histogram: rolling 24h counts by gate name ----
  try {
    const gsPath = path.join(__dirname, '..', 'api', 'gate-stats.json');
    let gs = { buckets: [] }; try { gs = JSON.parse(fs.readFileSync(gsPath, 'utf8')); } catch {}
    const counts = {};
    for (const r of state.rejects || []) for (const g of r.gates || []) counts[g] = (counts[g] || 0) + 1;
    gs.buckets = (gs.buckets || []).filter((b) => Date.now() - b.ts < 24 * 3600e3);
    gs.buckets.push({ ts: Date.now(), counts });
    const totals = {};
    for (const b of gs.buckets) for (const [g, n] of Object.entries(b.counts || {})) totals[g] = (totals[g] || 0) + n;
    gs.totals24h = totals;
    gs.refreshedAt = new Date().toISOString();
    writeJson(gsPath, gs);
  } catch {}

  // ---- excursion tracker (MAE/MFE): peak/trough mark per open position,
  // finalized on close -> calibration data for stop/target geometry ----
  try {
    const trackPath = path.join(__dirname, '..', 'state', 'mae-track.json');
    const epiPath = path.join(__dirname, '..', 'state', 'mae-mfe.json');
    const apiPath = path.join(__dirname, '..', 'api', 'mae-mfe.json');
    let track = {}; try { track = JSON.parse(fs.readFileSync(trackPath, 'utf8')); } catch {}
    const pos3 = await getPos().catch(() => []);
    const openKeys = new Set();
    for (const p of pos3 || []) {
      if (!(+p.total > 0)) continue;
      const mk = +p.markPrice || 0;
      if (!(mk > 0)) continue;
      const key = `${p.symbol}:${p.holdSide}`;
      openKeys.add(key);
      const t = (track[key] ||= { sym: p.symbol, side: p.holdSide, entry: +p.openPriceAvg, peak: mk, trough: mk, firstTs: Date.now(), strat: null });
      t.peak = Math.max(t.peak, mk); t.trough = Math.min(t.trough, mk); t.lastMark = mk;
      if (!t.strat) {
        const e = (state.entriesLog || []).filter((x) => x.symbol === p.symbol).slice(-1)[0];
        if (e?.strategy) t.strat = e.strategy;
      }
    }
    const done = Object.keys(track).filter((k) => !openKeys.has(k));
    if (done.length) {
      let epis = []; try { epis = JSON.parse(fs.readFileSync(epiPath, 'utf8')).episodes || []; } catch {}
      for (const k of done) {
        const t = track[k]; delete track[k];
        if (!t.entry || !t.lastMark) continue;
        const mae = t.side === 'long' ? (t.entry - t.trough) / t.entry * 100 : (t.peak - t.entry) / t.entry * 100;
        const mfe = t.side === 'long' ? (t.peak - t.entry) / t.entry * 100 : (t.entry - t.trough) / t.entry * 100;
        epis.push({ sym: t.sym, side: t.side, entry: t.entry, exit: t.lastMark,
          maePct: round(mae, 3), mfePct: round(mfe, 3),
          durMin: Math.round((Date.now() - t.firstTs) / 6e4), strat: t.strat || 'unattributed', ts: Date.now() });
      }
      epis = epis.slice(-300);
      writeJson(epiPath, { episodes: epis });
      const byKey = {};
      for (const e of epis) (byKey[`${e.sym}:${e.side}`] ||= []).push(e);
      const med = (a) => { const q = [...a].sort((x, y) => x - y); return q.length ? q[q.length >> 1] : null; };
      const agg = {};
      for (const [k, arr] of Object.entries(byKey)) {
        agg[k] = { n: arr.length, medMaePct: round(med(arr.map((e) => e.maePct)), 2), medMfePct: round(med(arr.map((e) => e.mfePct)), 2) };
      }
      // family rollup — the number that calibrates strategy stop floors
      const byFam = {};
      for (const e of epis) (byFam[e.strat] ||= []).push(e);
      const fam = {};
      for (const [k, arr] of Object.entries(byFam)) {
        fam[k] = { n: arr.length, medMaePct: round(med(arr.map((e) => e.maePct)), 2), medMfePct: round(med(arr.map((e) => e.mfePct)), 2) };
      }
      writeJson(apiPath, { refreshedAt: new Date().toISOString(), bySymbol: agg, byFamily: fam, episodes: epis.slice(-50) });
      state.maeMfe = fam;
      state.actions.push(`excursion: finalized ${done.length} episode(s) — mae/mfe journal updated`);
    }
    writeJson(trackPath, track);
  } catch (e) { state.errors.push(`mae/mfe: ${e.message}`); }

  writeJson(outPath, state);
  log(`done — ${state.actions.length} actions, ${state.errors.length} errors`);
  if (state.errors.length) console.log(state.errors.join('\n'));
}

main().catch((e) => {
  console.error('[exec] fatal:', e.message);
  process.exitCode = 1;
});
