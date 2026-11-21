// hft-shadow.mjs — zero-risk microstructure probe.
// Snapshots top-of-book + funding every ~4s on liquid crypto perps, then
// joins each snapshot to its forward 1m/5m return. Answers the only question
// that matters before risking a cent: does book imbalance / spread / funding
// predict short-horizon moves enough to beat 0.04-0.12% round-trip fees?
// Output: state/hft-shadow.jsonl  {ts,sym,bid,ask,spr%,bidSz,askSz,imb,fund,fwd1m%,fwd5m%}
import fs from 'node:fs';

const ROOT = '/opt/sentinel';
const OUT = `${ROOT}/state/hft-shadow.jsonl`;
const SYMS = (process.env.HFT_SYMS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,ZECUSDT,HYPEUSDT,ASTERUSDT,NEARUSDT,DOGEUSDT,LINKUSDT').split(',');
const SYM_MS = +(process.env.HFT_SYM_MS || 8000); // per-symbol cadence
const STAGGER = Math.max(250, Math.floor(SYM_MS / SYMS.length));
const FUND = +process.env.HFT_FUND_MS || 60000;

const api = async (p) => {
  const r = await fetch('https://api.bitget.com' + p, { signal: AbortSignal.timeout(8000) });
  const d = await r.json();
  return d?.data ?? null;
};

// ring of recent snapshots per symbol for forward-return join
const hist = new Map(); // sym -> [{ts,mid}]
const funding = new Map(); // sym -> rate (refreshed every FUND ms)

const snap = async (sym) => {
  try {
    const d = await api(`/api/v2/mix/market/merge-depth?symbol=${sym}&productType=USDT-FUTURES&precision=scale0&limit=10`);
    const bids = d?.bids || [], asks = d?.asks || [];
    if (!bids.length || !asks.length) return;
    const bid = +bids[0][0], ask = +asks[0][0];
    if (!(bid > 0) || !(ask > bid)) return;
    const mid = (bid + ask) / 2;
    const bidSz = +bids[0][1] || 0, askSz = +asks[0][1] || 0;
    const imb = (bidSz - askSz) / (bidSz + askSz || 1);
    const spr = (ask - bid) / mid * 100;
    const now = Date.now();
    const h = hist.get(sym) || [];
    // forward returns vs snapshots ~60s and ~300s old
    let f1 = null, f5 = null;
    for (const p of h) {
      const age = now - p.ts;
      if (f1 == null && age >= 55000 && age <= 75000) f1 = (mid / p.mid - 1) * 100;
      if (f5 == null && age >= 280000 && age <= 330000) { f5 = (mid / p.mid - 1) * 100; break; }
    }
    h.push({ ts: now, mid });
    while (h.length && now - h[0].ts > 360000) h.shift();
    hist.set(sym, h);
    const row = { ts: now, sym, bid, ask, spr: +spr.toFixed(4), bidSz, askSz,
      imb: +imb.toFixed(4), fund: funding.get(sym) ?? null,
      fwd1m: f1 == null ? null : +f1.toFixed(4), fwd5m: f5 == null ? null : +f5.toFixed(4) };
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  } catch {}
};

const refreshFunding = async () => {
  try {
    const d = await api('/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    for (const t of d || []) {
      const s = t.symbol;
      if (SYMS.includes(s)) funding.set(s, +t.fundingRate || 0);
    }
  } catch {}
};

console.log(`hft-shadow up: ${SYMS.length} syms every ${SYM_MS}ms -> ${OUT}`);
await refreshFunding();
setInterval(refreshFunding, FUND);
// stagger symbols so we don't burst — each symbol on its own cadence
for (let i = 0; i < SYMS.length; i++) setTimeout(() => {
  snap(SYMS[i]);
  setInterval(() => snap(SYMS[i]), SYM_MS);
}, i * STAGGER);
