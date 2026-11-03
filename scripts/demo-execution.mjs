import fs from 'node:fs';
import crypto from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = (o) => ['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled'].includes(o?.orderStatus);
const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
};
const write = (file, data) => {
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
};
const roundDown = (qty, c) => {
  const step = +c.sizeMultiplier || 10 ** -c.sizePlace;
  return +(Math.floor((qty + step * 1e-9) / step) * step).toFixed(c.sizePlace);
};

export function demoSize({ wanted, price, leverage, stopPrice, contract, marginCap = 150, notionalCap = 1500, riskCap = 15 }) {
  if (![wanted, price, leverage, stopPrice, marginCap, notionalCap, riskCap].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('invalid demo size inputs');
  const unitRisk = Math.abs(price - stopPrice) + price * 0.0017;
  const size = roundDown(Math.min(wanted, marginCap * leverage / price, notionalCap / price, riskCap / unitRisk), contract);
  const minimum = Math.max(+contract.minTradeNum || 0, (+contract.minTradeUSDT || 0) / price);
  return size >= minimum ? size : 0;
}

async function settleOrder(X, order, pause) {
  let row;
  for (let i = 0; i < 10; i++) {
    row = await X.getOrder(order.symbol, order);
    if (terminal(row)) return row;
    if (row?.orderId) {
      // A cancel acknowledgement is not final: the order may fill during cancellation.
      await X.cancelOrder(order.symbol, row.orderId).catch(() => {});
    }
    await pause(300);
  }
  // Invisible to realtime AND history past the consistency window = the
  // exchange never accepted it (gateway reject predating the refuse list,
  // or a POST that never arrived). A nonexistent order cannot be working
  // or filled — resolve as zero-fill rather than block entries forever.
  if (!row && Date.now() - (+order.at || 0) > 120_000) {
    return { orderStatus: 'Rejected', rejectReason: 'order-not-found-after-120s', cumExecQty: '0', cumExecValue: '0' };
  }
  throw new Error(`unresolved demo order ${order.symbol}/${order.clientOid}; entries blocked until reconciled`);
}

export async function reconcileDemoEntries(X, file, pause = sleep) {
  const pending = read(file), unresolved = [];
  for (const [id, order] of Object.entries(pending)) {
    try {
      await settleOrder(X, order, pause);
      delete pending[id];
      write(file, pending);
    } catch (e) { unresolved.push(e.message); }
  }
  return unresolved;
}

// A maker attempt always has a stop attached. Any fallback waits for terminal
// order state and subtracts every partial fill, including cancellation races.
export async function executeDemoEntry({
  X, symbol, side, wanted, referencePrice, stopPrice, targetPct, leverage,
  contract, pendingFile, marginCap = 150, notionalCap = 1500, riskCap = 15,
  maker = true, waitMs = 2000, pause = sleep, clientOidBase = null,
}) {
  if (X.name !== 'bybit' || X.host !== 'https://api-demo.bybit.com') throw new Error('demo entry requires Bybit demo host');
  const pending = read(pendingFile);
  if (Object.keys(pending).length) throw new Error('unresolved demo orders; reconcile before entering');
  const sign = side === 'buy' ? 1 : -1;
  const positions = await X.getPos();
  if (positions.some((p) => p.symbol === symbol && +p.total > 0)) throw new Error('demo top-up refused');
  if ((await X.pendingOrders(symbol)).some((o) => !o.reduceOnly)) throw new Error('existing entry order on symbol');
  const quote = async () => {
    const q = await X.ticker(symbol), t = Array.isArray(q) ? q[0] : q;
    const bid = +t?.bidPr, ask = +t?.askPr;
    if (!(bid > 0 && ask >= bid)) throw new Error('missing or crossed quote');
    const px = side === 'buy' ? ask : bid;
    if ((px - stopPrice) * sign <= 0) throw new Error('entry invalidated at stop');
    if ((px - referencePrice) * sign / referencePrice > 0.0035) throw new Error('entry moved beyond chase budget');
    const mid = (ask + bid) / 2;
    // coarse-tick books: 1 tick can exceed 15bp of price (e.g. $0.005
    // instruments) — the budget is a cost floor, not a listing ban.
    const tickFloor = (+contract?.tickSize > 0) ? (2.5 * +contract.tickSize) / mid : 0;
    const spreadBudget = Math.max(0.0015, tickFloor);
    if ((ask - bid) / mid > spreadBudget) throw new Error(`spread exceeds ${Math.round(spreadBudget * 1e4)}bp budget`);
    return { bid, ask, px };
  };
  let q = await quote();
  const qty = demoSize({ wanted, price: q.px, leverage, stopPrice, contract, marginCap, notionalCap, riskCap });
  if (!qty) return { filled: 0, reason: 'contract minimum exceeds demo budget' };
  const stop = {
    stopLoss: String(stopPrice), slTriggerBy: 'MarkPrice',
    tpslMode: 'Full', slOrderType: 'Market',
  };
  let filled = 0, makerFilled = 0, cost = 0;
  const submittedOrders = [];
  const submit = async (kind, quantity, price) => {
    const clientOid = (clientOidBase ? `${clientOidBase}${kind === 'Market' ? 'm' : ''}` : 'sdl-' + crypto.randomUUID().replaceAll('-', '')).slice(0, 38);
    const order = { symbol, clientOid, at: Date.now() };
    pending[clientOid] = order;
    write(pendingFile, pending); // persist before POST, including an ambiguous network failure
    let ack;
    try {
      ack = kind === 'Limit'
        ? await X.limitOrder(symbol, side, quantity, price, { clientOid, ...stop })
        : await X.marketOrder(symbol, side, quantity, 'open', { clientOid, ...stop });
    } catch (e) {
      // Explicit exchange rejection creates no order; a timeout is ambiguous.
      if (/-> (10001|110004|110007|110012|110017|110021|110032|110094|110123|110126) /.test(e.message)) {
        delete pending[clientOid];
        write(pendingFile, pending);
      }
      throw e;
    }
    order.orderId = ack?.orderId;
    submittedOrders.push({ clientOid, orderId: order.orderId || null });
    write(pendingFile, pending);
    await pause(kind === 'Limit' ? waitMs : 250);
    const done = await settleOrder(X, order, pause);
    const amount = +done.cumExecQty || 0;
    filled += amount;
    cost += +done.cumExecValue || amount * (+done.avgPrice || price || q.px);
    if (kind === 'Limit') makerFilled += amount;
    delete pending[clientOid];
    write(pendingFile, pending);
  };
  if (maker) {
    const price = side === 'buy' ? q.bid : q.ask;
    await submit('Limit', qty, price);
  }
  let remainder = roundDown(qty - filled, contract);
  if (remainder > 0) {
    // Keep a partial maker fill when the quote no longer qualifies for a chase.
    try { q = await quote(); }
    catch (e) { return { filled, makerFilled, notionalUsd: cost, orders: submittedOrders, reason: e.message }; }
    const target = referencePrice * (1 + sign * targetPct / 100);
    const rewardPct = (target - q.px) * sign / q.px * 100;
    if (!(rewardPct >= 3 * 0.17))
      return { filled, makerFilled, notionalUsd: cost, orders: submittedOrders, reason: 'remaining target cannot cover 3x modeled trading costs' };
    const availableNotional = Math.min(notionalCap, marginCap * leverage) - cost;
    const spentRisk = Math.abs(cost - filled * stopPrice) + cost * 0.0017;
    remainder = Math.min(remainder, roundDown(Math.min(
      availableNotional / q.px,
      Math.max(0, riskCap - spentRisk) / (Math.abs(q.px - stopPrice) + q.px * 0.0017),
    ), contract));
    if (remainder >= Math.max(+contract.minTradeNum || 0, (+contract.minTradeUSDT || 0) / q.px))
      await submit('Market', remainder);
  }
  return { filled, makerFilled, notionalUsd: cost, orders: submittedOrders,
    reason: filled > 0 ? 'settled' : 'no fill; setup remains eligible' };
}
