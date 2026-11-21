// consolidate-target.mjs — sell the 3 lane bags, sweep ALL proceeds into
// the operator target mint, register the seat BEFORE releasing the exec
// lock so the orphan sweep can never touch it again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-env.mjs';
import * as sol from './exchange/solana-swap.mjs';
import * as pp from './exchange/pumpportal.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(DIR, '..', 'state');
const BOOK_FILE = path.join(STATE, 'onchain-book.json');
const FILLS_FILE = path.join(STATE, 'onchain-fills.json');
const LOCK = path.join(STATE, 'onchain-exec.lock');
const TARGET = 'bn5DhJnkB8EVDoAgV9qCV3Kbv7XmEEp7mxW4npDpump';
const BAGS = [
  ['G:GTPONS', 'DrzVDZCEPkmdyk6LQ8jBpEK5tJQE4PncGEA86x4Vpump'],
  ['G:HOLD', '4iJ7xEQrUvVUQH9KVStvw3FaY2PZDd7RtR4L9zx2pump'],
  ['S:MIMI', 'EPWVCB9v3LpP1hNEVcHsfGm6EWFeoz1aTur7hYK6pump'],
];
const GAS_SOL = 0.004;
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const journal = (f) => { const a = readJ(FILLS_FILE, []); a.push({ ts: Date.now(), ...f }); writeJ(FILLS_FILE, a.slice(-500)); };
const log = (...a) => console.log('[consol]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fd = null;
try { fd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
catch {
  const pid = +String(fs.readFileSync(LOCK, 'utf8')).trim();
  const stale = Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60e3;
  let alive = false; if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
  if (!(stale || !alive)) { console.log('exec lock held — abort'); process.exit(2); }
  fs.rmSync(LOCK, { force: true });
  fd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(fd, String(process.pid));
}

try {
  // 1) sell all three bags on their curves — proceeds in SOL
  for (const [sym, mint] of BAGS) {
    const raw = +(await sol.tokenBalance(mint).catch(() => 0) || 0);
    if (!(raw > 0)) { log(`${sym}: wallet empty — skip`); continue; }
    try {
      const r = await pp.curveSell({ mint, tokenUiAmount: +(raw / 1e6).toFixed(6), slippage: 35 });
      log(`${sym}: sold ${(raw / 1e6).toFixed(2)} sig ${r.signature.slice(0, 16)}…`);
      journal({ side: 'sell', symbol: sym, mint, lane: 'consolidate', qtyRaw: raw, sig: r.signature, reason: 'operator-100pct-target' });
    } catch (e) { log(`${sym}: sell fail ${String(e.message || e).slice(0, 90)}`); }
    await sleep(1500);
  }

  // 2) sweep — buy target with everything liquid
  await sleep(3000);
  const bal = await sol.balances();
  const usdcRaw = Math.round((+(bal.tokens?.[sol.MINT.USDC] || 0)) * 1e6);
  const solFree = Math.max(0, bal.sol - GAS_SOL);
  log(`sweep usdc=$${(usdcRaw / 1e6).toFixed(4)} solFree=${solFree.toFixed(4)} sol=${bal.sol.toFixed(4)}`);

  let sig = null, legs = [];
  if (usdcRaw >= 30000) {
    for (const slip of [500, 1500, 4000]) {
      try { const r = await sol.swapAny({ inputMint: sol.MINT.USDC, outputMint: TARGET, amount: usdcRaw, slippageBps: slip, solBal: bal.sol }); sig = r.signature; legs.push('USDC'); break; }
      catch (e) { log(`usdc leg slip${slip} fail ${String(e.message || e).slice(0, 70)}`); }
    }
  }
  const solLeft = Math.max(0, (await sol.balances()).sol - GAS_SOL);
  if (solLeft > 0.0008) {
    for (const slip of [500, 1500, 4000]) {
      try { const r = await sol.swapAny({ inputMint: sol.MINT.SOL, outputMint: TARGET, amount: Math.round(solLeft * 1e9), slippageBps: slip, solBal: bal.sol }); sig = (sig ? sig + '+' : '') + r.signature; legs.push('SOL'); break; }
      catch (e) { log(`sol leg slip${slip} fail ${String(e.message || e).slice(0, 70)}`); }
    }
  }
  if (!sig) throw new Error('no buy legs landed');
  log(`BOUGHT legs=${legs.join('+')} sig ${sig.slice(0, 40)}`);

  // 3) verify + register BEFORE unlock — orphan sweep stays blind
  let qtyRaw = 0;
  for (let i = 0; i < 10 && !(qtyRaw > 0); i++) { await sleep(1500); qtyRaw = +(await sol.tokenBalance(TARGET).catch(() => 0) || 0); }
  if (!(qtyRaw > 0)) throw new Error('target balance unreadable after buy');

  const book = readJ(BOOK_FILE, { positions: [] });
  const bagMints = BAGS.map((b) => b[1]);
  book.positions = (book.positions || []).filter((p) => !bagMints.includes(p.mint));
  book.positions = book.positions.filter((p) => p.mint !== TARGET);
  book.positions.push({
    mint: TARGET, symbol: 'M:bn5DhJnk', lane: 'manual', qtyRaw,
    costUsd: 1.70, peakUsd: 1.70, lastValueUsd: 1.70, ts: Date.now(),
    entryPxUsd: null, score: null, liqUsd: null, sig,
    profile: { floor: 0, arm: 1.05, feeLock: 1.0, keep: 0.6, maxHoldH: 0, dynTp: { stepPct: 0.15, sellPct: 0.15, coverMult: 1.03, outMint: 'SOL' }, moonKeep: 0.10 },
    deployer: 'operator-direct',
  });
  writeJ(BOOK_FILE, { ...book, updatedAt: new Date().toISOString() });
  journal({ side: 'buy', symbol: 'M:bn5DhJnk', mint: TARGET, usd: 1.70, qtyRaw, sig, lane: 'manual', reason: 'consolidated-100pct' });
  log(`DONE qtyRaw=${qtyRaw} book registered under lock`);
} finally {
  if (fd != null) { try { fs.closeSync(fd); } catch {} try { fs.rmSync(LOCK, { force: true }); } catch {} }
}
