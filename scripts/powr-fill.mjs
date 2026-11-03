import '/opt/sentinel/scripts/load-env.mjs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
const X = await makeExchange(process.env);
const fills = await X.getFills({ symbol: 'POWRUSDT', startTime: Date.now() - 12 * 3600e3, limit: 20 });
for (const f of fills) console.log(f.symbol, f.side, f.price, 'x', f.size, 'fee', f.fee, f.tradeScope || '', new Date(+f.cTime).toISOString());
