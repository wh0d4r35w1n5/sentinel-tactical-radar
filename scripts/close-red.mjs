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
for (const s of ['CUSDT', 'ASTERUSDT']) {
  try { console.log(s, JSON.stringify(await X.closePosition(s, 'short')).slice(0, 200)); }
  catch (e) { console.log(s, 'ERR', String(e?.message || e).slice(0, 160)); }
}
