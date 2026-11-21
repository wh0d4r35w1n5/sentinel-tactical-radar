import fs from 'node:fs';
await import('/opt/sentinel/scripts/load-env.mjs');
const sol = await import('/opt/sentinel/scripts/exchange/solana-swap.mjs');
const web3 = await import('@solana/web3.js');
const DEST = new web3.PublicKey('EbCBWnjPFVkEaVa81mUr9HTYMPMyXuimf7WRWZcyBJ6y');
const SEND = 42_000_000; // ~0.042 SOL ≈ $5.5 AUD top-up
const conn = new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const kp = sol.keypair();
const bal = await conn.getBalance(kp.publicKey);
console.log('have', (bal/1e9).toFixed(6), 'SOL — sending', (SEND/1e9));
if (bal < SEND + 8000) throw new Error('insufficient');
const tx = new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: DEST, lamports: SEND }));
tx.feePayer = kp.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.sign(kp);
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
await conn.confirmTransaction(sig, 'confirmed');
console.log('SENT sig:', sig);
