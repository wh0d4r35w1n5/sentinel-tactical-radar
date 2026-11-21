#!/usr/bin/env node
// coinbase-intel — replicates Coinbase's data-driven push insights via public Exchange API.
// Captures: new listings (product-list diff), listing status flips, 24h movers,
// intraday price spikes. Emits events to state/coinbase-intel.jsonl and a snapshot
// to api/coinbase-intel.json, symbols mapped to Bitget-style {BASE}USDT so the
// exec/factory universe can join directly.
// Public endpoints only — no auth, IP-rate-limited ~10req/s; we stay under it.
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';

const API = 'https://api.exchange.coinbase.com';
const FEED = '/opt/sentinel/state/coinbase-intel.jsonl';
const SNAP = '/opt/sentinel/state/coinbase-intel.json';
const API_SNAP = '/opt/sentinel/api/coinbase-intel.json';
const SEEN_FILE = '/opt/sentinel/state/coinbase-products.json';
const HIST_FILE = '/opt/sentinel/state/coinbase-ticks.json';
const VOL_FILE = '/opt/sentinel/state/coinbase-vols.json';

const POLL_MS = 90_000;
const REQ_GAP_MS = 125;              // ~8 req/s, under public limit
const SPIKE_WINS = [[300, 2.0], [900, 3.5]]; // [windowSec, %move] spike triggers
const MOVER_PCT = 6;                 // 24h % to count as a mover
const MOVER_VOL_MIN = 500_000;       // $500k 24h volume floor
const TICK_TOPN = 100;               // how many products get per-cycle ticker polls
const STATS_TOPN = 150;              // products stats-swept per cycle (top volume)
const FULL_SWEEP_EVERY = 10;         // every Nth cycle sweeps ALL products
const TICK_KEEP = 40;                // ticks retained per product

const log = (...a) => console.log('[ci ' + new Date().toISOString().slice(11, 19) + ']', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const save = (p, o) => { try { writeFileSync(p, JSON.stringify(o, null, 1)); } catch (e) { log('write', p, e.message); } };
const emit = ev => {
  ev.t = new Date().toISOString();
  try { appendFileSync(FEED, JSON.stringify(ev) + '\n'); } catch (e) { log('feed', e.message); }
  recent.push(ev);
  if (recent.length > 80) recent.splice(0, recent.length - 80);
  log('EMIT', ev.type, ev.sym || ev.product || '', JSON.stringify(ev).slice(0, 140));
};
const recent = [];

async function j(path) {
  const r = await fetch(API + path, { headers: { 'user-agent': 'sentinel-intel/1.0' } });
  if (!r.ok) throw new Error(path + ' http ' + r.status);
  return r.json();
}

let seen = load(SEEN_FILE, null);     // productId -> {status, firstSeen}; null = unbootstrapped
let ticks = load(HIST_FILE, {});      // productId -> [[epochSec, price], ...]
let lastMoverEmit = {};               // base -> pct at last mover emit
let volMap = load(VOL_FILE, {});      // productId -> last known 24h $ volume
let cycleN = 0;

async function cycle() {
  const t0 = Date.now();
  const products = await j('/products');
  if (!Array.isArray(products)) throw new Error('products not array');

  const online = [];
  const usdQuotes = new Set(['USD', 'USDC', 'USDT']);
  let newListings = 0, statusFlips = 0;
  const now = Date.now() / 1000;
  const bootstrap = (seen === null);
  if (bootstrap) seen = {};

  for (const p of products) {
    const id = p.id;
    const prev = seen[id];
    if (!prev) {
      seen[id] = { status: p.status, firstSeen: now };
      if (!bootstrap) {
        newListings++;
        emit({ type: 'listing', product: id, sym: (p.base_currency || '') + 'USDT', base: p.base_currency, quote: p.quote_currency, status: p.status, tradingDisabled: !!p.trading_disabled, firstSeen: now });
      }
    } else if (prev.status !== p.status) {
      statusFlips++;
      emit({ type: 'status_flip', product: id, sym: (p.base_currency || '') + 'USDT', from: prev.status, to: p.status });
      prev.status = p.status;
    }
    if (usdQuotes.has(p.quote_currency) && p.status === 'online' && !p.trading_disabled && !p.cancel_only) online.push(p);
  }
  if (newListings || statusFlips || bootstrap) save(SEEN_FILE, seen);

  // 24h movers via /stats — top-volume products each cycle, full resweep
  // every FULL_SWEEP_EVERY cycles for discovery (low-vol can't pass the
  // mover volume floor anyway, so skipping them loses nothing)
  cycleN++;
  const fullSweep = (cycleN % FULL_SWEEP_EVERY === 1);
  const statList = fullSweep
    ? online
    : [...online].sort((a, b) => (volMap[b.id] || 0) - (volMap[a.id] || 0)).slice(0, STATS_TOPN);
  const movers = [];
  const volById = {};
  for (const p of statList) {
    try {
      const s = await j(`/products/${p.id}/stats`);
      const open = +s.open, last = +s.last, volUsd = +s.volume * +s.last;
      if (volUsd > 0) volById[p.id] = volUsd;
      if (open > 0 && last > 0) {
        const pct = (last - open) / open * 100;
        if (Math.abs(pct) >= MOVER_PCT && volUsd >= MOVER_VOL_MIN) {
          const base = p.base_currency;
          const prev = lastMoverEmit[base];
          if (prev === undefined || Math.abs(pct - prev) >= 1.5 || Math.sign(pct) !== Math.sign(prev)) {
            emit({ type: 'mover', sym: base + 'USDT', base, pct24: +pct.toFixed(2), vol24: Math.round(volUsd), dir: pct > 0 ? 'up' : 'down' });
            lastMoverEmit[base] = pct;
          }
          movers.push({ base, pct24: +pct.toFixed(2), vol24: Math.round(volUsd) });
        }
      }
    } catch (e) { log('stats', p.id, e.message); }
    await sleep(REQ_GAP_MS);
  }
  movers.sort((a, b) => Math.abs(b.pct24) - Math.abs(a.pct24));
  if (Object.keys(volById).length) { Object.assign(volMap, volById); save(VOL_FILE, volMap); }

  // intraday spikes: ticker polls on the top-volume products
  const tickList = [...online]
    .sort((a, b) => (volById[b.id] || 0) - (volById[a.id] || 0))
    .slice(0, TICK_TOPN);
  for (const p of tickList) {
    try {
      const tk = await j(`/products/${p.id}/ticker`);
      const px = +tk.price;
      if (px > 0) {
        const arr = ticks[p.id] || (ticks[p.id] = []);
        arr.push([now, px]);
        if (arr.length > TICK_KEEP) arr.splice(0, arr.length - TICK_KEEP);
        for (const [w, th] of SPIKE_WINS) {
          const ref = arr.find(x => now - x[0] >= w);
          if (ref) {
            const pct = (px - ref[1]) / ref[1] * 100;
            if (Math.abs(pct) >= th) {
              const key = p.id + ':' + w;
              if (!lastMoverEmit[key] || Math.abs(px / lastMoverEmit[key] - 1) > 0.005) {
                emit({ type: 'spike', sym: p.base_currency + 'USDT', base: p.base_currency, pct: +pct.toFixed(2), winSec: w, price: px });
                lastMoverEmit[key] = px;
              }
            }
          }
        }
      }
    } catch (e) { log('ticker', p.id, e.message); }
    await sleep(REQ_GAP_MS);
  }
  save(HIST_FILE, ticks);

  const snap = {
    asof: new Date().toISOString(),
    products: products.length,
    onlineUsd: online.length,
    listings: Object.keys(seen).length,
    topMovers: movers.slice(0, 25),
    recent,
    cadenceSec: POLL_MS / 1000
  };
  save(SNAP, snap);
  save(API_SNAP, snap);
  log('cycle done in', ((Date.now() - t0) / 1000).toFixed(1) + 's —', online.length, 'usd products,', movers.length, 'movers,', recent.length, 'recent events');
}

log('coinbase-intel up — public API replication of CB push insights');
(async () => {
  for (;;) {
    try { await cycle(); } catch (e) { log('cycle err:', e.message); }
    await sleep(POLL_MS);
  }
})();
