// Bitget Wallet OpenAPI adapter — the engine under the app'S "Onchain" tab.
// Real DEX swaps aggregated across Jupiter/1inch/0x on sol/base/eth/bnb/…
// NOT the CEX futures rail: these are unlevered spot swaps settling to a
// Bitget Wallet address (fromAddress). Leverage/liquidation semantics do not
// apply — slippage, MEV, and rug risk replace them.
//
// Auth: every request carries x-api-key + x-api-timestamp + x-api-signature
// (HMAC-SHA256 of a canonical JSON payload, keyed by the API secret — secret
// never goes on the wire). Keys mint at https://portal-web3.bitget.com.
//
// Dormant until creds exist: reads BGW_API_KEY / BGW_API_SECRET /
// BGW_WALLET_ADDRESS from env (loaded via ./load-env.mjs by callers).
// onchainReady() is the single gate the executor checks before touching this.

import crypto from 'node:crypto';

const HOST = process.env.BGW_HOST || 'https://bopenapi.bgwapi.io';
const TF = () => AbortSignal.timeout(12000);

export const onchainReady = () =>
  !!(process.env.BGW_API_KEY && process.env.BGW_API_SECRET && process.env.BGW_WALLET_ADDRESS);

// Canonical sign string: flat JSON object containing apiPath (path without
// query), the raw request body string, query params, and the auth headers —
// keys sorted alphabetically. Signed HMAC-SHA256(secret) -> base64.
function sign(apiPath, bodyStr, query = {}) {
  const ts = String(Date.now());
  const content = {
    apiPath,
    body: bodyStr,
    ...query,
    'x-api-key': process.env.BGW_API_KEY,
    'x-api-timestamp': ts,
  };
  const canon = JSON.stringify(
    Object.keys(content).sort().reduce((o, k) => ((o[k] = content[k]), o), {})
  );
  const signature = crypto
    .createHmac('sha256', process.env.BGW_API_SECRET)
    .update(canon)
    .digest('base64');
  return { 'x-api-key': process.env.BGW_API_KEY, 'x-api-timestamp': ts, 'x-api-signature': signature };
}

async function api(apiPath, body = {}, query = {}) {
  if (!onchainReady()) throw new Error('onchain lane dormant — BGW creds unset');
  const bodyStr = JSON.stringify(body);
  const qs = Object.keys(query).length
    ? '?' + new URLSearchParams(query).toString()
    : '';
  const res = await fetch(`${HOST}${apiPath}${qs}`, {
    method: 'POST',
    signal: TF(),
    headers: { 'Content-Type': 'application/json', ...sign(apiPath, bodyStr, query) },
    body: bodyStr,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.status !== 0 && j.status !== undefined))
    throw new Error(`bgw ${apiPath} http ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.data ?? j;
}

// ---- Markets (discovery support — the scanner prefers keyless feeds) ----
export const tokenInfo = (chain, contract) =>
  api('/bgw-pro/market/v3/coin/getBaseInfo', { chain, contract });

export const topRank = (params = {}) =>
  api('/bgw-pro/market/v3/topRank/detail', params);

// ---- Account ----
export const balances = (address = process.env.BGW_WALLET_ADDRESS, chains = ['sol']) =>
  api('/bgw-pro/wallet/v1/account/balancesV3', { address, chains });

// ---- Order-mode swaps ----
export const swapPrice = ({ fromChain, fromContract, fromAmount, toChain, toContract }) =>
  api('/bgw-pro/swapx/order/getSwapPrice', {
    fromChain, fromContract, fromAmount, toChain, toContract,
    fromAddress: process.env.BGW_WALLET_ADDRESS,
  });

export const swapOrder = (params) =>
  api('/bgw-pro/swapx/order/makeSwapOrder', {
    ...params,
    fromAddress: process.env.BGW_WALLET_ADDRESS,
    toAddress: params.toAddress || process.env.BGW_WALLET_ADDRESS,
  });

export const orderStatus = (params) =>
  api('/bgw-pro/swapx/order/getOrderInfo', params);

export default { onchainReady, tokenInfo, topRank, balances, swapPrice, swapOrder, orderStatus };
