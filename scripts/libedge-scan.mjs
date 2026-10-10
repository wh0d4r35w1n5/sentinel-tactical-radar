// trader.dev public leaderboard — symbol-level edge density evidence.
// The site indexes ~390k AI-built Pine strategies with public KPIs
// (profit factor, sharpe, max DD, win rate, trade count). The CODE is
// auth-gated; the metrics are not. What we harvest is the distribution:
// a pair where dozens of independent strategy variants backtest green is
// empirically easier tape than one where the whole library bleeds.
// Selection-bias note: these are auto-generated strats — we count DENSITY
// of quality, never trust the maxima, and the fusion layer gets the final
// say on how much this channel is worth.
// Usage: import { getLibEdge } — returns {asset: {density, topSharpe, topPf,
// domArch, domTf, n, edge}}; refreshes state cache when > MAX_AGE old.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(DIR, '..', 'state', 'libedge.json');
const API_PATH = path.join(DIR, '..', 'api', 'libedge.json');
const BASE = 'https://mcp-api.trader.dev';
const MAX_AGE_MS = +(process.env.LIBEDGE_MAX_AGE_H || 12) * 3600e3;
const PER_SYMBOL = 30; // top-N by sharpe per symbol — enough for a density read

// archetype histogram keys — names carry the strategy's logic
// ("SOL Donchian wider ATR trail", "EMA9VWAP ATR", "RSI Reversal + EMA Pullback")
const ARCH = [
  ['breakout', /donchian|channel|breakout|range break|orb\b|opening range/i],
  ['trend', /\bema|\bsma|ma[- ]?cross|golden cross|death cross|supertrend|trend/i],
  ['meanrev', /rsi|stoch|bollinger|\bbb\b|z.?score|revert|reversal|pullback|fade|oversold|overbought/i],
  ['vwap', /vwap|\bobv\b|volume prof/i],
  ['atr-trail', /atr|chandelier|trail|parabolic|\bsar\b/i],
  ['macd', /macd|adx|dmi|aroon/i],
  ['carry', /carry|funding|basis/i],
  ['momentum', /momentum|\broc\b|tsmom|impulse/i],
];
// our strategy names -> library archetype (agreement bonus only — a miss
// is 0, not a penalty: the library's absence isn't evidence against)
export const OUR_FAMILY = (strategy) =>
  /carry|funding/i.test(strategy) ? 'carry'
  : /breakout|continuation|sweep|liq/i.test(strategy) ? 'breakout'
  : /fade|vwap|effort|revert|mean|eq.?edge/i.test(strategy) ? 'meanrev'
  : /momentum|tsmom|trend|major|runner/i.test(strategy) ? 'trend'
  : null;

// quality bar for the density count — one-bar wonders and scalped dust
// don't count; we want strategies that survived enough trades to matter
const QUALITY = (r) =>
  r && (r.totalTrades || 0) >= 30 && (r.profitFactor || 0) >= 1.5 &&
  (r.maxDrawdownPct || 99) <= 20 && (r.winRatePct || 0) >= 45 &&
  (r.barsEvaluated || 0) >= 300;

const fetchJson = async (u) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
};

const summarize = (symbol, results) => {
  const rows = (results || []).map((x) => x.result).filter(Boolean);
  const q = rows.filter(QUALITY);
  const archW = {};
  let top = null;
  for (const s of results || []) {
    if (!s.result || !QUALITY(s.result)) continue;
    for (const [a, re] of ARCH) if (re.test(s.name || '')) archW[a] = (archW[a] || 0) + s.result.sharpeRatio;
  }
  if (!top && results?.length) top = results[0];
  else if (results?.length) top = results.find((s) => QUALITY(s.result)) || results[0];
  const domArch = Object.entries(archW).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const topSharpe = rows.length ? Math.max(...rows.map((r) => r.sharpeRatio || 0)) : 0;
  const topPf = rows.length ? Math.max(...rows.map((r) => r.profitFactor || 0)) : 0;
  // edge density → bounded prior: saturates ~10 quality strats, the
  // library-exists-but-all-junk case (n>0, density 0) is mildly negative
  // evidence — the crowd tried this tape and it didn't pay.
  const edge = q.length === 0 && rows.length > 0 ? -1
    : Math.min(3, Math.log1p(q.length) * 1.25 + (topSharpe > 3 ? 0.5 : 0));
  return {
    n: rows.length, density: q.length, topSharpe: +topSharpe.toFixed(2),
    topPf: +topPf.toFixed(2), domArch, domTf: top?.timeframe || null,
    edge: +edge.toFixed(3),
  };
};

export async function getLibEdge(symbols, { maxAgeMs = MAX_AGE_MS, log = () => {} } = {}) {
  let cache = { at: 0, map: {} };
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch {}
  cache.map ||= {};
  const fresh = Date.now() - (cache.at || 0) < maxAgeMs;
  const missing = symbols.filter((s) => !fresh || !(s in cache.map));
  if (!missing.length) return { map: cache.map, fresh: true };
  // polite concurrency — the API is open, don't hammer it
  const todo = missing.slice(0, 400);
  let done = 0;
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async (sym) => {
      try {
        // library symbols are full pairs (BTCUSDT, XAUUSD) — our scan
        // universe is base assets, so quote-join unless already paired.
        // USD-quoted perps (BTCUSD) fall back to the USDT tape — same
        // underlying tape, different margin currency.
        const cands = /USDT$/i.test(sym) ? [sym]
          : /USD$/i.test(sym) ? [sym, sym + 'T']
          : [sym + 'USDT', sym];
        let j = null;
        for (const q of cands) {
          j = await fetchJson(`${BASE}/strategies/search?symbol=${encodeURIComponent(q)}&sort=sharpe&limit=${PER_SYMBOL}&minTrades=30`);
          if ((j.results || []).length) break;
        }
        cache.map[sym] = summarize(sym, j.results);
      } catch (e) { cache.map[sym] = { n: 0, density: 0, edge: 0, err: String(e.message || e).slice(0, 60) }; }
      done++;
    }));
  }
  cache.at = Date.now();
  try { fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(cache)); fs.renameSync(STATE_PATH + '.tmp', STATE_PATH); } catch {}
  try {
    fs.writeFileSync(API_PATH + '.tmp', JSON.stringify({
      refreshedAt: new Date(cache.at).toISOString(), source: 'trader.dev public leaderboard',
      note: 'edge density = count of top-30 sharpe strategies passing PF>=1.5, trades>=30, DD<=20%, WR>=45%, bars>=300',
      symbols: Object.fromEntries(symbols.filter((s) => cache.map[s]).map((s) => [s, cache.map[s]])),
    }));
    fs.renameSync(API_PATH + '.tmp', API_PATH);
  } catch {}
  log(`libedge: refreshed ${done} symbols (${Object.keys(cache.map).length} cached)`);
  return { map: cache.map, fresh: false };
}
