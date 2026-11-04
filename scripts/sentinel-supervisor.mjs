// sentinel-supervisor.mjs — the deterministic 24/7 ops layer (deployed
// 2026-10-26 under the operator's "migrate everything to a 24/7 agent" order).
// Runs on a 10min systemd timer. Five duties, all mechanical — judgment calls
// (gate changes, sizing policy, code edits) stay with the agent/operator:
//
//   1. SERVICE HEALTH — every sentinel unit expected active gets checked;
//      dead units auto-restart (bounded: services only, never policy files).
//   2. ORPHAN SWEEP — untriggered TP/SL/entry legs on dead seats are
//      reduce-only dead letters the venue never cleans; cancel them so the
//      open-orders surface stays truthful.
//   3. MODE AUDIT — ledger mode/exchange vs unit env vs .env; drift (e.g. an
//      unexpected live flip) pages ops immediately.
//   4. EVIDENCE SNAPSHOT — alltime-stats cell table → api/supervisor-report.json
//      for the dashboard; fills-journal integrity (demo must never appear in
//      real-fills).
//   5. OPS DIGEST — a compact status line to the ops outbox every digest
//      window (rate-limited; anomalies always report regardless).
//
// Always exits 0 — a supervisor crash must never wedge the timer.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '/opt/sentinel/scripts/load-env.mjs';
import { makeExchange } from './exchange/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const API = path.join(ROOT, 'api');
const now = Date.now();
const DIGEST_MS = +(process.env.SUPERVISOR_DIGEST_MS || 6 * 3600e3);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch {} };

const svPath = path.join(STATE, 'supervisor.json');
const sv = readJson(svPath) || {};
const problems = [];
const notes = [];

const out = (text) => {
  try { fs.appendFileSync(path.join(STATE, 'tg-outbox.jsonl'), JSON.stringify({ ts: now, text, to: 'ops' }) + '\n'); } catch {}
  console.log('[supervisor]', text);
};

// ---- 1. service health ---------------------------------------------------
const EXPECTED = (process.env.SUPERVISOR_UNITS ||
  'sentinel-rapid,sentinel-bitget-watch,sentinel-liq-guard,sentinel-wealth-watch,sentinel-genius,sentinel-wife'
).split(',').map((s) => s.trim()).filter(Boolean);
const dead = [];
for (const u of EXPECTED) {
  try {
    const st = execSync(`systemctl is-active ${u} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (st !== 'active') {
      execSync(`systemctl restart ${u} 2>/dev/null || true`);
      const st2 = execSync(`systemctl is-active ${u} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      dead.push(`${u}:${st2}`);
      if (st2 === 'active') notes.push(`restarted ${u} (was ${st})`);
      else problems.push(`${u} down — restart failed (${st}→${st2})`);
    }
  } catch (e) { problems.push(`${u} health check failed: ${e.message.slice(0, 60)}`); }
}
// timers expected waiting/active
const EXPECTED_TIMERS = (process.env.SUPERVISOR_TIMERS ||
  'sentinel-forward-evidence.timer,sentinel-watchdog.timer,sentinel-bridge.timer,sentinel-shadow-grade.timer,sentinel-liq-ab.timer,sentinel-push.timer'
).split(',').map((s) => s.trim()).filter(Boolean);
for (const t of EXPECTED_TIMERS) {
  try {
    const st = execSync(`systemctl is-active ${t} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (st !== 'active') { execSync(`systemctl start ${t} 2>/dev/null || true`); notes.push(`started ${t} (was ${st})`); }
  } catch {}
}
sv.units = { checked: EXPECTED.length, dead: dead.length ? dead : 0, at: new Date(now).toISOString() };

// ---- 3. mode audit (before venue calls — cheap, catches drift early) -----
const ledger = readJson(path.join(API, 'live-ledger.json')) || {};
const envTxt = (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; } })();
const envExec = (envTxt.match(/^SENTINEL_EXEC=(\w+)/m) || [])[1];
const envX = (envTxt.match(/^SENTINEL_EXCHANGE=(\w+)/m) || [])[1];
sv.mode = { ledgerMode: ledger.mode, ledgerExchange: ledger.exchange, envExec, envX, equityUsd: ledger.equityUsd };
// two lanes (2026-11-04): sentinel-live-exec owns api/live-ledger.json and the
// demo lane writes api/live-ledger.demo<book>.json, so while the live lane is
// a supervised unit a live ledger next to a demo .env is the design, not drift
const liveLane = /(^|,)\s*sentinel-live-exec\s*(,|$)/.test(process.env.SUPERVISOR_UNITS || '');
sv.mode.liveLane = liveLane;
if (!liveLane && ledger.mode && envExec && ledger.mode !== envExec)
  problems.push(`mode drift — ledger '${ledger.mode}' vs .env '${envExec}' — verify which is real`);
if (!liveLane && ledger.mode === 'live' && envExec !== 'live')
  problems.push(`LIVE ledger while .env is ${envExec} — possible unauthorized live flip`);
if (liveLane && ledger.mode && ledger.mode !== 'live')
  problems.push(`live-ledger.json holds a '${ledger.mode}' book — a non-live lane is writing the live ledger`);
const rf = readJson(path.join(STATE, 'real-fills.json'));
const df = readJson(path.join(STATE, 'demo-fills-bybit.json'));
sv.journals = { realFills: rf?.fills?.length ?? null, demoFillsBybit: df?.fills?.length ?? null };
// demo contamination check: real-fills newest entry must predate demo switch
if (!liveLane && envExec === 'demo' && Array.isArray(rf?.fills) && rf.fills.length) {
  const lastRealTs = Math.max(...rf.fills.map((f) => +f.ts || 0));
  if (sv.lastRealTs != null && lastRealTs > sv.lastRealTs)
    problems.push(`real-fills grew while MODE=${envExec} — demo fills may be contaminating the live rail`);
  sv.lastRealTs = lastRealTs;
}

// ---- 2. orphan sweep -----------------------------------------------------
let sweep = { scanned: 0, cancelled: 0 };
try {
  const X = makeExchange({ ...process.env });
  const pos = await X.getPos().catch(() => []);
  const held = new Set((pos || []).map((p) => p.symbol));
  const syms = new Set(held);
  const setups = readJson(path.join(STATE, 'cmd-setups.json'));
  (Array.isArray(setups) ? setups : setups?.setups || Object.values(setups || {})).forEach((s) => s?.symbol && syms.add(s.symbol));
  (df?.fills || []).slice(-80).forEach((f) => f.symbol && syms.add(f.symbol));
  (rf?.fills || []).slice(-80).forEach((f) => f.symbol && syms.add(f.symbol));
  (ledger.actions || []).forEach((a) => { const m = String(a).match(/^([A-Z0-9]+USDT)/); if (m) syms.add(m[1]); });
  for (const s of syms) {
    const r = await X.api('GET', '/v5/order/realtime', { qs: `category=linear&symbol=${s}&openOnly=0&limit=50` }).catch(() => null);
    for (const o of (r?.list || [])) {
      sweep.scanned++;
      if (held.has(s)) continue;
      await X.cancelOrder(s, o.orderId).then(() => { sweep.cancelled++; }).catch(() => {});
    }
  }
  if (sweep.cancelled) notes.push(`orphan sweep — cancelled ${sweep.cancelled} untriggered legs on dead seats`);
} catch (e) { notes.push(`orphan sweep skipped: ${e.message.slice(0, 60)}`); }
sv.sweep = { ...sweep, at: new Date(now).toISOString() };

// ---- 4. evidence snapshot -------------------------------------------------
const at = readJson(path.join(API, 'alltime-stats.json')) || {};
const demoBook = at.books?.['bybit-demo'] || at.books?.['bitget-demo'] || {};
const demo = demoBook.byOwner?.bot || {};
const fams = at.families || {};
sv.evidence = {
  demoEpisodes: demo.episodes ?? null, demoNetUsd: demo.netUsd ?? null,
  demoWinRate: demo.winRatePct ?? null, demoSqN: demo.sqn ?? null,
  excluded: at.excludedEpisodes ?? 0,
  cellCount: Object.keys(fams).length,
};
sv.positions = (ledger.positionsAfter || []).map((p) => `${p.symbol}:${p.upl ?? '?'}`);
sv.at = new Date(now).toISOString();

// ---- 5. report + digest ---------------------------------------------------
writeJson(path.join(API, 'supervisor-report.json'), {
  refreshedAt: sv.at,
  mode: sv.mode, units: sv.units, sweep: sv.sweep,
  journals: sv.journals, evidence: sv.evidence, positions: sv.positions,
  problems, notes,
});
writeJson(svPath, sv);

for (const p of problems) out(`🚨 supervisor: ${p}`);
const dueDigest = now - (+sv.lastDigestTs || 0) > DIGEST_MS;
if (dueDigest || notes.length) {
  const npos = (ledger.positionsAfter || []).length;
  out(`📊 ${ledger.mode || '?'}/${ledger.exchange || '?'} eq $${(+ledger.equityUsd || 0).toFixed(0)} · ${npos} seats · demo eps ${sv.evidence.demoEpisodes ?? '?'} net $${(+sv.evidence.demoNetUsd || 0).toFixed(2)} SQN ${sv.evidence.demoSqN ?? '?'} · cells ${sv.evidence.cellCount}${dead.length ? ` · restarts ${dead.join(',')}` : ''}${sweep.cancelled ? ` · orphans -${sweep.cancelled}` : ''}`);
  if (dueDigest) { sv.lastDigestTs = now; writeJson(svPath, sv); }
}
process.exit(0);
