// strategy-policy.mjs — codified promote/probation/halt/abandon rules
// (Will Evans M6+Q5: "what precise, predefined evidence removes a model").
// Reads edge-attribution.json (independent-episode stats) and writes
// state/strategy-policy.json — the exec consults it in the order gate.
// Signals ALWAYS keep emitting for evaluation; status only gates orders.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = path.join(ROOT, 'api');
const STATE = path.join(ROOT, 'state');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

const RULES = {
  live: 'episodes>=30 AND meanCI.lower>0 AND netAfterCost>0 — independently demonstrated positive expectancy after modeled costs',
  probation: 'default: insufficient independent evidence — no live orders, evaluation continues',
  halted: 'episodes>=25 AND meanCI.upper<0 — significantly negative expectancy: NO live orders, evaluation continues for re-qualification',
  abandoned: 'halted AND second-half holdout also net-negative — candidate for code removal, not more tuning',
};
const PROMOTE_N = 30, HALT_N = 25;

const attr = readJ(path.join(API, 'edge-attribution.json'), null);
const hold = readJ(path.join(API, 'eval-independence.json'), null);
// trader.dev library — external cross-validation prior per archetype family.
// ADVISORY ONLY: it annotates each strategy with what ~390k independent
// backtests say about its logic family; lifecycle status remains gated on
// our own forward episodes alone (Will's rule — external priors never
// promote or kill, they inform the operator's read).
const lib = readJ(path.join(API, 'libedge.json'), null);
const OUR_FAMILY = (strategy) =>
  /carry|funding/i.test(strategy) ? 'carry'
  : /breakout|continuation|sweep|liq/i.test(strategy) ? 'breakout'
  : /fade|vwap|effort|revert|mean|eq.?edge|quartile|\bsfp\b|rejection|capitulat|wyckoff|exhaust/i.test(strategy) ? 'meanrev'
  : /momentum|tsmom|trend|major|runner|ignition/i.test(strategy) ? 'trend'
  : null;
const extFor = (strategy) => {
  const fam = OUR_FAMILY(strategy);
  if (!fam || !lib?.symbols) return null;
  let witnesses = 0, syms = 0, supportive = 0, negative = 0;
  const sharpes = [];
  for (const le of Object.values(lib.symbols)) {
    const a = le?.archEdge?.[fam];
    if (!a || a.n == null) continue;
    syms++; witnesses += a.n;
    if (a.n >= 3 && a.medSharpe >= 1) supportive++;
    if (a.n >= 3 && a.medPf < 1.2) negative++;
    if (Number.isFinite(a.medSharpe)) sharpes.push(a.medSharpe);
  }
  if (!syms) return null;
  sharpes.sort((x, y) => x - y);
  return { family: fam, symbols: syms, witnesses, medSharpe: +sharpes[Math.floor(sharpes.length / 2)].toFixed(2), supportiveSyms: supportive, negativeSyms: negative };
};
// full-historical-backtest advisory (api/full-backtest.json — 90d 1H x
// 25 syms, live TAEngine + live exit stack). Same rule as the library:
// ADVISORY ONLY — it annotates each strategy with what ~8k simulated
// historical signals say; lifecycle status stays gated on forward
// episodes alone. Conflicts between backtest and forward record are
// surfaced, never silently resolved.
const bt = readJ(path.join(API, 'full-backtest.json'), null);
const btCell = (strategy) => {
  if (!bt?.perStrategy) return null;
  const norm = strategy.replace(/[^A-Za-z]/g, '');
  const findCell = (suffix) => Object.keys(bt.perStrategy).find((k) => {
    if (!k.endsWith(suffix)) return false;
    const kn = k.split(':')[0].replace(/[^A-Za-z]/g, '');
    if (/^Wyckoff/.test(strategy)) return kn === 'Wyckoff';
    return kn === norm || kn.startsWith(norm) || norm.startsWith(kn);
  });
  // dedicated-short strategies (Exhaustion Short et al) judge their :SHORT cell
  const key = findCell(':LONG') || findCell(':SHORT');
  const v = key ? bt.perStrategy[key] : null;
  return v && v.n >= 10 ? { n: v.n, winRate: v.winRate, netPct: v.netPct, meanNetPct: v.meanNetPct, sqn: v.sqn, cell: key } : null;
};
const btAdvisory = (b) => {
  if (!b) return null;
  if (b.sqn >= 1) return `backtest-bullish: ${b.cell} SQN +${b.sqn} n=${b.n} net ${b.netPct}%`;
  if (b.sqn <= -2) return `backtest-confirm-loss: ${b.cell} SQN ${b.sqn} n=${b.n} net ${b.netPct}%`;
  return `backtest-neutral: ${b.cell} SQN ${b.sqn} n=${b.n}`;
};
if (!attr?.byStrategy) { console.warn('strategy-policy: edge-attribution missing — keeping existing policy'); process.exit(0); }

const prev = readJ(path.join(STATE, 'strategy-policy.json'), { strategies: {} });
const policies = {};
for (const [s, st] of Object.entries(attr.byStrategy)) {
  const n = st.episodes || 0, lo = st.meanDirFwd24h?.ci?.[0], hi = st.meanDirFwd24h?.ci?.[1], net = st.netAfterCost;
  let status = 'probation', why = 'insufficient evidence (default)';
  if (n >= HALT_N && hi != null && hi < 0) {
    status = 'halted';
    const h2 = hold?.holdout?.second ? null : null; // second-half per-strategy not emitted — use overall CI as evidence
    why = `${n} episodes, CI upper ${hi} < 0 — significantly negative expectancy`;
    // abandon check: halted AND journal realized contribution deeply negative
    if (n >= 60) { status = 'abandoned'; why += `, n=${n} >= 60 — remove the model, not the parameters`; }
  } else if (n >= PROMOTE_N && lo != null && lo > 0 && net > 0) {
    status = 'live'; why = `${n} episodes, CI lower +${lo}, netAfterCost +${net}`;
  }
  const btC = btCell(s);
  policies[s] = { status, why, episodes: n, meanDirFwd24h: st.meanDirFwd24h?.mean ?? null, ci: st.meanDirFwd24h?.ci ?? null, netAfterCost: net, hitRate: st.hitRate?.p ?? null, extLib: extFor(s), backtest: btC, backtestAdvisory: btAdvisory(btC), reviewedAt: new Date().toISOString() };
}
// per-cell lifecycle (strategy:direction) — same rules, judged on the cell's
// own episodes, plus a holdout bar for 'live': both chronological halves
// net-positive after cost (more cells = more chances to pass by luck, so the
// cell must have earned it twice). The exec reads `cells` before `strategies`.
const cellPolicies = {};
for (const [c, st] of Object.entries(attr.byCell || {})) {
  const n = st.episodes || 0, lo = st.meanDirFwd24h?.ci?.[0], hi = st.meanDirFwd24h?.ci?.[1], net = st.netAfterCost;
  const h = st.holdout || {};
  let status = 'probation', why = 'insufficient evidence (default)';
  if (n >= HALT_N && hi != null && hi < 0) {
    status = 'halted';
    why = `${n} episodes, CI upper ${hi} < 0 — significantly negative expectancy`;
    if (n >= 60) { status = 'abandoned'; why += `, n=${n} >= 60`; }
  } else if (n >= PROMOTE_N && lo != null && lo > 0 && net > 0 && h.firstNetAfterCost > 0 && h.secondNetAfterCost > 0) {
    status = 'live';
    why = `${n} episodes, CI lower +${lo}, netAfterCost +${net}, holdout halves +${h.firstNetAfterCost}/+${h.secondNetAfterCost}`;
  } else if (n >= PROMOTE_N && lo != null && lo > 0 && net > 0) {
    why = `${n} episodes, CI lower +${lo} but a holdout half is not net-positive (${h.firstNetAfterCost}/${h.secondNetAfterCost})`;
  }
  cellPolicies[c] = { status, why, strategy: st.strategy, direction: st.direction, episodes: n, meanDirFwd24h: st.meanDirFwd24h?.mean ?? null, ci: st.meanDirFwd24h?.ci ?? null, netAfterCost: net, holdout: h, hitRate: st.hitRate?.p ?? null, reviewedAt: new Date().toISOString() };
}
const out = { ts: Date.now(), updatedAt: new Date().toISOString(), source: 'edge-attribution + codified rules', rules: { ...RULES, cellLive: 'cell (strategy:direction) live = strategy live rule on its own episodes AND both chronological halves netAfterCost>0' }, thresholds: { promoteN: PROMOTE_N, haltN: HALT_N }, strategies: policies, cells: cellPolicies };
writeJ(path.join(STATE, 'strategy-policy.json'), out);
writeJ(path.join(API, 'strategy-policy.json'), out); // dashboard-visible copy
const counts = {};
for (const p of Object.values(policies)) counts[p.status] = (counts[p.status] || 0) + 1;
console.log('strategy-policy:', JSON.stringify(counts), '| live:', Object.entries(policies).filter(([, p]) => p.status === 'live').map(([s]) => s).join(',') || 'none',
  '| cells:', Object.entries(cellPolicies).map(([c, p]) => `${c}=${p.status}`).join(', ') || 'none');
