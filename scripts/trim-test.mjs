// trim-test.mjs — LIVE test of the trim -> kick -> instant re-arm chain.
// Closes ONE contract-minimum clip on ETHUSDT (same close path liq-guard's
// fire zone uses: market close with the position's real margin mode), then
// writes state/bw-kick exactly like kickWatcher(). Verifies that the
// watcher re-arms the staggered TP ladder to the new size almost instantly.
import fs from 'node:fs';
import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';

const X = makeExchange({ ...process.env, SENTINEL_EXCHANGE: 'bitget', SENTINEL_EXEC: 'live' });
const SYM = 'ETHUSDT';

const pos = (await X.getPos().catch((e) => { console.log('getPos ERR', e.message); process.exit(1); }))
  .find((p) => p.symbol === SYM && +p.total > 0);
if (!pos) { console.log('no open ETHUSDT position'); process.exit(0); }

const size = +pos.total;
const upl = +pos.unrealizedPL;
const cm = await X.contractMap().catch(() => ({}));
const minClip = +(cm[SYM]?.minTradeNum || 0.01);
console.log('BEFORE:', { size, entry: +pos.openPriceAvg, liq: +pos.liquidationPrice, upl, minClip });
if (size <= minClip * 2) { console.log('too small to trim — abort'); process.exit(1); }

const pm = await X.getPosMode(SYM).catch(() => null);
if (pm) X.setPosMode(pm);
console.log('posMode:', pm || 'unknown (adapter default)');

const closeSide = pos.holdSide === 'long' ? 'sell' : 'buy';
const extra = { marginMode: pos.marginMode === 'crossed' ? 'crossed' : 'isolated' };
try {
  const r = await X.marketOrder(SYM, closeSide, String(minClip), 'close', extra);
  console.log('TRIM FILLED:', JSON.stringify(r).slice(0, 220));
} catch (e) {
  console.log('TRIM FAILED:', e.message);
  process.exit(1);
}

// identical write to liq-guard's kickWatcher()
fs.writeFileSync('/opt/sentinel/state/bw-kick', String(Date.now()));
console.log('KICK WRITTEN at', new Date().toISOString());

const pos2 = (await X.getPos().catch(() => [])).find((p) => p.symbol === SYM && +p.total > 0);
console.log('AFTER:', { size: pos2 ? +pos2.total : 0, liq: pos2 ? +pos2.liquidationPrice : null });
const plans = await X.getPlans(SYM).catch(() => []);
console.log('BOOK AT KICK TIME:', plans.map((r) => `${r.planType}@${r.triggerPrice} sz=${r.size ?? 'ALL'}`).join(' | ') || 'EMPTY');
process.exit(0);
