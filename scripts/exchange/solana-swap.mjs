// Solana swap lane — Jupiter aggregator (lite-api.jup.ag, keyless) + local
// ed25519 signing with the bot hot wallet (SOLANA_BOT_SECRET in .env).
// This is the same liquidity the Bitget app's Onchain tab routes through —
// executed directly on-chain instead of via their API key program.
//
// Safety model (hot wallet discipline):
//  - bounded balance by design — fund with a defined purse, not the book
//  - every swap goes through quote-then-build; slippageBps caps execution
//  - secrets never leave the VPS; only signatures hit the wire

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import '../load-env.mjs';

const JUP = process.env.JUP_API || 'https://lite-api.jup.ag/swap/v1';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const TF = () => AbortSignal.timeout(15000);

// canonical mints
export const MINT = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

export const walletReady = () => !!process.env.SOLANA_BOT_SECRET;

export function keypair() {
  if (!walletReady()) throw new Error('solana lane dormant — SOLANA_BOT_SECRET unset');
  return Keypair.fromSecretKey(Buffer.from(process.env.SOLANA_BOT_SECRET, 'base64'));
}

export const address = () => (walletReady() ? keypair().publicKey.toBase58() : null);

export async function balances() {
  if (!walletReady()) return { ok: false, reason: 'no-wallet' };
  const conn = new Connection(RPC, 'confirmed');
  const pub = keypair().publicKey;
  const sol = (await conn.getBalance(pub)) / 1e9;
  const toks = await conn
    .getParsedTokenAccountsByOwner(pub, { programId: new (await import('@solana/web3.js')).PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })
    .catch(() => ({ value: [] }));
  const tokens = {};
  for (const t of toks.value || []) {
    const info = t.account.data.parsed?.info;
    if (info && +info.tokenAmount.uiAmount > 0)
      tokens[info.mint] = +info.tokenAmount.uiAmount;
  }
  return { ok: true, address: pub.toBase58(), sol, tokens };
}

export async function quote({ inputMint, outputMint, amount, slippageBps = 100 }) {
  const q = new URLSearchParams({
    inputMint, outputMint, amount: String(Math.round(amount)),
    slippageBps: String(slippageBps),
  });
  const res = await fetch(`${JUP}/quote?${q}`, { signal: TF() });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`jup quote: ${j.error || res.status}`);
  return j;
}

export async function swap({ inputMint, outputMint, amount, slippageBps = 100 }) {
  const kp = keypair();
  const q = await quote({ inputMint, outputMint, amount, slippageBps });
  const res = await fetch(`${JUP}/swap`, {
    method: 'POST',
    signal: TF(),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.swapTransaction) throw new Error(`jup swap: ${j.error || res.status}`);
  const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64'));
  tx.sign([kp]);
  const conn = new Connection(RPC, 'confirmed');
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await conn.confirmTransaction(sig, 'confirmed').catch(() => null);
  return { signature: sig, confirmed: !(conf?.value?.err), inAmount: q.inAmount, outAmount: q.outAmount, priceImpactPct: q.priceImpactPct };
}

export default { walletReady, keypair, address, balances, quote, swap, MINT };
