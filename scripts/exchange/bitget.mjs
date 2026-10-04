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
    }).then((d) => {
      if (d?.posMode === 'hedge_mode') return 'hedge';
      if (d?.posMode === 'one_way_mode') return 'oneway';
      throw new Error(`unexpected Bitget position mode for ${symbol}: ${d?.posMode ?? 'missing'}`);
    });

  // ---------- order placement ----------
  // Bitget answers "already isolated" with an error, which invites a blanket
  // catch — and that catch also swallows real failures, leaving the symbol CROSS
  // while the order below still carries marginMode:'isolated'. So: keep the
  // non-fatal catch for the idempotent case, then VERIFY the position row and
  // throw on mismatch so the entry is refused instead of silently cross.
  const isIsolated = async (symbol) => {
    const rows = await getPos().catch(() => []);
    const row = (rows || []).find((x) => x.symbol === symbol && +x.total > 0);
    // No open position yet: nothing to verify, but the mode was just requested.
    return !row || row.marginMode === 'isolated';
  };
  const setIsolated = async (symbol) => {
    await api('POST', '/api/v2/mix/account/set-margin-mode', {
      body: { symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, marginMode: 'isolated' },
    }).catch(() => {}); // already-isolated is idempotent; the check below is the guard
    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      const rows = await getPos().catch(() => []);
      row = (rows || []).find((x) => x.symbol === symbol && +x.total > 0) || null;
      if (!row) await new Promise((r) => setTimeout(r, 700));
    }
    if (row && row.marginMode !== 'isolated') {
      const err = new Error(
        `ISOLATION FAILED for ${symbol}: margin mode is ${row.marginMode}, not isolated — ` +
        'refusing to open cross.'
      );
      err.code = 'E_ISOLATION_FAILED';
      throw err;
    }
    return row;
  };
  const setLeverage = (symbol, leverage) =>
    api('POST', '/api/v2/mix/account/set-leverage', {
      body: { symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, leverage: String(leverage) },
    });
  // POS_MODE is account-wide ('one_way_mode' | 'hedge_mode') and Bitget REJECTS
  // any order whose posSide contradicts it:
  //   40774 "The order type for unilateral position must also be the
  //          unilateral position type."
  // This adapter shipped a hardcoded POS_MODE='oneway' default and never sent
  // posSide at all, so on this account (hedge_mode, measured) EVERY order was
  // rejected and nothing could be opened. Guessing is not an option here:
  // POS_MODE starts UNKNOWN and is read from the venue on first use, and an
  // unresolvable mode throws instead of ordering blind.
  let POS_MODE = null;
  let POS_MODE_PROBE = null;
  async function resolvePosMode(symbol) {
    if (POS_MODE) return POS_MODE;
    if (!POS_MODE_PROBE)
      POS_MODE_PROBE = getPosMode(symbol).catch((e) => {
        POS_MODE_PROBE = null; // never cache a transient failure
        throw e;
      });
    POS_MODE = await POS_MODE_PROBE;
    return POS_MODE;
  }

  // posSide names the POSITION, not the order flow. In hedge mode the two are
  // independent, so a close must carry BOTH posSide (which position) and the
  // opposite side (the direction that reduces it).
  const hedgeFields = (side, intent) => {
    const posSide = intent === 'close'
      ? (side === 'sell' ? 'long' : 'short') // a 'sell' reduces a long
      : (side === 'buy' ? 'long' : 'short');
    return {
      posSide,
      side: intent === 'close' ? (posSide === 'long' ? 'sell' : 'buy') : side,
      tradeSide: intent === 'close' ? 'close' : 'open',
    };
  };
  const onewayFields = (side, intent) => ({
    posSide: 'net',
    side,
    ...(intent === 'close' ? { reduceOnly: 'YES' } : {}),
  });

  // Callers use `extra` for BOTH real Bitget wire fields (clientOid) and local
  // journal metadata (refEntry, audUsd). Spreading the lot into the request body
  // sent refEntry/audUsd to the exchange as unknown order params. Only genuine
  // wire fields are forwarded now.
  const WIRE_KEYS = new Set([
    'clientOid', 'reduceOnly', 'timeInForceValue', 'postOnly', 'hidden', 'iceberg',
    'triggerPrice', 'triggerBy', 'stpMode', 'presetTakeProfitList', 'presetStopLossList',
  ]);
  const wire = (extra) =>
    Object.fromEntries(
      Object.entries(extra || {}).filter(([k, v]) => WIRE_KEYS.has(k) && v !== undefined)
    );

  const orderBody = (symbol, side, size, intent, orderType, price, extra) => ({
    symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MARGIN_COIN,
    size: String(size), orderType,
    ...(price != null ? { price: String(price) } : {}),
    ...(POS_MODE === 'hedge' ? hedgeFields(side, intent) : onewayFields(side, intent)),
    ...wire(extra),
  });

  const marketOrder = async (symbol, side, size, intent, extra = {}) => {
    await resolvePosMode(symbol);
    return api('POST', '/api/v2/mix/order/place-order', {
      body: orderBody(symbol, side, size, intent, 'market', null, extra),
    });
  };
  const limitOrder = async (symbol, side, size, price, extra = {}, intent = 'open') => {
    await resolvePosMode(symbol);
    return api('POST', '/api/v2/mix/order/place-order', {
      body: { ...orderBody(symbol, side, size, intent, 'limit', price, extra), timeInForceValue: 'post_only' },
    });
  };
  // exec sets POS_MODE via this hook after getPosMode; also clears the probe so
  // the next order trusts the caller's explicit answer.
  // An unrecognised value THROWS rather than silently becoming 'oneway': this
  // hook is how callers hand over the venue's answer, and a typo'd or error
  // string coerced to 'oneway' on a hedge account reproduces the 40774 failure
  // this adapter was fixed to eliminate.
  const setPosMode = (m) => {
    if (m !== 'hedge' && m !== 'oneway') {
      const e = new Error('setPosMode: expected "hedge" or "oneway", got ' + JSON.stringify(m));
      e.code = 'E_BAD_POS_MODE';
      throw e;
    }
    POS_MODE = m;
    POS_MODE_PROBE = null;
  };
  const getResolvedPosMode = () => POS_MODE;

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
    getResolvedPosMode,
    setIsolated,
    isIsolated,
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
  };
}
