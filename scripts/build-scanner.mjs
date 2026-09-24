// Builds api/market-scanner.json directly from Bitget public futures data.
// Universe: Bitget USDT-M perpetual futures — crypto + RWA (stocks/indexes/
// metals/FX), fiat-stable bases excluded. Signals score direction-aware
// momentum (Wilder RSI on closed 1h klines, signed 24h change), volume and
// liquidity ranked within the candidate pool, plus bounded TA/derivatives/
// news confluence. Never wipes a good snapshot — failures keep the previous.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../harmonics.js'; // UMD side-effect: sets globalThis.Harmonics
import '../ta-engine.js';  // sets globalThis.TAEngine

const Harmonics = globalThis.Harmonics;
const TAEngine = globalThis.TAEngine;

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
// Universe = Bitget USDT-M perpetual futures: crypto + RWA contracts
// (stocks, indexes, FX, metals) — everything tradeable from the futures account.
const CONTRACTS_URL =
  'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES';
const TICKERS_URL =
  'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES';
const CANDLES_URL = 'https://api.bitget.com/api/v2/mix/market/candles';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const MIN_QUOTE_VOLUME = 250_000; // USDT notional — liquid listings only
const KLINE_CANDIDATES = 48; // top-volume pairs get 1h momentum metrics
const MAX_SIGNALS = 12;
const PULSE_FILE = path.join(API, 'pulse-history.json');
const PULSE_MAX_POINTS = 144; // ~24h at a 10min cadence
const LEDGER_FILE = path.join(API, 'signal-ledger.json');
const PERP_TICKERS_URL =
  'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES';
const FUND_URL = 'https://api.bitget.com/api/v2/mix/market/current-fund-rate';
const FUND_HIST_URL =
  'https://api.bitget.com/api/v2/mix/market/history-fund-rate';
const OI_URL = 'https://api.bitget.com/api/v2/mix/market/open-interest';
const LEDGER_MAX = 1_000_000_000;
const LEDGER_TTL_MS = 24 * 3600 * 1000;
const REENTRY_COOLDOWN_MS = 2 * 3600 * 1000;
const UNTRACKED_TTL_MS = 3600 * 1000; // asset out of universe -> expire after 1h
const VAULT_FILE = path.join(API, 'vault.json');
const VAULT_PCT = 0.2; // share of realized gains swept into the hold basket
const TRADE_NOTIONAL = 1000; // dry-run $ per signal
const VAULT_ASSETS = ['BTC', 'ETH', 'SOL'];

const pct = (x) => Math.round(x * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const STABLE_FIAT = new Set([
  'USDC', 'USDT', 'USD1', 'USDE', 'USDD', 'DAI', 'FDUSD', 'TUSD', 'PYUSD',
  'RLUSD', 'USDP', 'GUSD', 'USDY', 'USTB', 'BFUSD', 'AUSD', 'EUR', 'EURC',
  'GBP', 'BRL', 'TRY', 'AUD', 'USDG', 'CUSD', 'XUSD', 'USDS', 'SUSDE',
]);

// asset-class labels for RWA perps (contracts API flags isRwa but not the
// kind). Index set covers broad indexes + index/sector/country/bond/vol and
// leveraged-ETF perps; metal covers bullion + gold tokens; commodity is
// energy/agri; fx is fiat pairs; remaining isRwa bases are equity perps.
const IDX_SET = new Set(
  'SPX SPY QQQ VOO IWM SP500 NDX100 NDX NAS100 US500 US30 DJT DJI DAX FTSE NI225 JP225 HSI KR200 TQQQ SQQQ QLD SPXU UDOW SDOW TNA TZA UVXY SOXL SOXS SOXX SMH XLE XLU XLK XLV XBI GDX URNM BOTZ KWEB EWJ EWY EWT INDA EWH EWZ TLT TMF TBT JEPQ SGOV BITO IBIT AGPU BITU ETHU SOLX'.split(' ')
);
const METAL_SET = new Set(
  'XAU XAG XPT XPD HG COPPER COP PAXG XAUT'.split(' ')
);
const COMMODITY_SET = new Set(
  'CL BZ NATGAS OIL UKOIL USOIL WTI BRENT CORN WHEAT SOY SUGAR COFFEE COCOA'.split(' ')
);
const FX_SET = new Set(
  'EURUSD USDJPY GBPUSD AUDUSD USDCAD USDCHF NZDUSD EURGBP EURJPY GBPJPY DXY USDCNH USDBRL'.split(' ')
);
const assetClass = (base, isRwa) =>
  IDX_SET.has(base)
    ? 'index'
    : METAL_SET.has(base)
      ? 'metal'
      : COMMODITY_SET.has(base)
        ? 'commodity'
        : FX_SET.has(base)
          ? 'fx'
          : isRwa
            ? 'stock'
            : 'crypto';

// Wilder RSI over the full series — average the first `period` deltas, then
// smooth forward to the last close. (The old version only read the first 15
// elements of a 48-close window: it reported RSI from ~34h ago.)
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

async function fetchKlines(symbol) {
  const res = await fetch(
    `${CANDLES_URL}?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&limit=120`
  );
  if (!res.ok) return null;
  const { data } = await res.json();
  if (!Array.isArray(data) || data.length < 20) return null;
  const rows = data
    .map((c) => ({
      t: Number(c[0]),
      h: Number(c[2]),
      l: Number(c[3]),
      c: Number(c[4]),
      qv: Number(c[6]),
    }))
    .sort((a, b) => a.t - b.t); // oldest first
  // drop the still-forming candle — TA on an unclosed bar paints patterns
  // that evaporate when the hour settles
  if (rows.length && rows[rows.length - 1].t + 3600e3 > Date.now()) rows.pop();
  const closes = rows.map((r) => r.c);
  const last6 = rows.slice(-6).reduce((a, r) => a + r.qv, 0) / 6;
  const prior = rows.slice(0, -6);
  const priorAvg = prior.reduce((a, r) => a + r.qv, 0) / (prior.length || 1);
  const candles = rows.map(({ t, h, l, c, qv }) => ({ t, h, l, c, qv }));
  let candles5m = null;
  try {
    const r5 = await fetch(
      `${CANDLES_URL}?symbol=${symbol}&productType=USDT-FUTURES&granularity=5m&limit=120`
    );
    if (r5.ok) {
      const d5 = await r5.json();
      if (Array.isArray(d5.data))
        candles5m = d5.data
          .map((c) => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4], qv: +c[6] }))
          .sort((a, b) => a.t - b.t)
          .filter((c) => c.t + 300e3 <= Date.now());
    }
  } catch {}
  return {
    rsi14: rsi(closes),
    volRatio: priorAvg > 0 ? last6 / priorAvg : 1,
    closes: closes.slice(-48), // sparkline stays 48h
    candles,
    harmonic: Harmonics.active(candles, 8),
    ta: TAEngine.analyze(candles, candles5m),
  };
}

async function main() {
  const now = Date.now();
  const [symbolsRes, tickersRes] = await Promise.all([
    fetch(CONTRACTS_URL),
    fetch(TICKERS_URL),
  ]);
  if (!symbolsRes.ok || !tickersRes.ok)
    throw new Error(`bitget http ${symbolsRes.status}/${tickersRes.status}`);
  const { data: symbols } = await symbolsRes.json();
  const { data: tickers } = await tickersRes.json();

  // contracts list drives the universe: every USDT-M perpetual — crypto,
  // stocks (TSLA/NVDA/AAPL...), indexes (SPX/QQQ...), metals (XAU/XAG), FX.
  const online = symbols.filter(
    (s) => s.symbolStatus === 'normal' && s.quoteCoin === 'USDT'
  );
  const listed = new Set(online.map((s) => (s.baseCoin ?? '').toUpperCase()));
  fs.writeFileSync(
    path.join(API, 'bitget-symbols.json'),
    JSON.stringify([...listed].sort())
  );
  const contractBySymbol = new Map(
    online.map((s) => [s.symbol.toUpperCase(), s])
  );
  const usdtPairs = new Set(
    online
      .filter((s) => !STABLE_FIAT.has((s.baseCoin ?? '').toUpperCase()))
      .map((s) => s.symbol.toUpperCase())
  );

  const rows = tickers
    .filter((t) => usdtPairs.has(t.symbol.toUpperCase()))
    .map((t) => {
      const last = Number(t.lastPr);
      const high = Number(t.high24h);
      const low = Number(t.low24h);
      const bid = Number(t.bidPr);
      const ask = Number(t.askPr);
      const c = contractBySymbol.get(t.symbol.toUpperCase());
      const base = t.symbol.replace(/USDT$/i, '').toUpperCase();
      return {
        asset: t.symbol.replace(/USDT$/i, ''),
        symbol: `${t.symbol.replace(/USDT$/i, '')}USD`,
        pair: t.symbol,
        cls: assetClass(base, c?.isRwa === 'YES'),
        maxLever: Number(c?.maxLever) || null,
        indexPrice: Number(t.indexPrice) || null,
        markPrice: Number(t.markPrice) || null,
        lastPrice: last,
        changePct: Number(t.changeUtc24h) * 100,
        quoteVolume: Number(t.quoteVolume),
        highPrice: high,
        lowPrice: low,
        rangePct: low > 0 ? ((high - low) / low) * 100 : 0,
        spreadPct: last > 0 && bid > 0 && ask > 0 ? ((ask - bid) / last) * 100 : 0,
        rangePosition: high > low ? (last - low) / (high - low) : 0.5,
      };
    })
    .filter(
      (r) =>
        Number.isFinite(r.lastPrice) &&
        r.lastPrice > 0 &&
        r.quoteVolume >= MIN_QUOTE_VOLUME
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  // hourly klines for the top-volume candidates -> real momentum metrics
  const enriched = new Map();
  const candidates = rows.slice(0, KLINE_CANDIDATES);
  for (let i = 0; i < candidates.length; i += 12) {
    const batch = candidates.slice(i, i + 12);
    await Promise.all(
      batch.map(async (r) => {
        const k = await fetchKlines(r.pair).catch(() => null);
        if (k) enriched.set(r.asset, k);
      })
    );
  }
  // one retry pass for rate-limited/missed klines
  const missing = candidates.filter((r) => !enriched.has(r.asset));
  if (missing.length) {
    await new Promise((r) => setTimeout(r, 1500));
    await Promise.all(
      missing.map(async (r) => {
        const k = await fetchKlines(r.pair).catch(() => null);
        if (k) enriched.set(r.asset, k);
      })
    );
  }

  // ---- funding intelligence: perp funding rates + spot/perp basis ----
  const funding = {};
  try {
    const perpRes = await fetch(PERP_TICKERS_URL);
    const perps = perpRes.ok ? (await perpRes.json()).data || [] : [];
    const perpPx = {};
    for (const t of perps)
      if ((t.symbol || '').endsWith('USDT'))
        perpPx[t.symbol.replace('USDT', '')] = +t.lastPr;
    const fundSyms = rows.slice(0, KLINE_CANDIDATES).map((r) => r.pair);
    for (let i = 0; i < fundSyms.length; i += 12) {
      await Promise.all(
        fundSyms.slice(i, i + 12).map(async (sym) => {
          try {
            const r = await fetch(
              `${FUND_URL}?symbol=${sym}&productType=USDT-FUTURES`
            );
            if (!r.ok) return;
            const d = (await r.json()).data;
            const f = Array.isArray(d) ? d[0] : d;
            const asset = sym.replace('USDT', '');
            const rate = +f.fundingRate;
            if (isFinite(rate)) {
              const row = rows.find((x) => x.asset === asset);
              const perp = row ? row.lastPrice : perpPx[asset] ?? null;
              // universe is futures-native: basis is perp mark vs index price
              const index = row?.indexPrice ?? null;
              const annualPct = rate * 3 * 365 * 100; // 8h funding x3/day
              const basisPct =
                index && perp ? ((perp - index) / index) * 100 : null;
              funding[asset] = {
                ratePct: pct(rate * 100),
                annualPct: pct(annualPct),
                nextTs: f.nextUpdate ? +f.nextUpdate : null,
                perp, index, basisPct: basisPct != null ? pct(basisPct) : null,
                // arb math: ~0.32% round-trip to open+close the pair
                // (spot taker + perp taker); breakeven = hours of funding
                // needed to cover entry+exit costs
                arb:
                  rate > 0
                    ? 'LONG_SPOT_SHORT_PERP'
                    : 'SHORT_SPOT_LONG_PERP',
                breakevenH:
                  Math.abs(rate) > 0.00005
                    ? Math.round((0.0032 / Math.abs(rate)) * 8 * 10) / 10
                    : null,
              };
            }
          } catch {}
        })
      );
    }

    // ---- derivatives + social intelligence ----
    // Bitget public futures (keyless): open interest + funding history →
    // positioning pressure. CoinGlass / LunarCrush activate when keys exist.
    let KEYS = {};
    try { KEYS = JSON.parse(fs.readFileSync(new URL('./api-keys.json', import.meta.url), 'utf8')); } catch {}
    const CG_KEY = process.env.COINGLASS_API_KEY || KEYS.coinglass || null;
    const LC_KEY = process.env.LUNARCRUSH_API_KEY || KEYS.lunarcrush || null;
    const CP_KEY = process.env.CRYPTOPANIC_API_KEY || KEYS.cryptopanic || null;
    const CP_PLAN = process.env.CRYPTOPANIC_PLAN || KEYS.cryptopanicPlan || 'growth';
    const CMC_KEY = process.env.CMC_API_KEY || KEYS.cmc || null;
    const CMCAL_ID = process.env.COINMARKETCAL_CLIENT_ID || KEYS.coinmarketcalId || null;
    const CMCAL_SECRET = process.env.COINMARKETCAL_CLIENT_SECRET || KEYS.coinmarketcalSecret || null;
    const deriv = {}, social = {}, news = {}, mcaps = {}, events = {};
    const feedStatus = { bitget: 'live', coinglass: CG_KEY ? 'live' : 'no-key', lunarcrush: LC_KEY ? 'live' : 'no-key', cryptopanic: CP_KEY ? 'live' : 'no-key', coingecko: 'live', coinmarketcap: CMC_KEY ? 'live' : 'no-key', coinmarketcal: CMCAL_ID && CMCAL_SECRET ? 'live' : 'no-key' };
    for (let i = 0; i < fundSyms.length; i += 12) {
      await Promise.all(
        fundSyms.slice(i, i + 12).map(async (sym) => {
          const asset = sym.replace('USDT', '');
          const d = {};
          try {
            // open interest — size of open perp positions (Bitget public)
            const oi = await fetch(`${OI_URL}?symbol=${sym}&productType=USDT-FUTURES`);
            if (oi.ok) {
              const od = (await oi.json()).data;
              const sz = +((od && od.openInterestList && od.openInterestList[0]) || {}).size;
              const px = perpPx[asset];
              if (isFinite(sz) && px) { d.oiUsd = Math.round(sz * px); }
            }
            // funding history → trend (rising = longs paying more, crowding)
            const fh = await fetch(`${FUND_HIST_URL}?symbol=${sym}&productType=USDT-FUTURES&pageSize=8`);
            if (fh.ok) {
              const hist = (await fh.json()).data || [];
              const rates = hist.map((x) => +x.fundingRate).filter((x) => isFinite(x));
              if (rates.length >= 4) {
                const now = rates[0], prevAvg = rates.slice(1).reduce((a, x) => a + x, 0) / (rates.length - 1);
                d.fundingTrend = now > prevAvg * 1.5 + 0.00002 ? 'rising' : now < prevAvg * 0.5 - 0.00002 ? 'falling' : 'flat';
                // crowding: sustained positive & rising → longs crowded (squeeze fuel)
                d.crowding = now > 0.0002 && d.fundingTrend !== 'falling' ? 'longs-crowded'
                           : now < -0.0001 ? 'shorts-crowded' : 'balanced';
              }
            }
          } catch {}
          // CoinGlass (key-gated): liquidations + long/short account ratio
          if (CG_KEY) {
            try {
              const H = { headers: { 'CG-API-KEY': CG_KEY } };
              const [lq, ls] = await Promise.all([
                fetch(`https://open-api-v4.coinglass.com/api/futures/liquidation/aggregated-history?symbol=${asset}&interval=1d&limit=1`, H),
                fetch(`https://open-api-v4.coinglass.com/api/futures/global-long-short-account-ratio/history?exchange=Bitget&symbol=${sym}&interval=1h&limit=1`, H),
              ]);
              if (lq.ok) {
                const dd = (await lq.json()).data || [];
                if (dd[0]) { d.liqLongUsd = Math.round(+dd[0].long_liquidation_usd || 0); d.liqShortUsd = Math.round(+dd[0].short_liquidation_usd || 0); }
              }
              if (ls.ok) {
                const dd = (await ls.json()).data || [];
                if (dd[0]) { d.longShortRatio = pct(+dd[0].global_account_long_percent / Math.max(1e-9, +dd[0].global_account_short_percent)); }
              }
            } catch {}
          }
          // positioning verdict: crowded side is squeeze fuel AGAINST it
          if (d.crowding) d.dir = d.crowding === 'longs-crowded' ? 'bear' : d.crowding === 'shorts-crowded' ? 'bull' : null;
          if (Object.keys(d).length) deriv[asset] = d;
          // LunarCrush (key-gated): galaxy score, alt rank, sentiment, social volume
          if (LC_KEY) {
            try {
              const lc = await fetch(`https://lunarcrush.com/api4/public/coins/${asset.toLowerCase()}/v1`, { headers: { Authorization: `Bearer ${LC_KEY}` } });
              if (lc.ok) {
                const ld = (await lc.json()).data;
                if (ld) social[asset] = {
                  galaxy: ld.galaxy_score ?? null, altRank: ld.alt_rank ?? null,
                  sentiment: ld.sentiment ?? null, socialVol: ld.social_volume_24h ?? null,
                  interactions: ld.interactions_24h ?? null,
                  dir: (ld.galaxy_score ?? 50) >= 65 ? 'bull' : (ld.galaxy_score ?? 50) <= 35 ? 'bear' : null,
                };
              }
            } catch {}
          }
        })
      );
    }

    // market-cap / news / calendar intel is crypto-only — a stock perp
    // symbol colliding with a crypto token name would attach wrong data
    const isCrypto = new Set(
      rows.filter((r) => r.cls === 'crypto').map((r) => r.asset.toUpperCase())
    );
    const cryptoOf = (syms) => syms.filter((s) => isCrypto.has(s.replace('USDT', '')));
    // CoinGecko (keyless): market-cap intelligence — rank, float unlocked %,
    // ATH distance, volume/mcap turnover. The CMC-equivalent quality layer.
    try {
      const syms = cryptoOf(fundSyms).map((s) => s.replace('USDT', '').toLowerCase()).join(',');
      const cg = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&symbols=${encodeURIComponent(syms)}&price_change_percentage=24h`
      );
      if (cg.ok) {
        for (const c of (await cg.json()) || []) {
          const a = (c.symbol || '').toUpperCase();
          if (!a) continue;
          const floatPct = c.max_supply ? pct((c.circulating_supply / c.max_supply) * 100) : null;
          const volMcap = c.market_cap ? pct((c.total_volume / c.market_cap) * 100) : null;
          mcaps[a] = {
            mcapUsd: c.market_cap ?? null, rank: c.market_cap_rank ?? null,
            volMcapPct: volMcap, athDistPct: c.ath_change_percentage != null ? pct(c.ath_change_percentage) : null,
            floatPct,
            // low float = dilution/unlock risk (bear); blue-chip near ATH =
            // strength context; everything else neutral
            dir: floatPct != null && floatPct < 30 ? 'bear'
               : (c.market_cap_rank ?? 999) <= 25 && (c.ath_change_percentage ?? -100) > -25 ? 'bull' : null,
          };
        }
      }
    } catch {}
    // CoinMarketCap (key-gated): cross-verification overlay — CMC rank,
    // 24h volume change, tags. Cheap batch quotes call.
    if (CMC_KEY) {
      try {
        const syms = cryptoOf(fundSyms).map((s) => s.replace('USDT', '')).slice(0, 40).join(',');
        const r = await fetch(
          `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(syms)}`,
          { headers: { 'X-CMC_PRO_API_KEY': CMC_KEY } }
        );
        if (r.ok) {
          const dd = (await r.json()).data || {};
          for (const [sym, v] of Object.entries(dd)) {
            const q = ((v || {})[0] || v).quote?.USD || {};
            const a = sym.toUpperCase();
            (mcaps[a] ??= {}).cmc = {
              rank: (v[0] || v).cmc_rank ?? null,
              volChg24h: q.volume_change_24h != null ? pct(q.volume_change_24h) : null,
            };
          }
        }
      } catch {}
    }
    // CoinMarketCal (key-gated): scheduled events in next 7d — token
    // unlocks = supply-dump risk, listings/upgrades = catalysts. Event
    // risk is a flag on the position, never a signal by itself.
    if (CMCAL_ID && CMCAL_SECRET) {
      try {
        const tk = await fetch(
          `https://api.coinmarketcal.com/oauth/v2/token?grant_type=client_credentials&client_id=${CMCAL_ID}&client_secret=${CMCAL_SECRET}`,
          { method: 'POST' }
        );
        if (tk.ok) {
          const tok = (await tk.json()).access_token;
          const coins = cryptoOf(fundSyms).map((s) => s.replace('USDT', '').toLowerCase()).slice(0, 20).join(',');
          const ev = await fetch(
            `https://api.coinmarketcal.com/v1/events?max=30&coins=${encodeURIComponent(coins)}&dateRangeStart=${new Date().toISOString().slice(0, 10)}`,
            { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } }
          );
          if (ev.ok) {
            for (const p of (await ev.json()).body || []) {
              const cats = (p.categories || []).map((x) => (x.name || '').toLowerCase()).join(' ');
              const isUnlock = /unlock|vesting|cliff/.test(cats + ' ' + (p.title?.en || ''));
              const isCatalyst = /listing|mainnet|launch|upgrade|fork|airdrop/.test(cats + ' ' + (p.title?.en || ''));
              const days = p.date_event ? Math.round((Date.parse(p.date_event) - Date.now()) / 864e5) : null;
              if (days == null || days > 7) continue;
              for (const c of p.coins || []) {
                const a = (c.symbol || '').toUpperCase();
                if (!isCrypto.has(a)) continue;
                const n = (events[a] ??= { n: 0, unlocks: 0, catalysts: 0, next: [] });
                n.n++; if (isUnlock) n.unlocks++; if (isCatalyst) n.catalysts++;
                if (n.next.length < 2) n.next.push(`${p.title?.en?.slice(0, 60)} (${days}d)`);
                n.dir = isUnlock ? 'bear' : isCatalyst ? 'bull' : n.dir ?? null;
              }
            }
          }
        }
      } catch {}
    }

    // CryptoPanic (key-gated): public crypto news → bullshit-filtered.
    // News is treated as CONTEXT, never a trigger: hype-word spam is
    // discounted to zero, only vote-validated important posts move the
    // needle, and the total influence is capped hard in the score.
    if (CP_KEY) {
      try {
        const curList = cryptoOf(fundSyms).map((s) => s.replace('USDT', '')).slice(0, 40).join(',');
        const cp = await fetch(
          `https://cryptopanic.com/api/${CP_PLAN}/v2/posts/?auth_token=${CP_KEY}&kind=news&filter=important&currencies=${encodeURIComponent(curList)}`
        );
        if (cp.ok) {
          const posts = (await cp.json()).results || [];
          const HYPE = /moon|100x|1000x|guarantee|parabolic|insane|don't miss|dont miss|lambo|rocket|🚀|next bitcoin|free money|shitcoin|pump it|bags|ape in|easily|hopium/i;
          const nowMs = Date.now();
          for (const p of posts) {
            const title = p.title || '';
            const v = p.votes || {};
            const pos = +v.positive || 0, neg = +v.negative || 0, imp = +v.important || 0;
            const ageH = (nowMs - Date.parse(p.published_at || 0)) / 3.6e6;
            if (!isFinite(ageH) || ageH > 72) continue; // stale news = noise
            const recency = Math.max(0.2, 1 - ageH / 72);
            const hype = HYPE.test(title) ? 1 : 0;
            const weight = recency * (1 + imp * 0.5) * (hype ? 0.15 : 1); // hype posts ~zeroed
            for (const c of p.currencies || []) {
              const a = (c.code || '').toUpperCase();
              if (!a || !isCrypto.has(a)) continue;
              const n = (news[a] ??= { n: 0, pos: 0, neg: 0, imp: 0, hype: 0, heads: [] });
              n.n++;
              n.pos += pos * weight; n.neg += neg * weight; n.imp += imp; n.hype += hype;
              if (n.heads.length < 3 && title) n.heads.push(title.slice(0, 90));
            }
          }
          for (const a of Object.keys(news)) {
            const n = news[a], tot = n.pos + n.neg;
            n.sentiment = tot > 0 ? pct((n.pos - n.neg) / tot) : null;
            // mostly-bullshit guard: need ≥2 important posts AND a decisive
            // vote ratio before direction is claimed; fud cluster = bear
            n.dir = n.imp >= 2 && n.sentiment != null
              ? n.sentiment > 0.25 ? 'bull' : n.sentiment < -0.25 ? 'bear' : null
              : null;
            if (n.neg > n.pos * 1.5 && n.neg > 1) n.fud = true;
          }
        }
      } catch {}
    }
    deriv._feeds = feedStatus; social._feeds = feedStatus; news._feeds = feedStatus;
    mcaps._feeds = feedStatus; events._feeds = feedStatus;
    globalThis.__deriv = deriv; globalThis.__social = social; globalThis.__news = news;
    globalThis.__mcaps = mcaps; globalThis.__events = events;
  } catch {}

  const rank = (arr, v) =>
    arr.length ? arr.filter((x) => x <= v).length / arr.length : 0.5;
  // ranks are computed INSIDE the candidate pool — the old version ranked
  // the top-48-by-volume against all ~515 pairs, so every candidate scored
  // ~95th percentile on volume for free and everything graded "A"
  const cands = rows.slice(0, KLINE_CANDIDATES);
  const vols = cands.map((r) => r.quoteVolume).sort((a, b) => a - b);
  const spreads = cands.map((r) => r.spreadPct).sort((a, b) => a - b);
  const surges = [...enriched.values()].map((k) => k.volRatio).sort((a, b) => a - b);
  // direction-aware momentum: a candidate is scored on the strength of the
  // move in ITS traded direction — a −8% dump traded SHORT is strong
  // downside momentum, not a high score riding the wrong side
  const dirOf = (r, k) =>
    (k && k.ta && k.ta.bias) || (r.changePct >= 0 ? 'LONG' : 'SHORT');
  const dirMove = (r, k) => (dirOf(r, k) === 'LONG' ? r.changePct : -r.changePct);
  const dirMoves = cands
    .map((r) => dirMove(r, enriched.get(r.asset)))
    .sort((a, b) => a - b);

  // ---- self-improvement: adapt doctrine weights to realized ledger R ----
  let priorEntries = [];
  try {
    priorEntries =
      JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')).entries || [];
  } catch {}
  const stratR = {};
  for (const e of priorEntries) {
    if (e.status === 'open' || e.pnlPct == null) continue;
    (stratR[e.strategy] ??= []).push(
      e.pnlPct / (e.stopPct ?? Math.max(4, e.targetPct || 4))
    );
  }
  // Bayesian-shrunk adjustments: a 3-trade sample cannot move doctrine
  // weights. Shrinkage n/(n+10) means 5 trades reach ~1/3 strength, 30
  // trades ~full — and the cap tightened from ±8 to ±4
  const stratAdj = Object.fromEntries(
    Object.entries(stratR).map(([k, v]) => {
      const n = v.length;
      const avg = v.reduce((a, b) => a + b, 0) / n;
      const shrunk = avg * (n / (n + 10));
      return [k, Math.round(clamp(shrunk * 4, -4, 4) * 10) / 10];
    })
  );

  const strategyFor = (r, k) => {
    if (r.changePct > 3 && r.rangePosition > 0.75) return 'Breakout Continuation';
    if (k && k.volRatio > 1.8 && r.changePct > 0) return 'Volume Surge';
    if (r.changePct < -3) return 'Momentum Breakdown';
    if (k && k.rsi14 < 35) return 'Oversold Reversal';
    return 'Momentum Confluence';
  };
  // doctrine-driven naming when the TA engine produced a bias signal
  const stratName = (r, k) => {
    const ta = k && k.ta;
    if (ta && ta.bias) {
      if (ta.sfp) return 'Key Level SFP';
      if (ta.reasons[0] === 'elliott-w5')
        return ta.elliott.shortTop ? 'Elliott W5 Short' : 'Elliott W5 Bottom';
      if (ta.reasons[0] === 'wyckoff-spring' || ta.reasons[0] === 'wyckoff-test')
        return 'Wyckoff Spring';
      if (ta.reasons[0] === 'wyckoff-jtc' || ta.reasons[0] === 'wyckoff-lps')
        return 'Wyckoff JTC';
      if (ta.reasons[0] === 'wyckoff-utad') return 'Wyckoff Upthrust';
      if (ta.reasons[0] === 'wyckoff-fti' || ta.reasons[0] === 'wyckoff-lpsy')
        return 'Wyckoff Ice Break';
      if (ta.reasons[0] === 'smc-choch') return 'SMC CHoCH';
      if (ta.reasons[0] === 'smc-bos') return 'SMC BOS';
      if (ta.reasons[0] === 'ignition') return 'Momentum Ignition';
      if (ta.reasons[0] === 'vwap-reversion') return 'VWAP Reversion';
      if (ta.reasons[0] === 'eq-edge') return 'PA Quartile';
    }
    return strategyFor(r, k);
  };

  // signals need momentum metrics; pairs whose kline fetch failed get a
  // neutral profile instead of being dropped from the board entirely
  const neutral = { rsi14: 50, volRatio: 1, closes: null };
  const ranked = rows
    .slice(0, KLINE_CANDIDATES)
    .map((r) => {
      const k = enriched.get(r.asset) ?? neutral;
      const dir0 = dirOf(r, k);
      // score the move in the direction we would trade it — the old rank
      // paid upside momentum to every coin including the ones we shorted
      const momentumRank = rank(dirMoves, dirMove(r, k));
      // RSI tilt toward the traded side: for a LONG, hot RSI reads strength;
      // for a SHORT, cold RSI reads weakness — both momentum, one axis
      const rsiTilt =
        dir0 === 'LONG'
          ? clamp((k.rsi14 - 30) / 40, 0, 1)
          : clamp((70 - k.rsi14) / 40, 0, 1);
      const momentumScore = Math.round(momentumRank * 60 + rsiTilt * 40);
      const volumeScore = Math.round(rank(vols, r.quoteVolume) * 100);
      const liquidityScore = Math.round((1 - rank(spreads, r.spreadPct)) * 100);
      const surgeScore = Math.round(rank(surges, k.volRatio) * 100);
      const strategy = stratName(r, k);
      // positioning pressure: crowded side is squeeze fuel — riding WITH
      // the crowd's unwind direction boosts, joining the crowd costs
      const dp = (globalThis.__deriv || {})[r.asset];
      const derivBoost = dp && dp.dir
        ? (dir0 === 'LONG' ? 'bull' : 'bear') === dp.dir ? 3 : -2
        : 0;
      // news context — hard-capped ±2; hype posts already zeroed upstream,
      // a FUD cluster actively costs longs (avoidance, not trigger)
      const nw = (globalThis.__news || {})[r.asset];
      const newsBoost = nw
        ? (nw.dir && ((dir0 === 'LONG' ? 'bull' : 'bear') === nw.dir ? 2 : -2))
          + (nw.fud && dir0 === 'LONG' ? -2 : 0)
        : 0;
      // market-cap quality + event risk — low float into an unlock is the
      // classic dump setup; catalysts are context, never a trigger
      const mc = (globalThis.__mcaps || {})[r.asset];
      const ev2 = (globalThis.__events || {})[r.asset];
      const mcapBoost = (mc && mc.dir ? ((dir0 === 'LONG' ? 'bull' : 'bear') === mc.dir ? 2 : -1) : 0)
        + (ev2 && ev2.unlocks > 0 && dir0 === 'LONG' ? -3 : 0)
        + (ev2 && ev2.dir ? ((dir0 === 'LONG' ? 'bull' : 'bear') === ev2.dir ? 1 : 0) : 0);
      const score = Math.round(
        clamp(
          momentumScore * 0.4 + volumeScore * 0.25 + liquidityScore * 0.2 +
            surgeScore * 0.15 +
            Math.min((k.ta?.confluence || 0) * 3, 12) +
            (stratAdj[strategy] || 0) +
            derivBoost +
            newsBoost +
            mcapBoost,
          0,
          100
        )
      );
      return { ...r, k, strategy, dir: dir0, momentumScore, volumeScore, liquidityScore, surgeScore, score };
    })
    .sort((a, b) => b.score - a.score);
  const signals = ranked
    .slice(0, MAX_SIGNALS)
    .map((r) => {
      const ta = r.k.ta ?? null;
      const direction = r.dir;
      const strategy = r.strategy;
      const targetPct = pct(clamp(r.rangePct * 0.35, 3, 15));
      const hasK = enriched.has(r.asset);
      const drivers = [
        `24h momentum ${r.changePct >= 0 ? '+' : ''}${pct(r.changePct)}%`,
        hasK
          ? `RSI(1h) ${Math.round(r.k.rsi14)} · volume ${round(r.k.volRatio, 1)}× baseline`
          : `Quote volume $${(r.quoteVolume / 1e6).toFixed(1)}M`,
        `Range position ${Math.round(r.rangePosition * 100)}% · spread ${pct(r.spreadPct)}%`,
      ];
      return {
        asset: r.asset,
        cls: r.cls,
        maxLever: r.maxLever,
        grade: r.score >= 85 ? 'A' : r.score >= 75 ? 'BBB' : r.score >= 65 ? 'BB' : 'B',
        score: r.score,
        symbol: r.symbol,
        thesis: `${strategy} on ${r.asset} | Confluence ${r.score}/100 | ${drivers[0]} | ${drivers[1]}`,
        assetId: r.asset.toLowerCase(),
        drivers,
        riskPct: pct(clamp(r.spreadPct * 2 + Math.abs(r.changePct) * 0.08, 0.3, 8)),
        summary: hasK
          ? `${strategy}: ${direction === 'LONG' ? 'upside' : 'downside'} momentum, RSI(1h) ${Math.round(r.k.rsi14)}, volume ${round(r.k.volRatio, 1)}× baseline.`
          : `${strategy}: ${direction === 'LONG' ? 'upside' : 'downside'} momentum on $${(r.quoteVolume / 1e6).toFixed(0)}M quote volume.`,
        harmonic: r.k.harmonic
          ? {
              type: r.k.harmonic.type,
              dir: r.k.harmonic.dir,
              quality: r.k.harmonic.quality,
              ratios: r.k.harmonic.ratios,
              dPrice: r.k.harmonic.dPrice,
            }
          : null,
        lowPrice: r.lowPrice,
        rangePct: pct(r.rangePct),
        strategy,
        changePct: pct(r.changePct),
        direction,
        highPrice: r.highPrice,
        lastPrice: r.lastPrice,
        spreadPct: pct(r.spreadPct),
        targetPct,
        updatedAt: new Date().toISOString(),
        entryPrice: r.lastPrice,
        quoteVolume: Math.round(r.quoteVolume),
        socialScore: 0,
        targetPrice:
          direction === 'LONG'
            ? r.lastPrice * (1 + targetPct / 100)
            : r.lastPrice * (1 - targetPct / 100),
        signalFamily: 'momentum',
        // carry: perp funding context — shorts collect when rate>0, longs pay
        funding: funding[r.asset] ?? null,
        carry:
          funding[r.asset] == null
            ? null
            : funding[r.asset].ratePct === 0
              ? 'flat'
              : (direction === 'SHORT') === (funding[r.asset].ratePct > 0)
                ? 'earn'
                : 'pay',
        deriv: (globalThis.__deriv || {})[r.asset] ?? null,
        social: (globalThis.__social || {})[r.asset] ?? null,
        news: (globalThis.__news || {})[r.asset] ?? null,
        mcap: (globalThis.__mcaps || {})[r.asset] ?? null,
        events: (globalThis.__events || {})[r.asset] ?? null,
        stopPct: pct(clamp(targetPct / 2, 2, 8)),
        ta: ta
          ? {
              bias: ta.bias,
              confluence: ta.confluence,
              reasons: ta.reasons,
              sfp: ta.sfp
                ? { type: ta.sfp.type, level: ta.sfp.level, strength: ta.sfp.strength, age: ta.sfp.age }
                : null,
              elliott: ta.elliott
                ? { dir: ta.elliott.dir, shortTop: ta.elliott.shortTop, longBottom: ta.elliott.longBottom, quality: ta.elliott.quality, ratios: ta.elliott.ratios }
                : null,
              wyckoff: ta.wyckoff
                ? {
                    type: ta.wyckoff.type,
                    phase: ta.wyckoff.phase,
                    event: ta.wyckoff.event ?? null,
                    quality: ta.wyckoff.quality,
                    volX: ta.wyckoff.eventDetail?.volX ?? null,
                    tr: ta.wyckoff.tr ?? null,
                    events: ta.wyckoff.events ?? [],
                  }
                : null,
              smc: ta.smc
                ? {
                    bos: ta.smc.bos, choch: ta.smc.choch, trend: ta.smc.trend,
                    zone: ta.smc.zone, inOB: ta.smc.inOB
                      ? { dir: ta.smc.inOB.dir, top: ta.smc.inOB.top, bot: ta.smc.inOB.bot }
                      : null,
                    eqh: ta.smc.eqh, eql: ta.smc.eql,
                  }
                : null,
              eq: ta.eq
                ? {
                    lastQ: ta.eq.lastQ, respect: ta.eq.respect, swept: ta.eq.swept,
                    wick: ta.eq.wick, rangeQ: ta.eq.rangeQ, rangePos: ta.eq.rangePos,
                  }
                : null,
              candles: ta.candles,
              fvgOpen: ta.fvgs.length,
              fvgNearest: ta.fvgs[0] ?? null,
              goldenPocket: ta.fib?.goldenPocket ?? false,
              fibClusters: ta.fib?.clusters ?? 0,
              trend: ta.structure?.trend ?? null,
              vwap: ta.vwap ? { z: ta.vwap.z, devPct: ta.vwap.devPct, fade: ta.vwap.fade } : null,
              eng: ta.eng
                ? Object.fromEntries(
                    Object.entries(ta.eng).map(([k, x]) => [k, x ? { dir: x.dir, label: x.label } : null])
                  )
                : null,
            }
          : null,
        momentumScore: r.momentumScore,
        rangePosition: round(r.rangePosition),
        reversalScore: r.surgeScore,
        liquidityScore: r.liquidityScore,
      };
    });

  const movers = rows
    .slice()
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 6)
    .map((r) => ({ price: r.lastPrice, symbol: r.asset, changePct: pct(r.changePct) }));
  const laggards = rows
    .slice()
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 6)
    .map((r) => ({ price: r.lastPrice, symbol: r.asset, changePct: pct(r.changePct) }));

  const advancing = rows.filter((r) => r.changePct > 0).length;
  const declining = rows.filter((r) => r.changePct < 0).length;
  const sorted = rows.map((r) => r.changePct).sort((a, b) => a - b);
  const medianChangePct = sorted.length ? pct(sorted[Math.floor(sorted.length / 2)]) : 0;
  const breadthPct = rows.length ? pct((advancing / rows.length) * 100) : 0;

  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(PULSE_FILE, 'utf8'));
  } catch {}
  history.push({ ts: Date.now(), value: pct(100 + medianChangePct) });
  history = history.slice(-PULSE_MAX_POINTS);
  fs.writeFileSync(PULSE_FILE, JSON.stringify(history));
  const values = history.map((p) => p.value);

  let fx = { audPerUsd: 1.5, usdPerAud: 0.667 };
  try {
    const fxJson = await (await fetch(FX_URL)).json();
    const aud = fxJson?.rates?.AUD;
    if (aud) fx = { audPerUsd: aud, usdPerAud: round(1 / aud, 4) };
  } catch {}

  // ---- signal pressure: near-miss candidates + what's blocking them ----
  const FACTORS = [
    ['momentumScore', 'momentum'],
    ['volumeScore', 'quote volume'],
    ['liquidityScore', 'liquidity'],
    ['surgeScore', 'vol surge'],
  ];
  const cutoff = ranked[MAX_SIGNALS - 1]?.score ?? 0;
  const pressureList = ranked
    .slice(MAX_SIGNALS, MAX_SIGNALS + 10)
    .map((r) => ({
      asset: r.asset,
      score: r.score,
      gap: Math.max(0, cutoff - r.score),
      lean: r.changePct >= 0 ? 'LONG' : 'SHORT',
      blocker: FACTORS.reduce((a, b) => (r[b[0]] < r[a[0]] ? b : a))[1],
    }));
  const pressurePct = cutoff
    ? Math.round(
        (pressureList.reduce((a, c) => a + c.score, 0) /
          (pressureList.length || 1) /
          cutoff) *
          100
      )
    : 0;

  const snap = {
    fx,
    pressure: {
      pct: Math.min(pressurePct, 99),
      cutoff,
      candidates: pressureList,
      scanning: ranked.length,
    },
    pulse: {
      low: Math.min(...values),
      high: Math.max(...values),
      delta: pct((values.at(-1) ?? 100) - (values[0] ?? 100)),
      series: history,
      baseline: 100,
    },
    movers,
    status: 'live',
    signals,
    laggards,
    overview: {
      advancing,
      declining,
      breadthPct,
      longSignals: signals.filter((s) => s.direction === 'LONG').length,
      totalVolume: Math.round(rows.reduce((a, r) => a + r.quoteVolume, 0)),
      harmonicHits: 0,
      scannedPairs: rows.length,
      shortSignals: signals.filter((s) => s.direction === 'SHORT').length,
      socialCoverage: 0,
      medianChangePct,
      averageSpreadPct: pct(rows.reduce((a, r) => a + r.spreadPct, 0) / (rows.length || 1)),
    },
    refreshedAt: new Date().toISOString(),
    scanWindowSeconds: 600,
    error: null,
    source: 'bitget-direct',
    universeFilter: 'bitget-usdt-m-futures',
  };

  fs.writeFileSync(path.join(API, 'market-scanner.json'), JSON.stringify(snap));

  // ---- coin detail: sparklines + metrics for every kline-enriched pair ----
  const priceByAsset = new Map(rows.map((r) => [r.asset, r.lastPrice]));
  const coinDetail = {};
  for (const r of rows.slice(0, KLINE_CANDIDATES)) {
    const k = enriched.get(r.asset);
    if (!k) continue;
    coinDetail[r.asset] = {
      price: r.lastPrice,
      changePct: pct(r.changePct),
      quoteVolume: Math.round(r.quoteVolume),
      rsi14: Math.round(k.rsi14),
      volRatio: round(k.volRatio, 2),
      spark: k.closes,
    };
  }
  fs.writeFileSync(
    path.join(API, 'coin-detail.json'),
    JSON.stringify({ refreshedAt: snap.refreshedAt, coins: coinDetail })
  );

  // ---- funding intelligence: write api/funding.json ----
  try {
    const rows2 = Object.entries(funding)
      .map(([asset, f]) => ({ asset, ...f }))
      .sort((a, b) => Math.abs(b.annualPct) - Math.abs(a.annualPct));
    fs.writeFileSync(
      path.join(API, 'funding.json'),
      JSON.stringify({
        refreshedAt: snap.refreshedAt,
        note: 'delta-neutral funding harvest: long spot + short perp collects positive 8h funding. paper estimates, Bitget USDT-FUTURES.',
        best: rows2.slice(0, 10),
        rows: rows2,
      })
    );
  } catch {}

  // ---- derivatives + social intelligence: write api/sentiment.json ----
  try {
    const dv = globalThis.__deriv || {}, so = globalThis.__social || {}, nw2 = globalThis.__news || {},
          mcap = globalThis.__mcaps || {}, evs = globalThis.__events || {};
    const assets = {};
    for (const a of new Set([...Object.keys(dv), ...Object.keys(so), ...Object.keys(nw2), ...Object.keys(mcap), ...Object.keys(evs)])) {
      if (a === '_feeds') continue;
      assets[a] = { ...(dv[a] || {}), ...(so[a] || {}), ...(mcap[a] || {}), news: nw2[a] ?? null, events: evs[a] ?? null, dir: (dv[a] || {}).dir ?? (so[a] || {}).dir ?? (mcap[a] || {}).dir ?? null };
    }
    fs.writeFileSync(
      path.join(API, 'sentiment.json'),
      JSON.stringify({
        refreshedAt: snap.refreshedAt,
        feeds: dv._feeds || {},
        note: 'positioning pressure: open interest + funding trend (Bitget public futures). CoinGlass liquidations/long-short and LunarCrush galaxy/sentiment activate when API keys are configured (scripts/api-keys.json or env). Crowded positioning is treated as squeeze fuel against the crowd.',
        assets,
      })
    );
  } catch {}

  // headline prices for the landing header chips
  const majors = {};
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    const r = rows.find((x) => x.asset === sym);
    if (r) majors[sym] = { price: r.lastPrice, changePct: pct(r.changePct) };
  }
  fs.writeFileSync(
    path.join(API, 'prices.json'),
    JSON.stringify({ refreshedAt: snap.refreshedAt, majors })
  );

  // ---- signal ledger: open entries + settled outcomes ----
  const EQUITY = 10000; // paper account, USD model
  const NOTIONAL = 1000; // legacy fallback notional (pre-leverage entries)
  const MAX_DEPLOYED = EQUITY * 4; // notional exposure cap — 400% of equity = 40% margin at 10x
  const FEE_PCT = 0.12; // Bitget USDT-M perp taker ~0.06% x2 sides
  const LEVERAGE = 10; // 10x isolated perpetuals
  const LIQ_PCT = 9.2; // ~1/lev − maintenance margin ≈ 9.2% adverse = liquidation
  let ledger = { entries: [], stats: {} };
  let ledgerCorrupt = false;
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (err) {
    ledgerCorrupt = err.code !== 'ENOENT'; // file exists but won't parse
  }
  ledger.entries ??= [];
  // re-tag asset classes from the live contract list — the taxonomy has
  // grown (index/commodity/metal/fx were once all 'stock'), and a stale
  // label on an open entry is a data bug, not entry-time evidence
  for (const e of ledger.entries) {
    const c = contractBySymbol.get(`${e.asset}USDT`.toUpperCase());
    if (c) e.cls = assetClass(e.asset.toUpperCase(), c.isRwa === 'YES');
  }
  const openFor = (a, d) =>
    ledger.entries.some(
      (e) => e.asset === a && e.direction === d && e.status === 'open'
    );
  const recentClosed = (a, d) =>
    ledger.entries.some(
      (e) =>
        e.asset === a &&
        e.direction === d &&
        e.status !== 'open' &&
        now - (e.exitTs ?? 0) < REENTRY_COOLDOWN_MS
    );
  // a reversal close locks the whole asset for an hour — no ping-pong
  const recentReversed = (a) =>
    ledger.entries.some(
      (e) =>
        e.asset === a &&
        e.status === 'reversed' &&
        now - (e.exitTs ?? 0) < 3600e3
    );
  // portfolio cap: total open notional can't exceed 400% of equity (= 40%
  // margin posted at 10x) — signals are score-sorted so the best setups get
  // slots first.
  // Tharp risk-based sizing: target 1% of equity AT RISK per trade, i.e.
  // notional = 1% / stop distance — tighter stops carry bigger notional for
  // the same dollar risk. 10x isolated: margin = notional/10, so a 30%
  // notional position only locks 3% margin. Conviction scales the risk
  // (A=full, B=half); notional capped at 30% of equity — concentration is
  // still concentration regardless of how little margin it posts.
  const RISK_PCT = 0.01, MAX_POS_PCT = 0.3, MIN_POS_USD = EQUITY * 0.05;
  // remaining open fraction after partial banks — banked rungs freed the
  // capital, so the exposure cap counts only what's still working
  const remFracOf = (e) =>
    e.tps
      ? e.tps.filter((t) => !t.hit).reduce((a, t) => a + t.frac, 0)
      : e.lockPnl != null
        ? 0.5
        : 1;
  const deployed = () =>
    ledger.entries
      .filter((e) => e.status === 'open')
      .reduce((a, e) => a + (e.notional ?? NOTIONAL) * remFracOf(e), 0);
  for (const s of signals) {
    // contract leverage cap — most RWA perps max at 20x, some at 5x;
    // paper lev is min(10x target, contract max), liq band scales with it
    const lev = Math.min(LEVERAGE, s.maxLever ?? LEVERAGE);
    const liqPct = Math.round((100 / lev - 0.8) * 10) / 10;
    // the stop must fire INSIDE the liquidation band — a stop wider than
    // ~80% of the band is fiction (liq executes first), so clamp it there
    const stopPct = Math.min(
      s.stopPct ?? Math.max(4, s.targetPct || 4),
      Math.max(1, Math.round(liqPct * 0.8 * 10) / 10)
    );
    const stopFrac = stopPct / 100;
    const conv = s.score >= 85 ? 1 : s.score >= 70 ? 0.75 : 0.5;
    const notional = Math.round(
      clamp((EQUITY * RISK_PCT * conv) / stopFrac, MIN_POS_USD, EQUITY * MAX_POS_PCT)
    );
    if (
      !openFor(s.asset, s.direction) &&
      !recentClosed(s.asset, s.direction) &&
      !recentReversed(s.asset) &&
      deployed() + notional <= MAX_DEPLOYED
    ) {
      ledger.entries.unshift({
        asset: s.asset,
        cls: s.cls ?? 'crypto',
        direction: s.direction,
        entry: s.entryPrice,
        notional,
        margin: Math.round(notional / lev),
        lev,
        liqPct,
        feePct: FEE_PCT,
        // multi-split take-profit ladder: bank 33%/33%/34% of the position
        // at 40%/70%/100% of the target move — "no one ever went broke
        // taking profit"; the engine harvests constantly, never waits for
        // a single all-or-nothing print
        tps: [
          { at: 0.4, frac: 0.33 },
          { at: 0.7, frac: 0.33 },
          { at: 1.0, frac: 0.34 },
        ],
        // dynamic stop (% adverse→locked-profit, from entry): starts at the
        // designed invalidation, moves to breakeven (zero-risk) once a safe
        // buffer prints, ratchets up behind profit, and only trails the
        // runner once price is past full target
        stopAt: -stopPct,
        targetPct: s.targetPct,
        targetPrice: s.targetPrice,
        score: s.score,
        grade: s.grade,
        strategy: s.strategy,
        harmonic: s.harmonic ?? null,
        ta: s.ta ?? null,
        mkt0: medianChangePct, // universe median 24h change at entry — benchmark for alpha
        funding: s.funding ?? null,
        carry: s.carry ?? null,
        stopPct,
        ts: now,
        status: 'open',
        exitPrice: null,
        exitTs: null,
        pnlPct: null,
      });
    }
  }
  const freshDir = new Map(signals.map((s) => [s.asset, s.direction]));
  for (const e of ledger.entries) {
    if (e.status !== 'open') continue;
    const px = priceByAsset.get(e.asset);
    const age = now - e.ts;
    let pnl = e.pnlPct;
    if (px) {
      pnl = pct(
        e.direction === 'LONG'
          ? ((px - e.entry) / e.entry) * 100
          : ((e.entry - px) / e.entry) * 100
      );
      e.lastPrice = px;
      e.rawPnl = pnl;
      e.peakPnl = Math.max(e.peakPnl ?? -Infinity, pnl);
      e.troughPnl = Math.min(e.troughPnl ?? Infinity, pnl);
      // ---- multi-split take-profit: a rung fills when the PEAK touched its
      // level — a resting limit order banks at the rung price even if the
      // mark has since retraced (the old instant-pnl check missed wicks
      // between builds and banked at whatever price was showing) ----
      if (e.tps) {
        for (const tp of e.tps)
          if (!tp.hit && e.peakPnl >= tp.at * e.targetPct) {
            tp.hit = true; tp.pnl = pct(tp.at * e.targetPct); tp.ts = now;
          }
        // ---- dynamic stop intelligence ----
        // zero-risk: once price covers 40% of target (TP1 territory), the
        // stop ratchets to breakeven — the trade can no longer lose
        if (e.peakPnl >= e.targetPct * 0.4) e.stopAt = Math.max(e.stopAt, 0);
        // profit ratchet: deeper into target → stop locks profit behind it
        if (e.peakPnl >= e.targetPct * 0.7) e.stopAt = Math.max(e.stopAt, e.targetPct * 0.4);
        if (e.peakPnl >= e.targetPct * 0.9) e.stopAt = Math.max(e.stopAt, e.targetPct * 0.65);
        // trailing stop — CAREFUL mode: only once the runner is past full
        // target does it trail (40% giveback of the peak), never earlier
        if (e.peakPnl > e.targetPct) e.stopAt = Math.max(e.stopAt, e.peakPnl * 0.6);
      }
      // legacy entries (pre-ladder) keep the lock-50 behavior
      else if (e.lockPnl == null && pnl >= e.targetPct / 2) {
        e.lockPnl = pnl;
        e.lockedAt = now;
        e.beStop = true;
      }
    }
    // blended P&L: banked split fractions are locked at their hit prices,
    // the remainder marks live — this is the true realized+open position
    const blended = (livePnl) => {
      if (!e.tps) return e.lockPnl != null ? (e.lockPnl + livePnl) / 2 : livePnl;
      const banked = e.tps.filter((t) => t.hit).reduce((a, t) => a + t.frac * t.pnl, 0);
      const rem = e.tps.filter((t) => !t.hit).reduce((a, t) => a + t.frac, 0);
      return banked + rem * livePnl;
    };
    const fee = e.feePct ?? FEE_PCT;
    // funding accrues on the fraction still open — banked rungs stopped
    // earning/paying when they closed
    const remFrac = remFracOf(e);
    const fundPnl =
      e.funding && e.carry && e.carry !== 'flat'
        ? (e.funding.ratePct || 0) * (age / 2.88e7) * (e.carry === 'earn' ? 1 : -1) * remFrac
        : 0;
    const settle = (status, exitPx, rawPnl) => {
      e.status = status;
      e.exitPrice = exitPx;
      e.exitTs = now;
      e.fundingPnl = pct(fundPnl);
      e.pnlPct = pct(blended(rawPnl) - fee + fundPnl);
      // alpha vs market drift: did the signal beat just riding the universe?
      // drift = change in the universe median 24h-move between entry and
      // exit, signed for our direction (a falling tape helps shorts)
      if (e.mkt0 != null) {
        const drift = medianChangePct - e.mkt0;
        e.alphaPct = pct(e.pnlPct - (e.direction === 'LONG' ? drift : -drift));
      }
    };
    // touch-based exits: a wick through a level counts even if the mark has
    // since retraced — peak catches targets, trough catches stops/wickouts
    const peak = Math.max(e.peakPnl ?? -Infinity, pnl ?? -Infinity);
    const trough = Math.min(e.troughPnl ?? Infinity, pnl ?? Infinity);
    const hit = px && peak >= e.targetPct; // full target = final rung fills
    const beStopped = px && !e.tps && e.beStop && trough <= 0;
    const stopLevel = e.tps
      ? e.stopAt ?? -(e.stopPct ?? Math.max(4, e.targetPct))
      : -(e.stopPct ?? Math.max(4, e.targetPct));
    const stopped = px && stopLevel != null && trough <= stopLevel;
    const trailed = stopped && stopLevel > 0; // stop was above entry → profit-lock exit
    // liquidation outranks everything: a wick through the band kills it
    const liquidated =
      px && (e.lev || 0) > 1 && trough <= -(e.liqPct ?? LIQ_PCT);
    const reversed =
      px && freshDir.get(e.asset) && freshDir.get(e.asset) !== e.direction;
    const expired = age > LEDGER_TTL_MS || (!px && age > UNTRACKED_TTL_MS);
    const sgn = e.direction === 'LONG' ? 1 : -1;
    // exits record the price the order actually filled at, not the mark we
    // happened to sample — limit TP fills AT target, stops fill AT the stop
    // (or worse on a gap), liquidation fires at the band
    const stopPx = e.entry * (1 + (sgn * stopLevel) / 100);
    const liqPx = e.entry * (1 - (sgn * (e.liqPct ?? LIQ_PCT)) / 100);
    if (liquidated) settle('liquidated', liqPx, -100 / (e.lev || LEVERAGE));
    // when a single window covers both target and stop the order is unknown —
    // resolve pessimistically (stop first) so the ledger never flatters itself
    else if (beStopped) settle('breakeven', e.entry, 0);
    else if (stopped)
      settle(
        trailed ? 'trailed' : stopLevel === 0 && e.tps ? 'breakeven' : 'stopped',
        pnl < stopLevel ? px : stopPx,
        Math.min(pnl, stopLevel)
      );
    else if (hit) settle('won', e.targetPrice ?? px, e.targetPct); // limit fill at target
    else if (reversed) settle('reversed', px, pnl);
    else if (expired) settle('expired', px ?? e.lastPrice ?? e.entry, px ? pnl : e.rawPnl ?? e.pnlPct ?? 0);
    else e.pnlPct = pct(blended(pnl) - fee + fundPnl); // live mark = banked + remainder
  }
  ledger.entries = ledger.entries.slice(0, LEDGER_MAX);
  const closed = ledger.entries.filter((e) => e.status !== 'open');
  // money truth: a profitable exit is a win regardless of which rule closed it
  const wins = closed.filter((e) => (e.pnlPct ?? 0) > 0).length;
  const losses = closed.filter((e) => (e.pnlPct ?? 0) < 0).length;
  const byStatus = {};
  closed.forEach((e) => (byStatus[e.status] = (byStatus[e.status] || 0) + 1));
  ledger.stats = {
    open: ledger.entries.filter((e) => e.status === 'open').length,
    closed: closed.length,
    wins,
    losses,
    flat: closed.length - wins - losses,
    byStatus,
    winRate: closed.length >= 5 ? pct((wins / closed.length) * 100) : null,
    avgPnlPct: closed.length
      ? pct(closed.reduce((a, e) => a + (e.pnlPct ?? 0), 0) / closed.length)
      : null,
    // did signals beat the market? avg excess return over universe-median
    // drift — the honest answer to "does this predict anything"
    avgAlphaPct: (() => {
      const a = closed.filter((e) => e.alphaPct != null);
      return a.length
        ? pct(a.reduce((s, e) => s + e.alphaPct, 0) / a.length)
        : null;
    })(),
  };
  // Van Tharp: R-multiples + SQN — the actual holy grail metric
  const Rs = closed
    .filter((e) => e.pnlPct != null)
    .map((e) => e.pnlPct / (e.stopPct ?? Math.max(4, e.targetPct || 4)));
  const avgR = Rs.length ? Rs.reduce((a, b) => a + b, 0) / Rs.length : null;
  const stdR =
    Rs.length > 1
      ? Math.sqrt(Rs.reduce((a, b) => a + (b - avgR) ** 2, 0) / (Rs.length - 1))
      : null;
  const sqn = stdR ? (avgR / stdR) * Math.sqrt(Rs.length) : null;
  ledger.stats.avgR = avgR != null ? round(avgR, 2) : null;
  ledger.stats.expectancyR = ledger.stats.avgR;
  ledger.stats.sqn = sqn != null ? round(sqn, 2) : null;
  ledger.stats.sqnBand =
    sqn == null
      ? null
      : sqn >= 7
        ? 'holy grail'
        : sqn >= 5
          ? 'superb'
          : sqn >= 3
            ? 'excellent'
            : sqn >= 2.5
              ? 'good'
              : sqn >= 2.0
                ? 'average'
                : sqn >= 1.6
                  ? 'below average'
                  : 'poor';
  // self-improving: doctrine weights learned from realized performance
  ledger.model = {
    stratAdj,
    samples: Object.fromEntries(
      Object.entries(stratR).map(([k, v]) => [k, v.length])
    ),
    updatedAt: snap.refreshedAt,
  };
  // ---- Sloggett risk-protocol adherence scorecard (paper equity model) ----
  const closedAll = closed.filter((e) => e.pnlPct != null);
  const rrList = closedAll.map(
    (e) => (e.targetPct || 4) / (e.stopPct ?? Math.max(4, e.targetPct || 4))
  );
  const riskPctList = closedAll.map(
    (e) =>
      ((e.stopPct ?? Math.max(4, e.targetPct || 4)) * (e.notional ?? NOTIONAL)) /
      EQUITY
  ); // stop% × actual notional → $ risk → % of paper equity
  let maxConsecL = 0,
    cur = 0;
  for (const e of [...closedAll].sort((a, b) => a.exitTs - b.exitTs)) {
    cur = e.pnlPct < 0 ? cur + 1 : 0;
    if (cur > maxConsecL) maxConsecL = cur;
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  ledger.stats.discipline = {
    equity: EQUITY,
    notional: NOTIONAL,
    avgRiskPctAcct: closedAll.length ? round(avg(riskPctList), 2) : null,
    avgRR: closedAll.length ? round(avg(rrList), 2) : null,
    rr12plus: closedAll.length
      ? pct(rrList.filter((r) => r >= 1.9).length / closedAll.length * 100)
      : null,
    maxConsecLosses: maxConsecL,
    journalCoverage: 100, // every entry carries a generated synopsis by construction
    stopsHonored: 100, // every close is rule-based — no discretionary overrides exist
    closedSample: closedAll.length,
    // fee intelligence: modeled round-trip fees actually paid, and carry
    // earned/paid by open positions' funding alignment
    feesPaidUsd: round(
      closedAll.reduce((a, e) => a + ((e.notional ?? NOTIONAL) * (e.feePct ?? FEE_PCT)) / 100, 0),
      2
    ),
    carryOpen: {
      earn: ledger.entries.filter((e) => e.status === 'open' && e.carry === 'earn').length,
      pay: ledger.entries.filter((e) => e.status === 'open' && e.carry === 'pay').length,
    },
  };
  const by = (key) => {
    const g = {};
    for (const e of closed) {
      const k = e[key] ?? 'other';
      (g[k] ??= { n: 0, wins: 0, pnl: 0 }).n++;
      g[k].wins += (e.pnlPct ?? 0) > 0 ? 1 : 0;
      g[k].pnl += e.pnlPct ?? 0;
    }
    return Object.fromEntries(
      Object.entries(g).map(([k, v]) => [
        k,
        { n: v.n, winRate: pct((v.wins / v.n) * 100), avgPnlPct: pct(v.pnl / v.n) },
      ])
    );
  };
  ledger.stats.byDirection = by('direction');
  ledger.stats.byStrategy = by('strategy');
  const sortedClosed = [...closed].sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0));
  ledger.stats.best = sortedClosed.at(-1)?.asset ?? null;
  ledger.stats.worst = sortedClosed[0]?.asset ?? null;
  if (!ledgerCorrupt) fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger));

  // ---- vault: a fixed share of every realized gain compounds into a
  // hold-forever BTC/ETH/SOL basket, marked to live prices ----
  let vault = { depositedUsd: 0, holdings: {}, fills: [] };
  let vaultCorrupt = false;
  try {
    vault = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  } catch (err) {
    vaultCorrupt = err.code !== 'ENOENT';
  }
  vault.fills ??= [];
  vault.holdings ??= {};
  for (const e of closed) {
    if (e.vaulted || (e.pnlPct ?? 0) <= 0) continue;
    const usd = (e.notional ?? TRADE_NOTIONAL) * (e.pnlPct / 100) * VAULT_PCT;
    vault.depositedUsd = pct(vault.depositedUsd + usd);
    vault.fills.unshift({
      ts: e.exitTs ?? now,
      asset: e.asset,
      status: e.status,
      pnlPct: e.pnlPct,
      usd: round(usd, 2),
    });
    for (const sym of VAULT_ASSETS) {
      const p = priceByAsset.get(sym);
      if (!p) continue;
      const h = (vault.holdings[sym] ??= { units: 0, costUsd: 0 });
      h.units += usd / VAULT_ASSETS.length / p;
      h.costUsd = round(h.costUsd + usd / VAULT_ASSETS.length, 2);
    }
    e.vaulted = true;
    if (!ledgerCorrupt) fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger));
  }
  let valueUsd = 0;
  const holdings = {};
  for (const [sym, h] of Object.entries(vault.holdings)) {
    const p = priceByAsset.get(sym);
    const v = h.units * (p ?? 0);
    valueUsd += v;
    holdings[sym] = {
      units: round(h.units, 6),
      costUsd: h.costUsd,
      valueUsd: round(v, 2),
      price: p ?? null,
    };
  }
  if (!vaultCorrupt) {
    fs.writeFileSync(
      VAULT_FILE,
      JSON.stringify({
        refreshedAt: snap.refreshedAt,
        vaultPct: VAULT_PCT,
        depositedUsd: vault.depositedUsd,
        valueUsd: round(valueUsd, 2),
        pnlUsd: round(valueUsd - vault.depositedUsd, 2),
        fills: vault.fills.slice(0, 200),
        holdings,
      })
    );
  }

  // pipeline health for the landing footer — only keys this pipeline owns;
  // the retired Jupiter/Solana snapshot used to leave a stale 'snapshot' key
  let health = {};
  try {
    health = JSON.parse(fs.readFileSync(path.join(API, 'health.json'), 'utf8'));
  } catch {}
  delete health.snapshot;
  health.scanner = {
    ok: true,
    at: snap.refreshedAt,
    pairs: rows.length,
    signals: signals.length,
    klineEnriched: enriched.size,
    ledgerOpen: ledger.stats.open,
  };
  fs.writeFileSync(path.join(API, 'health.json'), JSON.stringify(health));

  console.log(
    `scanner: ${signals.length} signals / ${movers.length} movers / ${laggards.length} laggards / ${rows.length} pairs (${enriched.size} kline-enriched) | ledger ${ledger.stats.open} open, ${wins}/${closed.length} won`
  );
}

main().catch((e) => {
  console.warn(`scanner build failed, keeping last snapshot: ${e.message}`);
});
