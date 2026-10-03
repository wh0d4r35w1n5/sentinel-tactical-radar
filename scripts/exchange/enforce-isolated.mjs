#!/usr/bin/env node
// exchange/enforce-isolated.mjs — force ISOLATED margin on the live book and prove it.
//
// Bybit stores margin mode per symbol. Only switch-isolated changes it;
// set-leverage without an explicit marginMode leaves the symbol's existing mode
// untouched. So a swallowed switch-isolated error silently leaves a position
// CROSS, where the whole wallet backs it instead of the position's own margin.
//
// Per symbol: clear orders -> switch-isolated (tradeMode=1, with leverage)
// -> fallback set-margin-mode + set-leverage(marginMode=ISOLATED_MARGIN)
// -> VERIFY tradeMode===1 from /v5/position/list (never trust the ack)
// -> re-apply TP/SL if the switch cleared them.
//
//   node scripts/exchange/enforce-isolated.mjs                  # all open positions
//   node scripts/exchange/enforce-isolated.mjs BTCUSDT ETHUSDT  # named symbols
import '../load-env.mjs'; // canonical .env loader; SENTINEL_*/EXEC_* need it or creds silently go missing
import { makeExchange } from './index.mjs';

const CAT = 'linear';
const argv = process.argv.slice(2);
const ex = makeExchange(process.env);
const out = { ts: new Date().toISOString(), host: ex.host, rows: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String((e && e.message) || e).replace(/^.*-> /, '').slice(0, 140);

// api-demo flaps on connect (undici 10s connect timeout). A transport blip must
// NEVER read as "no position" — that silently skips the symbol.
const retry = async (fn, n = 5) => {
  let last;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(1500); }
  }
  throw last;
};

const posRow = async (symbol) => {
  const r = await retry(() => ex.api('GET', '/v5/position/list', {
    qs: 'category=' + CAT + '&symbol=' + symbol + '&limit=20',
  }));
  return (r?.list || []).find((p) => p.symbol === symbol) || null;
};

const listOpen = async () => {
  const r = await retry(() => ex.api('GET', '/v5/position/list', {
    qs: 'category=' + CAT + '&settleCoin=USDT&limit=200',
  }));
  return (r?.list || []).filter((p) => +p.size > 0);
};

const clearOrders = async (symbol) => {
  const notes = [];
  try {
    await retry(() => ex.api('POST', '/v5/order/cancel-all', { body: { category: CAT, symbol } }));
    notes.push('cancelled working/conditional orders');
  } catch (e) { notes.push('cancel-all skipped: ' + short(e)); }
  return notes;
};

const switchIsolated = async (symbol, lev) => {
  const notes = [];
  try {
    await retry(() => ex.api('POST', '/v5/position/switch-isolated', {
      body: { category: CAT, symbol, tradeMode: 1, buyLeverage: String(lev), sellLeverage: String(lev) },
    }));
    notes.push('switch-isolated tradeMode=1 OK');
  } catch (e) {
    notes.push('switch-isolated failed: ' + short(e));
    try {
      await retry(() => ex.api('POST', '/v5/position/set-margin-mode', {
        body: { category: CAT, symbol, buyMarginMode: 'ISOLATED_MARGIN', sellMarginMode: 'ISOLATED_MARGIN' },
      }));
      notes.push('set-margin-mode ISOLATED_MARGIN OK');
    } catch (e2) { notes.push('set-margin-mode failed: ' + short(e2)); }
  }
  try {
    await retry(() => ex.api('POST', '/v5/position/set-leverage', {
      body: { category: CAT, symbol, buyLeverage: String(lev), sellLeverage: String(lev), marginMode: 'ISOLATED_MARGIN' },
    }));
    notes.push('set-leverage ' + lev + 'x ISOLATED_MARGIN OK');
  } catch (e) { notes.push('set-leverage: ' + short(e)); }
  return notes;
};

const verifyIsolated = async (symbol) => {
  let p = null;
  for (let i = 0; i < 6; i++) {
    p = await posRow(symbol).catch(() => null);
    if (p && +p.tradeMode === 1) return p;
    await sleep(1200);
  }
  return p;
};

const reapplyTpSl = async (symbol, p) => {
  if (!(+p.takeProfit > 0 || +p.stopLoss > 0)) return ['no tp/sl on record — left empty'];
  try {
    await retry(() => ex.api('POST', '/v5/position/trading-stop', {
      body: {
        category: CAT, symbol, tpslMode: 'Full', positionIdx: +(p.positionIdx || 0),
        takeProfit: String(p.takeProfit), stopLoss: String(p.stopLoss),
        tpTriggerBy: 'MarkPrice', slTriggerBy: 'MarkPrice',
      },
    }));
    return ['re-applied tp=' + p.takeProfit + ' sl=' + p.stopLoss];
  } catch (e) { return ['tp/sl re-apply failed: ' + short(e)]; }
};

const symbols = argv.length ? argv : (await listOpen()).map((p) => p.symbol);
console.log('enforce-isolated on ' + ex.host);
console.log('symbols: ' + (symbols.join(', ') || '(none)'));

for (const symbol of symbols) {
  const before = await posRow(symbol).catch((e) => { console.log('  ! position query failed: ' + short(e)); return null; });
  if (!before) {
    console.log('\n' + symbol + ': no position row (query OK) — nothing to isolate');
    out.rows.push({ symbol, ok: false, why: 'no position row' });
    continue;
  }
  const lev = +(process.env.SENTINEL_LEV || before.leverage || 25);
  console.log('\n' + symbol + ': size=' + before.size + ' tradeMode=' + before.tradeMode + ' lev=' + before.leverage + ' -> target ' + lev + 'x isolated');
  const notes = [];
  if (+before.tradeMode !== 1) notes.push(...await clearOrders(symbol));
  notes.push(...await switchIsolated(symbol, lev));
  const after = await verifyIsolated(symbol);
  const ok = !!after && +after.tradeMode === 1;
  if (ok) notes.push(...await reapplyTpSl(symbol, after));
  else notes.push('NOT isolated — refusing to claim success');
  console.log(notes.map((n) => '  - ' + n).join('\n'));
  console.log('  RESULT tradeMode=' + (after ? after.tradeMode : '?') + ' positionIM=' + (after ? after.positionIM : '?') + ' liq=' + (after ? after.liqPrice : '?') + ' ' + (ok ? 'ISOLATED' : 'FAILED'));
  out.rows.push({
    symbol, ok,
    size: after?.size, avgPrice: after?.avgPrice, leverage: after?.leverage,
    tradeMode: after?.tradeMode, positionIM: after?.positionIM,
    takeProfit: after?.takeProfit, stopLoss: after?.stopLoss, liqPrice: after?.liqPrice,
    notes,
  });
}

const bad = out.rows.filter((r) => !r.ok);
out.summary = { total: out.rows.length, isolated: out.rows.length - bad.length, failed: bad.map((r) => r.symbol) };
console.log('\nSUMMARY ' + out.summary.isolated + '/' + out.rows.length + ' isolated' + (bad.length ? ' — failed: ' + bad.map((r) => r.symbol).join(', ') : ''));
console.log(JSON.stringify(out, null, 2));
process.exit(bad.length ? 1 : 0);
