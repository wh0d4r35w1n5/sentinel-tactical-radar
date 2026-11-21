// Operator-directed manual buy: SEAN (8PGyHCKv...pump) with the spendable
// stable purse. Takes the SAME onchain-exec lock so no timer cycle can
// double-spend the purse mid-fill, then registers the position in
// onchain-book.json so the standard trail/fee-lock manages it as normal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '/opt/sentinel/scripts/load-env.mjs';
import * as sol from '/opt/sentinel/scripts/exchange/solana-swap.mjs';

const STATE = '/opt/sentinel/state';
const BOOK_FILE = path.join(STATE, 'onchain-book.json');
const FILLS_FILE = path.join(STATE, 'onchain-fills.json');
const LOCK = path.join(STATE, 'onchain-exec.lock');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

const MINT_SEAN = '8PGyHCKvSUjezHkV7KLwMacnmSJLe1YbRM1zvDVApump';
const SLIPPAGE_BPS = 150;
const MIN_STABLE_USD = +(process.env.ONCHAIN_MIN_STABLE_USD || 5);

// --- lock (same semantics as onchain-exec) ---
let lockFd = null;
try { lockFd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(lockFd, String(process.pid)); }
catch {
  const pid = +String(fs.readFileSync(LOCK, 'utf8')).trim();
  const stale = Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60e3;
  if (stale) { fs.rmSync(LOCK, { force: true }); lockFd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(lockFd, String(process.pid)); }
}
if (lockFd === null) { console.log('lock held — aborting (exec tick running)'); process.exit(1); }
process.on('exit', () => { try { fs.closeSync(lockFd); } catch {} try { fs.rmSync(LOCK, { force: true }); } catch {} });

const bal = await sol.balances();
const usdc = bal.tokens[sol.MINT.USDC] || 0, usdt = bal.tokens[sol.MINT.USDT] || 0;
const stableUsd = usdc + usdt;
const deploy = Math.max(0, stableUsd - MIN_STABLE_USD);
console.log(`purse: USDC $${usdc.toFixed(2)} + USDT $${usdt.toFixed(2)} = $${stableUsd.toFixed(2)} | reserve $${MIN_STABLE_USD} → deploy $${deploy.toFixed(2)}`);
if (deploy < 2) { console.log('nothing to deploy'); process.exit(0); }

const book = readJ(BOOK_FILE, { positions: [], updatedAt: null });
book.positions ??= [];
if (book.positions.some((p) => p.mint === MINT_SEAN)) { console.log('SEAN already in book — refusing double-seat'); process.exit(0); }

// legs: cover `deploy` from USDC first, USDT for any remainder
const legs = [];
let left = deploy;
const usdcLeg = Math.min(usdc, left);
if (usdcLeg >= 0.5) { legs.push({ mint: sol.MINT.USDC, usd: usdcLeg }); left -= usdcLeg; }
if (left >= 0.5 && usdt > 0.5) { const u = Math.min(usdt, left); legs.push({ mint: sol.MINT.USDT, usd: u }); }

let qtyRaw = 0, spent = 0, sigs = [];
for (const leg of legs) {
  const inRaw = Math.round(leg.usd * 1e6);
  const q = await sol.quote({ inputMint: leg.mint, outputMint: MINT_SEAN, amount: inRaw, slippageBps: SLIPPAGE_BPS });
  const r = await sol.swapAny({ inputMint: leg.mint, outputMint: MINT_SEAN, amount: inRaw, slippageBps: SLIPPAGE_BPS, solBal: bal.sol });
  qtyRaw += +q.outAmount; spent += leg.usd; sigs.push(r.signature);
  console.log(`  leg $${leg.usd.toFixed(2)} → ${(+q.outAmount).toLocaleString()} SEAN raw | sig ${r.signature.slice(0, 16)}…`);
  await new Promise((r2) => setTimeout(r2, 400));
}
if (!qtyRaw) { console.log('no fills — nothing booked'); process.exit(1); }

book.positions.push({
  mint: MINT_SEAN, symbol: 'SEAN', qtyRaw,
  costUsd: spent, peakUsd: spent, lastValueUsd: spent, ts: Date.now(),
  entryPxUsd: null, score: null, liqUsd: 128979,
  sig: sigs[0], note: 'operator-directed manual buy — hold-thesis profile',
  // custom hold profile — survives memecoin wicks: trail only bites on a
  // -55% giveback from peak; pre-arm rug floor -50%; fee-lock arms only
  // after a real +25% run (then can't close under ~98% of cost); no
  // age-out, exempt from the 45min dead-flow killer.
  profile: { keep: 0.45, floor: 0.5, arm: 1.25, feeLock: 0.98, maxHoldH: 9999, noRun: false },
});
book.updatedAt = new Date().toISOString();
writeJ(BOOK_FILE, book);
const fills = readJ(FILLS_FILE, []); fills.push({ ts: Date.now(), side: 'buy', symbol: 'SEAN', mint: MINT_SEAN, usd: spent, qtyRaw, sig: sigs[0], manual: true }); writeJ(FILLS_FILE, fills.slice(-500));
console.log(`BOOKED SEAN — spent $${spent.toFixed(2)}, qtyRaw ${qtyRaw.toLocaleString()}, sigs ${sigs.map((s) => s.slice(0, 12)).join(',')}`);
