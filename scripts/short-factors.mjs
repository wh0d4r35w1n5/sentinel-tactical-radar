// short-factors.mjs — Will's composite: a short isn't banned, it earns
// live ammo across confluence factors. Shared by pump-watch (emits)
// and bitget-exec (sentinel-structure desc-tri/rising-wedge shorts).
// Every emit + every shadow row journals the score so the evidence can
// attribute expectancy by factor count — data decides, not debate.
import fs from 'node:fs';
import path from 'node:path';
import { titanConfluence } from './titans.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STATE = path.join(DIR, '..', 'state');
const API = path.join(DIR, '..', 'api');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function rsi14(closes) {
  if (closes.length < 15) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / 14, al = l / 14;
  const out = [null]; // out[i] aligns to closes[i]
  for (let i = 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * 13 + Math.max(d, 0)) / 14;
    al = (al * 13 + Math.max(-d, 0)) / 14;
    out[i] = 100 - 100 / (1 + (al ? ag / al : 1e9));
  }
  return out;
}

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

function macdHist(closes) {
  const ema = (n) => {
    const k = 2 / (n + 1); const o = new Array(closes.length).fill(null);
    let e = null;
    for (let i = 0; i < closes.length; i++) { e = e == null ? closes[i] : closes[i] * k + e * (1 - k); if (i >= n - 1) o[i] = e; }
    return o;
  };
  const ef = ema(12), es = ema(26);
  const macd = closes.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const k = 2 / 10; let e = null;
  const sig = macd.map(v => v == null ? null : (e = e == null ? v : v * k + e * (1 - k)));
  return macd.map((v, i) => v != null && sig[i] != null ? v - sig[i] : null);
}

/**
 * Factor composite for a SHORT candidate.
 * ctx: { breakdown:bool } — caller marks whether the tape already printed
 *        the level break (br-mode emits always true at their own gate).
 * Returns { score, factors, notes } — 9 factors, score = count of true.
 */
export function shortFactors(sym, ctx = {}) {
  const f = {}, notes = [];
  const canon = sym.replace(/USDT$/, '');
  // ---- kline factors: RSI high, RSI bear-div, MACD roll-over ----
  const kl = rd(path.join(STATE, 'klines-15m.json'))?.[sym];
  const rows = kl?.rows || (Array.isArray(kl) ? kl : null);
  if (rows && rows.length >= 60) {
    const closes = rows.map(r => r.c);
    const rsi = rsi14(closes);
    const lastRsi = rsi[rsi.length - 1];
    f.rsiHigh = lastRsi != null && lastRsi >= 60;
    const { hi } = pivots(rows.slice(-48), 3);
    f.rsiDiv = false;
    if (hi.length >= 2) {
      const [a, b] = hi.slice(-2);
      const gi = rows.length - 48;
      const ra = rsi[a.i + gi], rb = rsi[b.i + gi];
      if (b.p > a.p && rb != null && ra != null && rb < ra) f.rsiDiv = true; // price HH, RSI LH = bearish
    }
    const hist = macdHist(closes);
    const h3 = hist.slice(-3).filter(v => v != null);
    f.macdRoll = h3.length === 3 && h3[2] < h3[1] && h3[1] >= h3[0];
  } else {
    notes.push('no-klines');
  }
  // ---- breadth: market tailwind ----
  const bub = rd(path.join(STATE, 'cryptobubbles.json'));
  if (bub) {
    const dg = bub.breadth?.dayGreen;
    f.breadthNeg = (dg != null && dg < 0.40) || (bub.mom != null && bub.mom < 0);
    const bs = bub.bySym?.[sym];
    f.notLeader = bs ? !(bs.day > 0 && bs.week > 0 && bs.hour > 0) : true;
  }
  // ---- funding: positive rate = shorts collect ----
  const fund = rd(path.join(API, 'funding.json'));
  if (fund?.rows) {
    const row = fund.rows.find(r => r.asset === canon || r.asset === sym);
    f.fundingPos = row ? row.ratePct > 0 : false;
  }
  // ---- tape flow: net sell pressure ----
  const liq = rd(path.join(API, 'liq-intel.json'));
  const ls = liq?.symbols?.[sym];
  if (ls) {
    f.flowNeg = (ls.flow15m?.delta || 0) < 0;
    f.squeezeFade = (ls.liq15m?.short || 0) < 10e3; // no active squeeze engine
  }
  // ---- TradingView scanner: weak-rated shorts ----
  const tv = rd(path.join(STATE, 'tv-ratings.json'));
  if (tv?.rates && tv.ts && Date.now() - tv.ts < 30 * 60e3) {
    f.tvWeak = (tv.rates[sym] ?? 0) < 0;
  }
  // ---- titans: Dow/OBV/Wyckoff/Elliott/Gann/Livermore confluence ----
  try {
    const t = titanConfluence(sym, 'short');
    const tf = t.factors || {};
    f.dowBear = !!tf.dowBear;
    f.obvDn = !!tf.obvDn;
    f.obvBearDiv = !!tf.obvBearDiv;
    f.wyckDist = !!tf.wyckDist;
    f.ewTop = !!tf.ewUpComplete;
    f.bbSqueeze = !!tf.bbSqueeze;
    f.bbStretchUp = !!tf.bbStretchUp;
    f.bbBelowMid = !!tf.bbBelowMid;
    f.kingBear = !!tf.kingBear;
  } catch { }
  // ---- the level actually broke ----
  f.breakdown = ctx.breakdown !== false;
  const score = Object.values(f).filter(Boolean).length;
  return { score, factors: f, notes };
}
