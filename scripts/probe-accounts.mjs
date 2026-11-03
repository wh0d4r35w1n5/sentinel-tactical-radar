// one-off: dump all Bitget account-group balances (futures/spot/funding/earn)
// via raw signed v2 calls — used to size the onchain purse transfer.
import './load-env.mjs';
import crypto from 'node:crypto';

const ts = () => Date.now().toString();
const hdr = (method, p, body = '') => ({
  'ACCESS-KEY': process.env.BITGET_API_KEY,
  'ACCESS-SIGN': crypto.createHmac('sha256', process.env.BITGET_API_SECRET).update(ts() + method + p + body).digest('base64'),
  'ACCESS-TIMESTAMP': ts(),
  'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE,
});
const H = hdr; // note: timestamp+sign must pair — regenerate per request
const get = async (p) => {
  const t = Date.now().toString();
  const s = crypto.createHmac('sha256', process.env.BITGET_API_SECRET).update(t + 'GET' + p).digest('base64');
  const r = await fetch('https://api.bitget.com' + p, {
    headers: { 'ACCESS-KEY': process.env.BITGET_API_KEY, 'ACCESS-SIGN': s, 'ACCESS-TIMESTAMP': t, 'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE },
  });
  return r.json();
};

const all = await get('/api/v2/account/all-account-balance');
console.log('ALL-ACCOUNTS:', JSON.stringify(all.data || all).slice(0, 800));
