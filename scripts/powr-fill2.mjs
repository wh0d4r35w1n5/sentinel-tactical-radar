import '/opt/sentinel/scripts/load-env.mjs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
const X = await makeExchange(process.env);
const fills = await X.getFills({ symbol: 'POWRUSDT', startTime: Date.now() - 6 * 3600e3, limit: 30 });
for (const f of fills) console.log(JSON.stringify(f));
