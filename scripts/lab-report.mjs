#!/usr/bin/env node
// Demo reporting only. Queueing a message is not proof of Telegram delivery.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8')); }
  catch { return null; }
};
const led = read('api/live-ledger.json'), all = read('api/alltime-stats.json');
const heartbeat = read('state/rapid-heartbeat.json');
const book = all?.books?.['bybit-demo'];
const num = (n, decimals = 2) => n != null && Number.isFinite(+n) ? (+n).toFixed(decimals) : 'unknown';
const issues = [];
const ageSec = (time) => {
  const ts = typeof time === 'number' ? time : Date.parse(time);
  return Number.isFinite(ts) ? Math.round((Date.now() - ts) / 1000) : null;
};
const ledgerAge = ageSec(led?.refreshedAt), statsAge = ageSec(all?.refreshedAt);
if (led?.mode !== 'demo' || led?.exchange !== 'bybit') issues.push('ledger does not identify Bybit demo');
if (ledgerAge == null || ledgerAge > 300) issues.push(`ledger stale (${ledgerAge ?? 'unknown'}s)`);
if (statsAge == null || statsAge > 300) issues.push(`stats stale (${statsAge ?? 'unknown'}s)`);
if (ageSec(heartbeat?.ts) == null || ageSec(heartbeat?.ts) > 300) issues.push('execution heartbeat stale');
if (heartbeat?.consecFails) issues.push(`${heartbeat.consecFails} failed cycles`);
for (const unit of ['sentinel-rapid', 'sentinel-bitget-watch', 'sentinel-liq-guard']) {
  try { execFileSync('systemctl', ['is-active', '--quiet', unit]); }
  catch { issues.push(`${unit} inactive`); }
}
const positions = led?.positionsAfter;
const cells = Object.entries(book?.families || {})
  .filter(([name]) => name !== 'unattributed')
  .sort((a, b) => b[1].netUsd - a[1].netUsd).slice(0, 8);
const text = [
  `LAB REPORT ${new Date().toISOString().slice(0, 16)}Z — BYBIT DEMO`,
  `equity $${num(led?.equityUsd)} | positions ${positions?.length ?? 'unknown'} | data ${ledgerAge ?? 'unknown'}s old`,
  `complete research trades ${book?.episodes ?? 'unknown'} | wins ${num(book?.winRatePct, 1)}% | net $${num(book?.netUsd)} | trading fees $${num(book?.feesUsd)}`,
  `all recorded fills: net $${num(book?.recordedNetUsd)} | fees $${num(book?.recordedFeesUsd)}`,
  `research exclusions ${book?.excludedEpisodes ?? 'unknown'} (net $${num(book?.excludedNetUsd)}) | unmatched closes ${book?.unmatchedCloses ?? 'unknown'}`,
  ...cells.map(([name, c]) => `${name}: n=${c.n} net $${num(c.netUsd)} fees $${num(c.feesUsd)} mean ${num(c.meanRetPct, 3)}% of notional`),
  `unattributed complete trades: ${book?.families?.unattributed?.n ?? 0}`,
  positions?.length ? `open: ${positions.slice(0, 8).map((p) => `${p.symbol} upl $${num(p.upl)}`).join(', ')}` : 'open: flat or unavailable',
  issues.length ? `CHECK: ${issues.join('; ')}` : 'service processes active; feeds fresh',
  'Trading-fee net excludes funding and unrealized P&L. Demo results do not establish live profitability.',
].join('\n');
const report = { ts: Date.now(), text, book: 'bybit-demo', issues, delivery: 'queued', to: 'ops' };
fs.writeFileSync(path.join(ROOT, 'state/lab-report-latest.json'), JSON.stringify(report));
fs.appendFileSync(path.join(ROOT, 'state/tg-outbox.jsonl'), JSON.stringify({ ts: report.ts, to: 'ops', text }) + '\n');
console.log(text);
