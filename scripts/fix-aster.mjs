import { makeExchange } from './exchange/index.mjs';
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.SENTINEL_EXEC = 'live'; process.env.SENTINEL_EXCHANGE = 'bitget'; process.env.SENTINEL_LIVE = '1';
const X = makeExchange(process.env); X.setPosMode('hedge');
const cm = await X.contractMap();
for (const sym of ['ASTERUSDT', 'QNTUSDT', 'ARIAUSDT']) {
  const plans = await X.getPlans(sym).catch(() => []);
  const pos = (await X.getPos()).find(p => p.symbol === sym && +p.total > 0);
  const legs = (plans || []).map(p => `${p.planType}@${p.triggerPrice}`).join(' ');
  console.log(sym, pos ? `pos ${pos.total}` : 'FLAT', legs || 'NO LEGS');
  if (pos && !(plans || []).some(p => p.planType === 'loss_plan')) {
    const tk = await X.ticker(sym); const mark = +((Array.isArray(tk) ? tk[0] : tk)?.lastPr || 0);
    const pp = cm[sym]?.pricePlace ?? 4;
    const stop = +(mark * 1.012).toFixed(pp);
    console.log('  placing stop', stop, JSON.stringify(await X.planOrder(sym, 'loss_plan', stop, +pos.total, 'short')).slice(0, 140));
  }
}
