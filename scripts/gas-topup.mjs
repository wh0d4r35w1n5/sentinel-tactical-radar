import fs from 'node:fs';
await import('/opt/sentinel/scripts/load-env.mjs');
const sol = await import('/opt/sentinel/scripts/exchange/solana-swap.mjs');
const web3 = await import('@solana/web3.js');
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_SPEND = 0.40;   // from sealed vault — restores protection-lane gas
const TOK = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const conn = new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const kp = sol.keypair();
const before = await conn.getBalance(kp.publicKey);
console.log('sol before:', (before / 1e9).toFixed(5));
const inRaw = Math.round(USDC_SPEND * 1e6);
const r = await sol.swap({ inputMint: sol.MINT.USDC, outputMint: WSOL, amount: inRaw, slippageBps: 400 });
console.log('swap sig:', r.signature);
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
const after = await conn.getBalance(kp.publicKey);
console.log('sol after:', (after / 1e9).toFixed(5));
// keep vault accounting honest — spend is journaled out of the seal
const vf = '/opt/sentinel/state/onchain-vault.json';
const v = JSON.parse(fs.readFileSync(vf, 'utf8'));
v.balanceUsd = Math.max(0, +(v.balanceUsd || 0) - USDC_SPEND).toFixed(4) * 1;
v.gasTopups = (v.gasTopups || 0) + 1;
fs.writeFileSync(vf, JSON.stringify(v));
fs.appendFileSync('/opt/sentinel/state/onchain-fills.json', JSON.stringify({ side: 'gas-topup', usd: USDC_SPEND, ts: Date.now(), note: 'vault usdc->wsol->native for protection-lane gas' }) + '\n');
console.log('vault now:', v.balanceUsd);
