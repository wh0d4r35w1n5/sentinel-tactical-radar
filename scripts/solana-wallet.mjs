// Generates the bot's Solana hot-wallet keypair and persists it to .env
// (SOLANA_BOT_SECRET=base64(64-byte secretKey)). Idempotent — never
// overwrites an existing key. Prints ONLY the public address; the secret
// never leaves the box.
//
// Funds: send USDT/USDC (Solana network) + ~0.05 SOL for gas to the printed
// address. The onchain exec lane activates automatically once a balance
// exists — see scripts/onchain-exec.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import './load-env.mjs';

const ENV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

const existing = process.env.SOLANA_BOT_SECRET;
if (existing) {
  const kp = Keypair.fromSecretKey(Buffer.from(existing, 'base64'));
  console.log(`wallet already exists: ${kp.publicKey.toBase58()}`);
  process.exit(0);
}

const kp = Keypair.generate();
const b64 = Buffer.from(kp.secretKey).toString('base64');
const line = `\n# Solana hot wallet — bot-custodied, bounded balance (generated ${new Date().toISOString()})\nSOLANA_BOT_SECRET=${b64}\n`;
fs.appendFileSync(ENV, line);
console.log(`SOLANA_BOT_ADDRESS=${kp.publicKey.toBase58()}`);
console.log('secret written to .env (SOLANA_BOT_SECRET) — never commit/echo it');
