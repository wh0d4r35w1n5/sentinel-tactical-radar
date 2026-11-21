// onchain-trades.mjs — fold state/onchain-fills.json into round-trip trade
// records in the SAME shape as trades-taken.json entries, so the dashboard
// journal + evidence gallery render Solana lane trades as first-class trades
// (venue:'solana'), not a sidebar panel.
//   buy            -> open/accumulate a lot (FIFO per mint)
//   sell           -> close against FIFO lots, real proceeds
//   reconcile      -> wallet balance zeroed outside the lane journal. If a
//                     custody 'sell' leg matches the mint inside a 4h window
//                     its amountUsd is the real proceeds (chain-return.mjs
//                     sells ride the custody journal, not the lane's). Else
//                     net is honestly unknown -> status 'closed-ext'.
//   open lots      -> status 'open', mark from onchain-lane lastValueUsd
// Emits api/onchain-trades.json. Runs each rapid cycle after onchain-exec.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'api');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

const fills = readJ(path.join(ROOT, 'state', 'onchain-fills.json'), [])
  .filter((f) => f && f.ts).sort((a, b) => a.ts - b.ts);
const legs = readJ(path.join(ROOT, 'state', 'custody-legs.json'), []);
const lane = readJ(path.join(API, 'onchain-lane.json'), {});
const lanePos = Object.fromEntries((lane.positions || []).map((p) => [p.mint, p]));

const lots = {}; // mint -> [{ts, symbol, usd, qtyUi, sig, score}]
const trades = [];
const pushLot = (f) => {
  const qtyUi = (+f.qtyRaw || 0) / 1e6;
  (lots[f.mint] ||= []).push({ ts: f.ts, symbol: f.symbol, usd: +f.usd || 0, qtyUi, sig: f.sig, score: f.score });
};
const closeLot = (f, proceedsUsd, exitKind, exitSig) => {
  const mint = f.mint, open = lots[mint] || [];
  if (!open.length) return;
  const cost = open.reduce((a, l) => a + l.usd, 0);
  const qtyUi = open.reduce((a, l) => a + l.qtyUi, 0);
  const entryTs = open[0].ts;
  const net = proceedsUsd != null ? +(proceedsUsd - cost).toFixed(6) : null;
  trades.push({
    symbol: f.symbol || open[0].symbol || mint.slice(0, 8),
    dir: 'LONG', venue: 'solana', mint,
    strategy: 'On-chain lane', score: open[0].score ?? null,
    entryTs, exitTs: f.ts,
    entryPx: qtyUi > 0 ? +(cost / qtyUi).toPrecision(6) : null,
    exitPx: qtyUi > 0 && proceedsUsd != null ? +(proceedsUsd / qtyUi).toPrecision(6) : null,
    qty: +qtyUi.toFixed(6), notional: +cost.toFixed(4),
    fees: 0, pnl: net, net,
    pnlPct: net != null && cost > 0 ? +(net / cost * 100).toFixed(2) : null,
    status: net != null ? 'closed' : 'closed-ext',
    holdMin: Math.max(0, Math.round((f.ts - entryTs) / 6e4)),
    sig: open[0].sig, exitSig: exitSig || null, exitKind,
    exits: open.map((l) => ({ ts: f.ts, px: qtyUi > 0 && proceedsUsd != null ? +(proceedsUsd / qtyUi).toPrecision(6) : null, qty: l.qtyUi, pnl: proceedsUsd != null ? +(proceedsUsd * (l.usd / cost) - l.usd).toFixed(6) : null })),
  });
  lots[mint] = [];
};

for (const f of fills) {
  if (f.side === 'buy') pushLot(f);
  else if (f.side === 'sell') closeLot(f, +(f.estUsd ?? f.usd ?? NaN) || null, 'sell', f.sig);
  else if (f.side === 'reconcile') {
    const leg = legs.find((l) => l.kind === 'sell' && l.asset === f.mint && Math.abs((l.ts || 0) - f.ts) < 4 * 3600e3);
    closeLot(f, leg ? leg.amountUsd : null, leg ? 'custody-sell' : 'external', leg?.sig || null);
  }
}
// still-open lots -> open trade rows, mark from the live lane read
for (const [mint, open] of Object.entries(lots)) {
  for (const l of open) {
    const lp = lanePos[mint];
    trades.push({
      symbol: l.symbol || mint.slice(0, 8), dir: 'LONG', venue: 'solana', mint,
      strategy: 'On-chain lane', score: l.score ?? null,
      entryTs: l.ts, exitTs: null,
      entryPx: l.qtyUi > 0 ? +(l.usd / l.qtyUi).toPrecision(6) : null,
      exitPx: lp?.entryPxUsd ?? null,
      qty: +l.qtyUi.toFixed(6), notional: +l.usd.toFixed(4),
      fees: 0, pnl: null, net: null, upl: lp ? +(lp.lastValueUsd - l.usd).toFixed(6) : null,
      status: 'open', holdMin: Math.max(0, Math.round((Date.now() - l.ts) / 6e4)),
      sig: l.sig, exits: [],
    });
  }
}

trades.sort((a, b) => b.entryTs - a.entryTs);
const closed = trades.filter((t) => t.status === 'closed' && t.net != null);
const wins = closed.filter((t) => t.net > 0);

// ---- lane vault: SENTINEL_VAULT_SHARE of every net-positive close banks
// into a sealed reserve (state/onchain-vault.json) when the purse NAV is at
// new highs — the same HWM discipline as the futures vault: nothing banks
// while underwater, sweptIds dedupe means a trade can never pay twice.
// Segregation is accounting-level: the reserve stays USDC in the same
// wallet, subtracted from onchain-exec's spendable stables — on an $11
// purse a separate vault address would burn more in gas than it protects.
const VAULT_SHARE = Math.min(0.9, Math.max(0, +(process.env.SENTINEL_VAULT_SHARE ?? 0.25)));
const VAULT_PATH = path.join(ROOT, 'state', 'onchain-vault.json');
const vault = { balanceUsd: 0, hwmUsd: 0, sweptIds: {}, sweeps: [], ...readJ(VAULT_PATH, {}) };
vault.sweptIds ||= {}; vault.sweeps ||= [];
let vaultChg = 0;
if (VAULT_SHARE > 0) {
  const hwmLoaded = +vault.hwmUsd || 0;
  const navNow = +lane.purseUsd || 0; // stables + deployed marks — reserve lives inside this
  let room = Math.max(0, navNow - (vault.hwmUsd || 0));
  for (const t of closed.sort((a, b) => a.exitTs - b.exitTs)) {
    const sid = `ot:${t.mint}:${t.exitTs}`;
    if (vault.sweptIds[sid]) continue;
    if (!(t.net > 0)) { vault.sweptIds[sid] = 1; continue; }
    const amt = Math.max(0, Math.min(t.net * VAULT_SHARE, room));
    room = Math.max(0, room - t.net);
    if (!(amt > 0)) { vault.sweptIds[sid] = 1; continue; }
    vault.sweptIds[sid] = 1;
    vault.sweeps.push({ ts: t.exitTs, sid, symbol: t.symbol, amountUsd: +amt.toFixed(4), hwm: +navNow.toFixed(2) });
    vault.balanceUsd = +(vault.balanceUsd + amt).toFixed(4);
    vaultChg += amt;
  }
  vault.hwmUsd = +Math.max(vault.hwmUsd || 0, navNow).toFixed(4);
  if (vaultChg > 0 || vault.hwmUsd !== hwmLoaded || !vault.updatedAt) {
    vault.sweeps = vault.sweeps.slice(-500);
    vault.updatedAt = new Date().toISOString();
    writeJ(VAULT_PATH, vault);
  }
}

writeJ(path.join(API, 'onchain-trades.json'), {
  ts: Date.now(), updatedAt: new Date().toISOString(),
  trades,
  stats: {
    n: closed.length, wins: wins.length,
    net: +closed.reduce((a, t) => a + t.net, 0).toFixed(4),
    open: trades.filter((t) => t.status === 'open').length,
    externalCloses: trades.filter((t) => t.status === 'closed-ext').length,
  },
  vault: {
    share: VAULT_SHARE, reservedUsd: +(+vault.balanceUsd || 0).toFixed(4),
    hwmUsd: +(+vault.hwmUsd || 0).toFixed(4), sweeps: (vault.sweeps || []).length,
    note: 'reserve sealed in-wallet — subtracted from lane spendable, never a separate address',
  },
  note: 'Solana lane round-trips folded from onchain-fills.json — FIFO per mint; gas is the declared lamports blind spot; closed-ext = tokens left the wallet outside the lane journal (proceeds unknown unless a custody sell leg matched).',
});
console.log(`onchain-trades: ${trades.length} trades (${closed.length} netted, ${trades.filter(t => t.status === 'open').length} open)`);
