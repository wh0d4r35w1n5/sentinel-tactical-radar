// sell a WEALTH chunk -> wSOL -> unwrap -> native SOL transfer
import fs from 'node:fs';
import path from 'node:path';

await import('/opt/sentinel/scripts/load-env.mjs');
const sol = await import('/opt/sentinel/scripts/exchange/solana-swap.mjs');
const web3 = await import('@solana/web3.js');

const TGT = '8Mi9E1V2bdPeAaRkR5yxUsAvpzP6UBUEEUrYmgKNpump';
const DEST = 'EbCBWnjPFVkEaVa81mUr9HTYMPMyXuimf7WRWZcyBJ6y';
const SEND_LAMPORTS = 47_000_000;           // ~0.047 SOL ~ $7 USD ~ $11 AUD
const SELL_RAW = 48_000_000_000;            // ~54% of the seat (~$7.7 at mark)
const WSOL = 'So11111111111111111111111111111111111111112';
const BOOK = '/opt/sentinel/state/onchain-book.json';
const TOK = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const conn = new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const kp = sol.keypair();

// 1) sell WEALTH chunk -> wSOL
const q = await sol.quote({ inputMint: TGT, outputMint: WSOL, amount: SELL_RAW, slippageBps: 400 });
console.log('quote out wSOL lamports:', q.outAmount);
const r = await sol.swap({ inputMint: TGT, outputMint: WSOL, amount: SELL_RAW, slippageBps: 400 });
console.log('sell sig:', r.signature);

// 2) unwrap wSOL: close the wSOL ATA -> native SOL
const atas = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new web3.PublicKey(WSOL) });
for (const a of atas.value) {
  const tx = new web3.Transaction().add(new web3.TransactionInstruction({
    keys: [
      { pubkey: a.pubkey, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    ], programId: TOK, data: Buffer.from([9]),
  }));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('unwrapped, sig:', sig.slice(0, 24));
}

const solNow = (await conn.getBalance(kp.publicKey)) / 1e9;
console.log('native SOL now:', solNow);
if (solNow * 1e9 < SEND_LAMPORTS + 8000) throw new Error('not enough native SOL after unwrap');

// 3) send native SOL
const tx2 = new web3.Transaction().add(web3.SystemProgram.transfer({
  fromPubkey: kp.publicKey, toPubkey: new web3.PublicKey(DEST), lamports: SEND_LAMPORTS }));
tx2.feePayer = kp.publicKey;
tx2.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx2.sign(kp);
const sig2 = await conn.sendRawTransaction(tx2.serialize(), { skipPreflight: false });
await conn.confirmTransaction(sig2, 'confirmed');
console.log('SENT 0.047 SOL ->', DEST.slice(0, 12), '… sig:', sig2);

// 4) update the book — reduce seat proportionally
const book = JSON.parse(fs.readFileSync(BOOK, 'utf8'));
for (const p of book.positions || []) {
  if (p.mint === TGT) {
    const frac = SELL_RAW / (p.qtyRaw || SELL_RAW);
    p.qtyRaw = Math.max(0, (p.qtyRaw || 0) - SELL_RAW);
    p.costUsd = +((p.costUsd || 0) * (1 - Math.min(frac, 1))).toFixed(4);
    console.log('book: qtyRaw ->', p.qtyRaw, 'cost ->', p.costUsd);
  }
}
book.updatedAt = new Date().toISOString();
fs.writeFileSync(BOOK, JSON.stringify(book));
console.log('done');
