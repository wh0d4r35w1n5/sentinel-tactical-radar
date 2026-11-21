// pattern-tag.mjs v2 — Bulkowski-grade pattern classifier.
// Full OHLCV input, swing-point detection, measured-move target + structural
// invalidation per pattern (the two numbers that actually matter for a seat),
// optional volume confirmation and higher-TF trend alignment.
//
// classifyPattern(rows, opts) where rows = [{h,l,c,v}]  ->  {
//   tag, conf, prior, target, invalidate, note, mtf
// }
// tag: machine tag for the episode board | prior: published base rate
// target: measured-move objective | invalidate: structural stop level.

const PCT = (a, b) => (b ? ((a - b) / b) * 100 : 0);

// swing highs/lows over a +/- k bar window — structure, not smoothing.
function swings(rows, k = 3) {
  const pts = [];
  for (let i = k; i < rows.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (rows[i].h < rows[i - j].h || rows[i].h < rows[i + j].h) isH = false;
      if (rows[i].l > rows[i - j].l || rows[i].l > rows[i + j].l) isL = false;
    }
    if (isH) pts.push({ i, px: rows[i].h, t: 'H' });
    if (isL) pts.push({ i, px: rows[i].l, t: 'L' });
  }
  return pts;
}

const volConfirm = (rows, win = 6) => {
  const vs = rows.map(r => r.v || 0).filter(v => v > 0);
  if (vs.length < win * 2) return null;
  const recent = vs.slice(-win).reduce((a, b) => a + b) / win;
  const prior = vs.slice(-win * 2, -win).reduce((a, b) => a + b) / win;
  return prior > 0 ? recent / prior : null;
};

// Published Bulkowski base rates (bull market, upward breakouts).
export const PRIOR = {
  'b-flag': 0.64, 'b-pennant': 0.55, 'b-dtb': 0.67, 'b-rect-up': 0.56,
  'b-tri-asc': 0.63, 'b-inv-hs': 0.65, 'b-cup': 0.68, 'b-wedge-up': 0.52,
  'b-run-up': 0.50, 'sector-play': null, 'signal-conflu': null, 'clone-mom': 0.575,
};

export function classifyPattern(rows, { htfTrend = null } = {}) {
  const bad = { tag: 'clone-mom', conf: 0.3, prior: PRIOR['clone-mom'], target: null, invalidate: null, note: 'no clean pattern' };
  if (!Array.isArray(rows) || rows.length < 26) return { ...bad, note: 'insufficient bars' };
  const n = rows.length;
  const last = rows[n - 1].c;
  const sw = swings(rows, 3);
  const swH = sw.filter(p => p.t === 'H'), swL = sw.filter(p => p.t === 'L');
  const vConf = volConfirm(rows);
  const vTxt = vConf == null ? '' : vConf >= 1.3 ? ' +vol' : vConf <= 0.7 ? ' -vol' : '';
  const boost = (c, why) => Math.min(0.95, c + (vConf >= 1.3 ? 0.05 : 0) + (htfTrend === 'up' ? 0.05 : 0));
  const range = (a, b) => Math.max(...a) - Math.min(...b);
  const mk = (tag, conf, target, invalidate, note) =>
    ({ tag, conf: +conf.toFixed(2), prior: PRIOR[tag], target: +target.toFixed(6), invalidate: +invalidate.toFixed(6), note: note + vTxt, mtf: htfTrend });

  // ---- BULL FLAG: pole (>4% in <=8 bars) + tight flag in upper third ----
  const i8 = Math.max(0, n - 9);
  const poleBase = Math.min(...rows.slice(Math.max(0, n - 24), i8 + 1).map(r => r.l));
  const poleTop = Math.max(...rows.slice(i8, n).map(r => r.h));
  const polePct = PCT(poleTop, poleBase);
  const flagRows = rows.slice(-6);
  const flagR = PCT(Math.max(...flagRows.map(r => r.h)), Math.min(...flagRows.map(r => r.l)));
  if (polePct > 4 && flagR < polePct * 0.4 && last > poleBase + (poleTop - poleBase) * 0.66) {
    const flagLo = Math.min(...flagRows.map(r => r.l));
    return mk('b-flag', boost(0.8), last + poleTop - poleBase, flagLo,
      `pole +${polePct.toFixed(1)}% then ${flagR.toFixed(1)}% flag — target= pole replay, stop= flag base ${flagLo.toFixed(4)}`);
  }

  // ---- PENNANT: pole + converging apex ----
  const r6 = range(rows.slice(-6).map(r => r.h), rows.slice(-6).map(r => r.l));
  const r12 = range(rows.slice(-12, -6).map(r => r.h), rows.slice(-12, -6).map(r => r.l));
  if (polePct > 3 && r6 < r12 * 0.6 && last > poleBase + (poleTop - poleBase) * 0.5) {
    const apexLo = Math.min(...flagRows.map(r => r.l));
    return mk('b-pennant', boost(0.7), last + (poleTop - poleBase) * 0.8, apexLo,
      `converging apex on +${polePct.toFixed(1)}% pole — target= 0.8x pole`);
  }

  // ---- DOUBLE BOTTOM: two swing lows within 2%, neckline broken ----
  if (swL.length >= 2 && swH.length >= 1) {
    const l1 = swL[swL.length - 2], l2 = swL[swL.length - 1];
    if (l2.i - l1.i >= 4 && Math.abs(l2.px - l1.px) / l1.px < 0.02) {
      const neck = Math.max(...swH.filter(p => p.i > l1.i && p.i < l2.i).map(p => p.px), -1);
      if (neck > 0 && last > neck) {
        const depth = PCT(neck, Math.min(l1.px, l2.px));
        return mk('b-dtb', boost(0.75), neck * (1 + depth / 100), Math.min(l1.px, l2.px),
          `double bottom ${l1.px.toFixed(4)}/${l2.px.toFixed(4)} broke neck ${neck.toFixed(4)} — target= neck+depth (+${depth.toFixed(1)}%)`);
      }
    }
  }

  // ---- INVERSE HEAD & SHOULDERS: L shoulder > head < R shoulder, neck broken ----
  if (swL.length >= 3 && swH.length >= 2) {
    const [a, h, b] = swL.slice(-3);
    if (h.px < a.px && h.px < b.px && Math.abs(a.px - b.px) / a.px < 0.03 && b.i - a.i >= 6) {
      const nk = Math.max(...swH.filter(p => p.i > a.i).map(p => p.px), -1);
      if (nk > 0 && last > nk) {
        const depth = PCT(nk, h.px);
        return mk('b-inv-hs', boost(0.78), nk * (1 + depth / 100), b.px,
          `inv H&S head ${h.px.toFixed(4)} shoulders ${a.px.toFixed(4)}/${b.px.toFixed(4)} broke neck ${nk.toFixed(4)} — target +${depth.toFixed(1)}%`);
      }
    }
  }

  // ---- ASCENDING TRIANGLE: flat top + rising lows ----
  if (swH.length >= 2 && swL.length >= 2) {
    const hs = swH.slice(-2), ls = swL.slice(-2);
    const flatTop = Math.abs(hs[1].px - hs[0].px) / hs[0].px < 0.015;
    const rising = ls[1].px > ls[0].px * 1.005;
    if (flatTop && rising && last > hs[1].px * 0.998) {
      const height = PCT(hs[1].px, Math.min(...ls.map(p => p.px)));
      return mk('b-tri-asc', boost(0.72), hs[1].px * (1 + height / 100), ls[1].px,
        `asc triangle — flat top ${hs[1].px.toFixed(4)} + rising lows — target +${height.toFixed(1)}%`);
    }
  }

  // ---- CUP & HANDLE: rounded base (~U) + shallow handle dip near rim ----
  const hi24 = Math.max(...rows.slice(-24).map(r => r.h));
  const lo24 = Math.min(...rows.slice(-24).map(r => r.l));
  const rimL = rows.slice(-24, -14), cupBot = rows.slice(-14, -8), rimR = rows.slice(-8);
  if (rimL.length && cupBot.length && rimR.length) {
    const rL = Math.max(...rimL.map(r => r.c)), rR = Math.max(...rimR.map(r => r.c));
    const bot = Math.min(...cupBot.map(r => r.l));
    const uShape = bot < rL * 0.97 && bot < rR * 0.97 && Math.abs(rL - rR) / rL < 0.03;
    const handle = rows.slice(-4);
    const handleDip = PCT(Math.max(...handle.map(r => r.h)), last);
    if (uShape && handleDip > 0.2 && handleDip < 4 && last > bot * 1.02 && last > rL * 0.98) {
      const depth = PCT(Math.max(rL, rR), bot);
      return mk('b-cup', boost(0.7), Math.max(rL, rR) * (1 + depth / 100), bot,
        `cup+handle depth ${depth.toFixed(1)}% handle ${handleDip.toFixed(1)}% — target= rim+depth`);
    }
  }

  // ---- RECTANGLE: tight 24-bar range, top-break ----
  const rectPct = PCT(hi24, lo24);
  if (rectPct < 3.5 && last >= hi24 * 0.998)
    return mk('b-rect-up', boost(0.68), last + (hi24 - lo24), lo24,
      `rect breakout of ${rectPct.toFixed(1)}% box — target= box height`);

  // ---- extended RUN-UP: >8% in 24 bars, no structure ----
  const ch24 = PCT(last, rows[n - 24].c);
  if (ch24 > 8)
    return { tag: 'b-run-up', conf: 0.4, prior: PRIOR['b-run-up'], target: null,
      invalidate: null, note: `extended +${ch24.toFixed(1)}%/24bar — no pattern, coin-flip class`, mtf: htfTrend };

  return { ...bad, mtf: htfTrend };
}

// CLI: node pattern-tag.mjs SYMBOL — pulls 15m OHLCV, prints full verdict.
if (process.argv[2]) {
  const s = process.argv[2];
  const r = await fetch(`https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${s}&productType=USDT-FUTURES&granularity=15m&limit=40`);
  const k = (await r.json()).data || [];
  const rows = k.map(x => ({ h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).reverse();
  console.log(s, JSON.stringify(classifyPattern(rows), null, 0));
}

// ---- v3 vendor-alpha extensions: SMC concepts (extracted methodologies,
// not code — order blocks, sweeps, FVGs, structure breaks, premium/discount).
// These compose with the pattern tag: a pattern that fires in discount with
// a fresh BOS + swept liquidity is a materially different trade than the
// same shape without context.

// equalHighs/equalLows: clustered swing points within tol% — the liquidity pools
export function liquidityPools(rows, tolPct = 0.4, minTouch = 2) {
  const sw = [];
  const n = rows.length;
  for (let i = 3; i < n - 3; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= 3; j++) {
      if (rows[i].h < rows[i - j].h || rows[i].h < rows[i + j].h) isH = false;
      if (rows[i].l > rows[i - j].l || rows[i].l > rows[i + j].l) isL = false;
    }
    if (isH) sw.push({ i, px: rows[i].h, t: 'H' });
    if (isL) sw.push({ i, px: rows[i].l, t: 'L' });
  }
  const pools = [];
  for (const t of ['H', 'L']) {
    const pts = sw.filter(p => p.t === t).map(p => p.px).sort((a, b) => a - b);
    for (let i = 0; i < pts.length; i++) {
      const cluster = pts.filter(px => Math.abs(px - pts[i]) / pts[i] * 100 < tolPct);
      if (cluster.length >= minTouch) pools.push({ side: t, px: cluster.reduce((a, b) => a + b) / cluster.length, touches: cluster.length });
      i += cluster.length - 1;
    }
  }
  return pools;
}

// sweepCheck: did the last few bars wick through a pool and close back inside?
// longs want a swept LOW pool (buy side liquidity grabbed then reclaimed).
export function sweepCheck(rows, pools, lookback = 6) {
  const recent = rows.slice(-lookback);
  for (const p of pools) {
    if (p.side === 'L') {
      const swept = recent.some(r => r.l < p.px * 0.998);
      const reclaimed = rows[rows.length - 1].c > p.px;
      if (swept && reclaimed) return { swept: 'lows', px: p.px, score: p.touches };
    }
    if (p.side === 'H') {
      const swept = recent.some(r => r.h > p.px * 1.002);
      const rejected = rows[rows.length - 1].c < p.px;
      if (swept && rejected) return { swept: 'highs-bearish', px: p.px, score: p.touches };
    }
  }
  return null;
}

// fairValueGaps: 3-candle imbalance — bull FVG = bar[i-1].h < bar[i+1].l
export function fairValueGaps(rows, lookback = 20) {
  const gaps = [];
  const start = Math.max(1, rows.length - lookback);
  for (let i = start; i < rows.length - 1; i++) {
    if (rows[i - 1].h < rows[i + 1].l) gaps.push({ type: 'bull', lo: rows[i - 1].h, hi: rows[i + 1].l, i });
    if (rows[i - 1].l > rows[i + 1].h) gaps.push({ type: 'bear', lo: rows[i + 1].h, hi: rows[i - 1].l, i });
  }
  const last = rows[rows.length - 1].c;
  return gaps.map(g => ({ ...g, filled: g.type === 'bull' ? last < g.lo : last > g.hi })).filter(g => !g.filled);
}

// marketStructure: last BOS direction — close beyond the prior swing extreme
export function marketStructure(rows, win = 12) {
  const seg = rows.slice(-win);
  const priorH = Math.max(...seg.slice(0, -4).map(r => r.h));
  const priorL = Math.min(...seg.slice(0, -4).map(r => r.l));
  const last = rows[rows.length - 1].c;
  if (last > priorH) return { bos: 'bull', level: priorH };
  if (last < priorL) return { bos: 'bear', level: priorL };
  return { bos: null };
}

// premiumDiscount: where in the range does price sit? longs only below 50%.
export function premiumDiscount(rows, win = 24) {
  const seg = rows.slice(-win);
  const hi = Math.max(...seg.map(r => r.h)), lo = Math.min(...seg.map(r => r.l));
  const last = rows[rows.length - 1].c;
  const pos = hi > lo ? (last - lo) / (hi - lo) : 0.5;
  return { zone: pos < 0.382 ? 'discount' : pos > 0.618 ? 'premium' : 'equilibrium', pos: +pos.toFixed(2) };
}

// squeeze: BB inside KC — compression = stored volatility
export function squeezeCheck(rows, len = 20) {
  const cl = rows.slice(-len).map(r => r.c);
  if (cl.length < len) return null;
  const m = cl.reduce((a, b) => a + b) / len;
  const sd = Math.sqrt(cl.reduce((a, b) => a + (b - m) ** 2, 0) / len);
  const bb = sd * 2;
  let tr = 0;
  for (let i = cl.length - len + 1; i < cl.length; i++) {
    const r = rows[rows.length - len + i], p = rows[rows.length - len + i - 1];
    tr += Math.max(r.h - r.l, Math.abs(r.h - p.c), Math.abs(r.l - p.c));
  }
  const kc = (tr / (len - 1)) * 1.5;
  const on = bb < kc;
  return { on, mom: PCT(cl[cl.length - 1], m), note: on ? 'squeeze ON — stored vol' : 'released' };
}

// contextScore: compose the SMC layer into a deploy-context verdict for a long.
export function smcContext(rows) {
  const pools = liquidityPools(rows);
  const sweep = sweepCheck(rows, pools);
  const fvg = fairValueGaps(rows);
  const ms = marketStructure(rows);
  const pd = premiumDiscount(rows);
  const sq = squeezeCheck(rows);
  let score = 0;
  const notes = [];
  if (sweep?.swept === 'lows') { score += 3; notes.push(`swept lows @${sweep.px.toFixed(4)} (${sweep.score}t)`); }
  if (sweep?.swept === 'highs-bearish') { score -= 3; notes.push(`highs swept & rejected — bearish`); }
  if (ms.bos === 'bull') { score += 2; notes.push(`BOS above ${ms.level.toFixed(4)}`); }
  if (ms.bos === 'bear') { score -= 2; notes.push(`BOS below ${ms.level.toFixed(4)}`); }
  if (pd.zone === 'discount') { score += 1; notes.push(`discount ${(pd.pos * 100).toFixed(0)}%`); }
  if (pd.zone === 'premium') { score -= 2; notes.push(`premium ${(pd.pos * 100).toFixed(0)}% — late entry`); }
  const openFvg = fvg.filter(g => g.type === 'bull' && rows[rows.length - 1].c > g.hi);
  if (openFvg.length) { score += 1; notes.push(`bull FVG ${openFvg.at(-1).lo.toFixed(4)}-${openFvg.at(-1).hi.toFixed(4)}`); }
  if (sq?.on) { score += 1; notes.push(`squeeze mom ${sq.mom > 0 ? '+' : ''}${sq.mom.toFixed(1)}%`); }
  return { score, notes, ms, pd, sweep, fvgCount: fvg.length, sq };
}
