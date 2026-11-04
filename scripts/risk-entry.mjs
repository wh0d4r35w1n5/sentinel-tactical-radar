import fs from 'node:fs';
import path from 'node:path';
import { ROOT, EXIT_MODEL, canonicalCell, hourlyTrail, readJson } from './execution-risk.mjs';

const seatsFile = (root) => path.join(root, 'state', 'execution-seats.json');
const writeSeats = (root, seats) => {
  const file = seatsFile(root), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seats)); fs.renameSync(tmp, file);
};
export function executionSeat(position, root = ROOT) {
  try {
    const symbol = position.symbol || position.sym,
      side = String(position.holdSide || position.side || '').toLowerCase();
    const seat = readJson(seatsFile(root), true)?.[`${symbol}:${side}`];
    return seat?.exitModel === EXIT_MODEL && +seat.cTime === +position.cTime ? seat : null;
  } catch { return null; } // unreadable seats file must not kill a protection pass
}

export async function openRiskEntry(X, order, contract, { riskScale = 1, root = ROOT,
  sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const cell = canonicalCell(order.strategy, order.direction);
  const pocket = cell && `${cell}:${order.symbol}`;
  const allow = readJson(path.join(root, 'state', 'live-cell-allowlist.json'), true);
  const adm = readJson(path.join(root, 'state', 'cell-admission.json'), true);
  // OPEN SEASON (operator order 2026-11-04): unrecorded/unconvicted cells
  // admit at probation — convictions (dead, non-positive mean) still refuse.
  const openSeason = readJson(path.join(root, 'state', 'open-season.json'), true)?.enabled === true;
  const listed = openSeason || (allow?.enabled === true &&
    (allow?.cells?.includes(cell) || (pocket && allow?.cells?.includes(pocket))));
  const ev = (pocket && adm?.cells?.[pocket]) || adm?.cells?.[cell];
  let tier =
    ev?.status === 'live' && ev.source === 'validated-forward-exits' &&
    ev.episodes >= 3 ? 'live'
    : ev?.status === 'probation' && ev.source === 'mega-backtest-1m' &&
      ev.episodes >= 200 ? 'probation'
    : null;
  if (!tier && openSeason && ev?.status !== 'dead' && !(ev && !(ev.netAfterCost > 0)))
    tier = 'probation';
  if (!listed || !tier || (ev && !(ev.netAfterCost > 0)) ||
      (!openSeason && (
        (tier === 'live' && !(ev.ci?.[0] > 0)) ||
        (tier === 'probation' && !(ev.sqn >= 1 || ev.ci?.[0] > 0)))))
    throw new Error(`entry-risk: ${cell || order.strategy || 'unattributed'} has no qualifying evidence`);
  if (tier === 'probation') riskScale *= 0.5; // backtest-only proof earns half risk
  const price = +order.refEntry;
  if (!(price > 0) || !(+contract.pricePlace >= 0) || !(+contract.sizePlace >= 0))
    throw new Error('entry-risk: missing entry price or contract geometry');
  const tick = +contract.priceTick || 10 ** -(+contract.pricePlace || 0);
  // Parity with the tested model (full-backtest simTrade): stopPx =
  // structStopPx ?? entry*(1-1%). The structural invalidation (wyckoff.invalid,
  // the spring low) is the base stop; the K2 trail only ever tightens it —
  // peak−2·ATR14 appears by itself at the first protectRiskSeat pass with
  // peak=entry. A malformed/missing invalidation falls to the flat 1% grid,
  // exactly like the backtest.
  const structural = +(order.wyckInvalid ?? order.structInvalid);
  const shortDir = order.direction === 'SHORT';
  const rawStop = structural > 0
    ? (shortDir ? (structural > price ? structural : price * 1.01)
                : (structural < price ? structural : price * 0.99))
    : price * (shortDir ? 1.01 : 0.99);
  const stopPrice = +(Math.floor(rawStop / tick) * tick).toFixed(+contract.pricePlace || 0);
  const intent = { symbol: order.symbol, strategy: order.strategy, direction: order.direction,
    exitModel: EXIT_MODEL, entryPrice: price, stopPrice, riskScale };
  let approved = await X.prepareEntry(intent);
  // Skip no-op margin/leverage writes — Bitget can reject them and a spurious
  // refusal must not stall a valid entry.
  if (approved.marginMode !== 'isolated') await X.setIsolated(order.symbol);
  if (approved.actualLeverage !== approved.leverage)
  try { await X.setLeverage(order.symbol, approved.leverage); }
  catch (e) {
    const cap = /leverage is (\d+)x/i.exec(e.message || '');
    if (!cap || +cap[1] >= approved.leverage) throw e;
    approved = await X.prepareEntry({ ...intent, leverageCap: +cap[1],
      requestedNotionalUsd: approved.notionalUsd });
    if (approved.actualLeverage !== approved.leverage)
      await X.setLeverage(order.symbol, approved.leverage);
  }
  const assertFiveTpCapacity = (size) => {
    const cfg = readJson(path.join(root, 'state', 'rr-config.json'), true);
    const rungs = Array.isArray(cfg?.absPct) ? cfg.absPct.length : 0;
    const allocations = Array.isArray(cfg?.alloc) ? cfg.alloc.length : 0;
    if (rungs !== 5 || allocations !== 5)
      throw new Error('entry-risk: five-rung TP configuration is missing or inconsistent');
    const places = +contract.sizePlace;
    const lotStep = +contract.sizeMultiplier || 10 ** -places;
    const minimum = +contract.minTradeNum || lotStep;
    if (!Number.isFinite(lotStep) || lotStep <= 0 || !Number.isFinite(minimum) || minimum <= 0)
      throw new Error('entry-risk: invalid contract lot size for five-rung TP');
    const minSlice = Math.ceil((minimum - lotStep * 1e-9) / lotStep) * lotStep;
    const required = rungs * minSlice;
    if (+size + lotStep * 1e-9 < required)
      throw new Error('entry-risk: five-rung TP requires at least ' + required + ' ' + order.symbol + ' contracts; risk-sized ' + size);
  };
  assertFiveTpCapacity(approved.size);
  const openSide = order.direction === 'SHORT' ? 'sell' : 'buy';
  const holdSide = order.direction === 'SHORT' ? 'short' : 'long';
  try {
    await X.marketOrder(order.symbol, openSide, approved.size, 'open', {
      clientOid: approved.clientOid, presetStopLossPrice: String(stopPrice),
      presetStopLossExecutePrice: '0',
    });
  } catch (e) {
    // 40808 on exeStopLossPrice: this contract rejects the explicit '0'
    // execute price — resubmit with the field omitted (market-execute
    // implied). The permit diff only binds presetStopLossPrice, which is
    // unchanged; a consumed permit means we need a fresh prepareEntry.
    if (!/40808/.test(e.message || '')) throw e;
    approved = await X.prepareEntry({ ...intent });
    assertFiveTpCapacity(approved.size);
    await X.marketOrder(order.symbol, openSide, approved.size, 'open', {
      clientOid: approved.clientOid, presetStopLossPrice: String(stopPrice),
    });
  }
  let pos;
  for (let i = 0; i < 9; i++) {
    pos = (await X.getPos()).find(p => p.symbol === order.symbol && p.holdSide === holdSide && +p.total > 0);
    if (pos) break;
    await sleep(1000);
  }
  if (!pos) throw new Error('entry-risk: submitted order awaits exchange position indexing; further entries blocked');
  const seats = readJson(seatsFile(root), true) || {};
  const record = { symbol: order.symbol, side: holdSide, cTime: +pos.cTime,
    strategy: order.strategy, cell: cell, exitModel: EXIT_MODEL,
    entryPrice: +pos.openPriceAvg, initialStop: stopPrice, size: +pos.total,
    clientOid: approved.clientOid, leverage: +pos.leverage, riskUsd: approved.riskUsd,
    openedAt: +pos.cTime, at: Date.now() };
  seats[`${order.symbol}:${holdSide}`] = record;
  writeSeats(root, seats);
  try {
    const plans = await X.getPlans(order.symbol);
    const stopOk = (p) => /loss/.test(p.planType || '') &&
        (p.planType === 'pos_loss' || +p.size >= +pos.total) &&
        (holdSide === 'short' ? +p.triggerPrice <= stopPrice : +p.triggerPrice >= stopPrice);
    if (!plans.some(stopOk))
      await X.planOrder(order.symbol, 'pos_loss', String(stopPrice), '0', holdSide, pos.marginMode);
    await X.completeEntry(approved.clientOid);
  } catch (e) {
    // The seat is REAL and journaled — protection verifies on the next watch
    // cycle and the pending file reconciles once covered. Do not report the
    // position as refused; it exists on the exchange.
    return { ...approved, ...record, notionalUsd: +pos.total * +pos.openPriceAvg,
      marginUsd: +pos.total * +pos.openPriceAvg / +pos.leverage,
      protectionPending: e.message };
  }
  return { ...approved, ...record, notionalUsd: +pos.total * +pos.openPriceAvg,
    marginUsd: +pos.total * +pos.openPriceAvg / +pos.leverage };
}

const candleCache = new Map();
// The protection watcher owns this exit model. Exec and liq-guard must not
// overlay fee locks, ladders, tick trails, trims or expiry exits on these seats.
export async function protectRiskSeat(X, pos, contract, { now = Date.now(), root = ROOT } = {}) {
  const seat = executionSeat(pos, root);
  if (!seat) return false;
  const symbol = pos.symbol;
  const side = String(pos.holdSide || pos.side || 'long').toLowerCase() === 'short' ? 'short' : 'long';
  const S = side === 'short';
  const plans = await X.getPlans(symbol);
  const existing = plans.filter(p => /loss/.test(p.planType || '') &&
    (!p.holdSide || p.holdSide === side));
  const trig = existing.map(p => +p.triggerPrice).filter(x => x > 0);
  const priorStop = S ? Math.min(seat.initialStop, ...trig) : Math.max(seat.initialStop, ...trig);
  if (now - seat.openedAt >= 96 * 3600000) {
    await X.closePosition(symbol, side);
    return true;
  }
  let cached = candleCache.get(symbol);
  const hour = Math.floor(now / 3600000);
  if (!cached || cached.hour !== hour) {
    const rows = await X.api('GET', '/api/v2/mix/market/history-candles', {
      qs: new URLSearchParams({ symbol, productType: 'USDT-FUTURES', granularity: '1H',
        endTime: String(hour * 3600000 - 1), limit: '200' }).toString(),
    });
    if (!Array.isArray(rows)) throw new Error('hourly trail: unreadable candle history');
    cached = { hour, rows: rows.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })) };
    candleCache.set(symbol, cached);
  }
  const trail = hourlyTrail({ rows: cached.rows, entryPrice: seat.entryPrice,
    initialStop: seat.initialStop, priorStop, openedAt: seat.openedAt, now, side });
  const tick = +contract.priceTick || 10 ** -(+contract.pricePlace || 0);
  const trigger = +((S ? Math.ceil : Math.floor)((trail?.stop ?? priorStop) / tick) * tick).toFixed(+contract.pricePlace || 0);
  const mark = +pos.markPrice;
  if (!(mark > 0)) throw new Error('hourly trail: mark unavailable');
  if (S ? trigger <= mark : trigger >= mark) {
    // The closed-hour exit decision is already breached; never widen it to fit.
    await X.closePosition(symbol, side);
    return true;
  }
  const wholeStop = existing.find(p => p.planType === 'pos_loss' || +p.size >= +pos.total);
  if (!wholeStop || (S ? +wholeStop.triggerPrice > trigger : +wholeStop.triggerPrice < trigger)) {
    // Tighten-only ratchet: the new stop goes live BEFORE stale lower stops
    // are cancelled — no naked window — and priorStop feeding hourlyTrail
    // means an existing trigger can never sit above the computed stop.
    await X.planOrder(symbol, 'pos_loss', String(trigger), '0', side, pos.marginMode);
    const stale = existing.filter(p => S ? +p.triggerPrice > trigger + tick / 2 : +p.triggerPrice < trigger - tick / 2);
    const byType = new Map();
    for (const p of stale) {
      const id = p.orderId || p.id; if (!id) continue;
      const t = p.planType || 'pos_loss';
      byType.set(t, [...(byType.get(t) || []), String(id)]);
    }
    for (const [t, ids] of byType)
      await X.cancelPlanOrders(symbol, t, ids).catch(() => {});
  }
  return true;
}
