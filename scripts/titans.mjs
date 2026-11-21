// titans.mjs — the 5 Titans of Technical Analysis as machine factors.
//   DOW      — trend = swing structure (HH/HL up, LH/LL down);
//              volume CONFIRMS the trend (OBV must agree).
//   WYCKOFF  — accumulation events (SC/SPRING/SOS/LPS) vs
//              distribution (BC/SOW/UTAD) inside the trading range.
//   ELLIOTT  — position in the wave count: longs want wave-2/4
//              pullbacks of an impulse-up or a finished 5-down;
//              shorts want a finished 5-up or a live impulse-down.
//   GANN     — the 50% retracement of the major range is the
//              master pivot; trade on the strong side of it.
//   LIVERMORE— the pivotal point + line of least resistance:
//              the path with the least overhead supply wins.
// Every factor is journaled on setups + shadow rows so the ledger
// can attribute expectancy per titan — evidence grades the masters.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STATE = path.join(DIR, '..', 'state');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ---------- shared math ----------
function pivots(rows, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < rows.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (rows[j].h > rows[i].h) isH = false;
      if (rows[j].l < rows[i].l) isL = false;
    }
    if (isH) hi.push({ i, p: rows[i].h });
    if (isL) lo.push({ i, p: rows[i].l });
  }
  return { hi, lo };
}

function zigzag(rows, minLeg) {
  const { hi, lo } = pivots(rows, 2);
  const ev = [...hi.map(e => ({ ...e, t: 'h' })), ...lo.map(e => ({ ...e, t: 'l' }))].sort((a, b) => a.i - b.i);
  const zz = [];
  for (const e of ev) {
    if (!zz.length) { zz.push(e); continue; }
    const l = zz[zz.length - 1];
    if (e.t === l.t) {
      if ((l.t === 'h' && e.p > l.p) || (l.t === 'l' && e.p < l.p)) zz[zz.length - 1] = e;
    } else if (Math.abs(e.p - l.p) >= minLeg) zz.push(e);
    else if ((l.t === 'h' && e.p < l.p - minLeg) || (l.t === 'l' && e.p > l.p + minLeg)) zz.push(e);
  }
  return zz;
}

// klines-15m rows carry `qv` (quote volume), not `v` — reading r.v
// zeroed OBV and every Wyckoff volume test since inception (found
// 2026-10-15: 785/785 symbols qv-only). One accessor, used everywhere.
const vol = (r) => +(r.v ?? r.qv ?? 0);
function obv(rows) {
  const out = new Array(rows.length).fill(0);
  let v = 0;
  for (let i = 1; i < rows.length; i++) {
    const q = vol(rows[i]);
    if (rows[i].c > rows[i - 1].c) v += q; else if (rows[i].c < rows[i - 1].c) v -= q;
    out[i] = v;
  }
  return out;
}

function atr(rows, n = 14) {
  let s = 0; const m = Math.min(n, rows.length - 1);
  for (let i = rows.length - m; i < rows.length; i++) {
    const r = rows[i], pc = rows[i - 1]?.c ?? r.o;
    s += Math.max(r.h - r.l, Math.abs(r.h - pc), Math.abs(r.l - pc));
  }
  return m ? s / m : 0;
}

function regSlope(vals, w) {
  const seg = vals.slice(-w); const n = seg.length;
  if (n < 3) return 0;
  const xm = (n - 1) / 2, ym = seg.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (seg[i] - ym); den += (i - xm) ** 2; }
  return den ? num / den : 0;
}

// ---------- the five masters ----------
// DOW: swing structure + volume agreement
function dowFactors(rows, zz, ob, f) {
  const sameDir = (t) => zz.filter(z => z.t === t).slice(-2);
  const hs = sameDir('h'), ls = sameDir('l');
  if (hs.length === 2 && ls.length === 2) {
    const bull = hs[1].p > hs[0].p && ls[1].p > ls[0].p;   // HH + HL
    const bear = hs[1].p < hs[0].p && ls[1].p < ls[0].p;   // LH + LL
    f.dowBull = bull; f.dowBear = bear;
  }
  const sl = regSlope(ob, 48);
  f.obvUp = sl > 0; f.obvDn = sl < 0;
}

// DOW confirmation: OBV diverges from price at the last two same-type pivots
function obvDivFactor(rows, ob, f) {
  const { hi, lo } = pivots(rows.slice(-56), 3);
  const gi = rows.length - 56;
  if (hi.length >= 2) {
    const [a, b] = hi.slice(-2);
    if (b.p > a.p && ob[b.i + gi] < ob[a.i + gi]) f.obvBearDiv = true;   // price HH, OBV LH
  }
  if (lo.length >= 2) {
    const [a, b] = lo.slice(-2);
    if (b.p < a.p && ob[b.i + gi] > ob[a.i + gi]) f.obvBullDiv = true;   // price LL, OBV HL
  }
}

// WYCKOFF: schematic events inside the last trading range
function wyckoffFactors(rows, f) {
  const seg = rows.slice(-60);
  if (seg.length < 40) return;
  const hi = Math.max(...seg.map(r => r.h)), lo = Math.min(...seg.map(r => r.l));
  const mid = (hi + lo) / 2, rng = (hi - lo) / mid;
  if (rng < 0.02 || rng > 0.20) return;
  const vols = seg.map(vol), vmed = [...vols].sort((a, b) => a - b)[vols.length >> 1] || 1;
  const iLo = seg.reduce((b, r, i) => r.l < seg[b].l ? i : b, 0);
  const iHi = seg.reduce((b, r, i) => r.h > seg[b].h ? i : b, 0);
  // accumulation: selling climax + a later higher low on lighter volume (ST),
  // or a sign of strength out of the range on heavy volume (SOS)
  const sc = iLo < seg.length - 6 && seg[iLo].l <= lo * 1.005;
  const st = sc && seg.slice(iLo + 2).some((r, i) =>
    Math.abs(r.l - seg[iLo].l) / seg[iLo].l <= 0.03 && vols[iLo + 2 + i] < vols[iLo]);
  const sos = seg.some((r, i) => r.c > hi * 1.002 && vols[i] > vmed * 1.2);
  const lps = sos && seg.slice(seg.findIndex(r => r.c > hi * 1.002)).some(r => r.l > hi * 0.99);
  f.wyckAccum = sc && (st || sos || lps);
  // distribution mirror: buying climax + sign of weakness back through the floor
  const bc = iHi < seg.length - 6 && seg[iHi].h >= hi * 0.995;
  const sow = bc && seg.slice(iHi).some((r, i) => r.c < lo * 0.998 && vols[iHi + i] > vmed * 1.1);
  const utad = bc && seg.slice(iHi).some(r => r.h > hi * 1.003 && r.c < hi);
  f.wyckDist = bc && (sow || utad);
}

// VOLUME (Wyckoff effort-vs-result, Livermore's "volume confirms"):
//  volThrust   — last closed bar moved WITH the side on >=1.5x 20-bar
//                median volume: effort producing result.
//  climax      — within the last 12 bars a >=2.5x-volume wide bar at a
//                40-bar extreme that closed back off the extreme: the
//                other side capitulated (selling climax -> long edge).
//  volDryUp    — last 3 bars' median volume <0.7x the 20-bar median
//                while price holds the right side of the 20-bar mid:
//                the pullback has no supply/demand behind it.
function volumeFactors(rows, f) {
  const n = rows.length; if (n < 45) return;
  const last = rows[n - 1];
  const w20 = rows.slice(-21, -1).map(vol), vmed = [...w20].sort((a, b) => a - b)[w20.length >> 1] || 0;
  if (!(vmed > 0)) return;
  const x = vol(last) / vmed;
  f._volX = +x.toFixed(2);
  f.volThrustUp = last.c > last.o && last.c > rows[n - 2].c && x >= 1.5;
  f.volThrustDn = last.c < last.o && last.c < rows[n - 2].c && x >= 1.5;
  const w40 = rows.slice(-40), lo40 = Math.min(...w40.map(r => r.l)), hi40 = Math.max(...w40.map(r => r.h));
  const rngMed = [...w40.map(r => r.h - r.l)].sort((a, b) => a - b)[20] || 0;
  f.sellClimax = f.buyClimax = false;
  for (const r of rows.slice(-12)) {
    const vx = vol(r) / vmed, wide = (r.h - r.l) >= 1.5 * rngMed;
    if (vx >= 2.5 && wide && r.l <= lo40 * 1.002 && (r.c - r.l) >= 0.4 * (r.h - r.l)) f.sellClimax = true;
    if (vx >= 2.5 && wide && r.h >= hi40 * 0.998 && (r.h - r.c) >= 0.4 * (r.h - r.l)) f.buyClimax = true;
  }
  const v3 = rows.slice(-3).map(vol).sort((a, b) => a - b)[1] / vmed;
  const mid20 = (Math.max(...rows.slice(-20).map(r => r.h)) + Math.min(...rows.slice(-20).map(r => r.l))) / 2;
  f.volDryUpLong = v3 < 0.7 && last.c > mid20;   // quiet pullback above the mid — supply dried up
  f.volDryUpShort = v3 < 0.7 && last.c < mid20;  // quiet bounce below the mid — demand dried up
}

// ELLIOTT: position in the wave count (impulse rules on the zigzag)
function elliottFactors(rows, zz, f) {
  if (zz.length < 6) return;
  const seq = zz.slice(-7);
  const types = seq.map(e => e.t).join('');
  // impulse up complete or running: L H L H L H
  if (types.slice(0, 6) === 'lhlhlh') {
    const [p0, p1, p2, p3, p4, p5] = seq.slice(0, 6).map(e => e.p);
    const w1 = p1 - p0, w3 = p3 - p2, w5 = p5 - p4;
    if (p2 > p0 && p4 > p1 && p5 > p3 && w3 >= Math.min(w1, w5) * 0.99 && w1 > 0 && w5 > 0) {
      f.ewUpComplete = true;                                     // five up done → top risk
      if (seq[6]?.t === 'l') f.ewAbcDown = true;                 // corrective started
    }
  }
  // impulse down complete or running: H L H L H L
  if (types.slice(0, 6) === 'hlhlhl') {
    const [p0, p1, p2, p3, p4, p5] = seq.slice(0, 6).map(e => e.p);
    const w1 = p0 - p1, w3 = p2 - p3, w5 = p4 - p5;
    if (p2 < p0 && p4 < p1 && p5 < p3 && w3 >= Math.min(w1, w5) * 0.99 && w1 > 0 && w5 > 0) {
      f.ewDnComplete = true;                                     // five down done → bottom
      if (seq[6]?.t === 'h') f.ewAbcUp = true;
    }
  }
  // running wave-4 pullback of an up-impulse (long entry zone): LH LH l
  if (types.endsWith('hlhl')) {
    const last4 = zz.slice(-4);
    if (last4[3].t === 'l' && last4[2].p > last4[0].p && last4[3].p > last4[1].p) f.ewWave4 = true;
  }
}

// GANN: 50% of the major range + time since the range extreme
function gannFactors(rows, f) {
  const seg = rows.slice(-96);
  if (seg.length < 48) return;
  const hi = Math.max(...seg.map(r => r.h)), lo = Math.min(...seg.map(r => r.l));
  const half = lo + (hi - lo) * 0.5;
  const px = rows[rows.length - 1].c;
  f.gannAbove50 = px > half; f.gannBelow50 = px < half;
  // time: Gann's cycle numbers in bars (15m: 7,13,21,28,45,89)
  const iHi = seg.reduce((b, r, i) => r.h >= seg[b].h ? i : b, 0);
  const iLo = seg.reduce((b, r, i) => r.l <= seg[b].l ? i : b, 0);
  const since = seg.length - 1 - Math.max(iHi, iLo);
  f.gannTime = [7, 13, 21, 28, 45, 89].some(g => Math.abs(since - g) <= 1);
}

// THE KINGS (operator doctrine): BTC is King of Market, ETH is King of
// Altcoins — subjects copy their structure. kingBear = EITHER king printing
// bearish Dow structure (LH+LL) — shorts gain evidence; kingBull = BOTH
// kings printing bullish structure (HH+HL) — longs gain evidence.
function kingFactors(f) {
  try {
    const klAll = rd(path.join(STATE, 'klines-15m.json')) || {};
    let bulls = 0, bears = 0;
    for (const k of ['BTCUSDT', 'ETHUSDT']) {
      const rows = klAll[k]?.rows || [];
      if (rows.length < 60) continue;
      const { hi, lo } = pivots(rows, 2);
      const hs = hi.slice(-2), ls = lo.slice(-2);
      if (hs.length < 2 || ls.length < 2) continue;
      if (hs[1].p > hs[0].p && ls[1].p > ls[0].p) bulls++;
      if (hs[1].p < hs[0].p && ls[1].p < ls[0].p) bears++;
    }
    f.kingBull = bulls === 2;
    f.kingBear = bears >= 1;
    f._kingB = bulls; f._kingS = bears;
  } catch { }
}

// BOLLINGER: %B position + squeeze (band-width percentile)
function bbFactors(rows, f) {
  const closes = rows.map(r => r.c);
  const n = 20;
  if (closes.length < n + 10) return;
  const px = closes[closes.length - 1];
  const bw = [];
  let last = null;
  for (let i = n - 1; i < closes.length; i++) {
    const seg = closes.slice(i - n + 1, i + 1);
    const m = seg.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    const up = m + 2 * sd, lo = m - 2 * sd;
    bw.push(m ? (up - lo) / m : 0);
    if (i === closes.length - 1) last = { up, mid: m, lo };
  }
  if (!last || last.up === last.lo) return;
  const pctB = (px - last.lo) / (last.up - last.lo);
  const curBw = bw[bw.length - 1];
  const sorted = [...bw].sort((x, y) => x - y);
  const bwPct = sorted.findIndex(v => v >= curBw) / sorted.length;
  f.bbSqueeze = bwPct <= 0.25;                  // coiled — energy building
  f.bbStretchUp = pctB > 0.9;                   // stretched above upper band
  f.bbStretchDn = pctB < 0.1;                   // pinned to lower band
  f.bbAboveMid = px > last.mid; f.bbBelowMid = px < last.mid;
  f._pctB = +pctB.toFixed(2); f._bwPct = +bwPct.toFixed(2);
}

// LIVERMORE: pivotal point proximity + the line of least resistance
function livermoreFactors(rows, f) {
  const a = atr(rows); if (!a) return;
  const px = rows[rows.length - 1].c;
  const { hi, lo } = pivots(rows.slice(-72), 3);
  const levels = [...hi.slice(-4).map(e => e.p), ...lo.slice(-4).map(e => e.p)];
  f.atPivotal = levels.some(l => Math.abs(px - l) <= 0.8 * a);
  // least resistance: density of the last 96 closes in the 1.5-ATR band
  // above vs below price — the thinner side is the easier path.
  const seg = rows.slice(-96).map(r => r.c);
  const above = seg.filter(c => c > px && c <= px + 1.5 * a).length;
  const below = seg.filter(c => c < px && c >= px - 1.5 * a).length;
  f.leastResUp = above < below; f.leastResDn = below < above;
}

/**
 * titanConfluence(sym, side) — { score, max, factors, detail }
 * side 'long':  dowBull|obvUp|obvBullDiv|wyckAccum|ewDnComplete|ewWave4|
 *               gannAbove50|atPivotal|leastResUp   (max 9)
 * side 'short': dowBear|obvDn|obvBearDiv|wyckDist|ewUpComplete|
 *               gannBelow50|atPivotal|leastResDn   (max 8)
 */
export function titanConfluence(sym, side = 'long') {
  const f = {};
  const kl = rd(path.join(STATE, 'klines-15m.json'))?.[sym];
  const rows = kl?.rows || (Array.isArray(kl) ? kl : null);
  if (!rows || rows.length < 80) return { score: 0, max: 9, factors: {}, detail: 'no-klines' };
  const a = atr(rows);
  const zz = zigzag(rows, Math.max(a * 1.2, rows[rows.length - 1].c * 0.008));
  const ob = obv(rows);
  dowFactors(rows, zz, ob, f);
  obvDivFactor(rows, ob, f);
  wyckoffFactors(rows, f);
  elliottFactors(rows, zz, f);
  gannFactors(rows, f);
  bbFactors(rows, f);
  volumeFactors(rows, f);
  kingFactors(f);
  livermoreFactors(rows, f);
  const longKeys = ['dowBull', 'obvUp', 'obvBullDiv', 'wyckAccum', 'ewDnComplete', 'ewWave4', 'gannAbove50', 'atPivotal', 'leastResUp', 'bbSqueeze', 'bbAboveMid', 'kingBull', 'volThrustUp', 'sellClimax', 'volDryUpLong'];
  const shortKeys = ['dowBear', 'obvDn', 'obvBearDiv', 'wyckDist', 'ewUpComplete', 'gannBelow50', 'atPivotal', 'leastResDn', 'bbSqueeze', 'bbStretchUp', 'bbBelowMid', 'kingBear', 'volThrustDn', 'buyClimax', 'volDryUpShort'];
  const keys = side === 'short' ? shortKeys : longKeys;
  const score = keys.filter(k => f[k]).length;
  return { score, max: keys.length, factors: f, detail: keys.filter(k => f[k]).join(',') || 'none' };
}
