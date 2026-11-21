// check-balances.mjs — one-shot read-only audit: where is the money?
// Prints USDT balances across futures / spot / funding wallets.
// Runs on the VPS: node /opt/sentinel/scripts/check-balances.mjs
import crypto from 'node:crypto';
import './load-env.mjs';

const HOST = 'https://api.bitget.com';
const key = process.env.BITGET_API_KEY;
const secret = process.env.BITGET_API_SECRET;
const pass = process.env.BITGET_API_PASSPHRASE || process.env.BITGET_PASSPHRASE;
if (!key || !secret || !pass) {
  console.error('missing BITGET_API_* creds in env');
  process.exit(1);
}

function sign(method, reqPath, qs, bodyStr) {
  const ts = String(Date.now());
  const pre = ts + method.toUpperCase() + reqPath + (qs ? '?' + qs : '') + (bodyStr || '');
  return {
    'ACCESS-KEY': key,
    'ACCESS-SIGN': crypto.createHmac('sha256', secret).update(pre).digest('base64'),
    'ACCESS-PASSPHRASE': pass,
    'ACCESS-TIMESTAMP': ts,
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
}

async function api(method, reqPath, qs = '') {
  const res = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
    method,
    headers: sign(method, reqPath, qs, ''),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && j.code !== '00000'))
    throw new Error(`${reqPath} -> ${j.code || res.status} ${j.msg || ''}`);
  return j.data;
}

// USDT-M futures account
try {
  const rows = await api('GET', '/api/v2/mix/account/accounts', 'productType=USDT-FUTURES');
  const acc = (rows || []).find((a) => a.marginCoin === 'USDT') || {};
  console.log('FUTURES (USDT-M): equity=%s available=%s', acc.usdtEquity ?? acc.equity, acc.available);
} catch (e) {
  console.log('FUTURES (USDT-M):', e.message);
}

// spot wallet
try {
  const assets = await api('GET', '/api/v2/spot/account/assets');
  const usdt = (assets || []).find((a) => a.coin === 'USDT');
  if (usdt) console.log('SPOT: available=%s frozen=%s', usdt.available, usdt.frozen);
  else console.log('SPOT: no USDT row (0 balance or perms)');
} catch (e) {
  console.log('SPOT:', e.message);
}

// funding/p2p account
try {
  const assets = await api('GET', '/api/v2/account/funding-assets');
  const usdt = (assets || []).find((a) => a.coin === 'USDT');
  if (usdt) console.log('FUNDING: available=%s frozen=%s', usdt.available, usdt.frozen);
  else console.log('FUNDING: no USDT row (0 balance or perms)');
} catch (e) {
  console.log('FUNDING:', e.message);
}
