import '/opt/sentinel/scripts/load-env.mjs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
const X = await makeExchange(process.env);
const cm = await X.contractMap();
for (const s of ['COWUSDT','POWRUSDT','GUSDT','STEEMUSDT','HOTUSDT']) console.log(s, JSON.stringify(cm[s]));
