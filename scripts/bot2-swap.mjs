// operator swap 2026-11-10 — sell ALL Bot2 bags -> USDC -> buy target mint.
// protects: mint pre-added to onchain-hold.json; position registered with
// the standard fprof after fill; old book seats zeroed (external outflow).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sol from './exchange/solana-swap.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = 'CcTwKBS9AdiFbH6LNyQinAea1D4Yhh7nM8tQZ3BKpump';
const QUOTE = [sol.MINT.USDC, sol.MINT.USDT];
const SKIP = new Set([sol.MINT.SOL, sol.MINT.USDC, sol.MINT.USDT, TARGET,
  'So11111111111111111111111111111111111111112'.replace('So','So')]); // WSOL = MINT.SOL already
const STATE = path.join(ROOT, 'state');
const BOOK = path.join(STATE, 'onchain-book.json');
const FILLS = path.join(STATE, 'onchain-fills.json');

const j = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wj = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const journal = (r) => { try { const a = j(FILLS, { fills: [] }); (a.fills = a.fills || []).push({ ts: Date.now(), ...r }); wj(FILLS, a); } catch {} };

const bal = await sol.balances();
if (!bal.ok) { console.log('no wallet', bal.reason); process.exit(1); }
console.log('wallet', bal.address, 'sol', bal.sol.toFixed(5));
const bags = Object.entries(bal.tokensRaw || {}).filter(([m, raw]) => !SKIP.has(m) && +raw > 0);
console.log('bags:', bags.map(([m, r]) => `${m.slice(0, 8)}… raw=${r}`).join(' | ') || 'NONE');

// ---- 1) sell every bag -> USDC ----
for (const [mint, raw] of bags) {
  const ui = bal.tokens[mint] || 0;
  if (ui * 1 < 0.000001) continue;
  console.log(`SELL ${mint.slice(0, 10)}… raw=${raw}`);
  let r = null, err = null;
  try { r = await sol.swapAny({ inputMint: mint, outputMint: sol.MINT.USDC, amount: +raw, slippageBps: 800, solBal: bal.sol }); }
  catch (e) { err = e; }
  if (!r) {
    try { r = await sol.swapUltra({ inputMint: mint, outputMint: sol.MINT.USDC, amount: +raw, slippageBps: 1200 }); } catch (e2) { err = e2; }
  }
  if (r) { console.log(`  sold sig ${r.signature} outUsdc=${r.outAmount}`); journal({ side: 'sell', mint, raw: +raw, outMint: sol.MINT.USDC, outRaw: r.outAmount, sig: r.signature, why: 'operator-swap-bot2' }); }
  else console.log(`  SELL FAILED ${mint.slice(0, 10)}: ${(err?.message || '?').slice(0, 140)}`);
  await new Promise((x) => setTimeout(x, 1200));
}

// ---- 2) rebalance: sweep USDT->USDC if needed, then buy target with all USDC ----
await new Promise((x) => setTimeout(x, 2500));
const bal2 = await sol.balances();
let usdcUi = bal2.tokens?.[sol.MINT.USDC] || 0;
const usdtUi = bal2.tokens?.[sol.MINT.USDT] || 0;
if (usdtUi > 0.01 && usdcUi < 0.01) {
  const usdtRaw = bal2.tokensRaw[sol.MINT.USDT];
  try {
    const r = await sol.swapAny({ inputMint: sol.MINT.USDT, outputMint: sol.MINT.USDC, amount: +usdtRaw, slippageBps: 100, solBal: bal2.sol });
    console.log('usdt->usdc sig', r.signature);
    journal({ side: 'swap', mint: sol.MINT.USDT, outMint: sol.MINT.USDC, sig: r.signature, why: 'operator-swap-consolidate' });
  } catch (e) { console.log('usdt consolidate failed', e.message.slice(0, 100)); }
  await new Promise((x) => setTimeout(x, 2000));
}
const bal3 = await sol.balances();
usdcUi = bal3.tokens?.[sol.MINT.USDC] || 0;
console.log('USDC available:', usdcUi.toFixed(4));
if (usdcUi >= 0.05) {
  // keep ~$0.02 for nothing — spend it all; gas rides on SOL not USDC
  const inRaw = Math.floor(usdcUi * 1e6);
  console.log(`BUY target ${TARGET.slice(0, 10)}… for ${usdcUi.toFixed(4)} USDC`);
  let r = null, q = null, err = null;
  try { q = await sol.quote({ inputMint: sol.MINT.USDC, outputMint: TARGET, amount: inRaw, slippageBps: 1000 }); } catch (e) { console.log('quote fail', e.message.slice(0, 100)); }
  try { r = await sol.swapAny({ inputMint: sol.MINT.USDC, outputMint: TARGET, amount: inRaw, slippageBps: 1000, solBal: bal3.sol }); }
  catch (e) { err = e; }
  if (!r) { try { r = await sol.swapUltra({ inputMint: sol.MINT.USDC, outputMint: TARGET, amount: inRaw, slippageBps: 1500 }); } catch (e2) { err = e2; } }
  if (r) {
    console.log(`  BOUGHT sig ${r.signature} outRaw=${r.outAmount}`);
    journal({ side: 'buy', symbol: 'NEWPUMP', mint: TARGET, usd: usdcUi, qtyRaw: +(q?.outAmount || r.outAmount || 0), sig: r.signature, force: false, why: 'operator-swap-bot2' });
    // register position with the same protective profile as WEALTH/CLAUDIA
    const book = j(BOOK, { positions: [] });
    book.positions = book.positions || [];
    // zero out the swapped-away seats (external outflow — keep record)
    for (const p of book.positions) {
      if (p.mint !== TARGET && bags.some(([m]) => m === p.mint)) { p.qtyRaw = 0; p.closedAt = Date.now(); p.closeReason = 'operator-swap'; }
    }
    const existing = book.positions.find((p) => p.mint === TARGET);
    const fprof = { floor: 0, arm: 99, feeLock: 1.01, keep: 0, maxHoldH: 8760, moonKeep: 0.4,
      dynTp: { stepPct: 0.15, sellPct: 0.12, coverMult: 1.03 } };
    if (existing) {
      existing.qtyRaw = (+existing.qtyRaw || 0) + (+(q?.outAmount || r.outAmount || 0));
      existing.costUsd = +(existing.costUsd || 0) + usdcUi;
      existing.lastValueUsd = existing.costUsd;
    } else {
      book.positions.push({ mint: TARGET, symbol: 'NEWPUMP', qtyRaw: +(q?.outAmount || r.outAmount || 0),
        costUsd: usdcUi, peakUsd: usdcUi, lastValueUsd: usdcUi, ts: Date.now(),
        entryPxUsd: null, score: null, liqUsd: null, sig: r.signature, profile: fprof });
    }
    book.updatedAt = new Date().toISOString();
    wj(BOOK, book);
    console.log('book updated — NEWPUMP position registered with dynTp profile');
  } else console.log(`  BUY FAILED: ${(err?.message || '?').slice(0, 160)}`);
} else {
  console.log('nothing to buy — USDC below minimum');
}
console.log('DONE');
