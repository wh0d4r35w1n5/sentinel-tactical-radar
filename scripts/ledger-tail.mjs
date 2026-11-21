import fs from 'node:fs';
const l = JSON.parse(fs.readFileSync('/opt/sentinel/api/live-ledger.json', 'utf8'));
console.log('actions:');
for (const a of (l.actions || []).slice(-25)) console.log(' ', a);
console.log('errors:');
for (const e of (l.errors || []).slice(-10)) console.log(' ', e);
console.log('ddPct', l.ddPct, 'equity', l.equityUsd ?? l.equity, 'halt', l.protectionHalted ?? l.halted ?? '');
