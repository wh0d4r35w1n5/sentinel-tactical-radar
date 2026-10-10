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
  policies[s] = { status, why, episodes: n, meanDirFwd24h: st.meanDirFwd24h?.mean ?? null, ci: st.meanDirFwd24h?.ci ?? null, netAfterCost: net, hitRate: st.hitRate?.p ?? null, reviewedAt: new Date().toISOString() };
}
const out = { ts: Date.now(), updatedAt: new Date().toISOString(), source: 'edge-attribution + codified rules', rules: RULES, thresholds: { promoteN: PROMOTE_N, haltN: HALT_N }, strategies: policies };
writeJ(path.join(STATE, 'strategy-policy.json'), out);
writeJ(path.join(API, 'strategy-policy.json'), out); // dashboard-visible copy
const counts = {};
for (const p of Object.values(policies)) counts[p.status] = (counts[p.status] || 0) + 1;
console.log('strategy-policy:', JSON.stringify(counts), '| live:', Object.entries(policies).filter(([, p]) => p.status === 'live').map(([s]) => s).join(',') || 'none');
