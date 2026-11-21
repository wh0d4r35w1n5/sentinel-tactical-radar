import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';
import fs from 'node:fs';
const X = makeExchange({ ...process.env, SENTINEL_EXCHANGE: 'bitget', SENTINEL_EXEC: 'live' });
const acct = await X.getAccount();
console.log('REST unionEquity:', acct.unionEquity, '| equity:', acct.equity, '| assetUsd:', acct.assetUsd, '| avail:', acct.available);
const w = JSON.parse(fs.readFileSync('/opt/sentinel/api/wealth-live.json', 'utf8'));
console.log('WW   totalUsd:', w.totalUsd, '| ageMs:', w.ageMs, '| futEq:', w.futures.equityUsd, '| assetUsd:', w.futures.assetUsd, '| spot:', w.spot.totalUsd, '| sol:', w.solana?.totalUsd);
process.exit(0);
