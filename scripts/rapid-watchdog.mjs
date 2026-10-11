// rapid-watchdog.mjs — the external supervisor god.mjs can't be (it runs
// inside the loop it watches). Timer-driven every 2min; two duties:
//
//   1. heartbeat stale > STALE_MS → the rapid loop is wedged somewhere its
//      own CHILD_TIMEOUT can't reach (dead spawn, hung fetch). Restart the
//      unit + journal an alert — a wedged daemon is how the book quietly
//      sits at zero positions for an hour.
//   2. zero positions with deployable free margin → the book is starved
//      while money sleeps. Alert (rate-limited) — entries may still be
//      legitimately gated, so this nudges, never forces.
//
// Always exits 0 — a watchdog crash must never wedge the timer.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const STALE_MS = +(process.env.WATCHDOG_STALE_MS || 12 * 60e3);   // > CHILD_TIMEOUT 600s + exec slack
const ALERT_COOLDOWN_MS = +(process.env.WATCHDOG_ALERT_MS || 30 * 60e3);

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alert = (text) => {
  try { fs.appendFileSync(path.join(STATE, 'tg-outbox.jsonl'), JSON.stringify({ ts: Date.now(), text }) + '\n'); } catch {}
  console.log('[watchdog]', text);
};

const wdPath = path.join(STATE, 'watchdog.json');
const wd = readJson(wdPath) || {};
const now = Date.now();
const canAlert = now - (+wd.lastAlertTs || 0) > ALERT_COOLDOWN_MS;
const note = (k, v) => { wd[k] = v; };

const hb = readJson(path.join(STATE, 'rapid-heartbeat.json'));
const hbAge = hb?.ts ? now - hb.ts : Infinity;
note('heartbeatAgeS', Number.isFinite(hbAge) ? Math.round(hbAge / 1e3) : null);

if (hbAge > STALE_MS) {
  // restart regardless of alert cooldown — a dead loop needs action even
  // when the last page is still warm. The cooldown only gates the noise.
  try {
    execSync('systemctl restart sentinel-rapid.service', { timeout: 30e3, stdio: 'ignore' });
    note('lastRestartAt', now); note('restarts', (+wd.restarts || 0) + 1);
    if (canAlert) { alert(`🚨 rapid heartbeat stale ${Math.round(hbAge / 6e4)}min — restarted sentinel-rapid (cycle ${hb?.cycle ?? '?'}, consecFails ${hb?.consecFails ?? '?'})`); note('lastAlertTs', now); }
  } catch (e) {
    note('lastRestartErr', String(e.message || e).slice(0, 120));
    if (canAlert) { alert(`🚨 rapid heartbeat stale AND restart failed: ${e.message}`); note('lastAlertTs', now); }
  }
} else {
  // healthy loop — now audit the empty-book condition
  const led = readJson(path.join(ROOT, 'api', 'live-ledger.json'));
  const ledAge = led?.refreshedAt ? now - Date.parse(led.refreshedAt) : Infinity;
  const open = Array.isArray(led?.positions) ? led.positions.length : null;
  const freeUsd = +led?.marginFreeUsd || 0;
  note('openPositions', open); note('marginFreeUsd', freeUsd);
  if (open === 0 && freeUsd > 1 && ledAge < 15 * 60e3 && canAlert) {
    alert(`⚠️ zero live positions with $${freeUsd.toFixed(2)} free margin — book starved (entries gated or min-size wall). Investigating is operator-domain; the mandate keeps trying each cycle.`);
    note('lastAlertTs', now);
  }
}

try { fs.writeFileSync(wdPath, JSON.stringify({ ...wd, ts: now })); } catch {}
process.exit(0);
