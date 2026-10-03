#!/usr/bin/env node
// exchange/prove-isolation.mjs — acceptance test: can this venue actually run
// isolated margin, end to end, with a real position open?
//
// A cross book once traded for hours while the journal claimed isolated,
// because every path trusted an ack and inferred the mode from posted margin.
// This tool proves the VENUE, not the code's opinion of it: open a minimum-size
// position -> read the margin mode back from the exchange -> PASS only if it is
// isolated -> close and confirm flat. No sizing happens until this prints PASS.
//
// Venue support measured directly, not assumed:
//   bybit demo    -> switch-isolated 10032 "Demo trading are not supported"  (never possible)
//   bybit testnet -> switch-isolated 100028 "unified account is forbidden"   (never possible)
//   bitget demo   -> supported natively; this is the path that satisfies the mandate
//
//   SENTINEL_EXCHANGE=bitget SENTINEL_EXEC=demo     node scripts/exchange/prove-isolation.mjs [SYMBOL]
//   SENTINEL_EXCHANGE=bybit  SENTINEL_EXEC=testnet  node scripts/exchange/prove-isolation.mjs [SYMBOL]
import '../load-env.mjs'; // canonical .env loader; SENTINEL_*/EXEC_* need it or creds silently go missing
import { makeExchange } from './index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String((e && e.message) || e).replace(/^.*-> /, '').slice(0, 150);

const exName = (process.env.SENTINEL_EXCHANGE || 'bitget').toLowerCase();
const mode = (process.env.SENTINEL_EXEC || '').toLowerCase();
const SUPPORTED =
  (exName === 'bitget' && mode === 'demo') ||
  (exName === 'bybit' && mode === 'testnet');
if (!SUPPORTED) {
  console.error(
    'refusing: this venue cannot run isolated margin.\n' +
    '  bybit  + demo    -> switch-isolated returns 10032 (demo not supported)\n' +
    '  bybit  + testnet -> switch-isolated returns 100028 (unified account forbidden)\n' +
    '  bitget + demo    -> supported — use that\n' +
    'got: SENTINEL_EXCHANGE=' + exName + ' SENTINEL_EXEC=' + (mode || '(unset)'));
  process.exit(2);
}

const ex = makeExchange(process.env);
if (!ex.hasCreds) {
  console.error([
    'refusing: no credentials for ' + exName + '/' + mode + '.',
    '  bitget demo needs BITGET_DEMO_API_KEY + _API_SECRET + _PASSPHRASE',
    '  bybit  testnet needs BYBIT_TESTNET_API_KEY + _API_SECRET',
  ].join(String.fromCharCode(10)));
  process.exit(2);
}
const result = { ts: new Date().toISOString(), host: ex.host, exchange: exName, mode, symbol: null, pass: false };

const findPos = async (symbol) => {
  for (let i = 0; i < 8; i++) {
    const rows = await ex.getPos().catch(() => []);
    const r = (rows || []).find((p) => p.symbol === symbol && +p.total > 0);
    if (r) return r;
    await sleep(1000);
  }
  return null;
};
const isFlat = async (symbol) => {
  const rows = await ex.getPos().catch(() => []);
  return !(rows || []).some((p) => p.symbol === symbol && +p.total > 0);
};

// Cheapest contract that still clears the venue's minimum notional: this test
// is about margin mode, not P&L, so size it as small as the exchange allows.
let pick = null;
if (process.argv[2]) {
  const sym = process.argv[2].toUpperCase();
  const cm = await ex.contractMap();
  const c = cm[sym] || {};
  pick = {
    sym, score: +c.minTradeUSDT || 5,
    price: +(await ex.ticker(sym))[0]?.askPr || 0,
    qStep: +c.qtyStep || 0.001, minQty: +c.minTradeNum || 0.001, maxLev: c.maxLev,
  };
} else {
  const cm = await ex.contractMap();
  for (const [sym, c] of Object.entries(cm)) {
    const minNotional = +c.minTradeUSDT || 5;
    if (!pick || minNotional < pick.score) {
      const price = +(await ex.ticker(sym))[0]?.askPr || 0;
      if (price) pick = { sym, score: minNotional, price, qStep: +c.qtyStep || 0.001, minQty: +c.minTradeNum || 0.001, maxLev: c.maxLev };
    }
  }
}
if (!pick || !pick.price) { console.error('no tradable symbol found'); process.exit(2); }

// Never probe on a symbol that already carries a position: the close step below
// is blunt, and a pre-existing book (e.g. an open HYPEUSDT isolated long) would
// be flattened by a test that was only meant to prove margin mode.
const pre = (await ex.getPos().catch(() => [])).find((p) => p.symbol === pick.sym && +p.total > 0);
if (pre) {
  console.error(
    'refusing to probe ' + pick.sym + ': it already holds a position (' +
    pre.holdSide + ' ' + pre.total + ', ' + pre.marginMode + '). ' +
    'The probe closes the symbol, so it would flatten a real position.'
  );
  process.exit(2);
}

const { sym, price, qStep, minQty } = pick;
const lev = Math.min(+(process.env.SENTINEL_LEV || 10), pick.maxLev || 10);
const qty = Math.ceil(Math.max(minQty, pick.score / price) / qStep) * qStep;
result.symbol = sym;

console.log('prove-isolation @ ' + ex.host + '  (' + exName + '/' + mode + ')');
console.log('probe ' + sym + '  ask=' + price + '  qty=' + qty +
  '  notional≈$' + (qty * price).toFixed(2) + '  lev=' + lev + 'x');
// Bitget rejects orders whose posSide contradicts the account mode (40774), so
// the mode is part of what this test actually exercises — report it, don't assume.
const pm = await ex.getPosMode(sym).catch((e) => {
  console.error('refusing: could not read the account position mode (' + short(e) + '). ' +
    'Falling back to a guessed mode would place orders the venue rejects.');
  process.exit(2);
});
if (ex.setPosMode) ex.setPosMode(pm);
result.posMode = pm;
console.log('account position mode: ' + pm + '\n');

let opened = false;
try {
  await ex.setIsolated(sym);        // throws E_ISOLATION_FAILED if the switch didn't take
  await ex.setLeverage(sym, lev);
  await ex.marketOrder(sym, 'buy', qty, 'open', { refEntry: price, audUsd: +(process.env.SENTINEL_AUD_PER_USD || 0) });
  opened = true;
} catch (e) {
  console.log('OPEN FAILED: ' + short(e));
  if (e.code) console.log('  code: ' + e.code);
}

if (opened) {
  const row = await findPos(sym);
  console.log('\nposition: ' + (row
    ? 'size=' + row.total + ' avg=' + row.openPriceAvg + ' marginMode=' + row.marginMode +
      ' posIM=' + row.marginSize + ' liq=' + (row.liquidationPrice || 'n/a')
    : 'not visible on the exchange'));
  result.pass = !!row && row.marginMode === 'isolated';
  result.position = row ? { size: row.total, avgPrice: row.openPriceAvg, marginMode: row.marginMode, positionIM: row.marginSize, liqPrice: row.liquidationPrice } : null;
  console.log('\n' + (result.pass ? 'PASS — venue runs ISOLATED margin' : 'FAIL — venue ran ' + (row ? row.marginMode : 'unknown')));
  result.probe = { qty, lev, refPrice: price };
  try {
    await ex.closePosition(sym, 'long');
    console.log('probe position closed');
  } catch (e) { console.log('close failed: ' + short(e)); }
  for (let i = 0; i < 8; i++) {
    if (await isFlat(sym)) { console.log('confirmed flat'); result.flat = true; break; }
    await sleep(1000);
  }
}
console.log('\n' + JSON.stringify(result, null, 1));
process.exit(result.pass ? 0 : 1);
