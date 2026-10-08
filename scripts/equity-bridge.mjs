// equity-bridge.mjs — exchange-verified profitability bridge.
// Answers: "equity at inception, adjusted for deposits/withdrawals, vs
// today's equity = actual % return + max drawdown". Source of truth is
// Bitget account bills (external transfers/funding/liquidation settle)
// + the equity-peak sample curve + live-ledger equity. Writes
// api/equity-bridge.json; refreshed by systemd timer.
import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const X = makeExchange({ ...process.env, SENTINEL_EXCHANGE: 'bitget', SENTINEL_EXEC: 'live' });
const EPOCH = new Date(process.env.SENTINEL_BRIDGE_EPOCH || '2026-10-05T00:00:00Z').getTime();

const start = new Date('2026-08-01').getTime(), end = Date.now();
let all = [], idAfter = null;
for (let pg = 0; pg < 60; pg++) {
  const qs = `productType=USDT-FUTURES&limit=100&startTime=${start}&endTime=${end}` + (idAfter ? `&idLessThan=${idAfter}` : '');
  const d = await X.api('GET', '/api/v2/mix/account/bill', { qs }).catch((e) => ({ err: e.message }));
  const list = d?.bills || (Array.isArray(d) ? d : []);
  if (!list.length) break;
  all.push(...list);
  idAfter = list[list.length - 1].billId || list[list.length - 1].id;
  if (list.length < 100) break;
}
all.sort((a, b) => +a.cTime - +b.cTime);

let equityNow = null;
try {
  const ll = JSON.parse(fs.readFileSync(path.join(ROOT, 'api', 'live-ledger.json'), 'utf8'));
  equityNow = +ll.equityUsd || null;
} catch {}

const bridge = (since) => {
  let dep = 0, wd = 0, funding = 0, burst = 0, grants = 0;
  for (const b of all) {
    if (+b.cTime < since) continue;
    const t = b.businessType || '', a = +b.amount || 0;
    if (t === 'trans_from_exchange') dep += a;
    else if (t === 'trans_to_exchange') wd += -a;
    else if (t === 'contract_settle_fee') funding += a;
    else if (t === 'burst_long_loss_query') burst += a;
    else if (/user_grants/.test(t)) grants += Math.abs(a);
  }
  const netExt = dep - wd + grants;
  const pnl = equityNow != null ? equityNow - netExt : null;
  return {
    depositsUsd: +dep.toFixed(2), withdrawalsUsd: +wd.toFixed(2),
    grantsUsd: +grants.toFixed(2), netExternalUsd: +netExt.toFixed(2),
    tradingPnlUsd: pnl != null ? +pnl.toFixed(2) : null,
    returnPct: dep > 0 && pnl != null ? +((pnl / dep) * 100).toFixed(1) : null,
    fundingNetUsd: +funding.toFixed(3),
    liquidationSettleUsd: +burst.toFixed(2),
  };
};

// maxDD on the deposit-adjusted equity curve: PnL(t)=equity(t)-cumExt(t).
// Absolute-dollar worst peak->trough + pct vs the peak when peak>0.
let samples = [];
try { samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'equity-peak-live.json'), 'utf8')).samples || []; } catch {}
const flows = all.filter((b) => /trans_from_exchange|trans_to_exchange|user_grants/.test(b.businessType || ''))
  .map((b) => ({ ts: +b.cTime, amt: (b.businessType === 'trans_to_exchange' ? -1 : 1) * Math.abs(+b.amount || 0) }));
const cumAt = (ts) => flows.reduce((s, f) => s + (f.ts <= ts ? f.amt : 0), 0);
let pk = -Infinity, ddUsd = 0, ddPct = 0;
for (const [ts, eq] of samples) {
  const v = eq - cumAt(ts);
  if (v > pk) pk = v;
  const dd = pk - v;
  if (dd > ddUsd) ddUsd = dd;
  if (pk > 0 && dd / pk > ddPct) ddPct = dd / pk;
}

const out = {
  at: new Date().toISOString(),
  equityNowUsd: equityNow,
  epochStart: new Date(EPOCH).toISOString(),
  epoch: bridge(EPOCH),
  allTime: { ...bridge(0), windowStart: all.length ? new Date(+all[0].cTime).toISOString() : null, billsN: all.length },
  maxPnlDrawdownUsd: +ddUsd.toFixed(2),
  maxPnlDrawdownPct: +(ddPct * 100).toFixed(1),
  equitySamples: samples.length,
};
fs.writeFileSync(path.join(ROOT, 'api', 'equity-bridge.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
