#!/usr/bin/env node
// research-engine.mjs — 24/7 ITIL-v4-style change pipeline for Sentinel.
// RFCs arrive as hypotheses (state/research-hypotheses.json) or are
// auto-proposed from evidence; each travels:
//   submitted -> assessing -> approved|rejected -> implementing -> reviewing -> closed|reverted
// Auto-implementation is bounded to declared classes with declared bounds;
// every write captures the previous value for auto-revert at PIR.
// NEVER paths (convictions, manual seats, secrets, code) refuse outright.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MS = Math.max(60_000, +(process.env.RESEARCH_ENGINE_MS || 900_000));
const LEDGER = path.join(ROOT, 'state', 'change-ledger.json');
const HYPO = path.join(ROOT, 'state', 'research-hypotheses.json');
const TAG = () => `[research ${new Date().toISOString().slice(11, 19)}]`;

const rj = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wj = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };

// ---- CAB rules: what the engine may change without a human ---------------
// key: state file (relative). value: {fields: {path: {min,max}}, never: [paths]}
const WRITABLE = {
  'state/execution-risk.json': {
    fields: {
      riskPerTradeFraction: { min: 0.005, max: 0.05 },
      maxPortfolioRiskFraction: { min: 0.02, max: 0.2 },
      maxPositionNotionalMultiple: { min: 0.1, max: 2 },
      maxGrossNotionalMultiple: { min: 0.5, max: 8 },
      cashReserveFraction: { min: 0, max: 0.5 },
      minLeverage: { min: 1, max: 25 },
      maxLeverage: { min: 1, max: 25 },
    },
    never: ['requireForwardEvidence', 'exitModel', 'allowTopUps', 'allowOnchainEntries', 'version'],
  },
  'state/open-season.json': { fields: { enabled: { any: [true, false] } }, never: [] },
  'state/rr-config.json': { fields: { '*': { min: 0.05, max: 20 } }, never: [] },
};
const NEVER_RE = /manual|secret|key|token|env|convict|abandon|halt|wallet|pem/i;

// ---- lifecycle ------------------------------------------------------------
const uid = () => 'RFC-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const ledger = () => rj(LEDGER, { rfcs: [] }) || { rfcs: [] };
const log = (r, to, why) => {
  r.state = to; (r.history = r.history || []).push({ to, at: Date.now(), why });
  console.log(TAG(), r.id, '->', to, '—', why);
};

function assess(r) {
  if (r.class === 'code') return log(r, 'awaiting-operator', 'code changes never auto-implement');
  if (r.class === 'shadow') return log(r, 'reviewing', 'shadow proposal — recorded for grading only');
  if (r.class !== 'state-knob' && r.class !== 'evidence-promote')
    return log(r, 'rejected', `unknown class ${r.class}`);
  const spec = WRITABLE[r.target];
  if (!spec) return log(r, 'rejected', `target ${r.target} not writable`);
  for (const [k] of Object.entries(r.params || {})) {
    if (NEVER_RE.test(k) || spec.never.includes(k)) return log(r, 'rejected', `field ${k} is a never-path`);
    const b = spec.fields[k] ?? spec.fields['*'];
    if (!b) return log(r, 'rejected', `field ${k} has no declared bounds`);
    const v = r.params[k];
    if (b.any ? !b.any.includes(v) : !(+v >= b.min && +v <= b.max))
      return log(r, 'rejected', `${k}=${v} outside bounds ${JSON.stringify(b)}`);
  }
  if (r.class === 'evidence-promote') {
    const ev = rj(path.join(ROOT, 'api', 'forward-evidence.json'));
    const eps = ev?.episodes?.length ?? ev?.n ?? 0;
    if (eps < 30) return log(r, 'rejected', `evidence bar unmet: ${eps} independent episodes < 30`);
  }
  log(r, 'approved', 'CAB rules pass: bounded class, inside declared bounds, no never-paths');
}

function implement(r, led) {
  const f = path.join(ROOT, r.target);
  const cur = rj(f, {});
  r.prior = {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(r.params)) { r.prior[k] = cur[k]; next[k] = v; }
  wj(f, next);
  const chk = rj(f);
  const ok = Object.entries(r.params).every(([k, v]) => chk[k] === v);
  if (!ok) { for (const [k, v] of Object.entries(r.prior)) next[k] = v; wj(f, next); return log(r, 'rejected', 'post-write readback mismatch — rolled back'); }
  r.implementedAt = Date.now();
  r.reviewAt = r.reviewAt || Date.now() + (+(r.reviewHours || 24) * 3600e3);
  r.baseline = { equity: rj(path.join(ROOT, 'api', 'wealth-live.json'))?.futures?.equityUsd ?? null, at: Date.now() };
  log(r, 'reviewing', `implemented ${r.target} ${JSON.stringify(r.params)} — PIR at ${new Date(r.reviewAt).toISOString()}`);
}

function review(r) {
  if (r.class === 'shadow' || !r.reviewAt || Date.now() < r.reviewAt) return;
  const eq = rj(path.join(ROOT, 'api', 'wealth-live.json'))?.futures?.equityUsd;
  const base = r.baseline?.equity;
  if (base != null && eq != null && eq < base * (1 - (+(r.revertIfEquityDownPct ?? 2) / 100))) {
    const f = path.join(ROOT, r.target);
    const cur = rj(f, {});
    for (const [k, v] of Object.entries(r.prior || {})) cur[k] = v;
    wj(f, cur);
    return log(r, 'reverted', `PIR: equity ${eq} < baseline ${base} (-${r.revertIfEquityDownPct ?? 2}%) — prior values restored`);
  }
  log(r, 'closed', `PIR: held or improved (eq ${eq ?? '?'} vs baseline ${base ?? '?'})`);
}

function propose(led) {
  // auto-proposal lane: evidence-driven hypotheses generated by the engine.
  const fe = rj(path.join(ROOT, 'api', 'forward-evidence.json'));
  const cells = fe?.cells || {};
  for (const [cell, c] of Object.entries(cells)) {
    const ep = +c?.episodes || 0, mean = +(c?.mean ?? c?.netAfterCost ?? 0);
    if (ep >= 30 && mean > 0 && !led.rfcs.some((x) => x.auto && x.cell === cell && x.state !== 'closed' && x.state !== 'reverted'))
      led.rfcs.push({ id: uid(), auto: true, cell, class: 'shadow', title: `cell ${cell} meets promotion evidence (n=${ep}, mean ${mean}%)`, state: 'submitted', history: [] });
  }
}

function tick() {
  const led = ledger();
  for (const h of rj(HYPO, []) || []) {
    if (!h.id || led.rfcs.some((x) => x.id === h.id)) continue;
    led.rfcs.push({ ...h, state: 'submitted', history: [{ to: 'submitted', at: Date.now(), why: h.source || 'hypothesis queue' }] });
  }
  propose(led);
  for (const r of led.rfcs) {
    if (r.state === 'submitted' || r.state === 'assessing') assess(r);
    else if (r.state === 'approved') implement(r, led);
    else if (r.state === 'reviewing') review(r);
  }
  wj(LEDGER, led);
  try { wj(path.join(ROOT, 'api', 'change-ledger.json'), { at: new Date().toISOString(), counts: led.rfcs.reduce((a, x) => (a[x.state] = (a[x.state] || 0) + 1, a), {}), rfcs: led.rfcs.slice(-50) }); } catch {}
}

console.log(TAG(), 'starting — ITIL change pipeline, cycle', MS / 60000, 'min');
tick();
setInterval(tick, MS);
