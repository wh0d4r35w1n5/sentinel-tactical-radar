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
const KEY = process.env.BITGET_API_KEY || '';
const SECRET = process.env.BITGET_API_SECRET || '';
const PASS = process.env.BITGET_PASSPHRASE || '';
const LIVE_ARMED =
  process.env.SENTINEL_LIVE === '1' && process.env.CONFIRM_LIVE === 'YES';
const MAX_NOTIONAL = +(process.env.LIVE_MAX_NOTIONAL_USD || 50);
const MAX_POSITIONS = +(process.env.LIVE_MAX_POSITIONS || 3);
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
const getPlans = (symbol) =>
  api('GET', '/api/v2/mix/order/orders-plan-pending', {
    qs: `symbol=${symbol}&productType=${PRODUCT}`,
  }).then((d) => d?.entrustedList || d?.orders || d || []);
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
const planOrder = (symbol, planType, triggerPrice, size, holdSide) =>
  api('POST', '/api/v2/mix/order/place-plan-order', {
    body: {
      symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MARGIN_COIN,
      planType, triggerPrice: String(triggerPrice), executePrice: '0',
      triggerType: 'mark_price', size: String(size),
      side: holdSide === 'long' ? 'sell' : 'buy',
      holdSide,
      ...(POS_MODE === 'hedge' ? { tradeSide: 'close' } : {}),
    },
  });
const cancelPlans = (symbol, orderIds = null) =>
  api('POST', '/api/v2/mix/order/cancel-plan-order', {
    body: orderIds
      ? { symbol, productType: PRODUCT, orderIdList: orderIds.map((id) => ({ orderId: id })) }
      : { symbol, productType: PRODUCT },
  }).catch(() => {});
// cancel ONLY loss plans — a blanket cancel was wiping the TP ladder off
// the exchange every time a trail ratcheted
const cancelLossPlans = async (symbol) => {
  const plans = await getPlans(symbol).catch(() => []);
  const ids = (plans || [])
    .filter((p) => (p.planType || '').includes('loss') || (p.planType || '').includes('stop'))
    .map((p) => p.orderId)
    .filter(Boolean);
  if (ids.length) await cancelPlans(symbol, ids);
  return ids.length;
};

// ---------- contracts: size rounding + minimums ----------
async function contractMap() {
  const res = await fetch(
    `${HOST}/api/v2/mix/market/contracts?productType=${PRODUCT}`
  );
  const j = await res.json();
  const m = {};
  for (const c of j.data || [])
    m[c.symbol] = {
      sizePlace: +c.sizePlace || 0,
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
  const probeSym = (plan.orders[0] && plan.orders[0].symbol) || (plan.closes[0] && plan.closes[0].symbol) || 'BTCUSDT';
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
      await marketOrder(c.symbol, pos.side === 'long' ? 'sell' : 'buy', pos.size, 'close');
      state.actions.push(`closed ${c.symbol} ${pos.side} ${pos.size}`);
      posBySym.delete(c.symbol);
    } catch (e) {
      state.errors.push(`close ${c.symbol}: ${e.message}`);
    }
  }

  // ---- trail amends: cancel+replace the loss plan at the ratcheted level ----
  for (const t of plan.trails) {
    const pos = posBySym.get(t.symbol);
    if (!pos || !Number.isFinite(t.entry) || !Number.isFinite(t.stopPctFromEntry)) continue;
    const px = t.entry * (1 + (t.direction === 'LONG' ? 1 : -1) * (t.stopPctFromEntry / 100));
    try {
      await cancelLossPlans(t.symbol); // loss plans only — the TP ladder stays
      await planOrder(t.symbol, 'loss_plan', round(px, 6), pos.size, pos.side);
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
      if (posBySym.has(o.symbol) || opened + state.positions.length >= MAX_POSITIONS) continue;
      if (!Number.isFinite(o.refEntry) || !Number.isFinite(o.notionalUsd) ||
          !Number.isFinite(o.stopPct) || !Number.isFinite(o.targetPct) ||
          !Number.isFinite(o.leverage) || (o.direction !== 'LONG' && o.direction !== 'SHORT')) {
        state.errors.push(`${o.symbol || '?'}: malformed order fields — skipped`);
        continue;
      }
      const notional = Math.min(o.notionalUsd * scale, MAX_NOTIONAL);
      const size = sizeFor(cm, o.symbol, notional, o.refEntry);
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
        const tpPlans = (o.tps || []).map((tp) => {
          const rung = Math.floor(size * tp.frac * cp) / cp;
          return rung > 0
            ? planOrder(o.symbol, 'profit_plan', round(fill * (1 + sgn * tp.at * (o.targetPct / 100)), 6), rung, holdSide)
            : null;
        }).filter(Boolean);
        const slPlan = planOrder(
          o.symbol, 'loss_plan',
          round(fill * (1 - sgn * (o.stopPct / 100)), 6),
          size, holdSide
        );
        await Promise.all([...tpPlans, slPlan]);
        state.actions.push(`opened ${o.symbol} ${o.direction} ${size} @~${round(fill, 6)} lev ${o.leverage}x notional $${round(notional, 2)}`);
        opened++;
      } catch (e) {
        // entry filled but protection failed -> close immediately, never naked
        state.errors.push(`open ${o.symbol}: ${e.message} — attempting emergency close`);
        try {
          const p = posBySym.get(o.symbol) || (await getPos()).find((x) => x.symbol === o.symbol && +x.total > 0);
          if (p) {
            await cancelPlans(o.symbol);
            await marketOrder(o.symbol, (p.holdSide || p.side) === 'long' ? 'sell' : 'buy', +(p.total || p.size), 'close');
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
  fs.writeFileSync(outPath, JSON.stringify(state));
  log(`done — ${state.actions.length} actions, ${state.errors.length} errors`);
  if (state.errors.length) console.log(state.errors.join('\n'));
}

main().catch((e) => {
  console.error('[exec] fatal:', e.message);
  process.exitCode = 1;
});
