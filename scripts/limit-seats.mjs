// limit-seats.mjs — resting retest orders, exchange-visible, pre-armored
import { makeExchange } from './exchange/index.mjs';
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.SENTINEL_EXEC = 'live'; process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_LIVE = '1';
const X = makeExchange(process.env);
X.setPosMode('hedge');
const cm = await X.contractMap();

const RISK_USD = 0.8, LEV = 10;
const seats = [
  { symbol: 'BLESSUSDT', dir: 'LONG',  entry: 0.00905,  sl: 0.00885, tps: [[0.00940, 50], [0.00980, 30], [0.01020, 20]] },
  { symbol: 'ARIAUSDT',  dir: 'LONG',  entry: 0.207,    sl: 0.1985,  tps: [[0.2225, 50], [0.2315, 30], [0.2405, 20]] },
  { symbol: 'QNTUSDT',   dir: 'SHORT', entry: 146.5,    sl: 152.0,   tps: [[138.0, 50], [131.0, 30], [126.0, 20]] },
  { symbol: 'PTBUSDT',   dir: 'LONG',  entry: 0.000135, sl: 0.000128, tps: [[0.000148, 50], [0.000160, 30], [0.000170, 20]] },
];

const out = [];
for (const s of seats) {
  const r = { symbol: s.symbol, dir: s.dir, entry: s.entry };
  try {
    const c = cm[s.symbol] || {};
    const stopFrac = Math.abs(s.entry - s.sl) / s.entry;
    const notional = RISK_USD / stopFrac;
    const sizeMult = +c.sizeMult || 1, minN = +c.minTradeNum || 0;
    let size = Math.floor(notional / s.entry / sizeMult) * sizeMult;
    r.notional = +(size * s.entry).toFixed(2);
    if (size < minN) { r.skip = `size ${size} < min ${minN}`; out.push(r); continue; }
    await X.setLeverage(s.symbol, LEV, 'isolated').catch(e => { r.levErr = String(e).slice(0, 80); });
    const holdSide = s.dir === 'LONG' ? 'long' : 'short';
    const side = s.dir === 'LONG' ? 'buy' : 'sell';
    r.limit = JSON.stringify(await X.limitOrder(s.symbol, side, size, s.entry)).slice(0, 160);
    r.stop = JSON.stringify(await X.planOrder(s.symbol, 'loss_plan', s.sl, size, holdSide)).slice(0, 160);
    r.tps = [];
    for (const [px, pct] of s.tps) {
      const ts = Math.floor(size * pct / 100 / sizeMult) * sizeMult;
      if (ts >= minN) r.tps.push(JSON.stringify(await X.planOrder(s.symbol, 'profit_plan', px, ts, holdSide)).slice(0, 120));
    }
    r.ok = true;
  } catch (e) { r.error = String(e?.message || e).slice(0, 200); }
  out.push(r);
}
console.log(JSON.stringify(out, null, 1));
