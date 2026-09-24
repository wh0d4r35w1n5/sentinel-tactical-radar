// rapid.mjs — local fast-path daemon. The CI pipeline (every ~10min) stays
// the deep-scan context layer; this loop is the trigger finger:
//   lean scan (Bitget-only intel, 16 candidates) → executor → sleep ~30s
// Same plan format, same executor, same risk rails — just not waiting on cron.
//
//   node scripts/rapid.mjs            # live mode (default)
//   RAPID_MODE=demo node rapid.mjs    # dry-run on Bitget demo
//   RAPID_MS=15000 node rapid.mjs     # custom cycle (min 5s enforced)
import { spawn } from 'node:child_process';

const MS = Math.max(5_000, +(process.env.RAPID_MS || 30_000));
const MODE = (process.env.RAPID_MODE || 'live').toLowerCase();
const env = {
  ...process.env,
  SENTINEL_RAPID: '1',
  SENTINEL_EXEC: MODE,
  LIVE_FLOOR_MIN: '1',
  ...(MODE === 'live' ? { SENTINEL_LIVE: '1', CONFIRM_LIVE: 'YES' } : {}),
};

const run = (f) =>
  new Promise((res) => {
    const c = spawn(process.execPath, [f], { env, stdio: 'inherit' });
    c.on('close', res);
    c.on('error', res);
  });

console.log(`[rapid] ${MODE.toUpperCase()} fast-loop — scan+exec every ${Math.round(MS / 1e3)}s — ctrl-c to stop`);
let cycle = 0;
for (;;) {
  const t = Date.now();
  cycle++;
  try {
    await run('scripts/build-scanner.mjs');
    await run('scripts/bitget-exec.mjs');
  } catch (e) {
    console.log(`[rapid] cycle ${cycle} error:`, e.message || e);
  }
  const dt = Date.now() - t;
  const wait = Math.max(1_000, MS - dt);
  console.log(`[rapid] cycle ${cycle} done in ${(dt / 1e3).toFixed(1)}s — next in ${Math.round(wait / 1e3)}s`);
  await new Promise((r) => setTimeout(r, wait));
}
