// SQN Factory — combinatorial hypothesis generator + grader.
// Tests THOUSANDS of candidate strategy cells against deep daily
// history. Same honesty as shadow-grade: net of 0.12% fees,
// adverse-first within bar. Promotion bar: n>=15 effective days,
// shrunk SQN >= 0.5, meanNet > 0. Output: state/sqn-factory.json.
import fs from 'fs';
import path from 'path';
const STATE = '/opt/sentinel/state';
const FEE = 0.12;
const MIN_N = 15, MIN_SQ = 0.5;

const kl = JSON.parse(fs.readFileSync(path.join(STATE, 'klines-1D.json'), 'utf8'));
const syms = Object.keys(kl).filter((k) => Array.isArray(kl[k] && kl[k].rows) && kl[k].rows.length > 60);

const rsi = (cl, i, n = 14) => {
  if (i < n + 1) return null;
  let g = 0, l = 0;
  for (let j = i - n + 1; j <= i; j++) { const d = cl[j] - cl[j - 1]; if (d > 0) g += d; else l -= d; }
  if (g + l === 0) return 50;
  return 100 * (g / (g + l));
};
const sma = (cl, i, n) => { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += cl[j]; return s / n; };
const medVol = (rows, i, n = 20) => { if (i < n) return null; const v = rows.slice(i - n, i).map((r) => r.qv).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

const TRIG = [];
for (const t of [10, 15, 20, 25, 30]) TRIG.push({ id: 'rsi-lt-' + t, test: (f) => f.rsi != null && f.rsi < t, side: 'long' });
for (const t of [70, 75, 80, 85, 90]) TRIG.push({ id: 'rsi-gt-' + t, test: (f) => f.rsi != null && f.rsi > t, side: 'short' });
for (const n of [2, 3, 5, 10, 20]) for (const t of [3, 5, 8, 12, 20]) {
  TRIG.push({ id: 'mom' + n + '-gt-' + t, test: (f) => f['chg' + n] != null && f['chg' + n] > t, side: 'long' });
  TRIG.push({ id: 'mom' + n + '-gt-' + t + '-fade', test: (f) => f['chg' + n] != null && f['chg' + n] > t, side: 'short' });
  TRIG.push({ id: 'mom' + n + '-lt-' + t, test: (f) => f['chg' + n] != null && f['chg' + n] < -t, side: 'long' });
  TRIG.push({ id: 'mom' + n + '-lt-' + t + '-cont', test: (f) => f['chg' + n] != null && f['chg' + n] < -t, side: 'short' });
}
for (const n of [10, 20, 50]) {
  TRIG.push({ id: 'brk-high' + n, test: (f) => f['hi' + n] != null && f.c > f['hi' + n], side: 'long' });
  TRIG.push({ id: 'brk-low' + n, test: (f) => f['lo' + n] != null && f.c < f['lo' + n], side: 'short' });
  TRIG.push({ id: 'brk-high' + n + '-fade', test: (f) => f['hi' + n] != null && f.c > f['hi' + n], side: 'short' });
  TRIG.push({ id: 'brk-low' + n + '-bounce', test: (f) => f['lo' + n] != null && f.c < f['lo' + n], side: 'long' });
}
for (const n of [3, 4, 5]) {
  TRIG.push({ id: 'down' + n + '-rev', test: (f) => f.downRun >= n, side: 'long' });
  TRIG.push({ id: 'down' + n + '-cont', test: (f) => f.downRun >= n, side: 'short' });
  TRIG.push({ id: 'up' + n + '-rev', test: (f) => f.upRun >= n, side: 'short' });
  TRIG.push({ id: 'up' + n + '-cont', test: (f) => f.upRun >= n, side: 'long' });
}
for (const m of [2, 3, 5]) {
  TRIG.push({ id: 'vol' + m + 'x-up', test: (f) => f.volX != null && f.volX > m && f.dayChg > 0, side: 'long' });
  TRIG.push({ id: 'vol' + m + 'x-dn', test: (f) => f.volX != null && f.volX > m && f.dayChg < 0, side: 'long' });
  TRIG.push({ id: 'vol' + m + 'x-dn-short', test: (f) => f.volX != null && f.volX > m && f.dayChg < 0, side: 'short' });
}
for (const t of [10, 20, 30]) {
  TRIG.push({ id: 'rng-bot' + t, test: (f) => f.rngPos != null && f.rngPos < t / 100, side: 'long' });
  TRIG.push({ id: 'rng-top' + (100 - t), test: (f) => f.rngPos != null && f.rngPos > (100 - t) / 100, side: 'short' });
}
for (const n of [10, 20, 50]) for (const t of [3, 5, 8, 12]) {
  TRIG.push({ id: 'sma' + n + '-abv-' + t, test: (f) => f['smaD' + n] != null && f['smaD' + n] > t, side: 'long' });
  TRIG.push({ id: 'sma' + n + '-bel-' + t, test: (f) => f['smaD' + n] != null && f['smaD' + n] < -t, side: 'long' });
  TRIG.push({ id: 'sma' + n + '-abv-' + t + '-fade', test: (f) => f['smaD' + n] != null && f['smaD' + n] > t, side: 'short' });
}
for (const t of [3, 5, 8]) {
  TRIG.push({ id: 'gapup' + t + '-fade', test: (f) => f.gap != null && f.gap > t, side: 'short' });
  TRIG.push({ id: 'gapdn' + t + '-bounce', test: (f) => f.gap != null && f.gap < -t, side: 'long' });
}
TRIG.push({ id: 'close-hi-rng', test: (f) => f.dayPos != null && f.dayPos > 0.9, side: 'long' });
TRIG.push({ id: 'close-hi-rng-fade', test: (f) => f.dayPos != null && f.dayPos > 0.9, side: 'short' });
TRIG.push({ id: 'close-lo-rng', test: (f) => f.dayPos != null && f.dayPos < 0.1, side: 'long' });
TRIG.push({ id: 'close-lo-rng-cont', test: (f) => f.dayPos != null && f.dayPos < 0.1, side: 'short' });

const EXITS = [];
for (const h of [1, 2, 3, 5, 10]) EXITS.push({ id: 'h' + h, run: (rows, i, sgn) => (rows[i + h] ? sgn * ((rows[i + h].c - rows[i].c) / rows[i].c) * 100 - FEE : null) });
for (const tp of [2, 4, 8]) for (const sl of [1, 2, 4]) EXITS.push({
  id: 'tp' + tp + '-sl' + sl,
  run: (rows, i, sgn) => {
    const tPx = rows[i].c * (1 + sgn * tp / 100), sPx = rows[i].c * (1 - sgn * sl / 100);
    for (let j = i + 1; j < Math.min(rows.length, i + 11); j++) {
      const b = rows[j];
      if (sgn > 0 ? b.l <= sPx : b.h >= sPx) return -sl - FEE;
      if (sgn > 0 ? b.h >= tPx : b.l <= tPx) return tp - FEE;
    }
    return rows[i + 10] ? sgn * ((rows[i + 10].c - rows[i].c) / rows[i].c) * 100 - FEE : null;
  },
});

const cells = new Map();
const bump = (key, ret, day) => { let c = cells.get(key); if (!c) cells.set(key, c = { rets: [], days: new Set() }); c.rets.push(ret); c.days.add(day); };

let totalBars = 0;
for (const sym of syms) {
  const rows = kl[sym].rows; totalBars += rows.length;
  const cl = rows.map((r) => r.c);
  for (let i = 55; i < rows.length - 1; i++) {
    const f = { c: cl[i] };
    f.rsi = rsi(cl, i);
    f.dayChg = (cl[i] - rows[i].o) / rows[i].o * 100;
    f.gap = (rows[i].o - cl[i - 1]) / cl[i - 1] * 100;
    f.dayPos = rows[i].h > rows[i].l ? (cl[i] - rows[i].l) / (rows[i].h - rows[i].l) : 0.5;
    const mv = medVol(rows, i); f.volX = mv ? rows[i].qv / mv : null;
    for (const n of [2, 3, 5, 10, 20]) f['chg' + n] = i >= n ? (cl[i] - cl[i - n]) / cl[i - n] * 100 : null;
    for (const n of [10, 20, 50]) {
      if (i >= n) { let hi = -1e18, lo = 1e18; for (let j = i - n; j < i; j++) { if (rows[j].h > hi) hi = rows[j].h; if (rows[j].l < lo) lo = rows[j].l; } f['hi' + n] = hi; f['lo' + n] = lo; }
      const s = sma(cl, i, n); f['smaD' + n] = s ? (cl[i] - s) / s * 100 : null;
    }
    let dr = 0, ur = 0; for (let j = i; j > 0 && cl[j] < cl[j - 1]; j--) dr++; for (let j = i; j > 0 && cl[j] > cl[j - 1]; j--) ur++;
    f.downRun = dr; f.upRun = ur;
    if (f.hi50 != null && f.hi50 !== f.lo50) f.rngPos = (cl[i] - f.lo50) / (f.hi50 - f.lo50);
    for (const tr of TRIG) {
      if (!tr.test(f)) continue;
      for (const ex of EXITS) {
        const ret = ex.run(rows, i, tr.side === 'long' ? 1 : -1);
        if (ret != null) bump('fac:' + tr.id + ':' + ex.id + ':' + tr.side, ret, rows[i].t);
      }
    }
  }
}

const sqnOf = (rets, days) => {
  const n = rets.length, dN = days.size;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, n - 1));
  const eff = Math.min(n, dN * 3);
  const shrunk = sd > 0 ? (mean / sd) * Math.sqrt(eff) : 0;
  return { n, dirN: dN, wr: +(rets.filter((r) => r > 0).length / n * 100).toFixed(1), meanNetPct: +mean.toFixed(3), sqn: +shrunk.toFixed(2) };
};
const out = { at: new Date().toISOString(), bar: { minN: MIN_N, minSqn: MIN_SQ }, symbols: syms.length, bars: totalBars, candidates: TRIG.length * EXITS.length, cells: {}, promoted: {}, convicted: {} };
for (const [k, c] of cells) {
  const g = sqnOf(c.rets, c.days); out.cells[k] = g;
  if (g.dirN >= MIN_N && g.meanNetPct > 0 && g.sqn >= MIN_SQ) out.promoted[k] = g;
  if (g.dirN >= MIN_N && g.meanNetPct < 0 && g.sqn <= -MIN_SQ) out.convicted[k] = g;
}
fs.writeFileSync(path.join(STATE, 'sqn-factory.json'), JSON.stringify(out, null, 1));

// ---- research-engine feed: every graded finding becomes an RFC hypothesis.
// shadow class = documented through the ITIL lifecycle, never auto-trades.
// Dedup by id; cap per run so the queue isn't flooded at once.
try {
  const HYPO = path.join(STATE, 'research-hypotheses.json');
  let hypo = []; try { hypo = JSON.parse(fs.readFileSync(HYPO, 'utf8')); } catch {}
  const seen = new Set(hypo.map((h) => h.id));
  const top = (m) => Object.entries(m).sort((a, b) => Math.abs(b[1].sqn) - Math.abs(a[1].sqn)).slice(0, 25);
  for (const [k, g] of top(out.promoted)) {
    const id = 'FAC-' + k;
    if (seen.has(id)) continue;
    hypo.push({ id, class: 'shadow', source: 'sqn-factory',
      title: 'promoted ' + k + ' — sqn ' + g.sqn + ' wr ' + g.wr + '% mean ' + g.meanNetPct + '% n=' + g.n + ' (' + g.dirN + 'd)',
      state: 'submitted', history: [] });
    seen.add(id);
  }
  for (const [k, g] of top(out.convicted)) {
    const id = 'FACX-' + k;
    if (seen.has(id)) continue;
    hypo.push({ id, class: 'shadow', source: 'sqn-factory',
      title: 'convicted ' + k + ' — sqn ' + g.sqn + ' wr ' + g.wr + '% mean ' + g.meanNetPct + '% n=' + g.n + ' — measured loser, stands down',
      state: 'submitted', history: [] });
    seen.add(id);
  }
  fs.writeFileSync(HYPO, JSON.stringify(hypo, null, 1));
  console.log('hypotheses queued:', hypo.length);
} catch (e) { console.log('hypo feed err:', e.message); }
const sorted = Object.entries(out.promoted).sort((a, b) => b[1].sqn - a[1].sqn);
console.log('graded ' + Object.keys(cells).length + ' cells | bars ' + totalBars + ' | promoted ' + sorted.length + ' | convicted ' + Object.keys(out.convicted).length);
for (const [k, g] of sorted.slice(0, 15)) console.log(' PROMOTED', k, JSON.stringify(g));
