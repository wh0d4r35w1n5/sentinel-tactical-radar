import fs from 'node:fs';
await import('/opt/sentinel/scripts/load-env.mjs');
const sol = await import('/opt/sentinel/scripts/exchange/solana-swap.mjs');
const web3 = await import('@solana/web3.js');
const DEST = new web3.PublicKey('EbCBWnjPFVkEaVa81mUr9HTYMPMyXuimf7WRWZcyBJ6y');
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_SPEND = 3.9;                    // ~$3.9 USD ≈ enough wSOL for send + fees
const SEND_LAMPORTS = 43_000_000;          // ~0.043 SOL ≈ $5.5 AUD
const TOK = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const conn = new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const kp = sol.keypair();

const inRaw = Math.round(USDC_SPEND * 1e6);
const r = await sol.swap({ inputMint: sol.MINT.USDC, outputMint: WSOL, amount: inRaw, slippageBps: 400 });
console.log('swap sig:', r.signature);

// unwrap every wSOL ATA
const atas = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new web3.PublicKey(WSOL) });
for (const a of atas.value) {
  const tx = new web3.Transaction().add(new web3.TransactionInstruction({
    keys: [
      { pubkey: a.pubkey, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    ], programId: TOK, data: Buffer.from([9]) }));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp);
  const s = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(s, 'confirmed');
  console.log('unwrapped:', s.slice(0, 24));
}

const native = await conn.getBalance(kp.publicKey);
console.log('native SOL:', (native / 1e9).toFixed(6));
if (native < SEND_LAMPORTS + 8000) throw new Error(`short: have ${native / 1e9}`);
const tx2 = new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: DEST, lamports: SEND_LAMPORTS }));
tx2.feePayer = kp.publicKey;
tx2.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx2.sign(kp);
const sig = await conn.sendRawTransaction(tx2.serialize(), { skipPreflight: false });
await conn.confirmTransaction(sig, 'confirmed');
console.log('SENT', (SEND_LAMPORTS / 1e9), 'SOL sig:', sig);
