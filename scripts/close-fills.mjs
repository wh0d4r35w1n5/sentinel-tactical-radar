import fs from 'node:fs';
import { makeExchange } from '/opt/sentinel/scripts/exchange/index.mjs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_EXEC = 'live';
const X = makeExchange(process.env);
const fills = await X.getFills().catch(() => []);
const closers = (fills || []).filter((x) => /close/i.test(x.tradeSide || '') || x.profit);
for (const f of closers.slice(-15)) {
  console.log(f.symbol, f.side, f.size ?? f.baseVolume, '@', f.price,
    'profit', f.profit ?? '?', 'ts', f.ts || f.cTime || '');
}
