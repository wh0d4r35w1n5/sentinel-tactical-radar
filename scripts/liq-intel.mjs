#!/usr/bin/env node
// liq-intel — aggr.trade-grade liquidation + order-flow intelligence.
//
// Multi-venue public feeds (no auth) — Binance WS is silent-blocked from
// this box (REST works, WS connects then delivers nothing) so coverage is:
//   Bybit  allLiquidation ×whitelist   — liquidation prints, venue 1
//   OKX    liquidation-orders ×family  — liquidation prints, venue 2
//   Bitget trade ×whitelist            — aggressor flow incl. OUR exotics
//   Bybit  publicTrade BTC/ETH/SOL     — second-venue flow on majors
//
// Publishes api/liq-intel.json every 15s:
//   global cascade state, per-symbol liq totals by side (5m/15m/60m),
//   biggest single prints, aggressor deltas. Consumers: dip-watch
//   (capitulation), pump-watch (squeeze guard), onchain-exec (risk-off),
//   tg-signals (card context), outbox alerts on extreme events.
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const A = (f) => path.join(ROOT, 'api', f);
const S = (f) => path.join(ROOT, 'state', f);
const TAG = () => `[liq ${new Date().toISOString().slice(11, 19)}]`;
const log = (...a) => console.log(TAG(), ...a);

const FLOW_SYMS = (process.env.LIQ_FLOW_SYMS ||
  'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,XRPUSDT,AVAXUSDT,NEARUSDT,LINKUSDT,ARBUSDT,OPUSDT,SUIUSDT,INJUSDT,MAGICUSDT,LUMIAUSDT,CKBUSDT,ACTUSDT')
  .split(',');
const okxFam = (s) => s.replace('USDT', '-USDT');
const okxSym = (f) => f.replace('-', '');

// thresholds — one-sided liqs >$75M/15m across Bybit+OKX is a real cascade
// (Binance-only threshold would be ~2x this; two mid venues ~ half the tape)
const GLOBAL_CASCADE_USD = +(process.env.LIQ_GLOBAL_CASCADE_USD || 75e6);
const SYM_CASCADE_USD = +(process.env.LIQ_SYM_CASCADE_USD || 100e3);
const ALERT_COOLDOWN_MS = 15 * 60e3;
const OUTBOX = S('tg-outbox.jsonl');
const outbox = (text) => { try { fs.appendFileSync(OUTBOX, JSON.stringify({ text }) + '\n'); } catch {} };

const liqs = [];                 // {ts, sym, side:'long'|'short', usd, px, venue}
const flow = {};                 // sym -> [{ts, buy, sell}]
for (const s of FLOW_SYMS) flow[s] = [];
const bigPrints = [];
let lastAlertAt = 0;
const KEEP_MS = 2 * 3600e3;
const ctVal = {};                // OKX contract size per instId (base units)

const prune = (arr, ms) => { const cut = Date.now() - ms; while (arr.length && arr[0].ts < cut) arr.shift(); };
const sumUsd = (arr, ms, side = null, sym = null) => {
  const cut = Date.now() - ms; let s = 0;
  for (const l of arr) {
    if (l.ts < cut) continue;
    if (side && l.side !== side) continue;
    if (sym && l.sym !== sym) continue;
    s += l.usd;
  }
  return s;
};
const flowDelta = (sym, ms) => {
  const cut = Date.now() - ms; let buy = 0, sell = 0;
  for (const t of flow[sym] || []) { if (t.ts >= cut) { buy += t.buy; sell += t.sell; } }
  return { buy: +buy.toFixed(0), sell: +sell.toFixed(0), delta: +(buy - sell).toFixed(0) };
};

function recordLiq(sym, side, usd, px, venue) {
  if (!isFinite(usd) || usd <= 0) return;
  liqs.push({ ts: Date.now(), sym, side, usd, px, venue });
  if (usd >= SYM_CASCADE_USD) bigPrints.push({ ts: Date.now(), sym, side, usd, px, venue });
}

function snapshot() {
  const now = Date.now();
  const g5 = { long: sumUsd(liqs, 5 * 60e3, 'long'), short: sumUsd(liqs, 5 * 60e3, 'short') };
  const g15 = { long: sumUsd(liqs, 15 * 60e3, 'long'), short: sumUsd(liqs, 15 * 60e3, 'short') };
  const g60 = { long: sumUsd(liqs, 3600e3, 'long'), short: sumUsd(liqs, 3600e3, 'short') };
  let cascade = null, cascadeUsd = 0;
  if (g15.long >= GLOBAL_CASCADE_USD && g15.long > 3 * g15.short) { cascade = 'long'; cascadeUsd = g15.long; }
  else if (g15.short >= GLOBAL_CASCADE_USD && g15.short > 3 * g15.long) { cascade = 'short'; cascadeUsd = g15.short; }
  const symbols = {};
  for (const s of FLOW_SYMS) {
    const l15 = { long: sumUsd(liqs, 15 * 60e3, 'long', s), short: sumUsd(liqs, 15 * 60e3, 'short', s) };
    const l60 = { long: sumUsd(liqs, 3600e3, 'long', s), short: sumUsd(liqs, 3600e3, 'short', s) };
    const f = flowDelta(s, 15 * 60e3);
    if (l15.long + l15.short + l60.long + l60.short + Math.abs(f.delta) > 0)
      symbols[s] = { liq15m: l15, liq60m: l60, flow15m: f };
  }
  if (cascade && now - lastAlertAt > ALERT_COOLDOWN_MS) {
    lastAlertAt = now;
    outbox(`🌊 <b>LIQUIDATION CASCADE — ${cascade.toUpperCase()} side</b>\n` +
      `$${(cascadeUsd / 1e6).toFixed(0)}M ${cascade}-liqs /15m (Bybit+OKX).\n` +
      `${cascade === 'long' ? 'Capitulation selling — dip entries paused this window.' : 'Short squeeze running — pump-shorts stand down.'}`);
  }
  try {
    fs.writeFileSync(A('liq-intel.json'), JSON.stringify({
      ts: new Date().toISOString(),
      src: 'bybit-allLiq + okx-liqOrders + bitget/bybit-trade',
      global: { liq5m: g5, liq15m: g15, liq60m: g60, cascade, cascadeUsd },
      symbols,
      biggestPrints60m: bigPrints.slice(-10).reverse(),
      liqCount2h: liqs.length,
    }, null, 1));
  } catch {}
}

// ---- Bybit: allLiquidation per symbol + publicTrade on majors ----------------
function bybit() {
  let ws, ping;
  const go = () => {
    ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    ws.on('open', () => {
      const args = [
        ...FLOW_SYMS.map((s) => `allLiquidation.${s}`),
        'publicTrade.BTCUSDT', 'publicTrade.ETHUSDT', 'publicTrade.SOLUSDT',
      ];
      ws.send(JSON.stringify({ op: 'subscribe', args }));
      log(`bybit LIVE — ${FLOW_SYMS.length} liq topics + 3 trade feeds`);
      ping = setInterval(() => { try { ws.send(JSON.stringify({ op: 'ping' })); } catch {} }, 20e3);
    });
    ws.on('message', (d) => {
      try {
        const j = JSON.parse(d);
        if (j.topic?.startsWith('allLiquidation.')) {
          const sym = j.topic.split('.')[1];
          for (const t of j.data || []) {
            // S = liquidation order side: Buy order -> SHORT position rekt
            recordLiq(sym, t.S === 'Sell' ? 'long' : 'short', (+t.p || 0) * (+t.v || 0), +t.p, 'bybit');
          }
        } else if (j.topic?.startsWith('publicTrade.')) {
          const sym = j.topic.split('.')[1];
          if (!flow[sym]) return;
          for (const t of j.data || []) {
            const usd = (+t.p || 0) * (+t.v || 0);
            flow[sym].push({ ts: Date.now(), buy: t.S === 'Buy' ? usd : 0, sell: t.S === 'Sell' ? usd : 0 });
          }
        }
      } catch {}
    });
    ws.on('close', () => { clearInterval(ping); setTimeout(go, 5000); });
    ws.on('error', () => { try { ws.close(); } catch {} });
  };
  go();
}

// ---- OKX: liquidation-orders per instFamily ----------------------------------
async function okxCtVal() {
  for (const s of FLOW_SYMS) {
    const inst = `${okxFam(s)}-SWAP`;
    try {
      const r = await fetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${inst}`);
      const j = await r.json();
      ctVal[inst] = +(j.data?.[0]?.ctVal || 0);
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  log(`okx ctVal loaded for ${Object.keys(ctVal).length} instruments`);
}
function okx() {
  let ws, ping;
  const go = () => {
    ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'subscribe', args: FLOW_SYMS.map((s) => ({ channel: 'liquidation-orders', instType: 'SWAP', instFamily: okxFam(s) })) }));
      log(`okx LIVE — ${FLOW_SYMS.length} liquidation-orders families`);
      ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 25e3);
    });
    ws.on('message', (d) => {
      try {
        const j = JSON.parse(d);
        if (j.arg?.channel !== 'liquidation-orders' || !j.data) return;
        for (const row of j.data) {
          const sym = okxSym((row.instId || j.arg.instFamily || '').replace('-SWAP', ''));
          for (const dt of row.details || []) {
            // posSide = position that died; sz in contracts -> ctVal base units
            const cv = ctVal[row.instId] || 0;
            recordLiq(sym, dt.posSide === 'long' ? 'long' : 'short',
              (+dt.bkPx || 0) * (+dt.sz || 0) * cv, +dt.bkPx, 'okx');
          }
        }
      } catch {}
    });
    ws.on('close', () => { clearInterval(ping); setTimeout(go, 5000); });
    ws.on('error', () => { try { ws.close(); } catch {} });
  };
  go();
}

// ---- Bitget: trade channel, our whitelist incl. exotics ----------------------
function bitget() {
  let ws, ping;
  const go = () => {
    ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'subscribe', args: FLOW_SYMS.map((s) => ({ instType: 'USDT-FUTURES', channel: 'trade', instId: s })) }));
      log(`bitget LIVE — ${FLOW_SYMS.length} trade feeds`);
      ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 25e3);
    });
    ws.on('message', (d) => {
      try {
        const j = JSON.parse(d);
        if (j.event === 'subscribe' || !['update', 'snapshot'].includes(j.action) || !j.data) return;
        const sym = j.arg?.instId;
        if (!flow[sym]) return;
        for (const t of j.data) {
          const usd = (+t.px || 0) * (+t.sz || 0);
          flow[sym].push({ ts: Date.now(), buy: t.side === 'buy' ? usd : 0, sell: t.side === 'sell' ? usd : 0 });
        }
      } catch {}
    });
    ws.on('close', () => { clearInterval(ping); setTimeout(go, 5000); });
    ws.on('error', () => { try { ws.close(); } catch {} });
  };
  go();
}

log(`up — cascade gate $${(GLOBAL_CASCADE_USD / 1e6).toFixed(0)}M/15m · sym $${(SYM_CASCADE_USD / 1e3).toFixed(0)}k · ${FLOW_SYMS.length} syms · 3 venues`);
okxCtVal().then(() => { bybit(); okx(); bitget(); });
setInterval(() => {
  for (const s of Object.keys(flow)) prune(flow[s], 15 * 60e3);
  prune(liqs, KEEP_MS); prune(bigPrints, 3600e3);
  snapshot();
}, 15e3);
