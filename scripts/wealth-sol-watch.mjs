// watches bot wallet for incoming SOL -> swaps to WEALTH, tops up booked seat.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = process.env.SENTINEL_STATE_DIR || path.join(ROOT, 'state');
const BOOK = path.join(STATE, 'onchain-book.json');
const TGT = process.env.WEALTH_MINT || '8Mi9E1V2bdPeAaRkR5yxUsAvpzP6UBUEEUrYmgKNpump';
const POLL_MS = +(process.env.WATCH_POLL_MS || 15000);
const GAS_KEEP = +(process.env.WATCH_GAS_KEEP || 0.006);   // leave gas for ATA/fee + trail ops
const MIN_SOL = +(process.env.WATCH_MIN_SOL || 0.015);      // don't bother under ~$2
const SLIP = +(process.env.WATCH_SLIP_BPS || 300);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import(path.join(HERE, 'load-env.mjs'));
const sol = await import(path.join(HERE, 'exchange', 'solana-swap.mjs'));

log(`watch armed — mint ${TGT.slice(0, 8)}… poll ${POLL_MS / 1000}s, min ${MIN_SOL} SOL, gas-keep ${GAS_KEEP}`);
while (true) {
  try {
    const b = await sol.balances();
    const spend = b.sol - GAS_KEEP;
    if (spend >= MIN_SOL) {
      const lamports = Math.floor(spend * 1e9);
      log(`SOL detected: ${b.sol.toFixed(4)} — swapping ${spend.toFixed(4)} -> WEALTH`);
      const r = await sol.swap({ inputMint: 'So11111111111111111111111111111111111111112', outputMint: TGT, amount: lamports, slippageBps: SLIP });
      log(`swap sig: ${r.signature} out: ${r.outAmount}`);
      // book the bag the SAME tick — unbooked tokens are sweep-bait
      try {
        const book = JSON.parse(fs.readFileSync(BOOK, 'utf8'));
        book.positions = book.positions || [];
        let pos = book.positions.find((p) => p.mint === TGT);
        // USD cost of the buy: quote the received bag back to USDC
        let addCost = 0;
        try {
          const q2 = await sol.quote({ inputMint: TGT, outputMint: sol.MINT.USDC, amount: +r.outAmount });
          addCost = +(q2?.outAmount || 0) / 1e6;
        } catch {}
        if (pos) {
          pos.qtyRaw = (pos.qtyRaw || 0) + +r.outAmount;
          pos.costUsd = +((pos.costUsd || 0) + addCost).toFixed(6);
          pos.unitCost = pos.costUsd / pos.qtyRaw;
          book.updatedAt = new Date().toISOString();
          fs.writeFileSync(BOOK, JSON.stringify(book));
          log('book topped up — trail covers enlarged seat');
        } else {
          book.positions.push({
            mint: TGT, symbol: 'WEALTH', qtyRaw: +r.outAmount,
            costUsd: addCost, unitCost: addCost > 0 ? addCost / +r.outAmount : null,
            peakUsd: addCost, lastValueUsd: addCost, ts: Date.now(), sig: r.signature,
            note: 'solwatch inbound — hold-thesis profile',
            profile: { keep: 0.55, floor: 0.60, arm: 1.25, feeLock: 0.98, maxHoldH: 9999, noRun: false,
              tpLadder: [{ mult: 1.25, pct: 0.25 }, { mult: 1.75, pct: 0.25 }, { mult: 2.5, pct: 0.25 }, { mult: 4, pct: 0.5 }] }
          });
          book.updatedAt = new Date().toISOString();
          fs.writeFileSync(BOOK, JSON.stringify(book));
          log('new seat booked — trail + ladder armed');
        }
      } catch (e) { log('book write failed:', e.message || e); }
    }
  } catch (e) { log('poll err:', (e.message || String(e)).slice(0, 120)); }
  await sleep(POLL_MS);
}
