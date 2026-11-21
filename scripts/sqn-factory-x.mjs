// SQN Factory X — expansion pass (2026-11-12, team directive: grow the high-SQN
// cell database + opportunity flow). Experimental sibling of sqn-factory.mjs —
// writes state/sqn-factory-x.json, never touches production outputs.
//
// New trigger families beyond the base factory:
//   volreg-*   volatility-regime gated momentum/mean-reversion (ATR% percentile)
//   rs-*       cross-sectional relative strength vs universe median (chg20)
//   ddhigh-*   distance-from-90d-high structure plays
//   voldiv-*   volume/price divergence fades
//   nr-*       range-compression expansion plays
//   sess-*     UTC session momentum/fade (4H bars only — hour-of-day edge)
// New exits: atr-trail{k} — peak-close trailing stop k*ATR14, max 10 bars.
// Grading identical honesty: net of 0.12% fees, shrunk SQN, dirN>=15 days.
import fs from 'fs';
import path from 'path';
const STATE = '/opt/sentinel/state';
const FEE = 0.12;
const MIN_N = 15, MIN_SQ = 0.5;

const D = JSON.parse(fs.readFileSync(path.join(STATE, 'klines-1D.json'), 'utf8'));
let H = {};
try { H = JSON.parse(fs.readFileSync(path.join(STATE, 'klines-4H.json'), 'utf8')); } catch {}

const syms = Object.keys(D).filter((k) => Array.isArray(D[k]?.rows) && D[k].rows.length > 60);

// ---------- per-symbol feature rows (daily) ----------
const feats = new Map(); // sym -> [{i,f}]
const atr14 = (rows, i) => {
  if (i < 15) return null;
  let s = 0;
  for (let j = i - 13; j <= i; j++) {
    const r = rows[j], p = rows[j - 1];
    s += Math.max(r.h - r.l, Math.abs(r.h - p.c), Math.abs(r.l - p.c));
  }
  return s / 14;
};
for (const sym of syms) {
  const rows = D[sym].rows, cl = rows.map((r) => r.c);
  const arr = [];
  for (let i = 55; i < rows.length; i++) {
    const r = rows[i];
    const f = {};
    f.c = cl[i];
    f.chg1 = (cl[i] - cl[i - 1]) / cl[i - 1] * 100;
    f.chg3 = i >= 3 ? (cl[i] - cl[i - 3]) / cl[i - 3] * 100 : null;
    f.chg5 = (cl[i] - cl[i - 5]) / cl[i - 5] * 100;
    f.chg10 = i >= 10 ? (cl[i] - cl[i - 10]) / cl[i - 10] * 100 : null;
    f.chg20 = i >= 20 ? (cl[i] - cl[i - 20]) / cl[i - 20] * 100 : null;
    f.dayChg = (cl[i] - r.o) / r.o * 100;
    f.gapPct = i >= 1 ? (r.o - cl[i - 1]) / cl[i - 1] * 100 : null;
    // trend regime: distance from prior-50d mean — regime-aware triggers
    // gate on this instead of polluting cell keys with a regime dimension
    f.sma50dist = (() => { if (i < 50) return null; let s = 0; for (let j = i - 50; j < i; j++) s += cl[j]; const m = s / 50; return m > 0 ? (cl[i] - m) / m * 100 : null; })();
    // consecutive same-sign dayChg streak (signed, capped ±6)
    f.streak = (() => { let n = 0; for (let j = i; j >= Math.max(0, i - 8); j--) { const d = rows[j].c - rows[j].o; const s = d > 0 ? 1 : d < 0 ? -1 : 0; if (s === 0) break; if (n === 0 || Math.sign(n) === s) n += s; else break; } return n; })();
    const mv = (() => { if (i < 20) return null; const v = rows.slice(i - 20, i).map((x) => x.qv).sort((a, b) => a - b); return v[10]; })();
    f.volX = mv ? r.qv / mv : null;
    f.atr = atr14(rows, i);
    f.atrPct = f.atr && cl[i] ? f.atr / cl[i] * 100 : null;
    // 90d high distance
    let hi90 = -1e18; for (let j = Math.max(0, i - 90); j < i; j++) if (rows[j].h > hi90) hi90 = rows[j].h;
    f.ddHigh = hi90 > 0 ? (cl[i] - hi90) / hi90 * 100 : null; // negative = below high
    // range position + compression
    f.rng = r.h > r.l ? (cl[i] - r.l) / (r.h - r.l) : 0.5;
    f.rngSz = r.h > r.l ? (r.h - r.l) / cl[i] * 100 : null;
    f.rngMed = (() => { if (i < 15) return null; const v = []; for (let j = i - 14; j < i; j++) v.push((rows[j].h - rows[j].l) / rows[j].c * 100); v.sort((a, b) => a - b); return v[7]; })();
    // ATR percentile vs trailing 120d
    f.atrPctile = (() => {
      if (i < 120 || !f.atrPct) return null;
      let below = 0, n = 0;
      for (let j = i - 119; j < i; j++) {
        const a = atr14(rows, j); if (!a || !rows[j].c) continue;
        if (a / rows[j].c * 100 < f.atrPct) below++;
        n++;
      }
      return n ? below / n : null;
    })();
    arr.push({ i, f, t: r.t });
  }
  feats.set(sym, arr);
}

// ---------- universe median chg20 per timestamp (RS factor) ----------
const medChg20 = new Map(); // t -> median
{
  const byT = new Map();
  for (const [sym, arr] of feats) for (const { i, f, t } of arr) {
    if (f.chg20 == null) continue;
    if (!byT.has(t)) byT.set(t, []);
    byT.get(t).push(f.chg20);
  }
  for (const [t, v] of byT) { v.sort((a, b) => a - b); medChg20.set(t, v[Math.floor(v.length / 2)]); }
}

// ---------- trigger library X v2 — parameterized grid (2026-11-12 apex
// expansion: ~40 hand-picked triggers -> ~380 grid cells. Every family is
// swept across its meaningful parameter range; regime-aware variants gate
// on sma50dist/streak so trend vs counter-trend plays grade as separate
// cells without changing the cell-key format the deploy pass parses.)
const TRIG = [];
const T = (id, test, side) => TRIG.push({ id, test, side });

// ---- raw momentum sweep: every lookback × threshold × resolution ----
// cont = ride the move, fade = fight it, rev = deep-move reversal
for (const [cn, fld] of [['c3', 'chg3'], ['c5', 'chg5'], ['c10', 'chg10'], ['c20', 'chg20']])
  for (const th of [1, 2, 3, 5, 8]) {
    T(`mom-${cn}${th}-up`, (f) => f[fld] != null && f[fld] > th, 'long');
    T(`mom-${cn}${th}-dn`, (f) => f[fld] != null && f[fld] < -th, 'short');
    T(`mom-${cn}${th}-fade`, (f) => f[fld] != null && f[fld] > th, 'short');
    T(`mom-${cn}${th}-rev`, (f) => f[fld] != null && f[fld] < -th, 'long');
  }

// ---- vol-regime gated grid: ATR%ile × momentum threshold × pattern ----
for (const vp of [0.5, 0.6, 0.7, 0.8]) for (const mt of [3, 5, 8, 12]) {
  const hi = (f) => f.atrPctile != null && f.atrPctile > vp;
  const lo = (f) => f.atrPctile != null && f.atrPctile < 1 - vp;
  T(`volreg-p${vp}-m${mt}-hi-cont`, (f) => hi(f) && f.chg5 != null && f.chg5 > mt, 'long');
  T(`volreg-p${vp}-m${mt}-hi-fade`, (f) => hi(f) && f.chg5 != null && f.chg5 > mt, 'short');
  T(`volreg-p${vp}-m${mt}-lo-dip`, (f) => lo(f) && f.chg5 != null && f.chg5 < -mt, 'long');
  T(`volreg-p${vp}-m${mt}-lo-fade`, (f) => lo(f) && f.chg5 != null && f.chg5 < -mt, 'short');
}

// ---- relative strength vs universe median ----
for (const t of [2, 3, 5, 8, 12]) {
  T(`rs-lead${t}`, (f, med) => f.chg20 != null && med != null && f.chg20 - med > t, 'long');
  T(`rs-lag${t}`, (f, med) => f.chg20 != null && med != null && f.chg20 - med < -t, 'short');
  T(`rs-lead${t}-fade`, (f, med) => f.chg20 != null && med != null && f.chg20 - med > t, 'short');
  T(`rs-lag${t}-rev`, (f, med) => f.chg20 != null && med != null && f.chg20 - med < -t, 'long');
}

// ---- distance-from-90d-high structure ----
for (const t of [1, 2, 3, 5, 8, 12, 20]) {
  T(`ddhi${t}-pull`, (f) => f.ddHigh != null && f.ddHigh > -t && f.chg5 != null && f.chg5 < 0, 'long');
  T(`ddhi${t}-disc`, (f) => f.ddHigh != null && f.ddHigh < -t && f.chg5 != null && f.chg5 > 0, 'long');
  T(`ddhi${t}-disc-fade`, (f) => f.ddHigh != null && f.ddHigh < -t && f.chg5 != null && f.chg5 > 0, 'short');
  T(`ddhi${t}-newlow`, (f) => f.ddHigh != null && f.ddHigh < -t && f.chg5 != null && f.chg5 < 0, 'short');
}

// ---- volume/price divergence grid ----
for (const dc of [0.5, 1, 2]) for (const vx of [0.5, 0.7, 0.9, 1.2, 1.5, 2.0]) {
  T(`voldiv-u${dc}-v${vx}-fade`, (f) => f.dayChg > dc && f.volX != null && f.volX < vx, 'short');
  T(`voldiv-d${dc}-v${vx}-bnc`, (f) => f.dayChg < -dc && f.volX != null && f.volX > vx, 'long');
  T(`voldiv-d${dc}-v${vx}-cont`, (f) => f.dayChg < -dc && f.volX != null && f.volX > vx, 'short');
}

// ---- range compression -> expansion ----
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  T(`nr-comp${t}-up`, (f) => f.rngSz != null && f.rngMed != null && f.rngSz < t * f.rngMed && f.chg5 != null && f.chg5 > 0, 'long');
  T(`nr-comp${t}-dn`, (f) => f.rngSz != null && f.rngMed != null && f.rngSz < t * f.rngMed && f.chg5 != null && f.chg5 < 0, 'short');
  T(`nr-comp${t}-up-fade`, (f) => f.rngSz != null && f.rngMed != null && f.rngSz < t * f.rngMed && f.chg5 != null && f.chg5 > 0, 'short');
  T(`nr-comp${t}-dn-bnc`, (f) => f.rngSz != null && f.rngMed != null && f.rngSz < t * f.rngMed && f.chg5 != null && f.chg5 < 0, 'long');
}

// ---- gap plays: open vs prior close ----
for (const g of [1, 2, 3, 5]) {
  T(`gap${g}-fade`, (f) => f.gapPct != null && f.gapPct > g, 'short');
  T(`gap${g}-gapdn-bnc`, (f) => f.gapPct != null && f.gapPct < -g, 'long');
  T(`gap${g}-gapdn-cont`, (f) => f.gapPct != null && f.gapPct < -g, 'short');
  T(`gap${g}-gapup-cont`, (f) => f.gapPct != null && f.gapPct > g && f.dayChg > 0, 'long');
}

// ---- streak exhaustion / continuation ----
for (const n of [2, 3, 4]) {
  T(`streak${n}-rev`, (f) => f.streak >= n, 'short');
  T(`streak${n}-dnbnc`, (f) => f.streak <= -n, 'long');
  T(`streak${n}-dncont`, (f) => f.streak <= -n && f.chg5 != null && f.chg5 < -2, 'short');
  T(`streak${n}-upcont`, (f) => f.streak >= n && f.chg5 != null && f.chg5 > 2, 'long');
}

// ---- sma50 regime plays: pullback-in-trend / breakdown-fade ----
for (const d of [1, 2, 4, 6, 10]) {
  T(`sma50-d${d}-pull-bnc`, (f) => f.sma50dist != null && f.sma50dist > -d && f.sma50dist < d && f.chg5 != null && f.chg5 < 0, 'long');
  T(`sma50-d${d}-break-fade`, (f) => f.sma50dist != null && f.sma50dist < -d && f.chg5 != null && f.chg5 > 0, 'short');
  T(`sma50-d${d}-above-mom`, (f) => f.sma50dist != null && f.sma50dist > d && f.chg5 != null && f.chg5 > 1, 'long');
  T(`sma50-d${d}-below-mom`, (f) => f.sma50dist != null && f.sma50dist < -d && f.chg5 != null && f.chg5 < -1, 'short');
}

// ---- intraday range-position plays (where close sits in the day's range) ----
for (const rp of [0.2, 0.35, 0.65, 0.8]) {
  T(`rngpos${rp}-close-weak`, (f) => f.rng != null && f.rng < rp && f.dayChg > -3, 'short');
  T(`rngpos${rp}-close-strong`, (f) => f.rng != null && f.rng > 1 - rp && f.dayChg < 3, 'long');
}

// ---- session triggers (4H) — UTC buckets, threshold sweep ----
const SESS = { asia: [0, 7], lon: [8, 12], ny: [13, 20], late: [21, 23] };
for (const [nm, [h0, h1]] of Object.entries(SESS)) for (const st of [1, 1.5, 2.5]) {
  const inS = (f) => f.hour >= h0 && f.hour <= h1;
  T(`sess-${nm}-m${st}-mom-cont`, (f) => inS(f) && f.chg3 != null && f.chg3 > st, 'long');
  T(`sess-${nm}-m${st}-mom-fade`, (f) => inS(f) && f.chg3 != null && f.chg3 > st, 'short');
  T(`sess-${nm}-m${st}-dip-bnc`, (f) => inS(f) && f.chg3 != null && f.chg3 < -st, 'long');
  T(`sess-${nm}-m${st}-dip-cont`, (f) => inS(f) && f.chg3 != null && f.chg3 < -st, 'short');
}

// ---------- exit library X v2 — swept grids ----------
const EXITS = [];
for (const h of [1, 2, 3, 5, 8, 10, 15, 20]) EXITS.push({ id: 'h' + h, run: (rows, i, sgn) => (rows[i + h] ? sgn * ((rows[i + h].c - rows[i].c) / rows[i].c) * 100 - FEE : null) });
for (const tp of [1, 1.5, 2, 3, 4, 6, 8, 12]) for (const sl of [0.75, 1, 1.5, 2, 3, 4, 6]) EXITS.push({
  id: 'tp' + tp + '-sl' + sl,
  run: (rows, i, sgn) => {
    const tPx = rows[i].c * (1 + sgn * tp / 100), sPx = rows[i].c * (1 - sgn * sl / 100);
    for (let j = i + 1; j < Math.min(rows.length, i + 16); j++) {
      const b = rows[j];
      if (sgn > 0 ? b.l <= sPx : b.h >= sPx) return -sl - FEE;
      if (sgn > 0 ? b.h >= tPx : b.l <= tPx) return tp - FEE;
    }
    return rows[i + 15] ? sgn * ((rows[i + 15].c - rows[i].c) / rows[i].c) * 100 - FEE : null;
  },
});
// ATR trailing exits — matches live K2 geometry
const trailAtr = (rows, i, sgn, k, maxB = 10) => {
  if (i + 1 >= rows.length) return null;
  let peak = rows[i].c, exit = null, held = 0;
  for (let j = i + 1; j < Math.min(rows.length, i + 1 + maxB); j++) {
    held++;
    const a = atr14(rows, j - 1) || atr14(rows, i);
    if (!a) continue;
    if (sgn > 0 ? rows[j].h > peak : rows[j].l < peak) peak = sgn > 0 ? rows[j].h : rows[j].l;
    const stop = peak - sgn * k * a;
    const hit = sgn > 0 ? rows[j].l <= stop : rows[j].h >= stop;
    if (hit) { exit = sgn * ((stop - rows[i].c) / rows[i].c) * 100 - FEE; break; }
  }
  if (exit == null) {
    const j = Math.min(rows.length - 1, i + maxB);
    exit = sgn * ((rows[j].c - rows[i].c) / rows[i].c) * 100 - FEE;
  }
  return exit;
};
for (const k of [1, 1.5, 2, 3, 4, 6]) EXITS.push({ id: 'atr' + k, run: (rows, i, sgn) => trailAtr(rows, i, sgn, k) });

// ---------- grading ----------
// O(1)-memory cells (2026-11-12 apex fix): the v2 grid produces ~70M
// trigger×exit samples — storing raw rets arrays OOM'd node at ~900MB.
// Running stats (n/sum/sumsq/wins) + a day-bucket set carry identical
// SQN/WR/dirN information in bounded memory per cell.
const cells = new Map();
const bump = (key, ret, day) => {
  let c = cells.get(key);
  if (!c) cells.set(key, c = { n: 0, sum: 0, sumsq: 0, wins: 0, days: new Set() });
  c.n++; c.sum += ret; c.sumsq += ret * ret; if (ret > 0) c.wins++;
  c.days.add(Math.floor(day / 86400000));
};

// live-signal capture: which promoted-eligible triggers fire on each symbol's
// LATEST bar — deploy pass consumes this instead of re-deriving features.
const lastSignals = []; // {sym, tf, cellBase, side, px, t}
const isLast = (rows, i) => i === rows.length - 1;

let totalBars = 0;
// daily pass
for (const [sym, arr] of feats) {
  const rows = D[sym].rows; totalBars += rows.length;
  const lastI = rows.length - 1;
  for (const { i, f, t } of arr) {
    const med = medChg20.get(t);
    const last = i === lastI;
    for (const tr of TRIG) {
      if (tr.id.startsWith('sess-')) continue; // session triggers are 4H-only
      let ok = false;
      try { ok = tr.test(f, med); } catch { continue; }
      if (!ok) continue;
      if (last) lastSignals.push({ sym, tf: '1D', trig: tr.id, side: tr.side, px: rows[i].c, t: rows[i].t });
      for (const ex of EXITS) {
        const ret = ex.run(rows, i, tr.side === 'long' ? 1 : -1);
        if (ret != null) bump('x:' + tr.id + ':' + ex.id + ':' + tr.side, ret, rows[i].t);
      }
    }
  }
}
// 4H pass — session triggers + 4H-native momentum/mean-rev grid. The 4H
// timeframe is where intraday structure lives; it was previously limited
// to session buckets only. Cells key 'x4h:<trig>:<exit>:<side>' — the
// deploy regex already parses the x4h prefix.
const TRIG4H = [];
const T4 = (id, test, side) => TRIG4H.push({ id, test, side });
for (const [cn, fld] of [['h3', 'chg3'], ['h6', 'chg6'], ['h12', 'chg12'], ['h30', 'chg30']])
  for (const th of [1, 2, 3, 5]) {
    T4(`h4-${cn}${th}-up`, (f) => f[fld] != null && f[fld] > th, 'long');
    T4(`h4-${cn}${th}-dn`, (f) => f[fld] != null && f[fld] < -th, 'short');
    T4(`h4-${cn}${th}-fade`, (f) => f[fld] != null && f[fld] > th, 'short');
    T4(`h4-${cn}${th}-rev`, (f) => f[fld] != null && f[fld] < -th, 'long');
  }
for (const vx of [0.6, 0.8, 1.3, 1.8]) {
  T4(`h4-volx${vx}-upfade`, (f) => f.dayChg > 0.5 && f.volX != null && f.volX < vx, 'short');
  T4(`h4-volx${vx}-dnbnc`, (f) => f.dayChg < -0.5 && f.volX != null && f.volX > vx, 'long');
  T4(`h4-volx${vx}-dncont`, (f) => f.dayChg < -0.5 && f.volX != null && f.volX > vx, 'short');
}
for (const g of [1, 2, 3]) {
  T4(`h4-gap${g}-fade`, (f) => f.gapPct != null && f.gapPct > g, 'short');
  T4(`h4-gap${g}-bnc`, (f) => f.gapPct != null && f.gapPct < -g, 'long');
}
const hSyms = Object.keys(H).filter((k) => Array.isArray(H[k]?.rows) && H[k].rows.length > 60);
for (const sym of hSyms) {
  const rows = H[sym].rows; totalBars += rows.length;
  const cl = rows.map((r) => r.c);
  const qv = rows.map((r) => r.qv || 0);
  for (let i = 30; i < rows.length; i++) {
    const r = rows[i];
    const f = { c: cl[i] };
    for (const [cn, n] of [['chg3', 3], ['chg6', 6], ['chg12', 12], ['chg30', 30]])
      f[cn] = i >= n ? (cl[i] - cl[i - n]) / cl[i - n] * 100 : null;
    f.dayChg = (cl[i] - r.o) / r.o * 100;
    f.gapPct = i >= 1 ? (r.o - cl[i - 1]) / cl[i - 1] * 100 : null;
    const mv = (() => { if (i < 30) return null; const v = qv.slice(i - 30, i).filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })();
    f.volX = mv ? r.qv / mv : null;
    f.hour = new Date(r.t).getUTCHours();
    const last = i === rows.length - 1;
    const grade = (tr) => {
      let ok = false;
      try { ok = tr.test(f, null); } catch { return; }
      if (!ok) return;
      if (last) lastSignals.push({ sym, tf: '4H', trig: tr.id, side: tr.side, px: rows[i].c, t: rows[i].t });
      if (last) return; // last bar graded for signals only — no forward exit data
      for (const ex of EXITS) {
        const ret = ex.run(rows, i, tr.side === 'long' ? 1 : -1);
        if (ret != null) bump('x4h:' + tr.id + ':' + ex.id + ':' + tr.side, ret, rows[i].t);
      }
    };
    for (const tr of TRIG) if (tr.id.startsWith('sess-')) grade(tr);
    for (const tr of TRIG4H) grade(tr);
  }
}

const sqnOf = (c) => {
  const n = c.n, dN = c.days.size;
  if (!n) return { n: 0, dirN: 0, wr: 0, meanNetPct: 0, sqn: 0 };
  const mean = c.sum / n;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (c.sumsq - (c.sum * c.sum) / n) / (n - 1))) : 0;
  const eff = Math.min(n, dN * 3);
  const shrunk = sd > 0 ? (mean / sd) * Math.sqrt(eff) : 0;
  return { n, dirN: dN, wr: +(c.wins / n * 100).toFixed(1), meanNetPct: +mean.toFixed(3), sqn: +shrunk.toFixed(2) };
};
const out = { at: new Date().toISOString(), bar: { minN: MIN_N, minSqn: MIN_SQ }, symbols: syms.length, hSymbols: hSyms.length, bars: totalBars, triggers: TRIG.length, exits: EXITS.length, cells: {}, promoted: {}, convicted: {}, lastSignals };
for (const [k, c] of cells) {
  const g = sqnOf(c); out.cells[k] = g;
  if (g.dirN >= MIN_N && g.meanNetPct > 0 && g.sqn >= MIN_SQ) out.promoted[k] = g;
  if (g.dirN >= MIN_N && g.meanNetPct < 0 && g.sqn <= -MIN_SQ) out.convicted[k] = g;
}
fs.writeFileSync(path.join(STATE, 'sqn-factory-x.json'), JSON.stringify(out, null, 1));

// hypotheses feed — same ITIL lane as base factory
try {
  const HYPO = path.join(STATE, 'research-hypotheses.json');
  let hypo = []; try { hypo = JSON.parse(fs.readFileSync(HYPO, 'utf8')); } catch {}
  const seen = new Set(hypo.map((h) => h.id));
  const top = (m) => Object.entries(m).sort((a, b) => Math.abs(b[1].sqn) - Math.abs(a[1].sqn)).slice(0, 25);
  for (const [k, g] of top(out.promoted)) {
    const id = 'FACX-' + k;
    if (seen.has(id)) continue;
    hypo.push({ id, class: 'shadow', source: 'sqn-factory-x',
      title: 'promoted ' + k + ' — sqn ' + g.sqn + ' wr ' + g.wr + '% mean ' + g.meanNetPct + '% n=' + g.n + ' (' + g.dirN + 'd)',
      state: 'submitted', history: [] });
    seen.add(id);
  }
  for (const [k, g] of top(out.convicted)) {
    const id = 'FACXX-' + k;
    if (seen.has(id)) continue;
    hypo.push({ id, class: 'shadow', source: 'sqn-factory-x',
      title: 'convicted ' + k + ' — sqn ' + g.sqn + ' wr ' + g.wr + '% mean ' + g.meanNetPct + '% n=' + g.n + ' — measured loser, stands down',
      state: 'submitted', history: [] });
    seen.add(id);
  }
  fs.writeFileSync(HYPO, JSON.stringify(hypo, null, 1));
} catch (e) { console.log('hypo feed err:', e.message); }

const sorted = Object.entries(out.promoted).sort((a, b) => b[1].sqn - a[1].sqn);
console.log('X graded ' + Object.keys(cells).length + ' cells | bars ' + totalBars + ' | promoted ' + sorted.length + ' | convicted ' + Object.keys(out.convicted).length);
for (const [k, g] of sorted.slice(0, 20)) console.log(' PROMOTED', k, JSON.stringify(g));
