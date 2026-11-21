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
for (const f of (fills || []).filter((x) => x.symbol === 'XAUUSDT').slice(-6))
  console.log('XAU fill:', JSON.stringify(f).slice(0, 260));
const g = JSON.parse(fs.readFileSync('/opt/sentinel/api/liq-guard.json', 'utf8'));
console.log('guard log tail:');
try {
  const t = fs.readFileSync('/opt/sentinel/logs/liq-guard.log', 'utf8').trim().split('\n').slice(-15);
  for (const l of t) console.log(l);
} catch (e) { console.log('log read:', String(e).slice(0, 100)); }
