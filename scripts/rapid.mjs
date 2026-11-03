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
const CHILD_TIMEOUT = +(process.env.RAPID_CHILD_TIMEOUT_MS || 900_000); // scans legitimately need 600s+ on this IO-throttled box — 900s bounds true hangs without killing healthy slow cycles
const SCAN_MEM_MB = +(process.env.RAPID_SCAN_MEM_MB || 1400);
// heap must live inside the cgroup with room for non-heap node overhead —
// measured 1035MB peak RSS on a clean 1200MB-heap run, so 1400 cage / 1150
// heap leaves ~250MB of non-heap headroom. The argv flag beats NODE_OPTIONS:
// zzz-heap.conf's 1408 never reached this child and it SIGABRT'd at 700MB.
const SCAN_HEAP_MB = +(process.env.RAPID_SCAN_HEAP_MB || Math.max(700, SCAN_MEM_MB - 250));
const run = (f) =>
  new Promise((res) => {
    // scanner gets its own cgroup — ~1GB RSS on a 1.9GB box kept tripping
    // the kernel OOM killer, starving SSH/exec. Scope dies alone; V8 heap
    // capped first so it exits with a loggable error before the kernel acts.
    const cage = f === 'scripts/build-scanner.mjs';
    const unit = `sentinel-scan-${Date.now()}.scope`;
    const c = cage
      ? spawn('systemd-run', ['--scope', '--quiet', '--collect', '-p', `MemoryMax=${SCAN_MEM_MB}M`, '--unit', unit, process.execPath, `--max-old-space-size=${SCAN_HEAP_MB}`, f], { env, stdio: 'inherit' })
      : spawn(process.execPath, [f], { env, stdio: 'inherit' });
    const killer = setTimeout(() => {
      console.log(`[rapid] ${f} exceeded ${CHILD_TIMEOUT / 1e3}s — killing`);
      if (cage) { try { spawn('systemctl', ['kill', '--signal=SIGKILL', unit]); } catch {} }
      c.kill('SIGKILL');
    }, CHILD_TIMEOUT);
    // resolve with exit info — a crashed/killed child must surface as a
    // failed cycle (heartbeat + death-spiral alert), not silently count as
    // healthy. Exec still runs after a scanner crash: positions need
    // managing even when intelligence is down.
    c.on('close', (code, sig) => { clearTimeout(killer); res({ f, code, sig }); });
    c.on('error', (e) => { clearTimeout(killer); res({ f, err: e }); });
  });

console.log(`[rapid] ${MODE.toUpperCase()} fast-loop — scan+exec every ${Math.round(MS / 1e3)}s — ctrl-c to stop`);
const HEAVY_MS = +(process.env.RAPID_HEAVY_MS || 10 * 60_000);
let cycle = 0, consecFails = 0, lastErr = null, lastHeavy = 0;
for (;;) {
  const t = Date.now();
  cycle++;
  // heartbeat — the ledger only writes when the exec phase runs, and a big
  // scan can legitimately hold it off for minutes. god.mjs reads this file
  // for "is the loop alive"; ledger age alone can't answer that question.
  // consecFails/lastErr expose a death spiral — N straight broken cycles is
  // a paged event, not just a journal line. Beats fire BETWEEN children as
  // well as at loop top: the watchdog's 12min stale kill used to land
  // mid-cycle (a 500s+ cycle + a slow scan = 13min between beats → restart
  // → in-flight scanner SIGKILLed before live-plan.json wrote — the dead
  // pipeline bug). A beat between spawns keeps >12min silence meaning what
  // it should: one child genuinely wedged past its 600s cap.
  const beat = (phase) => { try { fs.writeFileSync('state/rapid-heartbeat.json', JSON.stringify({ ts: Date.now(), cycle, consecFails, lastErr, phase })); } catch {} };
  beat('top');
  let tScan = 0, tExec = 0;
  try {
    // exec FIRST — the trigger finger (armed setups, position management,
    // protection) must not queue behind the scanner's 4-8min budget on this
    // I/O-throttled box; a wedged/OOM'd scan used to stall every eval for a
    // full cycle. Exec reads the prior cycle's scan artifacts — signal
    // entries are edge-gated anyway, so a slightly stale context is cheap.
    const b = Date.now(); const rExec = await run('scripts/bitget-exec.mjs'); tExec = Date.now() - b;
    beat('post-exec');
    // scan-verify: build-scanner has a silent exit-0 path (empty event
    // loop under socket pressure — pending promise, no handles → node
    // exits mid-main). It prints nothing and the cycle flags clean while
    // live-plan.json rots. A scan that didn't freshen the plan is a
    // failed scan — retry once, and say it loud either way.
    const planAge = () => {
      try { return (Date.now() - JSON.parse(fs.readFileSync('api/live-plan.json', 'utf8')).ts) / 6e4; }
      catch { return Infinity; }
    };
    let a = Date.now();
    let rScan = await run('scripts/build-scanner.mjs');
    if (planAge() > 15 && !(rScan.code || rScan.sig || rScan.err)) {
      console.log(`[rapid] scan exited 0 but plan still ${Math.round(planAge())}min stale — silent exit, retrying once`);
      rScan = await run('scripts/build-scanner.mjs');
    }
    if (planAge() > 15)
      console.log(`[rapid] ⚠ scan produced no fresh plan (${Math.round(planAge())}min stale${rScan.sig ? `, sig=${rScan.sig}` : ''}${rScan.code ? `, code=${rScan.code}` : ''}) — exec runs mandate-only`);
    tScan = Date.now() - a;
    beat('post-scan');
    await run('scripts/god.mjs').catch((e) => console.log('[rapid] god:', e.message || e));
    await run('scripts/thoughts.mjs').catch((e) => console.log('[rapid] thoughts:', e.message || e));
    beat('post-health');
    // heavy fan-out on a slow cadence — 13 serial node spawns every cycle
    // ran the loop to 600-740s on this I/O-throttled t3.micro and starved
    // the scanner's own fetches (12s timeouts → dead plan → blind mandate).
    // The evidence layer is a RESEARCH surface: 10-minute freshness is
    // plenty; the trigger finger needs the box back every cycle.
    if (Date.now() - lastHeavy > HEAVY_MS) {
      lastHeavy = Date.now();
      await run('scripts/onchain-scan.mjs').catch((e) => console.log('[rapid] onchain-scan:', e.message || e));
      await run('scripts/onchain-exec.mjs').catch((e) => console.log('[rapid] onchain-exec:', e.message || e));
      await run('scripts/onchain-trades.mjs').catch((e) => console.log('[rapid] onchain-trades:', e.message || e));
      // evidence layer (Will M1-M6): forensics -> policy must precede
      // exec-critical reads next cycle
      await run('scripts/eval-forensics.mjs').catch((e) => console.log('[rapid] eval-forensics:', e.message || e));
      await run('scripts/shadow-ab.mjs').catch((e) => console.log('[rapid] shadow-ab:', e.message || e));
      await run('scripts/strategy-policy.mjs').catch((e) => console.log('[rapid] strategy-policy:', e.message || e));
      await run('scripts/feature-tuner.mjs').catch((e) => console.log('[rapid] feature-tuner:', e.message || e));
      await run('scripts/ledger-recon.mjs').catch((e) => console.log('[rapid] ledger-recon:', e.message || e));
      await run('scripts/failover-audit.mjs').catch((e) => console.log('[rapid] failover-audit:', e.message || e));
      await run('scripts/validator-report.mjs').catch((e) => console.log('[rapid] validator-report:', e.message || e));
      await run('scripts/autonomous-pnl.mjs').catch((e) => console.log('[rapid] autonomous-pnl:', e.message || e));
      beat('mid-heavy');
      await run('scripts/reject-markout.mjs').catch((e) => console.log('[rapid] reject-markout:', e.message || e));
      // dashboard bundle LAST — single-fetch aggregate of the api/ fan-out
      // so remote viewers load one file, not 49. Runs after all writers settle.
      await run('scripts/api-bundle.mjs').catch((e) => console.log('[rapid] api-bundle:', e.message || e));
    }
    // crash accounting AFTER the fan-out — a dead scanner/exec flags the
    // cycle but must not starve the evidence + dashboard children that ride
    // below it (god/eval/bundle all read state, not the dead child's output).
    const crashed = [rScan, rExec]
      .filter((r) => r.code !== 0 || r.sig || r.err)
      .map((r) => `${r.f}: ${r.err?.message || `code=${r.code} sig=${r.sig}`}`)
      .join('; ');
    if (crashed) throw new Error(`child exited (${crashed})`);
    consecFails = 0; lastErr = null;
  } catch (e) {
    consecFails++;
    lastErr = String(e.message || e).slice(0, 120);
    console.log(`[rapid] cycle ${cycle} error (${consecFails} straight):`, e.message || e);
    if (consecFails >= 5)
      try { fs.appendFileSync('state/tg-outbox.jsonl', JSON.stringify({ ts: Date.now(), to: 'ops', text: `🚨 RAPID DEATH SPIRAL — ${consecFails} consecutive failed cycles: ${lastErr}` }) + '\n'); } catch {}
  }
  const dt = Date.now() - t;
  const wait = Math.max(1_000, MS - dt);
  console.log(`[rapid] cycle ${cycle} done in ${(dt / 1e3).toFixed(1)}s (scan ${(tScan / 1e3).toFixed(1)}s + exec ${(tExec / 1e3).toFixed(1)}s) — next in ${Math.round(wait / 1e3)}s`);
  await new Promise((r) => setTimeout(r, wait));
}
