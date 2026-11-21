// retighten-tp.mjs — one-off (operator order 2026-11-02, Beau): every open
// Bitget position carrying ONE whole-position pos_profit far from entry gets
// it moved to the nearest evidence-fit rung (state/rr-config.json absPct)
// ABOVE the current mark (longs) / BELOW (shorts). Place-first, then cancel
// the old TP, so the position is never uncovered. Stops are untouched.
// Usage: cd /opt/sentinel && SENTINEL_EXCHANGE=bitget SENTINEL_EXEC=live node /tmp/retighten-tp.mjs [--dry]
import fs from 'node:fs';
import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';

const DRY = process.argv.includes('--dry');
const X = makeExchange({ ...process.env, SENTINEL_EXCHANGE: 'bitget', SENTINEL_EXEC: 'live' });
const rr = JSON.parse(fs.readFileSync('/opt/sentinel/state/rr-config.json', 'utf8'));
const rungs = (rr.absPct || []).map(Number).filter((x) => x > 0).sort((a, b) => a - b);
if (!rungs.length) throw new Error('rr-config has no absPct rungs');
const fracLen = (s) => (String(s).split('.')[1] || '').length;
const cm = await X.contractMap().catch(() => ({}));
const pos = (await X.getPos()).filter((p) => +p.total > 0);
console.log(`${pos.length} open positions; rungs ${rungs.join('/')}%`);
for (const p of pos) {
  const entry = +p.openPriceAvg;
  const long = p.holdSide === 'long';
  const tk = await X.ticker(p.symbol);
  const mark = +(Array.isArray(tk) ? tk[0]?.markPrice ?? tk[0]?.lastPr : tk?.markPrice ?? tk?.lastPr);
  const plans = await X.getPlans(p.symbol);
  const tps = plans.filter((r) => /^(pos_profit|profit_plan)$/.test(r.planType || ''));
  const c = cm[p.symbol] || {};
  const dec = Number.isFinite(+c.pricePlace) ? +c.pricePlace : Math.max(fracLen(p.openPriceAvg), fracLen(tps[0]?.triggerPrice || ''));
  const oldPct = tps.length ? ((long ? +tps[0].triggerPrice - entry : entry - +tps[0].triggerPrice) / entry) * 100 : null;
  // nearest rung that clears the mark by >=0.05% (Bitget rejects TP at/under mark)
  const markPct = ((long ? mark - entry : entry - mark) / entry) * 100;
  const rung = rungs.find((r) => r > markPct + 0.05) ?? null;
  const tag = `${p.symbol} ${p.holdSide} entry ${entry} mark ${mark} (${markPct.toFixed(2)}%) old TP ${tps.length ? `${tps[0].triggerPrice} (+${oldPct.toFixed(2)}%)` : 'none'}`;
  if (tps.length > 1) { console.log(`${tag} — already laddered (${tps.length} legs), skip`); continue; }
  if (rung == null) { console.log(`${tag} — mark already past the top rung, leave for the ratchet`); continue; }
  if (oldPct != null && Math.abs(oldPct - rung) < 0.02) { console.log(`${tag} — already at rung ${rung}%`); continue; }
  const px = (long ? Math.ceil(entry * (1 + rung / 100) * 10 ** dec) : Math.floor(entry * (1 - rung / 100) * 10 ** dec)) / 10 ** dec;
  console.log(`${tag} -> new TP ${px.toFixed(dec)} (+${rung}%)${DRY ? ' [dry]' : ''}`);
  if (DRY) continue;
  if (tps.length) {
    // Bitget allows only one pos_profit per position: cancel then place,
    // with the stop (pos_loss) left armed throughout
    const old = tps[0];
    await X.cancelPlanOrders(p.symbol, old.planType, [String(old.orderId || old.planId || old.id)]);
  }
  try {
    await X.planOrder(p.symbol, 'pos_profit', String(px.toFixed(dec)), '0', p.holdSide, p.marginMode);
    console.log(`  placed`);
  } catch (e) {
    console.log(`  PLACE FAILED (${e.message.slice(0, 120)}) — restoring old TP`);
    if (tps.length) await X.planOrder(p.symbol, 'pos_profit', String(tps[0].triggerPrice), '0', p.holdSide, p.marginMode).catch((e2) => console.log(`  restore failed: ${e2.message.slice(0, 120)}`));
  }
}
