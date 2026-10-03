// exchange/index.mjs — exchange factory. SENTINEL_EXCHANGE selects the driver;
// both adapters return the same Bitget-shaped interface so the executor,
// journal, and stats code are exchange-agnostic.
//
//   SENTINEL_EXCHANGE=bitget  (default — current behavior)
//   SENTINEL_EXCHANGE=bybit   (Bybit V5; SENTINEL_EXEC picks the environment —
//                               demo/testnet/live, each with its own host + keys)
//
// Bybit credentials (NEVER commit real values):
//   BYBIT_DEMO_API_KEY / BYBIT_DEMO_API_SECRET  — created in demo.bybit.com
//   BYBIT_API_KEY / BYBIT_API_SECRET            — live env only
//   BYBIT_RECV_WINDOW (default 5000), BYBIT_ACCOUNT_TYPE (default UNIFIED)
import { makeBitget } from './bitget.mjs';
import { makeBybit } from './bybit.mjs';

export function makeExchange(env = process.env) {
  const mode = (env.SENTINEL_EXEC || 'off').toLowerCase();
  const name = (env.SENTINEL_EXCHANGE || 'bitget').toLowerCase();

  if (name === 'bybit') {
    // An unset/typo'd SENTINEL_EXEC used to fall through to the MAINNET host
    // with mainnet keys. Demand an explicit environment instead.
    if (!['demo', 'testnet', 'live'].includes(mode))
      throw new Error('bybit refused: SENTINEL_EXEC must be demo|testnet|live (got ' +
        JSON.stringify(env.SENTINEL_EXEC ?? null) + ') — not defaulting to a live host');
    // Three DISJOINT credential sets. testnet keys are minted on
    // testnet.bybit.com and are rejected by both the demo and mainnet hosts.
    //   demo    -> api-demo.bybit.com    (no isolated margin at all)
    //   testnet -> api-testnet.bybit.com (isolated margin works)
    //   live    -> api.bybit.com
    const pick = (demoK, testnetK, liveK) =>
      mode === 'demo' ? (env[demoK] || env[liveK] || '')
        : mode === 'testnet' ? (env[testnetK] || '')
        : (env[liveK] || '');
    const key = pick('BYBIT_DEMO_API_KEY', 'BYBIT_TESTNET_API_KEY', 'BYBIT_API_KEY');
    const secret = pick('BYBIT_DEMO_API_SECRET', 'BYBIT_TESTNET_API_SECRET', 'BYBIT_API_SECRET');
    const host = env.BYBIT_API_HOST ||
      (mode === 'demo' ? 'https://api-demo.bybit.com'
        : mode === 'testnet' ? 'https://api-testnet.bybit.com'
        : 'https://api.bybit.com');
    // Mode and host must agree. Refuse every mismatch up front: pointing LIVE
    // keys at the wrong environment is the dangerous direction, and it should
    // never be discovered from an exchange response.
    if (mode === 'demo' && !/demo/.test(host))
      throw new Error('bybit demo mode refused: host is not a demo host (got ' + host + ')');
    if (mode === 'testnet' && !/testnet/.test(host))
      throw new Error('bybit testnet mode refused: host is not testnet (got ' + host + ')');
    if (mode === 'live' && /demo|testnet/.test(host))
      throw new Error('bybit live mode refused: host is ' + host + ' — unset BYBIT_API_HOST');
    if (!key || !secret)
      throw new Error('bybit ' + mode + ' mode refused: no credentials (need BYBIT_' +
        (mode === 'demo' ? 'DEMO' : mode === 'testnet' ? 'TESTNET' : '') +
        '_API_KEY and _API_SECRET)');
    return makeBybit({ key, secret, mode, recvWindow: env.BYBIT_RECV_WINDOW || '5000', host });
  }

  // default: bitget — identical wiring to pre-refactor behavior
  // (exec uses BITGET_DEMO_PASSPHRASE / BITGET_PASSPHRASE)
  const key = mode === 'demo'
    ? (env.BITGET_DEMO_API_KEY || env.BITGET_API_KEY || '')
    : (env.BITGET_API_KEY || '');
  const secret = mode === 'demo'
    ? (env.BITGET_DEMO_API_SECRET || env.BITGET_API_SECRET || '')
    : (env.BITGET_API_SECRET || '');
  const pass = mode === 'demo'
    ? (env.BITGET_DEMO_PASSPHRASE || env.BITGET_PASSPHRASE || '')
    : (env.BITGET_PASSPHRASE || '');
  return makeBitget({ key, secret, pass, mode });
}
