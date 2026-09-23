// Live data shim for the Sentinel Tactical Radar terminal.
// Patches window.fetch so the app's /api calls are served fresh:
//  - GET market-scanner.json -> built live from Bitget public spot data
//  - POST config/bot-state/trades -> persisted to localStorage (static host
//    has no backend; makes the dry-run controls functional per-browser)
//  - GET config/bot-state/trades -> static snapshot merged with local state
// Any failure falls back to the original static-file fetch.
(function () {
  if (typeof fetch !== 'function' || typeof Response !== 'function') return;
  var orig = fetch.bind(window);
  var BASE = '/sentinel-tactical-radar/api/';
  var SYM_KEY = 'str-bitget-syms';
  var PULSE_KEY = 'str-live-pulse';
  var POST_KEY = 'str-post-state';
  var MIN_QV = 250000;
  var STABLE = {};
  'USDC USDT USD1 USDE USDD DAI FDUSD TUSD PYUSD RLUSD USDP GUSD USDY USTB BFUSD AUSD EUR EURC GBP BRL TRY AUD USDG CUSD XUSD USDS SUSDE'
    .split(' ').forEach(function (s) { STABLE[s] = 1; });

  var tickersCache = { t: 0, data: null };
  var postState = null;

  // ---- live ticker stream (Bitget public WS, REST fallback) ----
  var liveTick = {};       // instId -> latest ticker row
  var liveTickAt = 0;      // last ws update
  var ws = null, wsSubscribed = false, wsRetry = 0;

  function wsConnect(pairIds) {
    if (ws || typeof WebSocket !== 'function') return;
    try { ws = new WebSocket('wss://ws.bitget.com/v2/ws/public'); } catch (e) { return; }
    ws.onopen = function () {
      wsRetry = 0;
      var ids = pairIds || Object.keys(lastPairs || {});
      for (var i = 0; i < ids.length; i += 100) {
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: ids.slice(i, i + 100).map(function (id) {
            return { instType: 'USDT-FUTURES', channel: 'ticker', instId: id };
          }),
        }));
      }
      wsSubscribed = true;
    };
    ws.onmessage = function (e) {
      try {
        var m = JSON.parse(e.data);
        if (m && m.arg && m.arg.channel === 'ticker' && Array.isArray(m.data)) {
          m.data.forEach(function (d) { liveTick[d.instId] = d; });
          liveTickAt = Date.now();
          emitTick();
        }
      } catch (e2) {}
    };
    ws.onclose = ws.onerror = function () {
      ws = null; wsSubscribed = false;
      var delay = Math.min(30000, 2000 * ++wsRetry);
      setTimeout(function () { wsConnect(); }, delay);
    };
  }
  setInterval(function () {
    if (ws && ws.readyState === 1) { try { ws.send('ping'); } catch (e) {} }
  }, 25000);

  // pub/sub: pages can repaint on every WS tick (throttled ~2s)
  var tickSubs = [], tickTimer = 0;
  function emitTick() {
    if (tickTimer) return;
    tickTimer = setTimeout(function () {
      tickTimer = 0;
      tickSubs.forEach(function (f) { try { f(liveTick); } catch (e) {} });
    }, 2000);
  }
  window.__live = {
    onTick: function (f) { tickSubs.push(f); },
    price: function (sym) { var t = liveTick[sym]; return t ? +t.lastPr : null; },
    tick: liveTick,
  };

  var lastPairs = null;
  function maybeStream(pairs) {
    lastPairs = pairs;
    if (!wsSubscribed) wsConnect(Object.keys(pairs));
  }
  // overlay ws updates onto REST rows (ws payload uses same field names)
  function withLive(rows) {
    var fresh = Date.now() - liveTickAt < 30000;
    if (!fresh) return rows;
    return rows.map(function (t) {
      var live = liveTick[t.symbol];
      return live ? Object.assign({}, t, live) : t;
    });
  }

  function J(x) {
    return new Response(JSON.stringify(x), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  function pct(x) { return Math.round(x * 100) / 100; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function loadPost() {
    if (!postState) {
      try { postState = JSON.parse(localStorage.getItem(POST_KEY)) || {}; }
      catch (e) { postState = {}; }
    }
    postState.config = postState.config || {};
    postState.bot = postState.bot || {};
    postState.trades = postState.trades || [];
    return postState;
  }
  function savePost() {
    try { localStorage.setItem(POST_KEY, JSON.stringify(postState)); } catch (e) {}
  }

  async function getSymbols() {
    var c = null;
    try { c = JSON.parse(localStorage.getItem(SYM_KEY)); } catch (e) {}
    if (c && Date.now() - c.ts < 6 * 3600e3) return c.data;
    var r = await orig('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES');
    var j = await r.json();
    var data = j.data || [];
    try { localStorage.setItem(SYM_KEY, JSON.stringify({ ts: Date.now(), data: data })); } catch (e) {}
    return data;
  }
  async function getTickers() {
    if (tickersCache.data && Date.now() - tickersCache.t < 10000) return tickersCache.data;
    var r = await orig('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    var j = await r.json();
    tickersCache = { t: Date.now(), data: j.data || [] };
    return tickersCache.data;
  }

  async function buildScanner() {
    var syms = await getSymbols();
    var tks = await getTickers();
    var pairs = {};
    syms.forEach(function (s) {
      if (s.symbolStatus === 'normal' &&
          s.quoteCoin === 'USDT' && !STABLE[(s.baseCoin || '').toUpperCase()])
        pairs[s.symbol.toUpperCase()] = 1;
    });
    maybeStream(pairs);
    var rows = withLive(tks)
      .filter(function (t) { return pairs[t.symbol.toUpperCase()]; })
      .map(function (t) {
        var last = +t.lastPr, hi = +t.high24h, lo = +t.low24h, bid = +t.bidPr, ask = +t.askPr;
        return {
          asset: t.symbol.replace(/USDT$/i, ''),
          lastPrice: last,
          changePct: +t.changeUtc24h * 100,
          quoteVolume: +t.quoteVolume,
          highPrice: hi, lowPrice: lo,
          rangePct: lo > 0 ? ((hi - lo) / lo) * 100 : 0,
          spreadPct: last > 0 && bid > 0 && ask > 0 ? ((ask - bid) / last) * 100 : 0,
          rangePosition: hi > lo ? (last - lo) / (hi - lo) : 0.5,
        };
      })
      .filter(function (r) { return isFinite(r.lastPrice) && r.lastPrice > 0 && r.quoteVolume >= MIN_QV; })
      .sort(function (a, b) { return b.quoteVolume - a.quoteVolume; });
    if (!rows.length) throw new Error('empty universe');

    var chgs = rows.map(function (r) { return r.changePct; }).sort(function (a, b) { return a - b; });
    var vols = rows.map(function (r) { return r.quoteVolume; }).sort(function (a, b) { return a - b; });
    var sps = rows.map(function (r) { return r.spreadPct; }).sort(function (a, b) { return a - b; });
    function rank(a, v) { return a.filter(function (x) { return x <= v; }).length / a.length; }
    function strat(r) {
      if (r.changePct > 3 && r.rangePosition > 0.75) return 'Breakout Continuation';
      if (r.changePct < -3) return 'Momentum Breakdown';
      return 'Momentum Confluence';
    }

    var signals = rows
      .map(function (r) {
        var ms = Math.round(rank(chgs, r.changePct) * 100);
        var vs = Math.round(rank(vols, r.quoteVolume) * 100);
        var ls = Math.round((1 - rank(sps, r.spreadPct)) * 100);
        var score = Math.round(ms * 0.5 + vs * 0.3 + ls * 0.2);
        var dir = r.changePct >= 0 ? 'LONG' : 'SHORT';
        var stg = strat(r);
        var tp = pct(clamp(r.rangePct * 0.35, 3, 15));
        var drv = [
          '24h momentum ' + (r.changePct >= 0 ? '+' : '') + pct(r.changePct) + '%',
          'Quote volume $' + (r.quoteVolume / 1e6).toFixed(1) + 'M',
          'Range position ' + Math.round(r.rangePosition * 100) + '% · spread ' + pct(r.spreadPct) + '%',
        ];
        return {
          asset: r.asset,
          grade: score >= 85 ? 'A' : score >= 75 ? 'BBB' : score >= 65 ? 'BB' : 'B',
          score: score, social: null, symbol: r.asset + 'USD',
          thesis: stg + ' on ' + r.asset + ' | Confluence ' + score + '/100 | ' + drv[0] + ' | ' + drv[1],
          assetId: r.asset.toLowerCase(), drivers: drv,
          riskPct: pct(clamp(r.spreadPct * 2 + Math.abs(r.changePct) * 0.08, 0.3, 8)),
          summary: stg + ': ' + (dir === 'LONG' ? 'upside' : 'downside') + ' momentum on $' + (r.quoteVolume / 1e6).toFixed(0) + 'M quote volume.',
          harmonic: null, lowPrice: r.lowPrice, rangePct: pct(r.rangePct),
          strategy: stg, changePct: pct(r.changePct), direction: dir,
          highPrice: r.highPrice, lastPrice: r.lastPrice, spreadPct: pct(r.spreadPct),
          targetPct: tp, updatedAt: new Date().toISOString(), entryPrice: r.lastPrice,
          quoteVolume: Math.round(r.quoteVolume), socialScore: 0,
          targetPrice: dir === 'LONG' ? r.lastPrice * (1 + tp / 100) : r.lastPrice * (1 - tp / 100),
          signalFamily: 'momentum', momentumScore: ms,
          rangePosition: Math.round(r.rangePosition * 100) / 100,
          reversalScore: 0, liquidityScore: ls,
        };
      })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 12);

    var movers = rows.slice().sort(function (a, b) { return b.changePct - a.changePct; }).slice(0, 6)
      .map(function (r) { return { price: r.lastPrice, symbol: r.asset, changePct: pct(r.changePct) }; });
    var laggards = rows.slice().sort(function (a, b) { return a.changePct - b.changePct; }).slice(0, 6)
      .map(function (r) { return { price: r.lastPrice, symbol: r.asset, changePct: pct(r.changePct) }; });
    var adv = rows.filter(function (r) { return r.changePct > 0; }).length;
    var dec = rows.filter(function (r) { return r.changePct < 0; }).length;
    var med = chgs.length ? pct(chgs[chgs.length >> 1]) : 0;
    var breadth = rows.length ? pct((adv / rows.length) * 100) : 0;

    // seed pulse/fx from the static snapshot on first build (its history
    // is server-side accumulated); localStorage then extends it per-visitor
    var hist = [];
    try { hist = JSON.parse(localStorage.getItem(PULSE_KEY)) || []; } catch (e) {}
    var fx = { audPerUsd: 1.5, usdPerAud: 0.667 };
    if (!hist.length && !buildScanner._seeded) {
      buildScanner._seeded = true;
      try {
        var seed = await (await orig(BASE + 'market-scanner.json', { cache: 'no-store' })).json();
        if (seed && seed.pulse && Array.isArray(seed.pulse.series)) hist = seed.pulse.series;
        if (seed && seed.fx) fx = seed.fx;
      } catch (e) {}
    }
    var now = Date.now();
    if (!hist.length || now - hist[hist.length - 1].ts > 30000) {
      hist.push({ ts: now, value: pct(100 + med) });
      hist = hist.slice(-288);
      try { localStorage.setItem(PULSE_KEY, JSON.stringify(hist)); } catch (e) {}
    }
    var vals = hist.map(function (p) { return p.value; });

    return {
      fx: fx,
      pulse: {
        low: Math.min.apply(null, vals), high: Math.max.apply(null, vals),
        delta: pct((vals[vals.length - 1] || 100) - (vals[0] || 100)),
        series: hist, baseline: 100,
      },
      movers: movers, status: 'live', signals: signals, laggards: laggards,
      overview: {
        advancing: adv, declining: dec, breadthPct: breadth,
        longSignals: signals.filter(function (s) { return s.direction === 'LONG'; }).length,
        totalVolume: Math.round(rows.reduce(function (a, r) { return a + r.quoteVolume; }, 0)),
        harmonicHits: 0, scannedPairs: rows.length,
        shortSignals: signals.filter(function (s) { return s.direction === 'SHORT'; }).length,
        socialCoverage: 0, medianChangePct: med,
        averageSpreadPct: pct(rows.reduce(function (a, r) { return a + r.spreadPct; }, 0) / (rows.length || 1)),
      },
      refreshedAt: new Date().toISOString(),
      scanWindowSeconds: 10, error: null,
      source: 'bitget-live', universeFilter: 'bitget-spot',
    };
  }

  async function getMerged(url, init, fn) {
    var r = await orig(url, init);
    var j = await r.json().catch(function () { return {}; });
    return J(fn(j));
  }

  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = ((init && init.method) || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase();
      var idx = url.indexOf(BASE);
      if (idx === 0 || idx === location.origin.length) {
        var name = url.slice(idx + BASE.length).split('?')[0];
        if (method === 'GET' && name === 'market-scanner.json') {
          return buildScanner().then(J).catch(function () { return orig(input, init); });
        }
        if (method === 'POST') {
          var st = loadPost(), body = {};
          try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
          if (name === 'config.json') {
            st.config = Object.assign(st.config, body); savePost();
            return Promise.resolve(J({ ok: true, config: st.config }));
          }
          if (name === 'bot-state.json') {
            var b = body.bot || body;
            st.bot = Object.assign(st.bot, b); savePost();
            return Promise.resolve(J({ ok: true, bot: st.bot }));
          }
          if (name === 'trades.json') {
            var tr = Object.assign({ id: 'local_' + Date.now(), createdAt: new Date().toISOString(), mode: 'dry-run' }, body);
            st.trades.unshift(tr); st.trades = st.trades.slice(0, 50); savePost();
            return Promise.resolve(J({ ok: true, trade: tr }));
          }
        }
        if (method === 'GET') {
          if (name === 'market-snapshot.json')
            return (async function () {
              var r = await orig(input, init);
              var j = await r.json().catch(function () { return {}; });
              try {
                var t = (await getTickers()).find(function (x) { return x.symbol === 'SOLUSDT'; });
                var live = liveTick['SOLUSDT'];
                var px = +(live ? live.lastPr : t && t.lastPr);
                var chg = +(live ? live.changeUtc24h : t && t.changeUtc24h);
                if (isFinite(px) && j.assets && j.assets.input) {
                  j.assets.input.usdPrice = px;
                  j.assets.input.priceChange24h = chg * 100;
                  j.refreshedAt = new Date().toISOString();
                  j.source = 'bitget-live';
                }
              } catch (e) {}
              return J(j);
            })().catch(function () { return orig(input, init); });
          if (name === 'config.json')
            return getMerged(input, init, function (j) { return Object.assign({}, j, loadPost().config); });
          if (name === 'bot-state.json')
            return getMerged(input, init, function (j) { j.bot = Object.assign({}, j.bot, loadPost().bot); return j; });
          if (name === 'trades.json')
            return getMerged(input, init, function (j) {
              var l = loadPost().trades;
              if (l.length) {
                j.trades = l.concat(j.trades || []);
                if (j.summary) j.summary.totalTrades = (j.summary.totalTrades || 0) + l.length;
              }
              return j;
            });
        }
      }
    } catch (e) {}
    return orig(input, init);
  };
})();
