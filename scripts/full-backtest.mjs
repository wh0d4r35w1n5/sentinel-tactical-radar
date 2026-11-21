// full-backtest.mjs — REAL historical backtest of every named strategy.
// Full-history (90d 1H) per liquid symbol, every bar scored by the same
// TAEngine the live scanner runs, every emitted strategy simulated with
// the live exit stack (1% stop, crackwhore TP ladder, 0.17% fee model).
// Output: api/full-backtest.json — per-strategy n/WR/net/SQN/maxDD/avgR
// with the assumptions journaled. No forward-episode anecdotes — this is
// the full-sample evidence.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = path.join(ROOT, 'api');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

await import(path.join(ROOT, 'ta-engine.js'));
const TA = globalThis.TAEngine;

const SYMS_N = +(process.env.BT_SYMS || 25);
const BARS = +(process.env.BT_BARS || 2160); // 90d of 1H
const WIN = 140;          // TA context window per bar
const HORIZON = 96;       // max bars in trade
const FEE = 0.17;         // % per round trip — same model as attribution
const STOP = 1.0;         // % stop, rr-config
const RUNGS = (readJ(path.join(ROOT, 'state', 'rr-config.json'), null)?.absPct) || [0.3, 0.55, 0.9, 1.4, 2.2];
const ALLOC = (readJ(path.join(ROOT, 'state', 'rr-config.json'), null)?.alloc) || [0.2, 0.2, 0.18, 0.15, 0.12];
const TRAIL_K = +(process.env.BT_TRAIL_K || 0);      // >0 = ATR-trail exits (K×ATR14) replace the TP ladder
// per-strategy exit assignment: cells listed in BT_TRAIL_STRATS ride the
// ATR trail, everyone else keeps ladder/structural — the R-max synthesis.
const TRAIL_SET = new Set((process.env.BT_TRAIL_STRATS || '').split(',').map((s) => s.trim()).filter(Boolean));
const RETEST = process.env.BT_SHORT_RETEST === '1';  // exhaustion shorts wait for the FAILED B-wave retest
const RETEST_FIB = +(process.env.BT_RETEST_FIB || 0.4);   // bounce retrace of the climax->rollLow drop
const RETEST_BARS = +(process.env.BT_RETEST_BARS || 8);   // bars the retest has to print inside
const STRUCT = process.env.BT_STRUCT !== '0';        // honor detector-carried invalidation stops where emitted
const TAG = process.env.BT_TAG || 'run';                 // per-sweep label for episode/output artifacts
const EP_F = path.join(API, `mega-episodes-${TAG}.jsonl`);
fs.writeFileSync(EP_F, '');
const epStream = fs.createWriteStream(EP_F, { flags: 'a' });

const NAME = (reasons0) => ({
  'liq-sweep': 'Liquidity Sweep', 'sfp': 'Key Level SFP', 'elliott-w5': 'Elliott W5',
  'smc-choch': 'SMC CHoCH', 'smc-bos': 'SMC BOS', 'ignition': 'Momentum Ignition',
  'tsmom': 'TS Momentum', 'vwap-reversion': 'VWAP Reversion',
  'elliott-w5-proj': 'Elliott W5 Proj', 'effort-result': 'Effort Result',
  'eq-edge': 'PA Quartile', 'capitulation': 'Capitulation Reclaim',
  'breakout-cont': 'Breakout Continuation', 'exhaust-short': 'Exhaustion Short',
}[reasons0] || (reasons0?.startsWith?.('wyckoff-') ? 'Wyckoff' : null));

async function fetchKlines(sym, bars) {
  const out = [];
  let end = Date.now();
  while (out.length < bars) {
    const u = `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${sym}USDT&productType=USDT-FUTURES&granularity=1H&endTime=${end}&limit=200`;
    const j = await fetch(u).then((r) => r.json());
    const rows = (j.data || []).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], qv: +r[6] })).sort((a, b) => a.t - b.t);
    if (!rows.length) break;
    const older = rows.filter((r) => !out.length || r.t < out[0].t);
    out.unshift(...older);
    const minT = out[0].t;
    if (older.length < 50 || rows[0].t >= end) break;
    end = minT - 1;
    await new Promise((r) => setTimeout(r, 120)); // rate-limit kindness
  }
  return out.slice(-bars);
}

function simTrade(rows, i, dir, structStopPx, opts) {
  opts = opts || {};
  const L = dir === 'LONG';
  let entry = rows[i + 1].o, startBar = i + 1;
  // failed-retest entry (BT_SHORT_RETEST=1): the first roll-over print gets
  // B-waved — the squeeze back toward the climax hunts every resting stop.
  // The real short opens when that bounce FAILS: bounce = bar high retraces
  // >=40% of (climaxHi -> rolloverLow); failure = next bar closes under the
  // bounce bar's low. Entry at that close, stop above the bounce high.
  // No print inside 8 bars = no trade (skipped honestly, n drops).
  if (opts.retest && !L) {
    const climaxHi = opts.retest.climaxHi, rollLow = rows[i].l;
    const drop = climaxHi - rollLow;
    let bj = -1;
    for (let j = i + 1; j < Math.min(rows.length, i + 1 + RETEST_BARS); j++) {
      if (rows[j].h >= rollLow + RETEST_FIB * drop) { bj = j; break; }
      if (rows[j].l < rollLow - 0.6 * drop) break; // waterfall — move already gone
    }
    if (bj < 0) return null;
    const nb = rows[bj + 1];
    if (!nb || nb.c >= rows[bj].l) return null;
    entry = nb.c; startBar = bj + 2;
    structStopPx = rows[bj].h * 1.01;
  }
  // structural-stop strategies (exhaust-short @ climax high, capitulation @
  // flush low, wyckoff @ spring/UTAD extreme, w5-proj @ W1 pivot) trade
  // their own risk geometry: stop = the strategy's invalidation, targets =
  // R-multiples of that width (1.5/2/3/4/6R). Flat-grid cells keep the 1%
  // stop + % ladder. A stop emitted on the wrong side of entry is
  // malformed — fall back to the flat grid rather than instant-stop.
  if (structStopPx && (L ? structStopPx >= entry : structStopPx <= entry)) structStopPx = null;
  const stopPctAbs = structStopPx ? Math.abs(entry - structStopPx) / entry * 100 : null;
  const stopPx = structStopPx
    ? structStopPx
    : (L ? entry * (1 - STOP / 100) : entry * (1 + STOP / 100));
  const targets = stopPctAbs
    ? [1.5, 2, 3, 4, 6].map((r) => r * stopPctAbs)
    : RUNGS;
  let used = 0, pnl = 0, stopped = false;
  const upTo = Math.min(rows.length, startBar + HORIZON);
  let hiC = entry, loC = entry;
  for (let j = startBar; j < upTo; j++) {
    const b = rows[j];
    if (opts.trailK) {
      // ATR-trail (the libedge top exit archetype): no ladder — the stop
      // follows the best close at K*ATR14, tighten-only. Trail computed
      // from PRIOR bars only; breach exits the full remainder.
      let tr = 0;
      for (let k2 = Math.max(1, j - 14); k2 < j; k2++) {
        const r2 = rows[k2], p2 = rows[k2 - 1];
        tr += Math.max(r2.h - r2.l, Math.abs(r2.h - p2.c), Math.abs(r2.l - p2.c));
      }
      const atr = tr / 14;
      const trail = L ? hiC - opts.trailK * atr : loC + opts.trailK * atr;
      const eff = L ? Math.max(stopPx, trail) : Math.min(stopPx, trail);
      if (L ? b.l <= eff : b.h >= eff) {
        pnl += (1 - used) * ((L ? eff / entry - 1 : 1 - eff / entry) * 100);
        used = 1; stopped = true; break;
      }
      hiC = Math.max(hiC, b.c); loC = Math.min(loC, b.c);
      continue;
    }
    // stop checks first (conservative — intrabar order unknown)
    if (L && b.l <= stopPx) { pnl += (1 - used) * ((stopPx / entry - 1) * 100); used = 1; stopped = true; break; }
    if (!L && b.h >= stopPx) { pnl += (1 - used) * ((1 - stopPx / entry) * 100); used = 1; stopped = true; break; }
    targets.forEach((r, k) => {
      if (used >= 1 || used >= ALLOC.slice(0, k + 1).reduce((a, x) => a + x, 0)) return;
      const hit = L ? b.h >= entry * (1 + r / 100) : b.l <= entry * (1 - r / 100);
      if (hit) { pnl += ALLOC[k] * r; used += ALLOC[k]; }
    });
  }
  if (!stopped && used < 1) {
    const last = rows[upTo - 1].c;
    pnl += (1 - used) * ((L ? last / entry - 1 : 1 - last / entry) * 100);
  }
  return +(pnl - FEE * 100 / 100).toFixed(4); // net pct on notional-equivalent
}

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1e3).toFixed(0)}s] ${m}`);

// universe: top futures by quote volume — or, with BT_UNIVERSE=pump, the
// parabolic habitat: small/mid-volume pairs ranked by today's move, where
// dead-cat tops are born (Q-style +100% names don't live in the top-25).
const tickers = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES').then((r) => r.json());
const base = (tickers.data || [])
  .filter((t) => t.symbol.endsWith('USDT') && !/^(1000|KACS|USDTUSDC)/.test(t.symbol));
const uniTk = (process.env.BT_UNIVERSE === 'pump'
  ? base.filter((t) => { const v = +t.quoteVolume || 0; return v >= 5e5 && v <= 8e7; })
        .sort((a, b) => Math.abs(+b.changeUtc24h || 0) - Math.abs(+a.changeUtc24h || 0))
  : base.sort((a, b) => (+b.quoteVolume || 0) - (+a.quoteVolume || 0)))
  .slice(0, SYMS_N);
const uni = uniTk.map((t) => t.symbol.replace(/USDT$/, ''));
// universe manifest — rank + quoteVolume per sym, so post-hoc liquidity
// bands (liquid/mid/illiquid terciles) are reproducible from this file.
writeJ(path.join(API, `mega-universe-${TAG}.json`),
  uniTk.map((t, i) => ({ rank: i + 1, sym: t.symbol.replace(/USDT$/, ''), quoteVol: +t.quoteVolume || 0 })));
log(`universe[${process.env.BT_UNIVERSE || 'majors'}]: ${uni.length} syms`);

const stats = {};  // strat -> {n,wins,net,rets[],eq,dd}
const cell = (s) => (stats[s] ??= { n: 0, wins: 0, net: 0, rets: [], eq: 0, peak: 0, dd: 0 });
let totSigs = 0;

for (const sym of uni) {
  const rows = await fetchKlines(sym, BARS);
  if (rows.length < WIN + HORIZON + 10) { log(`${sym}: only ${rows.length} bars — skipped`); continue; }
  let sigs = 0;
  for (let i = WIN; i < rows.length - HORIZON - 2; i++) {
    const win = rows.slice(i - WIN, i + 1);
    let ta = null;
    try { ta = TA.analyze(win, null, {}); } catch { continue; }
    if (!ta || !ta.bias || !ta.reasons?.length) continue;
    const strat = NAME(ta.reasons[0]);
    if (!strat) continue;
    // de-dup: one signal per symbol+strategy+6 bars (episode, not spam)
    const structStop = !STRUCT ? null : (
      ta.exhaustShort?.stop ?? ta.capitulation?.stop
      ?? (strat === 'Wyckoff' ? ta.wyckoff?.invalid : null)
      ?? (strat === 'Elliott W5 Proj' ? ta.elliottProj?.invalid : null)
      ?? null);
    const ret = simTrade(rows, i, ta.bias, structStop, {
      trailK: TRAIL_K || (TRAIL_SET.size ? (TRAIL_SET.has(strat) ? +(process.env.BT_TRAIL_SET_K || 2.5) : 0) : 0),
      retest: RETEST && ta.exhaustShort ? { climaxHi: ta.exhaustShort.climaxHi } : null,
    });
    if (ret == null) continue; // retest mode: no failed-retest print — no trade
    const c = cell(strat + ':' + ta.bias);
    c.n++; c.net += ret; c.rets.push(ret); if (ret > 0) c.wins++;
    epStream.write(JSON.stringify({ s: sym, c: strat + ':' + ta.bias, t: rows[i].t, n: ret }) + '\n');
    c.eq += ret; c.peak = Math.max(c.peak, c.eq); c.dd = Math.max(c.dd, c.peak - c.eq);
    sigs++; totSigs++;
    i += 5; // episode spacing
  }
  log(`${sym}: ${rows.length} bars, ${sigs} signals simulated`);
  writeJ(path.join(API, 'full-backtest-progress.json'), { sym, done: true, totSigs, elapsedSec: Math.round((Date.now() - t0) / 1e3) });
}

const out = { ts: Date.now(), updatedAt: new Date().toISOString(),
  model: { tag: TAG, episodesFile: `mega-episodes-${TAG}.jsonl`, bars1H: BARS, syms: SYMS_N, win: WIN, horizon: HORIZON, feePct: FEE, stopPct: STOP, rungs: RUNGS, alloc: ALLOC,
           trailK: TRAIL_K || 0, trailStrats: [...TRAIL_SET], retestEntries: RETEST,
           retestFib: RETEST_FIB, retestBars: RETEST_BARS, structuralStops: STRUCT,
           assumptions: 'entry next-bar open after signal close; stop checked before rungs intrabar (conservative); unfilled remainder exits at horizon close; one signal per sym+strat+6 bars; LONG+SHORT both graded (book is long-only — SHORT cells are shadow-only)' },
  totalSignals: totSigs, perStrategy: {} };

for (const [k, c] of Object.entries(stats).sort((a, b) => b[1].n - a[1].n)) {
  const n = c.n; if (!n) continue;
  const mean = c.net / n;
  const sd = Math.sqrt(c.rets.reduce((a, x) => a + (x - mean) ** 2, 0) / n) || 1e-9;
  const sqn = n >= 30 && sd > 1e-9 * Math.max(1, Math.abs(mean)) ? +(mean / sd * Math.sqrt(Math.min(n, 100))).toFixed(2) : null; /* sqn-guard */
  out.perStrategy[k] = { n, winRate: +(c.wins / n * 100).toFixed(1), netPct: +c.net.toFixed(2),
    meanNetPct: +mean.toFixed(4), ci95: [+(mean - 1.96 * sd / Math.sqrt(n)).toFixed(4), +(mean + 1.96 * sd / Math.sqrt(n)).toFixed(4)],
    sqn, maxDDPct: +c.dd.toFixed(2), avgR: +(mean / STOP).toFixed(3) };
}
epStream.end();
writeJ(path.join(API, 'full-backtest.json'), out);
try { fs.unlinkSync(path.join(API, 'full-backtest-progress.json')); } catch { }
log(`DONE — ${totSigs} signals, ${Object.keys(out.perStrategy).length} strategy cells in ${Math.round((Date.now() - t0) / 1e3)}s`);
