// chain-return.mjs — full on-chain round-trip proof:
//   sell a lane position -> USDC (Jupiter) -> SPL-transfer to the Bitget
//   main-account deposit address -> confirm on-chain.
// Every leg prints its tx signature so the flow is auditable on solscan
// and verifiable in the Bitget deposit history. Operator-directed tool —
// not part of the autonomous lane.
// Usage: node scripts/chain-return.mjs [sellMint] [usdcSendAmt]
import './load-env.mjs';
import crypto from 'node:crypto';
import {
  Connection, Keypair, PublicKey, TransactionInstruction, Transaction,
  SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { keypair, balances, swapAny, MINT } from './exchange/solana-swap.mjs';
import { appendLeg, emitCustody } from './custody-proof.mjs';

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const USDC = new PublicKey(MINT.USDC);
const TOKEN_PROG = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROG = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const HOST = 'https://api.bitget.com';

// ---- Bitget signed GET (standalone signer — same wire shape as the adapter)
const bitgetGet = async (reqPath, qs) => {
  const ts = String(Date.now());
  const pre = ts + 'GET' + reqPath + (qs ? '?' + qs : '');
  const sign = crypto.createHmac('sha256', process.env.BITGET_API_SECRET).update(pre).digest('base64');
  const r = await fetch(HOST + reqPath + '?' + qs, {
    headers: {
      'ACCESS-KEY': process.env.BITGET_API_KEY, 'ACCESS-SIGN': sign,
      'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE, 'ACCESS-TIMESTAMP': ts, locale: 'en-US',
    }, signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== '00000') throw new Error(`bitget ${reqPath} -> ${j.code} ${j.msg}`);
  return j.data;
};

const ataOf = async (owner, mint, prog = TOKEN_PROG) => {
  const [ata] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA_PROG);
  return ata;
};

const createAtaIx = (funder, ata, owner, mint, prog = TOKEN_PROG) =>
  new TransactionInstruction({
    programId: ATA_PROG,
    keys: [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: prog, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // idempotent
  });

const transferCheckedIx = (src, mint, dst, owner, amount, decimals = 6, prog = TOKEN_PROG) =>
  new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: src, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    // transferChecked: [12][amount u64le][decimals u8]
    data: Buffer.concat([Buffer.from([12]), Buffer.from(new BigUint64Array([BigInt(amount)]).buffer), Buffer.from([decimals])]),
  });

const main = async () => {
  const kp = keypair();
  const conn = new Connection(RPC, 'confirmed');
  const sellMint = process.argv[2] || '9XKzy4KahcZaGJPJtz1PtqGPB3CiseoBrx7TcQhEpump'; // GOMO
  const sendUsd = +(process.argv[3] || 1.55);

  console.log('wallet:', kp.publicKey.toBase58());
  const b0 = await balances();
  console.log('before: sol', b0.sol.toFixed(4), '| usdc', (b0.tokens[MINT.USDC] || 0).toFixed(2), '| tok', JSON.stringify(b0.tokens));

  // 1 — sell the position to USDC (raw token units from the live balance read)
  const raw = b0.tokensRaw?.[sellMint];
  if (raw && +raw > 0) {
    console.log('SELL leg:', sellMint.slice(0, 12), 'raw', raw);
    const sw = await swapAny({ inputMint: sellMint, outputMint: MINT.USDC, amount: +raw, slippageBps: 250, solBal: b0.sol });
    console.log('  sell sig:', sw.signature, '| confirmed:', sw.confirmed, '| out:', sw.outAmount, '| impact:', sw.priceImpactPct);
    appendLeg({ kind: 'sell', label: `DEX sell → USDC`, asset: sellMint, amountUsd: +(sw.outAmount || 0) / 1e6 || null, sig: sw.signature });
    await new Promise((r) => setTimeout(r, 4000));
  } else console.log('SELL leg: no balance for', sellMint.slice(0, 12), '— skipping');

  // 2 — Bitget deposit address (USDC on Solana -> main spot account)
  const dep = await bitgetGet('/api/v2/spot/wallet/deposit-address', 'coin=USDC&chain=SOL');
  const depAddr = new PublicKey(dep.address);
  console.log('RETURN leg: bitget deposit addr', dep.address, `(chain ${dep.chain})`);

  // 3 — SPL transferChecked USDC -> ATA(deposit)
  const b1 = await balances();
  const usdcHave = b1.tokens[MINT.USDC] || 0;
  const amt = Math.min(sendUsd, usdcHave - 0.05); // keep dust for fees-edge
  if (amt <= 0) throw new Error(`usdc ${usdcHave} too small to send`);
  const rawAmt = Math.floor(amt * 1e6);
  const srcAta = await ataOf(kp.publicKey, USDC);
  const dstAta = await ataOf(depAddr, USDC);
  const dstInfo = await conn.getAccountInfo(dstAta);
  const tx = new Transaction();
  if (!dstInfo) { console.log('  dest ATA missing — creating'); tx.add(createAtaIx(kp.publicKey, dstAta, depAddr, USDC)); }
  tx.add(transferCheckedIx(srcAta, USDC, dstAta, kp.publicKey, rawAmt));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
  console.log('  sent', amt.toFixed(2), 'USDC | sig:', sig);
  console.log('  solscan: https://solscan.io/tx/' + sig);
  appendLeg({ kind: 'return', label: `USDC → Bitget deposit (${dep.chain || 'SOL'} chain)`, asset: 'USDC', amountUsd: +amt.toFixed(4), dest: dep.address, sig });

  const b2 = await balances();
  console.log('after: sol', b2.sol.toFixed(4), '| usdc', (b2.tokens[MINT.USDC] || 0).toFixed(2));
  console.log('DONE — check Bitget deposit history for', amt.toFixed(2), 'USDC on SOL chain');
  const n = await emitCustody().catch(() => 0);
  console.log('custody artifact refreshed —', n, 'leg(s)');
};

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
