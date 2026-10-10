// eval-forensics.mjs — evaluation independence + edge attribution (Will M4/Q2/Q1).
// Pure analysis over the eval journal: no trading code, no credentials.
// Emits api/eval-independence.json + api/edge-attribution.json.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = path.join(ROOT, 'api');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

// ---------- load the full journal ----------
const recs = [];
for (const f of ['history/eval-2026-09.json', 'history/eval-2026-10.json', 'signal-eval.json']) {
  const d = readJ(path.join(API, f), null);
  const r = d?.records || (Array.isArray(d) ? d : []);
  for (const x of r) if (x?.runTs && x.asset) recs.push(x);
}
// dedupe by key — monthly archives + live file overlap at the tail
const seen = new Set();
const evals = recs.filter((r) => { const k = r.key || `${r.runTs}|${r.asset}|${r.direction}`; if (seen.has(k)) return false; seen.add(k); return true; })
  .sort((a, b) => a.runTs - b.runTs);

const dirSign = (r) => (r.direction === 'SHORT' ? -1 : 1);
const dirAdj = (r, f = 'fwd24h') => (r[f] == null ? null : dirSign(r) * r[f]);
const labeled = evals.filter((r) => r.fwd24h != null);

// ---------- independence: episode clustering ----------
// Two evals on the same asset+direction <24h apart have ~fully-overlapping
// outcome windows — they are ONE observation, not two. Merge into episodes;
// episode outcome = first eval's forward return (entry at signal time).
const EP_GAP = 24 * 36e5;
const episodes = [];
const byKey = {};
for (const r of labeled) {
  const k = `${r.asset}|${r.direction}`;
  const last = byKey[k];
  if (last && r.runTs - last.lastTs < EP_GAP) {
    last.members.push(r); last.lastTs = r.runTs;
    if (r.grade === 'A' || (r.grade === 'B' && last.grade !== 'A')) last.grade = r.grade; // episode grade = strongest member
  } else {
    const ep = { key: k, ts: r.runTs, lastTs: r.runTs, members: [r], asset: r.asset, direction: r.direction, grade: r.grade, strategy: r.strategy, fwd24h: r.fwd24h, alpha24h: r.alpha24h, fwd4h: r.fwd4h, fwd1h: r.fwd1h, score: r.score };
    episodes.push(ep); byKey[k] = ep;
  }
}
episodes.sort((a, b) => a.ts - b.ts);

// ---------- stats helpers ----------
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const tCI = (a) => { const m = mean(a), s = sd(a), n = a.length; if (m == null || s == null || n < 2) return { mean: m, ci: [null, null], n }; const h = 1.96 * s / Math.sqrt(n); return { mean: +m.toFixed(5), ci: [+(m - h).toFixed(5), +(m + h).toFixed(5)], n }; };
const wilson = (hits, n) => { if (!n) return { p: null, ci: [null, null] }; const z = 1.96, p = hits / n, d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return { p: +p.toFixed(4), ci: [+Math.max(0, c - h).toFixed(4), +Math.min(1, c + h).toFixed(4)] }; };
const spearman = (xs, ys) => {
  const n = Math.min(xs.length, ys.length); if (n < 10) return null;
  const rank = (a) => { const s = a.slice(0, n).map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
  const rx = rank(xs), ry = rank(ys); const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? +(num / Math.sqrt(dx * dy)).toFixed(4) : null;
};

// ---------- by-grade stats on INDEPENDENT episodes ----------
const COST_PCT = 0.0017; // ~0.17% round trip: taker×2 + spread — modeled, not journal-exact
const grades = {};
for (const g of [...new Set(episodes.map((e) => e.grade))]) {
  const eps = episodes.filter((e) => e.grade === g);
  const fws = eps.map((e) => dirSign(e) * e.fwd24h);
  const hits = fws.filter((x) => x > 0).length;
  const rawN = eps.reduce((a, e) => a + e.members.length, 0);
  grades[g] = {
    rawEvals: rawN, episodes: eps.length, compressionPct: +(100 * (1 - eps.length / Math.max(rawN, 1))).toFixed(1),
    hitRate24h: wilson(hits, eps.length),
    meanDirFwd24h: tCI(fws),
    meanDirFwd24hNetCost: fws.length ? +(mean(fws) - COST_PCT * 100).toFixed(5) : null,
  };
}
// chronological holdout — first half vs second half of episodes
const mid = episodes[Math.floor(episodes.length / 2)]?.ts;
const holdout = { splitTs: mid ? new Date(mid).toISOString() : null, first: {}, second: {} };
for (const g of Object.keys(grades)) {
  for (const [h, eps] of [['first', episodes.filter((e) => e.grade === g && e.ts < mid)], ['second', episodes.filter((e) => e.grade === g && e.ts >= mid)]]) {
    const fws = eps.map((e) => dirSign(e) * e.fwd24h);
    holdout[h][g] = { n: eps.length, meanDirFwd24h: tCI(fws).mean, hitRate: eps.length ? +(fws.filter((x) => x > 0).length / eps.length).toFixed(4) : null };
  }
}
// A-grade inversion check
const aM = grades.A?.meanDirFwd24h, bbM = (grades.BB || grades.B)?.meanDirFwd24h;
const inversion = {
  aMean: aM?.mean ?? null, bMean: bbM?.mean ?? null,
  aCi: aM?.ci ?? null, bCi: bbM?.ci ?? null,
  ciOverlap: aM && bbM && aM.ci[0] != null ? !(aM.ci[1] < bbM.ci[0] || bbM.ci[1] < aM.ci[0]) : null,
  verdict: null,
};
if (inversion.aMean != null && inversion.bMean != null) {
  inversion.verdict = inversion.aMean < inversion.bMean
    ? (inversion.ciOverlap ? `A(${inversion.aMean}) < B(${inversion.bMean}) but CIs overlap — suggestive, not proven` : `A(${inversion.aMean}) < B(${inversion.bMean}) CIs disjoint — INVERSION CONFIRMED on independent episodes`)
    : `A(${inversion.aMean}) >= B(${inversion.bMean}) — no inversion on independent episodes`;
}
writeJ(path.join(API, 'eval-independence.json'), {
  ts: Date.now(), updatedAt: new Date().toISOString(),
  method: 'episode cluster = same asset+direction evals <24h apart (overlapping outcome windows); episode outcome = first eval fwd24h; grade = strongest member',
  totals: { rawEvals: labeled.length, episodes: episodes.length, effectiveN: episodes.length, compressionPct: +(100 * (1 - episodes.length / Math.max(labeled.length, 1))).toFixed(1), avgClusterSize: +(labeled.length / Math.max(episodes.length, 1)).toFixed(2) },
  byGrade: grades, inversion, holdout,
  caveat: 'episodes on different assets in the same window still share market beta — true independent N is lower still. This is the conservative ceiling on effective sample size.',
});

// ---------- edge attribution (Q1): which components predict after costs ----------
const attr = { ts: Date.now(), updatedAt: new Date().toISOString(), costModelPct: COST_PCT * 100 };

// per-strategy expectancy on episodes
attr.byStrategy = {};
for (const s of [...new Set(episodes.map((e) => e.strategy).filter(Boolean))]) {
  const eps = episodes.filter((e) => e.strategy === s);
  const fws = eps.map((e) => dirSign(e) * e.fwd24h);
  attr.byStrategy[s] = { episodes: eps.length, meanDirFwd24h: tCI(fws), netAfterCost: fws.length ? +(mean(fws) - COST_PCT * 100).toFixed(5) : null, hitRate: wilson(fws.filter((x) => x > 0).length, eps.length) };
}

// per-confluence-tag: present vs absent (does the tag add value?)
attr.byConfluence = {};
const tags = new Set();
for (const r of labeled) for (const c of r.confl || []) tags.add(c.k);
for (const tag of tags) {
  const withTag = episodes.filter((e) => e.members[0].confl?.some((c) => c.k === tag));
  const without = episodes.filter((e) => !e.members[0].confl?.some((c) => c.k === tag));
  const fw = (eps) => eps.map((e) => dirSign(e) * e.fwd24h);
  const w = fw(withTag), wo = fw(without);
  attr.byConfluence[tag] = {
    withTag: { n: w.length, meanDirFwd24h: tCI(w).mean },
    without: { n: wo.length, meanDirFwd24h: tCI(wo).mean },
    lift: w.length && wo.length ? +(tCI(w).mean - tCI(wo).mean).toFixed(5) : null,
  };
}

// score calibration — does higher score = higher fwd? (the IC Will keeps asking about)
const scEps = episodes.filter((e) => e.score != null);
attr.scoreIC24h = spearman(scEps.map((e) => e.score), scEps.map((e) => dirSign(e) * e.fwd24h));
attr.scoreIC4h = spearman(scEps.map((e) => e.score), scEps.map((e) => (e.fwd4h != null ? dirSign(e) * e.fwd4h : null)).map((x, i) => x == null ? 0 : x));
// score deciles — monotone or noise?
const sorted = [...scEps].sort((a, b) => a.score - b.score);
attr.scoreDeciles = Array.from({ length: 10 }, (_, i) => {
  const bin = sorted.slice(Math.floor(i * sorted.length / 10), Math.floor((i + 1) * sorted.length / 10));
  const fws = bin.map((e) => dirSign(e) * e.fwd24h);
  return { decile: i + 1, scoreRange: [bin[0]?.score, bin[bin.length - 1]?.score], n: bin.length, meanDirFwd24h: tCI(fws).mean, hitRate: bin.length ? +(fws.filter((x) => x > 0).length / bin.length).toFixed(3) : null };
});
// feature columns present on records
for (const f of ['rsi', 'volRatio', 'momScore', 'boardRank']) {
  const ok = episodes.filter((e) => e.members[0][f] != null);
  attr[`ic_${f}`] = spearman(ok.map((e) => e.members[0][f]), ok.map((e) => dirSign(e) * e.fwd24h));
}
attr.verdict = 'positive netAfterCost + non-overlapping positive CI = independently predictive; negative/zero = contributes nothing after costs';
writeJ(path.join(API, 'edge-attribution.json'), attr);
console.log(`eval-forensics: ${labeled.length} evals → ${episodes.length} episodes (${(100 * (1 - episodes.length / labeled.length)).toFixed(0)}% redundant) | grades ${Object.keys(grades).join(',')} | A-vs-B: ${inversion.verdict || 'n/a'}`);
