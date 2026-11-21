// exchange/index.mjs — exchange factory. SENTINEL_EXCHANGE selects the driver;
// both adapters return the same Bitget-shaped interface so the executor,
// journal, and stats code are exchange-agnostic.
//
//   SENTINEL_EXCHANGE=bitget  (default — current behavior)
//
import { makeBitget } from './bitget.mjs';

export function makeExchange(env = process.env) {
  const mode = (env.SENTINEL_EXEC || 'off').toLowerCase();
  const name = (env.SENTINEL_EXCHANGE || 'bitget').toLowerCase();

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
