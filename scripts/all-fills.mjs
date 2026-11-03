import '/opt/sentinel/scripts/load-env.mjs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
const X = await makeExchange(process.env);
const fills = await X.getFills({ startTime: Date.now() - 45 * 60e3, limit: 50 });
for (const f of fills) console.log(new Date(+f.cTime).toISOString(), f.symbol, f.tradeSide, f.side, f.price, 'x', f.baseVolume, 'profit', f.profit, f.enterPointSource, f.tradeScope);
console.log('---count', fills.length);
