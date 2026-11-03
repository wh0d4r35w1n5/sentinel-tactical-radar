#!/usr/bin/env node
// ruin-guard — Satoshi §11 applied to the book (operator order 2026-10-15).
// Whitepaper: P(attacker catches up from z behind) = (q/p)^z for p>q.
// Trader version: P(equity hits the ruin line before N trades elapse),
// bootstrapped over the REAL per-lane episode return distribution —
// closed-form (q/p)^z ignores win/loss magnitudes, so Monte Carlo it is.
// Publishes state/ruin-budget.json: per-lane P(ruin) at current sizing +
// a max leverage such that P(ruin) <= 5% (the governor exec obeys), and a
// live-book block with the ruin probability of what's open RIGHT NOW.
process.env.SENTINEL_EXCHANGE='bitget'; process.env.SENTINEL_EXEC='live'; // .env carries bybit/demo — pin before makeExchange
import fs from 'fs';
import path from 'path';
const ROOT = '/opt/sentinel';
const eps = JSON.parse(fs.readFileSync(`${ROOT}/state/mae-mfe.json`, 'utf8')).episodes;
const FEE = 0.12;
const ret = e => ((e.side === 'short' ? (e.entry - e.exit) : (e.exit - e.entry)) / e.entry * 100) - FEE;
let acct = null;
try {
  const { makeExchange } = await import(`${ROOT}/scripts/exchange/index.mjs`);
  const X = makeExchange();
  const a = await X.getAccount();
  const pos = await X.getPos();
  acct = { equity: +a.equity, avail: +a.available, pos };
} catch { }
const E0 = acct?.equity || 5;
const RUIN = Math.max(0.5, E0 * 0.5);       // ruin = half the book
const N_SIM = 50000, T = 60;
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const mc = (rs, lev, frac) => {
  let ruined = 0;
  for (let i = 0; i < N_SIM; i++) {
    let E = E0;
    for (let t = 0; t < T; t++) { E += E * frac * lev * (rnd(rs) / 100); if (E <= RUIN) { ruined++; break; } }
  }
  return ruined / N_SIM;
};
const lanes = {};
const names = { 'sentinel-structure': 'structure', 'slot-deploy': 'slot-deploy', 'unattributed': 'manual/market', 'pump-short': 'pump-short' };
const dist = {};
for (const e of eps) (dist[e.strat] = dist[e.strat] || []).push(ret(e));
dist.__all = eps.map(ret);
for (const [strat, rs] of Object.entries(dist)) {
  if (rs.length < 8) continue;
  const p = rs.filter(r => r > 0).length / rs.length;
  const pRuin = mc(rs, 10, 0.5); // current structure-lane sizing
  let levCap = 1;
  for (const L of [50, 40, 30, 25, 20, 15, 10, 7.5, 5, 3, 2, 1]) {
    if (mc(rs, L, Math.min(1, 1.0)) <= 0.05) { levCap = L; break; }
  }
  lanes[strat] = { n: rs.length, p: +p.toFixed(3), pRuin60_at_10x_halfBook: +pRuin.toFixed(4), levCapFor5PctRuin: levCap };
}
// live book: ruin prob of the CURRENT open set at its actual lev/notional
let live = null;
if (acct) {
  let ruined = 0;
  const legs = acct.pos.map(p => ({ sym: p.symbol, strat: null, lev: +p.leverage || 10, frac: (+p.marginSize || 0) / Math.max(0.01, E0), side: p.holdSide }));
  for (const l of legs) l.dist = dist[l.sym === 'BTCUSDT' ? '__all' : '__all']; // per-symbol history too thin — all-episodes prior
  for (let i = 0; i < N_SIM; i++) {
    let E = E0;
    for (let t = 0; t < T; t++) {
      for (const l of legs) E += E * Math.min(1, l.frac) * l.lev * (rnd(l.dist) / 100) * (l.side === 'short' ? -1 : 1);
      if (E <= RUIN) { ruined++; break; }
    }
  }
  live = { positions: legs.map(l => `${l.sym}:${l.side} ${l.lev}x`), pRuin60_liveBook: +(ruined / N_SIM).toFixed(4), marginAtRisk: legs.reduce((a, l) => a + l.frac * E0, 0) };
}
const out = { at: Date.now(), equity: E0, ruinLine: RUIN, horizon: T, sims: N_SIM, lanes, live };
fs.writeFileSync(`${ROOT}/state/ruin-budget.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 2400));
