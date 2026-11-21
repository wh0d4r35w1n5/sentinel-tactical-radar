import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';
const X = makeExchange({ SENTINEL_EXCHANGE:'bitget', SENTINEL_EXEC:'live', ...process.env });
for (const sym of process.argv.slice(2)) {
  try { console.log(sym, 'closing…', JSON.stringify(await X.closePosition(sym, 'short')).slice(0,150)); }
  catch (e) { console.log(sym, 'ERR', e.message.slice(0,120)); }
}
