// wealth-repeat.mjs — operator order: keep buying WEALTH on repeat.
// When no WEALTH seat is open and the purse holds spendable USDC, buys it
// back and rebooks the same armor (floor/trail/fee-lock + 4-rung TP ladder).
// Self-brake: 3 straight losing WEALTH exits pauses the loop 2h — repeat
// buying is a doctrine, bleeding fees into a dead mint is not.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = process.env.SENTINEL_STATE_DIR || path.join(ROOT, 'state');
const BOOK = path.join(STATE, 'onchain-book.json');
const FILLS = path.join(STATE, 'onchain-fills.json');
const VAULT = path.join(STATE, 'onchain-vault.json');
const EXEC_LOCK = path.join(STATE, 'onchain-exec.lock');
const TGT = '8Mi9E1V2bdPeAaRkR5yxUsAvpzP6UBUEEUrYmgKNpump';
const POLL_MS = +(process.env.REPEAT_POLL_MS || 30000);
const GAS_KEEP = +(process.env.REPEAT_GAS_KEEP || 0.006);
const SLIP = +(process.env.REPEAT_SLIP_BPS || 300);
const PAUSE_H = +(process.env.REPEAT_PAUSE_H || 2);
const PROFILE = { keep: 0.55, floor: 0.6, arm: 1.25, feeLock: 0.98, maxHoldH: 9999, noRun: false,
  tpLadder: [{ mult: 1.25, pct: 0.25 }, { mult: 1.75, pct: 0.25 }, { mult: 2.5, pct: 0.25 }, { mult: 4.0, pct: 0.5 }] };

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

await import(path.join(HERE, 'load-env.mjs'));
const sol = await import(path.join(HERE, 'exchange', 'solana-swap.mjs'));

log(`repeat armed — WEALTH ${TGT.slice(0, 8)}… poll ${POLL_MS / 1000}s`);
while (true) {
  try {
    // never race the exec's own cycle — its lock serializes every touch
    if (fs.existsSync(EXEC_LOCK)) { await sleep(2000); continue; }
    const book = readJ(BOOK, { positions: [] });
    if ((book.positions || []).some((p) => p.mint === TGT)) { await sleep(POLL_MS); continue; }  // seat open — trail owns it

    // self-brake: last 3 WEALTH EPISODES all red -> pause. Episode
    // accounting: tp-sell legs belong to the same seat — a sell row
    // alone compares partial proceeds to full cost and lies red.
    const fills = readJ(FILLS, []);
    const tFills = fills.filter((f) => f.mint === TGT);
    const wSells = tFills.filter((f) => ['sell', 'abandon', 'reconcile'].includes(f.side)).slice(-3);
    const epRed = (s) => {
      const buys = tFills.filter((f) => f.side === 'buy' && f.ts <= s.ts);
      const pb = buys[buys.length - 1];
      const tpLegs = tFills.filter((f) => f.side === 'tp-sell' && pb && f.ts >= pb.ts && f.ts <= s.ts);
      const proceeds = (s.estUsd || 0) + tpLegs.reduce((a, f) => a + (f.estUsd || f.usd || 0), 0);
      return proceeds < (s.costUsd || 0);
    };
    if (wSells.length === 3 && wSells.every(epRed)) {
      const lastTs = wSells[2].ts || 0;
      if (Date.now() - lastTs < PAUSE_H * 36e5) { await sleep(POLL_MS); continue; }
    }

    const b = await sol.balances();
    if (!b?.ok) { await sleep(POLL_MS); continue; }
    const vaultRes = +(readJ(VAULT, {}).balanceUsd || 0);
    const spend = (b.tokens[sol.MINT.USDC] || 0) - vaultRes;
    if (spend < 3 || b.sol < GAS_KEEP) { await sleep(POLL_MS); continue; }

    const inRaw = Math.round(spend * 1e6);
    log(`seat empty, purse $${spend.toFixed(2)} USDC — re-buying WEALTH`);
    const q = await sol.quote({ inputMint: sol.MINT.USDC, outputMint: TGT, amount: inRaw, slippageBps: SLIP });
    const r = await sol.swap({ inputMint: sol.MINT.USDC, outputMint: TGT, amount: inRaw, slippageBps: SLIP });
    log(`REBOUGHT sig ${r.signature} out ${r.outAmount}`);

    const book2 = readJ(BOOK, { positions: [] });
    book2.positions = book2.positions || [];
    if (!book2.positions.some((p) => p.mint === TGT)) {
      book2.positions.push({ mint: TGT, symbol: 'WEALTH', qtyRaw: +q.outAmount,
        costUsd: spend, peakUsd: spend, lastValueUsd: spend, ts: Date.now(),
        entryPxUsd: null, score: null, liqUsd: 12324, sig: r.signature,
        note: 'operator repeat-buy — hold-thesis profile', profile: PROFILE });
      book2.updatedAt = new Date().toISOString();
      writeJ(BOOK, book2);
      fills.push({ ts: Date.now(), side: 'buy', symbol: 'WEALTH', mint: TGT, usd: spend, qtyRaw: +q.outAmount, sig: r.signature, repeat: true });
      writeJ(FILLS, fills.slice(-500));
      log('rebooked — trail + ladder armed');
    }
  } catch (e) { log('cycle err:', (e.message || String(e)).slice(0, 140)); }
  await sleep(POLL_MS);
}
