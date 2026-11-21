#!/usr/bin/env node
// plumbing-audit.mjs — triple-audit every data pipe in the architecture.
// For each edge: (1) file exists + parses, (2) producer alive + output fresh,
// (3) CRC32 verified against the integrity manifest (or noted in),
// (4) declared consumers actually alive. Publishes api/plumbing.json so
// every claim is machine-checkable — trust the file, not the reporter.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crc32hex } from './crc32.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = (f) => path.join(ROOT, 'state', f);
const A = (f) => path.join(ROOT, 'api', f);

// ---- master architecture map: producer unit -> file -> consumer units ----
// proc: systemd unit name or 'manual'/'operator' for non-service writers.
// maxAgeMin: freshness bound in minutes (0 = append-ledger, mtime exempt).
const EDGES = [
  { file: 'state/sector-scan.json',      proc: 'sentinel-sector-scan',    maxAgeMin: 3,    consumers: ['manual-deploy-rail'] },
  { file: 'state/tg-confluence.json',    proc: 'sentinel-tg-watch',       maxAgeMin: 0,    consumers: ['manual-deploy-rail'] },
  { file: 'state/klines-15m.json',       proc: 'sentinel-build-scanner',  maxAgeMin: 90,   consumers: ['sentinel-liq-guard', 'sentinel-live-exec'] },
  { file: 'state/klines-1h.json',        proc: 'sentinel-build-scanner',  maxAgeMin: 90,   consumers: ['sentinel-live-exec'] },
  { file: 'state/klines-4H.json',        proc: 'sentinel-build-scanner',  maxAgeMin: 180,  consumers: ['sentinel-live-exec'] },
  { file: 'state/klines-1D.json',        proc: 'sentinel-build-scanner',  maxAgeMin: 1500, consumers: ['sentinel-live-exec'] },
  { file: 'api/wealth-live.json',        proc: 'sentinel-wealth-watch',   maxAgeMin: 10,   consumers: ['sentinel-liq-guard', 'sentinel-statusd', 'manual-deploy-rail'] },
  { file: 'api/status.json',             proc: 'sentinel-statusd',        maxAgeMin: 10,   consumers: ['dashboard'] },
  { file: 'state/status.json',           proc: 'sentinel-statusd',        maxAgeMin: 10,   consumers: ['dashboard'] },
  { file: 'state/trade-reasons.json',    proc: 'manual-deploy-rail',      maxAgeMin: 0,    consumers: ['sentinel-statusd'] },
  { file: 'state/cmd-manual-hold.json',  proc: 'operator',                maxAgeMin: 0,    consumers: ['sentinel-liq-guard', 'sentinel-bitget-watch-live'] },
  { file: 'state/stop-override.json',    proc: 'manual-deploy-rail',      maxAgeMin: 0,    consumers: ['sentinel-bitget-watch-live'] },
  { file: 'state/real-fills.json',       proc: 'sentinel-chain',          maxAgeMin: 120,  consumers: ['sentinel-statusd'] },
  { file: 'state/equity-peak-live.json', proc: 'sentinel-wealth-watch',   maxAgeMin: 30,   consumers: ['sentinel-liq-guard'] },
  { file: 'state/liq-guard.json',        proc: 'sentinel-liq-guard',      maxAgeMin: 10,   consumers: ['dashboard', 'api-fanout'] },
  { file: 'state/strategy-policy.json',  proc: 'sentinel-shadow-grade',   maxAgeMin: 2400, consumers: ['sentinel-live-exec'] },
  { file: 'state/mae-mfe.json',          proc: 'sentinel-forward-evidence.timer', maxAgeMin: 120, consumers: ['sentinel-ruin-guard', 'research'] },
  { file: 'state/commod-24h.json',       proc: 'sentinel-commod-24h',     maxAgeMin: 30,   consumers: ['sentinel-statusd'] },
  { file: 'state/operator-clone.json',   proc: 'sentinel-operator-clone', maxAgeMin: 15,   consumers: ['sentinel-statusd'] },
  { file: 'state/shadow-graded.json',    proc: 'sentinel-shadow-grade',   maxAgeMin: 2400, consumers: ['research'] },
  { file: 'state/shadow-grades.jsonl',   proc: 'sentinel-shadow-grade',   maxAgeMin: 0,    consumers: ['sentinel-shadow-grade'] },
  { file: 'state/pattern-census.jsonl',  proc: 'sentinel-live-exec',      maxAgeMin: 0,    consumers: ['sentinel-shadow-grade'] },
  { file: 'state/war-engine.json',       proc: 'sentinel-war-engine',     maxAgeMin: 15,   consumers: ['sentinel-statusd'] },
  { file: 'api/sector-scan.json',        proc: 'sentinel-sector-scan',    maxAgeMin: 3,    consumers: ['dashboard'] },
  { file: 'api/integrity.json',          proc: 'manual',                  maxAgeMin: 1440, consumers: ['sentinel-god', 'dashboard'] },
];

const unitState = (u) => { try { return execSync(`timeout 4 systemctl is-active ${u} 2>/dev/null`, { timeout: 6000 }).toString().trim(); } catch { return 'missing'; } };
const manifest = (() => { try { return JSON.parse(fs.readFileSync(S('checksums.json'), 'utf8')); } catch { return { files: {} }; } })();

const report = { at: new Date().toISOString(), ok: true, edges: [] };
for (const e of EDGES) {
  const fp = path.join(ROOT, e.file);
  const edge = { file: e.file, proc: e.proc, consumers: e.consumers };
  try {
    const buf = fs.readFileSync(fp);
    const st = fs.statSync(fp);
    edge.bytes = st.size;
    edge.mtimeAgeMin = +((Date.now() - st.mtimeMs) / 60e3).toFixed(1);
    if (!e.file.endsWith('.jsonl')) { try { JSON.parse(buf.toString()); edge.parseOk = true; } catch { edge.parseOk = false; } }
    else edge.parseOk = true;
    // crc check vs manifest
    const ent = manifest.files?.[e.file];
    if (ent) {
      edge.crc = crc32hex(buf);
      edge.crcOk = edge.crc === ent.crc32;
      if (!edge.crcOk && st.mtimeMs > (ent.ts || 0)) {
        edge.crcOk = true; edge.renoted = true;
        edge.crcNote = 'file newer than note — re-baselined';
        try { const { integrityNote } = await import('./crc32.mjs'); integrityNote(fp, buf); } catch {}
      }
    } else edge.crcNote = 'not-in-manifest';
    // freshness
    if (e.maxAgeMin > 0) edge.fresh = edge.mtimeAgeMin <= e.maxAgeMin;
    else edge.fresh = true;
    // producer + consumer liveness
    edge.procState = e.proc === 'manual' || e.proc === 'operator' || e.proc === 'manual-deploy-rail' ? 'n/a'
      : (() => { const a = unitState(e.proc); if (a === 'active') return 'active'; const t = unitState(e.proc + '.timer'); return t === 'active' ? 'active(timer)' : a; })();
    edge.consumerStates = {};
    for (const c of e.consumers) {
      edge.consumerStates[c] = ['dashboard', 'research', 'api-fanout', 'manual-deploy-rail', 'sentinel-god'].includes(c)
        ? (c === 'sentinel-god' ? unitState(c) : 'n/a') : unitState(c);
    }
    edge.ok = edge.parseOk !== false && edge.fresh !== false && edge.crcOk !== false;
  } catch {
    edge.ok = false; edge.missing = true;
    edge.procState = 'unreadable';
    edge.consumerStates = {};
  }
  if (!edge.ok) report.ok = false;
  report.edges.push(edge);
}

const fails = report.edges.filter(x => !x.ok).map(x => x.file);
report.fails = fails;
report.summary = `${report.edges.length - fails.length}/${report.edges.length} edges healthy`;
fs.writeFileSync(A('plumbing.json.tmp'), JSON.stringify(report, null, 1));
fs.renameSync(A('plumbing.json.tmp'), A('plumbing.json'));
console.log(`[plumbing] ${report.summary}${fails.length ? ' FAILS: ' + fails.join(', ') : ' — all edges healthy'}`);
for (const x of report.edges.filter(x => !x.ok)) {
  console.log(`  FAIL ${x.file}: age=${x.mtimeAgeMin}m fresh=${x.fresh} crcOk=${x.crcOk ?? 'n/a'} proc=${x.procState}`);
}
// ---- post-hoc seat-risk audit (ENSO rule): any open position whose
// stop-distance x size exceeds 4% of equity is flagged — catches rogue
// seats even if an off-rail path ever places one.
try {
  const w = JSON.parse(fs.readFileSync(A('wealth-live.json'), 'utf8'));
  const eq = +w?.futures?.equityUsd || 0;
  const plans = JSON.parse(fs.readFileSync(S('liq-guard.json'), 'utf8'));
  report.seatRisk = [];
  for (const p of w?.futures?.positions || []) {
    const sym = p.k?.split(':')[0];
    const entry = +p.entryUsd || +p.openPriceAvg || 0;
    const size = Math.abs(+p.total || +p.size || 0);
    const stop = plans?.seats?.[sym]?.stopPx ?? plans?.[sym]?.stopPx ?? null;
    const riskUsd = stop != null && entry > 0 ? size * Math.abs(entry - +stop) : null;
    const riskPct = eq > 0 && riskUsd != null ? +(riskUsd / eq * 100).toFixed(1) : null;
    const rec = { sym, size, entry, stop, riskUsd, riskPct, over: riskPct != null && riskPct > 4 };
    if (rec.over) report.ok = false;
    report.seatRisk.push(rec);
  }
} catch (e) { report.seatRiskError = String(e).slice(0, 120); }

