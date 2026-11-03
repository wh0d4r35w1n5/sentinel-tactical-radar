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
const fut = { equityUsd: 0, availableUsd: 0, uplUsd: 0, marginUsedUsd: 0, grantUsd: 0, positions: new Map(), at: 0 };
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
    next.set(posKey(p), { marginSize: +p.marginSize || 0, total: +p.total, upl: +p.unrealizedPL || 0, grant: +p.grant || 0 });
  }
  const eD = (equityUsd ?? fut.equityUsd) - fut.equityUsd;
  const structural = diffPositions(next);
  if (fut.at && Math.abs(eD) > 0.05 && !structural) delta('balance-move', 'equity', eD);
  if (equityUsd != null) fut.equityUsd = equityUsd;
  if (availableUsd != null) fut.availableUsd = availableUsd;
  fut.positions = next;
  fut.marginUsedUsd = [...next.values()].reduce((a, p) => a + p.marginSize, 0);
  fut.uplUsd = [...next.values()].reduce((a, p) => a + p.upl, 0);
  // grant/coupon margin is phantom equity — tracked separately so the book
  // can report both the exchange figure and the ownable truth. REST rows
  // carry the field; this is an authoritative grant read for the ATH gate.
  fut.grantUsd = [...next.values()].reduce((a, p) => a + (p.grant || 0), 0);
  grantLoaded = true;
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
        next.set(k, { marginSize: +r.marginSize || 0, total: +r.total || 0, upl: +r.unrealizedPL || 0, grant: +r.grant || 0 });
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
      // WS rows do NOT carry the coupon grant field — summing here would zero
      // grantUsd on every push and let the phantom equity back into totalUsd.
      // Only REST paths (snapshot + 30s enrichment) own the grant total.
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
// DexScreener best-liquidity USD price per mint — covers bags the lane book
// doesn't know (operator app buys, airdrops, hold-listed mints).
async function bagPx(mints) {
  if (!mints.length) return {};
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.slice(0, 30).join(',')}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const best = {};
    for (const p of j?.pairs || []) {
      const m = p?.baseToken?.address, liq = +p?.liquidity?.usd || 0;
      if (m && liq > (best[m]?.liq || -1)) best[m] = { px: +p.priceUsd || 0, liq };
    }
    return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.px]));
  } catch { return {}; }
}
async function solPoll() {
  if (!sola.address) return;
  try {
    const b = await sol.balances();
    sola.solQty = b.sol;
    const prevStable = sola.stableUsd;
    sola.tokens = b.tokens;
    sola.stableUsd = (b.tokens[sol.MINT.USDC] || 0) + (b.tokens[sol.MINT.USDT] || 0);
    if (prevStable && Math.abs(sola.stableUsd - prevStable) > 0.5) delta('chain-stable-move', 'hot wallet', sola.stableUsd - prevStable);
    // wallet-truth bags: value EVERY non-stable SPL on the chain, then take the
    // max with the lane's own Jupiter marks (lane prices its tracked positions
    // even when dexscreener is thin) — operator-held bags were invisible before.
    const bagMints = Object.keys(b.tokens).filter((m) => m !== sol.MINT.USDC && m !== sol.MINT.USDT);
    const px = await bagPx(bagMints);
    let walletBags = 0;
    sola.tokenUsd = {};
    for (const m of bagMints) {
      const usd = +(b.tokens[m] * (px[m] || 0)).toFixed(4);
      if (usd > 0) sola.tokenUsd[m.slice(0, 8)] = usd;
      walletBags += usd;
    }
    let lanePurse = 0;
    try {
      const lane = JSON.parse(fs.readFileSync(A('onchain-lane.json'), 'utf8'));
      lanePurse = +(lane.purseUsd || 0);
    } catch {}
    // wallet truth wins whenever the dexscreener read landed — the lane's
    // purse estimate (cost-basis + vault leftovers) ran ~$3 high vs the
    // Bitget Wallet app's real balances and inflated every ATH card.
    sola.bagsUsd = walletBags > 0 ? walletBags : lanePurse;
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
      grantUsd: +fut.grantUsd.toFixed(4), equityOwnUsd: +(fut.equityUsd - fut.grantUsd).toFixed(4),
      marginUsedUsd: +fut.marginUsedUsd.toFixed(4), uplUsd: +fut.uplUsd.toFixed(4),
      positions: [...fut.positions.entries()].map(([k, p]) => ({ k, size: p.total, marginUsd: +p.marginSize.toFixed(4), uplUsd: +p.upl.toFixed(4) })),
    },
    solana: {
      address: sola.address, solQty: +sola.solQty.toFixed(6), solUsd: +solUsd.toFixed(4),
      stableUsd: +sola.stableUsd.toFixed(4), bagsUsd: +sola.bagsUsd.toFixed(4), totalUsd: +solTotal.toFixed(4),
      tokens: sola.tokenUsd || {},
      staleMs: sola.at ? Date.now() - sola.at : null,
    },
    // total = OWNABLE wealth: grant/coupon margin is phantom equity (on close
    // only the P&L lands) so it never counts toward the combined figure.
    totalUsd: +((fut.equityUsd - fut.grantUsd) + solTotal).toFixed(4),
    deltas: deltas.slice(0, 20),
  };
}
// ---- Will ATH reporter ------------------------------------------------------
// Operator mandate: every new all-time-high of combined ownable real balance
// (Bot1 equityOwnUsd + Bot2 solana total) goes to Will via the outbox router.
// state/wealth-ath.json persists the high-water mark across restarts; first
// write after boot seeds silently so a restart never retro-spams.
const ATH_F = S('wealth-ath.json');
const OUTBOX = S('tg-outbox.jsonl');
const FX_F = S('fx-aud.json');
const LIAB_F = S('liabilities.json');
let audRate = 0;           // USD->AUD display rate; 0 = unavailable -> USD-only card
async function fxPoll() {
  let rate = 0;
  for (const url of [
    'https://api.frankfurter.app/latest?from=USD&to=AUD',
    'https://open.er-api.com/v6/latest/USD',
  ]) {
    try {
      const j = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
      rate = +(j?.rates?.AUD || 0);
      if (rate > 1 && rate < 3) break;
      rate = 0;
    } catch {}
  }
  if (!rate) {
    try { rate = +(JSON.parse(fs.readFileSync(FX_F, 'utf8')).rate || 0); } catch {}
  }
  if (rate > 0) { audRate = rate; try { fs.writeFileSync(FX_F, JSON.stringify({ rate, at: new Date().toISOString() })); } catch {} }
}
fxPoll(); setInterval(fxPoll, 6 * 3600e3);
const fmtA = (usd) => audRate > 0 ? `A$${(usd * audRate).toFixed(2)}` : `$${usd.toFixed(2)}`;
const audNote = () => audRate > 0 ? ` (US$ shown 2nd · @${audRate.toFixed(3)})` : '';
let grantLoaded = false;   // set once the first grant-enrichment poll lands —
// before that equityOwnUsd still carries the phantom coupon and any ATH read
// is fiction. Boot also brings the two legs up at different times, so both
// must be populated before the high-water check may run.
function athCheck(w) {
  if (!fut.at || !sola.at || !grantLoaded) return;
  if (w.ageMs != null && w.ageMs > 60000) return;   // stale legs aren't ATHs
  const tot = +w.totalUsd;
  if (!isFinite(tot) || tot <= 0.01) return;
  let ath = {};
  try { ath = JSON.parse(fs.readFileSync(ATH_F, 'utf8')); } catch {}
  const prev = +ath.athUsd || 0;
  if (!prev) { try { fs.writeFileSync(ATH_F, JSON.stringify({ athUsd: tot, at: w.ts })); } catch {} return; }
  // cent-creep isn't news — require a meaningful step above the last ATH
  // (0.5% of book or $0.50, whichever is larger) before messaging Will.
  const step = Math.max(0.50, prev * 0.005);
  if (tot < prev + step) {
    // benign re-read at/below the mark — clear any armed pending jump
    if (ath.pendUsd) { delete ath.pendUsd; delete ath.pendAt; try { fs.writeFileSync(ATH_F, JSON.stringify(ath)); } catch {} }
    return;
  }
  // a >$2 positive balance/chain delta inside the last 3min = deposit, not P&L
  const dep = (w.deltas || []).some(d =>
    /balance-move|chain-stable-move|chain-sol-move/.test(d.kind || '') &&
    (d.amt || 0) > 2 && Date.now() - (d.ts || 0) < 180000);
  // persistence gate — swap-settle windows double-count (stable credit +
  // token bags priced pre-debit) and flash +$X phantoms for seconds; a
  // >10% jump or any deposit-flagged step must HOLD ~20s before it may
  // fire a card or rebase the mark. Genuine levels persist; phantoms revert.
  const jump = (tot - prev) / prev;
  if (jump > 0.10 || dep) {
    const pend = +ath.pendUsd || 0, pendAt = +ath.pendAt || 0;
    const held = pend > 0 && Math.abs(tot - pend) <= pend * 0.02 && Date.now() - pendAt >= 20000;
    if (!held) {
      if (!pend || Math.abs(tot - pend) > pend * 0.02) { ath.pendUsd = tot; ath.pendAt = Date.now(); }
      try { fs.writeFileSync(ATH_F, JSON.stringify(ath)); } catch {}
      return;
    }
    delete ath.pendUsd; delete ath.pendAt;
    if (dep) {
      // held 20s+ AND a real delta exists = genuine deposit: the new
      // level is real wealth, so rebase the mark — but a deposit is
      // never trading performance, so no card goes to Will.
      try { fs.writeFileSync(ATH_F, JSON.stringify({ athUsd: tot, prevUsd: prev, at: w.ts, viaDeposit: true })); } catch {}
      log(`deposit rebase — mark $${tot.toFixed(2)} silently (no ATH card)`);
      return;
    }
  }
  // Will's standing review: judge by net live P&L + real closed episodes,
  // never backtest SQN — every ATH card carries the live-evidence line.
  let lv = null;
  try {
    const fills = (JSON.parse(fs.readFileSync(S('real-fills.json'), 'utf8')).fills || []);
    const cl = fills.filter(f => f.tradeSide === 'close' && (!f.src || f.src === 'api'));
    const nets = cl.map(f => (+f.profit || 0) - (+f.fee || 0));
    const dayAgo = Date.now() - 86400e3;
    const nets24 = cl.filter(f => (f.ts || 0) > dayAgo).map(f => (+f.profit || 0) - (+f.fee || 0));
    // Bot 2 lane: onchain sells journal estUsd proceeds vs costUsd basis.
    let ocNets = [];
    try {
      const od = JSON.parse(fs.readFileSync(S('onchain-fills.json'), 'utf8'));
      const of = Array.isArray(od) ? od : (od.fills || []);
      ocNets = of.filter(x => x.side === 'sell' && x.estUsd != null && x.costUsd != null)
                 .map(x => x.estUsd - x.costUsd);
    } catch {}
    const allNets = nets.concat(ocNets);
    const gw = allNets.filter(x => x > 0).reduce((a, x) => a + x, 0);
    const gl = allNets.filter(x => x < 0).reduce((a, x) => a - x, 0);
    lv = {
      n: cl.length, net: nets.reduce((a, x) => a + x, 0),
      n24: nets24.length, net24: nets24.reduce((a, x) => a + x, 0),
      wr: cl.length ? nets.filter(x => x > 0).length / cl.length * 100 : 0,
      nB2: ocNets.length,
      pf: gl > 0.001 ? gw / gl : (gw > 0 ? Infinity : null),
    };
  } catch {}
  const prevEps = +ath.epsN || 0;
  // advance the mark BEFORE sending — the next tick must see the new
  // high-water or it re-fires the same card every write.
  try { fs.writeFileSync(ATH_F, JSON.stringify({ athUsd: tot, prevUsd: prev, at: w.ts, viaDeposit: false, epsN: lv ? lv.n : prevEps })); } catch {}
  const grant = +w.futures.grantUsd || 0;
  const hhmm = new Date().toISOString().slice(11, 16);
  const text = `🏔 <b>NEW ATH — combined real balance</b>\n\n` +
    `<b>${fmtA(tot)}</b>${audRate > 0 ? `  (US$${tot.toFixed(2)})` : ''}  (prev ${fmtA(prev)} · +${fmtA(tot - prev)})${dep ? '  ·  fresh deposit detected' : ''}\n` +
    `Bot1 ${fmtA(+w.futures.equityOwnUsd)} ownable${grant > 0.5 ? ` (+${fmtA(grant)} coupon margin — not ours, only its P&L counts)` : ''} · Bot2 ${fmtA(+w.solana.totalUsd)}${audNote()}\n` +
    `<i>as of ${hhmm} UTC</i>` +
    (lv ? `\nlive: <b>${lv.n}</b> B1 + <b>${lv.nB2}</b> B2 closed eps · net <b>${fmtA(lv.net)}</b>${lv.n24 && lv.n24 !== lv.n ? ` · 24h <b>${fmtA(lv.net24)}</b>` : ''} · WR ${lv.wr.toFixed(0)}% · PF <b>${lv.pf == null ? '—' : (lv.pf === Infinity ? '∞' : lv.pf.toFixed(2))}</b>${prevEps && lv.n === prevEps ? ' · move: open-pos uPL (no new closes)' : ''}` : '');
  try { fs.appendFileSync(OUTBOX, JSON.stringify({ text, to: 'will' }) + '\n'); } catch (e) { log('ath outbox:', e.message.slice(0, 60)); }
  log(`ATH->will $${tot.toFixed(2)} (prev $${prev.toFixed(2)})`);
}

// ---- drawdown watch (operator mandate 2026-10-12: constant balance awareness
// is the primary job). Fires to the operator's Saved Messages via outbox when
// ownable draws down >3% from
// the UTC-day high. Cooldown 30min per event class — never a stream.
const DD_F = S('wealth-dd.json');
let dd = (() => { try { return JSON.parse(fs.readFileSync(DD_F, 'utf8')); } catch { return {}; } })();
function ddCheck(w) {
  if (!fut.at || !sola.at || !grantLoaded) return;               // same leg gate as ATH
  const tot = +w.totalUsd;
  if (!isFinite(tot) || tot <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  if (dd.day !== today) { dd = { day: today, hiUsd: tot, prevTot: tot }; }
  // same phantom guard as athCheck: a +10% single-tick jump is a swap
  // settle double-count, not P&L — don't let it raise the day high.
  const prevTot = +dd.prevTot || 0;
  if (!(prevTot > 0 && (tot - prevTot) / prevTot > 0.10)) dd.hiUsd = Math.max(dd.hiUsd || 0, tot);
  dd.prevTot = tot;
  const now = Date.now();
  const cool = (k) => now - (dd[k] || 0) > 30 * 60e3;
  let msg = null, key = null;
  if (dd.hiUsd && tot < dd.hiUsd * 0.97 && cool('ddAt')) {
    key = 'ddAt';
    msg = `day drawdown ${((tot / dd.hiUsd - 1) * 100).toFixed(1)}% — ${fmtA(tot)} vs day-high ${fmtA(dd.hiUsd)}`;
  }
  if (key) {
    dd[key] = now;
    try { fs.appendFileSync(OUTBOX, JSON.stringify({ text: `📉 <b>WEALTH WATCH</b>\n${msg}` }) + '\n'); } catch {}
    log(`DD alert: ${msg}`);
  }
  try { fs.writeFileSync(DD_F, JSON.stringify(dd)); } catch {}
}
function write() {
  lastWrite = Date.now(); pendingWrite = false;
  const w = wealth();
  try { fs.writeFileSync(A('wealth-live.json'), JSON.stringify(w, null, 1)); } catch (e) { log('write failed:', e.message.slice(0, 80)); }
  try { athCheck(w); } catch (e) { log('ath:', e.message.slice(0, 60)); }
  try { ddCheck(w); } catch (e) { log('dd:', e.message.slice(0, 60)); }
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
// grant enrichment — the WS positions push doesn't carry the coupon/grant
// field, so phantom-equity accounting would read zero while the socket is
// live. A slow REST pass refreshes grantUsd only; the WS owns the position
// map, this touches nothing else.
setInterval(async () => {
  const pos = await X.getPos().catch(() => null);
  if (Array.isArray(pos)) {
    fut.grantUsd = pos.reduce((a, p) => a + (+p.grant || 0), 0); grantLoaded = true;
    // REST is the membership authority, not just the grant source — a WS
    // delta-merge never drops a position whose close-push was missed
    // (burst_close, reconnect gap), so while wsUp stays healthy the ghost
    // sits in the map forever (the NATGAS phantom, 2026-10-13). This 30s
    // pass bounds a ghost's life to one interval; deltas still fire.
    const structural = mergeFutures(null, null, pos);
    if (structural) kick();
  }
}, 30000);
setInterval(solPoll, SOL_POLL_MS); solPoll();
setInterval(solPxRefresh, 60000); solPxRefresh();
solSubscribe();
setInterval(write, 5000); // heartbeat freshness even in silence
process.on('SIGTERM', () => { log('SIGTERM — exiting'); process.exit(0); });
