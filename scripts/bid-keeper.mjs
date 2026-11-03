// bid-keeper.mjs — persistent greedy-patient bid net.
// Re-arms resting limit bids each cycle if missing (Bitget drops them
// under margin pressure). Budget-checked: total margin <= BUDGET_FRAC of
// free equity. Every fill lands under watcher armor (SL + vtp ladder).
import fs from 'node:fs';
import './load-env.mjs';
// pinned: this daemon trades the LIVE bitget book — never let the .env
// bybit/demo defaults leak in through unit-file env precedence quirks.
process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_EXEC = 'live';
import { makeExchange } from './exchange/index.mjs';

const X = makeExchange();
const MS = +(process.env.BIDKEEPER_MS || 60e3);
const BUDGET_FRAC = +(process.env.BIDKEEPER_BUDGET_FRAC || 0.45); // of available margin
const LEAD_PCT = +(process.env.BIDKEEPER_LEAD_PCT || 4.2);         // % under mark

// symbol, size, ref discount — deep-value cells only (proven/flat + fresh diversifiers)
const NET = [
  { sym: 'MUUSDT',     size: '0.01',  lead: 1.4 },  // proven — tight
  { sym: 'VELVETUSDT', size: '82',    lead: 1.4 },  // proven — tight
  { sym: 'PENGUUSDT',  size: '740',   lead: 1.4 },
  { sym: 'XLMUSDT',    size: '31',    lead: 1.4 },
  { sym: 'DOGEUSDT',   size: '72',    lead: 1.4 },
  { sym: 'APTUSDT',    size: '7.5',   lead: 1.4 },
  { sym: 'MUUSDT',     size: '0.01',  lead: 4.2 },  // deep leg
  { sym: 'VELVETUSDT', size: '82',    lead: 4.2 },
  { sym: 'PENGUUSDT',  size: '740',   lead: 4.2 },
  { sym: 'XLMUSDT',    size: '31',    lead: 4.2 },
  { sym: 'DOGEUSDT',   size: '72',    lead: 4.2 },
];
const log = (...a) => console.log(`[bidk ${new Date().toISOString().slice(11, 19)}]`, ...a);

let CMAP = {};
const round = (x, p = 6) => +(+x).toFixed(p);
const pxPlace = (sym) => +(CMAP[sym]?.pricePlace ?? 6);
const tick = async (sym) => {
  const t = await X.ticker(sym).catch(() => null);
  const r = Array.isArray(t) ? t[0] : t;
  return +(r?.markPr || r?.lastPr || 0);
};

for (;;) {
  try {
    if (!Object.keys(CMAP).length) { try { CMAP = await X.contractMap() || {}; } catch {} }
    const acc = await X.getAccount().catch(() => null);
    const avail = +(acc?.available || 0);
    // hard cap on total live bid margin — the 'available' field goes
    // negative once pending orders lock margin, so budget off a flat cap
    // scaled by equity, not the exchange's own free-margin field.
    const equity = +(acc?.equity || acc?.available || 0);
    const budget = Math.max(1.0, equity * BUDGET_FRAC);
    const held = new Set();
    try {
      const pos = await X.getPos().catch(() => []);
      for (const p of pos) held.add(p.symbol);
    } catch {}
    let spent = 0;
    for (const leg of NET) {
      const { sym, size } = leg;
      if (held.has(sym)) continue; // already seated — watcher owns it
      const mark = await tick(sym);
      if (!(mark > 0)) continue;
      const lead = +(leg.lead ?? LEAD_PCT);
      const px = round(mark * (1 - lead / 100), pxPlace(sym));
      const pend = await X.pendingOrders(sym).catch(() => []);
      // a live bk leg only counts as THIS rung if within ~1.2% of its
      // price — otherwise it's the other depth of the ladder.
      const live = pend.find((o) => /^bk-/.test(String(o.clientOid || '')) && Math.abs(+o.price - px) / mark < 0.012);
      if (live) { spent += (+live.size || +size) * (+live.price) / 10; continue; }
      const notional = (+size) * px;
      const marginEst = notional / 10; // ~10x conservative
      if (spent + marginEst > budget) { log(`${sym}: budget cap — skipped ($${marginEst.toFixed(2)} > $${(budget - spent).toFixed(2)} left)`); continue; }
      try {
        const r = await X.limitOrder(sym, 'buy', size, String(px), { tradeSide: 'open', clientOid: `bk-${Date.now().toString(36).slice(-5)}` });
        const oid = r?.orderId || r?.data?.orderId || '';
        spent += marginEst;
        log(`${sym}: re-armed ${size} @ ${px} (-${lead}% vs ${mark}) oid …${String(oid).slice(-8)}`);
      } catch (e) { log(`${sym}: place failed — ${String(e.message).slice(0, 90)}`); }
    }
  } catch (e) { log('cycle err:', String(e.message).slice(0, 120)); }
  await new Promise((r) => setTimeout(r, MS));
}
