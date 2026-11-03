// liq-intel A/B grader — Will's scientific test.
// state/liq-shadow.jsonl holds every setup the liq-intel gate blocked, with
// entry px + the strategy's own exit rule. This grades each counterfactual
// on REAL forward tape (Bitget 15m klines), simulating its own SL/TP/TTL
// with worst-case intra-candle sequencing (stop wins ties — Will's rule),
// net of ~0.12% round-trip taker fees.
//
// Cohort B (treatment) = real fills in the same window from
// state/real-fills.json — the gate was live for those, so the comparison is
// blocked-vs-allowed on identical calendar tape. Writes api/liq-ab.json.
// Small n is reported, never hidden.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SHADOW = path.join(DIR, '..', 'state', 'liq-shadow.jsonl');
const FILLS = path.join(DIR, '..', 'state', 'real-fills.json');
const OUT = path.join(DIR, '..', 'api', 'liq-ab.json');
const HOST = 'https://api.bitget.com';
const FEE_RT = 0.0012;            // ~0.12% round-trip taker — same fee model the census used
const HORIZON_H = 24;             // grade at 24h forward window
const MIN_AGE_H = 2;              // need at least 2h of forward tape to grade

const rows = (() => {
  try { return fs.readFileSync(SHADOW, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
})();

async function candles(sym, startMs, endMs) {
  const gran = '15m';
  const out = [];
  let cur = startMs;
  // kline API pages newest->oldest; walk forward in 100-bar chunks (25h of 15m)
  while (cur < endMs) {
    const url = `${HOST}/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=${gran}&startTime=${cur}&endTime=${Math.min(endMs, cur + 100 * 900e3)}&limit=100`;
    const j = await (await fetch(url, { signal: AbortSignal.timeout(12000) })).json();
    const arr = (j && j.data) || [];
    if (!arr.length) break;
    arr.sort((a, b) => +a[0] - +b[0]);
    for (const c of arr) out.push({ ts: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] });
    const last = +arr[arr.length - 1][0];
    if (last <= cur) break;
    cur = last + 900e3;
    if (arr.length < 100) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

function gradeShadow(row, bars) {
  const e = row.px ?? row.entryPx;
  const long = row.side === 'long';
  // two row schemas: {px, rule:{slPct,tpPct,ttlMin}} or {entryPx, slPx} (no tp leg)
  const slPct = row.rule?.slPct != null ? +row.rule.slPct
    : (e && row.slPx ? Math.abs(+row.slPx - e) / e * 100 : NaN);
  const tpPct = row.rule?.tpPct != null ? +row.rule.tpPct : null;
  if (!e || !Number.isFinite(slPct)) return null;
  const sl = long ? e * (1 - slPct / 100) : e * (1 + slPct / 100);
  const tp = tpPct != null ? (long ? e * (1 + tpPct / 100) : e * (1 - tpPct / 100)) : null;
  const ttlEnd = row.ts + (row.rule?.ttlMin || 30) * 60e3;
  let mfe = 0, mae = 0;
  for (const b of bars) {
    if (b.ts < row.ts) continue;
    const ret = (px) => (long ? (px - e) / e : (e - px) / e) * 100;
    mfe = Math.max(mfe, ret(b.h)); mae = Math.min(mae, ret(b.l));
    // worst-case sequencing: if a candle tags both SL and TP, the stop wins
    const hitSl = long ? b.l <= sl : b.h >= sl;
    const hitTp = tp != null && (long ? b.h >= tp : b.l <= tp);
    if (hitSl) return { outcome: 'sl', netPct: -slPct - FEE_RT * 100, mfe, mae };
    if (hitTp) return { outcome: 'tp', netPct: tpPct - FEE_RT * 100, mfe, mae };
    if (b.ts >= ttlEnd) return { outcome: 'ttl', netPct: ret(b.c) - FEE_RT * 100, mfe, mae };
  }
  const last = bars[bars.length - 1];
  if (!last) return null;
  return { outcome: 'open', netPct: ((long ? last.c - e : e - last.c) / e) * 100 - FEE_RT * 100, mfe, mae };
}

const now = Date.now();
const graded = [], pending = [];
for (const r of rows) {
  if (now - r.ts < MIN_AGE_H * 3600e3) { pending.push(r); continue; }
  const end = Math.min(now, r.ts + HORIZON_H * 3600e3);
  try {
    const bars = await candles(r.sym, r.ts, end);
    if (!bars.length) { pending.push(r); continue; }
    const g = gradeShadow(r, bars);
    if (g) graded.push({ ...r, ...g });
  } catch (e) { console.log(`${r.sym}: grade fail ${e.message.slice(0, 60)}`); pending.push(r); }
}

// cohort B — real closed episodes overlapping the shadow window
let real = { n: 0, netUsd: 0, wr: 0 };
try {
  const fills = (JSON.parse(fs.readFileSync(FILLS, 'utf8')).fills || []);
  const win0 = rows.length ? Math.min(...rows.map((r) => r.ts)) : now;
  const cl = fills.filter((f) => f.tradeSide === 'close' && (f.ts || 0) >= win0);
  const nets = cl.map((f) => (+f.profit || 0) - (+f.fee || 0));
  real = { n: cl.length, netUsd: +nets.reduce((a, x) => a + x, 0).toFixed(2), wr: cl.length ? +(nets.filter((x) => x > 0).length / cl.length * 100).toFixed(1) : 0 };
} catch {}

const byGate = {};
for (const g of graded) {
  const k = `${g.src}:${g.gate}`;
  (byGate[k] ??= { n: 0, wins: 0, netPct: 0, outcomes: {} });
  byGate[k].n++; byGate[k].netPct += g.netPct;
  if (g.netPct > 0) byGate[k].wins++;
  byGate[k].outcomes[g.outcome] = (byGate[k].outcomes[g.outcome] || 0) + 1;
}
for (const k of Object.keys(byGate)) {
  byGate[k].meanNetPct = +(byGate[k].netPct / byGate[k].n).toFixed(3);
  byGate[k].wr = +(byGate[k].wins / byGate[k].n * 100).toFixed(1);
}

const verdict = graded.length >= 10
  ? (graded.reduce((a, g) => a + g.netPct, 0) / graded.length < 0
      ? 'gate net-positive — blocked trades would have lost on average'
      : 'gate net-negative — blocked trades would have won on average')
  : 'insufficient shadow sample — keep collecting';

const out = {
  ts: new Date().toISOString(),
  method: 'frozen-rule counterfactual on real forward tape; stop wins intra-candle ties; 0.12% RT fees; 24h window',
  shadowRows: rows.length, graded: graded.length, pending: pending.length,
  blockedWouldHave: byGate,
  allowedCohort: real,
  verdict,
  sample: graded.slice(-20).map((g) => ({ ts: new Date(g.ts).toISOString(), sym: g.sym, side: g.side, gate: g.gate, out: g.outcome, netPct: +g.netPct.toFixed(2) })),
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`graded ${graded.length} shadow rows (${pending.length} pending) — ${verdict}`);
for (const [k, v] of Object.entries(byGate)) console.log(`  ${k}: n=${v.n} wr=${v.wr}% meanNet=${v.meanNetPct}%`);
