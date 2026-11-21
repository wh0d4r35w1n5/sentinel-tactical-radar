// protect-eth.mjs — one-shot: arm SL + TP ladder on the live ETHUSDT position,
// clamping the trigger safely BELOW the live mark (40808 = trigger above/too
// near mark for a long) and above liquidation. Prints full API errors.
import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';

const X = makeExchange({ ...process.env, SENTINEL_EXCHANGE: 'bitget', SENTINEL_EXEC: 'live' });
const SYM = 'ETHUSDT';

const cm = await X.contractMap().catch(() => ({}));
const c = cm[SYM] || {};
const dec = Number.isFinite(+c.pricePlace) ? +c.pricePlace : 2;
const sizeDec = Number.isFinite(+c.sizePlace) ? +c.sizePlace : 2;
const tick = 10 ** -dec;
const floorT = (x) => Math.floor(x * 10 ** dec) / 10 ** dec;
const ceilT = (x) => Math.ceil(x * 10 ** dec) / 10 ** dec;

const pos = (await X.getPos().catch((e) => { console.log('getPos ERR', e.message); process.exit(1); }))
  .find((p) => p.symbol === SYM && +p.total > 0);
if (!pos) { console.log('no open ETHUSDT position'); process.exit(0); }

const entry = +pos.openPriceAvg;
const liq = +pos.liquidationPrice || 0;
const size = +pos.total;
const upl = +pos.unrealizedPL || 0;
const mark = entry + upl / size;
const side = pos.holdSide;
const long = side === 'long';
console.log({ entry, liq, size, upl, mark, marginMode: pos.marginMode, dec, sizeDec });

const rows = await X.getPlans(SYM).catch((e) => { console.log('getPlans ERR', e.message); return []; });
console.log('existing plans:', rows.map((r) => `${r.planType}@${r.triggerPrice} size=${r.size ?? 'ALL'}`).join(' | ') || 'NONE');

// ---- desired SL from the watcher's band rule, then clamped to the live mark
const liqPct = liq > 0 ? (Math.abs(entry - liq) / entry) * 100 : 5;
let stopPct = Math.max(1.2, Math.min(liqPct * 0.7, 5));
if (stopPct >= liqPct * 0.8) stopPct = Math.max(liqPct * 0.75, 0.05);
let want = long ? ceilT(entry * (1 - stopPct / 100)) : floorT(entry * (1 + stopPct / 100));
// mark-aware clamp: trigger must clear the mark by a margin (long: below it)
const clearMark = long ? floorT(mark * (1 - 0.0015)) : ceilT(mark * (1 + 0.0015));
want = long ? Math.min(want, clearMark) : Math.max(want, clearMark);
// ...but never on the wrong side of liquidation
if (liq > 0) want = long ? Math.max(want, ceilT(liq * 1.0005)) : Math.min(want, floorT(liq * 0.9995));
console.log({ stopPct, slTarget: want });

// ---- place SL (skip if a valid one already exists)
const hasLoss = rows.filter((r) => /loss|stop|moving/i.test(r.planType || ''));
if (!hasLoss.length) {
  for (const cand of [want, long ? floorT(mark * (1 - 0.001)) : ceilT(mark * (1 + 0.001))]) {
    if (liq > 0 && (long ? cand <= liq : cand >= liq)) continue;
    try {
      await X.planOrder(SYM, 'pos_loss', String(cand), '0', side, pos.marginMode);
      console.log('SL PLACED @', cand);
      break;
    } catch (e) {
      console.log('SL FAIL @', cand, '->', e.message);
    }
  }
} else {
  console.log('SL already exists:', hasLoss.map((r) => `${r.planType}@${r.triggerPrice}`).join(', '));
}

// ---- TP ladder: 2x-stop grid @ 2/4/7R, alloc 15/25/45 (moon 15% uncovered)
const base = Math.max(2 * stopPct, 2);
const alloc = [0.15, 0.25, 0.45], mults = [2, 4, 7];
const sp = 10 ** sizeDec;
const cum = [0, 0.15, 0.4, 0.85];
const profits = rows.filter((r) => /^profit_plan$|^pos_profit$/.test(r.planType || ''));
let placedTp = 0;
for (let i = 0; i < mults.length; i++) {
  const px = long
    ? +(entry * (1 + (base * mults[i]) / 100)).toFixed(dec)
    : +(entry * (1 - (base * mults[i]) / 100)).toFixed(dec);
  const qty = (Math.floor(size * cum[i + 1] * sp) - Math.floor(size * cum[i] * sp)) / sp;
  const clears = mark <= 0 || (long ? px > mark * 1.0005 : px < mark * 0.9995);
  const dup = profits.some((r) => Math.abs(+r.triggerPrice - px) <= tick);
  if (qty <= 0 || dup) { console.log(`TP skip ${px} qty=${qty} dup=${dup}`); continue; }
  if (!clears) { console.log(`TP skip ${px} — does not clear mark ${mark}`); continue; }
  try {
    await X.planOrder(SYM, 'profit_plan', String(px), String(qty), side, pos.marginMode);
    placedTp++;
    console.log('TP PLACED', px, 'qty', qty);
  } catch (e) {
    console.log('TP FAIL', px, '->', e.message);
  }
}

const after = await X.getPlans(SYM).catch(() => []);
console.log('FINAL BOOK:', after.map((r) => `${r.planType}@${r.triggerPrice} size=${r.size ?? 'ALL'}`).join(' | ') || 'EMPTY');
process.exit(0);
