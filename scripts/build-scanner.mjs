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
// frozen-rule versioning: entries carry the ruleset that created them so
// results stay comparable across engine edits (audit requirement — keep
// v1.0 untouched results separate from whatever follows)
// frozen-rule versioning: v1.0 = static 10x; v1.1 = dynamic leverage +
// cluster governor; v1.2 = forensic overhaul; v1.3 = runner rung +
// retracement trail + six market types; v1.4 = Tharp doctrine ENFORCED —
// market-type gating (bear tape blocks momentum longs, bull tape blocks
// momentum shorts, chop raises the floor), volatile-regime heat haircut.
const ENGINE_VERSION = 'v1.4';
// append-only prospective record: every emitted signal, every run, never
// deleted or rewritten — the out-of-sample dataset the audit asked for
const ARCHIVE_FILE = path.join(API, 'signal-archive.json');
const ARCHIVE_MAX_RUNS = 2500; // ~17 days at a 10min cadence
// self-learning gate: doctrine weights stay DORMANT until the out-of-sample
// set is big enough that adjustments measure edge, not luck (audit: 22
// trades is nowhere near enough to start believing)
const LEARN_MIN_TOTAL = 100;
const LEARN_MIN_STRAT = 20;

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

// correlation governor's static fallback clusters — crypto majors vs alts
// vs each RWA class. Used when realized correlation data is missing.
const CRYPTO_MAJORS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'LTC', 'BCH', 'LINK', 'AVAX', 'TRX']);
const clusterOf = (e) =>
  e.cls === 'crypto'
    ? CRYPTO_MAJORS.has(e.asset) ? 'crypto-major' : 'crypto-alt'
    : e.cls ?? 'crypto';

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

// 5m candles from entry open -> now, for intraperiod settlement replay.
// 600 bars ≈ 50h — comfortably covers the 24h TTL; the still-forming tail
// candle is dropped (same rule as the TA klines).
async function fetchEntryCandles(e) {
  const out = [];
  let start = e.ts;
  for (let page = 0; page < 3; page++) {
    const res = await fetch(
      `${CANDLES_URL}?symbol=${e.asset}USDT&productType=USDT-FUTURES&granularity=5m&startTime=${start}&endTime=${Date.now()}&limit=200`
    );
    if (!res.ok) return null;
    const { data } = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    const rows = data
      .map((c) => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }))
      .sort((a, b) => a.t - b.t);
    for (const c of rows)
      if (!out.length || c.t > out[out.length - 1].t) out.push(c);
    const last = out[out.length - 1];
    if (data.length < 200 || !last || last.t + 300e3 >= Date.now() - 300e3) break;
    start = last.t + 300e3;
  }
  // drop the still-forming tail bar
  if (out.length && out[out.length - 1].t + 300e3 > Date.now()) out.pop();
  return out;
}

// 5m candles over an arbitrary closed range — used by the forward-outcome
// evaluator. Paginates to cover multi-day windows; unclosed tail dropped.
async function fetch5mRange(asset, fromMs, toMs) {
  const out = [];
  let start = fromMs;
  for (let page = 0; page < 8; page++) {
    const res = await fetch(
      `${CANDLES_URL}?symbol=${asset}USDT&productType=USDT-FUTURES&granularity=5m&startTime=${start}&endTime=${toMs}&limit=200`
    );
    if (!res.ok) return null;
    const { data } = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    const rows = data
      .map((c) => ({ t: +c[0], h: +c[2], l: +c[3], c: +c[4] }))
      .sort((a, b) => a.t - b.t);
    for (const c of rows)
      if (!out.length || c.t > out[out.length - 1].t) out.push(c);
    const last = out[out.length - 1];
    if (data.length < 200 || !last || last.t >= toMs - 300e3) break;
    start = last.t + 300e3;
  }
  if (out.length && out[out.length - 1].t + 300e3 > Date.now()) out.pop();
  return out;
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
  // ---- measured correlation structure ----
  // Static asset clusters are a prior; the real question is whether two
  // books move together NOW. Compute 48h of 1h simple returns per enriched
  // asset and pairwise Pearson — this drives BTC-beta per signal and the
  // correlation governor's same-bet test (avg corr ≥0.6 = same trade).
  const rets = new Map();
  for (const [asset, k] of enriched) {
    const cs = (k.candles || []).slice(-49).map((x) => x.c);
    if (cs.length >= 30)
      rets.set(asset, cs.slice(1).map((v, i) => ((v - cs[i]) / cs[i]) * 100));
  }
  const corrPair = (x, y) => {
    const n = Math.min(x.length, y.length);
    if (n < 20) return null;
    const xs = x.slice(-n), ys = y.slice(-n);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sx2 = 0, sy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sx2 += dx * dx; sy2 += dy * dy;
    }
    return sx2 > 0 && sy2 > 0 ? sxy / Math.sqrt(sx2 * sy2) : null;
  };
  const corrTo = (a, b) =>
    a === b ? 1 : rets.has(a) && rets.has(b) ? corrPair(rets.get(a), rets.get(b)) : null;
  const betaTo = (a, b) => {
    if (a === b) return 1;
    if (!rets.has(a) || !rets.has(b)) return null;
    const x = rets.get(a), y = rets.get(b);
    const n = Math.min(x.length, y.length);
    if (n < 20) return null;
    const xs = x.slice(-n), ys = y.slice(-n);
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sy2 = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sy2 += (ys[i] - my) ** 2; }
    return sy2 > 0 ? round(sxy / sy2, 2) : null;
  };
  // ---- Tharp market type: direction × volatility, measured objectively ----
  // Direction = market SQN of the universe-median 1h return series over
  // 48h (√N·mean/std — Tharp's own trendiness statistic). Volatility =
  // mean 1h ATR% across candidates, banded quiet/normal/volatile. Six
  // types: bull/bear/side × quiet/volatile. His rule: a system designed
  // for one type is insane to run in another — so every signal/entry/eval
  // record carries this tag and the eval engine grades by it.
  let marketSQN = 0, mktType = 'side-normal', atrPct = null;
  {
    const med1h = [];
    for (let i = 1; i <= 48; i++) {
      const xs = [];
      for (const k of enriched.values()) {
        const cs = k.candles || [];
        if (cs.length > i && cs[cs.length - i - 1].c > 0)
          xs.push(((cs[cs.length - i].c - cs[cs.length - i - 1].c) / cs[cs.length - i - 1].c) * 100);
      }
      if (xs.length > 20) {
        xs.sort((a, b) => a - b);
        med1h.push(xs[Math.floor(xs.length / 2)]);
      }
    }
    if (med1h.length > 10) {
      const m = med1h.reduce((a, b) => a + b, 0) / med1h.length;
      const s = Math.sqrt(med1h.reduce((a, b) => a + (b - m) ** 2, 0) / (med1h.length - 1));
      marketSQN = s > 0 ? round((m / s) * Math.sqrt(med1h.length), 2) : 0;
    }
    const atrs = [...enriched.values()].map((k) => {
      const cs = (k.candles || []).slice(-25);
      if (cs.length < 5) return null;
      let s = 0;
      for (let i = 1; i < cs.length; i++)
        s += Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)) / cs[i].c;
      return (s / (cs.length - 1)) * 100;
    }).filter((x) => x != null);
    atrPct = atrs.length ? round(atrs.reduce((a, b) => a + b, 0) / atrs.length, 2) : null;
    const dirClass = marketSQN > 0.5 ? 'bull' : marketSQN < -0.5 ? 'bear' : 'side';
    const volClass = atrPct == null ? 'normal' : atrPct < 0.55 ? 'quiet' : atrPct > 1.0 ? 'volatile' : 'normal';
    mktType = dirClass + '-' + volClass;
  }
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
  // Bayesian-shrunk adjustments, GATED: the audit is right that ~22 trades
  // is nowhere near enough for the machine to start believing it found which
  // strategies work — learning random luck is overfitting. Adjustments stay
  // dormant until ≥LEARN_MIN_TOTAL closed signals AND ≥LEARN_MIN_STRAT per
  // strategy; below that the shrinkage math still runs for reporting but
  // the score input is zeroed.
  const closedTotal = priorEntries.filter(
    (e) => e.status !== 'open' && e.pnlPct != null
  ).length;
  const learnActive = closedTotal >= LEARN_MIN_TOTAL;
  const stratAdj = Object.fromEntries(
    Object.entries(stratR).map(([k, v]) => {
      const n = v.length;
      const avg = v.reduce((a, b) => a + b, 0) / n;
      const shrunk = avg * (n / (n + 10));
      const adj = Math.round(clamp(shrunk * 4, -4, 4) * 10) / 10;
      return [k, learnActive && n >= LEARN_MIN_STRAT ? adj : 0];
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
      // climax-entry penalty: the ledger's forensic finding — the highest
      // scores fired on overextended moves and entered late (85+ bucket
      // avg +0.03% vs <75 bucket +0.72%). A LONG at RSI>75 or already +8%
      // is buying the top; score pays for the entry, not the move.
      const climax =
        dir0 === 'LONG'
          ? k.rsi14 > 75 || r.changePct > 8
          : k.rsi14 < 25 || r.changePct < -8;
      const score = Math.round(
        clamp(
          momentumScore * 0.4 + volumeScore * 0.25 + liquidityScore * 0.2 +
            surgeScore * 0.15 +
            Math.min((k.ta?.confluence || 0) * 3, 12) +
            (stratAdj[strategy] || 0) +
            derivBoost +
            newsBoost +
            mcapBoost +
            (climax ? -10 : 0),
          0,
          100
        )
      );
      return { ...r, k, strategy, dir: dir0, momentumScore, volumeScore, liquidityScore, surgeScore, score };
    })
    .sort((a, b) => b.score - a.score);
  const signals = ranked
    .slice(0, MAX_SIGNALS)
    .map((r, boardIdx) => {
      const ta = r.k.ta ?? null;
      const direction = r.dir;
      const strategy = r.strategy;
      // forensic finding: 15% targets almost never fill (won=9%) while the
      // paired 7–9% stops fill constantly — asymmetric suicide. Targets cap
      // at 8% (moves that actually complete in <24h) and stops at half that
      // (≤4%) so a stop-out costs ~-2R not -9R.
      const targetPct = pct(clamp(r.rangePct * 0.35, 3, 8));
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
        ver: ENGINE_VERSION,
        boardRank: boardIdx + 1, // position on the emitted board this run
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
              // the validated XABCD geometry itself — the journal chart draws
              // this exact pattern rather than re-detecting a lookalike
              pts: (r.k.harmonic.points || []).map((p) => ({
                t: p.t,
                p: p.p,
                ty: p.type,
              })),
            }
          : null,
        lowPrice: r.lowPrice,
        rangePct: pct(r.rangePct),
        strategy,
        changePct: pct(r.changePct),
        // raw features for per-component IC evaluation
        rsi: hasK ? round(r.k.rsi14, 1) : null,
        volRatio: hasK ? round(r.k.volRatio, 2) : null,
        momScore: r.momentumScore != null ? round(r.momentumScore, 1) : null,
        // measured market structure — beta + realized correlation to BTC
        // over the last 48h of 1h returns (null when klines are missing)
        betaBtc: betaTo(r.asset, 'BTC'),
        corrBtc: corrTo(r.asset, 'BTC') != null ? round(corrTo(r.asset, 'BTC'), 2) : null,
        mktType,
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
        stopPct: pct(clamp(targetPct / 2, 1.5, 4)),
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
  // measured tape regime — drives dynamic leverage + heat budget AND is
  // archived per run so eval can grade signals by the tape they called in
  const regime =
    medianChangePct > 0.5 && breadthPct > 55
      ? 'risk-on'
      : medianChangePct < -0.5 && breadthPct < 45
        ? 'risk-off'
        : 'mixed';

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
      regime,
      mktType,
      marketSQN,
      atrPct,
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

  // ---- measured correlation structure → api/correlation.json ----
  try {
    const board = signals.map((s) => s.asset);
    const matrix = board.map((a) =>
      board.map((b) => (corrTo(a, b) != null ? round(corrTo(a, b), 2) : null))
    );
    const corrList = [...rets.keys()].map((a) => ({
      asset: a,
      corrBtc: corrTo(a, 'BTC') != null ? round(corrTo(a, 'BTC'), 2) : null,
      corrEth: corrTo(a, 'ETH') != null ? round(corrTo(a, 'ETH'), 2) : null,
      betaBtc: betaTo(a, 'BTC'),
      cluster: clusterOf({ asset: a, cls: (rows.find((r) => r.asset === a) || {}).cls }),
    }));
    // universe coupling: mean pairwise corr across the board — high coupling
    // means diversification is an illusion right now
    const pairs = [];
    for (let i = 0; i < board.length; i++)
      for (let j = i + 1; j < board.length; j++)
        if (matrix[i][j] != null) pairs.push(matrix[i][j]);
    fs.writeFileSync(
      path.join(API, 'correlation.json'),
      JSON.stringify({
        refreshedAt: snap.refreshedAt,
        note: 'realized 48h pairwise correlation of 1h returns, Bitget USDT-M candidates. The risk governor treats corr>=0.6 as the same bet.',
        windowHours: 48,
        boardAssets: board,
        boardMatrix: matrix,
        meanBoardCorr: pairs.length ? round(pairs.reduce((a, b) => a + b, 0) / pairs.length, 2) : null,
        assets: corrList,
      })
    );
  } catch {}

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

  // ---- intelligence wire: RSS headlines, asset-tagged → api/news.json ----
  // Key-free public feeds. Headlines are tagged to universe assets and a
  // keyword tone estimate — display context, deliberately NOT a score input
  // (headline sentiment is noise until the eval engine proves otherwise).
  try {
    const FEEDS = [
      { src: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
      { src: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
    ];
    const NAME_MAP = {
      BTC: /\bbitcoin\b|\bbtc\b/i, ETH: /\bethereum\b|\bether\b|\beth\b/i,
      SOL: /\bsolana\b|\bsol\b/i, XRP: /\bxrp\b|\bripple\b/i,
      DOGE: /\bdoge\b|\bdogecoin\b/i, BNB: /\bbnb\b|\bbinance\b/i,
      ADA: /\bcardano\b|\bada\b/i, LINK: /\bchainlink\b/i,
      XAU: /\bgold\b|\bbullion\b/i, XAG: /\bsilver\b/i,
      CL: /\boil\b|\bcrude\b|\bwti\b/i, SPX: /\bs&p\b|\bspx\b/i,
      NDX100: /\bnasdaq\b/i, DXY: /\bdollar index\b|\bdxy\b/i,
    };
    const BULL = /surge|soar|rally|record|all-time high|\bath\b|etf inflow|adoption|approve|breakout|rebound|accumulat|bullish|pump/i;
    const BEAR = /crash|plunge|hack|exploit|ban|lawsuit|selloff|sell-off|dump|bearish|liquidat|fraud|collapse|outflow|fear|recession|tariff/i;
    const items = [];
    for (const f of FEEDS) {
      try {
        const res = await fetch(f.url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const xml = await res.text();
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const b = m[1];
          const title = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || b.match(/<title>(.*?)<\/title>/) || [])[1];
          const link = (b.match(/<link>(.*?)<\/link>/) || [])[1];
          const pub = (b.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];
          if (!title) continue;
          const t = title.trim();
          const ts = Date.parse(pub || 0) || now;
          const tags = [];
          for (const [a, re] of Object.entries(NAME_MAP)) if (re.test(t)) tags.push(a);
          // also tag any universe symbol explicitly named in the headline
          for (const r of rows.slice(0, KLINE_CANDIDATES))
            if (new RegExp(`\\b${r.asset}\\b`, 'i').test(t) && !tags.includes(r.asset)) tags.push(r.asset);
          const tone = BULL.test(t) ? 'bull' : BEAR.test(t) ? 'bear' : 'neutral';
          items.push({ ts, src: f.src, title: t.slice(0, 140), link: (link || '').trim(), tags: tags.slice(0, 6), tone });
        }
      } catch {}
    }
    items.sort((a, b) => b.ts - a.ts);
    const fresh = items.filter((i) => now - i.ts < 24 * 3600e3);
    fs.writeFileSync(
      path.join(API, 'news.json'),
      JSON.stringify({
        refreshedAt: snap.refreshedAt,
        note: 'public RSS wire — headlines tagged to universe assets; tone is a keyword estimate, context only, never a score input',
        items: fresh.slice(0, 40),
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
  // portfolio heat cap — regime-scaled: the book is allowed to carry more
  // total risk when the measured tape supports the traded direction, less
  // for counter-trend trades in a hostile regime
  const heatCapFor = (dir) => {
    const aligned =
      (dir === 'LONG' && regime === 'risk-on') ||
      (dir === 'SHORT' && regime === 'risk-off');
    const counter =
      (dir === 'LONG' && regime === 'risk-off') ||
      (dir === 'SHORT' && regime === 'risk-on');
    return aligned ? 6 : counter ? 2.5 : 4;
  };
  // correlation governor: BTC+ETH+SOL+alts aren't independent bets — during
  // a shock they're the same crypto risk. Cap heat per correlated cluster
  // so the book can't stack 15 disguised copies of one bet.
  const CLUSTER_HEAT_CAP = 2.5; // % of equity at risk per correlated cluster
  // measured-corr heat: an open position counts against the candidate's
  // cluster when their realized 48h correlation is ≥0.6 — the "same bet"
  // test. Falls back to the static asset-class cluster when either side
  // lacks kline data. This is the governor Will described: fifteen crypto
  // longs stop being fifteen risks the moment the tape says they're one.
  const SAME_BET_CORR = 0.6;
  const openRiskByCluster = (candidate) =>
    (ledger.entries
      .filter((e) => {
        if (e.status !== 'open') return false;
        const c = corrTo(candidate.asset, e.asset);
        return c != null ? c >= SAME_BET_CORR : clusterOf(e) === clusterOf(candidate);
      })
      .reduce((a, e) => {
        const stopPnl = e.tps
          ? (e.stopAt ?? -(e.stopPct ?? Math.max(4, e.targetPct ?? 8)))
          : -(e.stopPct ?? Math.max(4, e.targetPct ?? 8));
        return (
          a + (Math.max(0, -stopPnl) / 100) * remFracOf(e) * (e.notional ?? NOTIONAL)
        );
      }, 0) / EQUITY) * 100;
  // no-trade floor: below BBB the board is noise — signals still emit and
  // archive (the eval engine grades them) but no position opens. Standing
  // down is a legitimate output.
  const MIN_ENTRY_SCORE = 70;
  // ---- Tharp's core law enforced: no system works in every market type.
  // bear tape → only reversal-family LONGs trade; bull tape → only
  // exhaustion-family SHORTs; sideways chop → momentum needs a higher bar
  // (the forensic bleeders were exactly momentum-in-chop). Volatile tapes
  // get a 0.75× heat haircut — chop is where books die.
  const REV_LONG = new Set(['Wyckoff Spring', 'Oversold Reversal', 'Elliott W5 Bottom', 'SMC CHoCH', 'VWAP Reversion', 'PA Quartile', 'Key Level SFP']);
  const EXH_SHORT = new Set(['Elliott W5 Short', 'Wyckoff Upthrust', 'Wyckoff Ice Break', 'Key Level SFP', 'Momentum Breakdown']);
  const MEANREV = new Set([...REV_LONG, ...EXH_SHORT]);
  const mktAllows = (s) => {
    if (mktType.startsWith('bear')) return s.direction === 'SHORT' || REV_LONG.has(s.strategy);
    if (mktType.startsWith('bull')) return s.direction === 'LONG' || EXH_SHORT.has(s.strategy);
    return s.score >= MIN_ENTRY_SCORE + 8 || MEANREV.has(s.strategy);
  };
  const volHaircut = mktType.endsWith('volatile') ? 0.75 : 1;
  const entryFloor = MIN_ENTRY_SCORE + (mktType.endsWith('volatile') ? 5 : 0);
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
  // portfolio heat: total equity at risk if every live stop fired right
  // now — positions with locked-profit stops contribute zero. Tharp's
  // heat rule caps the whole book, not just each trade.
  const openRiskPct = () =>
    (ledger.entries
      .filter((e) => e.status === 'open')
      .reduce((a, e) => {
        const stopPnl = e.tps
          ? (e.stopAt ?? -(e.stopPct ?? Math.max(4, e.targetPct ?? 8)))
          : -(e.stopPct ?? Math.max(4, e.targetPct ?? 8));
        return (
          a +
          (Math.max(0, -stopPnl) / 100) * remFracOf(e) * (e.notional ?? NOTIONAL)
        );
      }, 0) /
      EQUITY) *
    100;
  for (const s of signals) {
    // dynamic leverage — scales with MEASURED regime alignment and
    // conviction, never with narrative. Under 1%-risk sizing leverage
    // doesn't multiply profit; it sets margin efficiency and liquidation
    // distance, so the binding constraint is the liquidation band the
    // stop must live inside: lev <= 80/(stopPct + 0.64) keeps the
    // designed stop at <=80% of the band. Tight stops earn leverage,
    // wide stops don't.
    const dirUp = s.direction === 'LONG';
    const aligned =
      (dirUp && regime === 'risk-on') || (!dirUp && regime === 'risk-off');
    const counter =
      (dirUp && regime === 'risk-off') || (!dirUp && regime === 'risk-on');
    const levTarget = aligned && s.score >= 85 ? 20 : aligned ? 15 : counter ? 5 : 10;
    const stopWant = s.stopPct ?? Math.max(4, s.targetPct || 4);
    const levMax = Math.max(3, Math.floor(80 / (stopWant + 0.64)));
    const lev = Math.max(3, Math.min(levTarget, levMax, s.maxLever ?? 20));
    const liqPct = Math.round((100 / lev - 0.8) * 10) / 10;
    // the stop must fire INSIDE the liquidation band — a stop wider than
    // ~80% of the band is fiction (liq executes first), so clamp it there
    const stopPct = Math.min(
      stopWant,
      Math.max(1, Math.round(liqPct * 0.8 * 10) / 10)
    );
    const stopFrac = stopPct / 100;
    const conv = s.score >= 85 ? 1 : s.score >= 70 ? 0.75 : 0.5;
    // strategy circuit-breaker — a doctrine that has already bled on ≥3
    // closed trades gets half-size until its record clears. Risk control,
    // not learning: the adaptation gate stays dormant.
    let stratN = 0, stratPnl = 0;
    for (const e of ledger.entries)
      if (e.status !== 'open' && e.strategy === s.strategy) { stratN++; stratPnl += e.pnlPct || 0; }
    const stratMul = stratN >= 3 && stratPnl < 0 ? 0.5 : 1;
    const notional = Math.round(
      clamp((EQUITY * RISK_PCT * conv * stratMul) / stopFrac, MIN_POS_USD, EQUITY * MAX_POS_PCT)
    );
    const newHeatPct = (stopFrac * notional) / EQUITY * 100;
    if (
      s.score >= entryFloor &&
      mktAllows(s) &&
      !openFor(s.asset, s.direction) &&
      !recentClosed(s.asset, s.direction) &&
      !recentReversed(s.asset) &&
      deployed() + notional <= MAX_DEPLOYED &&
      openRiskPct() + newHeatPct <= heatCapFor(s.direction) * volHaircut &&
      openRiskByCluster(s) + newHeatPct <= CLUSTER_HEAT_CAP * volHaircut
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
        // take-profit ladder + RUNNER: bank 30%/30%/25% at 40%/70%/100% of
        // target, and leave a 15% runner that never has a limit — it trails
        // behind the peak. Forensic: zero trades ever reached +2R because
        // the ladder closed everything at target. Tharp: the right tail is
        // where expectancy lives — the runner is how we reach it.
        tps: [
          { at: 0.4, frac: 0.3 },
          { at: 0.7, frac: 0.3 },
          { at: 1.0, frac: 0.25 },
        ],
        runner: 0.15, // residual fraction that trails past target
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
        regime, // measured tape regime at entry — leverage/heat keyed off this
        mktType, // Tharp six-type tag: direction × volatility at entry
        funding: s.funding ?? null,
        carry: s.carry ?? null,
        stopPct,
        // prospective-record fields: what the world looked like at signal
        // time — spread/slippage estimate, universe + pool size, board slot
        ver: s.ver ?? ENGINE_VERSION,
        boardRank: s.boardRank ?? null,
        spreadPct: s.spreadPct ?? null,
        slipPct: s.spreadPct != null ? pct(s.spreadPct / 2) : null,
        universeSize: rows.length,
        poolN: candidates.length,
        ts: now,
        status: 'open',
        exitPrice: null,
        exitTs: null,
        pnlPct: null,
      });
    }
  }
  const freshDir = new Map(signals.map((s) => [s.asset, s.direction]));

  // ---- intraperiod settlement: prefetch 5m candles for every open entry ----
  // The audit's sharpest question: can a 10-minute sampling cadence award
  // targets that never filled, or miss stops that triggered between builds?
  // Tick extremes can't see wicks — candles can. We replay each open
  // position through the 5m tape chronologically and let levels fire on the
  // candles that actually traded them.
  const openEntries = ledger.entries.filter((e) => e.status === 'open');
  const openCandles = new Map();
  for (let i = 0; i < openEntries.length; i += 12) {
    await Promise.all(
      openEntries.slice(i, i + 12).map(async (e) => {
        const cs = await fetchEntryCandles(e).catch(() => null);
        if (cs && cs.length) openCandles.set(e, cs);
      })
    );
  }

  for (const e of ledger.entries) {
    if (e.status !== 'open') continue;
    const px = priceByAsset.get(e.asset);
    const age = now - e.ts;
    let pnl = e.pnlPct;
    const sgn = e.direction === 'LONG' ? 1 : -1;
    const dirPnl = (price) =>
      pct((sgn * (price - e.entry)) / e.entry * 100);
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
    // earning/paying when they closed; computed lazily so mid-replay settles
    // charge the fraction actually open at that moment
    const fundPnlNow = () =>
      e.funding && e.carry && e.carry !== 'flat'
        ? (e.funding.ratePct || 0) * (age / 2.88e7) * (e.carry === 'earn' ? 1 : -1) * remFracOf(e)
        : 0;
    const settle = (status, exitPx, rawPnl, tsC) => {
      e.status = status;
      e.exitPrice = exitPx;
      e.exitTs = tsC ?? now;
      const fp = fundPnlNow();
      e.fundingPnl = pct(fp);
      e.pnlPct = pct(blended(rawPnl) - fee + fp);
      // alpha vs market drift: did the signal beat just riding the universe?
      if (e.mkt0 != null) {
        const drift = medianChangePct - e.mkt0;
        e.alphaPct = pct(e.pnlPct - (e.direction === 'LONG' ? drift : -drift));
      }
    };
    const stopLevel = () =>
      e.tps
        ? e.stopAt ?? -(e.stopPct ?? Math.max(4, e.targetPct))
        : -(e.stopPct ?? Math.max(4, e.targetPct));
    // favorable excursion: peak, rung banks, stop ratchets — limit orders
    // fill at their level even when the mark later retraces
    const applyFavorable = (fav, tsC) => {
      e.peakPnl = Math.max(e.peakPnl ?? -Infinity, fav);
      if (e.tps) {
        for (const tp of e.tps)
          if (!tp.hit && e.peakPnl >= tp.at * e.targetPct) {
            tp.hit = true; tp.pnl = pct(tp.at * e.targetPct); tp.ts = tsC ?? now;
          }
        // retracement trail (Tharp: give back at most half the excursion):
        // past 40% of target the stop floors at breakeven AND trails at
        // 50% of the running peak — a fade keeps half the move instead of
        // round-tripping to a +0.3% scratch. Forensic capture was 16%.
        if (e.peakPnl >= e.targetPct * 0.4)
          e.stopAt = Math.max(e.stopAt, Math.max(0, e.peakPnl * 0.5));
        if (e.peakPnl >= e.targetPct * 0.9)
          e.stopAt = Math.max(e.stopAt, e.peakPnl * 0.65);
        // past target the runner trails at 55% of peak — wide enough to
        // breathe through continuation pullbacks, tight enough to keep
        // most of an overshoot
        if (e.peakPnl > e.targetPct) e.stopAt = Math.max(e.stopAt, e.peakPnl * 0.55);
      } else if (e.lockPnl == null && fav >= e.targetPct / 2) {
        e.lockPnl = fav;
        e.lockedAt = tsC ?? now;
        e.beStop = true;
      }
    };
    // adverse check — liquidation first, then stop family; settles at the
    // level that filled (or the mark if it gapped through). Returns true
    // when the entry just closed.
    const checkAdverse = (adv, markPx, tsC) => {
      e.troughPnl = Math.min(e.troughPnl ?? Infinity, adv);
      if ((e.lev || 0) > 1 && adv <= -(e.liqPct ?? LIQ_PCT)) {
        settle('liquidated',
          e.entry * (1 - (sgn * (e.liqPct ?? LIQ_PCT)) / 100),
          -100 / (e.lev || LEVERAGE), tsC);
        return true;
      }
      const sl = stopLevel();
      if (!e.tps && e.beStop && adv <= 0) {
        settle('breakeven', e.entry, 0, tsC);
        return true;
      }
      if (sl != null && adv <= sl) {
        settle(
          sl > 0 ? 'trailed' : sl === 0 && e.tps ? 'breakeven' : 'stopped',
          adv < sl ? markPx : e.entry * (1 + (sgn * sl) / 100),
          Math.min(adv, sl), tsC
        );
        return true;
      }
      return false;
    };
    const checkFavorable = (fav, markPx, tsC) => {
      applyFavorable(fav, tsC);
      if (e.peakPnl >= e.targetPct) {
        // v1.3+: the ladder's last rung banks at target but a 15% runner
        // stays on and trails — the trade only settles when the trail,
        // stop, reversal or TTL closes it. Older entries (no runner field)
        // keep their original settle-at-target semantics.
        if (e.runner) e.targetHit = e.targetHit ?? tsC ?? now;
        else {
          settle('won', e.targetPrice ?? markPx, e.targetPct, tsC);
          return true;
        }
      }
      return false;
    };
    // dead-zone time-stop: >6h old, no rung banked, mark under +0.3% —
    // the thesis didn't work, so the stop tightens to a −0.3% scratch line.
    // Forensic: the 6–12h bucket held every catastrophic stop-out (−7.6%
    // total); trades that go nowhere get scratched early instead of riding
    // the full designed stop to settlement.
    const DEAD_MS = 6 * 3600e3;
    const timeStop = (tsNow, curPnl) => {
      if (!e.tps) return;
      if (!e.tps.some((t) => t.hit) && tsNow - e.ts > DEAD_MS && (curPnl ?? -1) < 0.3)
        e.stopAt = Math.max(e.stopAt ?? -Infinity, -0.3);
    };

    // candle replay: adverse extreme first within each bar — when a single
    // bar covers both levels the order is unknowable, so we resolve the
    // pessimistic path (the ledger must never flatter itself). The replay
    // only runs when the tape reaches back to entry: persisted stop/ladder
    // state has already ratcheted, so old candles must be judged against a
    // reset entry-time state — all replayed fields are deterministic
    // functions of the tape and rebuild identically every build.
    const cs = openCandles.get(e);
    if (cs && cs.length && cs[0].t <= e.ts + 6e5) {
      e.peakPnl = e.troughPnl = undefined;
      if (e.tps) {
        for (const tp of e.tps) { tp.hit = false; tp.pnl = null; tp.ts = null; }
        e.stopAt = -(e.stopPct ?? Math.max(4, e.targetPct));
      } else {
        e.lockPnl = null; e.beStop = false;
      }
      for (const c of cs) {
        const advPx = sgn > 0 ? c.l : c.h;
        timeStop(c.t + 300e3, dirPnl(advPx));
        if (checkAdverse(dirPnl(advPx), advPx, c.t + 300e3)) break;
        const favPx = sgn > 0 ? c.h : c.l;
        if (checkFavorable(dirPnl(favPx), favPx, c.t + 300e3)) break;
      }
      if (e.status === 'open') {
        // last closed candle is a better mark than a stale tick when the
        // symbol momentarily drops off the ticker list
        e.lastPrice = cs[cs.length - 1].c;
        e.rawPnl = dirPnl(e.lastPrice);
      }
    }
    // live tick — same touch logic on the freshest mark; cumulative
    // peak/trough covers the candle-less fallback path too
    if (e.status === 'open' && px) {
      pnl = dirPnl(px);
      e.lastPrice = px;
      e.rawPnl = pnl;
      timeStop(now, pnl);
      if (!checkAdverse(Math.min(e.troughPnl ?? Infinity, pnl), px))
        checkFavorable(Math.max(e.peakPnl ?? -Infinity, pnl), px);
    }
    // still open: reversal / expiry / live mark. NOTE the unpriced path keeps
    // the stored mark — re-blending e.pnlPct would compound banked rungs
    // every tick (that was a real bug for untracked entries)
    if (e.status === 'open') {
      const reversed =
        px && freshDir.get(e.asset) && freshDir.get(e.asset) !== e.direction;
      const expired = age > LEDGER_TTL_MS || (!px && age > UNTRACKED_TTL_MS);
      if (reversed) settle('reversed', px, pnl);
      else if (expired)
        settle('expired', px ?? e.lastPrice ?? e.entry, px ? pnl : e.rawPnl ?? e.pnlPct ?? 0);
      else if (px) e.pnlPct = pct(blended(pnl) - fee + fundPnlNow());
      else if (e.rawPnl != null) e.pnlPct = pct(blended(e.rawPnl) - fee + fundPnlNow());
    }
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
    openRiskPct: pct(openRiskPct()), // portfolio heat — equity at risk if every stop fires
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
    // full audit reporting: profit factor, max drawdown on the realized
    // equity path, avg winner/loser — net expectancy after costs is
    // avgPnlPct above (fees + funding are already inside pnlPct)
    profitFactor: (() => {
      const gW = closed.filter((e) => (e.pnlPct ?? 0) > 0).reduce((a, e) => a + e.pnlPct, 0);
      const gL = Math.abs(closed.filter((e) => (e.pnlPct ?? 0) < 0).reduce((a, e) => a + e.pnlPct, 0));
      return gL > 0 ? round(gW / gL, 2) : gW > 0 ? Infinity : null;
    })(),
    maxDrawdownPct: (() => {
      let eq = 0, peak = 0, mdd = 0;
      for (const e of [...closed].sort((a, b) => (a.exitTs ?? 0) - (b.exitTs ?? 0))) {
        eq += (e.pnlPct ?? 0) * ((e.notional ?? NOTIONAL) / EQUITY);
        peak = Math.max(peak, eq);
        mdd = Math.max(mdd, peak - eq);
      }
      return closed.length ? pct(mdd) : null;
    })(),
    avgWinPct: (() => {
      const w = closed.filter((e) => (e.pnlPct ?? 0) > 0);
      return w.length ? pct(w.reduce((a, e) => a + e.pnlPct, 0) / w.length) : null;
    })(),
    avgLossPct: (() => {
      const l = closed.filter((e) => (e.pnlPct ?? 0) < 0);
      return l.length ? pct(l.reduce((a, e) => a + e.pnlPct, 0) / l.length) : null;
    })(),
    byGrade: (() => {
      const g = {};
      for (const e of closed) {
        const k = e.grade ?? '?';
        (g[k] ??= { n: 0, wins: 0, pnl: 0 }).n++;
        g[k].wins += e.pnlPct > 0 ? 1 : 0;
        g[k].pnl = pct(g[k].pnl + (e.pnlPct ?? 0));
      }
      for (const k in g) g[k].winRate = pct((g[k].wins / g[k].n) * 100);
      return g;
    })(),
    byVersion: (() => {
      const g = {};
      for (const e of closed) {
        const k = e.ver ?? 'v0.x';
        (g[k] ??= { n: 0, wins: 0, pnl: 0 }).n++;
        g[k].wins += e.pnlPct > 0 ? 1 : 0;
        g[k].pnl = pct(g[k].pnl + (e.pnlPct ?? 0));
      }
      for (const k in g) g[k].winRate = pct((g[k].wins / g[k].n) * 100);
      return g;
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
  ledger.stats.sharpeR = stdR ? round(avgR / stdR, 2) : null; // per-trade Sharpe — SQN is this × √N
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
  // Tharp: the system IS its R-multiple distribution — publish the shape
  const rHist = { '≤-1R': 0, '-1..-0.5': 0, '-0.5..0': 0, '0..+0.5': 0, '+0.5..1': 0, '+1..2': 0, '≥+2': 0 };
  for (const r of Rs)
    rHist[r <= -1 ? '≤-1R' : r <= -0.5 ? '-1..-0.5' : r < 0 ? '-0.5..0' : r < 0.5 ? '0..+0.5' : r < 1 ? '+0.5..1' : r < 2 ? '+1..2' : '≥+2']++;
  ledger.stats.rDist = rHist;
  ledger.stats.maxR = Rs.length ? round(Math.max(...Rs), 2) : null;
  ledger.stats.minR = Rs.length ? round(Math.min(...Rs), 2) : null;
  // capture efficiency: how much of each trade's favorable excursion was
  // actually banked — the forensic leak metric (was 16%)
  const cap = closed.filter((e) => e.peakPnl != null && e.peakPnl > 0);
  ledger.stats.capturePct = cap.length
    ? pct((closed.reduce((a, e) => a + (e.pnlPct ?? 0), 0) / closed.length) /
        (cap.reduce((a, e) => a + e.peakPnl, 0) / cap.length) * 100)
    : null;
  // Tharp's first rule: objectives come BEFORE the system. Stated openly,
  // measured every build — the dashboard grades us against them.
  ledger.stats.objectives = {
    sqn: { target: 'SQN ≥ 2.5 at n≥100', cur: ledger.stats.sqn, n: closed.length, ok: (sqn ?? 0) >= 2.5 && closed.length >= 100 },
    capture: { target: 'capture ≥ 40% of excursion', cur: ledger.stats.capturePct, ok: (ledger.stats.capturePct ?? 0) >= 40 },
    expectancy: { target: 'expectancy ≥ +0.25R', cur: ledger.stats.avgR, ok: (avgR ?? 0) >= 0.25 },
    maxdd: { target: 'max drawdown < 5%', cur: ledger.stats.maxDrawdownPct, ok: (ledger.stats.maxDrawdownPct ?? 0) < 5 },
    sample: { target: '≥100 closed for a real verdict', cur: closed.length, ok: closed.length >= 100 },
  };
  // self-improving: doctrine weights learned from realized performance —
  // DORMANT until the sample is large enough to distinguish edge from luck
  ledger.model = {
    stratAdj,
    learning: {
      active: learnActive,
      closedN: closedTotal,
      gate: { total: LEARN_MIN_TOTAL, perStrategy: LEARN_MIN_STRAT },
    },
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

  // ---- append-only prospective record: the full emitted board every run,
  // including signals that never became positions. Nothing is rewritten or
  // deleted except trimming whole oldest runs at the cap — this is the
  // unaltered out-of-sample dataset the audit called for.
  let archive = { runs: [] };
  try {
    archive = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  } catch {}
  archive.runs ??= [];
  archive.runs.push({
    ts: now,
    ver: ENGINE_VERSION,
    universeSize: rows.length,
    poolN: candidates.length,
    medianChangePct,
    breadth: breadthPct,
    regime,
    mktType,
    marketSQN,
    signals: signals.map((s) => ({
      asset: s.asset,
      cls: s.cls,
      direction: s.direction,
      score: s.score,
      grade: s.grade,
      strategy: s.strategy,
      entry: s.entryPrice,
      targetPct: s.targetPct,
      stopPct: s.stopPct,
      spreadPct: s.spreadPct,
      boardRank: s.boardRank,
      // raw feature values — the evaluator correlates each against forward
      // returns to measure WHICH component carries predictive power
      rsi: s.rsi ?? null,
      volRatio: s.volRatio ?? null,
      momScore: s.momScore ?? null,
      changePct: s.changePct ?? null,
    })),
  });
  // permanent record: every run also lands in its monthly history file
  // (api/history/archive-YYYY-MM.json) — trimming the hot window below can
  // never lose a signal. Dedup by timestamp keeps re-runs idempotent.
  const histDir = path.join(API, 'history');
  fs.mkdirSync(histDir, { recursive: true });
  const byMonth = new Map();
  for (const r of archive.runs) {
    const m = new Date(r.ts).toISOString().slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  let histRuns = 0;
  let histSignals = 0;
  for (const [m, rs] of byMonth) {
    const hf = path.join(histDir, `archive-${m}.json`);
    let h = { runs: [] };
    try {
      h = JSON.parse(fs.readFileSync(hf, 'utf8'));
    } catch {}
    h.runs ??= [];
    const seen = new Set(h.runs.map((x) => x.ts));
    for (const r of rs) if (!seen.has(r.ts)) h.runs.push(r);
    h.runs.sort((a, b) => a.ts - b.ts);
    fs.writeFileSync(hf, JSON.stringify(h));
  }
  for (const f of fs.readdirSync(histDir)) {
    if (!/^archive-\d{4}-\d{2}\.json$/.test(f)) continue;
    try {
      const h = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
      for (const r of h.runs || []) {
        histRuns++;
        histSignals += (r.signals || []).length;
      }
    } catch {}
  }
  archive.runs = archive.runs.slice(-ARCHIVE_MAX_RUNS);
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive));
  // surface the permanent record's depth on the ledger itself
  ledger.stats.archiveRuns = histRuns;
  ledger.stats.signalsArchived = histSignals;

  // ---- forward-outcome evaluation: EVERY emitted signal gets measured ----
  // The position ledger only ever samples the ~1-2 signals that became
  // trades. This evaluator scores the whole board: for each archived
  // signal, the 5m tape after emission determines forward returns at
  // +1h/+4h/+24h, whether TP touched before SL inside 24h (adverse-first,
  // same pessimism as settlement), and alpha vs a BTC/ETH/SOL median
  // benchmark over the identical window. Complete records are sealed into
  // monthly eval files (api/eval-YYYY-MM.json) — the predictive-power
  // dataset accumulates ~10x faster than the traded ledger can.
  const EVAL_FILE = path.join(API, 'signal-eval.json');
  let evalBook = { records: [] };
  try {
    evalBook = JSON.parse(fs.readFileSync(EVAL_FILE, 'utf8'));
  } catch {}
  evalBook.records ??= [];
  const evalMap = new Map(evalBook.records.map((r) => [r.key, r]));
  const HORIZONS = [3600e3, 4 * 3600e3, 24 * 3600e3];
  // keys already sealed into monthly eval files — never re-evaluate
  const sealedKeys = new Set();
  for (const f of fs.readdirSync(histDir)) {
    if (!/^eval-\d{4}-\d{2}\.json$/.test(f)) continue;
    try {
      const eh = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
      for (const r of eh.records || []) sealedKeys.add(r.key);
    } catch {}
  }
  const pending = [];
  for (const f of fs.readdirSync(histDir)) {
    if (!/^archive-\d{4}-\d{2}\.json$/.test(f)) continue;
    try {
      const h = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
      for (const run of h.runs || [])
        for (const s of run.signals || []) {
          const key = `${run.ts}|${s.asset}|${s.direction}`;
          if (sealedKeys.has(key)) continue;
          const rec = evalMap.get(key);
          if (rec && rec.complete) continue;
          pending.push({ key, run, s, rec });
        }
    } catch {}
  }
  // bound API spend: evaluate at most 24 signals per build; backlog clears
  // within a few builds and steady-state is ~12 new signals per run anyway
  const toEval = pending
    .filter((p) => now - p.run.ts >= HORIZONS[0])
    .slice(0, 24);
  if (toEval.length) {
    const minTs = Math.min(...toEval.map((p) => p.run.ts));
    // shared market benchmark tape — BTC/ETH/SOL median same-window return
    const mktSeries = {};
    await Promise.all(
      ['BTC', 'ETH', 'SOL'].map(async (a) => {
        mktSeries[a] = await fetch5mRange(a, minTs, now).catch(() => null);
      })
    );
    const mktAt = (t0, t1) => {
      const rets = [];
      for (const a of ['BTC', 'ETH', 'SOL']) {
        const cs = mktSeries[a];
        if (!cs || !cs.length) continue;
        const c0 = cs.find((c) => c.t >= t0);
        let c1 = null;
        for (const c of cs) if (c.t <= t1) c1 = c;
        if (c0 && c1 && c1.t > c0.t) rets.push((c1.c - c0.c) / c0.c);
      }
      if (!rets.length) return null;
      rets.sort((a, b) => a - b);
      return rets[Math.floor(rets.length / 2)] * 100;
    };
    // parallel prefetch: one fetch per ASSET over the union of its pending
    // windows (was one serial fetch per record — same tape refetched 24×)
    const byAsset = new Map();
    for (const p of toEval) {
      const w = byAsset.get(p.s.asset) ?? { min: p.run.ts, end: 0 };
      w.min = Math.min(w.min, p.run.ts);
      w.end = Math.max(w.end, Math.min(p.run.ts + HORIZONS[2], now));
      byAsset.set(p.s.asset, w);
    }
    const assetCandles = new Map();
    {
      const assets = [...byAsset.keys()];
      for (let i = 0; i < assets.length; i += 6) {
        await Promise.all(
          assets.slice(i, i + 6).map(async (a) => {
            const w = byAsset.get(a);
            assetCandles.set(a, await fetch5mRange(a, w.min, w.end).catch(() => null));
          })
        );
      }
    }
    for (const p of toEval) {
      const { key, run, s } = p;
      const sgn = s.direction === 'LONG' ? 1 : -1;
      const end = Math.min(run.ts + HORIZONS[2], now);
      const all = assetCandles.get(s.asset);
      const cs = all && all.filter((c) => c.t >= run.ts - 300e3 && c.t <= end + 300e3);
      if (!cs || !cs.length) continue;
      // entry fill: emission mark plus adverse half-spread (worst case)
      const half = (s.spreadPct ?? 0) / 200;
      const entry = s.entry * (1 + sgn * half);
      const r = p.rec ?? {
        key,
        runTs: run.ts,
        asset: s.asset,
        cls: s.cls,
        direction: s.direction,
        score: s.score,
        grade: s.grade,
        strategy: s.strategy,
        ver: s.ver ?? run.ver ?? ENGINE_VERSION,
        regime: run.regime ?? null,
        mktType: run.mktType ?? null,
        rsi: s.rsi ?? null,
        volRatio: s.volRatio ?? null,
        momScore: s.momScore ?? null,
        boardRank: s.boardRank ?? null,
        entry,
      };
      const closeAt = (T) => {
        let c1 = null;
        for (const c of cs) if (c.t <= T) c1 = c;
        return c1 && c1.t >= run.ts ? c1.c : null;
      };
      for (let i = 0; i < 3; i++) {
        const H = HORIZONS[i];
        if (end < run.ts + H) continue;
        const c = closeAt(run.ts + H);
        if (c == null) continue;
        const fwd = sgn * ((c - entry) / entry) * 100;
        const mkt = mktAt(run.ts, run.ts + H);
        r['fwd' + H / 3600e3 + 'h'] = pct(fwd);
        if (mkt != null) r['mkt' + H / 3600e3 + 'h'] = pct(mkt);
        if (mkt != null) r['alpha' + H / 3600e3 + 'h'] = pct(fwd - mkt);
      }
      // tp-before-sl inside the 24h window — adverse-first within a bar,
      // identical pessimism to position settlement
      if (!r.outcome) {
        const tgt = s.targetPct ?? 8;
        const stp = s.stopPct ?? Math.max(4, tgt);
        const tPx = entry * (1 + (sgn * tgt) / 100);
        const sPx = entry * (1 - (sgn * stp) / 100);
        for (const c of cs) {
          const advPx = sgn > 0 ? c.l : c.h;
          if (sgn > 0 ? advPx <= sPx : advPx >= sPx) {
            r.outcome = 'sl';
            r.outcomePct = pct(-stp);
            break;
          }
          const favPx = sgn > 0 ? c.h : c.l;
          if (sgn > 0 ? favPx >= tPx : favPx <= tPx) {
            r.outcome = 'tp';
            r.outcomePct = pct(tgt);
            break;
          }
        }
        if (!r.outcome && end >= run.ts + HORIZONS[2] - 300e3) {
          r.outcome = 'timeout';
          const lastC = cs[cs.length - 1].c;
          r.outcomePct = pct(sgn * ((lastC - entry) / entry) * 100);
        }
      }
      r.complete = end >= run.ts + HORIZONS[2] - 300e3;
      r.evaluatedAt = now;
      evalMap.set(key, r);
    }
  }
  // seal complete records into monthly eval files keyed by signal month
  const evalByMonth = new Map();
  for (const r of evalMap.values()) {
    if (!r.complete) continue;
    const m = new Date(r.runTs).toISOString().slice(0, 7);
    if (!evalByMonth.has(m)) evalByMonth.set(m, []);
    evalByMonth.get(m).push(r);
  }
  const allComplete = [];
  for (const [m, rs] of evalByMonth) {
    const ef = path.join(histDir, `eval-${m}.json`);
    let eh = { records: [] };
    try {
      eh = JSON.parse(fs.readFileSync(ef, 'utf8'));
    } catch {}
    eh.records ??= [];
    const seen = new Set(eh.records.map((x) => x.key));
    for (const r of rs) if (!seen.has(r.key)) eh.records.push(r);
    fs.writeFileSync(ef, JSON.stringify(eh));
  }
  for (const f of fs.readdirSync(histDir)) {
    if (!/^eval-\d{4}-\d{2}\.json$/.test(f)) continue;
    try {
      const eh = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
      for (const r of eh.records || []) allComplete.push(r);
    } catch {}
  }
  // predictive-power stats. Per-horizon metrics (dirAcc, avgFwd, alpha)
  // use every record that has that field — a signal labeled at +1h counts
  // for 1h accuracy immediately instead of waiting 24h. Outcome-dependent
  // stats (hit rate, expectancy, IC) stay on complete records only.
  const labeled = [...allComplete];
  for (const r of evalBook.records) if (r.hit24h == null) labeled.push(r);
  const evStats = { n: allComplete.length, labeled: labeled.length };
  const evAvg = (xs) => (xs.length ? pct(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const fld = (k) => labeled.map((r) => r[k]).filter((v) => v != null);
  evStats.hitRate24h = allComplete.length
    ? pct((allComplete.filter((r) => r.outcome === 'tp').length / allComplete.length) * 100)
    : null;
  evStats.avgFwd1h = evAvg(fld('fwd1h'));
  evStats.avgFwd4h = evAvg(fld('fwd4h'));
  evStats.avgFwd24h = evAvg(fld('fwd24h'));
  evStats.avgAlpha1h = evAvg(fld('alpha1h'));
  evStats.avgAlpha4h = evAvg(fld('alpha4h'));
  evStats.avgAlpha24h = evAvg(fld('alpha24h'));
  evStats.expectancyPct = evAvg(fld('outcomePct'));
  // directional accuracy — % of evaluated signals whose forward return
  // was positive in the traded direction at each horizon
  const dirAcc = (k) => {
    const xs = fld(k);
    return xs.length ? pct((xs.filter((v) => v > 0).length / xs.length) * 100) : null;
  };
  evStats.dirAcc1h = dirAcc('fwd1h');
  evStats.dirAcc4h = dirAcc('fwd4h');
  evStats.dirAcc24h = dirAcc('fwd24h');
  // median alpha — the outlier-robust centre, not just the mean
  const med = (xs) =>
    xs.length
      ? (xs.sort((a, b) => a - b), xs.length % 2
          ? xs[(xs.length - 1) / 2]
          : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2)
      : null;
  evStats.medAlpha24h = med(fld('alpha24h').slice());
  evStats.medFwd24h = med(fld('fwd24h').slice());
  // information coefficients: Pearson corr of each feature vs 24h alpha —
  // THE quant answer to "which component actually predicts". Score IC is
  // the headline; feature ICs say where the signal lives.
  const pearson = (pairs) => {
    if (pairs.length < 10) return null;
    const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
    const my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
    let num = 0, dx = 0, dy = 0;
    for (const [x, y] of pairs) {
      num += (x - mx) * (y - my);
      dx += (x - mx) ** 2;
      dy += (y - my) ** 2;
    }
    return dx > 0 && dy > 0 ? round(num / Math.sqrt(dx * dy), 3) : null;
  };
  const pairUp = (k) =>
    allComplete
      .filter((r) => r[k] != null && r.alpha24h != null)
      .map((r) => [r[k], r.alpha24h]);
  evStats.ic24h = pearson(pairUp('score'));
  evStats.icRsi = pearson(pairUp('rsi'));
  evStats.icVol = pearson(pairUp('volRatio'));
  evStats.icMom = pearson(pairUp('momScore'));
  evStats.icRank = pearson(
    allComplete
      .filter((r) => r.boardRank != null && r.alpha24h != null)
      .map((r) => [-r.boardRank, r.alpha24h])
  );
  const group = (kf) => {
    const g = {};
    for (const r of allComplete) {
      const k = kf(r);
      (g[k] ??= { n: 0, tp: 0, alpha: [], fwd: [] }).n++;
      if (r.outcome === 'tp') g[k].tp++;
      if (r.alpha24h != null) g[k].alpha.push(r.alpha24h);
      if (r.fwd24h != null) g[k].fwd.push(r.fwd24h);
    }
    for (const k in g) {
      g[k].hitRate = pct((g[k].tp / g[k].n) * 100);
      g[k].avgAlpha24h = evAvg(g[k].alpha);
      g[k].avgFwd24h = evAvg(g[k].fwd);
      delete g[k].alpha; delete g[k].fwd; delete g[k].tp;
    }
    return g;
  };
  evStats.byGrade = group((r) => r.grade ?? '?');
  evStats.byDirection = group((r) => r.direction ?? '?');
  evStats.byStrategy = group((r) => r.strategy ?? '?');
  evStats.byScoreBand = group((r) =>
    r.score >= 90 ? '90+' : r.score >= 80 ? '80-89' : '<80'
  );
  evStats.byRegime = group((r) => r.regime ?? 'unknown');
  evStats.byMktType = group((r) => r.mktType ?? 'unknown');
  // hot file: pending (incomplete) + most recent completes for the UI
  const incomplete = [...evalMap.values()].filter((r) => !r.complete);
  const recent = allComplete.sort((a, b) => b.runTs - a.runTs).slice(0, 200);
  fs.writeFileSync(
    EVAL_FILE,
    JSON.stringify({
      refreshedAt: snap.refreshedAt,
      note: 'forward-outcome labels for EVERY emitted signal — monthly eval-YYYY-MM.json files hold the complete permanent set',
      stats: evStats,
      pending: incomplete.length,
      records: [...incomplete, ...recent],
    })
  );

  // ---- hypothesis engine → api/hypotheses.json ----
  // The self-improvement layer, done honestly: registered falsifiable claims
  // scored prospectively from the eval labels + ledger. Status escalates
  // with evidence n — UNTESTED <10, EARLY <30, SUGGESTIVE <100, then
  // SUPPORTED/REFUTED at 100+. The system states what it believes AND how
  // much evidence that belief rests on — no claim outruns its sample.
  try {
    const HYPO_FILE = path.join(API, 'hypotheses.json');
    let hypoBook = { claims: [] };
    try { hypoBook = JSON.parse(fs.readFileSync(HYPO_FILE, 'utf8')); } catch {}
    const prior = new Map((hypoBook.claims || []).map((h) => [h.id, h]));
    const statusFor = (n, pass) =>
      n < 10 ? 'UNTESTED'
        : n < 30 ? 'EARLY SIGNAL'
        : n < 100 ? (pass == null ? 'MIXED' : pass ? 'SUGGESTIVE' : 'WEAKENING')
        : pass == null ? 'MIXED' : pass ? 'SUPPORTED' : 'REFUTED';
    const bg = evStats.byGrade || {}, bd = evStats.byDirection || {}, bb = evStats.byScoreBand || {};
    // regime alignment needs direction×regime — compute from labeled records
    const al = labeled.filter((r) => r.alpha24h != null &&
      ((r.direction === 'LONG' && r.regime === 'risk-on') || (r.direction === 'SHORT' && r.regime === 'risk-off')));
    const ct = labeled.filter((r) => r.alpha24h != null &&
      ((r.direction === 'LONG' && r.regime === 'risk-off') || (r.direction === 'SHORT' && r.regime === 'risk-on')));
    const meanOf = (xs) => xs.length ? xs.reduce((a, r) => a + r.alpha24h, 0) / xs.length : null;
    const tests = [
      {
        id: 'score-ranks-alpha',
        claim: 'Higher scores predict higher 24h alpha',
        metric: `score→alpha IC = ${evStats.ic24h ?? '—'}`,
        value: evStats.ic24h, n: evStats.n,
        pass: evStats.ic24h == null ? null : evStats.ic24h > 0.05 ? true : evStats.ic24h <= 0 ? false : null,
      },
      {
        id: 'grade-orders',
        claim: 'Grade A signals beat lower grades',
        metric: `A hitRate ${bg.A?.hitRate ?? '—'}% vs B ${bg.B?.hitRate ?? '—'}%`,
        value: bg.A?.hitRate != null && bg.B?.hitRate != null ? pct(bg.A.hitRate - bg.B.hitRate) : null,
        n: Math.min(bg.A?.n ?? 0, bg.B?.n ?? 0),
        pass: bg.A?.hitRate != null && bg.B?.hitRate != null ? bg.A.hitRate >= bg.B.hitRate : null,
      },
      {
        id: 'short-edge',
        claim: 'SHORT signals carry more edge than LONGs',
        metric: `SHORT α ${bd.SHORT?.avgAlpha24h ?? '—'}% vs LONG α ${bd.LONG?.avgAlpha24h ?? '—'}%`,
        value: bd.SHORT?.avgAlpha24h != null && bd.LONG?.avgAlpha24h != null ? pct(bd.SHORT.avgAlpha24h - bd.LONG.avgAlpha24h) : null,
        n: Math.min(bd.SHORT?.n ?? 0, bd.LONG?.n ?? 0),
        pass: bd.SHORT?.avgAlpha24h != null && bd.LONG?.avgAlpha24h != null ? bd.SHORT.avgAlpha24h > bd.LONG.avgAlpha24h : null,
      },
      {
        id: 'regime-align',
        claim: 'Regime-aligned signals beat counter-trend ones',
        metric: `aligned α ${al.length ? pct(meanOf(al)) : '—'}% vs counter α ${ct.length ? pct(meanOf(ct)) : '—'}%`,
        value: al.length && ct.length ? pct(meanOf(al) - meanOf(ct)) : null,
        n: Math.min(al.length, ct.length),
        pass: al.length && ct.length ? meanOf(al) > meanOf(ct) : null,
      },
      {
        id: 'vol-edge',
        claim: 'Volume ratio predicts forward alpha',
        metric: `volRatio IC = ${evStats.icVol ?? '—'}`,
        value: evStats.icVol, n: evStats.n,
        pass: evStats.icVol == null ? null : evStats.icVol > 0.05,
      },
      {
        id: 'rsi-edge',
        claim: 'RSI(1h) carries predictive information',
        metric: `rsi IC = ${evStats.icRsi ?? '—'}`,
        value: evStats.icRsi, n: evStats.n,
        pass: evStats.icRsi == null ? null : Math.abs(evStats.icRsi) > 0.05,
      },
      {
        id: 'entry-floor-valid',
        claim: 'Signals ≥80 score outperform <80 (entry floor is real)',
        metric: `80+ hitRate ${bb['80-89']?.hitRate ?? bb['90+']?.hitRate ?? '—'}% vs <80 ${bb['<80']?.hitRate ?? '—'}%`,
        value: (bb['80-89']?.hitRate ?? bb['90+']?.hitRate) != null && bb['<80']?.hitRate != null
          ? pct((bb['80-89']?.hitRate ?? bb['90+']?.hitRate) - bb['<80'].hitRate) : null,
        n: Math.min((bb['80-89']?.n ?? 0) + (bb['90+']?.n ?? 0), bb['<80']?.n ?? 0),
        pass: (bb['80-89']?.hitRate ?? bb['90+']?.hitRate) != null && bb['<80']?.hitRate != null
          ? (bb['80-89']?.hitRate ?? bb['90+']?.hitRate) > bb['<80'].hitRate : null,
      },
    ];
    const claims = tests.map((t) => {
      const p = prior.get(t.id);
      const hist = [...(p?.history || []), { ts: now, value: t.value, n: t.n }].slice(-300);
      return {
        id: t.id, claim: t.claim, metric: t.metric, value: t.value, n: t.n,
        status: statusFor(t.n, t.pass),
        prev: p ? { value: p.value, n: p.n } : null,
        history: hist,
      };
    });
    fs.writeFileSync(
      HYPO_FILE,
      JSON.stringify({
        refreshedAt: snap.refreshedAt,
        note: 'registered falsifiable claims scored prospectively from eval labels + ledger. Status: UNTESTED<10, EARLY<30, SUGGESTIVE<100, then SUPPORTED/REFUTED. The engine only gets to believe what the sample has earned.',
        claims,
      })
    );
  } catch {}


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

  // final unconditional ledger write — archive-depth stats and vault
  // `vaulted` flags set after the first write must still persist
  if (!ledgerCorrupt) fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger));

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
