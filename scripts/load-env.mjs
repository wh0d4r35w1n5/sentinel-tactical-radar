// load-env.mjs — the single canonical .env loader for every sentinel script.
// Side-effect import only:
//   import './load-env.mjs';
// Populates process.env from <repo>/.env for keys not already set — real
// process env and systemd Environment= always win.
// Audit F2: any script reading SENTINEL_* / EXEC_* / GOD_* env MUST import
// this. A script that reads env without it silently reverts to hardcoded
// defaults (e.g. kill-switch re-arms at 8–35% dd).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(dir, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
