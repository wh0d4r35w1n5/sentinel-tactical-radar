// manual override: force-enter a position NOW (Bitget or Bybit via makeExchange).
// usage: node force-trade.mjs SYMBOLUSDT LONG|SHORT [stopPct=0.9] [tgtPct=4.0]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeExchange } from './exchange/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const p of [path.join(__dirname, '..', '.env'), '/opt/sentinel/.env']) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  } catch {}
}

const X = makeExchange(process.env);
if (!X.hasCreds) throw new Error(`missing ${X.name} API credentials`);

const SYM = process.argv[2] || 'NEARUSDT';
const DIR = (process.argv[3] || 'LONG').toUpperCase();
const SGN = DIR === 'LONG' ? 1 : -1;
const HOLD = DIR === 'LONG' ? 'long' : 'short';
const BUYSIDE = DIR === 'LONG' ? 'buy' : 'sell';
const stopPct = +(process.argv[4] || 0.9);
const tgtPct = +(process.argv[5] || 4.0);

const plans = await X.getPlans(SYM);
const byType = {};
for (const pl of plans || [])
  if (pl.orderId && pl.planType) (byType[pl.planType] ??= []).push(pl.orderId);
for (const [pt, ids] of Object.entries(byType))
  await X.cancelPlanOrders(SYM, pt, ids).catch((e) => console.log('cancel', pt, e.message));

const pos = await X.getPos();
const np = (pos || []).find((p) => p.symbol === SYM && +p.total > 0);
if (np) {
  await X.closePosition(SYM, np.holdSide);
  console.log('closed existing', np.holdSide, np.total, '@', np.openPriceAvg);
}

const acct = await X.getAccount();
const avail = +acct.available;
const cmap = await X.contractMap();
const ctr = cmap[SYM];
if (!ctr) throw new Error(`${SYM} missing from ${X.name} contract map`);
const tick = await X.ticker(SYM);
const row = Array.isArray(tick) ? tick[0] : tick;
const px = +(row.lastPr || row.lastPrice || 0);
if (!(px > 0)) throw new Error(`no ticker for ${SYM}`);
const lev = Math.min(+ctr.maxLev || 25, Math.floor(80 / (stopPct + 0.64)));
const prec = Math.pow(10, +ctr.sizePlace || 0);
const minQ = Math.max(+ctr.minTradeNum || 0, (+ctr.minTradeUSDT || 0) / px);
console.log(`[${X.name}] equity $${(+acct.equity).toFixed(2)} avail $${avail.toFixed(2)} | ${SYM} px ${px} | lev ${lev}x`);

await X.setIsolated(SYM).catch(() => {});
await X.setLeverage(SYM, lev);
const FIXED = +process.env.FORCE_MARGIN_USD || 0;
const fracs = process.env.FORCE_FRACS
  ? process.env.FORCE_FRACS.split(',').map(Number)
  : FIXED
    ? [Math.min(FIXED / avail, 0.97), Math.min(FIXED / avail, 0.97) * 0.95]
    : [0.85, 0.80, 0.75, 0.70, 0.60];
let size = 0, done = false;
for (const frac of fracs) {
  size = Math.max(Math.floor((avail * frac * lev) / px * prec) / prec, Math.ceil(minQ * prec) / prec);
  try {
    await X.marketOrder(SYM, BUYSIDE, String(size), 'open');
    console.log('filled at', (frac * 100).toFixed(0) + '% of avail — size', size, '~$' + (size * px).toFixed(2), 'notional, ~$' + (size * px / lev).toFixed(2), 'margin');
    done = true; break;
  } catch (e) { console.log('attempt', (frac * 100).toFixed(0) + '% rejected:', e.message); }
}
if (!done) throw new Error('all size attempts rejected');

const pos2 = await X.getPos();
const lp = (pos2 || []).find((p) => p.symbol === SYM && +p.total > 0);
if (!lp) throw new Error('fill succeeded but position not visible yet');
const fill = +lp.openPriceAvg;
const pp = +ctr.pricePlace || 4;
await X.planOrder(SYM, 'profit_plan', (fill * (1 + SGN * tgtPct / 100)).toFixed(pp), String(lp.total), HOLD, 'isolated');
await X.planOrder(SYM, 'loss_plan', (fill * (1 - SGN * stopPct / 100)).toFixed(pp), String(lp.total), HOLD, 'isolated');
console.log(`${DIR} ${SYM} ${lp.total} @ ${fill} lev ${lev}x margin ~$${(lp.total * fill / lev).toFixed(2)} | TP ${SGN * tgtPct}% @ ${(fill * (1 + SGN * tgtPct / 100)).toFixed(pp)} | SL ${-SGN * stopPct}% @ ${(fill * (1 - SGN * stopPct / 100)).toFixed(pp)}`);
