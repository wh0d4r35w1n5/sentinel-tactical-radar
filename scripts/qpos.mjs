import '/opt/sentinel/scripts/load-env.mjs';
process.env.SENTINEL_EXEC = 'demo';
process.env.SENTINEL_EXCHANGE = 'bybit';
const m = await import('/opt/sentinel/scripts/exchange/index.mjs');
const X = await m.makeExchange(process.env);
console.log('exchange:', X.name);
const pos = await X.getPos();
console.log('open positions:', pos.length);
for (const p of pos) {
  const ageMin = Math.round((Date.now() - +p.cTime) / 6e4);
  console.log(p.symbol, p.side, 'size', p.total, 'age', ageMin + 'm', 'upl', p.unrealizedPL, 'entry', p.openPriceAvg);
}
const acct = await X.getAccount();
console.log('equity', acct.equity, 'avail', acct.available);
