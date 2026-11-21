import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_EXEC = 'live';
const { makeExchange } = await import('/opt/sentinel/scripts/exchange/index.mjs');
const X = makeExchange(process.env);
const [acct, pos] = await Promise.all([X.getAccount(), X.getPos()]);
console.log('EQ', (+acct.equity).toFixed(2), 'AVAIL', (+acct.available).toFixed(2));
for (const p of (pos || []).filter((x) => +x.total > 0)) {
  const t = await X.ticker(p.symbol);
  const r = Array.isArray(t) ? t[0] : t;
  const mk = +(r.lastPr || r.lastPrice || 0);
  const fav = p.holdSide === 'long'
    ? (mk - +p.openPriceAvg) / +p.openPriceAvg * 100
    : (+p.openPriceAvg - mk) / +p.openPriceAvg * 100;
  console.log(
    p.symbol, p.holdSide, p.total, '@' + (+p.openPriceAvg).toFixed(3),
    'mk', mk, 'upl', (+p.unrealizedPL).toFixed(3),
    'fav', fav.toFixed(2) + '%', 'lev', p.leverage + 'x',
    'liq', (+p.liquidationPrice).toFixed(2)
  );
}
