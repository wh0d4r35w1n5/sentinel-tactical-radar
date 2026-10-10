// custody-proof.mjs — wallet<->exchange custody evidence.
// Reads state/custody-legs.json (append-only journal — chain-return.mjs and
// lane sweeps write completed legs), re-verifies every sig on-chain via RPC,
// and emits api/chain-custody.json for the dashboard + evidence gallery.
// A leg is VERIFIED when its signature resolves to a confirmed transaction
// with meta.err===null; Credited legs are exchange-receipt claims verified
// through the venue's own deposit/withdrawal history, not a sig.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-env.mjs';
import { Connection } from '@solana/web3.js';
import { address as walletAddress } from './exchange/solana-swap.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'api');
const LEGS_FILE = path.join(ROOT, 'state', 'custody-legs.json');
const OUT_FILE = path.join(API, 'chain-custody.json');
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

export const appendLeg = (leg) => {
  const legs = readJ(LEGS_FILE, []);
  legs.push({ ts: Date.now(), ...leg });
  writeJ(LEGS_FILE, legs);
  return legs.length;
};

export const emitCustody = async () => {
  const legs = readJ(LEGS_FILE, []);
  let conn = null;
  const out = [];
  for (const leg of legs) {
    const row = { ...leg, solscan: leg.sig ? `https://solscan.io/tx/${leg.sig}` : null };
    if (leg.sig && leg.verified !== true) {
      try {
        conn ||= new Connection(RPC, 'confirmed');
        const tx = await conn.getTransaction(leg.sig, {
          commitment: 'confirmed', maxSupportedTransactionVersion: 0,
        });
        if (tx && tx.meta && tx.meta.err == null) {
          row.verified = true;
          row.slot = tx.slot;
          row.blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
          leg.verified = true; leg.slot = tx.slot; // persist — verify once
        } else row.verified = false;
      } catch { row.verified = false; }
    } else if (leg.sig) row.verified = leg.verified === true;
    else row.verified = leg.verified === true; // credit legs: venue-receipt claim
    out.push(row);
  }
  writeJ(LEGS_FILE, legs); // persist any new verification stamps
  const ret = out.filter((l) => l.kind === 'return' && l.verified);
  writeJ(OUT_FILE, {
    ts: Date.now(), updatedAt: new Date().toISOString(),
    wallet: walletAddress() || null,
    legs: out.slice().reverse(), // newest first
    summary: {
      nLegs: out.length,
      verifiedLegs: out.filter((l) => l.verified).length,
      returnedUsd: +ret.reduce((a, l) => a + (l.amountUsd || 0), 0).toFixed(4),
      lastLegTs: out.length ? Math.max(...out.map((l) => l.ts || 0)) : null,
    },
    note: 'custody legs are operator-directed proofs — sigs verified on-chain via RPC, credited legs verified in the venue deposit history. Not part of the autonomous lane.',
  });
  return out.length;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  emitCustody()
    .then((n) => console.log(`chain-custody.json emitted — ${n} leg(s)`))
    .catch((e) => { console.error('custody-proof failed:', e.message); process.exit(1); });
}
