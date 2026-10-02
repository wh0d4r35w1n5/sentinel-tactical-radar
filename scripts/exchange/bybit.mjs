// exchange/bybit.mjs — Bybit V5 adapter.
// Returns Bitget-shaped rows everywhere so bitget-exec.mjs call sites and
// downstream journal/stats code don't care which exchange is underneath.
//
// Semantic mapping (Bitget → Bybit V5 linear):
//   pos_loss / pos_profit   → /v5/position/trading-stop  (tpslMode=Full)
//   profit_plan / loss_plan → /v5/order/create conditional (reduceOnly, MarkPrice trigger)
//   moving_plan (trailing)  → /v5/position/trading-stop trailingStop+activePrice
//   close-positions         → reduceOnly market order
//   vault sweep             → /v5/asset/transfer/inter-transfer UNIFIED→FUND
//   fills                   → /v5/execution/list
import crypto from 'node:crypto';

const dec = (s) => {
  // decimals implied by a step string ('0.001' → 3). Scientific-notation safe.
  const t = String(s ?? '0');
  if (!t.includes('e') && !t.includes('E')) {
    const i = t.indexOf('.');
    return i < 0 ? 0 : t.length - i - 1;
  }
  const [m, e] = t.toLowerCase().split('e');
  const i = m.indexOf('.');
  return Math.max(0, (i < 0 ? 0 : m.length - i - 1) - +e);
};

export function makeBybit({ key, secret, mode, recvWindow = '5000', host } = {}) {
  const HOST = host || (mode === 'demo' ? 'https://api-demo.bybit.com' : 'https://api.bybit.com');
  const CAT = 'linear'; // USDT perps — mirrors Bitget USDT-FUTURES scope
  const ACCT = process.env.BYBIT_ACCOUNT_TYPE || 'UNIFIED';
  const POS_IDX = +(process.env.BYBIT_POSITION_IDX ?? 0); // 0 = one-way (default)

  function sign(ts, payload) {
    return crypto
      .createHmac('sha256', secret)
      .update(ts + key + recvWindow + payload)
      .digest('hex');
  }

  async function api(method, reqPath, { qs = '', body = null } = {}) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const payload = method === 'GET' ? qs : bodyStr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ts = String(Date.now());
        const res = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
          method,
          headers: {
            'X-BAPI-API-KEY': key,
            'X-BAPI-SIGN': sign(ts, payload),
            'X-BAPI-SIGN-TYPE': '2',
            'X-BAPI-TIMESTAMP': ts,
            'X-BAPI-RECV-WINDOW': recvWindow,
            'Content-Type': 'application/json',
          },
          body: bodyStr || undefined,
          signal: AbortSignal.timeout(15000),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || (j.retCode && j.retCode !== 0))
          throw new Error(`${reqPath} ${method} -> ${j.retCode ?? res.status} ${j.retMsg || ''}`);
        return j.result;
      } catch (e) {
        if (attempt === 1 || e.message.includes('->') || method !== 'GET') throw e;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }

  // ---------- market data ----------
  const ticker = async (symbol) => {
    const r = await api('GET', '/v5/market/tickers', {
      qs: `category=${CAT}&symbol=${symbol}`,
    });
    const t = (r?.list || [])[0] || {};
    // Bitget row shape: lastPr/markPr/indexPr/bidPr/askPr used by exec —
    // returned as a single-element ARRAY because Bitget's ticker endpoint
    // returns a list and call sites do `Array.isArray(q) ? q[0] : q`
    return [{
      lastPr: t.lastPrice,
      markPr: t.markPrice,
      indexPr: t.indexPrice,
      bidPr: t.bid1Price,
      askPr: t.ask1Price,
      fundingRate: t.fundingRate,
      nextFundingTime: t.nextFundingTime,
    }];
  };

  const contractMap = async () => {
    const out = {};
    let cursor = '';
    for (;;) {
      const r = await api('GET', '/v5/market/instruments-info', {
        qs: `category=${CAT}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`,
      });
      for (const c of r?.list || []) {
        if (c.status !== 'Trading') continue;
        const lot = c.lotSizeFilter || {};
        const pf = c.priceFilter || {};
        const lev = c.leverageFilter || {};
        const sz = dec(lot.qtyStep ?? '0.001');
        const tick = +pf.tickSize;
        out[c.symbol] = {
          sizePlace: sz,
          pricePlace: dec(pf.tickSize ?? '0.01'),
          priceEndStep: '1',
          minTradeNum: lot.minOrderQty ?? '0',
          minTradeUSDT: lot.minNotionalValue ?? '0',
          maxLev: +lev.maxLeverage || 25,
          tickSize: tick,
          qtyStep: +lot.qtyStep,
        };
      }
      cursor = r?.nextPageCursor;
      if (!cursor) break;
    }
    return out;
  };

  // ---------- account / positions ----------
  const getAccount = async () => {
    const r = await api('GET', '/v5/account/wallet-balance', {
      qs: `accountType=${ACCT}`,
    });
    const a = (r?.list || [])[0] || {};
    const equity = +(a.totalEquity ?? 0);
    const avail = +(a.totalAvailableBalance || a.totalWalletBalance || 0);
    return { equity, available: avail, isoMax: avail, crossMax: avail };
  };

  // Normalize a Bybit position row → Bitget all-position row shape.
  const normPos = (p) => ({
    symbol: p.symbol,
    holdSide: p.side === 'Buy' ? 'long' : 'short',
    side: p.side === 'Buy' ? 'long' : 'short',
    total: p.size,
    available: p.size,
    openPriceAvg: p.avgPrice,
    unrealizedPL: p.unrealisedPnl,
    leverage: p.leverage,
    marginMode: +p.positionIM > 0 || p.tradeMode === 1 ? 'isolated' : 'crossed',
    liquidationPrice: p.liqPrice,
    markPrice: p.markPrice,
    cTime: p.createdTime,
    utime: p.updatedTime,
    positionIdx: p.positionIdx,
    takeProfit: p.takeProfit,
    stopLoss: p.stopLoss,
    trailingStop: p.trailingStop,
    tpslMode: p.tpslMode,
  });

  const getPos = async () => {
    const r = await api('GET', '/v5/position/list', {
      qs: `category=${CAT}&settleCoin=USDT&limit=200`,
    });
    return (r?.list || [])
      .filter((p) => +p.size > 0)
      .map(normPos);
  };

  const getPosMode = async () => {
    // Bybit hedge mode shows positions at positionIdx 1/2. Default = oneway.
    const r = await api('GET', '/v5/position/list', {
      qs: `category=${CAT}&settleCoin=USDT&limit=200`,
    });
    return (r?.list || []).some((p) => +p.positionIdx > 0) ? 'hedge' : 'oneway';
  };

  // ---------- margin / leverage ----------
  // Bybit's switch-isolated REQUIRES leverage in the same call (no bare
  // mode-set like Bitget). So setIsolated only marks intent; the actual
  // switch happens in setLeverage where leverage is known.
  const isoPending = new Set();
  const setIsolated = (symbol) => { isoPending.add(symbol); return Promise.resolve(); };
  const setLeverage = async (symbol, leverage) => {
    const lev = String(leverage);
    if (isoPending.has(symbol)) {
      isoPending.delete(symbol);
      try {
        return await api('POST', '/v5/position/switch-isolated', {
          body: { category: CAT, symbol, tradeMode: 1, buyLeverage: lev, sellLeverage: lev },
        });
      } catch (e) {
        // 110026/110043 = already isolated at this lev — fall through to set-leverage;
        // 10032 = demo sandbox doesn't support isolated margin — positions run
        // cross there; protection paths don't depend on margin mode.
        if (!/110026|110043|10032/.test(e.message)) throw e;
      }
    }
    return api('POST', '/v5/position/set-leverage', {
      body: { category: CAT, symbol, buyLeverage: lev, sellLeverage: lev },
    }).catch((e) => {
      if (!/110043/.test(e.message)) throw e; // 'leverage not modified' — benign
    });
  };

  // ---------- orders ----------
  const marketOrder = (symbol, side, size, intent, extra = {}) =>
    api('POST', '/v5/order/create', {
      body: {
        category: CAT,
        symbol,
        side: side === 'buy' || side === 'open_long' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: String(size),
        positionIdx: idxFor(side === 'buy' || side === 'open_long' ? 'Buy' : 'Sell', intent),
        ...(intent === 'close' ? { reduceOnly: true } : {}),
        ...extra,
      },
    });

  const limitOrder = (symbol, side, size, price, extra = {}) =>
    api('POST', '/v5/order/create', {
      body: {
        category: CAT,
        symbol,
        side: side === 'buy' || side === 'open_long' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        qty: String(size),
        price: String(price),
        timeInForce: 'PostOnly',
        positionIdx: idxFor(side === 'buy' || side === 'open_long' ? 'Buy' : 'Sell', 'open'),
        ...extra,
      },
    });

  const pendingOrders = async (symbol) => {
    const r = await api('GET', '/v5/order/realtime', {
      qs: `category=${CAT}&symbol=${symbol}&openOnly=0&limit=50`,
    });
    return (r?.list || [])
      .filter((o) => !o.stopOrderType) // conditional rows belong in getPlans
      .map((o) => ({
        orderId: o.orderId,
        clientOid: o.orderLinkId,
        symbol: o.symbol,
        price: o.price,
        size: o.qty,
        side: (o.side || '').toLowerCase(),
        orderType: (o.orderType || '').toLowerCase(),
        state: o.orderStatus,
        cTime: o.createdTime,
      }));
  };

  const cancelOrder = (symbol, orderId) =>
    api('POST', '/v5/order/cancel', {
      body: { category: CAT, symbol, orderId },
    });

  // ---------- TP/SL plans ----------
  // Whole-position legs ride the position's trading-stop; sized legs are
  // conditional reduceOnly orders. getPlans merges both into Bitget plan rows.
  const TPSL_IDS = { pos_loss: 'sl', pos_profit: 'tp' };

  const tradingStop = (symbol, fields, holdSide) =>
    api('POST', '/v5/position/trading-stop', {
      body: {
        category: CAT, symbol, tpslMode: 'Full',
        // positionIdx targets the POSITION: hedge long=1/short=2, oneway=0
        positionIdx: POS_MODE === 'hedge' ? (holdSide === 'long' ? 1 : 2) : POS_IDX,
        ...fields,
      },
    });

  const planOrder = async (symbol, planType, triggerPrice, size, holdSide, marginMode) => {
    if (planType === 'pos_loss' || planType === 'pos_profit') {
      const isSl = planType === 'pos_loss';
      return tradingStop(symbol, isSl
        ? { stopLoss: String(triggerPrice), slTriggerBy: 'MarkPrice' }
        : { takeProfit: String(triggerPrice), tpTriggerBy: 'MarkPrice' }, holdSide);
    }
    if (planType === 'moving_plan') {
      // Bitget moving_plan ≈ Bybit position trailing stop. triggerPrice
      // carries the callback distance in the exec's usage (moving plans are
      // placed with a distance arg); activate immediately.
      return tradingStop(symbol, {
        trailingStop: String(triggerPrice),
        slTriggerBy: 'MarkPrice',
      }, holdSide);
    }
    // sized legs (profit_plan / loss_plan) → conditional reduceOnly order.
    // Direction: TP on a long fires when price RISES; SL on a long when it
    // FALLS. triggerDirection: 1=rise, 2=fall.
    const isProfit = planType === 'profit_plan';
    const long = holdSide === 'long';
    const rise = isProfit === long;
    const closeSide = long ? 'Sell' : 'Buy';
    const body = {
      category: CAT,
      symbol,
      side: closeSide,
      orderType: isProfit ? 'Limit' : 'Market', // TP legs limit@trigger (fee mandate), SL market
      qty: String(size),
      reduceOnly: true,
      positionIdx: idxFor(closeSide, 'close'),
      triggerPrice: String(triggerPrice),
      triggerDirection: rise ? 1 : 2,
      triggerBy: 'MarkPrice',
      ...(isProfit ? { price: String(triggerPrice) } : {}),
    };
    return api('POST', '/v5/order/create', { body });
  };

  // Merge conditional orders + position-level TP/SL into Bitget plan rows.
  // Synthetic ids 'bbpos:sl:<sym>' / 'bbpos:tp:<sym>' mark position-level legs
  // so cancelPlanOrders knows to clear trading-stop rather than cancel an order.
  const getPlans = async (symbol) => {
    const rows = [];
    const [ord, ord2, pos] = await Promise.all([
      api('GET', '/v5/order/realtime', {
        qs: `category=${CAT}&symbol=${symbol}&orderFilter=StopOrder&openOnly=0&limit=50`,
      }).catch(() => null),
      api('GET', '/v5/order/realtime', {
        qs: `category=${CAT}&symbol=${symbol}&orderFilter=tpslOrder&openOnly=0&limit=50`,
      }).catch(() => null),
      api('GET', '/v5/position/list', {
        qs: `category=${CAT}&symbol=${symbol}`,
      }).catch(() => null),
    ]);
    for (const o of [...(ord?.list || []), ...(ord2?.list || [])]) {
      const st = o.stopOrderType || '';
      const moving = /trailing/i.test(st);
      const prof = /takeprofit/i.test(st);
      rows.push({
        planType: moving ? 'moving_plan' : prof ? 'profit_plan' : 'loss_plan',
        orderId: o.orderId,
        triggerPrice: o.triggerPrice,
        size: o.qty,
        holdSide: o.side === 'Sell' ? 'long' : 'short', // close side inverted
        cTime: o.createdTime,
      });
    }
    for (const p of pos?.list || []) {
      if (+p.size <= 0) continue;
      const hs = p.side === 'Buy' ? 'long' : 'short';
      if (+p.stopLoss > 0)
        rows.push({
          planType: 'pos_loss',
          orderId: `bbpos:sl:${p.symbol}:${p.positionIdx}`,
          triggerPrice: p.stopLoss,
          size: '0',
          holdSide: hs,
          cTime: p.updatedTime,
        });
      if (+p.takeProfit > 0)
        rows.push({
          planType: 'pos_profit',
          orderId: `bbpos:tp:${p.symbol}:${p.positionIdx}`,
          triggerPrice: p.takeProfit,
          size: '0',
          holdSide: hs,
          cTime: p.updatedTime,
        });
      if (+p.trailingStop > 0)
        rows.push({
          planType: 'moving_plan',
          orderId: `bbpos:ts:${p.symbol}:${p.positionIdx}`,
          triggerPrice: p.trailingStop,
          size: '0',
          holdSide: hs,
          cTime: p.updatedTime,
        });
    }
    return rows;
  };

  const cancelPlanOrders = async (symbol, planType, orderIds) => {
    for (const id of orderIds) {
      const s = String(id);
      if (s.startsWith('bbpos:')) {
        const [, kind, sym] = s.split(':');
        await tradingStop(sym || symbol, kind === 'sl'
          ? { stopLoss: '0' }
          : kind === 'tp'
            ? { takeProfit: '0' }
            : { trailingStop: '0' }).catch(() => {});
      } else {
        await api('POST', '/v5/order/cancel', {
          body: { category: CAT, symbol, orderId: s },
        }).catch(() => {});
      }
    }
    return { ok: true };
  };

  const cancelAllPlans = (symbol) =>
    api('POST', '/v5/order/cancel-all', {
      body: { category: CAT, symbol, orderFilter: 'StopOrder' },
    });

  // ---------- fills / closes / vault ----------
  // fills → the exec's journal shape: tradeId/symbol/side/price/baseVolume/
  // quoteVolume/fee/profit/tradeSide/cTime/enterPointSource. execValue is the
  // USDT notional (quoteVolume); execFee arrives positive as a cost.
  const getFills = async () => {
    const r = await api('GET', '/v5/execution/list', {
      qs: `category=${CAT}&limit=100&startTime=${Date.now() - 48 * 3600e3}`,
    });
    return (r?.list || []).map((f) => ({
      tradeId: f.execId,
      orderId: f.orderId,
      symbol: f.symbol,
      side: (f.side || '').toLowerCase(),
      tradeSide: +f.closedSize > 0 ? 'close' : 'open',
      price: f.execPrice,
      baseVolume: f.execQty,
      quoteVolume: f.execValue,
      feeDetail: [{ totalFee: -(+f.execFee || 0) }], // Bitget convention: negative = charge
      profit: f.execPnl,
      cTime: f.execTime,
      enterPointSource: 'api', // bot-routed — manual fills can't be distinguished on V5
    }));
  };

  // V5 has no close-positions endpoint — resolve live size, then a
  // reduceOnly market order flattens the position (mirrors Bitget's
  // close-positions semantic the exec relies on).
  const closePosition = async (symbol, holdSide) => {
    const r = await api('GET', '/v5/position/list', {
      qs: `category=${CAT}&symbol=${symbol}`,
    });
    const p = (r?.list || []).find(
      (x) => +x.size > 0 && (x.side === 'Buy' ? 'long' : 'short') === holdSide);
    if (!p) return { ok: true }; // already flat
    return api('POST', '/v5/order/create', {
      body: {
        category: CAT,
        symbol,
        side: p.side === 'Buy' ? 'Sell' : 'Buy',
        orderType: 'Market',
        qty: p.size,
        reduceOnly: true,
        positionIdx: +p.positionIdx,
      },
    });
  };

  // futures->spot on Bitget ≈ UNIFIED->FUND internal transfer on Bybit.
  const vaultTransfer = (amtUsd) =>
    api('POST', '/v5/asset/transfer/inter-transfer', {
      body: {
        transferId: crypto.randomUUID(),
        coin: 'USDT',
        amount: String(Math.round(amtUsd * 100) / 100),
        fromAccountType: 'UNIFIED',
        toAccountType: 'FUND',
      },
    });

  // hedge-mode positionIdx: open → order side (Buy=1/Sell=2); close → the
  // POSITION side (Sell order closing a long = idx 1). One-way mode = 0.
  let POS_MODE = 'oneway';
  const setPosMode = (m) => { POS_MODE = m === 'hedge' ? 'hedge' : 'oneway'; };
  const idxFor = (orderSide, intent) => {
    if (POS_MODE !== 'hedge') return POS_IDX;
    const buyPos = intent === 'close' ? orderSide === 'Sell' : orderSide === 'Buy';
    return buyPos ? 1 : 2;
  };

  return {
    name: 'bybit',
    host: HOST,
    hasCreds: !!(key && secret),
    setPosMode,
    api,
    ticker,
    contractMap,
    getAccount,
    getPos,
    getPosMode,
    setIsolated,
    setLeverage,
    marketOrder,
    limitOrder,
    pendingOrders,
    cancelOrder,
    planOrder,
    getPlans,
    cancelPlanOrders,
    cancelAllPlans,
    getFills,
    closePosition,
    vaultTransfer,
    TPSL_IDS,
  };
}
