// exchange/index.mjs — exchange factory. SENTINEL_EXCHANGE selects the driver;
// both adapters return the same Bitget-shaped interface so the executor,
// journal, and stats code are exchange-agnostic.
//
//   SENTINEL_EXCHANGE=bitget  (default — current behavior)
//   SENTINEL_EXCHANGE=bybit   (Bybit V5; demo → api-demo.bybit.com)
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
    // Bybit demo trading uses keys minted inside demo.bybit.com — mainnet
    // keys on api-demo get 'invalid api key', which is the guard we want.
    // Hard fail if someone points demo mode at a mainnet host.
    const key = mode === 'demo'
      ? (env.BYBIT_DEMO_API_KEY || env.BYBIT_API_KEY || '')
      : (env.BYBIT_API_KEY || '');
    const secret = mode === 'demo'
      ? (env.BYBIT_DEMO_API_SECRET || env.BYBIT_API_SECRET || '')
      : (env.BYBIT_API_SECRET || '');
    const host = env.BYBIT_API_HOST ||
      (mode === 'demo' ? 'https://api-demo.bybit.com' : 'https://api.bybit.com');
    if (mode === 'demo' && /api\.bybit\.com/.test(host) && !/demo/.test(host))
      throw new Error('bybit demo mode refused: host is mainnet — set BYBIT_API_HOST to api-demo.bybit.com');
    if (mode === 'live' && /demo/.test(host))
      throw new Error('bybit live mode refused: host is demo — unset BYBIT_API_HOST');
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
