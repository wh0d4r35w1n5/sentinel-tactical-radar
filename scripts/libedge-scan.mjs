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
const PER_SYMBOL = 50; // API caps limit at 50 — top-N by sharpe + top-N by profit

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
  : /fade|vwap|effort|revert|mean|eq.?edge|quartile|\bsfp\b|rejection/i.test(strategy) ? 'meanrev'
  : /momentum|tsmom|trend|major|runner|ignition/i.test(strategy) ? 'trend'
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

const med = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

const summarize = (symbol, results) => {
  // dedupe by id — the sharpe+profit pulls overlap heavily
  const seen = new Set();
  const uniq = (results || []).filter((s) => s?.result && !seen.has(s.id) && seen.add(s.id));
  const rows = uniq.map((x) => x.result).filter(Boolean);
  const q = uniq.filter((s) => QUALITY(s.result));
  const archW = {}, archRows = {};
  const tfW = {};
  for (const s of q) {
    const sharpe = s.result.sharpeRatio || 0;
    const tf = String(s.timeframe || '?');
    tfW[tf] = (tfW[tf] || 0) + 1;
    for (const [a, re] of ARCH) if (re.test(s.name || '')) {
      archW[a] = (archW[a] || 0) + sharpe;
      (archRows[a] ||= []).push(s.result);
    }
  }
  // per-archetype evidence matrix — the full-advantage read: not just "does
  // this pair have profitable strats" but WHICH logic families the crowd
  // proved out here and how strongly
  const archEdge = {};
  for (const [a, rs] of Object.entries(archRows)) {
    archEdge[a] = {
      n: rs.length,
      medSharpe: +med(rs.map((r) => r.sharpeRatio)).toFixed(2),
      medPf: +med(rs.map((r) => r.profitFactor)).toFixed(2),
      medWr: +med(rs.map((r) => r.winRatePct)).toFixed(1),
      medDd: +med(rs.map((r) => r.maxDrawdownPct)).toFixed(1),
    };
  }
  // timeframe prior — which horizon the library's winners cluster on
  const tfEdge = Object.fromEntries(Object.entries(tfW).sort((a, b) => b[1] - a[1]));
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
    topPf: +topPf.toFixed(2), domArch, domTf: Object.keys(tfEdge)[0] || null,
    archEdge, tfEdge,
    edge: +edge.toFixed(3),
  };
};

// family-conditional tilt — what the library says about OUR strategy family
// on THIS symbol. medSharpe>=1 with >=3 quality witnesses = proven family;
// exists-but-mediocre (medPf<1.2) = the crowd tried our style and it didn't
// pay. Null when the library has no opinion (absence is never evidence).
export const familyTilt = (le, strategy) => {
  const fam = OUR_FAMILY(strategy);
  if (!fam || !le?.archEdge?.[fam]) return 0;
  const a = le.archEdge[fam];
  if (a.n >= 3 && a.medSharpe >= 1) return +0.8;
  if (a.n >= 3 && a.medPf < 1.2) return -0.5;
  return 0;
};

export async function getLibEdge(symbols, { maxAgeMs = MAX_AGE_MS, log = () => {} } = {}) {
  let cache = { at: 0, map: {} };
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch {}
  cache.map ||= {};
  const fresh = Date.now() - (cache.at || 0) < maxAgeMs;
  // rows lacking archEdge are pre-matrix format — refetch regardless of age
  const missing = symbols.filter((s) => !fresh || !(s in cache.map) || (cache.map[s]?.n > 0 && !cache.map[s]?.archEdge));
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
        let j = null, lastErr = null;
        for (const q of cands) {
          try {
            // two sorts — sharpe finds risk-adjusted winners, profit surfaces
            // different (often longer-horizon) archetypes. Deduped by id.
            const [a, b] = await Promise.all([
              fetchJson(`${BASE}/strategies/search?symbol=${encodeURIComponent(q)}&sort=sharpe&limit=${PER_SYMBOL}&minTrades=30`),
              fetchJson(`${BASE}/strategies/search?symbol=${encodeURIComponent(q)}&sort=profit&limit=${PER_SYMBOL}&minTrades=30`),
            ]);
            j = { results: [...(a.results || []), ...(b.results || [])] };
            if (j.results.length) break;
          } catch (e) { lastErr = e; }
        }
        if (!j) throw lastErr || new Error('fetch failed');
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
      note: 'edge density = count of top-60 sharpe+profit strategies passing PF>=1.5, trades>=30, DD<=20%, WR>=45%, bars>=300; archEdge = per-family median KPIs',
      symbols: Object.fromEntries(symbols.filter((s) => cache.map[s]).map((s) => [s, cache.map[s]])),
    }));
    fs.renameSync(API_PATH + '.tmp', API_PATH);
  } catch {}
  log(`libedge: refreshed ${done} symbols (${Object.keys(cache.map).length} cached)`);
  return { map: cache.map, fresh: false };
}
