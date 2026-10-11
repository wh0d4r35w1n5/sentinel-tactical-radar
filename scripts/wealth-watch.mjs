#!/usr/bin/env node
// wealth-watch.mjs — REAL-TIME unified wealth watcher. The operator's rule:
// never quote a modeled/stale balance — the exchange and the chain are the
// only truth, and they're both event-driven now.
//
//   futures leg  Bitget PRIVATE websocket (wss://ws.bitget.com/v2/ws/private)
//                account+positions channels push equity/margin/size changes
//                in ~100-300ms — REST poll (1.5s) as fallback while the socket
//                is down or unauthenticated.
//   solana leg   Connection.onAccountChange on the hot wallet (instant SOL
//                lamport events) + 15s balances() poll for the SPL set; token
//                USD marks reuse the lane's own Jupiter marks (onchain-lane.json).
//
//   Every detected delta (deposit/withdrawal/transfer, margin add/remove,
//   size change, open/close) journals to `deltas[]` AND touches
//   state/bw-kick — bitget-watch's fs.watch resyncs SL/TP in the same second,
//   so a manual margin top-up re-fits protection ~10x faster than the 10s poll.
//
//   Output: api/wealth-live.json — the ONLY number anyone should ever quote:
//   exchange equity + chain wallet value, event-fresh, never the book model.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';
import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import * as sol from './exchange/solana-swap.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const A = (f) => path.join(ROOT, 'api', f);
const S = (f) => path.join(ROOT, 'state', f);
const KICK = S('bw-kick');
const TAG = () => `[ww ${new Date().toISOString().slice(11, 19)}]`;
const log = (...a) => console.log(TAG(), ...a);
const REST_FALLBACK_MS = 1500;
const SOL_POLL_MS = 15000;
const WRITE_MIN_MS = 400;      // event-driven writes throttled to 2.5Hz max

const X = makeExchange({ ...process.env, SENTINEL_EXCHANGE: 'bitget', SENTINEL_EXEC: 'live' });
const KEY = process.env.BITGET_API_KEY || '';
const SECRET = process.env.BITGET_API_SECRET || '';
const PASS = process.env.BITGET_PASSPHRASE || '';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

// ---- state ----------------------------------------------------------------
const fut = { equityUsd: 0, availableUsd: 0, uplUsd: 0, marginUsedUsd: 0, positions: new Map(), at: 0 };
const sola = { address: sol.walletReady() ? sol.address() : null, solQty: 0, solPx: 0, stableUsd: 0, bagsUsd: 0, tokens: {}, at: 0 };
const deltas = [];
let wsUp = false, lastWsAt = 0, lastWrite = 0, pendingWrite = false;
const kick = () => { try { fs.writeFileSync(KICK, String(Date.now())); } catch {} };
const delta = (kind, detail, amt) => {
  deltas.unshift({ ts: Date.now(), kind, detail, amt: +(amt || 0).toFixed(4) });
  if (deltas.length > 50) deltas.pop();
  log(`${kind} ${detail} ${amt >= 0 ? '+' : ''}${(+amt).toFixed(2)}`);
};

// ---- delta detection -------------------------------------------------------
const posKey = (p) => `${p.symbol || p.instId}:${p.holdSide || p.posSide || p.side}`;
function diffPositions(next) {
  let kickWorthy = false;
  for (const [k, p] of next) {
    const prev = fut.positions.get(k);
    if (!prev) { delta('position-opened', k, +p.marginSize || 0); kickWorthy = true; continue; }
    const mD = (+p.marginSize || 0) - (+prev.marginSize || 0);
    const sD = (+p.total || 0) - (+prev.total || 0);
    if (Math.abs(mD) > 0.05 && Math.abs(sD) < 1e-9) { delta(mD > 0 ? 'margin-added' : 'margin-removed', k, mD); kickWorthy = true; }
    if (Math.abs(sD) > 1e-9) { delta(sD > 0 ? 'size-added' : 'size-reduced', `${k} Δ${sD}`, 0); kickWorthy = true; }
  }
  for (const [k] of fut.positions) if (!next.has(k)) { delta('position-closed', k, 0); kickWorthy = true; }
  return kickWorthy;
}

function mergeFutures(equityUsd, availableUsd, posRows) {
  // posRows === null means the fetch FAILED — an API error must never read as
  // an empty book (same rule as bitget-watch's getPlans): skip position merge
  if (posRows === null) {
    if (equityUsd != null) fut.equityUsd = equityUsd;
    if (availableUsd != null) fut.availableUsd = availableUsd;
    fut.at = Date.now();
    return false;
  }
  const next = new Map();
  for (const p of posRows || []) {
    if (!(+p.total > 0)) continue;
    next.set(posKey(p), { marginSize: +p.marginSize || 0, total: +p.total, upl: +p.unrealizedPL || 0 });
  }
  const eD = (equityUsd ?? fut.equityUsd) - fut.equityUsd;
  const structural = diffPositions(next);
  if (fut.at && Math.abs(eD) > 0.05 && !structural) delta('balance-move', 'equity', eD);
  if (equityUsd != null) fut.equityUsd = equityUsd;
  if (availableUsd != null) fut.availableUsd = availableUsd;
  fut.positions = next;
  fut.marginUsedUsd = [...next.values()].reduce((a, p) => a + p.marginSize, 0);
  fut.uplUsd = [...next.values()].reduce((a, p) => a + p.upl, 0);
  fut.at = Date.now();
  return structural;
}

// ---- bitget private ws -----------------------------------------------------
const WS_URL = 'wss://ws.bitget.com/v2/ws/private';
let ws = null, wsRetryMs = 1000;
function wsSign() {
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHmac('sha256', SECRET).update(ts + 'GET' + '/user/verify').digest('base64');
  return { op: 'login', args: [{ apiKey: KEY, passphrase: PASS, timestamp: ts, sign }] };
}
function wsConnect() {
  try { ws?.terminate(); } catch {}
  ws = new WebSocket(WS_URL);
  let ping = null, watchdog = null;
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { try { ws.terminate(); } catch {} }, 45e3); };
  ws.on('open', () => {
    ws.send(JSON.stringify(wsSign()));
    arm();
  });
  ws.on('message', (buf) => {
    arm(); lastWsAt = Date.now();
    const raw = String(buf);
    if (raw === 'pong') return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.event === 'login') {
      if (+m.code === 0) {
        wsUp = true; wsRetryMs = 1000;
        ws.send(JSON.stringify({ op: 'subscribe', args: [
          { instType: 'USDT-FUTURES', channel: 'account', coin: 'default' },
          { instType: 'USDT-FUTURES', channel: 'positions', instId: 'default' },
        ] }));
        log('private ws LIVE — account+positions push armed');
      } else { wsUp = false; log('ws login refused:', m.msg || m.code, '— REST fallback active'); }
      return;
    }
    if (m.event === 'error') { log('ws error:', m.msg || m.code); return; }
    const ch = m?.arg?.channel, rows = m?.data;
    if (!Array.isArray(rows)) return;
    if (ch === 'account') {
      const usdt = rows.find((r) => /usdt/i.test(r.marginCoin || r.coin || '')) || rows[0] || {};
      const equity = +(usdt.usdtEquity ?? usdt.equity ?? usdt.totalEquity ?? NaN);
      const avail = +(usdt.available ?? usdt.availableBalance ?? NaN);
      const prevEq = fut.equityUsd;
      if (Number.isFinite(equity)) fut.equityUsd = equity;
      if (Number.isFinite(avail)) fut.availableUsd = avail;
      fut.at = Date.now();
      if (prevEq && Math.abs(fut.equityUsd - prevEq) > 0.05) delta('balance-move', 'account push', fut.equityUsd - prevEq);
      scheduleWrite();
    } else if (ch === 'positions') {
      const next = new Map();
      let marginUsed = 0, upl = 0;
      for (const r of rows) {
        const k = posKey(r);
        next.set(k, { marginSize: +r.marginSize || 0, total: +r.total || 0, upl: +r.unrealizedPL || 0 });
        marginUsed += +r.marginSize || 0;
        upl += +r.unrealizedPL || 0;
      }
      // NOTE: positions channel pushes CHANGED rows only — merge into the
      // existing map rather than replacing (a push of one pos isn't the book)
      const merged = new Map(fut.positions);
      let kickWorthy = false;
      for (const [k, p] of next) {
        const prev = merged.get(k);
        const mD = p.marginSize - (prev?.marginSize || 0);
        const sD = p.total - (prev?.total || 0);
        if (!prev && p.total > 0) { delta('position-opened', k, p.marginSize); kickWorthy = true; }
        else if (prev && Math.abs(mD) > 0.05 && Math.abs(sD) < 1e-9) { delta(mD > 0 ? 'margin-added' : 'margin-removed', k, mD); kickWorthy = true; }
        else if (prev && Math.abs(sD) > 1e-9) { delta(sD > 0 ? 'size-added' : 'size-reduced', `${k} Δ${sD}`, 0); kickWorthy = true; }
        if (p.total > 0) merged.set(k, p); else merged.delete(k);
      }
      fut.positions = merged;
      fut.marginUsedUsd = [...merged.values()].reduce((a, p) => a + p.marginSize, 0);
      fut.uplUsd = [...merged.values()].reduce((a, p) => a + p.upl, 0);
      fut.at = Date.now();
      if (kickWorthy) kick();
      scheduleWrite();
    }
  });
  ws.on('close', () => { wsUp = false; clearInterval(ping); clearTimeout(watchdog); setTimeout(wsConnect, wsRetryMs = Math.min(15000, wsRetryMs * 1.6)); });
  ws.on('error', () => { try { ws.terminate(); } catch {} });
  ws.on('open', () => { ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 20e3); });
}

// ---- REST fallback (also the boot baseline) --------------------------------
async function restSnap() {
  const [bal, pos] = await Promise.all([X.getAccount().catch(() => null), X.getPos().catch(() => null)]);
  if (bal || pos) {
    const structural = mergeFutures(bal ? +bal.equity : null, bal ? +bal.available : null, pos);
    if (structural) kick();
  }
  fut.at = Date.now();
}

// ---- solana leg --------------------------------------------------------------
async function solPoll() {
  if (!sola.address) return;
  try {
    const b = await sol.balances();
    sola.solQty = b.sol;
    const prevStable = sola.stableUsd;
    sola.tokens = b.tokens;
    sola.stableUsd = (b.tokens[sol.MINT.USDC] || 0) + (b.tokens[sol.MINT.USDT] || 0);
    if (prevStable && Math.abs(sola.stableUsd - prevStable) > 0.5) delta('chain-stable-move', 'hot wallet', sola.stableUsd - prevStable);
    // bag USD from the lane's own Jupiter marks (it quotes every cycle anyway)
    try {
      const lane = JSON.parse(fs.readFileSync(A('onchain-lane.json'), 'utf8'));
      sola.bagsUsd = +(lane.purseUsd || 0);
    } catch {}
    sola.at = Date.now();
    scheduleWrite();
  } catch {}
}
async function solPxRefresh() {
  try {
    const t = await X.ticker('SOLUSDT');
    const tk = Array.isArray(t) ? t[0] : t;
    sola.solPx = +(tk?.lastPr || tk?.bidPr || 0);
  } catch {}
}
function solSubscribe() {
  if (!sola.address) return;
  try {
    const conn = new Connection(RPC, 'confirmed');
    conn.onAccountChange(new PublicKey(sola.address), (acc) => {
      const qty = acc.lamports / 1e9;
      if (Math.abs(qty - sola.solQty) > 1e-6) delta('chain-sol-move', 'hot wallet', qty - sola.solQty);
      sola.solQty = qty; sola.at = Date.now(); scheduleWrite();
    });
    log('solana ws LIVE — hot wallet lamport events armed');
  } catch (e) { log('solana subscribe failed:', e.message.slice(0, 120)); }
}

// ---- unified write -----------------------------------------------------------
function wealth() {
  const solUsd = sola.solQty * (sola.solPx || 0);
  const solTotal = solUsd + sola.stableUsd + sola.bagsUsd;
  return {
    ts: new Date().toISOString(),
    ageMs: Date.now() - Math.max(fut.at, sola.at),
    src: wsUp ? 'ws' : 'rest',
    futures: {
      equityUsd: +fut.equityUsd.toFixed(4), availableUsd: +fut.availableUsd.toFixed(4),
      marginUsedUsd: +fut.marginUsedUsd.toFixed(4), uplUsd: +fut.uplUsd.toFixed(4),
      positions: [...fut.positions.entries()].map(([k, p]) => ({ k, size: p.total, marginUsd: +p.marginSize.toFixed(4), uplUsd: +p.upl.toFixed(4) })),
    },
    solana: {
      address: sola.address, solQty: +sola.solQty.toFixed(6), solUsd: +solUsd.toFixed(4),
      stableUsd: +sola.stableUsd.toFixed(4), bagsUsd: +sola.bagsUsd.toFixed(4), totalUsd: +solTotal.toFixed(4),
      staleMs: sola.at ? Date.now() - sola.at : null,
    },
    totalUsd: +(fut.equityUsd + solTotal).toFixed(4),
    deltas: deltas.slice(0, 20),
  };
}
function write() {
  lastWrite = Date.now(); pendingWrite = false;
  try { fs.writeFileSync(A('wealth-live.json'), JSON.stringify(wealth(), null, 1)); } catch (e) { log('write failed:', e.message.slice(0, 80)); }
}
function scheduleWrite() {
  if (Date.now() - lastWrite >= WRITE_MIN_MS) write();
  else if (!pendingWrite) { pendingWrite = true; setTimeout(write, WRITE_MIN_MS); }
}

// ---- boot -------------------------------------------------------------------
log(`starting — bitget private ws + solana events, REST fallback ${REST_FALLBACK_MS}ms`);
await restSnap().catch((e) => log('rest boot snap failed:', e.message.slice(0, 120)));
write();
if (KEY && SECRET && PASS) wsConnect(); else log('no bitget creds in env — REST only');
setInterval(() => { if (!wsUp || Date.now() - lastWsAt > 30000) restSnap().catch(() => {}); }, REST_FALLBACK_MS);
setInterval(solPoll, SOL_POLL_MS); solPoll();
setInterval(solPxRefresh, 60000); solPxRefresh();
solSubscribe();
setInterval(write, 5000); // heartbeat freshness even in silence
process.on('SIGTERM', () => { log('SIGTERM — exiting'); process.exit(0); });
