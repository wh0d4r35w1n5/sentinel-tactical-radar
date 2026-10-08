import fs from 'node:fs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_EXEC = 'live';
const X = makeExchange(process.env);
const pos = (await X.getPos()).filter((p) => +p.total > 0);
for (const p of pos) {
  const pl = await X.getPlans(p.symbol).catch(() => []);
  const long = p.holdSide === 'long';
  const liq = +p.liquidationPrice || 0;
  const sl = (pl || []).filter((x) => /loss|stop|moving/i.test(x.planType || ''));
  const tp = (pl || []).filter((x) => /profit/i.test(x.planType || ''));
  const trig = sl[0] ? +sl[0].triggerPrice : 0;
  const safe = trig && liq ? (long ? trig > liq : trig < liq) : 'n/a';
  const tpQty = tp.reduce((a, x) => a + (+x.size || 0), 0);
  console.log(
    p.symbol, p.holdSide, 'sz=' + p.total,
    'liq=' + (liq || '?'), 'SL=' + (trig || 'NONE'),
    'slSafe=' + safe, 'tpLegs=' + tp.length, 'tpQty=' + tpQty
  );
}
try {
  const led = JSON.parse(fs.readFileSync('/opt/sentinel/api/live-ledger.json', 'utf8'));
  console.log('ledger errors:', JSON.stringify((led.errors || []).slice(-5)));
  console.log('manualHoldActive:', JSON.stringify(led.manualHoldActive || (led.state && led.state.manualHoldActive) || null));
} catch (e) { console.log('ledger read:', String(e).slice(0, 100)); }
