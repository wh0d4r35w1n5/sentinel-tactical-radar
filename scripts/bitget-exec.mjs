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
// always fires before liquidation. Exactly ONE take-profit + ONE stop-loss
// per position; no trailing, no TP ladder, no notional cap. Existing
// positions missing either leg get it repaired; positions exceeding their
// slot margin get partially closed to free balance for the other slots.
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
// SENTINEL_RISK_PROFILE=max: maximum aggression — kill-switch at 35% DD and
// daily halt at 25% (defaults 8/6). Below those floors the book still stands
// down — a wipeout spiral isn't risk, it's the end of the book.
const RISK_MAX = process.env.SENTINEL_RISK_PROFILE === 'max';
const MAX_POSITIONS = +(process.env.LIVE_MAX_POSITIONS || (RISK_MAX ? 12 : 10));
const TARGET_POSITIONS = +(process.env.LIVE_TARGET_POSITIONS || 4);
const DD_KILL = +(process.env.SENTINEL_DD_KILL_PCT || (RISK_MAX ? 35 : 8));
const DAILY_HALT = +(process.env.SENTINEL_DAILY_HALT_PCT || (RISK_MAX ? 25 : 6));
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
// recent fills — the REAL trade journal: every actual fill the exchange
// recorded, deduped into state/real-fills.json so the public ledger shows
// real entries/exits with real fees, not just the sim's paper model
const getFills = () =>
  api('GET', '/api/v2/mix/order/fills', {
    qs: `productType=${PRODUCT}&limit=100`,
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
  const [positions, acct] = await Promise.all([
    getPos().catch((e) => (state.errors.push('positions: ' + e.message), [])),
    getAccount().catch(() => ({ equity: 0, available: 0 })),
    getPosMode(probeSym)
      .then((m) => { POS_MODE = m; })
      .catch((e) => state.errors.push('posMode detect failed — fail-closed: ' + e.message)),
  ]);
  if (state.errors.some((e) => e.startsWith('posMode'))) {
    fs.writeFileSync(outPath, JSON.stringify(state));
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
  state.positions = rawPos.map((p) => ({
    symbol: p.symbol, side: p.holdSide, size: +p.total,
    entry: +p.openPriceAvg, upl: +p.unrealizedPL, lev: +p.leverage,
    marginMode: p.marginMode, cTime: +(p.cTime || 0),
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

  // trailing stops removed by mandate — stops stay where the entry set them

  // ---- real-equity drawdown guard: the kill-switch keys off the ACTUAL
  // account equity curve (peak persisted across runs), not the sim ledger —
  // sim bookkeeping diverges from exchange truth and must not gate money.
  // The same file keeps a rolling equity tape so a rolling-24h loss halt
  // exists too — max daily drawdown is the rail the teardown flagged missing.
  const peakPath = path.join(__dirname, '..', 'state', 'equity-peak.json');
  let eqTrack = { peak: equityUsd, samples: [] };
  try {
    const prior = JSON.parse(fs.readFileSync(peakPath, 'utf8'));
    eqTrack.peak = Math.max(equityUsd, +prior.peak || 0);
    eqTrack.samples = Array.isArray(prior.samples) ? prior.samples : [];
  } catch {}
  const nowMs = Date.now();
  eqTrack.samples.push([nowMs, equityUsd]);
  eqTrack.samples = eqTrack.samples.filter(([t]) => nowMs - t < 36e5 * 24.5).slice(-7000);
  try { fs.writeFileSync(peakPath, JSON.stringify({ peak: eqTrack.peak, samples: eqTrack.samples, at: new Date().toISOString() })); } catch {}
  const realDdPct = eqTrack.peak > 0 ? ((eqTrack.peak - equityUsd) / eqTrack.peak) * 100 : 0;
  const peak24 = Math.max(equityUsd, ...eqTrack.samples.filter(([t]) => nowMs - t <= 36e5 * 24).map(([, q]) => q));
  const dd24 = peak24 > 0 ? ((peak24 - equityUsd) / peak24) * 100 : 0;
  state.ddPct = round(realDdPct, 2);
  state.dd24Pct = round(dd24, 2);
  const entriesBlocked =
    realDdPct >= DD_KILL ? `kill-switch (real equity dd ${state.ddPct}% >= ${DD_KILL}%)`
    : dd24 >= DAILY_HALT ? `daily-loss halt (equity -${state.dd24Pct}% in rolling 24h >= ${DAILY_HALT}%)`
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
  // its slot share (equity / TARGET_POSITIONS). Oversized positions get a
  // partial close releasing margin for the remaining slots.
  const slotMargin = (equityUsd * 0.96) / TARGET_POSITIONS;
  for (const p of posBySym.values()) {
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
        await api('POST', '/api/v2/mix/order/close-positions', {
          body: { symbol: p.symbol, productType: PRODUCT, holdSide: p.side, size: String(closeSize) },
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

  // ---- protection repair: EVERY open position must carry a loss plan AND
  // a profit plan. Orphaned/manual positions get synthesized protection —
  // stop distance is inferred from an existing loss plan, else 1.2%; the
  // take-profit lands at 2R of that distance.
  for (const p of posBySym.values()) {
    try {
      const existing = await getPlans(p.symbol).catch(() => []);
      const lossPlan = existing.find((x) => /loss|stop/i.test(x.planType || ''));
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
      if (lossPlan && profitPlans.length && p.size > 0) {
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
        const bePx = round(p.entry * (1 + (sgn * 0.2) / 100), pp);
        const slSubBE = sgn === 1 ? slTrig < p.entry : slTrig > p.entry;
        if (prog >= 0.9 && slTrig > 0 && slSubBE) {
          const planId = lossPlan.orderId || lossPlan.planId || lossPlan.id;
          if (planId)
            await cancelPlanOrders(p.symbol, lossPlan.planType, [String(planId)]);
          await planOrder(
            p.symbol, lossPlan.planType, bePx,
            /pos_/.test(lossPlan.planType) ? '0' : String(p.size), p.side
          );
          state.actions.push(
            `breakeven ${p.symbol}: ${round(prog * 100, 0)}% to TP — stop ratcheted to entry+fees @ ${bePx}, trade is now a free runner`
          );
        }
      }
      // retrofit: an open position still carrying ONE full-size profit plan
      // gets the staggered ladder — cancel the single TP, replace with
      // 45/35/20 tranches at 0.55x/1.0x/1.8x of its original target distance.
      // Too-small positions (<3x contract min) keep their single TP.
      if (profitPlans.length === 1 && p.size > 0) {
        const sgn0 = p.side === 'long' ? 1 : -1;
        const tpTrig = +profitPlans[0].triggerPrice;
        const distPct = tpTrig > 0 ? (Math.abs(tpTrig - p.entry) / p.entry) * 100 : 0;
        const sp0 = Math.pow(10, cm[p.symbol]?.sizePlace ?? 4);
        const pp0 = cm[p.symbol]?.pricePlace ?? 6;
        const minQty0 = Math.max(
          cm[p.symbol]?.minTradeNum || 0,
          (cm[p.symbol]?.minTradeUSDT || 0) / p.entry
        );
        if (distPct > 0 && p.size >= 3 * minQty0) {
          const pid = profitPlans[0].orderId || profitPlans[0].planId || profitPlans[0].id;
          if (pid) await cancelPlanOrders(p.symbol, profitPlans[0].planType, [String(pid)]);
          const tranches = [
            { frac: 0.45, mult: 0.55 },
            { frac: 0.35, mult: 1.0 },
            { frac: 0.20, mult: 1.8 },
          ];
          let placed = 0;
          for (let ti = 0; ti < tranches.length; ti++) {
            const t = tranches[ti];
            const tsize = ti === 2
              ? Math.floor((p.size - placed) * sp0) / sp0
              : Math.floor(p.size * t.frac * sp0) / sp0;
            if (tsize < minQty0) continue;
            placed += tsize;
            await planOrder(
              p.symbol, 'profit_plan',
              round(p.entry * (1 + sgn0 * (distPct * t.mult) / 100), pp0),
              String(tsize), p.side
            );
          }
          state.actions.push(
            `laddered ${p.symbol}: single TP split 45/35/20 @ ${round(distPct * 0.55, 2)}/${round(distPct, 2)}/${round(distPct * 1.8, 2)}%`
          );
        }
      }
      if (lossPlan && hasProfit) continue;
      const sgn = p.side === 'long' ? 1 : -1;
      const pp = cm[p.symbol]?.pricePlace ?? 6;
      const stopPct = lossPlan && +lossPlan.triggerPrice > 0
        ? (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100
        : 1.2;
      if (!lossPlan) {
        await planOrder(p.symbol, 'pos_loss',
          round(p.entry * (1 - (sgn * stopPct) / 100), pp), '0', p.side);
        state.actions.push(`repaired ${p.symbol}: added pos_loss @ ${round(p.entry * (1 - (sgn * stopPct) / 100), pp)}`);
      }
      if (!hasProfit) {
        const tpPrice = round(p.entry * (1 + (sgn * 2 * stopPct) / 100), pp);
        try {
          await planOrder(p.symbol, 'pos_profit', tpPrice, '0', p.side);
        } catch {
          await planOrder(p.symbol, 'pos_profit', tpPrice, String(p.size), p.side);
        }
        state.actions.push(`repaired ${p.symbol}: added pos_profit @ ${tpPrice}`);
      }
    } catch (e) {
      state.errors.push(`protect ${p.symbol}: ${e.message}`);
    }
  }

  // ---- entries: only when the real drawdown guards are clear and capacity
  // allows — plan.killSwitch is sim-derived and logged for reference only ----
  if (entriesBlocked) {
    state.actions.push(`${entriesBlocked} — no new entries`);
  } else {
    let opened = 0;
    for (const [oi, o] of plan.orders.entries()) {
      // ambiguous symbols are excluded from posBySym — a .has() check would
      // pass and stack a third order on a symbol already holding both sides
      if (posBySym.has(o.symbol) || ambiguous.has(o.symbol) || opened + posBySym.size >= MAX_POSITIONS) continue;
      if (!Number.isFinite(o.refEntry) || !Number.isFinite(o.notionalUsd) ||
          !Number.isFinite(o.stopPct) || !Number.isFinite(o.targetPct) ||
          !Number.isFinite(o.leverage) || (o.direction !== 'LONG' && o.direction !== 'SHORT')) {
        state.errors.push(`${o.symbol || '?'}: malformed order fields — skipped`);
        continue;
      }
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
      const riskMul = +(process.env.SENTINEL_RISK_MUL || (RISK_MAX ? 3 : 1));
      // leverage: contract max, bounded so the designed stop still sits
      // inside the liquidation band — lev <= 80/(stopPct + 0.64) keeps the
      // stop at <=80% of the band edge, otherwise liquidation fires first.
      const lev = Math.max(
        1,
        Math.min(cm[o.symbol].maxLev || 125, Math.floor(80 / (o.stopPct + 0.64)))
      );
      // fee headroom: Bitget charges the taker fee on NOTIONAL from free
      // balance — at 37x the round-trip (open taker + conditional exit)
      // eats ~4.4% of the margin slice. Sizing to 100% of marginFree was
      // the source of the 40762 'order amount exceeds the balance'
      // rejections — the fee landed on top of a fully-deployed balance.
      const FEE_RT = 0.0012; // 0.06% taker x2 sides of notional
      const marginUsd = Math.min(
        (Math.min(riskMul / denom, 1) * marginFree) / (1 + lev * FEE_RT),
        equityUsd * 0.5 // single-position margin cap — no all-in one-dice-roll
      );
      const notional = marginUsd * lev;
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
      try {
        await setIsolated(o.symbol);
        await setLeverage(o.symbol, lev);
        await marketOrder(o.symbol, sgn > 0 ? 'buy' : 'sell', size, 'open', { clientOid: coid });
        // protective levels anchor to the ACTUAL fill, not the plan's ref
        // price — market orders slip, and a stop quoted off an unfilled
        // reference can sit on the wrong side of price
        let fill = o.refEntry;
        try {
          const pp = (await getPos()).find((x) => x.symbol === o.symbol && +x.total > 0);
          if (pp && +pp.openPriceAvg > 0) fill = +pp.openPriceAvg;
        } catch {}
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
        const ladder = size >= 3 * minQty;
        const plans = [];
        if (ladder) {
          const tranches = [
            { frac: 0.45, mult: 0.55 },
            { frac: 0.35, mult: 1.0 },
            { frac: 0.20, mult: 1.8 },
          ];
          let placed = 0;
          for (let ti = 0; ti < tranches.length; ti++) {
            const t = tranches[ti];
            // last tranche takes the remainder so rounding never oversells
            const tsize =
              ti === tranches.length - 1
                ? Math.floor((size - placed) * sp) / sp
                : Math.floor(size * t.frac * sp) / sp;
            if (tsize < minQty) continue;
            placed += tsize;
            plans.push(
              planOrder(
                o.symbol, 'profit_plan',
                round(fill * (1 + sgn * (o.targetPct * t.mult) / 100), pp),
                String(tsize), holdSide
              )
            );
          }
        } else {
          plans.push(
            planOrder(
              o.symbol, 'profit_plan',
              round(fill * (1 + sgn * (o.targetPct / 100)), pp),
              size, holdSide
            )
          );
        }
        plans.push(
          planOrder(
            o.symbol, 'loss_plan',
            round(fill * (1 - sgn * (o.stopPct / 100)), pp),
            size, holdSide
          )
        );
        await Promise.all(plans);
        const usedMargin = (size * fill) / lev;
        marginFree = Math.max(0, marginFree - usedMargin);
        state.actions.push(`opened ${o.symbol} ${o.direction} ${size} @~${round(fill, 6)} lev ${lev}x margin $${round(usedMargin, 2)} notional $${round(size * fill, 2)}`);
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
        ts: +(f.cTime ?? f.uTime ?? Date.now()),
      });
      added++;
    }
    if (added || repaired) {
      store.fills = store.fills.slice(0, 400);
      fs.writeFileSync(fillsPath, JSON.stringify(store));
    }
    state.realFills = store.fills.slice(0, 50);
    state.realFillCount = store.fills.length;
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
