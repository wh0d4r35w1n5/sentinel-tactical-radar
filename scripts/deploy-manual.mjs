// deploy-manual.mjs — operator-directed 100% equity deploy into one mint.
// Liquidates every token bag -> quote asset, converts free SOL, buys the
// target with the full purse, registers a NEVER-SELL-AT-LOSS seat
// (floor:0 = exits exist only in profit; dynTp banks into strength).
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
const GAS_SOL = 0.003;
const STABLES = new Set([sol.MINT.USDC, sol.MINT.USDT]);
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const journal = (f) => { const a = readJ(FILLS_FILE, []); a.push({ ts: Date.now(), ...f }); writeJ(FILLS_FILE, a.slice(-500)); };
const log = (...a) => console.log('[deploy]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// single-flight — exec skips while we hold it
let fd = null;
try { fd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
catch {
  const pid = +String(fs.readFileSync(LOCK, 'utf8')).trim();
  const stale = Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60e3;
  let alive = false; if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
  if (!(stale || !alive)) { console.log('exec lock held by live pid — abort'); process.exit(2); }
  fs.rmSync(LOCK, { force: true });
  fd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(fd, String(process.pid));
}

// bags are pump.fun curve tokens — Jupiter can't route them, the curve can.
// proceeds land in SOL; we track value via pre-sell curve marks.
const sellToken = async (mint, raw) => {
  try {
    const r = await pp.curveSell({ mint, tokenUiAmount: +(raw / 1e6).toFixed(6), slippage: 30 });
    if (r?.signature) return r;
  } catch (e) { log(`curve-sell ${mint.slice(0, 8)} fail: ${String(e.message || e).slice(0, 80)}`); }
  for (const slip of [1500, 4000, 9000]) {
    try { return await sol.swapAny({ inputMint: mint, outputMint: sol.MINT.USDC, amount: raw, slippageBps: slip, solBal: 0 }); }
    catch (e) { log(`sell ${mint.slice(0, 8)} slip${slip} fail: ${String(e.message || e).slice(0, 80)}`); }
  }
  try { return await sol.swapUltra({ inputMint: mint, outputMint: sol.MINT.USDC, amount: raw, slippageBps: 9000 }); }
  catch (e) { log(`sell ${mint.slice(0, 8)} ultra fail: ${String(e.message || e).slice(0, 80)}`); return null; }
};

try {
  let bal = await sol.balances();
  if (!bal.ok) throw new Error('balances failed');
  log(`start sol=${bal.sol.toFixed(4)} tokens=${Object.keys(bal.tokensRaw || {}).length}`);

  // 1) liquidate every non-stable bag — curve sells pay out in SOL
  const bags = Object.keys(bal.tokensRaw || {}).filter((m) => !STABLES.has(m) && +(bal.tokensRaw[m]) > 0);
  for (const m of bags) {
    const raw = bal.tokensRaw[m];
    log(`selling bag ${m.slice(0, 10)}… raw=${raw}`);
    const r = await sellToken(m, +raw);
    if (r) log(`  sold sig ${r.signature.slice(0, 16)}…`);
    await sleep(1200);
  }

  // 2) fresh truth + SOL price
  bal = await sol.balances();
  const pxC = readJ(path.join(STATE, 'onchain-solpx.json'), null);
  let solPx = pxC?.px && Date.now() - pxC.ts < 30 * 60e3 ? pxC.px : null;
  if (!solPx) {
    const q = await sol.quote({ inputMint: sol.MINT.SOL, outputMint: sol.MINT.USDC, amount: 1e7, slippageBps: 100 });
    solPx = (+q.outAmount / 1e6) * 100;
    writeJ(path.join(STATE, 'onchain-solpx.json'), { px: solPx, ts: Date.now() });
  }
  log(`post-sell sol=${bal.sol.toFixed(4)} usdc=${(bal.tokens?.[sol.MINT.USDC] || 0).toFixed(4)} usdt=${(bal.tokens?.[sol.MINT.USDT] || 0).toFixed(4)} solPx=${solPx?.toFixed(1)}`);

  // 3) purse = USDC + USDT + free SOL (minus gas)
  const solFree = Math.max(0, bal.sol - GAS_SOL);
  const stablesUsd = (+(bal.tokens?.[sol.MINT.USDC] || 0)) + (+(bal.tokens?.[sol.MINT.USDT] || 0));
  const purseUsd = stablesUsd + solFree * (solPx || 0);
  log(`purse $${purseUsd.toFixed(4)} (stables ${stablesUsd.toFixed(4)} + sol ${solFree.toFixed(4)})`);
  if (!(purseUsd >= 0.05)) throw new Error('purse too thin after liquidation');

  // 4) buy TARGET — USDC leg first, SOL leg for whatever remains
  let sig = null, usedMint = null, spentUsd = 0;
  const usdcRaw = Math.round((bal.tokens?.[sol.MINT.USDC] || 0) * 1e6);
  if (usdcRaw >= 50000) { // >=$0.05
    for (const slip of [500, 1500, 4000]) {
      try {
        const r = await sol.swapAny({ inputMint: sol.MINT.USDC, outputMint: TARGET, amount: usdcRaw, slippageBps: slip, solBal: bal.sol });
        sig = r.signature; usedMint = 'USDC'; spentUsd = usdcRaw / 1e6; break;
      } catch (e) { log(`buy USDC slip${slip} fail ${String(e.message || e).slice(0, 80)}`); }
    }
  }
  const solAfter = Math.max(0, (await sol.balances()).sol - GAS_SOL);
  if (!sig && solAfter > 0.0005) {
    const inRaw = Math.round(solAfter * 1e9);
    for (const slip of [500, 1500, 4000]) {
      try {
        const r = await sol.swapAny({ inputMint: sol.MINT.SOL, outputMint: TARGET, amount: inRaw, slippageBps: slip, solBal: bal.sol });
        sig = r.signature; usedMint = 'SOL'; spentUsd = solAfter * (solPx || 0); break;
      } catch (e) { log(`buy SOL slip${slip} fail ${String(e.message || e).slice(0, 80)}`); }
    }
  }
  // mixed purse: USDC leg landed but SOL remains -> second buy with leftover SOL
  if (sig && usedMint === 'USDC') {
    const solLeft2 = Math.max(0, (await sol.balances()).sol - GAS_SOL);
    const solUsd2 = solLeft2 * (solPx || 0);
    if (solUsd2 >= 0.03) {
      try {
        const r2 = await sol.swapAny({ inputMint: sol.MINT.SOL, outputMint: TARGET, amount: Math.round(solLeft2 * 1e9), slippageBps: 1500, solBal: bal.sol });
        spentUsd += solUsd2;
        log(`second leg SOL->target ${(solLeft2).toFixed(4)} sig ${r2.signature.slice(0, 16)}…`);
      } catch (e) { log(`second leg fail ${String(e.message || e).slice(0, 60)} — SOL stays liquid`); }
    }
  }
  if (!sig) throw new Error('all buy attempts failed');
  log(`BOUGHT via ${usedMint} sig ${sig}`);

  // 5) verify receipt + register never-sell-at-loss seat
  let qtyRaw = 0;
  for (let i = 0; i < 10 && !(qtyRaw > 0); i++) {
    await sleep(1500);
    qtyRaw = +(await sol.tokenBalance(TARGET).catch(() => 0) || 0);
  }
  if (!(qtyRaw > 0)) throw new Error('buy confirmed but token balance unreadable');

  const book = readJ(BOOK_FILE, { positions: [] });
  book.positions = (book.positions || []).filter((p) => !bags.includes(p.mint) && p.mint !== TARGET);
  const deployedUsd = +spentUsd.toFixed(4);
  book.positions.push({
    mint: TARGET, symbol: 'M:bn5DhJnk', lane: 'manual', qtyRaw,
    costUsd: deployedUsd, peakUsd: deployedUsd, lastValueUsd: deployedUsd,
    ts: Date.now(), entryPxUsd: null, score: null, liqUsd: null, sig,
    profile: {
      floor: 0, arm: 1.05, feeLock: 1.0, keep: 0.6,
      maxHoldH: 0,
      dynTp: { stepPct: 0.15, sellPct: 0.15, coverMult: 1.03, outMint: 'SOL' },
      moonKeep: 0.10,
    },
    deployer: 'operator-direct',
  });
  writeJ(BOOK_FILE, { ...book, updatedAt: new Date().ISOString() });
  journal({ side: 'buy', symbol: 'M:bn5DhJnk', mint: TARGET, usd: deployedUsd, qtyRaw, sig, lane: 'manual', reason: 'operator-100pct-deploy' });
  log(`DONE deployed ~$${deployedUsd} qtyRaw=${qtyRaw} — floor:0 never-sell-at-loss profile armed`);
} finally {
  if (fd != null) { try { fs.closeSync(fd); } catch {} try { fs.rmSync(LOCK, { force: true }); } catch {} }
}
