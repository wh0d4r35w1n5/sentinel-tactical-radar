// reject-markout.mjs — Will Evans: "measure rejected trades — track what
// would have happened to every refused candidate over the next 5/15/60min.
// That establishes whether the filters are genuinely protecting capital."
// Maintains state/reject-tracker.json (append-only ledger of stamped rejects)
// and marks each against live prices at fixed horizons. Direction-aware:
// avoidedRet>0 = the signal was right (veto cost money); <0 = veto saved.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const round = (x, n = 4) => (x == null || !Number.isFinite(+x)) ? null : Math.round(+x * 10 ** n) / 10 ** n;
const HORIZONS = [5, 15, 60];

const tracker = readJ(path.join(ROOT, 'state', 'reject-tracker.json'), { rows: [] });
const ledger = readJ(path.join(ROOT, 'api', 'live-ledger.json'), {});
const scanner = readJ(path.join(ROOT, 'api', 'market-scanner.json'), {});
const now = Date.now();

// merge fresh rejects — scanner's land in state.rejects via the exec; the
// ledger artifact carries them all (stamped px+ts by scanner/exec).
const seen = new Set(tracker.rows.map((r) => r.k));
const incoming = [];
for (const src of [scanner, ledger]) {
  for (const r of (src.rejects || [])) {
    if (!r.symbol || !r.px || !r.ts) continue;
    const gate = (r.gates || ['?'])[0];
    const k = r.symbol + '|' + r.direction + '|' + gate;
    incoming.push({ k, ts: r.ts, symbol: r.symbol, direction: r.direction, px: +r.px, gate, gates: r.gates, strategy: r.strategy ?? null, score: r.score ?? null, marks: {} });
  }
}
for (const r of incoming.sort((a, b) => a.ts - b.ts)) {
  const prev = tracker.rows.filter((x) => x.k === r.k).at(-1);
  if (prev && r.ts - prev.ts < 30 * 60e3) continue; // same veto re-fired — dedupe 30min
  if (!seen.has(r.k + '|' + r.ts) && r.px > 0) { tracker.rows.push(r); seen.add(r.k + '|' + r.ts); }
}
tracker.rows = tracker.rows.slice(-2000); // bounded ledger

// live prices — public endpoint, no auth needed for marks
let tick = {};
try {
  const j = await (await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', { signal: AbortSignal.timeout(12000) })).json();
  for (const t of (j.data || [])) tick[t.symbol] = +t.lastPr;
} catch (e) { console.log('reject-markout: ticker fetch failed —', e.message); }

// mark each horizon once reached — marks persist (a marked horizon never recomputes)
let marked = 0;
for (const r of tracker.rows) {
  const pxNow = tick[r.symbol]; if (!(pxNow > 0)) continue;
  const sgn = r.direction === 'SHORT' ? -1 : 1;
  for (const h of HORIZONS) {
    const key = 'm' + h;
    if (r.marks[key] != null || now - r.ts < h * 60e3) continue;
    r.marks[key] = round(sgn * (pxNow - r.px) / r.px * 100, 3); marked++;
  }
}

// aggregate — a veto "won" if the candidate went on to lose (avoided<0)
const agg = (rows) => {
  const out = { n: rows.length };
  for (const h of HORIZONS) {
    const m = rows.filter((r) => r.marks['m' + h] != null).map((r) => r.marks['m' + h]);
    out['h' + h] = m.length ? {
      n: m.length,
      meanAvoidedPct: round(m.reduce((a, x) => a + x, 0) / m.length, 3),
      vetoWinPct: round(m.filter((x) => x < 0).length / m.length * 100, 1),
      median: round(m.sort((a, b) => a - b)[Math.floor(m.length / 2)], 3),
    } : { n: 0 };
  }
  return out;
};
const byGate = {};
for (const r of tracker.rows) (byGate[r.gate] ||= []).push(r);
const gates = Object.fromEntries(Object.entries(byGate).map(([g, rows]) => [g, agg(rows)]));

writeJ(path.join(ROOT, 'state', 'reject-tracker.json'), tracker);
const out = {
  ts: now, updatedAt: new Date().toISOString(),
  method: 'avoided-forward-return vs reject price; >0 = veto cost money, <0 = veto saved; each horizon marked once then frozen; dedupe 30min per symbol+gate',
  tracked: tracker.rows.length,
  overall: agg(tracker.rows),
  byGate: Object.fromEntries(Object.entries(gates).sort((a, b) => (b[1].h60.n + b[1].h15.n + b[1].h5.n) - (a[1].h60.n + a[1].h15.n + a[1].h5.n))),
  recent: tracker.rows.slice(-15).map((r) => ({ sym: r.symbol, dir: r.direction, gate: r.gate, ageMin: Math.round((now - r.ts) / 6e4), m5: r.marks.m5 ?? null, m15: r.marks.m15 ?? null, m60: r.marks.m60 ?? null })),
};
writeJ(path.join(ROOT, 'api', 'reject-markout.json'), out);
const o = out.overall;
console.log(`reject-markout: ${out.tracked} tracked (+${marked} new marks) | m60: n=${o.h60.n} meanAvoided=${o.h60.meanAvoidedPct}% vetoWin=${o.h60.vetoWinPct}%`);
