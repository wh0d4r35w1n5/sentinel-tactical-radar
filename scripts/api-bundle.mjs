// api-bundle.mjs — aggregate the dashboard's 49-file artifact fan-out into a
// single api/dashboard.json so remote viewers fetch ONE file (~0.5s RTT)
// instead of 49 (~4s of connection waves). Runs at the tail of each rapid
// cycle, after every writer has settled. Mirrors index.html's fetch list —
// keep them in sync. signal-archive (14MB) stays out: nobody live-fetches it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const FILES = [
  'market-scanner', 'coin-detail', 'signal-ledger', 'prices', 'health',
  'funding', 'sentiment', 'signal-eval', 'news', 'hypotheses', 'correlation',
  'benchmark', 'live-ledger', 'god', 'volcore', 'confluence', 'breakouts',
  'einstein', 'mtf', 'social', 'trades-taken', 'sqn-report', 'thoughts',
  'liq-guard', 'gate-stats', 'freqtrade-bench', 'mae-mfe', 'rr-optimize',
  'rr-backtest', 'integrity', 'alltime-stats', 'equity-bridge', 'pimp-war',
  'onchain-lane', 'shadow-ab', 'eval-independence', 'edge-attribution',
  'ledger-recon', 'failover-audit', 'validator-report', 'strategy-policy',
  'autonomous-pnl', 'reject-markout', 'libedge', 'live-plan', 'bitget-watch',
  'markouts', 'onchain-hot', 'chain-custody',
];

const data = {};
let n = 0;
for (const name of FILES) {
  try { data[name] = JSON.parse(fs.readFileSync(path.join(API, `${name}.json`), 'utf8')); n++; }
  catch { data[name] = null; }
}
const tmp = path.join(API, 'dashboard.json.tmp');
fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), updatedAt: new Date().toISOString(), n, data }));
fs.renameSync(tmp, path.join(API, 'dashboard.json'));
console.log(`dashboard.json — ${n}/${FILES.length} artifacts bundled`);
