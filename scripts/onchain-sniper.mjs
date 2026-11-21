// onchain-sniper.mjs — new-token launch sniper (operator idea 2026-11-11:
// "snipe brand new tokens the second they hit the chain, frontrun the
// listings"). Long-running service: pumpportal new-token feed -> filters ->
// bonding-curve buy via trade-local -> book registration lane:'sniper'.
//
// Edge research baked in (118k-bot measured study + pump.fun analytics):
//  - creator initialBuy is the strongest success predictor (dev skin in game)
//  - crowded/zero-dev launches are the bleed cohort — skip them
//  - exits must be FAST (holding >5min = -32% median) — sniper profile is
//    tight trail + short maxHold, managed by onchain-exec's exit pass
//  - clips stay dust-sized until the hit rate is proven on fills
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
const SEEN_FILE = path.join(STATE, 'onchain-sniper-seen.json');
const DEPLOYERS_FILE = path.join(STATE, 'onchain-sniper-deployers.json');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const journal = (f) => { const a = readJ(FILLS_FILE, []); a.push({ ts: Date.now(), ...f }); writeJ(FILLS_FILE, a.slice(-500)); };
const log = (...a) => console.log(`[sniper ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---- config (env-tunable; defaults sized for the ~$0.75 purse) ----
const ON = process.env.ONCHAIN_SNIPER !== '0';
const CLIP_USD = +(process.env.SNIPER_CLIP_USD || 0.18);        // dust clip until hit-rate proven
const MIN_DEV_BUY_SOL = +(process.env.SNIPER_MIN_DEV_BUY_SOL || 0.3); // creator initial buy floor — AUC .82 predictor
const MAX_POS = +(process.env.SNIPER_MAX_POS || 3);             // concurrent sniper seats
const MAX_BUYS_H = +(process.env.SNIPER_MAX_BUYS_H || 12);      // hourly buy cap — fee bleed guard
const MAX_SEEN = 5000;
const SOLPX_FILE = path.join(STATE, 'onchain-solpx.json');

const solPx = () => { const c = readJ(SOLPX_FILE, null); return c?.px && Date.now() - c.ts < 30 * 60e3 ? c.px : 85; };

// sniper exit profile — research says HOLDING is death; tight trail,
// short fuse, bank the first spike, small moon bag rides free.
const SNIPER_PROFILE = {
  floor: 0.55, arm: 1.03, feeLock: 1.0, keep: 0.5,
  maxHoldH: +(process.env.SNIPER_MAX_HOLD_H || 0.5), // 30min fuse
  dynTp: { stepPct: 0.12, sellPct: 0.15, coverMult: 1.03, outMint: 'SOL' },
  moonKeep: 0.10,
};

const seen = readJ(SEEN_FILE, {});
const deployers = readJ(DEPLOYERS_FILE, {});
const buysHour = [];

async function purseSpendable() {
  const bal = await sol.balances().catch(() => null);
  if (!bal?.ok) return 0;
  const stable = (bal.tokens[sol.MINT.USDC] || 0) + (bal.tokens[sol.MINT.USDT] || 0);
  const solSpend = Math.max(0, bal.sol - 0.002) * solPx();
  return stable + solSpend;
}

async function registerPosition({ mint, symbol, clipUsd, sig }) {
  // take the exec lock so book writes never interleave with a tick
  let fd = null;
  try { fd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
  catch {
    try {
      const pid = +String(fs.readFileSync(LOCK, 'utf8')).trim();
      const stale = Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60e3;
      let alive = false; if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
      if (stale || !alive) { fs.rmSync(LOCK, { force: true }); fd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
    } catch {}
  }
  try {
    const book = readJ(BOOK_FILE, { positions: [] });
    book.positions ??= [];
    if (book.positions.some((p) => p.mint === mint)) return false;
    // actual received qty — read the ATA after confirm
    let qtyRaw = 0;
    for (let i = 0; i < 8 && !(qtyRaw > 0); i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const tb = await sol.tokenBalance?.(mint).catch(() => 0);
      qtyRaw = +(tb || 0);
    }
    if (!(qtyRaw > 0)) { log(`${symbol}: buy confirmed but qty unreadable — book skipped, orphan sweep owns it`); return false; }
    book.positions.push({
      mint, symbol, lane: 'sniper', qtyRaw, costUsd: clipUsd, peakUsd: clipUsd,
      lastValueUsd: clipUsd, ts: Date.now(), entryPxUsd: null, score: null,
      liqUsd: null, sig, profile: SNIPER_PROFILE,
      deployer: deployers[symbol]?.deployer || null,
    });
    writeJ(BOOK_FILE, { ...book, updatedAt: new Date().toISOString() });
    journal({ side: 'buy', symbol, mint, usd: clipUsd, qtyRaw, sig, lane: 'sniper', reason: 'launch-snipe' });
    return true;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} try { fs.rmSync(LOCK, { force: true }); } catch {} }
  }
}

async function onCreate(ev) {
  const mint = ev.mint, name = ev.name || '', symbol = (ev.symbol || name.split(/\s+/)[0] || mint.slice(0, 6)).toUpperCase().slice(0, 12);
  const SYM = `S:${symbol}`;
  if (!mint || !mint.endsWith('pump')) return;
  if (seen[mint]) return;
  seen[mint] = Date.now();
  const keys = Object.keys(seen);
  if (keys.length > MAX_SEEN) for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete seen[k];
  writeJ(SEEN_FILE, seen);

  // ---- filters (the stealable edge) ----
  const devBuySol = +(ev.solAmount || 0) || +(ev.initialBuy || 0);
  if (!(devBuySol >= MIN_DEV_BUY_SOL)) return;           // no dev skin = bleed cohort
  if (!ev.uri) return;                                    // no metadata = farm/spam launch
  const book = readJ(BOOK_FILE, { positions: [] });
  if ((book.positions || []).some((p) => p.mint === mint || p.symbol === SYM)) return;
  const sniperHeld = (book.positions || []).filter((p) => p.lane === 'sniper').length;
  if (sniperHeld >= MAX_POS) return;
  const now = Date.now();
  while (buysHour.length && now - buysHour[0] > 3600e3) buysHour.shift();
  if (buysHour.length >= MAX_BUYS_H) return;

  const purse = await purseSpendable();
  const clip = Math.min(CLIP_USD, purse * 0.5);          // never more than half the purse per snipe
  if (!(clip >= 0.05)) { log(`${SYM}: purse too thin ($${purse.toFixed(2)}) — skip`); return; }

  // pay in SOL always — freshest curve, no stable leg needed
  const solAmt = +(clip / solPx()).toFixed(4);
  if (!(solAmt > 0.0005)) return;
  log(`SNIPE ${SYM} devBuy=${devBuySol.toFixed(2)}SOL clip=$${clip.toFixed(2)} mint=${mint.slice(0, 10)}…`);
  try {
    const r = await pp.curveBuy({ mint, solAmount: solAmt, slippage: 20 });
    if (!r.confirmed) { log(`${SYM}: tx unconfirmed ${r.signature?.slice(0, 12)}…`); return; }
    buysHour.push(now);
    deployers[SYM] = { deployer: ev.traderPublicKey || null, devBuySol, at: now };
    writeJ(DEPLOYERS_FILE, deployers);
    const ok = await registerPosition({ mint, symbol: SYM, clipUsd: clip, sig: r.signature });
    log(`${ok ? 'FILLED' : 'UNBOOKED'} ${SYM} sig ${r.signature.slice(0, 12)}…`);
  } catch (e) {
    log(`${SYM}: buy failed ${String(e.message || e).slice(0, 100)}`);
  }
}

async function main() {
  if (!ON) { log('disabled (ONCHAIN_SNIPER=0)'); return; }
  if (!sol.walletReady()) { log('no wallet — exit'); return; }
  log(`armed — clip $${CLIP_USD} devBuy>=${MIN_DEV_BUY_SOL}SOL maxPos=${MAX_POS} maxH=${MAX_BUYS_H}`);
  pp.watchNewTokens(onCreate, { onLog: log });
  // keep alive forever; exec handles all exits
  setInterval(() => {}, 3600e3);
}
main().catch((e) => { log('fatal', e); process.exit(1); });
