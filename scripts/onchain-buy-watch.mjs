// Operator-directed buy watcher: waits for the stable purse (USDC/USDT on
// Solana) to reach the target spend, then buys TARGET_MINT via Jupiter —
// same lock + booking conventions as onchain-buy-sean.mjs. Exits when the
// buy completes, or after WATCH_MAX_MS of waiting.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '/opt/sentinel/scripts/load-env.mjs';
import * as sol from '/opt/sentinel/scripts/exchange/solana-swap.mjs';

const STATE = '/opt/sentinel/state';
const BOOK_FILE = path.join(STATE, 'onchain-book.json');
const FILLS_FILE = path.join(STATE, 'onchain-fills.json');
const LOCK = path.join(STATE, 'onchain-buy-watch.lock');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

const TARGET_MINT = process.env.BUY_MINT || '8Mi9E1V2bdPeAaRkR5yxUsAvpzP6UBUEEUrYmgKNpump';
const SYMBOL = process.env.BUY_SYMBOL || 'OPBUY';
const SPEND_USD = +(process.env.BUY_SPEND_USD || 10);
const SLIPPAGE_BPS = +(process.env.BUY_SLIPPAGE_BPS || 200);
const POLL_MS = 20e3;
const WATCH_MAX_MS = +(process.env.BUY_WATCH_MAX_MS || 6 * 3600e3);
const log = (...a) => console.log(`[buy-watch ${new Date().toISOString().slice(11, 19)}]`, ...a);

let lockFd = null;
try { lockFd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(lockFd, String(process.pid)); }
catch {
  const pid = +String(fs.readFileSync(LOCK, 'utf8')).trim();
  const stale = Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60e3;
  if (stale) { fs.rmSync(LOCK, { force: true }); lockFd = fs.openSync(LOCK, 'wx'); fs.writeFileSync(lockFd, String(process.pid)); }
}
if (lockFd === null) { log('lock held — aborting'); process.exit(1); }
process.on('exit', () => { try { fs.closeSync(lockFd); } catch {} try { fs.rmSync(LOCK, { force: true }); } catch {} });

const book = readJ(BOOK_FILE, { positions: [] });
if ((book.positions || []).some((p) => p.mint === TARGET_MINT)) {
  log(`${SYMBOL} already in book — refusing double-seat`); process.exit(0);
}

log(`watching for $${SPEND_USD} stable purse → buy ${SYMBOL} (${TARGET_MINT.slice(0, 12)}…) slippage ${SLIPPAGE_BPS}bps`);
const t0 = Date.now();
for (;;) {
  if (Date.now() - t0 > WATCH_MAX_MS) { log('watch window expired — no stable deposit arrived'); process.exit(2); }
  let bal;
  try { bal = await sol.balances(); } catch (e) { log('balance read err:', e.message); await new Promise((r) => setTimeout(r, POLL_MS)); continue; }
  const usdc = bal.tokens[sol.MINT.USDC] || 0, usdt = bal.tokens[sol.MINT.USDT] || 0;
  const stableUsd = usdc + usdt;
  if (stableUsd < Math.max(2, SPEND_USD * 0.9)) { process.stdout.write(`\r  purse $${stableUsd.toFixed(2)} / $${SPEND_USD} — waiting…`); await new Promise((r) => setTimeout(r, POLL_MS)); continue; }

  const spend = Math.min(stableUsd, SPEND_USD);
  log(`\nDEPOSIT LANDED — purse $${stableUsd.toFixed(2)} → spending $${spend.toFixed(2)} on ${SYMBOL}`);
  const legs = [];
  let left = spend;
  const usdcLeg = Math.min(usdc, left);
  if (usdcLeg >= 0.5) { legs.push({ mint: sol.MINT.USDC, usd: usdcLeg }); left -= usdcLeg; }
  if (left >= 0.5 && usdt > 0.5) legs.push({ mint: sol.MINT.USDT, usd: Math.min(usdt, left) });

  let qtyRaw = 0, spent = 0; const sigs = [];
  let swapErr = null;
  for (const leg of legs) {
    try {
      const inRaw = Math.round(leg.usd * 1e6);
      const q = await sol.quote({ inputMint: leg.mint, outputMint: TARGET_MINT, amount: inRaw, slippageBps: SLIPPAGE_BPS });
      const r = await sol.swap({ inputMint: leg.mint, outputMint: TARGET_MINT, amount: inRaw, slippageBps: SLIPPAGE_BPS });
      qtyRaw += +q.outAmount; spent += leg.usd; sigs.push(r.signature);
      log(`  leg $${leg.usd.toFixed(2)} → ${(+q.outAmount).toLocaleString()} ${SYMBOL} raw | sig ${r.signature.slice(0, 16)}…`);
    } catch (e) { swapErr = e; log(`  leg $${leg.usd.toFixed(2)} swap err: ${e.message.slice(0, 120)}`); }
    await new Promise((r2) => setTimeout(r2, 400));
  }
  if (!qtyRaw) {
    log(`no fills (last err: ${swapErr ? swapErr.message.slice(0, 100) : 'n/a'}) — retrying in 60s`);
    await new Promise((r) => setTimeout(r, 60000));
    continue;
  }

  book.positions = book.positions || [];
  book.positions.push({
    mint: TARGET_MINT, symbol: SYMBOL, qtyRaw,
    costUsd: spent, peakUsd: spent, lastValueUsd: spent, ts: Date.now(),
    entryPxUsd: null, score: null, liqUsd: null,
    sig: sigs[0], note: 'operator-directed manual buy — hold-thesis profile',
    profile: { keep: 0.45, floor: 0.5, arm: 1.25, feeLock: 0.98, maxHoldH: 9999, noRun: false },
  });
  book.updatedAt = new Date().toISOString();
  writeJ(BOOK_FILE, book);
  const fills = readJ(FILLS_FILE, []);
  fills.push({ ts: Date.now(), side: 'buy', symbol: SYMBOL, mint: TARGET_MINT, usd: spent, qtyRaw, sig: sigs[0], manual: true });
  writeJ(FILLS_FILE, fills.slice(-500));
  log(`BOOKED ${SYMBOL} — spent $${spent.toFixed(2)}, qtyRaw ${qtyRaw.toLocaleString()}, sigs ${sigs.map((s) => s.slice(0, 12)).join(',')}`);
  process.exit(0);
}
