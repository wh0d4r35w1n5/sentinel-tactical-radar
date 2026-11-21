import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync('/opt/sentinel/api/market-scanner.json', 'utf8'));
const sigs = s.signals || [];
console.log('ts', s.ts || s.at || '');
for (const x of sigs) {
  const dir = x.direction || x.side || '';
  if (!/long|buy/i.test(dir)) continue;
  console.log(x.symbol, dir, 'score', x.score ?? x.tradeScore ?? '?', x.strategy || '', 'tgt', x.targetPct ?? '', 'stop', x.stopPct ?? '');
}
const rej = s.rejects || s.rejected || [];
const counts = {};
for (const r of rej) { const k = r.reason || r; counts[k] = (counts[k] || 0) + 1; }
console.log('--- rejects:', JSON.stringify(counts));
