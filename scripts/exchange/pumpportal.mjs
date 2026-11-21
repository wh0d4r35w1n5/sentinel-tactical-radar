// exchange/pumpportal.mjs — direct pump.fun bonding-curve rail via
// PumpPortal's trade-local builder + public new-token feed.
//
// Why this exists: Jupiter cannot route a token until it is indexed
// (minutes-hours for fresh mints), and Ultra can't route bonding-curve
// pairs at all — verified 2026-11-11 when every GRAD buy on unindexed
// mints failed 'Failed to get quotes'. The curve itself is the venue:
// trade-local returns an UNSIGNED versioned tx that we sign with the
// bot keypair and send ourselves — PumpPortal never touches funds.
//
// Feed: wss://pumpportal.fun/api/data subscribeNewToken pushes create
// events ~1s after launch with mint/creator/initialBuy/metadata.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import '../load-env.mjs';
import WebSocket from 'ws';
import * as sol from './solana-swap.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(DIR, '..', '..', 'state');
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const TRADE_LOCAL = process.env.PUMPPORTAL_TRADE || 'https://pumpportal.fun/api/trade-local';
const WS_URL = process.env.PUMPPORTAL_WS || 'wss://pumpportal.fun/api/data';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TF = () => AbortSignal.timeout(20000);

const conn = () => new Connection(RPC, 'confirmed');
const kp = () => sol.keypair();

// ---------- trade-local tx builder ----------
// action 'buy':  amount = SOL (denominatedInSol 'true') or token UI amount
// action 'sell': amount = token UI amount to sell
async function tradeLocal({ action, mint, amount, denominatedInSol = 'true', slippage = 15, priorityFee = 0.0001 }) {
  const res = await fetch(TRADE_LOCAL, {
    method: 'POST', signal: TF(),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: kp().publicKey.toBase58(),
      action, mint,
      amount,
      denominatedInSol: String(denominatedInSol),
      slippage,
      priorityFee,
      pool: 'pump',
    }),
  });
  if (!res.ok) throw new Error(`trade-local ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64) throw new Error(`trade-local returned ${buf.length}b — not a tx`);
  return buf;
}

async function signSend(buf) {
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([kp()]);
  const c = conn();
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await c.confirmTransaction(sig, 'confirmed').catch(() => null);
  return { signature: sig, confirmed: !(conf?.value?.err) };
}

export async function curveBuy({ mint, solAmount, slippage = 15 }) {
  const buf = await tradeLocal({ action: 'buy', mint, amount: solAmount, slippage });
  return signSend(buf);
}

export async function curveSell({ mint, tokenUiAmount, slippage = 20 }) {
  const buf = await tradeLocal({ action: 'sell', mint, amount: tokenUiAmount, denominatedInSol: 'false', slippage });
  return signSend(buf);
}

// ---------- bonding-curve price reader ----------
// BondingCurve account (Anchor): 8B disc | vToken u64 | vSol u64 |
// realToken u64 | realSol u64 | supply u64 | complete u8
// price (SOL per whole token) = vSol / vToken * 1e3  (vSol lamports→SOL,
// vToken raw→UI at 6 decimals: SOL/token = (vSol/1e9)/(vToken/1e6))
const curvePda = (mint) => {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM));
  return pda;
};

export async function curveState(mint) {
  const info = await conn().getAccountInfo(curvePda(mint));
  if (!info) return null;
  const b = info.data;
  if (b.length < 49) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const vToken = Number(dv.getBigUint64(8, true));
  const vSol = Number(dv.getBigUint64(16, true));
  const realSol = Number(dv.getBigUint64(32, true));
  const complete = b[48] === 1;
  if (!(vToken > 0) || !(vSol > 0)) return null;
  // SOL per UI token (6 decimals)
  const pxSol = (vSol / 1e9) / (vToken / 1e6);
  return { pxSol, vSol, vToken, realSol, complete, prog: 1 - (vToken / 1e6) / 1.073e9 };
}

// USD mark for a raw qty — needs SOL price; caller supplies or we read cache
export async function curveMarkUsd({ mint, qtyRaw, solPxUsd }) {
  const cs = await curveState(mint);
  if (!cs) return null;
  const qtyUi = qtyRaw / 1e6;
  return { markUsd: qtyUi * cs.pxSol * solPxUsd, pxSol: cs.pxSol, complete: cs.complete, prog: cs.prog };
}

// ---------- new-token feed ----------
// Returns {close}. onEvent fires per create tx; auto-reconnects.
export function watchNewTokens(onEvent, { onLog = console.log } = {}) {

  let ws = null, stopped = false, backoff = 1000;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(WS_URL);
    ws.on('open', () => {
      backoff = 1000;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      onLog('sniper: pumpportal feed subscribed');
    });
    ws.on('message', (d) => {
      let ev;
      try { ev = JSON.parse(String(d)); } catch { return; }
      if (ev.message) { onLog(`sniper: feed ${String(ev.message).slice(0, 80)}`); return; }
      try { onEvent(ev); } catch (e) { onLog(`sniper: event handler err ${String(e.message || e).slice(0, 100)}`); }
    });
    ws.on('error', (e) => onLog(`sniper: ws err ${e.message}`));
    ws.on('close', () => {
      if (!stopped) { onLog(`sniper: ws closed — reconnect in ${backoff}ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); }
    });
  };
  connect();
  return { close: () => { stopped = true; try { ws?.close(); } catch {} } };
}
