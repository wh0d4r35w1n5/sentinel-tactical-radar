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
import * as pp from './exchange/pumpportal.mjs';
import { emitCustody } from './custody-proof.mjs';
import { readJson as readRiskJson, validateRiskPolicy } from './execution-risk.mjs';

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
// --- bot-1 intelligence, ported to the on-chain lane ---
// dead-seat: a bag that never showed favor past NO_FAVOR_H gets cut — same
// doctrine as the futures dead-seat kill (no favorable excursion = wrong seat).
const NO_FAVOR_H = +(process.env.ONCHAIN_NO_FAVOR_H || 8);
const FAVOR_MULT = +(process.env.ONCHAIN_FAVOR_MULT || 1.15);   // "favor" = peak >= cost*1.15
// mint cooldown: a mint that exited red can't be rebought for N hours — the
// cell-level lastLossAt gate, on mints instead of cells.
const MINT_LOSS_CD_H = +(process.env.ONCHAIN_MINT_LOSS_CD_H || 12);
// rolling-loss brake: if the last N realized exits net red by more than
// ROLL_LOSS_USD, entries halt for ROLL_HALT_H — the lane's own CUSUM-lite.
const ROLL_LOSS_USD = +(process.env.ONCHAIN_ROLL_LOSS_USD || 6);
const ROLL_LOSS_N = +(process.env.ONCHAIN_ROLL_LOSS_N || 6);
const ROLL_HALT_H = +(process.env.ONCHAIN_ROLL_HALT_H || 6);
// purse drawdown brake: purse equity (stables + marks) off its latched peak
// past PURSE_DD -> entries blocked. Same dd-kill shape as the futures book.
const PURSE_DD = +(process.env.ONCHAIN_PURSE_DD || 0.35);
// churn brake: > CHURN_MAX round-trip exits in CHURN_WIN_H -> entries pause
// the rest of the window — the fee-burn rail.
const CHURN_MAX = +(process.env.ONCHAIN_CHURN_MAX || 10);
const CHURN_WIN_H = +(process.env.ONCHAIN_CHURN_WIN_H || 12);
// score-tiered sizing: floor-score candidates get a half clip (probe tier),
// clearing SCORE_FULL earns the full clip — probation vs live sizing.
const SCORE_FULL = +(process.env.ONCHAIN_SCORE_FULL || 78);
const EQ_FILE = path.join(STATE, 'onchain-equity-peak.json');

// ---- GRAD lane: pump.fun bonding-curve graduation plays (operator trick
// 2026-11-11 — "buy tokens 8% before graduation"). Buys coins in the last
// stretch of curve progress; the PumpSwap migration is the liquidity event.
// Discovery: GeckoTerminal indexes curve pools — progress derives exactly
// from base_token_price_native_currency via the constant-product formula
// (k = 30 * 1.073e9 virtual reserves; curve sells out at 793.1M tokens).
// Execution: Jupiter routes the curve directly ("Pump.fun" route leg —
// verified live on a still-on-curve quote 2026-11-11), sells work the same
// pre- and post-migration, so the standard trail/dynTp armor manages exits.
const GRAD_ON = process.env.ONCHAIN_GRAD !== '0';
const GRAD_MIN_PROG = +(process.env.ONCHAIN_GRAD_MIN_PROG || 0.9);   // enter at >=90% sold
const GRAD_MAX_PROG = +(process.env.ONCHAIN_GRAD_MAX_PROG || 0.985); // <1.5% buffer before completion
const GRAD_MIN_VOL_USD = +(process.env.ONCHAIN_GRAD_MIN_VOL_USD || 30000); // h24 volume floor — stalled curves don't graduate
const GRAD_MIN_BUYS = +(process.env.ONCHAIN_GRAD_MIN_BUYS || 25);    // h24 buy-tx floor — same reason
const GRAD_PAGES = +(process.env.ONCHAIN_GRAD_PAGES || 4);          // GT pages/cycle — page1-only saw 20 pools, in-zone candidates hide deeper
const GRAD_MIN_BUY_RATIO = +(process.env.ONCHAIN_GRAD_MIN_BUY_RATIO || 0.48); // buys/(buys+sells) — demand must not be distributing into graduation
const GRAD_MIN_BUYERS = +(process.env.ONCHAIN_GRAD_MIN_BUYERS || 15); // unique buyers h24 — one wallet can't fake a crowd
const GRAD_MIN_H1_CHG = +(process.env.ONCHAIN_GRAD_MIN_H1_CHG || -20); // h1 % floor — a curve dumping into the zone is a trap, not a squeeze
const GRAD_PCT = +(process.env.ONCHAIN_GRAD_PCT || 0.34);           // clip = pct of spendable purse
const GRAD_MAX_POS = +(process.env.ONCHAIN_GRAD_MAX_POS || 2);      // concurrent grad seats
const GRAD_MIN_CLIP_USD = +(process.env.ONCHAIN_GRAD_MIN_CLIP_USD || 0.5);
const GRAD_MIN_KEEP_USD = +(process.env.ONCHAIN_GRAD_MIN_KEEP_USD || 0.5);
const GRAD_SLIPPAGE_BPS = +(process.env.ONCHAIN_GRAD_SLIPPAGE_BPS || 400); // curve is thinner than AMM pools near the top
const GRAD_K = 30 * 1.073e9;      // virtual k = virtual_sol * virtual_token reserves
const GRAD_VTOK0 = 1.073e9;       // initial virtual token reserves
const GRAD_SOLD_MAX = 793.1e6;    // tokens for sale on curve — sold out = graduation

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
    // age gate: an orphan must PERSIST across passes before it is sweepable.
    // A token that just landed (operator swap, airdrop, inbound transfer) is
    // not purse fodder — the registration window is one timer cycle, and the
    // CLAUDIA sweep sold an operator buy ~40s after it confirmed (2026-11-08).
    const ORPHAN_AGE_MS = +(process.env.ONCHAIN_ORPHAN_AGE_MS || 600e3);
    const orphanSeen = book.orphanSeen = book.orphanSeen || {};
    // buy-grace: a mint journaled as bought inside BUY_GRACE_MS is mid-
    // registration — book writes can lag a crashed helper by minutes, and
    // the age gate alone let the sweep liquidate the operator's bn5DhJnk
    // deploy ~10min post-buy when its book write crashed (2026-11-11).
    const BUY_GRACE_MS = +(process.env.ONCHAIN_BUY_GRACE_MS || 30 * 60e3);
    const recentBuys = new Set(
      readJ(FILLS_FILE, [])
        .filter((f) => f.side === 'buy' && f.mint && Date.now() - (f.ts || 0) < BUY_GRACE_MS)
        .map((f) => f.mint));
    const orphanCands = Object.keys(bal.tokens).filter((m) => m !== sol.MINT.USDC && m !== sol.MINT.USDT && !heldMints.has(m) && !HOLD_MINTS.has(m) && !recentBuys.has(m) && +bal.tokens[m] > 0);
    for (const m of orphanCands) if (!orphanSeen[m]) orphanSeen[m] = Date.now();
    for (const m of Object.keys(orphanSeen)) if (!orphanCands.includes(m)) delete orphanSeen[m];
    const orphans = orphanCands.filter((m) => Date.now() - orphanSeen[m] > ORPHAN_AGE_MS);
    const fresh = orphanCands.filter((m) => !orphans.includes(m));
    if (fresh.length) console.log(`  ⏳ young orphans held (age<${ORPHAN_AGE_MS / 60e3 | 0}m): ${fresh.map((m) => m.slice(0, 8) + '…').join(', ')}`);
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
  // wallet zero must CONFIRM across 3 passes before reconcile — a single
  // lagged/absent balance read (RPC flake, Token-2022 map miss) used to drop
  // live seats with the tokens still in the wallet (WEALTH seat lost
  // management this way, 2026-11-07). A real external move stays zero.
  const walletQty = (m) => +(bal.tokensRaw?.[m] || bal.tokens?.[m] || 0);
  for (const pos of [...book.positions]) {
    if (walletQty(pos.mint) > 0) { pos.zeroReads = 0; continue; }
    pos.zeroReads = (pos.zeroReads || 0) + 1;
    if (pos.zeroReads < 3) {
      console.log(`  ${pos.symbol}: wallet reads zero (${pos.zeroReads}/3) — holding seat pending confirm`);
      continue;
    }
    // mint-scoped confirm before ANY close — the wallet listing silently
    // misses fresh/lagged ATAs on flaky nodes (CLAUDIA seat nearly false-
    // closed this way 2026-11-08). A mint-scoped read that returns tokens or
    // errors keeps the seat; only a confirmed chain-zero reconciles.
    const scoped = await sol.tokenBalance?.(pos.mint).catch(() => null);
    if (scoped === null || scoped > 0) {
      pos.zeroReads = 0;
      console.log(`  ${pos.symbol}: mint-scoped read ${scoped === null ? 'errored' : 'shows ' + scoped} — listing miss, seat held`);
      continue;
    }
    journal({ side: 'reconcile', symbol: pos.symbol, mint: pos.mint, lane: pos.lane, costUsd: pos.costUsd, note: 'wallet balance zero x3 — closed outside trail' });
    book.positions = book.positions.filter((p) => p.mint !== pos.mint);
    console.log(`  ${pos.symbol}: wallet empty (confirmed) — book reconciled (cost $${(pos.costUsd || 0).toFixed(2)} returned via sweeps)`);
  }

  // ---- exits first: trail every open position ----
  const hot = readJ(path.join(API, 'onchain-hot.json'), null);
  // sniper-lane positions live on pump.fun bonding curves — Jupiter has no
  // route for minutes-old mints, so marks come straight off the curve
  // account and sells go through pumpportal trade-local (see exchange/
  // pumpportal.mjs). solPxUsd feeds the curve's SOL price into USD.
  const sniperSolPx = (() => {
    const c = readJ(path.join(STATE, 'onchain-solpx.json'), null);
    return c?.px && Date.now() - c.ts < 30 * 60e3 ? c.px : 85;
  })();
  for (const pos of [...book.positions]) {
    // sell what the WALLET actually holds, not the book's qtyRaw — partial
    // fills, sweep leftovers, and externally-moved chunks all leave qtyRaw
    // overstated, and every swap built on it sim-fails 'insufficient funds'.
    await new Promise((r) => setTimeout(r, 150)); // lite-api burst pacing
    const wQty = +(bal.tokensRaw?.[pos.mint] || 0);
    if (wQty > 0 && (pos.qtyRaw || 0) > wQty) {
      // external outflow (manual transfer / outside partial sell): the cost
      // basis rides out with the tokens — per-unit marks keep the trail
      // blind to qty, so a manual trim can never read as a price crash.
      pos.costUsd = +((pos.costUsd || 0) * (wQty / pos.qtyRaw)).toFixed(6);
      journal({ side: 'outflow', symbol: pos.symbol, mint: pos.mint, qtyRaw: pos.qtyRaw - wQty, note: 'external outflow — cost basis carried out' });
      pos.qtyRaw = wQty;
    }
    let qtyRaw = Math.min(+pos.qtyRaw || 0, wQty);
    if (!(qtyRaw > 0)) continue; // zero-balance reconcile above owns this case
    // moon bag: trails can only sell the loop portion — the locked floor
    // stays in the wallet through every exit path
    const moonKeepRaw = pos.moonKeepRaw || 0;
    const sellableRaw = Math.max(0, qtyRaw - moonKeepRaw);
    let mark = null;
    try {
      if (pos.lane === 'sniper') {
        // bonding-curve mark — no Jupiter route exists for fresh mints
        const cm = await pp.curveMarkUsd({ mint: pos.mint, qtyRaw, solPxUsd: sniperSolPx });
        if (!cm) throw new Error('curve state unreadable');
        mark = +cm.markUsd.toFixed(6);
        pos.curveDone = cm.complete;
      } else {
      // lite-api free tier answers bursts with Cloudflare HTML — one backoff
      // retry keeps a transient 429 from freezing a tripped stop. The 150ms
      // pacing between positions smooths the burst at the source.
      let q = null, qErr = null;
      for (let att = 0; att < 2 && !q; att++) {
        try {
          // mark quotes the WHOLE position (qtyRaw), never just the loop
          // portion — with a moon bag, quoting sellableRaw understates
          // unitMark by the moon fraction and fires phantom trail exits
          // (G:OSARU sold its loop 3min after entry on exactly this, 2026-11-11)
          q = await sol.quote({
            inputMint: pos.mint, outputMint: sol.MINT.USDC,
            amount: qtyRaw, slippageBps: SLIPPAGE_SELL_BPS,
          });
        } catch (e) { qErr = e; if (!att) await new Promise((r) => setTimeout(r, 1500)); }
      }
      if (!q) throw qErr;
      mark = +q.outAmount / 1e6;
      }
    } catch (e) { console.log(`  ${pos.symbol}: quote fail ${e.message.slice(0, 60)} — trail holds`); continue; }
    pos.lastValueUsd = mark;
    pos.peakUsd = Math.max(pos.peakUsd || mark, mark);
    // FEE_LOCK is a profit lock, not a -1.5% entry stop — a memecoin
    // sell-quote sits structurally below buy-in on tick one, so the cost
    // floor only tightens once peak has cleared the round-trip (LOCK_ARM).
    const prof = pos.profile || {};
    // per-unit marks — the trail compares value-per-token, never the bag
    // total, so partial outflows can't impersonate a price dump.
    const unitMark = mark / qtyRaw;
    if (!(pos.unitCost > 0)) pos.unitCost = (pos.costUsd || 0) > 0 ? pos.costUsd / qtyRaw : unitMark;
    pos.peakUnit = Math.max(pos.peakUnit || unitMark, unitMark);
    const locked = pos.peakUnit > pos.unitCost * (prof.arm ?? LOCK_ARM);
    const trailStop = Math.max(pos.unitCost * (locked ? (prof.feeLock ?? FEE_LOCK) : (prof.floor ?? STOP_LOSS)), pos.peakUnit * (prof.keep ?? KEEP));
    // floor:0 = operator never-sell-at-loss mandate (WEALTH 2026-11-06):
    // the trail only exists in the profit zone — a peak retrace that would
    // close below cost is NOT an exit, the seat holds. Ladder rungs and the
    // armed feeLock still bank the upside.
    const noLoss = +(prof.floor ?? 1) === 0;
    const trailHit = unitMark < trailStop && (!noLoss || trailStop >= pos.unitCost);
    const heldH = (Date.now() - pos.ts) / 36e5;

    // staggered TP ladder — profile.tpLadder: [{mult, pct}] sells pct of the
    // CURRENT wallet qty each time mark crosses cost*mult; rungs are sticky
    // (pos.ladderDone) so a single cycle can't double-fire one.
    // dynamic staggered TP — prof.dynTp {stepPct, sellPct, coverMult, outMint}:
    // rungs RE-ANCHOR on every fill instead of a fixed multiplier table — each
    // +stepPct above the higher of (last sell mark, cost×coverMult) sells
    // sellPct of the LOOP portion. A trend keeps banking indefinitely (no
    // "ladder exhausted"); coverMult (default 1.03) keeps every sale above the
    // round-trip fee toll; proceeds settle to SOL by default (operator mandate
    // 2026-11-08: profit back into SOL, net of fees, same staggered TP shape
    // as the Bitget-side ladder).
    const dyn = prof.dynTp || null;
    if (dyn && pos.unitCost > 0 && (wQty > 0)) {
      if (prof.moonKeep && pos.moonKeepRaw == null)
        pos.moonKeepRaw = Math.floor(qtyRaw * prof.moonKeep);
      const moonKeep = pos.moonKeepRaw || 0;
      const cover = pos.unitCost * +(dyn.coverMult || 1.03);
      const anchor = Math.max(+pos.lastTpUnit || 0, cover);
      const trigger = anchor * (1 + +(dyn.stepPct || 0.15));
      if (unitMark >= trigger) {
        const sellable = Math.max(0, qtyRaw - moonKeep);
        const sellRaw = Math.min(Math.floor(qtyRaw * +(dyn.sellPct || 0.12)), sellable);
        if (!(sellRaw > 0)) {
          if (sellable <= 0) console.log(`  ${pos.symbol}: moon-bag floor reached — dyn-tp fully banked`);
        } else {
          const outMint = dyn.outMint || sol.MINT.SOL;
          try {
            let rr = null, tpErr = null;
            if (pos.lane === 'sniper') {
              // bonding-curve sell — proceeds come back in SOL regardless of
              // outMint; Jupiter has no route for fresh mints
              try { rr = await pp.curveSell({ mint: pos.mint, tokenUiAmount: +(sellRaw / 1e6).toFixed(6), slippage: 25 }); }
              catch (e) { tpErr = e; }
            } else {
            for (const slip of [SLIPPAGE_SELL_BPS, SLIPPAGE_SELL_BPS * 4]) {
              try { rr = await sol.swapAny({ inputMint: pos.mint, outputMint: outMint, amount: sellRaw, slippageBps: slip, solBal: bal.sol }); break; }
              catch (e) { tpErr = e; }
            }
            if (!rr) { try { rr = await sol.swapUltra({ inputMint: pos.mint, outputMint: outMint, amount: sellRaw, slippageBps: SLIPPAGE_SELL_BPS * 4 }); } catch (e) { tpErr = e; } }
            }
            if (!rr) throw tpErr;
            journal({ side: 'tp-sell', symbol: pos.symbol, mint: pos.mint, lane: pos.lane, qtyRaw: sellRaw, estUsd: +(unitMark * sellRaw).toFixed(4), costUsd: +(pos.unitCost * sellRaw).toFixed(4), netUsd: +((unitMark - pos.unitCost) * sellRaw).toFixed(4), sig: rr.signature, reason: `dyn-tp @${(trigger / pos.unitCost).toFixed(2)}x → SOL` });
            pos.qtyRaw = Math.max(0, (pos.qtyRaw || 0) - sellRaw);
            if (bal.tokensRaw) bal.tokensRaw[pos.mint] = Math.max(0, (bal.tokensRaw[pos.mint] || 0) - sellRaw);
            pos.lastTpUnit = unitMark;
            console.log(`  DYN-TP ${pos.symbol}: sold ${(+(dyn.sellPct || 0.12) * 100) | 0}% loop @ ${(trigger / pos.unitCost).toFixed(2)}x → SOL sig ${rr.signature.slice(0, 12)}`);
          } catch (e) { console.log(`  ${pos.symbol}: dyn-tp failed ${String(e.message || e).slice(0, 80)}`); }
        }
      }
    }

    const ladder = prof.tpLadder || null;
    if (ladder && !dyn && (pos.costUsd || 0) > 0) {
      pos.ladderDone = pos.ladderDone || [];
      // moon bag (operator mandate 2026-11-07): prof.moonKeep freezes a share
      // of the seat qty that TP rungs and trails can NEVER sell — the loop
      // plays the rest, the bag rides to zero or 1000x with the operator.
      if (!(wQty > 0)) continue; // lagged balance read — never burn rungs on phantom qty
      if (prof.moonKeep && pos.moonKeepRaw == null)
        pos.moonKeepRaw = Math.floor(qtyRaw * prof.moonKeep);
      const moonKeepRaw = pos.moonKeepRaw || 0;
      for (let i = 0; i < ladder.length; i++) {
        const rung = ladder[i];
        if (pos.ladderDone.includes(i) || unitMark < pos.unitCost * rung.mult) continue;
        const sellable = Math.max(0, qtyRaw - moonKeepRaw);
        const sellRaw = Math.min(Math.floor(qtyRaw * rung.pct), sellable);
        if (!(sellRaw > 0)) { pos.ladderDone.push(i); if (sellable <= 0) console.log(`  ${pos.symbol}: moon-bag floor reached — loop fully banked`); continue; }
        try {
          let rr = null, tpErr = null;
          if (pos.lane === 'sniper') {
            try { rr = await pp.curveSell({ mint: pos.mint, tokenUiAmount: +(sellRaw / 1e6).toFixed(6), slippage: 25 }); }
            catch (e) { tpErr = e; }
          } else {
          for (const slip of [SLIPPAGE_SELL_BPS, SLIPPAGE_SELL_BPS * 4]) {
            try { rr = await sol.swapAny({ inputMint: pos.mint, outputMint: sol.MINT.USDC, amount: sellRaw, slippageBps: slip, solBal: bal.sol }); break; }
            catch (e) { tpErr = e; }
          }
          if (!rr) { try { rr = await sol.swapUltra({ inputMint: pos.mint, outputMint: sol.MINT.USDC, amount: sellRaw, slippageBps: SLIPPAGE_SELL_BPS * 4 }); } catch (e) { tpErr = e; } }
          }
          if (!rr) throw tpErr;
          journal({ side: 'tp-sell', symbol: pos.symbol, mint: pos.mint, lane: pos.lane, qtyRaw: sellRaw, estUsd: +(unitMark * sellRaw).toFixed(4), costUsd: +(pos.unitCost * sellRaw).toFixed(4), netUsd: +((unitMark - pos.unitCost) * sellRaw).toFixed(4), sig: rr.signature, reason: `tp-rung${i + 1} @${rung.mult}x` });
          pos.qtyRaw = Math.max(0, (pos.qtyRaw || 0) - sellRaw);
          if (bal.tokensRaw) bal.tokensRaw[pos.mint] = Math.max(0, (bal.tokensRaw[pos.mint] || 0) - sellRaw);
          pos.ladderDone.push(i);
          console.log(`  TP${i + 1} ${pos.symbol}: sold ${(rung.pct * 100) | 0}% @ ${rung.mult}x mark $` + mark.toFixed(2) + ` sig ${rr.signature.slice(0, 12)}`);
          await new Promise((r2) => setTimeout(r2, 150));
        } catch (e) { console.log(`  ${pos.symbol}: tp-rung${i + 1} failed ${String(e.message || e).slice(0, 80)}`); }
      }
    }

    const reason =
      trailHit ? `trail u${unitMark.toFixed(6)}<u${trailStop.toFixed(6)}` :
      !noLoss && heldH > NO_FAVOR_H && pos.peakUnit < pos.unitCost * FAVOR_MULT ? `dead-seat no favor ${heldH.toFixed(0)}h` :
      !noLoss && heldH > (prof.maxHoldH ?? MAX_HOLD_H) && unitMark < pos.unitCost * 1.05 ? `age ${heldH.toFixed(0)}h unprofitable` :
      null;
    console.log(`  ${pos.symbol}: $${mark.toFixed(2)} (cost $${pos.costUsd.toFixed(2)}, peak $${pos.peakUsd.toFixed(2)})${reason ? ' → ' + reason : ''}`);
    if (!reason) continue;
    // moon bag: exits sell only the loop portion — the locked floor rides
    // regardless of trails/stops. Seats with no floor (moonKeepRaw=0) exit
    // whole exactly as before.
    const exitRaw = Math.max(0, qtyRaw - (pos.moonKeepRaw || 0));
    if (!(exitRaw > 0)) {
      // moon-only seat — clear the stale armed peak too, or the next avg-in
      // gets instantly trail-sold against a peak that was already monetized
      pos.peakUnit = unitMark;
      pos.peakUsd = Math.min(pos.peakUsd || mark, mark);
      console.log(`  ${pos.symbol}: moon-bag only — ${reason} ignored`);
      continue;
    }
    try {
      // exits must LAND — a falling bag reprices inside the quote window,
      // so a tripped stop escalates slippage and then falls through to the
      // gasless Ultra rail before it lets the trail hold a loser another
      // cycle. Better a bad fill than no exit at all.
      let r = null, lastErr = null;
      if (pos.lane === 'sniper') {
        try { r = await pp.curveSell({ mint: pos.mint, tokenUiAmount: +(exitRaw / 1e6).toFixed(6), slippage: 30 }); }
        catch (e) { lastErr = e; }
      } else {
      for (const slip of [SLIPPAGE_SELL_BPS, SLIPPAGE_SELL_BPS * 4]) {
        try { r = await sol.swapAny({ inputMint: pos.mint, outputMint: sol.MINT.USDC, amount: exitRaw, slippageBps: slip, solBal: bal.sol }); break; }
        catch (e) { lastErr = e; }
      }
      if (!r) {
        try { r = await sol.swapUltra({ inputMint: pos.mint, outputMint: sol.MINT.USDC, amount: exitRaw, slippageBps: SLIPPAGE_SELL_BPS * 4 }); }
        catch (e) { lastErr = e; }
      }
      }
      if (!r) throw lastErr;
      const exitFrac = exitRaw / qtyRaw;
      journal({ side: 'sell', symbol: pos.symbol, mint: pos.mint, lane: pos.lane, qtyRaw: exitRaw, estUsd: +(mark * exitFrac).toFixed(4), costUsd: +((pos.costUsd || 0) * exitFrac).toFixed(4), netUsd: +((mark - (pos.costUsd || 0)) * exitFrac).toFixed(4), sig: r.signature, reason });
      if (qtyRaw - exitRaw > 0) {
        pos.qtyRaw = qtyRaw - exitRaw;
        if (pos.unitCost > 0) pos.costUsd = +(pos.unitCost * pos.qtyRaw).toFixed(4);
        if (bal.tokensRaw) bal.tokensRaw[pos.mint] = Math.max(0, (bal.tokensRaw[pos.mint] || 0) - exitRaw);
        // the old peak was monetized — clear it so dip rebuys aren't instantly
        // trail-sold by a stale armed stop (whipsaw trap, WEALTH 2026-11-06)
        pos.peakUnit = unitMark;
        pos.peakUsd = Math.min(pos.peakUsd || mark, mark);
        console.log(`  SOLD ${pos.symbol} loop-portion ~$${(mark * exitFrac).toFixed(2)} sig ${r.signature.slice(0, 12)}… (${reason}) — moon bag ${pos.qtyRaw} raw rides`);
      } else {
        book.positions = book.positions.filter((p) => p.mint !== pos.mint);
        console.log(`  SOLD ${pos.symbol} ~$${mark.toFixed(2)} sig ${r.signature.slice(0, 12)}… (${reason})`);
      }
    } catch (e) {
      // unsellable dust isn't a position, it's residue — write it off in
      // the book instead of burning a sim-fail retry every single tick.
      if (mark > 0 && mark < DUST_ABANDON_USD) {
        journal({ side: 'abandon', symbol: pos.symbol, mint: pos.mint, lane: pos.lane, estUsd: mark, costUsd: pos.costUsd, note: `unsellable dust — ${String(e.message || e).slice(0, 60)}` });
        book.positions = book.positions.filter((p) => p.mint !== pos.mint);
        console.log(`  🗑 ${pos.symbol}: dust $${mark.toFixed(2)} abandoned (cost $${(pos.costUsd || 0).toFixed(2)} written off)`);
      } else console.log(`  ${pos.symbol}: sell failed ${String(e.message || e).slice(0, 80)}`);
    }
  }

  // ---- entries: top audited candidate, non-perp only ----
  // Existing exits remain active; funding the wallet must not silently re-arm
  // an unvalidated entry engine outside the futures admission policy. An
  // unreadable policy file means entries OFF — it must never kill the exit
  // bookkeeping that already ran above.
  let entriesAllowed = false;
  try {
    entriesAllowed =
      validateRiskPolicy(readRiskJson(path.join(STATE, 'execution-risk.json'))).allowOnchainEntries === true &&
      readRiskJson(path.join(STATE, 'execution-maintenance.json'), true)?.active !== true;
  } catch {}
  // FORCE-ACCUMULATE (operator order 2026-11-06 — "keep buying WEALTH
  // on loop as directed; take profit regularly on the way up; move the
  // stop into zero-risk-with-buffer once clear"). Every pass buys the
  // mandated mint with a clip of spendable purse and registers/avg-ins
  // the book position so the trail+ladder machinery manages it:
  //   floor 0.75 pre-profit (bounded, not a coin-flip close),
  //   feeLock 1.01 once peak > cost*1.02  = zero-risk PLUS buffer,
  //   keep 0.80 trail, denser TP rungs banking on the way up,
  //   maxHoldH ~1yr — the accumulation seat never expires.
  const FORCE_MINT = process.env.ONCHAIN_FORCE_MINT || '';
  const FORCE_SYM = process.env.ONCHAIN_FORCE_SYM || 'FORCE';
  const FORCE_CLIP_USD = +(process.env.ONCHAIN_FORCE_CLIP_USD || 0); // 0 = PCT x spendable
  const FORCE_MAX_COST = +(process.env.ONCHAIN_FORCE_MAX_COST_USD || 50);
  const FORCE_MIN_KEEP = +(process.env.ONCHAIN_FORCE_MIN_KEEP_USD || 0.5);
  if (FORCE_MINT && spendableUsd - FORCE_MIN_KEEP >= MIN_SIZE_USD) {
    const clip = Math.min(FORCE_CLIP_USD || spendableUsd * PCT, spendableUsd - FORCE_MIN_KEEP, MAX_USD);
    const existing = book.positions.find((pp) => pp.mint === FORCE_MINT);
    const FORCE_GAS_MIN = +(process.env.ONCHAIN_FORCE_GAS_MIN || 0.002); // mandated lane: Ultra goes gasless under 0.004 anyway — don't starve the buy on a conservative floor (WEALTH rebuy blocked at sol=0.004, 2026-11-06)
    if (clip >= MIN_SIZE_USD && bal.sol >= FORCE_GAS_MIN && (existing?.costUsd || 0) < FORCE_MAX_COST) {
      const payMint = (bal.tokens[sol.MINT.USDC] || 0) >= clip ? sol.MINT.USDC : sol.MINT.USDT; // bal.tokens is UI units — compare to clip USD, not raw lamports
      const inRaw = Math.round(clip * 1e6);
      console.log(`  FORCE-BUY ${FORCE_SYM} $${clip.toFixed(2)} — accumulate loop`);
      try {
        await new Promise((r) => setTimeout(r, 250));
        const q = await sol.quote({ inputMint: payMint, outputMint: FORCE_MINT, amount: inRaw, slippageBps: SLIPPAGE_BUY_BPS });
        const r = await sol.swapAny({ inputMint: payMint, outputMint: FORCE_MINT, amount: inRaw, slippageBps: SLIPPAGE_BUY_BPS, solBal: bal.sol });
        const fprof = { floor: +(process.env.ONCHAIN_FORCE_FLOOR || 0.75), arm: +(process.env.ONCHAIN_LOCK_ARM || 99), feeLock: +(process.env.ONCHAIN_FEE_LOCK || 1.01), keep: +(process.env.ONCHAIN_KEEP || 0.5), maxHoldH: 8760,
          moonKeep: +(process.env.ONCHAIN_FORCE_MOON_KEEP || 0.4),
          tpLadder: [{ mult: 1.15, pct: 0.15 }, { mult: 1.3, pct: 0.15 }, { mult: 1.6, pct: 0.2 }, { mult: 2.0, pct: 0.2 }, { mult: 3.0, pct: 0.25 }, { mult: 4.0, pct: 0.3 }, { mult: 6.0, pct: 0.4 }] };
        if (existing) {
          existing.qtyRaw = (+existing.qtyRaw || 0) + (+q.outAmount);
          existing.costUsd = +(existing.costUsd || 0) + clip;
          existing.profile = existing.profile || fprof;
          existing.lastValueUsd = existing.costUsd;
          console.log(`  FILLED (avg-in) sig ${r.signature.slice(0, 12)}… total cost $${existing.costUsd.toFixed(2)}`);
        } else {
          book.positions.push({ mint: FORCE_MINT, symbol: FORCE_SYM, qtyRaw: +q.outAmount, costUsd: clip, peakUsd: clip,
            lastValueUsd: clip, ts: Date.now(), entryPxUsd: null, score: null, liqUsd: null, sig: r.signature, profile: fprof });
          console.log(`  FILLED (new seat) sig ${r.signature.slice(0, 12)}…`);
        }
        journal({ side: 'buy', symbol: FORCE_SYM, mint: FORCE_MINT, usd: clip, qtyRaw: +q.outAmount, sig: r.signature, force: true });
      } catch (e) { console.log(`  FORCE-BUY failed ${(e.message || '').slice(0, 120)}`); }
    }
  }

  // --- brakes (bot-1 rails, purse-shaped) ---
  const fillsLog = readJ(FILLS_FILE, []);
  const exits = fillsLog.filter((f) => ['sell', 'tp-sell', 'abandon', 'reconcile'].includes(f.side) && f.costUsd != null);
  const purseEq = spendableUsd + deployed;
  const eqTrack = readJ(EQ_FILE, null) || { peak: purseEq };
  if (purseEq > (eqTrack.peak || 0)) { eqTrack.peak = purseEq; writeJ(EQ_FILE, eqTrack); }
  const purseDdPct = eqTrack.peak > 0 ? (eqTrack.peak - purseEq) / eqTrack.peak : 0;
  if (purseDdPct >= PURSE_DD) { console.log(`  🔒 purse-dd brake ${(purseDdPct * 100).toFixed(1)}% >= ${(PURSE_DD * 100)}% — entries blocked`); done('purse-dd brake'); return; }
  // rolling-loss brake scopes to the standard lane — legacy fills (RCAT
  // write-offs etc.) must not permanently park the operator-directed GRAD
  // lane, which carries its own mini-brake inside its block below.
  const exitsStd = exits.filter((f) => f.lane !== 'grad');
  const recentNet = exitsStd.slice(-ROLL_LOSS_N).reduce((a, f) => a + ((f.estUsd || 0) - (f.costUsd || 0)), 0);
  let rollingBraked = false;
  if (exitsStd.length >= ROLL_LOSS_N && recentNet < -ROLL_LOSS_USD) {
    const lastExit = exits[exits.length - 1]?.ts || 0;
    if (Date.now() - lastExit < ROLL_HALT_H * 36e5) { console.log(`  🔒 rolling-loss brake $${recentNet.toFixed(2)} net on last ${ROLL_LOSS_N} std exits — std entries halted ${ROLL_HALT_H}h`); rollingBraked = true; }
  }
  const churned = exits.filter((f) => Date.now() - f.ts < CHURN_WIN_H * 36e5).length;
  if (churned >= CHURN_MAX) { console.log(`  🔒 churn brake ${churned} exits/${CHURN_WIN_H}h — entries paused`); done('churn brake'); return; }
  const lossCd = {};
  for (const f of exits.slice(-40)) if ((f.estUsd || 0) < (f.costUsd || 0) && f.mint) lossCd[f.mint] = f.ts;

  if (book.positions.length >= MAX_POSITIONS || deployed >= MAX_DEPLOYED_USD || spendableUsd < MIN_STABLE_USD) {
    done(spendableUsd < MIN_STABLE_USD ? `purse below floor ($${spendableUsd.toFixed(2)} spendable < $${MIN_STABLE_USD}${vaultRes > 0 ? ` · vault sealed $${vaultRes.toFixed(2)}` : ''})` : 'capacity full');
    return;
  }

  // ---- GRAD lane entries: last-stretch bonding-curve buys. Operator-directed
  // lane (same class as FORCE-BUY): it runs on its own ONCHAIN_GRAD flag and
  // does NOT consume the execution-risk entriesAllowed policy — that policy
  // gates the unvalidated hot-feed lane only. It DOES respect the purse-dd /
  // rolling-loss / churn brakes above and carries its own position cap so it
  // can't crowd the established-token lane.
  const gradHeld = book.positions.filter((p) => p.lane === 'grad').length;
  // SOL float counts toward the grad purse — the curve is SOL-native, so a
  // SOL-funded buy skips the USDC->SOL conversion leg entirely. Price comes
  // from a 0.01 SOL -> USDC probe quote; a reserve stays locked for fees +
  // the next ATA rent.
  const GRAD_SOL_RESERVE = +(process.env.ONCHAIN_GRAD_SOL_RESERVE || 0.005);
  const SOLPX_FILE = path.join(STATE, 'onchain-solpx.json');
  let gradSolPx = null, gradSolSpend = 0;
  const solPxCached = readJ(SOLPX_FILE, null);
  if (solPxCached?.px && Date.now() - solPxCached.ts < 10 * 60e3) gradSolPx = solPxCached.px;
  if (!gradSolPx && GRAD_ON && gradHeld < GRAD_MAX_POS && bal.sol > GRAD_SOL_RESERVE) {
    try {
      const pq = await sol.quote({ inputMint: sol.MINT.SOL, outputMint: sol.MINT.USDC, amount: 1e7, slippageBps: 100 });
      gradSolPx = (+pq.outAmount || 0) / 1e6 / 0.01;
      if (gradSolPx > 0) writeJ(SOLPX_FILE, { px: gradSolPx, ts: Date.now() });
    } catch {}
    // classic quote endpoint 429s under burst — the /price/v3 route has its
    // own budget and returns the same USDC-per-SOL number (verified
    // 2026-11-11: price api answered while swap/v1 was hard-limited).
    if (!gradSolPx) {
      try {
        const pr = await fetch(`https://lite-api.jup.ag/price/v3?ids=${sol.MINT.SOL}`, { signal: AbortSignal.timeout(8000) });
        const pj = await pr.json();
        const u = +(pj?.[sol.MINT.SOL]?.usdPrice || 0);
        if (u > 0) { gradSolPx = u; writeJ(SOLPX_FILE, { px: u, ts: Date.now() }); }
      } catch {}
    }
  }
  if (gradSolPx) gradSolSpend = Math.max(0, bal.sol - GRAD_SOL_RESERVE) * gradSolPx;
  if (GRAD_ON && gradHeld < GRAD_MAX_POS && (spendableUsd + gradSolSpend) - GRAD_MIN_KEEP_USD >= GRAD_MIN_CLIP_USD) {
    // gas/ATA reserve: every grad buy creates a fresh token account (~0.002
    // SOL rent) plus fees — a sub-0.006 SOL wallet sim-fails every fill.
    // Top up gaslessly via Ultra (relayer pays) when the purse can spare it.
    const GRAD_GAS_MIN = +(process.env.ONCHAIN_GRAD_GAS_MIN || 0.006);
    const GRAD_GAS_TOPUP_USD = +(process.env.ONCHAIN_GRAD_GAS_TOPUP_USD || 0.3);
    let stableSpend = spendableUsd, solSpend = gradSolSpend;
    if (bal.sol < GRAD_GAS_MIN && (bal.tokens[sol.MINT.USDC] || 0) >= GRAD_GAS_TOPUP_USD + 0.5) {
      try {
        const gr = await sol.swapUltra({ inputMint: sol.MINT.USDC, outputMint: sol.MINT.SOL, amount: Math.round(GRAD_GAS_TOPUP_USD * 1e6), slippageBps: 100 });
        journal({ side: 'gas-topup', usd: GRAD_GAS_TOPUP_USD, sig: gr.signature, lane: 'grad' });
        console.log(`  GRAD gas top-up $${GRAD_GAS_TOPUP_USD} -> SOL sig ${(gr.signature || '').slice(0, 12)}…`);
        bal.sol += (+gr.outAmount || 0) / 1e9;
        bal.tokens[sol.MINT.USDC] = Math.max(0, (bal.tokens[sol.MINT.USDC] || 0) - GRAD_GAS_TOPUP_USD);
        stableSpend = Math.max(0, stableSpend - GRAD_GAS_TOPUP_USD);
        solSpend = gradSolPx ? Math.max(0, bal.sol - GRAD_SOL_RESERVE) * gradSolPx : solSpend;
      } catch (e) { console.log(`  grad gas top-up failed: ${String(e.message || e).slice(0, 80)}`); }
    }
    const solPxUsd = gradSolPx;
    let solSpendUsd = solSpend;
    const gradPurse = stableSpend + solSpend;
    // grad mini-brake: last 3 realized grad exits net worse than GRAD_ROLL_USD
    // pauses new grad buys — the lane's own evidence gate, proportional to a
    // lottery strategy (a couple of dead curves shouldn't halt it forever,
    // a bleeding streak should).
    const GRAD_ROLL_USD = +(process.env.ONCHAIN_GRAD_ROLL_USD || 2);
    const gradExits = exits.filter((f) => f.lane === 'grad');
    const gradNet = gradExits.slice(-3).reduce((a, f) => a + ((f.estUsd || 0) - (f.costUsd || 0)), 0);
    const gradBraked = gradExits.length >= 3 && gradNet < -GRAD_ROLL_USD;
    if (gradBraked) console.log(`  🔒 grad brake $${gradNet.toFixed(2)} net on last ${gradExits.length} grad exits — buys paused`);
    try {
      // multi-page scan: pump.fun runs hundreds of live curves and the
      // in-zone candidates are not all on page 1 — sort is by h24 volume
      // so deeper pages still clear the volume/buy floors.
      const pools = [];
      for (let pg = 1; pg <= GRAD_PAGES; pg++) {
        const gtRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/pump-fun/pools?sort=h24_volume_usd_desc&page=${pg}`, { signal: AbortSignal.timeout(12000) });
        const gt = await gtRes.json();
        const rows = gt.data || [];
        pools.push(...rows);
        if (rows.length < 20) break;
        await new Promise((r) => setTimeout(r, 400)); // GT rate-limit courtesy
      }
      const WSOL = 'solana_So11111111111111111111111111111111111111112';
      const heldMints = new Set(book.positions.map((p) => p.mint));
      const gradCands = [];
      for (const p of pools) {
        const a = p.attributes || {};
        const mint = (p.relationships?.base_token?.data?.id || '').split('_')[1] || '';
        if (!mint.endsWith('pump') || (p.relationships?.quote_token?.data?.id || '') !== WSOL) continue;
        const px = +a.base_token_price_native_currency;
        if (!(px > 0)) continue;
        const vtok = Math.sqrt(GRAD_K / px);
        const prog = (GRAD_VTOK0 - vtok) / GRAD_SOLD_MAX;
        if (!(prog >= GRAD_MIN_PROG && prog <= GRAD_MAX_PROG)) continue;
        // reserve_in_usd is 0 for pump.fun bonding-curve pools (field only
        // tracks AMM reserves) — every near-graduation candidate failed the
        // old $500 floor (verified 2026-11-11: prog .95-.99 pools all res=0).
        // Curve solvency is proven by prog itself — a 95%-sold curve cannot
        // be drained; graduated pools exceed MAX_PROG. FDV floor replaces it.
        const curveRes = +(a.reserve_in_usd || 0);
        if ((+a.fdv_usd || 0) < 5000) continue; // dead/micro curve — no crowd
        const vol24 = +(a.volume_usd?.h24 || 0);
        const buys24 = +(a.transactions?.h24?.buys || 0);
        if (vol24 < GRAD_MIN_VOL_USD || buys24 < GRAD_MIN_BUYS) continue;
        const sells24 = +(a.transactions?.h24?.sells || 0);
        const buyers24 = +(a.transactions?.h24?.buyers || 0);
        const txTot = buys24 + sells24;
        if (txTot > 0 && buys24 / txTot < GRAD_MIN_BUY_RATIO) continue; // distribution into the zone
        if (buyers24 < GRAD_MIN_BUYERS) continue;                        // no crowd = no squeeze
        const h1chg = +((a.price_change_percentage?.h1 ?? 0));
        if (h1chg < GRAD_MIN_H1_CHG) continue;                           // dumping into graduation = trap
        if (heldMints.has(mint)) continue;
        if (lossCd[mint] && Date.now() - lossCd[mint] < MINT_LOSS_CD_H * 36e5) continue;
        gradCands.push({
          mint, symbol: (a.name || mint.slice(0, 6)).split('/')[0].trim().toUpperCase() || mint.slice(0, 6),
          prog, curveRes, vol24, buys24, fdv: +a.fdv_usd || 0,
          buyRatio: txTot ? +(buys24 / txTot).toFixed(2) : null, buyers24, h1chg,
        });
      }
      gradCands.sort((x, y) => y.vol24 - x.vol24);
      let gradLeft = gradPurse - GRAD_MIN_KEEP_USD;
      const GRAD_CLIP_USD = +(process.env.ONCHAIN_GRAD_CLIP_USD || 0); // fixed clip override — at purse scale pct math dips under the floor
      if (process.env.ONCHAIN_GRAD_DEBUG) console.log('  GRADDBG purse=' + gradPurse.toFixed(4) + ' stableSpend=' + stableSpend.toFixed(4) + ' solSpend=' + solSpend.toFixed(4) + ' solSpendUsd=' + (solSpendUsd||0).toFixed(4) + ' clipUsd=' + GRAD_CLIP_USD + ' pct=' + GRAD_PCT + ' minClip=' + GRAD_MIN_CLIP_USD + ' keep=' + GRAD_MIN_KEEP_USD);
      for (const c of (gradBraked ? [] : gradCands).slice(0, GRAD_MAX_POS - gradHeld)) {
        const clip = Math.min(GRAD_CLIP_USD || GRAD_PCT * gradPurse, gradLeft, MAX_USD);
        if (clip < GRAD_MIN_CLIP_USD) break;
        const usdcHave = bal.tokens[sol.MINT.USDC] || 0, usdtHave = bal.tokens[sol.MINT.USDT] || 0;
        const payMint = usdcHave >= clip ? sol.MINT.USDC : usdtHave >= clip ? sol.MINT.USDT :
          (solPxUsd && solSpendUsd >= clip ? sol.MINT.SOL : null);
        if (!payMint) continue;
        const inRaw = payMint === sol.MINT.SOL ? Math.round((clip / solPxUsd) * 1e9) : Math.round(clip * 1e6);
        console.log(`  GRAD-BUY ${c.symbol} $${clip.toFixed(2)} — curve ${(c.prog * 100).toFixed(1)}% fdv $${(c.fdv / 1e3).toFixed(0)}k vol24 $${(c.vol24 / 1e3).toFixed(0)}k buys24 ${c.buys24}`);
        try {
          await new Promise((r) => setTimeout(r, 250));
          // swapAny returns outAmount on both rails — skip a separate quote
          // call; lite-api 429s under burst and every saved call is headroom.
          const r = await sol.swapAny({ inputMint: payMint, outputMint: c.mint, amount: inRaw, slippageBps: GRAD_SLIPPAGE_BPS, solBal: bal.sol });
          const outRaw = +r.outAmount || 0;
          if (!(outRaw > 0)) throw new Error('swap returned zero outAmount');
          book.positions.push({
            mint: c.mint, symbol: `G:${c.symbol}`, lane: 'grad', qtyRaw: outRaw,
            costUsd: clip, peakUsd: clip, lastValueUsd: clip, ts: Date.now(),
            entryPxUsd: null, score: null, liqUsd: c.curveRes, sig: r.signature,
            gradProg: +c.prog.toFixed(4), gradFdvUsd: c.fdv,
            profile: {
              floor: +(process.env.ONCHAIN_GRAD_FLOOR || 0.78),
              arm: +(process.env.ONCHAIN_GRAD_ARM || 1.02),
              feeLock: +(process.env.ONCHAIN_GRAD_FEE_LOCK || 1.0),
              keep: +(process.env.ONCHAIN_GRAD_KEEP || 0.72),
              maxHoldH: +(process.env.ONCHAIN_GRAD_MAX_HOLD_H || 12),
              moonKeep: +(process.env.ONCHAIN_GRAD_MOON_KEEP || 0.15),
              dynTp: {
                stepPct: +(process.env.ONCHAIN_GRAD_DYN_STEP || 0.12),
                sellPct: +(process.env.ONCHAIN_GRAD_DYN_SELL || 0.15),
                coverMult: 1.04,
                outMint: sol.MINT.SOL,
              },
            },
          });
          journal({ side: 'buy', symbol: `G:${c.symbol}`, mint: c.mint, usd: clip, qtyRaw: outRaw, sig: r.signature, lane: 'grad', prog: +c.prog.toFixed(4), fdvUsd: c.fdv, vol24hUsd: c.vol24, payMint: payMint === sol.MINT.SOL ? 'SOL' : payMint === sol.MINT.USDC ? 'USDC' : 'USDT' });
          gradLeft -= clip;
          if (payMint === sol.MINT.USDC) bal.tokens[sol.MINT.USDC] = Math.max(0, usdcHave - clip);
          else if (payMint === sol.MINT.USDT) bal.tokens[sol.MINT.USDT] = Math.max(0, usdtHave - clip);
          else { bal.sol = Math.max(0, bal.sol - clip / solPxUsd); solSpendUsd = Math.max(0, solSpendUsd - clip); }
          console.log(`  GRAD FILLED ${c.symbol} sig ${r.signature.slice(0, 12)}…`);
        } catch (e) { console.log(`  GRAD ${c.symbol}: buy failed ${String(e.message || e).slice(0, 100)}`); }
      }
      // always log the scan — silence is indistinguishable from a dead lane
      // (silent degradation is how lanes rot invisibly; 2026-11-11 audit)
      console.log(`  grad scan: ${gradCands.length} in-zone candidate(s) of ${pools.length} pools (${GRAD_PAGES}pg max), held ${gradHeld}/${GRAD_MAX_POS}${gradBraked ? ' — BRAKED' : ''}`);
    } catch (e) { console.log(`  grad scan fail: ${String(e.message || e).slice(0, 80)}`); }
  }

  // hot-feed lane stays behind the execution-risk policy — the GRAD lane
  // above is the operator-directed exception, everything below is not.
  if (!entriesAllowed || rollingBraked) {
    done(rollingBraked && entriesAllowed ? 'rolling-loss brake — std entries halted' : 'onchain entries disabled by execution risk policy — grad lane only');
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
    !(lossCd[h.contract] && Date.now() - lossCd[h.contract] < MINT_LOSS_CD_H * 36e5) &&
    (h.score || 0) >= MIN_SCORE &&
    (+h.chg24h || 0) >= MIN_CHG_PCT &&
    h.audit && !h.audit.rugged && (h.audit.risks || []).length <= 3 &&
    h.liqUsd >= 50e3
  );
  if (!cands.length) { console.log('onchain-exec: no candidate passed gates'); done('no candidate passed gates'); return; }

  let stableLeft = spendableUsd, deployLeft = MAX_DEPLOYED_USD - deployed;
  let usdcLeft = bal.tokens[sol.MINT.USDC] || 0, usdtLeft = bal.tokens[sol.MINT.USDT] || 0;
  for (const cand of cands.slice(0, MAX_POSITIONS - book.positions.length)) {
    const sizeUsd = Math.min(MAX_USD, stableLeft * PCT, deployLeft) * ((cand.score || 0) >= SCORE_FULL ? 1 : 0.5);
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
