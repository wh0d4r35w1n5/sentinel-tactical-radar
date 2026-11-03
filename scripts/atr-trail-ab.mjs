// atr-trail-ab.mjs — ATR-trailing-stop exit variants vs realized exits,
// replayed over journaled episodes using the 15m kline cache for the
// actual price path (not just extremes — a trail needs the walk).
// libedge corpus ranks atr-trail the top exit archetype on majors
// (BTC pf 14.6, SOL 14.7, ETH 11.9) — this measures what it would have
// done on OUR seats vs what the TP-ladder realized.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = path.join(ROOT, 'api');
const STATE = path.join(ROOT, 'state');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

const FEE = 0.17;
const eps = readJ(path.join(STATE, 'mae-mfe.json'), { episodes: [] }).episodes
  .filter((e) => e.entry > 0 && e.exit > 0 && e.ts && e.durMin);
const kl = readJ(path.join(STATE, 'klines-15m.json'), {});
// historical coverage: episodes outside the rolling 30h cache fetch their
// real 15m path from Bitget history and persist to a replay cache — the
// evidence base stops depending on what's still in the rolling window.
const HIST = path.join(STATE, 'klines-hist-15m.json');
const klHist = readJ(HIST, {});

async function fetchHist(sym, t0, t1) {
  const key = sym + '|' + Math.floor(t0 / 3.6e6);
  if (klHist[key]?.rows?.length) return klHist[key].rows;
  const out = [];
  let end = t1;
  while (end > t0) {
    const u = `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${sym}&productType=USDT-FUTURES&granularity=15m&endTime=${end}&limit=200`;
    const j = await fetch(u).then((r) => r.json()).catch(() => null);
    const rows = (j?.data || []).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).sort((a, b) => a.t - b.t);
    if (!rows.length) break;
    out.unshift(...rows.filter((r) => r.t <= end));
    end = rows[0].t - 1;
    if (rows.length < 200 || out.length > 2000) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  const rows = out.filter((r) => r.t >= t0 - 4 * 3.6e6 && r.t <= t1 + 3.6e6);
  klHist[key] = { rows };
  return rows;
}

const atr = (rows, i, n = 14) => {
  let s = 0, c = 0;
  for (let j = Math.max(1, i - n); j < i; j++) {
    const p = rows[j - 1];
    s += Math.max(rows[j].h - rows[j].l, Math.abs(rows[j].h - p.c), Math.abs(rows[j].l - p.c));
    c++;
  }
  return c ? s / c : null;
};

// replay one episode under trail-k: long seat at entry, trail peak-K*ATR.
// horizonMin: the realized-duration replay CANNOT measure a trail's real
// edge — trails exist to hold winners longer, and clipping at durMin
// forbids exactly that. freeHorizon walks the path out to H hours past
// entry so the trail itself picks the exit, like the backtest's 96 bars.
function trailExit(e, rows, k, horizonMin) {
  const L = e.side !== 'short';
  const i0 = rows.findIndex((r) => r.t >= e.ts - 7.5 * 6e4);
  if (i0 < 15) return null;
  const a0 = atr(rows, i0);
  if (!a0 || a0 <= 0) return null;
  const bars = Math.max(1, Math.round((horizonMin || e.durMin) / 15));
  let peak = e.entry, trough = e.entry, exitPx = null, hitBar = null;
  for (let j = i0; j < Math.min(rows.length, i0 + bars + 1); j++) {
    const b = rows[j];
    if (L) {
      peak = Math.max(peak, b.h);
      const stop = peak - k * a0;
      if (b.l <= stop) { exitPx = stop; hitBar = j - i0; break; }
    } else {
      trough = Math.min(trough, b.l);
      const stop = trough + k * a0;
      if (b.h >= stop) { exitPx = stop; hitBar = j - i0; break; }
    }
  }
  if (exitPx == null) {
    const last = rows[Math.min(rows.length - 1, i0 + bars)];
    if (!last) return null;
    exitPx = last.c;                            // horizon close, not realized exit
  }
  const ret = L ? (exitPx / e.entry - 1) * 100 : (1 - exitPx / e.entry) * 100;
  return { retPct: ret, hit: hitBar != null, bars: hitBar };
}

const covered = [];
for (const e of eps) {
  const sym = e.sym.endsWith('USDT') ? e.sym : e.sym + 'USDT';
  let rows = kl[sym]?.rows;
  if (!rows || e.ts < rows[0].t || e.ts > rows[rows.length - 1].t) {
    rows = await fetchHist(sym, e.ts - 4 * 3.6e6, e.ts + Math.max(e.durMin, 24 * 60) * 6e4);
  }
  if (!rows || !rows.length) continue;
  if (e.ts < rows[0].t || e.ts > rows[rows.length - 1].t) continue;   // path not recoverable
  covered.push({ e, rows });
}
try { fs.writeFileSync(HIST + '.tmp', JSON.stringify(klHist)); fs.renameSync(HIST + '.tmp', HIST); } catch {}

const out = { ts: Date.now(), updatedAt: new Date().toISOString(),
  method: 'per episode: walk 15m bars from entry for durMin bars; trail = peak - K*ATR14(entry); exit on touch else realized exit; fee 0.17%',
  caveat: '15m granularity — intrabar trail hits are approximations; only episodes inside the 30h kline cache replay',
  episodesTotal: eps.length, covered: covered.length, variants: {} };

const realized = covered.map(({ e }) => (e.side === 'short' ? 1 - e.exit / e.entry : e.exit / e.entry - 1) * 100 - FEE);
out.variants.realized_exit = summarize(realized);
// two replay modes, reported separately because they answer different
// questions: durCap = "same holding period, trail-managed" (biased against
// trails — clips exactly what trails buy); free24h = "entry real, exit
// trail's own choice inside 24h" — the honest counterfactual.
for (const k of [1.0, 1.5, 2.0, 3.0]) {
  for (const [tag, hor] of [['durCap', 0], ['free24h', 24 * 60]]) {
    const nets = [], hits = [];
    for (const { e, rows } of covered) {
      if (hor && e.ts + hor * 6e4 > Date.now() - 3.6e6) continue; // path too young
      const r = trailExit(e, rows, k, hor);
      if (r) { nets.push(r.retPct - FEE); hits.push(r.hit ? 1 : 0); }
    }
    out.variants[`trail_k${k}_${tag}`] = { k, horizon: tag, ...summarize(nets), trailHitRate: hits.length ? +(hits.reduce((a, x) => a + x, 0) / hits.length * 100).toFixed(0) : null };
  }
}
function summarize(nets) {
  const n = nets.length;
  if (!n) return { n: 0 };
  const mean = nets.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(nets.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
  return { n, meanNetPct: +mean.toFixed(4), ci95: [+(mean - 1.96 * sd / Math.sqrt(n)).toFixed(4), +(mean + 1.96 * sd / Math.sqrt(n)).toFixed(4)], totalNetPct: +nets.reduce((a, x) => a + x, 0).toFixed(2), winRate: +(nets.filter((x) => x > 0).length / n * 100).toFixed(1) };
}
const best = Object.entries(out.variants).filter(([k]) => k.startsWith('trail') && k.endsWith('free24h')).sort((a, b) => b[1].meanNetPct - a[1].meanNetPct)[0];
out.verdict = best ? `best free-horizon trail K=${best[1].k} (${best[1].meanNetPct}%/ep, n=${best[1].n}) vs realized exits ${out.variants.realized_exit.meanNetPct}%/ep — durCap variants undercount trails by construction` : 'no covered episodes';
writeJ(path.join(API, 'atr-trail-ab.json'), out);
console.log(JSON.stringify(out.variants, null, 1));
console.log('verdict:', out.verdict);
