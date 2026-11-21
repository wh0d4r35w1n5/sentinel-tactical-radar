#!/usr/bin/env node
import fs from 'fs';
import { makeExchange } from './scripts/exchange/index.mjs';

const creds = {};
for (const line of fs.readFileSync('C:/Users/beaue/sentinel-live/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) creds[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
for (const k of Object.keys(creds)) process.env[k] = creds[k];

const X = makeExchange(process.env);
const pairs = [
  {sym:'XRPUSDT', mark:1.5453, stopPct:1.85},
  {sym:'ETHUSDT', mark:2758.61, stopPct:2.61},
  {sym:'HYPEUSDT', mark:91.14, stopPct:1.5},
  {sym:'SOLUSDT', mark:122.75, stopPct:1.98},
  {sym:'BTCUSDT', mark:86898.8, stopPct:2.52},
];
const equity = 65;
const riskUsd = equity * 0.01;

for (const p of pairs) {
  const stopDist = p.mark * p.stopPct / 100;
  const size = riskUsd / stopDist;
  console.log(p.sym, 'size', size.toFixed(4), 'notional', (size*p.mark).toFixed(2));
  try {
    const r = await X.marketOrder(p.sym, 'Buy', size, 'open');
    console.log('ORDER:', JSON.stringify(r).slice(0,500));
  } catch(e) { console.log('ERROR', p.sym, e.message); }
}
