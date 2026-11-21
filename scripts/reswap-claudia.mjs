// Re-do the operator-ordered 50/50 split: sweep ate the first CLAUDIA buy,
// recycled it to WEALTH. Swap half of current WEALTH -> CLAUDIA, then write
// the book to wallet truth (WEALTH qty + CLAUDIA seat, both dynTp+moon).
import sol from '/opt/sentinel/scripts/exchange/solana-swap.mjs';
import fs from 'fs';

const WEALTH = '8Mi9E1V2bdPeAaRkR5yxUsAvpzP6UBUEEUrYmgKNpump';
const CLAUDIA = '2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM';
const BOOK = '/opt/sentinel/state/onchain-book.json';
const readJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJ = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

const bal = await sol.balances();
const wRaw = +bal.tokensRaw[WEALTH];
console.log('WEALTH raw:', wRaw, '| SOL:', bal.sol.toFixed(6));
if (!(wRaw > 0)) { console.log('no WEALTH — abort'); process.exit(1); }
if (bal.sol < 0.0025) { console.log('gas too low to attempt — abort'); process.exit(1); }

const half = Math.floor(wRaw / 2);
// expected out via quote for cost-basis record
let estOut = null, estUsd = null;
try {
  const q = await sol.quote({ inputMint: WEALTH, outputMint: sol.MINT.USDC, amount: half, slippageBps: 200 });
  estUsd = +q.outAmount / 1e6;
  console.log(`half ${half} ≈ $${estUsd.toFixed(4)} USDC-equiv`);
} catch (e) { console.log('usdc quote for valuation failed:', e.message.slice(0, 80)); }

console.log(`swapping ${half} WEALTH -> CLAUDIA`);
const r = await sol.swap({ inputMint: WEALTH, outputMint: CLAUDIA, amount: half, slippageBps: 200 });
console.log('sig:', r.signature, 'out:', r.outAmount, 'impact:', r.priceImpactPct);

// reconcile book to post-swap wallet truth
const bal2 = await sol.balances();
const book = readJ(BOOK, { positions: [] });
const wNow = +bal2.tokensRaw[WEALTH] || 0;
const cNow = +bal2.tokensRaw[CLAUDIA] || 0;

const wPos = book.positions.find((p) => p.mint === WEALTH);
if (wPos) {
  wPos.qtyRaw = wNow;
  wPos.unitCost = (wPos.costUsd || 0) / wNow;
  wPos.moonKeepRaw = Math.floor(wNow * (wPos.profile?.moonKeep ?? 0.4));
  wPos.zeroReads = 0;
  console.log(`WEALTH reconciled: qty ${wNow} cost $${wPos.costUsd} moon ${wPos.moonKeepRaw} unit ${wPos.unitCost}`);
}
const wProf = wPos?.profile || {};
let cPos = book.positions.find((p) => p.mint === CLAUDIA);
const costUsd = estUsd != null ? estUsd : null;
if (!cPos) {
  cPos = { mint: CLAUDIA, symbol: 'CLAUDIA', qtyRaw: cNow, costUsd, peakUsd: costUsd,
    lastValueUsd: costUsd, ts: Date.now(), entryPxUsd: null, score: null, liqUsd: null,
    sig: r.signature, profile: { ...wProf }, zeroReads: 0 };
  book.positions.push(cPos);
} else { cPos.qtyRaw = cNow; cPos.zeroReads = 0; }
cPos.unitCost = costUsd ? costUsd / cNow : null;
cPos.moonKeepRaw = Math.floor(cNow * (cPos.profile?.moonKeep ?? 0.4));
console.log(`CLAUDIA seat: qty ${cNow} cost $${costUsd} moon ${cPos.moonKeepRaw}`);
book.updatedAt = new Date().toISOString();
writeJ(BOOK, book);
console.log('post-swap SOL:', bal2.sol.toFixed(6), '| book written');
