import fs from 'node:fs';
import { makeExchange } from './exchange/index.mjs';
for (const p of ['.env', '/opt/sentinel/.env']) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
    break;
  } catch {}
}
const X = makeExchange(process.env);
const pm = await X.getPosMode('BTCUSDT').catch(() => null);
if (pm) X.setPosMode?.(pm);
const cmap = await X.contractMap();
const SYMS = ['ETHUSDT', 'SUIUSDT', 'ADAUSDT', 'XAUUSDT'];
const SL_PCT = 1.5, TP1_PCT = 1.5, TP2_PCT = 3.5, TP1_SHARE = 0.6;
const pos = await X.getPos();
for (const sym of SYMS) {
  const p = (pos || []).find((x) => x.symbol === sym && +x.total > 0);
  if (!p) { console.log(sym, 'no position — skip'); continue; }
  const side = p.holdSide || 'short';
  const size = +p.total, entry = +p.openPriceAvg;
  const c = cmap[sym] || {};
  const pp = +(c.pricePlace ?? 4), sp = Math.pow(10, +(c.sizePlace ?? 0));
  const minQ = Math.max(+c.minTradeNum || 0, (+c.minTradeUSDT || 0) / entry);
  const sgn = side === 'long' ? 1 : -1;
  const slPx = +(entry * (1 - sgn * SL_PCT / 100)).toFixed(pp);
  const tp1Px = +(entry * (1 + sgn * TP1_PCT / 100)).toFixed(pp);
  const tp2Px = +(entry * (1 + sgn * TP2_PCT / 100)).toFixed(pp);
  const mm = p.marginMode === 'crossed' ? 'crossed' : 'isolated';
  // place new protection FIRST, cancel old after — never naked
  await X.planOrder(sym, 'pos_loss', slPx, '0', side, mm);
  // Bitget counts cumulative pending plan qty against the position — legs
  // summing to the full size alongside a whole-cover pos_loss get silently
  // invalidated. Keep the ladder at ~85% cover like the exec retrofit.
  // Positions too small to split can't carry a sized leg at all — for them
  // a pos_profit (whole-position TP, size omitted) is the scalp exit.
  const cover = Math.floor(size * 0.85 * sp) / sp;
  const q1 = Math.floor(cover * TP1_SHARE * sp) / sp;
  const q2 = Math.round((cover - q1) * sp) / sp;
  let legs = [];
  if (q1 >= minQ && q2 >= minQ) legs = [[tp1Px, q1], [tp2Px, q2]];
  else if (cover >= minQ) legs = [[tp1Px, cover]];
  if (legs.length) {
    for (const [px, q] of legs) await X.planOrder(sym, 'profit_plan', px, String(q), side, mm);
  } else {
    await X.planOrder(sym, 'pos_profit', tp1Px, '0', side, mm);
    legs = [[tp1Px, size]];
  }
  // now retire the old ladder
  const old = await X.getPlans(sym).catch(() => []);
  for (const x of old || []) {
    if (!x.orderId || !x.planType) continue;
    if (x.holdSide && x.holdSide !== side) continue;
    const tp = +x.triggerPrice;
    if (/loss/i.test(x.planType) && tp !== slPx) await X.cancelPlanOrders(sym, x.planType, [String(x.orderId)]).catch(() => {});
    if (/profit/i.test(x.planType) && !legs.some(([px]) => px === tp)) await X.cancelPlanOrders(sym, x.planType, [String(x.orderId)]).catch(() => {});
  }
  console.log(sym, `${side} ${size} @ ${entry} | SL ${slPx} | TP ${legs.map(([px, q]) => `${q}@${px}`).join(' + ')}`);
}
