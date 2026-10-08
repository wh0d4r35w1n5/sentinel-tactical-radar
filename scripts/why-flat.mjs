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
const cutoff = Date.now() - 30 * 60e3;
for (const f of (fills || []).filter((x) => +(x.ts || x.cTime || 0) > cutoff))
  console.log(f.symbol, f.side, f.size ?? f.baseVolume, '@', f.price, 'profit', f.profit ?? '?', 'src', f.src || '', 't', new Date(+f.ts || +f.cTime).toISOString());
const t = await X.ticker('BTCUSDT');
const b = Array.isArray(t) ? t[0] : t;
console.log('BTC mark', b.markPrice, '24h chg', b.change24h, 'lo24', b.low24h);
