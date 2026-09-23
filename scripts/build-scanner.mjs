// Builds api/market-scanner.json directly from Bitget public spot data.
// Replaces the upstream scanner feed so the board is always fresh and
// limited to coins actually listed on Bitget (no onchain/DEX-only tokens).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const SYMBOLS_URL = 'https://api.bitget.com/api/v2/spot/public/symbols';
const TICKERS_URL = 'https://api.bitget.com/api/v2/spot/market/tickers';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const MIN_QUOTE_VOLUME = 250_000; // USDT notional — liquid listings only
const MAX_SIGNALS = 12;
const PULSE_FILE = path.join(API, 'pulse-history.json');
const PULSE_MAX_POINTS = 96; // ~24h at a 15min cadence

const pct = (x) => Math.round(x * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const [symbolsRes, tickersRes] = await Promise.all([
  fetch(SYMBOLS_URL),
  fetch(TICKERS_URL),
]);
if (!symbolsRes.ok) throw new Error(`bitget symbols http ${symbolsRes.status}`);
if (!tickersRes.ok) throw new Error(`bitget tickers http ${tickersRes.status}`);
const { data: symbols } = await symbolsRes.json();
const { data: tickers } = await tickersRes.json();

// areaSymbol === 'yes' marks Bitget's RWA zone (tokenized stocks/ETFs like
// rQQQ, rAAPL) — not crypto. Stable/fiat bases are excluded as radar noise.
const STABLE_FIAT = new Set([
  'USDC', 'USDT', 'USD1', 'USDE', 'USDD', 'DAI', 'FDUSD', 'TUSD', 'PYUSD',
  'RLUSD', 'USDP', 'GUSD', 'USDY', 'USTB', 'BFUSD', 'AUSD', 'EUR', 'EURC',
  'GBP', 'BRL', 'TRY', 'AUD', 'USDG', 'CUSD', 'XUSD', 'USDS', 'SUSDE',
]);
const online = symbols.filter(
  (s) => s.status === 'online' && s.areaSymbol !== 'yes'
);
const listed = new Set(online.map((s) => (s.baseCoin ?? '').toUpperCase()));
fs.writeFileSync(
  path.join(API, 'bitget-symbols.json'),
  JSON.stringify([...listed].sort())
);
const usdtPairs = new Set(
  online
    .filter(
      (s) =>
        s.quoteCoin === 'USDT' && !STABLE_FIAT.has((s.baseCoin ?? '').toUpperCase())
    )
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
    return {
      asset: t.symbol.replace(/USDT$/i, ''),
      symbol: `${t.symbol.replace(/USDT$/i, '')}USD`,
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
  .filter((r) => Number.isFinite(r.lastPrice) && r.lastPrice > 0 && r.quoteVolume >= MIN_QUOTE_VOLUME)
  .sort((a, b) => b.quoteVolume - a.quoteVolume);

// percentile helpers over the universe
const rank = (arr, v) => arr.filter((x) => x <= v).length / arr.length;
const chgs = rows.map((r) => r.changePct).sort((a, b) => a - b);
const vols = rows.map((r) => r.quoteVolume).sort((a, b) => a - b);
const spreads = rows.map((r) => r.spreadPct).sort((a, b) => a - b);

const strategyFor = (r) => {
  if (r.changePct > 3 && r.rangePosition > 0.75) return 'Breakout Continuation';
  if (r.changePct < -3) return 'Momentum Breakdown';
  return 'Momentum Confluence';
};

const signals = rows
  .map((r) => {
    const momentumScore = Math.round(rank(chgs, r.changePct) * 100);
    const volumeScore = Math.round(rank(vols, r.quoteVolume) * 100);
    const liquidityScore = Math.round((1 - rank(spreads, r.spreadPct)) * 100);
    const score = Math.round(momentumScore * 0.5 + volumeScore * 0.3 + liquidityScore * 0.2);
    return { ...r, momentumScore, volumeScore, liquidityScore, score };
  })
  .sort((a, b) => b.score - a.score)
  .slice(0, MAX_SIGNALS)
  .map((r) => {
    const direction = r.changePct >= 0 ? 'LONG' : 'SHORT';
    const strategy = strategyFor(r);
    const targetPct = pct(clamp(r.rangePct * 0.35, 3, 15));
    const drivers = [
      `24h momentum ${r.changePct >= 0 ? '+' : ''}${pct(r.changePct)}%`,
      `Quote volume $${(r.quoteVolume / 1e6).toFixed(1)}M`,
      `24h range position ${Math.round(r.rangePosition * 100)}%`,
    ];
    return {
      asset: r.asset,
      grade: r.score >= 90 ? 'A' : r.score >= 80 ? 'BBB' : r.score >= 70 ? 'BB' : 'B',
      score: r.score,
      social: null,
      symbol: r.symbol,
      thesis: `${strategy} on ${r.asset} | Confluence ${r.score}/100 | ${drivers[0]} | ${drivers[1]}`,
      assetId: r.asset.toLowerCase(),
      drivers,
      riskPct: pct(clamp(r.spreadPct * 2 + Math.abs(r.changePct) * 0.08, 0.3, 8)),
      summary: `${strategy}: ${direction === 'LONG' ? 'upside' : 'downside'} momentum with ${direction === 'LONG' ? 'strong' : 'weak'} breadth participation.`,
      harmonic: null,
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
      momentumScore: r.momentumScore,
      rangePosition: pct(r.rangePosition * 100) / 100,
      reversalScore: 0,
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

// pulse = breadth index pinned to a 100 baseline, accumulated across runs
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
  const fxRes = await fetch(FX_URL);
  const fxJson = await fxRes.json();
  const aud = fxJson?.rates?.AUD;
  if (aud) fx = { audPerUsd: aud, usdPerAud: pct(1 / aud * 10000) / 10000 };
} catch {}

const snap = {
  fx,
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
  scanWindowSeconds: 900,
  error: null,
  source: 'bitget-direct',
  universeFilter: 'bitget-spot',
};

fs.writeFileSync(path.join(API, 'market-scanner.json'), JSON.stringify(snap));
console.log(
  `built scanner snapshot: ${signals.length} signals, ${movers.length} movers, ${laggards.length} laggards, ${rows.length} pairs scanned`
);
