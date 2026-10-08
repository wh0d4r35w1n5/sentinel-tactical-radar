// exchange/bitget.mjs — Bitget USDT-M futures adapter.
// Extracted verbatim from bitget-exec.mjs — same endpoints, same wire shapes,
// same paptrading demo header. The interface returned here is what the
// executor consumes; bybit.mjs returns identical shapes.
import crypto from 'node:crypto';

export function makeBitget({ key, secret, pass, mode } = {}) {
  const HOST = 'https://api.bitget.com';
  const PRODUCT = 'USDT-FUTURES';
  const MARGIN_COIN = 'USDT';
  const MODE = mode;

  // ---------- signed REST ----------
  function signHeaders(method, reqPath, qs, bodyStr) {
    const ts = String(Date.now());
    const pre = ts + method.toUpperCase() + reqPath + (qs ? '?' + qs : '') + (bodyStr || '');
    const sign = crypto.createHmac('sha256', secret).update(pre).digest('base64');
    const h = {
      'ACCESS-KEY': key,
      'ACCESS-SIGN': sign,
      'ACCESS-PASSPHRASE': pass,
      'ACCESS-TIMESTAMP': ts,
      'Content-Type': 'application/json',
      locale: 'en-US',
    };
    if (MODE === 'demo') h.paptrading = '1'; // Bitget demo-trading header
    return h;
  }
  async function api(method, reqPath, { qs = '', body = null } = {}) {
    const bodyStr = body ? JSON.stringify(body) : '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
          method,
          headers: signHeaders(method, reqPath, qs, bodyStr),
          body: bodyStr || undefined,
          signal: AbortSignal.timeout(15000), // a hung call must not stall the cycle
        });
        // 429 rate-limit on a GET is safe to retry after a pause — a throttled
        // read isn't an API rejection of the data, just the door closed briefly
        if (res.status === 429 && method === 'GET' && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        const j = await res.json().catch(() => ({}));
        if (!res.ok || (j.code && j.code !== '00000'))
          throw new Error(`${reqPath} ${method} -> ${j.code || res.status} ${j.msg || ''}`);
        return j.data;
      } catch (e) {
        // retry only transport failures on GETs — API rejections carry the
        // '->' marker, and a retried POST could double-fill an order that
        // actually executed before its response was lost
        if (attempt === 2 || e.message.includes('->') || method !== 'GET') throw e;
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
      isoMax: +acc.isolatedMaxAvailable,
      crossMax: +acc.crossedMaxAvailable,
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
  // position mode is account-wide per product type
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
  let POS_MODE = 'oneway'; // set by setPosMode before any order is placed
  const marketOrder = (symbol, side, size, intent, extra = {}) =>
    api('POST', '/api/v2/mix/order/place-order', {
      body: {
        symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MARGIN_COIN,
        size: String(size),
        // callers pass the ORDER side ('sell' reduces a long). Bitget hedge
        // closes want the POSITION side + tradeSide:'close' — invert here.
        side: intent === 'close' && POS_MODE === 'hedge'
          ? (side === 'sell' ? 'buy' : 'sell')
          : side,
        orderType: 'market',
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
  // exec sets POS_MODE via this hook after getPosMode
  const setPosMode = (m) => { POS_MODE = m === 'hedge' ? 'hedge' : 'oneway'; };

  const pendingOrders = (symbol) =>
    api('GET', '/api/v2/mix/order/orders-pending', { qs: `symbol=${symbol}&productType=${PRODUCT}` })
      .then((d) => { const l = d?.orders || d?.entrustedList || d; return Array.isArray(l) ? l : []; });

  const cancelOrder = (symbol, orderId) =>
    api('POST', '/api/v2/mix/order/cancel-order', {
      body: { symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, orderId },
    });

  // TP/SL plans go through place-tpsl-order — profit_plan/loss_plan are
  // illegal on place-plan-order (that endpoint is for trigger/moving orders).
  // holdSide identifies the protected side; no side/orderType needed.
  const planOrder = (symbol, planType, triggerPrice, size, holdSide, marginMode) =>
    api('POST', '/api/v2/mix/order/place-tpsl-order', {
      body: {
        symbol, productType: PRODUCT,
        // must match the POSITION's real margin mode — an 'isolated' plan on a
        // crossed position is accepted by the API then silently invalidated
        // seconds later, leaving the book naked while logging 'repaired'.
        // (6 dead pos_loss plans in plan history proved this live.)
        marginMode: marginMode === 'crossed' ? 'crossed' : 'isolated', marginCoin: MARGIN_COIN,
        planType, triggerPrice: String(triggerPrice), executePrice: /profit/.test(planType) ? String(triggerPrice) : '0', // TP legs limit@trigger — fee mandate; loss legs market (must fill)
        triggerType: 'mark_price', holdSide,
        // pos_profit/pos_loss cover the whole position — the API wants size
        // OMITTED for those, not a literal '0'
        ...(size === '0' || size == null ? {} : { size: String(size) }),
      },
    });
  const vaultTransfer = (amtUsd) =>
    api('POST', '/api/v2/spot/wallet/transfer', {
      body: {
        fromType: 'usdt_futures', toType: 'spot',
        amount: String(+(+amtUsd).toFixed(2)), coin: 'USDT',
        clientOid: `vault-${Date.now()}-${Math.round(amtUsd * 100)}`,
      },
    });
  // vault destination: BTC on SPOT. Market buy where `size` is the quote
  // (USDT) amount to spend — Bitget spot semantics for market buys.
  const spotMarketBuy = (symbol, quoteUsd) =>
    api('POST', '/api/v2/spot/trade/place-order', {
      body: {
        symbol, side: 'buy', orderType: 'market', force: 'normal',
        size: String(+(+quoteUsd).toFixed(2)),
        clientOid: `vaultbtc-${Date.now()}`.slice(0, 38),
      },
    });
  const spotAssets = () =>
    api('GET', '/api/v2/spot/account/assets', {})
      .then((d) => (Array.isArray(d) ? d : d?.assets || []));
  const getFills = () =>
    api('GET', '/api/v2/mix/order/fills', {
      qs: `productType=${PRODUCT}&limit=100&startTime=${Date.now() - 48 * 3600e3}`,
    }).then((d) => {
      const l = d?.fillList || d?.fills || d;
      return Array.isArray(l) ? l : [];
    });
  const closePosition = (symbol, holdSide) =>
    api('POST', '/api/v2/mix/order/close-positions', {
      body: { symbol, productType: PRODUCT, holdSide },
    });
  // cancel-plan-order requires the SPECIFIC planType (loss_plan, profit_plan,
  // pos_profit...) — 'profit_loss' is a query-only umbrella; sending it makes
  // the cancel silently no-op
  const cancelPlanOrders = (symbol, planType, orderIds) =>
    api('POST', '/api/v2/mix/order/cancel-plan-order', {
      body: {
        symbol, productType: PRODUCT, marginCoin: MARGIN_COIN,
        planType, orderIdList: orderIds.map((id) => ({ orderId: id })),
      },
    });

  // single-symbol ticker — returns Bitget's array shape [{lastPr,...}]
  const ticker = (symbol) =>
    api('GET', '/api/v2/mix/market/ticker', {
      qs: `symbol=${symbol}&productType=${PRODUCT}`,
    });

  // ---------- contracts ----------
  async function contractMap() {
    // the demo environment lists a SUBSET of the live catalog — fetching the
    // live list unsigned would size orders for symbols this environment
    // can't route. The demo header scopes the response to demo contracts.
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
        pricePlace: +c.pricePlace ?? 6,
        minTradeNum: +c.minTradeNum || 0,
        minTradeUSDT: +c.minTradeUSDT || 0,
        maxLev: +c.maxLever || 0,
      };
    return m;
  }

  return {
    name: 'bitget',
    host: HOST,
    hasCreds: !!(key && secret && pass), // Bitget needs the passphrase too
    api,
    ticker,
    contractMap,
    getAccount,
    getPos,
    getPosMode,
    setPosMode,
    setIsolated,
    setLeverage,
    marketOrder,
    limitOrder,
    pendingOrders,
    cancelOrder,
    planOrder,
    getPlans,
    cancelPlanOrders,
    getFills,
    closePosition,
    vaultTransfer,
    spotMarketBuy,
    spotAssets,
  };
}
