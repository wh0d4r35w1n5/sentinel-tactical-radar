// exchange/bitget.mjs — Bitget USDT-M futures adapter.
// Extracted verbatim from bitget-exec.mjs — same endpoints, same wire shapes,
// same paptrading demo header. The interface returned here is what the
// executor consumes; bybit.mjs returns identical shapes.
import crypto from 'node:crypto';
import path from 'node:path';
import { createEntryGuard, readJson, ROOT, validateRiskPolicy } from '../execution-risk.mjs';

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
  let entryGuard;
  async function transport(method, reqPath, { qs = '', body = null } = {}) {
    const bodyStr = body ? JSON.stringify(body) : '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
          method,
          headers: signHeaders(method, reqPath, qs, bodyStr),
          body: bodyStr || undefined,
          signal: AbortSignal.timeout(+(process.env.SENTINEL_API_TIMEOUT_MS || 15000)),
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
  const api = (method, reqPath, options = {}) =>
    entryGuard.run(method, reqPath, options.body, () => transport(method, reqPath, options));
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
      available: +(acc.available ?? 0),
      isoMax: +acc.isolatedMaxAvailable,
      crossMax: +acc.crossedMaxAvailable,
    };
  };
  // pending-plan query REQUIRES planType — 'profit_loss' is the umbrella that
  // covers profit_plan/loss_plan/moving_plan/pos_profit/pos_loss
  const getPlans = (symbol) =>
    api('GET', '/api/v2/mix/order/orders-plan-pending', {
      qs: `productType=${PRODUCT}&marginCoin=${MARGIN_COIN}&planType=profit_loss${symbol ? `&symbol=${symbol}` : ''}`,
    }).then((d) => {
      if (Array.isArray(d)) return d;
      const l = d?.entrustedList ?? d?.orders ?? [];
      return Array.isArray(l) ? l : []; // {entrustedList:null} = empty book, not an error
    });
  // position mode is account-wide per product type
  const getPosMode = (symbol) =>
    api('GET', '/api/v2/mix/account/account', {
      qs: `symbol=${symbol}&productType=${PRODUCT}&marginCoin=${MARGIN_COIN}`,
    }).then((d) => (d?.posMode === 'hedge_mode' ? 'hedge' : 'oneway'));
  const getMarginMode = (symbol) =>
    api('GET', '/api/v2/mix/account/account', {
      qs: `symbol=${symbol}&productType=${PRODUCT}&marginCoin=${MARGIN_COIN}`,
    }).then((d) => d?.marginMode || null);

  // ---------- order placement ----------
  const setIsolated = (symbol) =>
    api('POST', '/api/v2/mix/account/set-margin-mode', {
      body: { symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, marginMode: 'isolated' },
    }); // A failed margin-mode change is not permission to open in crossed mode.
  const setLeverage = (symbol, leverage) => {
    if (!Number.isFinite(+leverage) || +leverage < 1) throw new Error('invalid leverage');
    return api('POST', '/api/v2/mix/account/set-leverage', {
      body: { symbol, productType: PRODUCT, marginCoin: MARGIN_COIN, leverage: String(Math.floor(+leverage)) },
    });
  };
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
    api('GET', '/api/v2/mix/order/orders-pending', { qs: `productType=${PRODUCT}${symbol ? `&symbol=${symbol}` : ''}` })
      .then((d) => {
        if (Array.isArray(d)) return d;
        if (d && ('orders' in d || 'entrustedList' in d))
          return d.orders ?? d.entrustedList ?? []; // {entrustedList:null} = documented empty book
        throw new Error('unreadable pending orders');
      });

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
  const getFills = ({ symbol, startTime, limit } = {}) =>
    api('GET', '/api/v2/mix/order/fills', {
      qs: `productType=${PRODUCT}&limit=${limit || 100}&startTime=${startTime || Date.now() - 48 * 3600e3}${symbol ? `&symbol=${symbol}` : ''}`,
    }).then((d) => {
      const l = d?.fillList || d?.fills || d;
      const rows = Array.isArray(l) ? l : [];
      return symbol ? rows.filter((r) => r.symbol === symbol) : rows;
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
        signal: AbortSignal.timeout(+(process.env.SENTINEL_API_TIMEOUT_MS || 15000)),
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
        sizeMultiplier: +c.sizeMultiplier || 10 ** -(+c.volumePlace || 0),
        pricePlace: +c.pricePlace ?? 6,
        minTradeNum: +c.minTradeNum || 0,
        minTradeUSDT: +c.minTradeUSDT || 0,
        maxLev: +c.maxLever || 0,
      };
    return m;
  }

  let contractsCache = null, contractsAt = 0;
  entryGuard = createEntryGuard({
    mode: MODE,
    snapshot: async (symbol) => {
      const risk = validateRiskPolicy(readJson(path.join(ROOT, 'state', 'execution-risk.json')));
      const wealth = readJson(path.join(ROOT, 'api', 'wealth-live.json'));
      const age = Date.now() - Date.parse(wealth.ts);
      if (!Number.isFinite(age) || age < 0 || age > risk.maxSnapshotAgeMs)
        throw new Error('entry-risk: stale ownable-equity snapshot');
      if (!contractsCache || Date.now() - contractsAt > 60000) {
        contractsCache = await contractMap(); contractsAt = Date.now();
      }
      const [account, allPos, pending, settings, tick] = await Promise.all([
        getAccount(), getPos(), pendingOrders(),
        api('GET', '/api/v2/mix/account/account', {
          qs: `symbol=${symbol}&productType=${PRODUCT}&marginCoin=${MARGIN_COIN}`,
        }), ticker(symbol),
      ]);
      if (!Array.isArray(allPos)) throw new Error('entry-risk: unreadable positions');
      const positions = allPos.filter(p => +p.total > 0);
      const plans = {};
      for (const p of positions) plans[p.symbol] = await getPlans(p.symbol);
      const grant = +wealth.futures?.grantUsd;
      const own = +wealth.futures?.equityOwnUsd;
      if (!Number.isFinite(grant) || grant < 0 || !Number.isFinite(own) || own < 0)
        throw new Error('entry-risk: unknown grant/ownable equity');
      const vault = readJson(path.join(ROOT, 'state', 'wealth-vault.json'), true);
      const reserved = Math.max(0, (+vault?.balanceUsd || 0) - (+vault?.transferredUsd || 0) - (+vault?.lostUsd || 0));
      return { equityUsd: Math.max(0, Math.min(own, account.equity - grant) - reserved),
        availableUsd: Math.min(account.available, own),
        positions, pending, plans, contract: contractsCache[symbol],
        price: +(Array.isArray(tick) ? tick[0]?.markPr || tick[0]?.lastPr : tick?.markPr || tick?.lastPr),
        actualLeverage: +(settings.isolatedLongLever ?? settings.leverage),
        marginMode: settings.marginMode };
    },
  });

  return {
    name: 'bitget',
    host: HOST,
    hasCreds: !!(key && secret && pass), // Bitget needs the passphrase too
    api,
    prepareEntry: entryGuard.prepare,
    completeEntry: entryGuard.complete,
    ticker,
    contractMap,
    getAccount,
    getPos,
    getPosMode,
    getMarginMode,
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
