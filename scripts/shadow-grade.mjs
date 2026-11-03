// shadow-grade.mjs — forward-grade every pattern-census emission honestly.
// Reads state/pattern-census.jsonl (emitted by the exec's shadow census),
// pulls 15m candles after each emit, and measures:
//   stopped:  adverse side touched slPx first -> full stop loss
//   timeout:  +24h horizon exit at last close
//   markouts: net % at +1h / +4h / horizon, net of 0.12% round-trip
// Aggregates per (pattern:side) cell -> state/shadow-policy.json
//   promoted: n>=15, meanNet>0, SQN>0.5 — the measured bar a cell must earn.
// Emitted rows dedupe by ts+sym+pattern — already-graded rows are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, '..', 'state');
const CENSUS = path.join(STATE, 'pattern-census.jsonl');
const GRADES = path.join(STATE, 'shadow-grades.jsonl');
const POLICY = path.join(STATE, 'shadow-policy.json');
const FEE_RT = 0.12;            // round-trip taker floor, %
const HORIZON_BARS = 96;        // 15m bars = 24h
const MIN_N = 15, MIN_SQ = 0.5;

const klinesCache = new Map();
async function candles(sym, startMs) {
  const key = `${sym}:${Math.floor(startMs / 36e5)}`;
  if (klinesCache.has(key)) return klinesCache.get(key);
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=15m&startTime=${startMs}&endTime=${startMs + HORIZON_BARS * 900e3}&limit=100`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const rows = (j.data || []).map((c) => ({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] })).sort((a, b) => a.t - b.t);
    klinesCache.set(key, rows);
    return rows;
  } catch { klinesCache.set(key, []); return []; }
}

const stats = (arr) => {
  const n = arr.length; if (!n) return { n: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, wr: +(arr.filter((x) => x > 0).length / n * 100).toFixed(1), meanNetPct: +mean.toFixed(3), sqn: +(n >= 30 && sd > 1e-9 * Math.max(1, Math.abs(mean)) ? mean / sd * Math.sqrt(Math.min(n, 100)) : 0 /* sqn-guard */).toFixed(2), netSum: +arr.reduce((a, b) => a + b, 0).toFixed(2) };
};

const seen = new Set();
try { for (const l of fs.readFileSync(GRADES, 'utf8').split('\n')) { const j = JSON.parse(l || 'null'); if (j) seen.add(`${j.ts}:${j.sym}:${j.pattern}:${j.side}`); } } catch {}

const out = fs.createWriteStream(GRADES, { flags: 'a' });
const cells = {};
let graded = 0;

for (const l of fs.readFileSync(CENSUS, 'utf8').split('\n')) {
  if (!l.trim()) continue;
  let j; try { j = JSON.parse(l); } catch { continue; }
  const { ts, sym, side, pattern, entryPx, slPx } = j || {};
  const k = `${ts}:${sym}:${pattern}:${side}`;
  if (!ts || !sym || !entryPx || !slPx || seen.has(k)) continue;
  if (Date.now() - ts < 36e5) continue;              // needs >=1h of tape to mean anything
  const rows = await candles(sym, ts);
  if (rows.length < 4) continue;
  const dir = side === 'short' ? -1 : 1;
  const adv = side === 'short' ? (r) => r.h >= slPx : (r) => r.l <= slPx;
  let exit = null, why = 'horizon';
  for (const r of rows) {
    if (r.t <= ts) continue;
    if (adv(r)) { exit = slPx; why = 'stopped'; break; }
    exit = r.c;
  }
  if (exit == null) continue;
  const m1 = rows.find((r) => r.t > ts + 36e5)?.c ?? rows.at(-1)?.c;
  const m4 = rows.find((r) => r.t > ts + 144e5)?.c ?? rows.at(-1)?.c;
  const net = (x) => +(dir * (x - entryPx) / entryPx * 100 - FEE_RT).toFixed(3);
  const g = { ts, sym, side, pattern, entryPx, slPx, why, net1h: m1 ? net(m1) : null, net4h: m4 ? net(m4) : null, netHorizon: net(exit) };
  out.write(JSON.stringify(g) + '\n');
  graded++;
  if (graded % 25 === 0) await new Promise((r) => setTimeout(r, 400)); // rate-kind
}
out.end();

// fold historical grades into the cell totals too (policy needs the full book)
try {
  for (const l of fs.readFileSync(GRADES, 'utf8').split('\n')) {
    const j = JSON.parse(l || 'null'); if (!j) continue;
    const v = j.netHorizon ?? j.netPct;
    if (!Number.isFinite(+v)) continue;
    const name = j.pattern || (j.factors && j.factors[0]) || (j.led || 'unpatterned');
    const ck = `${name}:${j.side || '?'}`;
    (cells[ck] ||= []).push(+v);
  }
} catch {}

const policy = { at: new Date().toISOString(), bar: { minN: MIN_N, minSqn: MIN_SQ }, cells: {}, promoted: {} };
for (const [ck, arr] of Object.entries(cells)) {
  const s = stats(arr);
  policy.cells[ck] = s;
  if (ck.endsWith(':short') && s.n >= MIN_N && s.meanNetPct > 0 && s.sqn >= MIN_SQ) policy.promoted[ck.split(':')[0]] = s;
}
fs.writeFileSync(POLICY, JSON.stringify(policy, null, 1));
console.log(`graded ${graded} new rows | cells: ${Object.keys(cells).length} | promoted shorts: ${Object.keys(policy.promoted).join(', ') || 'none'}`);
