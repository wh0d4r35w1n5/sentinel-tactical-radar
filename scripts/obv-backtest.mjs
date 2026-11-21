// obv-backtest.mjs — OBV-extreme signal study, same engine + exit stack as
// full-backtest.mjs. Operator hypothesis: OBV pushed to the absolute limit
// (stealth accumulation / divergence / breakout-lead / distribution) should
// produce outsized SQN + WR. Same fees, same sim, same spacing — honest A/B.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = path.join(ROOT, 'api');
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

await import(path.join(ROOT, 'ta-engine.js'));
const TA = globalThis.TAEngine;

const SYMS_N = +(process.env.BT_SYMS || 60);
const BARS = +(process.env.BT_BARS || 2160);
const WIN = 140;
const HORIZON = 96;
const FEE = 0.17;
const STOP = 1.0;
const RUNGS = [0.3, 0.55, 0.9, 1.4, 2.2];
const ALLOC = [0.2, 0.2, 0.18, 0.15, 0.12];

async function fetchKlines(sym, bars) {
  const out = [];
  let end = Date.now();
  while (out.length < bars) {
    const u = `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${sym}USDT&productType=USDT-FUTURES&granularity=1H&endTime=${end}&limit=200`;
    let rows = [];
    for (let att = 0; att < 4; att++) {
      const j = await fetch(u).then((r) => r.json()).catch(() => ({}));
      rows = (j.data || []).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], qv: +r[6] })).sort((a, b) => a.t - b.t);
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 500 * (att + 1))); // rate-limit backoff
    }
    if (!rows.length) break;
    const older = rows.filter((r) => !out.length || r.t < out[0].t);
    out.unshift(...older);
    if (rows.length < 200) break;
    end = rows[0].t - 1;
    await new Promise((r) => setTimeout(r, 120));
  }
  return out.slice(-bars);
}

const TRAIL_K = +(process.env.BT_TRAIL_K || 0);

function simTrade(rows, i, dir) {
  const L = dir === 'LONG';
  const entry = rows[i + 1].o, startBar = i + 1;
  const stopPx = L ? entry * (1 - STOP / 100) : entry * (1 + STOP / 100);
  const targets = RUNGS;
  let used = 0, pnl = 0, stopped = false;
  const upTo = Math.min(rows.length, startBar + HORIZON);
  let hiC = entry, loC = entry;
  for (let j = startBar; j < upTo; j++) {
    const b = rows[j];
    if (TRAIL_K) {
      let tr = 0;
      for (let k2 = Math.max(1, j - 14); k2 < j; k2++) {
        const r2 = rows[k2], p2 = rows[k2 - 1];
        tr += Math.max(r2.h - r2.l, Math.abs(r2.h - p2.c), Math.abs(r2.l - p2.c));
      }
      const atr = tr / 14;
      const trail = L ? hiC - TRAIL_K * atr : loC + TRAIL_K * atr;
      const eff = L ? Math.max(stopPx, trail) : Math.min(stopPx, trail);
      if (L ? b.l <= eff : b.h >= eff) {
        pnl += (1 - used) * ((L ? eff / entry - 1 : 1 - eff / entry) * 100);
        used = 1; stopped = true; break;
      }
      hiC = Math.max(hiC, b.c); loC = Math.min(loC, b.c);
      continue;
    }
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
  return +(pnl - FEE).toFixed(4);
}

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1e3).toFixed(0)}s] ${m}`);

const tickers = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES').then((r) => r.json());
const uni = (tickers.data || [])
  .filter((t) => t.symbol.endsWith('USDT') && !/^(1000|KACS|USDTUSDC)/.test(t.symbol))
  .sort((a, b) => (+b.quoteVolume || 0) - (+a.quoteVolume || 0))
  .slice(0, SYMS_N)
  .map((t) => t.symbol.replace(/USDT$/, ''));
log(`universe[obv]: ${uni.length} syms`);

// OBV-extreme cells — each condition its own cell so the honest answer is
// per-condition, not pooled. Most specific first (confluence), then singles.
const OBV_CELL = (obv) => {
  if (!obv) return null;
  const bullDiv = obv.div && String(obv.div).includes('bull');
  const bearDiv = obv.div && String(obv.div).includes('bear');
  if (obv.stealth && bullDiv) return ['OBV stealth+div', 'LONG'];
  if (obv.stealth) return ['OBV stealth', 'LONG'];
  if (obv.leadBull && bullDiv) return ['OBV lead+div', 'LONG'];
  if (obv.leadBull) return ['OBV lead-bull', 'LONG'];
  if (bullDiv) return ['OBV div-bull', 'LONG'];
  if (obv.distrib && bearDiv) return ['OBV distrib+div', 'SHORT'];
  if (obv.distrib) return ['OBV distrib', 'SHORT'];
  if (obv.leadBear && bearDiv) return ['OBV leadbear+div', 'SHORT'];
  if (obv.leadBear) return ['OBV lead-bear', 'SHORT'];
  if (bearDiv) return ['OBV div-bear', 'SHORT'];
  return null;
};

const stats = {};
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
    if (!ta) continue;
    const pick = OBV_CELL(ta.eng?.obv);
    if (!pick) continue;
    const [strat, dir] = pick;
    const ret = simTrade(rows, i, dir);
    if (ret == null) continue;
    const c = cell(strat + ':' + dir);
    c.n++; c.net += ret; c.rets.push(ret); if (ret > 0) c.wins++;
    c.eq += ret; c.peak = Math.max(c.peak, c.eq); c.dd = Math.max(c.dd, c.peak - c.eq);
    sigs++; totSigs++;
    i += 5;
  }
  log(`${sym}: ${rows.length} bars, ${sigs} obv signals simulated`);
  writeJ(path.join(API, 'obv-backtest-progress.json'), { sym, done: true, totSigs, elapsedSec: Math.round((Date.now() - t0) / 1e3) });
}

const out = { ts: Date.now(), updatedAt: new Date().toISOString(),
  model: { bars1H: BARS, syms: SYMS_N, win: WIN, horizon: HORIZON, feePct: FEE, stopPct: STOP, rungs: RUNGS, alloc: ALLOC,
           signalSource: 'ta.obv extreme conditions (stealth/divergence/lead/distribution) — SAME engine object the live scanner computes',
           assumptions: 'identical to full-backtest: entry next-bar open, stop before rungs intrabar, remainder at horizon close, one signal per sym+cell+6 bars' },
  totalSignals: totSigs, perStrategy: {} };

for (const [k, c] of Object.entries(stats).sort((a, b) => b[1].n - a[1].n)) {
  const n = c.n; if (!n) continue;
  const mean = c.net / n;
  const sd = Math.sqrt(c.rets.reduce((a, x) => a + (x - mean) ** 2, 0) / n) || 1e-9;
  const sqn = n >= 30 && sd > 1e-9 * Math.max(1, Math.abs(mean)) ? +(mean / sd * Math.sqrt(Math.min(n, 100))).toFixed(2) : null; /* sqn-guard */
  // win/loss asymmetry — Will's payoff-ratio metric baked in
  const w = c.rets.filter((x) => x > 0), l = c.rets.filter((x) => x <= 0);
  const aw = w.length ? w.reduce((a, x) => a + x, 0) / w.length : 0;
  const al = l.length ? -l.reduce((a, x) => a + x, 0) / l.length : 0;
  const gw = w.reduce((a, x) => a + x, 0), gl = -l.reduce((a, x) => a + x, 0);
  out.perStrategy[k] = { n, winRate: +(c.wins / n * 100).toFixed(1), netPct: +c.net.toFixed(2),
    meanNetPct: +mean.toFixed(4), ci95: [+(mean - 1.96 * sd / Math.sqrt(n)).toFixed(4), +(mean + 1.96 * sd / Math.sqrt(n)).toFixed(4)],
    sqn, maxDDPct: +c.dd.toFixed(2), avgWinPct: +aw.toFixed(3), avgLossPct: +al.toFixed(3),
    payoffRatio: al ? +(aw / al).toFixed(2) : null, profitFactor: gl ? +(gw / gl).toFixed(2) : 99 };
}
writeJ(path.join(API, 'obv-backtest.json'), out);
log(`DONE — ${totSigs} signals, ${Object.keys(out.perStrategy).length} obv cells`);
