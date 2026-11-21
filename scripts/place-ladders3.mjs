// place-ladders3.mjs — restore staggered TP ladders on the live carry seats.
// Topology (mirrors bitget-watch doctrine): sized profit_plan trigger rungs at
// rr-config absPct levels + ONE whole-position pos_profit at the TOP rung as
// taker fallback. Seats are ~$10 notional vs $5 min tranche → at most 2 sized
// rungs fit; earliest rungs bank first, remainder rides pos_profit.
// Run with: SENTINEL_EXCHANGE=bitget SENTINEL_EXEC=live node place-ladders3.mjs
import '/opt/sentinel/scripts/load-env.mjs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
import { readFileSync } from 'node:fs';

const X = await makeExchange(process.env);
const rr = JSON.parse(readFileSync('/opt/sentinel/state/rr-config.json', 'utf8'));
const RUNGS = rr.absPct;               // [0.3, 0.55, 0.9, 1.4, 2.2]
const TOP = RUNGS[RUNGS.length - 1];   // pos_profit fallback level = top rung
const RUNG_PICK = [RUNGS[0], RUNGS[3]]; // 2-rung fit: +0.3% bank-early, +1.4% ride

const [pos, cm] = await Promise.all([X.getPos(), X.contractMap()]);
let placed = 0, moved = 0, failed = 0;

for (const p of pos) {
  const sym = p.symbol, sz = +p.total, e = +p.openPriceAvg, mark = +p.markPrice || 0;
  const c = cm[sym] || {};
  const dec = c.pricePlace ?? 5;
  const minUsd = c.minTradeUSDT || 5;
  const mult = c.sizeMultiplier || 1;
  const minNum = c.minTradeNum || 1;
  if (!(sz > 0) || !(e > 0)) continue;

  const plans = await X.getPlans(sym).catch(() => []);
  const profRows = plans.filter(r => r.planType === 'profit_plan');
  const posProfRows = plans.filter(r => r.planType === 'pos_profit');

  // --- 1. pos_profit must sit at the TOP rung (fallback), not at +0.3% ---
  const topPx = +(e * (1 + TOP / 100)).toFixed(dec);
  const hasTop = posProfRows.some(r => Math.abs(+r.triggerPrice - topPx) <= 2 * 10 ** -dec);
  if (!hasTop && posProfRows.length) {
    const ids = posProfRows.map(r => String(r.orderId || r.id)).filter(Boolean);
    if (ids.length) {
      try {
        await X.cancelPlanOrders(sym, 'pos_profit', ids);
        console.log('pos_profit moved off', sym, '@', posProfRows.map(r => r.triggerPrice).join(','));
      } catch (err) { console.log('FAIL cancel pos_profit', sym, String(err.message || err).slice(0, 90)); }
    }
  }
  if (!posProfRows.length || !hasTop) {
    try {
      await X.planOrder(sym, 'pos_profit', String(topPx), '0', p.holdSide || 'long', p.marginMode || 'isolated');
      console.log('pos_profit armed', sym, '+', TOP, '% @', topPx, '(whole-seat fallback)');
      moved++;
    } catch (err) {
      failed++;
      console.log('FAIL pos_profit', sym, TOP, String(err.message || err).slice(0, 90));
    }
    await new Promise(r => setTimeout(r, 250));
  }

  // --- 2. sized profit_plan rungs: as many $5+ rungs as the seat supports ---
  // minimum units per rung: covers $5 notional at the rung's trigger price,
  // minTradeNum, and sizeMultiplier granularity — all rounded UP to mult.
  let remaining = sz;
  const placedNow = new Set(profRows.map(r => `${+r.triggerPrice}`));
  for (const pct of RUNG_PICK) {
    const px = +(e * (1 + pct / 100)).toFixed(dec);
    if (mark > 0 && px <= mark * 1.0002) { console.log('skip', sym, '+', pct, '% — below mark'); continue; }
    if (placedNow.has(px)) { console.log('dup', sym, '+', pct, '%'); continue; }
    const uMin = Math.max(minNum, Math.ceil((minUsd * 1.005) / px / mult) * mult);
    // split: each rung gets ceil(half of what's left) so 2 rungs cover ~all
    let qty = Math.min(Math.ceil(remaining / 2 / mult) * mult, remaining);
    if (qty < uMin) qty = uMin;
    if (qty > remaining) qty = remaining;
    if (qty < uMin || qty * px < minUsd * 0.999) { console.log('skip', sym, '+', pct, '% — rung', qty, 'under min'); continue; }
    try {
      await X.planOrder(sym, 'profit_plan', String(px), String(qty), p.holdSide || 'long', p.marginMode || 'isolated');
      placed++;
      remaining -= qty;
      console.log('TP', sym, '+', pct, '% @', px, 'sz', qty, '≈$', (qty * px).toFixed(2));
    } catch (err) {
      failed++;
      console.log('FAIL', sym, '+', pct, '%', String(err.message || err).slice(0, 90));
    }
    await new Promise(r => setTimeout(r, 250));
  }
}
console.log('rungs placed', placed, '| pos_profit re-armed', moved, '| failed', failed);
