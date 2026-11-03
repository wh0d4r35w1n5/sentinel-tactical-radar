// confirm-ab.mjs — CONFIRM_PCT variant replay over journaled excursions.
// The 228-excursion study already showed +0.2% confirm beats instant fill
// (+12.5% net vs -41.9%) — this replays the same episodes under a sweep of
// thresholds to find whether 0.2 is the right level or a plateau edge.
//
// Model per threshold p:
//   - episodes with mfePct < p never printed the confirm => no seat (skipped,
//     outcome 0 — the gate's selection benefit)
//   - episodes with mfePct >= p fill at entry*(1+p/100): realized outcome
//     shifts by -p (the premium paid for proof), same cost model.
// Caveat: mae-mfe only journals filled seats — arms that never printed are
// invisible in both legs, so this measures premium sensitivity + selection,
// not the unfilled-losers benefit (that's already documented).
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
const exitPct = (e) => (e.side === 'short' ? 1 - e.exit / e.entry : e.exit / e.entry - 1) * 100;

const out = { ts: Date.now(), updatedAt: new Date().toISOString(),
  method: 'per threshold p: episodes with mfe<p skipped (gate saved the seat); mfe>=p pays p% basis premium; fee 0.17%',
  livePct: +(process.env.SENTINEL_CONFIRM_PCT || 0.2), variants: {} };

for (const p of [0, 0.1, 0.2, 0.3, 0.5, 0.8]) {
  const nets = eps.filter((e) => e.mfePct >= p)
    .map((e) => exitPct(e) - p - FEE);
  const n = nets.length;
  const mean = n ? nets.reduce((a, x) => a + x, 0) / n : 0;
  const sd = n ? Math.sqrt(nets.reduce((a, x) => a + (x - mean) ** 2, 0) / n) : 0;
  out.variants[`p${p}`] = {
    confirmPct: p, seated: n, skipped: eps.length - n,
    meanNetPct: +mean.toFixed(4),
    ci95: n ? [+(mean - 1.96 * sd / Math.sqrt(n)).toFixed(4), +(mean + 1.96 * sd / Math.sqrt(n)).toFixed(4)] : null,
    totalNetPct: +nets.reduce((a, x) => a + x, 0).toFixed(2),
    winRate: n ? +(nets.filter((x) => x > 0).length / n * 100).toFixed(1) : null,
  };
}
const best = Object.values(out.variants).sort((a, b) => b.meanNetPct - a.meanNetPct)[0];
out.verdict = best ? `best threshold on replay: +${best.confirmPct}% (${best.meanNetPct}%/ep over ${best.seated} seats)` : 'no data';
writeJ(path.join(API, 'confirm-ab.json'), out);
console.log(JSON.stringify(out.variants, null, 1));
console.log('verdict:', out.verdict);
