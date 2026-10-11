// On-chain execution lane — trades the onchain-hot.json candidates via
// Jupiter swaps from the bot hot wallet. Unlevered spot: no liquidation,
// but rug/pull/slippage risk instead — gates are audit + liquidity +
// bounded purse, exits are software trails (no exchange-side stops exist
// on-chain).
//
// Dormant by design: with no wallet secret or no funded balance it logs a
// heartbeat line and exits 0 — the lane arms itself when funds land.
//
// Rails:
//  - purse cap: max ONCHAIN_PCT of wallet USDC/USDT value per position,
//    hard-capped by ONCHAIN_MAX_USD and total deployed cap
//  - entry requires: fresh onchain-hot feed, score floor, audit pass
//    (solana: not rugged + <=3 named risks), perp tokens are skipped —
//    the leveraged lane already covers them
//  - exit: value trail — sells to USDC when position value < trail stop
//    (peak * keep) or age-out beyond MAX_HOLD_H with no profit
//  - every fill journals to state/onchain-fills.json for episode accounting

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-env.mjs';
import * as sol from './exchange/solana-swap.mjs';
import { emitCustody } from './custody-proof.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'api');
const STATE = path.join(ROOT, 'state');
const BOOK_FILE = path.join(STATE, 'onchain-book.json');
const FILLS_FILE = path.join(STATE, 'onchain-fills.json');

const ENABLED = process.env.SENTINEL_ONCHAIN_LANE === '1';
const PCT = +(process.env.ONCHAIN_PCT || 0.25); // of spendable stable balance
const MAX_USD = +(process.env.ONCHAIN_MAX_USD || 25); // per position cap
const MAX_POSITIONS = +(process.env.ONCHAIN_MAX_POS || 3);
const MAX_DEPLOYED_USD = +(process.env.ONCHAIN_MAX_DEPLOYED || 40);
const MIN_SCORE = +(process.env.ONCHAIN_MIN_SCORE || 65);
// momentum gate — buy what's moving NOW, not what scored well on a stale
// 24h composite. A runner entry needs +MIN_CHG_PCT on the 24h tape.
const MIN_CHG_PCT = +(process.env.ONCHAIN_MIN_CHG_PCT || 10);
const SLIPPAGE_BUY_BPS = +(process.env.ONCHAIN_SLIPPAGE_BUY || 150);
const SLIPPAGE_SELL_BPS = +(process.env.ONCHAIN_SLIPPAGE_SELL || 250);
const KEEP = +(process.env.ONCHAIN_KEEP || 0.72); // trail: keep 72% of peak
const FEE_LOCK = +(process.env.ONCHAIN_FEE_LOCK || 0.985); // once profitable, never give back under ~98.5% of cost
const LOCK_ARM = +(process.env.ONCHAIN_LOCK_ARM || 1.03); // peak must clear cost+round-trip before FEE_LOCK engages
const STOP_LOSS = +(process.env.ONCHAIN_STOP_LOSS || 0.7); // pre-profit hard floor — wide enough to survive entry spread
const MAX_HOLD_H = +(process.env.ONCHAIN_MAX_HOLD_H || 36);
const DUST_ABANDON_USD = +(process.env.ONCHAIN_DUST_USD || 0.05); // below this an unsellable bag is residue, not a position
// micro-purse floors — gas on Solana is ~fixed-cent cheap, so a tiny wallet
// stays economic; env lets the operator scale them up when the purse grows
const MIN_STABLE_USD = +(process.env.ONCHAIN_MIN_STABLE_USD || 5);
const MIN_SIZE_USD = +(process.env.ONCHAIN_MIN_SIZE_USD || 4);

// single-flight lock — rapid's cycle spawn AND the 3-min trail timer both
// call this script; two concurrent runners could double-sell the same bag
// on the exit pass or double-buy one candidate. Stale locks (>15min =
// owner died mid-swap) get reclaimed, never honored forever.
const LOCK = path.join(STATE, 'onchain-exec.lock');
let lockFd = null;
try {
  lockFd = fs.openSync(LOCK, 'wx');
  fs.writeFileSync(lockFd, String(process.pid));
} catch {
  try {
    const pid = +String(fs.readFileSync(LOCK, 'utf8')).trim();
    const stale = Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60e3;
    let alive = false;
    if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
    if (stale || !alive) {
      fs.rmSync(LOCK, { force: true });
      lockFd = fs.openSync(LOCK, 'wx');
      fs.writeFileSync(lockFd, String(process.pid));
    }
  } catch {}
}
if (lockFd === null) { console.log('[onchain-exec] lock held — skipping this tick'); process.exit(0); }
process.on('exit', () => { try { fs.closeSync(lockFd); } catch {} try { fs.rmSync(LOCK, { force: true }); } catch {} });

const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const journal = (f) => { const a = readJ(FILLS_FILE, []); a.push({ ts: Date.now(), ...f }); writeJ(FILLS_FILE, a.slice(-500)); };

// lane state is published every cycle so the dashboard can show the purse —
// an operator should never have to wonder where onchain funds went again.
let lastVaultRes = 0; // set each cycle before emitLane — sealed vault share
const emitLane = (book, bal, stableUsd, note) => {
  const tokens = {};
  if (bal?.ok) for (const [m, v] of Object.entries(bal.tokens || {})) if (+v > 0) tokens[m] = +(+v).toFixed(6);
  const deployed = (book.positions || []).reduce((a, p) => a + (p.lastValueUsd || p.costUsd || 0), 0);
  try {
    writeJ(path.join(API, 'onchain-lane.json'), {
      ts: Date.now(), updatedAt: new Date().toISOString(), enabled: ENABLED,
      address: sol.walletReady() ? sol.address() : null,
      sol: bal?.ok ? +(+bal.sol).toFixed(6) : null,
      stableUsd: bal?.ok ? +(+stableUsd).toFixed(4) : null,
      tokens,
      purseUsd: +(deployed + (stableUsd || 0)).toFixed(4),
      positions: (book.positions || []).map((p) => ({
        symbol: p.symbol, mint: p.mint, costUsd: p.costUsd, lastValueUsd: p.lastValueUsd,
        qtyUi: bal?.ok && bal.tokens?.[p.mint] ? +(+bal.tokens[p.mint]).toFixed(6) : null,
        entryPxUsd: p.entryPxUsd || null,
        peakUsd: p.peakUsd, ageH: +(((Date.now() - p.ts) / 36e5) || 0).toFixed(2), sig: p.sig,
      })),
      recentFills: readJ(FILLS_FILE, []).slice(-12).reverse(),
      note: note || null,
      gates: { minScore: MIN_SCORE, minStableUsd: MIN_STABLE_USD, minSizeUsd: MIN_SIZE_USD, pct: PCT, maxPositions: MAX_POSITIONS, maxDeployedUsd: MAX_DEPLOYED_USD, keep: KEEP, maxHoldH: MAX_HOLD_H, vaultReservedUsd: +lastVaultRes.toFixed(4) },
    });
  } catch {}
};

async function main() {
  const book = readJ(BOOK_FILE, { positions: [], updatedAt: null });
  book.positions ??= [];

  if (!ENABLED) { console.log('onchain-exec: lane off (SENTINEL_ONCHAIN_LANE!=1)'); emitLane(book, null, null, 'lane off'); return; }
  if (!sol.walletReady()) { console.log('onchain-exec: no wallet — awaiting SOLANA_BOT_SECRET'); emitLane(book, null, null, 'no wallet'); return; }

  const bal = await sol.balances().catch((e) => ({ ok: false, err: e.message }));
  if (!bal.ok) { console.log(`onchain-exec: wallet probe failed — ${bal.err || bal.reason}`); emitLane(book, null, null, `probe failed: ${bal.err || bal.reason}`); return; }

  const stableUsd = (bal.tokens[sol.MINT.USDC] || 0) + (bal.tokens[sol.MINT.USDT] || 0);
  const deployed = book.positions.reduce((a, p) => a + (p.lastValueUsd || p.costUsd || 0), 0);
  // lane vault reserve: swept profits are sealed out of the deploy pool —
  // they stay USDC in this wallet but never size new entries (the vault is
  // accounting-segregated; at purse scale a second address just burns gas)
  const vaultRes = Math.max(0, +(readJ(path.join(STATE, 'onchain-vault.json'), {}).balanceUsd || 0));
  const spendableUsd = Math.max(0, stableUsd - vaultRes);
  lastVaultRes = vaultRes;
  const done = (note) => { writeJ(BOOK_FILE, { ...book, updatedAt: new Date().toISOString() }); emitLane(book, bal, stableUsd, note); emitCustody().catch(() => {}); };
  console.log(`onchain-exec: ${bal.address.slice(0, 8)}… sol=${bal.sol.toFixed(4)} stables=$${stableUsd.toFixed(2)}${vaultRes > 0 ? ` (🏦 $${vaultRes.toFixed(2)} sealed, $${spendableUsd.toFixed(2)} spendable)` : ''} positions=${book.positions.length} (~$${deployed.toFixed(2)})`);

  // bootstrap: convert whatever landed into the USDC purse. Two rails —
  // raw SOL converts via the classic swap keeping a gas reserve; ANY other
  // SPL token (USDGO/ME/… — the cheap CEX-withdrawal-minimum escape hatches)
  // converts via Jupiter Ultra GASLESS, where the relayer fronts the SOL
  // fee. A zero-SOL wallet can bootstrap itself entirely this way.
  const GAS_RESERVE = +(process.env.ONCHAIN_GAS_RESERVE || 0.025);
  if (stableUsd < MIN_STABLE_USD) {
    if (bal.sol > GAS_RESERVE + 0.008) {
      const swapLamports = Math.floor((bal.sol - GAS_RESERVE) * 1e9);
      console.log(`  bootstrap: swapping ${(swapLamports / 1e9).toFixed(4)} SOL -> USDC (keeping ${GAS_RESERVE} gas)`);
      try {
        const r = await sol.swap({ inputMint: sol.MINT.SOL, outputMint: sol.MINT.USDC, amount: swapLamports, slippageBps: 150 });
        journal({ side: 'bootstrap', usd: 'sol->usdc', lamports: swapLamports, outUsdcRaw: r.outAmount, sig: r.signature });
        console.log(`  bootstrap filled sig ${r.signature.slice(0, 12)}… — stables land next cycle`);
      } catch (e) { console.log(`  bootstrap swap failed: ${e.message.slice(0, 100)}`); }
    }
    // orphan SPL tokens — convert up to 2 per cycle, gasless rail when
    // gas is short (Ultra relayer pays), classic when SOL exists.
    // NEVER sweep an open position's mint — a post-buy purse dip below
    // MIN_STABLE_USD must not liquidate the book (fixed: held-mint guard).
    // Operator manual holds ride too: state/onchain-hold.json {mints:[...]}
    // — a token the operator bought through the app into this shared
    // address is not purse fodder (SIB buys were being insta-swept).
    const heldMints = new Set(book.positions.map((p) => p.mint));
    const HOLD_MINTS = new Set(readJ(path.join(STATE, 'onchain-hold.json'), {}).mints || []);
    const heldOrphans = Object.keys(bal.tokens).filter((m) => HOLD_MINTS.has(m) && !heldMints.has(m) && +bal.tokens[m] > 0);
    if (heldOrphans.length) console.log(`  🖐 hold-list: ${heldOrphans.map((m) => m.slice(0, 8) + '…').join(', ')} spared from orphan sweep`);
    const orphans = Object.keys(bal.tokens).filter((m) => m !== sol.MINT.USDC && m !== sol.MINT.USDT && !heldMints.has(m) && !HOLD_MINTS.has(m));
    for (const mint of orphans.slice(0, 2)) {
      const raw = bal.tokensRaw?.[mint];
      if (!raw || !(+raw > 0)) continue;
      const rail = bal.sol > 0.004 ? 'classic' : 'gasless';
      try {
        const r = bal.sol > 0.004
          ? await sol.swap({ inputMint: mint, outputMint: sol.MINT.USDC, amount: +raw, slippageBps: 200 })
          : await sol.swapUltra({ inputMint: mint, outputMint: sol.MINT.USDC, amount: +raw, slippageBps: 200 });
        journal({ side: 'bootstrap', usd: `${mint.slice(0, 8)}->usdc`, raw, rail, sig: r.signature });
        console.log(`  bootstrap ${rail} ${mint.slice(0, 8)}… -> USDC sig ${(r.signature || '').slice(0, 12)}…`);
      } catch (e) { console.log(`  bootstrap ${rail} ${mint.slice(0, 8)}… failed: ${e.message.slice(0, 80)}`); }
    }
    // positions still open → fall through to the exit trail; only an
    // empty book parks here waiting for a funded purse
    if (!book.positions.length) { done('bootstrap'); return; }
  }

  if (bal.sol < 0.004) console.log('  ⚠ gas low — need ~0.004 SOL minimum per swap');

  // ---- reconcile: wallet truth beats book state — a position whose token
  // account reads zero is closed regardless of what the book believes
  // (bootstrap sweeps, external moves). Quote-marks on zero balance are
  // fiction and their sells can only ever simulation-fail.
  const walletQty = (m) => +(bal.tokens?.[m] || 0);
  for (const pos of [...book.positions]) {
    if (walletQty(pos.mint) > 0) continue;
    journal({ side: 'reconcile', symbol: pos.symbol, mint: pos.mint, costUsd: pos.costUsd, note: 'wallet balance zero — closed outside trail' });
    book.positions = book.positions.filter((p) => p.mint !== pos.mint);
    console.log(`  ${pos.symbol}: wallet empty — book reconciled (cost $${(pos.costUsd || 0).toFixed(2)} returned via sweeps)`);
  }

  // ---- exits first: trail every open position ----
  const hot = readJ(path.join(API, 'onchain-hot.json'), null);
  for (const pos of [...book.positions]) {
    // sell what the WALLET actually holds, not the book's qtyRaw — partial
    // fills, sweep leftovers, and externally-moved chunks all leave qtyRaw
    // overstated, and every swap built on it sim-fails 'insufficient funds'.
    await new Promise((r) => setTimeout(r, 150)); // lite-api burst pacing
    const qtyRaw = Math.min(+pos.qtyRaw || 0, +(bal.tokensRaw?.[pos.mint] || 0));
    if (!(qtyRaw > 0)) continue; // zero-balance reconcile above owns this case
    let mark = null;
    try {
      // lite-api free tier answers bursts with Cloudflare HTML — one backoff
      // retry keeps a transient 429 from freezing a tripped stop. The 150ms
      // pacing between positions smooths the burst at the source.
      let q = null, qErr = null;
      for (let att = 0; att < 2 && !q; att++) {
        try {
          q = await sol.quote({
            inputMint: pos.mint, outputMint: sol.MINT.USDC,
            amount: qtyRaw, slippageBps: SLIPPAGE_SELL_BPS,
          });
        } catch (e) { qErr = e; if (!att) await new Promise((r) => setTimeout(r, 1500)); }
      }
      if (!q) throw qErr;
      mark = +q.outAmount / 1e6;
    } catch (e) { console.log(`  ${pos.symbol}: quote fail ${e.message.slice(0, 60)} — trail holds`); continue; }
    pos.lastValueUsd = mark;
    pos.peakUsd = Math.max(pos.peakUsd || mark, mark);
    // FEE_LOCK is a profit lock, not a -1.5% entry stop — a memecoin
    // sell-quote sits structurally below buy-in on tick one, so the cost
    // floor only tightens once peak has cleared the round-trip (LOCK_ARM).
    const locked = (pos.peakUsd || 0) > (pos.costUsd || 0) * LOCK_ARM;
    const trailStop = Math.max((pos.costUsd || 0) * (locked ? FEE_LOCK : STOP_LOSS), (pos.peakUsd || 0) * KEEP);
    const heldH = (Date.now() - pos.ts) / 36e5;
    const reason =
      mark < trailStop ? `trail ${mark.toFixed(2)}<${trailStop.toFixed(2)}` :
      heldH > MAX_HOLD_H && mark < (pos.costUsd || 0) * 1.05 ? `age ${heldH.toFixed(0)}h unprofitable` :
      null;
    console.log(`  ${pos.symbol}: $${mark.toFixed(2)} (cost $${pos.costUsd.toFixed(2)}, peak $${pos.peakUsd.toFixed(2)})${reason ? ' → ' + reason : ''}`);
    if (!reason) continue;
    try {
      // exits must LAND — a falling bag reprices inside the quote window,
      // so a tripped stop escalates slippage and then falls through to the
      // gasless Ultra rail before it lets the trail hold a loser another
      // cycle. Better a bad fill than no exit at all.
      let r = null, lastErr = null;
      for (const slip of [SLIPPAGE_SELL_BPS, SLIPPAGE_SELL_BPS * 4]) {
        try { r = await sol.swapAny({ inputMint: pos.mint, outputMint: sol.MINT.USDC, amount: qtyRaw, slippageBps: slip, solBal: bal.sol }); break; }
        catch (e) { lastErr = e; }
      }
      if (!r) {
        try { r = await sol.swapUltra({ inputMint: pos.mint, outputMint: sol.MINT.USDC, amount: qtyRaw, slippageBps: SLIPPAGE_SELL_BPS * 4 }); }
        catch (e) { lastErr = e; }
      }
      if (!r) throw lastErr;
      journal({ side: 'sell', symbol: pos.symbol, mint: pos.mint, qtyRaw, estUsd: mark, costUsd: pos.costUsd, sig: r.signature, reason });
      book.positions = book.positions.filter((p) => p.mint !== pos.mint);
      console.log(`  SOLD ${pos.symbol} ~$${mark.toFixed(2)} sig ${r.signature.slice(0, 12)}… (${reason})`);
    } catch (e) {
      // unsellable dust isn't a position, it's residue — write it off in
      // the book instead of burning a sim-fail retry every single tick.
      if (mark > 0 && mark < DUST_ABANDON_USD) {
        journal({ side: 'abandon', symbol: pos.symbol, mint: pos.mint, estUsd: mark, costUsd: pos.costUsd, note: `unsellable dust — ${String(e.message || e).slice(0, 60)}` });
        book.positions = book.positions.filter((p) => p.mint !== pos.mint);
        console.log(`  🗑 ${pos.symbol}: dust $${mark.toFixed(2)} abandoned (cost $${(pos.costUsd || 0).toFixed(2)} written off)`);
      } else console.log(`  ${pos.symbol}: sell failed ${String(e.message || e).slice(0, 80)}`);
    }
  }

  // ---- entries: top audited candidate, non-perp only ----
  if (book.positions.length >= MAX_POSITIONS || deployed >= MAX_DEPLOYED_USD || spendableUsd < MIN_STABLE_USD) {
    done(spendableUsd < MIN_STABLE_USD ? `purse below floor ($${spendableUsd.toFixed(2)} spendable < $${MIN_STABLE_USD}${vaultRes > 0 ? ` · vault sealed $${vaultRes.toFixed(2)}` : ''})` : 'capacity full');
    return;
  }
  if (!hot || Date.now() - hot.ts > (hot.ttlMs || 900e3)) {
    console.log('onchain-exec: hot feed stale/absent — no entries');
    done('hot feed stale');
    return;
  }
  // fill every open slot this cycle, best-scored first — the purse updates
  // locally as each clip deploys so later buys shrink honestly
  const held = new Set(book.positions.map((p) => p.mint));
  const cands = (hot.hot || []).filter((h) =>
    h.chain === 'solana' && !h.perpAvailable && !held.has(h.contract) &&
    (h.score || 0) >= MIN_SCORE &&
    (+h.chg24h || 0) >= MIN_CHG_PCT &&
    h.audit && !h.audit.rugged && (h.audit.risks || []).length <= 3 &&
    h.liqUsd >= 50e3
  );
  if (!cands.length) { console.log('onchain-exec: no candidate passed gates'); done('no candidate passed gates'); return; }

  let stableLeft = spendableUsd, deployLeft = MAX_DEPLOYED_USD - deployed;
  let usdcLeft = bal.tokens[sol.MINT.USDC] || 0, usdtLeft = bal.tokens[sol.MINT.USDT] || 0;
  for (const cand of cands.slice(0, MAX_POSITIONS - book.positions.length)) {
    const sizeUsd = Math.min(MAX_USD, stableLeft * PCT, deployLeft);
    if (sizeUsd < MIN_SIZE_USD) { console.log(`  purse drained below clip floor ($${sizeUsd.toFixed(2)} < $${MIN_SIZE_USD}) — done entering`); break; }
    // pay with whichever stable actually covers this clip
    const mint = usdcLeft >= sizeUsd ? sol.MINT.USDC : sol.MINT.USDT;
    const inRaw = Math.round(sizeUsd * 1e6);
    console.log(`  BUY ${cand.symbol} $${sizeUsd.toFixed(2)} — score ${cand.score} liq $${(cand.liqUsd / 1e3).toFixed(0)}k vol $${(cand.vol24hUsd / 1e6).toFixed(1)}M mc $${(cand.mcapUsd / 1e6).toFixed(1)}M`);
    try {
      await new Promise((r) => setTimeout(r, 250)); // same burst pacing as the exit pass
      const q = await sol.quote({ inputMint: mint, outputMint: cand.contract, amount: inRaw, slippageBps: SLIPPAGE_BUY_BPS });
      const r = await sol.swapAny({ inputMint: mint, outputMint: cand.contract, amount: inRaw, slippageBps: SLIPPAGE_BUY_BPS, solBal: bal.sol });
      book.positions.push({
        mint: cand.contract, symbol: cand.symbol, qtyRaw: +q.outAmount,
        costUsd: sizeUsd, peakUsd: sizeUsd, lastValueUsd: sizeUsd, ts: Date.now(),
        entryPxUsd: +cand.priceUsd || null,
        score: cand.score, liqUsd: cand.liqUsd, sig: r.signature,
      });
      journal({ side: 'buy', symbol: cand.symbol, mint: cand.contract, usd: sizeUsd, qtyRaw: +q.outAmount, sig: r.signature, score: cand.score });
      stableLeft -= sizeUsd; deployLeft -= sizeUsd; held.add(cand.contract);
      if (mint === sol.MINT.USDC) usdcLeft -= sizeUsd; else usdtLeft -= sizeUsd;
      console.log(`  FILLED ${cand.symbol} sig ${r.signature.slice(0, 12)}…`);
    } catch (e) { console.log(`  ${cand.symbol}: buy failed ${e.message.slice(0, 100)}`); }
  }

  done('cycle complete');
}

main().catch((e) => console.warn(`onchain-exec failed: ${e.message}`));
