// trades-taken.mjs — standalone episode reconstruction for api/trades-taken.json.
// Extracted from build-scanner.mjs: the scanner's tail (health + trades-taken)
// sits ~1400 lines past live-plan.json, and scans on this box exceed rapid's
// CHILD_TIMEOUT (900s) — the scanner gets SIGKILLed mid-tail every cycle, so
// the evidence gallery's Bot 1 (Bitget fills) feed froze. This runs on its own
// timer every 10min and rewrites the file in <2s — independent of the scan.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'api');
const STATE = path.join(ROOT, 'state');
const BOOK_TAG =
  (process.env.SENTINEL_EXEC || '').toLowerCase() === 'demo'
    ? `-${(process.env.SENTINEL_EXCHANGE || '').toLowerCase()}`
    : '';
const FILLS_FILE =
  (process.env.SENTINEL_EXEC || '').toLowerCase() === 'demo'
    ? `demo-fills${BOOK_TAG}.json`
    : 'real-fills.json';
// FILLS_SINCE: .env is the epoch's home, but the whole file can't ride
// EnvironmentFile — it also carries SENTINEL_EXEC=demo / EXCHANGE=bybit which
// would flip FILLS_FILE onto the demo book. Read just the epoch key.
const envEpoch = (() => {
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
      .match(/^\s*SENTINEL_FILLS_SINCE_MS\s*=\s*(\d+)/m);
    return m ? +m[1] : 0;
  } catch { return 0; }
})();
const FILLS_SINCE = +(process.env.SENTINEL_FILLS_SINCE_MS || 0) || envEpoch;
const pct = (v, p = 1e6) => Math.round(v * p) / p;

const readJson = (p, fb) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
};
const writeJson = (p, obj) => {
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
  fs.renameSync(p + '.tmp', p);
};

const fills = (readJson(path.join(STATE, FILLS_FILE), {}).fills || [])
  .filter((f) => !FILLS_SINCE || (+f.ts || 0) >= FILLS_SINCE);

const bySym = {};
for (const f of [...fills].sort((a, b) => a.ts - b.ts))
  (bySym[f.symbol + '|' + f.side] = bySym[f.symbol + '|' + f.side] || []).push(f);

// signal linkage — same provenance matching as build-scanner
const evRecs2 = readJson(path.join(API, 'signal-eval.json'), {}).records || [];
const linkSignal = (symbol, dir, entryPx, entryTs) => {
  const base = symbol.replace(/USDT$/, '');
  let best = null;
  for (const r of evRecs2) {
    if (r.asset !== base || r.direction !== dir || !r.entry || !r.runTs) continue;
    const dt = entryTs - r.runTs;
    if (dt < -5 * 60e3 || dt > 20 * 60e3) continue;
    const pd = Math.abs(r.entry - entryPx) / entryPx;
    if (pd > 0.015) continue;
    const score = pd * 1e6 + Math.abs(dt);
    if (!best || score < best.score) best = { r, score };
  }
  return best ? { strategy: best.r.strategy, score: best.r.score, grade: best.r.grade, runTs: best.r.runTs } : null;
};
const entryLog = readJson(path.join(API, 'live-ledger.json'), {}).entriesLog || [];
const linkSetup = (symbol, dir, entryTs) => {
  let best = null;
  for (const e of entryLog) {
    if (!e.setupId || e.symbol !== symbol || e.direction !== dir || !e.ts) continue;
    const dt = Math.abs(e.ts - entryTs);
    if (dt > 10 * 60e3) continue;
    if (!best || dt < best.dt) best = { e, dt };
  }
  return best
    ? { strategy: best.e.strategy || 'vema-setup', setupId: best.e.setupId, setupMode: best.e.setupMode || null, note: best.e.note || null }
    : null;
};

const trades = [];
for (const [k, list] of Object.entries(bySym)) {
  const [symbol, side] = k.split('|');
  let ep = null;
  const finish = (last) => {
    const entryPx = ep.cost0 / ep.qty0;
    const exitPx = ep.closeQty > 0 ? ep.closeCost / ep.closeQty : null;
    const sgn = side === 'sell' ? -1 : 1;
    const t = {
      symbol, dir: side === 'sell' ? 'SHORT' : 'LONG',
      entryTs: ep.ts, exitTs: last ? last.ts : null,
      status: last ? undefined : 'open',
      entryPx: pct(entryPx),
      exitPx: exitPx != null ? pct(exitPx) : null,
      qty: ep.qty0,
      notional: pct(ep.notional0, 100),
      fees: pct(ep.fees),
      pnl: pct(ep.pnl, 1e4),
      net: pct(ep.pnl - ep.fees, 1e4),
      pnlPct: entryPx > 0 && exitPx != null ? pct((exitPx - entryPx) / entryPx * sgn * 100, 100) : null,
      holdMin: last ? pct((last.ts - ep.ts) / 60000, 10) : pct((Date.now() - ep.ts) / 60000, 10),
      exits: ep.exits,
    };
    const sig = linkSetup(symbol, t.dir, ep.ts) || linkSignal(symbol, t.dir, entryPx, ep.ts);
    if (sig) Object.assign(t, sig);
    trades.push(t);
    ep = null;
  };
  for (const f of list) {
    const px = +f.price || 0, qty = +f.size || 0, fee = +f.fee || 0, pnl = +f.profit || 0;
    if (f.tradeSide === 'open') {
      if (!ep) ep = { ts: f.ts, qty: 0, qty0: 0, cost0: 0, notional0: 0, fees: 0, pnl: 0, closeQty: 0, closeCost: 0, exits: [] };
      ep.qty += qty; ep.qty0 += qty; ep.cost0 += px * qty; ep.fees += fee; ep.notional0 += qty * px;
    } else if (f.tradeSide === 'close' && ep && ep.qty > 0) {
      const portion = Math.min(qty, ep.qty);
      const frac = qty > 0 ? portion / qty : 1;
      ep.closeQty += portion; ep.closeCost += px * portion;
      ep.fees += fee * frac; ep.pnl += pnl * frac;
      ep.exits.push({ ts: f.ts, px, qty: portion, pnl: pct(pnl * frac, 1e4) });
      ep.qty -= portion;
      if (ep.qty <= 1e-9) finish(f);
    }
  }
  if (ep) finish(null);
}
trades.sort((a, b) => (b.exitTs ?? b.entryTs) - (a.exitTs ?? a.entryTs));
const closed = trades.filter((t) => t.exitTs);
writeJson(path.join(API, 'trades-taken.json'), {
  generated: new Date().toISOString(),
  trades,
  stats: {
    scope: 'reconstructed position episodes — laddered tranches merged; foreign fills included but unattributed',
    n: closed.length,
    wins: closed.filter((t) => t.net > 0).length,
    net: pct(closed.reduce((a, t) => a + t.net, 0), 100),
    fees: pct(closed.reduce((a, t) => a + t.fees, 0), 100),
    open: trades.filter((t) => t.status === 'open').length,
  },
});
console.log(`trades-taken: ${trades.length} episodes (${closed.length} closed) from ${fills.length} fills`);
