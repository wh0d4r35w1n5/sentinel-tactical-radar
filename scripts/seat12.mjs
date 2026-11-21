// op-direct-seat.mjs — operator-ordered direct entry (2026-11-14 "open trades now")
import { makeExchange } from './exchange/index.mjs';
import { openRiskEntry } from './risk-entry.mjs';
import fs from 'node:fs';

for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.SENTINEL_EXEC = 'live';
process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_LIVE = '1';
process.env.SENTINEL_OPEN_SEASON = '1';
process.env.SENTINEL_DEPLOY_ALL = '1';

const X = makeExchange(process.env);
X.setPosMode('hedge');
const cm = await X.contractMap();

const seats = [
  { symbol: 'SOPHUSDT', direction: 'LONG', strategy: 'devin-momentum',
    notionalUsd: 60, slPct: 0.030, tps: [{ pctOff: 0.035, pct: 50 }, { pctOff: 0.065, pct: 30 }, { pctOff: 0.095, pct: 20 }] },
  { symbol: 'BARDUSDT', direction: 'SHORT', strategy: 'Liquidity Sweep',
    notionalUsd: 60, slPct: 0.030, tps: [{ pctOff: 0.035, pct: 50 }, { pctOff: 0.065, pct: 30 }, { pctOff: 0.095, pct: 20 }] },
];

const out = [];
for (const s of seats) {
  const r = { symbol: s.symbol, dir: s.direction };
  try {
    const tk = await X.ticker(s.symbol);
    const last = +((Array.isArray(tk) ? tk[0] : tk)?.lastPr || 0);
    r.last = last;
    if (!(last > 0)) throw new Error('no mark');
    const slPx = s.direction === 'SHORT' ? last * (1 + s.slPct) : last * (1 - s.slPct);
    const tps = s.tps.map(t => ({
      px: +(s.direction === 'SHORT' ? last * (1 - t.pctOff) : last * (1 + t.pctOff)).toPrecision(8),
      pct: t.pct,
    }));
    const order = {
      symbol: s.symbol, direction: s.direction, strategy: s.strategy,
      refEntry: last, setup: true, slPx,
      absTps: tps, notionalUsd: s.notionalUsd, mode: 'market',
      setupId: 'op-direct-2026-11-14',
      note: 'operator order: deploy all capital; momentum pick, mark-anchored geometry',
    };
    const res = await openRiskEntry(X, order, cm[s.symbol], { riskScale: 1 });
    r.result = res && JSON.stringify(res).slice(0, 300);
    r.ok = true;
  } catch (e) {
    r.error = String(e?.message || e).slice(0, 240);
  }
  out.push(r);
}
console.log(JSON.stringify(out, null, 1));
