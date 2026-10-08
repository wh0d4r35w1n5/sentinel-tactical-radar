// rapid.mjs — local fast-path daemon. The CI pipeline (every ~10min) stays
// the deep-scan context layer; this loop is the trigger finger:
//   lean scan (Bitget-only intel, 16 candidates) → executor → sleep ~30s
// Same plan format, same executor, same risk rails — just not waiting on cron.
//
//   node scripts/rapid.mjs            # inert (RAPID_MODE unset -> off)
//   RAPID_MODE=demo node rapid.mjs    # paper trading on Bitget demo
//   RAPID_MODE=live node rapid.mjs    # real orders — VPS only
//   RAPID_MS=15000 node rapid.mjs     # custom cycle (min 5s enforced)
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// VIP telegram watcher runs alongside when configured — group signals land
// in state/tg-confluence.json and the scanner picks them up next cycle
const spawnTg = () => {
  if (process.env.SENTINEL_NO_TG === '1') return;
  if (!fs.existsSync('scripts/tg-config.json')) return;
  const tg = spawn('python', ['scripts/tg-watch.py'], { stdio: 'inherit' });
  // an unhandled 'error' event THROWS — a missing python would kill the
  // whole rapid daemon, not just the watcher
  let spawnFailed = false;
  tg.on('error', (e) => {
    spawnFailed = true; // ENOENT loops forever — a missing python is fatal config, not a crash
    console.log('[rapid] tg-watch spawn failed:', e.message);
  });
  tg.on('close', () => {
    if (spawnFailed) return;
    console.log('[rapid] tg-watch exited — restarting in 10s');
    setTimeout(spawnTg, 10_000);
  });
};
spawnTg();

const MS = Math.max(5_000, +(process.env.RAPID_MS || 30_000));
// default 'off', never 'live': an unconfigured spawn (stale autostart, a
// second box, a debugging run) must be inert — the VPS is the only
// component authorized to place orders, and it sets RAPID_MODE explicitly.
const MODE = (process.env.RAPID_MODE || 'off').toLowerCase();
const env = {
  ...process.env,
  SENTINEL_RAPID: '1',
  SENTINEL_EXEC: MODE,
  ...(MODE === 'live' ? { SENTINEL_LIVE: '1', CONFIRM_LIVE: 'YES' } : {}),
};

// a hung child must not stall the daemon forever — fetch timeouts bound most
// cases, but anything that escapes them gets a hard kill so the loop recovers
// instead of going silent. 600s: scans legitimately need 4-5min on this box
// (IO-throttled t3.micro) — a 240s cap killed the scanner before it could
// write live-plan.json, which starved exec and broke the whole loop.
const CHILD_TIMEOUT = 600_000;
const run = (f) =>
  new Promise((res) => {
    const c = spawn(process.execPath, [f], { env, stdio: 'inherit' });
    const killer = setTimeout(() => {
      console.log(`[rapid] ${f} exceeded ${CHILD_TIMEOUT / 1e3}s — killing`);
      c.kill('SIGKILL');
    }, CHILD_TIMEOUT);
    c.on('close', () => { clearTimeout(killer); res(); });
    c.on('error', () => { clearTimeout(killer); res(); });
  });

console.log(`[rapid] ${MODE.toUpperCase()} fast-loop — scan+exec every ${Math.round(MS / 1e3)}s — ctrl-c to stop`);
let cycle = 0, consecFails = 0, lastErr = null;
for (;;) {
  const t = Date.now();
  cycle++;
  // heartbeat — the ledger only writes when the exec phase runs, and a big
  // scan can legitimately hold it off for minutes. god.mjs reads this file
  // for "is the loop alive"; ledger age alone can't answer that question.
  // consecFails/lastErr expose a death spiral — N straight broken cycles is
  // a paged event, not just a journal line.
  try { fs.writeFileSync('state/rapid-heartbeat.json', JSON.stringify({ ts: Date.now(), cycle, consecFails, lastErr })); } catch {}
  let tScan = 0, tExec = 0;
  try {
    const a = Date.now(); await run('scripts/build-scanner.mjs'); tScan = Date.now() - a;
    const b = Date.now(); await run('scripts/bitget-exec.mjs'); tExec = Date.now() - b;
    await run('scripts/god.mjs').catch((e) => console.log('[rapid] god:', e.message || e));
    await run('scripts/thoughts.mjs').catch((e) => console.log('[rapid] thoughts:', e.message || e));
    consecFails = 0; lastErr = null;
  } catch (e) {
    consecFails++;
    lastErr = String(e.message || e).slice(0, 120);
    console.log(`[rapid] cycle ${cycle} error (${consecFails} straight):`, e.message || e);
    if (consecFails >= 5)
      try { fs.appendFileSync('state/tg-outbox.jsonl', JSON.stringify({ ts: Date.now(), text: `🚨 RAPID DEATH SPIRAL — ${consecFails} consecutive failed cycles: ${lastErr}` }) + '\n'); } catch {}
  }
  const dt = Date.now() - t;
  const wait = Math.max(1_000, MS - dt);
  console.log(`[rapid] cycle ${cycle} done in ${(dt / 1e3).toFixed(1)}s (scan ${(tScan / 1e3).toFixed(1)}s + exec ${(tExec / 1e3).toFixed(1)}s) — next in ${Math.round(wait / 1e3)}s`);
  await new Promise((r) => setTimeout(r, wait));
}
