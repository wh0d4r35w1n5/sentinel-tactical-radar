// tp-ladder-ab.mjs — ladder-shape A/B replay over journaled excursions.
// Every mae-mfe episode carries mfePct (how far the trade ran) and the
// realized exitPct — so we can replay each seat under a different rung
// grid: rungs at-or-below mfe fill at their level, the unfilled remainder
// (incl. moon leg) exits at the realized exit. Same cost model as
// edge-attribution (0.17% round trip). Reads state/mae-mfe.json +
// state/rr-config.json, writes api/tp-ladder-ab.json.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = path.join(ROOT, 'api');
const STATE = path.join(ROOT, 'state');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

const FEE = 0.17;
const eps = readJ(path.join(STATE, 'mae-mfe.json'), { episodes: [] }).episodes
  .filter((e) => e.entry > 0 && e.exit > 0 && e.mfePct != null);
const rr = readJ(path.join(STATE, 'rr-config.json'), null);
const ALLOC = rr?.alloc || [0.2, 0.2, 0.18, 0.15, 0.12];
const MOON = rr?.moon || 0.15;
const LIVE = rr?.absPct || [0.3, 0.55, 0.9, 1.4, 2.2];

const VARIANTS = {
  'A_live':     LIVE,
  'B_tighter':  [0.20, 0.35, 0.60, 1.00, 1.60],
  'C_wider':    [0.45, 0.80, 1.30, 2.00, 3.00],
  'D_deep':     [0.55, 1.00, 1.60, 2.50, 4.00],
  'E_frontload':[0.25, 0.40, 0.60, 0.85, 1.20],
};

const exitPct = (e) => (e.side === 'short' ? 1 - e.exit / e.entry : e.exit / e.entry - 1) * 100;

function replay(absPct) {
  const nets = [];
  let rungsFilled = 0, rungsTotal = 0;
  for (const e of eps) {
    const mfe = Math.max(0, e.mfePct), ex = exitPct(e);
    let pnl = 0, used = 0;
    absPct.forEach((r, i) => {
      if (mfe >= r) { pnl += ALLOC[i] * r; used += ALLOC[i]; rungsFilled++; }
      rungsTotal++;
    });
    pnl += (1 - used) * ex;         // moon + unfilled remainder ride to realized exit
    nets.push(pnl - FEE);
  }
  const n = nets.length, mean = nets.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(nets.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
  return {
    rungs: absPct, episodes: n, meanNetPct: +mean.toFixed(4),
    ci95: [+(mean - 1.96 * sd / Math.sqrt(n)).toFixed(4), +(mean + 1.96 * sd / Math.sqrt(n)).toFixed(4)],
    totalNetPct: +nets.reduce((a, x) => a + x, 0).toFixed(2),
    winRate: +(nets.filter((x) => x > 0).length / n * 100).toFixed(1),
    avgRungsFilled: +(rungsFilled / Math.max(rungsTotal, 1) * absPct.length).toFixed(2),
  };
}

const out = {
  ts: Date.now(), updatedAt: new Date().toISOString(),
  method: 'mae-mfe replay: rung fills iff episode.mfePct>=rung; unfilled+moon exits at realized exitPct; fee 0.17%/position; same 300-episode sample for every variant',
  caveat: 'replay assumes rung fills do not change the realized exit of the remainder — honest approximation, not forward data',
  liveProfile: rr?.profile || 'no rr-config — code-default grid',
  variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, replay(v)])),
};
const rank = Object.entries(out.variants).sort((a, b) => b[1].meanNetPct - a[1].meanNetPct);
out.verdict = rank[0] ? `${rank[0][0]} leads the replay — ${rank[0][1].meanNetPct}%/ep vs live ${out.variants.A_live?.meanNetPct}%/ep` : 'no data';
writeJ(path.join(API, 'tp-ladder-ab.json'), out);
console.log(JSON.stringify(out.variants, null, 1));
console.log('verdict:', out.verdict);
