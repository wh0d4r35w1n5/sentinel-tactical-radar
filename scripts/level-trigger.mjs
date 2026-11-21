// level-trigger.mjs — fires openRiskEntry when mark touches retest level.
// Level-entry doctrine: fills only AT the level, via the real risk rail.
import { makeExchange } from './exchange/index.mjs';
import { openRiskEntry } from './risk-entry.mjs';
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.SENTINEL_EXEC = 'live'; process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_LIVE = '1'; process.env.SENTINEL_OPEN_SEASON = '1';
process.env.SENTINEL_DEPLOY_ALL = '1';

const X = makeExchange(process.env);
X.setPosMode('hedge');
const cm = await X.contractMap();

const DEADLINE = Date.now() + 6 * 3600e3;
const arms = [
  { symbol: 'BLESSUSDT', dir: 'SHORT', level: 0.00900, strategy: 'Liquidity Sweep',
    slPct: 0.028, tps: [[0.035, 50], [0.065, 30], [0.095, 20]] },
  { symbol: 'ARIAUSDT',  dir: 'SHORT', level: 0.203,   strategy: 'Liquidity Sweep',
    slPct: 0.040, tps: [[0.045, 50], [0.080, 30], [0.110, 20]] },
];
const hit = (arm, px) => arm.dir === 'LONG' ? px <= arm.level : px >= arm.level;

while (Date.now() < DEADLINE && arms.length) {
  for (let i = arms.length - 1; i >= 0; i--) {
    const a = arms[i];
    try {
      const tk = await X.ticker(a.symbol);
      const px = +((Array.isArray(tk) ? tk[0] : tk)?.lastPr || 0);
      if (!(px > 0)) continue;
      if (!hit(a, px)) { process.stdout.write(`${a.symbol}@${px} `); continue; }
      const slPx = a.dir === 'LONG' ? px * (1 - a.slPct) : px * (1 + a.slPct);
      const tps = a.tps.map(([o, p]) => ({ px: +(a.dir === 'LONG' ? px * (1 + o) : px * (1 - o)).toPrecision(8), pct: p }));
      const res = await openRiskEntry(X, {
        symbol: a.symbol, direction: a.dir, strategy: a.strategy,
        refEntry: px, setup: true, slPx, absTps: tps, notionalUsd: 60, mode: 'market',
        setupId: 'level-trigger-2026-11-14',
        note: 'level-fill at retest; operator deploy-all order',
      }, cm[a.symbol], { riskScale: 1 });
      console.log(`\nFILLED ${a.symbol} ${a.dir} @ ${px}:`, JSON.stringify(res).slice(0, 200));
      arms.splice(i, 1);
    } catch (e) {
      const msg = String(e?.message || e);
      console.log(`\n${a.symbol} trigger refused: ${msg.slice(0, 160)}`);
      arms.splice(i, 1);
    }
  }
  await new Promise(r => setTimeout(r, 15000));
}
console.log('\ntrigger done');
