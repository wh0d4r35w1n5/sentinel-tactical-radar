// Signal fusion — the HFT-desk signal-combination stack (the framework the
// viral Stanford paper formalizes). Four steps, exactly as desks run them:
//
//   1. SERIAL DEMEANING   — each score component minus its rolling EMA.
//      A component whose structural mean drifts hot (volume scores in a
//      volume tape, funding in a carry tape) stops dominating the blend;
//      only the SURPRISE relative to its own history carries signal.
//   2. CROSS-SECTIONAL Z  — every component z-scored across the board each
//      cycle. Ranks beat raw units: a +3 funding nudge in a quiet book can
//      outrank a +3 sigma volume print in a mania book.
//   3. RESIDUAL WEIGHTING — ridge regression of the emitted z-map onto
//      realized alpha24h, penalized toward hand priors (Bayesian ridge:
//      solve (X'X + λI)w = X'y + λ·prior). Each component earns only its
//      MARGINAL contribution net of correlated components — the multi-count
//      problem (mom/vol/surg all reading the same move) dies here.
//   4. EMPIRICAL KELLY    — f* = p − q/b on realized R-multiples per
//      strategy, deployed at half-Kelly relative to the book's own f*.
//      Lives in bitget-exec; this module exports the estimator.
//
// Evidence-gated: the blend weight scales n/(n+300) capped at 0.7 — the
// hand-tuned score remains a floor until the fitted weights have depth.

import fs from 'node:fs';
import path from 'node:path';

export const FZ_KEYS = ['mom', 'vol', 'liq', 'surg', 'confl', 'ic', 'strat', 'deriv', 'news', 'mc', 'vip', 'soc', 'fund', 'clim'];

// priors in z-space — direction-signed relative importance. The hand score's
// raw weights (mom .4/vol .25/liq .2/surg .15) map directly; boost terms get
// small positive priors ("context, not trigger"); climax is negative — the
// ledger's forensic finding is that overextended entries bleed.
const PRIOR = {
  mom: 0.40, vol: 0.25, liq: 0.20, surg: 0.15, confl: 0.10, ic: 0.08,
  strat: 0.06, vip: 0.05, deriv: 0.04, news: 0.03, soc: 0.03, fund: 0.03,
  mc: 0.02, clim: -0.06,
};

const EMA_A = 1 / 30;      // ~30-cycle halflife — hours-scale bias tracking
const RIDGE_LAMBDA = 30;   // shrink-to-prior strength
const BLEND_CAP = 0.7;     // fused weight ceiling vs hand score
const TRAIN_CAP = 6000;    // rolling regression rows
const Y_WIN = 8;           // winsorize alpha24h target ±8%

const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

const emaPath = (stateDir) => path.join(stateDir, 'fusion-ema.json');
const wPath = (stateDir) => path.join(stateDir, 'fusion-weights.json');

export function loadWeights(stateDir) {
  const j = readJ(wPath(stateDir), null);
  if (!j || !j.w) return { w: { ...PRIOR }, n: 0, blend: 0, fittedAt: null };
  return j;
}

// fuseBoard(rows, stateDir): rows carry raw component map row.fz; mutates
// row.fusion (the consumed z-map), row.fusedZ, row.fusedScore, row.score
// (blended). Caller re-sorts after. Also advances the component EMA once.
export function fuseBoard(rows, stateDir) {
  const fzRows = rows.filter((r) => r.fz);
  if (!fzRows.length) return null;

  // step 1 — serial demeaning against the rolling EMA
  const emaJ = readJ(emaPath(stateDir), { ema: {}, n: 0 });
  const ema = emaJ.ema || {};
  const dm = fzRows.map((r) => {
    const d = {};
    for (const k of FZ_KEYS) d[k] = (r.fz[k] ?? 0) - (ema[k] ?? 0);
    return d;
  });

  // step 2 — cross-sectional z across this board (per component)
  const xsMean = {}, xsSd = {};
  for (const k of FZ_KEYS) {
    const vs = dm.map((d) => d[k]);
    const m = vs.reduce((a, b) => a + b, 0) / vs.length;
    const sd = Math.sqrt(vs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, vs.length - 1));
    xsMean[k] = m; xsSd[k] = sd || 1e-9;
  }
  const zRows = dm.map((d) => {
    const z = {};
    for (const k of FZ_KEYS) z[k] = Math.max(-4, Math.min(4, (d[k] - xsMean[k]) / xsSd[k]));
    return z;
  });

  // step 3 — residual weights (ridge-fitted, shrunk to prior while thin)
  const { w, n, blend } = loadWeights(stateDir);
  for (let i = 0; i < fzRows.length; i++) {
    const z = zRows[i];
    let fused = 0;
    for (const k of FZ_KEYS) fused += (w[k] ?? PRIOR[k] ?? 0) * z[k];
    fzRows[i].fusion = Object.fromEntries(FZ_KEYS.map((k) => [k, +z[k].toFixed(3)]));
    fzRows[i].fusedZ = +fused.toFixed(3);
    fzRows[i].fusedScore = Math.max(0, Math.min(100, Math.round(50 + fused * 12)));
    if (Number.isFinite(fzRows[i].score))
      fzRows[i].score = Math.round(
        Math.max(0, Math.min(100, fzRows[i].score * (1 - blend) + fzRows[i].fusedScore * blend))
      );
    else fzRows[i].score = fzRows[i].fusedScore;
  }

  // advance the EMA on this board's component means
  for (const k of FZ_KEYS) {
    const m = fzRows.reduce((a, r) => a + (r.fz[k] ?? 0), 0) / fzRows.length;
    ema[k] = (ema[k] ?? m) * (1 - EMA_A) + m * EMA_A;
  }
  writeJ(emaPath(stateDir), { ema, n: (emaJ.n || 0) + 1, updatedAt: new Date().toISOString() });
  return { n, blend, fitted: n > 0 };
}

// harvest complete eval records (hot book + sealed monthly files) that carry
// the emitted fusion z-map and a realized alpha24h — the regression set.
export function harvestRows(evalBook, histDir, cap = TRAIN_CAP) {
  const rows = [];
  const take = (r) => {
    if (!r?.complete || r.alpha24h == null || !r.fusion) return;
    rows.push({ c: r.fusion, a: Math.max(-Y_WIN, Math.min(Y_WIN, +r.alpha24h)) });
  };
  for (const r of evalBook?.records || []) take(r);
  try {
    for (const f of fs.readdirSync(histDir)) {
      if (!/^eval-\d{4}-\d{2}\.json$/.test(f)) continue;
      for (const r of readJ(path.join(histDir, f), {}).records || []) take(r);
    }
  } catch {}
  return rows.slice(-cap);
}

// Bayesian ridge: (X'X + λI) w = X'y + λ·prior — data peels weights off the
// prior only as the sample earns it. 14x14 solve via Gauss-Jordan.
export function fitWeights(rows) {
  if (!rows || rows.length < 40) return null;
  const K = FZ_KEYS.length;
  const XtX = Array.from({ length: K }, () => new Array(K).fill(0));
  const Xty = new Array(K).fill(0);
  for (const r of rows) {
    const x = FZ_KEYS.map((k) => +r.c[k] || 0);
    for (let i = 0; i < K; i++) {
      Xty[i] += x[i] * r.a;
      for (let j = 0; j < K; j++) XtX[i][j] += x[i] * x[j];
    }
  }
  for (let i = 0; i < K; i++) {
    XtX[i][i] += RIDGE_LAMBDA;
    Xty[i] += RIDGE_LAMBDA * (PRIOR[FZ_KEYS[i]] ?? 0);
  }
  // Gauss-Jordan
  for (let i = 0; i < K; i++) {
    let piv = i;
    for (let r = i + 1; r < K; r++) if (Math.abs(XtX[r][i]) > Math.abs(XtX[piv][i])) piv = r;
    [XtX[i], XtX[piv]] = [XtX[piv], XtX[i]];
    [Xty[i], Xty[piv]] = [Xty[piv], Xty[i]];
    const d = XtX[i][i] || 1e-9;
    for (let j = i; j < K; j++) XtX[i][j] /= d;
    Xty[i] /= d;
    for (let r = 0; r < K; r++) {
      if (r === i) continue;
      const f = XtX[r][i];
      for (let j = i; j < K; j++) XtX[r][j] -= f * XtX[i][j];
      Xty[r] -= f * Xty[i];
    }
  }
  const w = Object.fromEntries(FZ_KEYS.map((k, i) => [k, +Xty[i].toFixed(4)]));
  // in-sample R² for the audit trail
  const yMean = rows.reduce((a, r) => a + r.a, 0) / rows.length;
  let ssT = 0, ssR = 0;
  for (const r of rows) {
    const yh = FZ_KEYS.reduce((a, k, i) => a + Xty[i] * (+r.c[k] || 0), 0);
    ssT += (r.a - yMean) ** 2; ssR += (r.a - yh) ** 2;
  }
  const blend = Math.min(BLEND_CAP, rows.length / (rows.length + 300));
  return { w, n: rows.length, r2: ssT > 0 ? +(1 - ssR / ssT).toFixed(4) : null, blend: +blend.toFixed(3), fittedAt: new Date().toISOString() };
}

export function saveWeights(stateDir, fit) {
  if (fit) writeJ(wPath(stateDir), fit);
}

// ---- empirical Kelly (step 4) — consumed by bitget-exec ------------
// f* = p − q/b on a stream of R-multiples (net/risk per position).
export function kellyF(rs) {
  if (!rs || !rs.length) return null;
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  if (!wins.length || !losses.length) return null;
  const p = wins.length / rs.length;
  const avgW = wins.reduce((a, r) => a + r, 0) / wins.length;
  const avgL = Math.abs(losses.reduce((a, r) => a + r, 0) / losses.length);
  const b = avgW / Math.max(0.05, avgL);
  return { n: rs.length, winPct: +(p * 100).toFixed(1), payoff: +b.toFixed(2), fStar: +(p - (1 - p) / b).toFixed(3) };
}
