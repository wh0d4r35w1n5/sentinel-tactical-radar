#!/usr/bin/env node
// trade-chain — Satoshi's timestamp server for the book (operator order
// 2026-10-15 "secrets from the whitepaper"). Every new exchange fill is
// appended to state/trade-chain.jsonl hash-chained: {n, ts, data, hash}
// where hash = sha256(prevHash + canonical(data)). Any rewrite of history
// changes the head — verify() recomputes the whole chain. Runs forever
// (60s poll); the exec/daemons never write here, it's append-only truth.
process.env.SENTINEL_EXCHANGE='bitget'; process.env.SENTINEL_EXEC='live'; // .env carries bybit/demo — pin before makeExchange
import fs from 'fs';
import crypto from 'crypto';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
const FILE = '/opt/sentinel/state/trade-chain.jsonl';
const HEAD = '/opt/sentinel/state/chain-head.json';
const X = makeExchange();
const canon = (x) => JSON.stringify(x, Object.keys(x).sort());
const hash = (h, d) => crypto.createHash('sha256').update(h + canon(d)).digest('hex');
let head = 'GENESIS', n = 0, seen = new Set();
try {
  const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
  for (const l of lines) { const j = JSON.parse(l); seen.add(j.data.tradeId || j.data.fillId || j.hash); head = j.hash; n = Math.max(n, j.n); }
} catch { }
export const verify = () => {
  try {
    let h = 'GENESIS'; let i = 0;
    for (const l of fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean)) {
      const j = JSON.parse(l); i++;
      if (j.hash !== hash(h, j.data) || j.n !== i) return { ok: false, at: i };
      h = j.hash;
    }
    return { ok: true, n: i, head: h };
  } catch (e) { return { ok: false, err: e.message }; }
};
const append = (data) => {
  const id = data.tradeId || data.fillId; if (id && seen.has(id)) return false;
  const j = { n: ++n, ts: Date.now(), data, hash: hash(head, data) };
  fs.appendFileSync(FILE, JSON.stringify(j) + '\n'); head = j.hash; if (id) seen.add(id);
  fs.writeFileSync(HEAD, JSON.stringify({ n, head, at: Date.now(), v: verify().ok }));
  return true;
};
const poll = async () => {
  try {
    const f = await X.getFills(); const list = (Array.isArray(f) ? f : (f.fillList || f.list || []));
    const now = Date.now();
    const newOnes = list.filter((x) => +x.cTime > now - 10 * 60e3).sort((a, b) => +a.cTime - +b.cTime);
    for (const x of newOnes) {
      const id = String(x.tradeId || x.fillId || `${x.symbol}:${x.cTime}:${x.baseVolume}:${x.price}`);
      if (seen.has(id)) continue;
      const ok = append({ tradeId: id, ts: +x.cTime, sym: x.symbol, side: x.side, tradeSide: x.tradeSide, qty: +x.baseVolume, px: +x.price, pnl: +x.profit || 0, fee: +(x.feeDetail?.[0]?.totalFee || 0), src: x.enterPointSource || null });
      if (ok) console.log('[chain]', id.slice(-8), x.symbol, x.tradeSide, '->', head.slice(0, 12));
    }
    const a = await X.getAccount();
    append({ tradeId: `snap:${Math.floor(now / 600e3)}`, ts: now, kind: 'equity-snapshot', equity: +a.equity, avail: +a.available, pos: (await X.getPos()).map(p => `${p.symbol}:${p.holdSide}:${p.total}`) });
  } catch (e) { console.error('[chain]', e.message?.slice(0, 120)); }
};
if (process.argv[2] === 'verify') { console.log(verify()); process.exit(0); }
console.log('[chain] up — verify-dont-trust ledger, head', head.slice(0, 12), 'n', n);
for (;;) { await poll(); await new Promise(r => setTimeout(r, 60e3)); }
