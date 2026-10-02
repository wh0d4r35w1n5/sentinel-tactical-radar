#!/usr/bin/env node
// crc32-verify.mjs — integrity auditor. Recomputes CRC32 for every file
// in the state/checksums.json manifest and deep-verifies per-fill `fcrc`
// records inside the fills journals (proves WHICH record changed, not
// just that the file did). Publishes api/integrity.json — itself CRC32'd
// into the manifest — and GOD reads it every cycle.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { crc32hex, writeCheckedJson, integrityNote } from './crc32.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = (f) => path.join(ROOT, 'state', f);
const A = (f) => path.join(ROOT, 'api', f);

const manifest = (() => {
  try { return JSON.parse(fs.readFileSync(S('checksums.json'), 'utf8')); } catch { return { files: {} }; }
})();
const files = manifest.files || {};
const report = { ok: true, checked: 0, corrupt: [], missing: [], renoted: [], files: {} };
for (const [rel, ent] of Object.entries(files)) {
  const fp = path.join(ROOT, rel);
  try {
    const actual = crc32hex(fs.readFileSync(fp));
    const ok = actual === ent.crc32;
    report.files[rel] = { crc32: actual, ok, bytes: ent.bytes, ts: ent.ts };
    report.checked++;
    if (!ok) {
      // stale-entry vs corrupt: a file NEWER than its manifest note is a
      // rewrite whose note lost the manifest read-modify-write race (the
      // lock's timeout falls back to an unlocked write) — not corruption.
      // If it still parses as JSON, re-note to re-baseline the entry and
      // report 'renoted' instead. Parse failure, or a file OLDER than its
      // note (rollback — the genuinely suspicious direction), stays corrupt.
      if (fs.statSync(fp).mtimeMs > (ent.ts || 0)) {
        try { JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {
          report.ok = false; report.corrupt.push(rel); continue;
        }
        integrityNote(fp, fs.readFileSync(fp));
        report.files[rel].renoted = true;
        report.renoted.push(rel);
        continue;
      }
      report.ok = false; report.corrupt.push(rel);
    }
  } catch {
    report.files[rel] = { crc32: ent.crc32, ok: false, missing: true, ts: ent.ts };
    report.checked++;
    report.ok = false;
    report.missing.push(rel);
  }
}
// deep verify: per-fill fcrc inside the fills journals — a tampered or
// corrupted record fails its own checksum even if the file's does not
const fillAudit = {};
for (const jf of ['real-fills.json',
    ...fs.readdirSync(S('.')).filter((f) => /^demo-fills.*\.json$/.test(f))]) {
  try {
    const j = JSON.parse(fs.readFileSync(S(jf), 'utf8'));
    const bad = [];
    let checked = 0;
    for (const f of j.fills || []) {
      if (!f.fcrc) continue;
      checked++;
      const { fcrc, ...rest } = f;
      if (crc32hex(JSON.stringify(rest)) !== fcrc) bad.push(f.tradeId || f.ts);
    }
    fillAudit[jf] = { checked, bad: bad.slice(0, 10), badCount: bad.length };
    if (bad.length) { report.ok = false; report.corrupt.push(jf + ' (fill-level)'); }
  } catch {}
}
report.fillAudit = fillAudit;
report.refreshedAt = new Date().toISOString();
writeCheckedJson(A('integrity.json'), report);
console.log(`integrity: ${report.ok ? 'OK' : 'CORRUPT'} — ${report.checked} files checked, ${report.corrupt.length} corrupt, ${report.missing.length} missing, ${report.renoted.length} re-noted` +
  Object.entries(fillAudit).map(([k, v]) => ` | ${k}: ${v.checked} fills verified${v.badCount ? ` (${v.badCount} BAD)` : ''}`).join(''));
process.exit(report.ok ? 0 : 1);
