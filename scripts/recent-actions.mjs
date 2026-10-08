import fs from 'node:fs';
const l = JSON.parse(fs.readFileSync('/opt/sentinel/api/live-ledger.json', 'utf8'));
for (const a of (l.actions || []).slice(-15)) console.log(a);
console.log('==== trims ====');
try {
  const g = JSON.parse(fs.readFileSync('/opt/sentinel/api/liq-guard.json', 'utf8'));
  for (const t of (g.trims || []).slice(-8)) console.log(JSON.stringify(t));
  for (const x of (g.actions || g.events || []).slice(-8)) console.log(JSON.stringify(x));
} catch (e) { console.log('guard api:', String(e).slice(0, 80)); }
console.log('==== last fills ====');
try {
  const f = JSON.parse(fs.readFileSync('/opt/sentinel/state/demo-fills.json', 'utf8'));
  const arr = Array.isArray(f) ? f : (f.fills || []);
  for (const x of arr.slice(-8)) console.log(JSON.stringify(x).slice(0, 220));
} catch (e) { console.log('fills:', String(e).slice(0, 80)); }
