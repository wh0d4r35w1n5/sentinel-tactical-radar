// api-bundle.mjs — aggregate the dashboard's artifact fan-out into tiered
// pre-gzipped bundles so remote viewers get first paint in one ~65KB fetch
// instead of 49 round-trips (~4s). Runs at the tail of each rapid cycle.
//   dashboard-hot.json  — artifacts driving the first viewport (~16 files)
//   dashboard-cold.json — evidence/bench/slow panels (~33 files), lazy-merged
//   *.json.gz           — served by nginx gzip_static at zero per-request CPU
// Mirrors index.html's fetch list — keep them in sync. signal-archive (14MB)
// stays out: nobody live-fetches it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const HOT = [
  'market-scanner', 'prices', 'health', 'live-ledger', 'live-plan',
  'gate-stats', 'funding', 'liq-guard', 'bitget-watch', 'integrity',
  'onchain-lane', 'chain-custody', 'signal-ledger', 'thoughts', 'god',
  'breakouts', 'onchain-trades',
];
const COLD = [
  'coin-detail', 'signal-eval', 'sentiment', 'news', 'hypotheses', 'correlation',
  'benchmark', 'volcore', 'confluence', 'einstein', 'mtf', 'social',
  'trades-taken', 'sqn-report', 'freqtrade-bench', 'mae-mfe', 'rr-optimize',
  'rr-backtest', 'alltime-stats', 'equity-bridge', 'pimp-war', 'shadow-ab',
  'eval-independence', 'edge-attribution', 'ledger-recon', 'failover-audit',
  'validator-report', 'strategy-policy', 'autonomous-pnl', 'reject-markout',
  'libedge', 'markouts', 'onchain-hot',
];

const read = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(API, `${name}.json`), 'utf8')); }
  catch { return null; }
};
const emit = (file, names) => {
  const data = {};
  let n = 0;
  for (const name of names) { data[name] = read(name); if (data[name] != null) n++; }
  const buf = Buffer.from(JSON.stringify({ ts: Date.now(), updatedAt: new Date().toISOString(), n, data }));
  const p = path.join(API, file);
  fs.writeFileSync(p + '.tmp', buf); fs.renameSync(p + '.tmp', p);
  const gz = zlib.gzipSync(buf, { level: 9 }); // offline CPU — serve pre-compressed
  fs.writeFileSync(p + '.gz.tmp', gz); fs.renameSync(p + '.gz.tmp', p + '.gz');
  return `${file} ${n}/${names.length} (${(buf.length / 1024).toFixed(0)}K→${(gz.length / 1024).toFixed(0)}Kgz)`;
};

console.log('bundle:', emit('dashboard-hot.json', HOT), '|', emit('dashboard-cold.json', COLD));
