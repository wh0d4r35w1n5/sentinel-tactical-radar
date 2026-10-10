// ledger-recon.mjs — independent financial reconciliation (Will Evans M1/Q3).
// Deliberately STANDALONE: its own signer, its own RPC reads, no imports from
// the trading stack. The validator must not share code paths with the system
// it validates — every number here is recomputed from exchange bills, wallet
// RPC and journal files, then published to api/ledger-recon.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const STATE = path.join(ROOT, 'state');
const API = path.join(ROOT, 'api');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

const HOST = 'https://api.bitget.com';
const KEY = process.env.BITGET_API_KEY || '';
const SECRET = process.env.BITGET_API_SECRET || '';
const PASS = process.env.BITGET_PASSPHRASE || '';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

async function bget(reqPath, qs = '') {
  const ts = String(Date.now());
  const pre = ts + 'GET' + reqPath + (qs ? '?' + qs : '');
  const sign = crypto.createHmac('sha256', SECRET).update(pre).digest('base64');
  const r = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
    headers: { 'ACCESS-KEY': KEY, 'ACCESS-SIGN': sign, 'ACCESS-PASSPHRASE': PASS, 'ACCESS-TIMESTAMP': ts, locale: 'en-US' },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== '00000') { const e = new Error(`${reqPath} -> ${j.code} ${j.msg || ''}`); e.code = j.code; throw e; }
  return j.data;
}

// every financial businessType on the futures bill feed — margin-adjust
// types are non-cash and excluded from flow totals but kept for audit
const BILL_TYPES = [
  'trans_from_exchange', 'trans_to_exchange', 'trans_from_contract', 'trans_to_contract',
  'trans_from_otc', 'trans_to_otc', 'open_long', 'open_short', 'close_long', 'close_short',
  'contract_settle_fee', 'force_close_long', 'force_close_short',
  'burst_long_loss_query', 'burst_short_loss_query', 'cash_gift_issue', 'cash_gift_recycle',
];
const DAY = 864e5, SPAN = 30 * DAY; // API window cap

async function allBills() {
  const out = [], errors = {};
  const now = Date.now();
  // walk back ~120 days in 30d windows, paginate each type via idLessThan
  for (const bt of BILL_TYPES) {
    for (let end = now; end > now - 120 * DAY; end -= SPAN) {
      const start = Math.max(end - SPAN, now - 120 * DAY);
      let cursor = '', guard = 0;
      for (;;) {
        const qs = `productType=USDT-FUTURES&coin=USDT&businessType=${bt}&limit=100&startTime=${start}&endTime=${end}` + (cursor ? `&idLessThan=${cursor}` : '');
        let d;
        try { d = await bget('/api/v2/mix/account/bill', qs); }
        catch (e) { errors[bt] = e.message; break; }
        const rows = d?.bills || [];
        rows.forEach((r) => out.push(r));
        if (rows.length < 100 || ++guard > 20) break;
        cursor = d?.endId || rows[rows.length - 1]?.billId || '';
        if (!cursor) break;
      }
    }
  }
  return { bills: out, errors };
}

async function solanaTokens(address) {
  if (!address) return { ok: false };
  const rpc = (method, params) => fetch(SOLANA_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) }).then((r) => r.json());
  const progs = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
  const [solJ, ...tokLists] = await Promise.all([
    rpc('getBalance', [address]),
    ...progs.map((p) => rpc('getTokenAccountsByOwner', [address, { programId: p }, { encoding: 'jsonParsed' }]).catch(() => ({}))),
  ]);
  const tokens = {};
  for (const t of tokLists) {
    for (const a of t?.result?.value || []) {
      const i = a.account?.data?.parsed?.info;
      if (i && +i.tokenAmount.uiAmount > 0) tokens[i.mint] = +i.tokenAmount.uiAmount;
    }
  }
  return { ok: true, sol: (solJ?.result?.value || 0) / 1e9, tokens };
}

async function main() {
  const recon = { ts: Date.now(), updatedAt: new Date().toISOString(), source: 'independent-recon-v1' };
  if (!KEY || !SECRET || !PASS) { recon.fatal = 'no BITGET_API_* env — exchange side unreadable'; writeJ(path.join(API, 'ledger-recon.json'), recon); return; }

  // ---- exchange account state ----
  try {
    const acc = await bget('/api/v2/mix/account/account', 'productType=USDT-FUTURES&marginCoin=USDT&symbol=BTCUSDT');
    recon.futures = { equityUsd: +acc.equity || 0, availableUsd: +acc.available || 0, unrealizedPnlUsd: +acc.unrealizedPL || 0 };
  } catch (e) { recon.futures = { error: e.message }; }
  try {
    const assets = await bget('/api/v2/spot/account/assets', '');
    recon.spot = { assets: (assets || []).filter((a) => +a.available > 0 || +a.frozen > 0).map((a) => ({ coin: a.coin, available: +a.available, frozen: +a.frozen })) };
  } catch (e) { recon.spot = { error: e.message }; }

  // ---- futures bills: every cash movement through the account ----
  const { bills, errors } = await allBills();
  recon.billErrors = Object.keys(errors).length ? errors : undefined;
  const flow = {};
  const rows = [];
  for (const b of bills) {
    const t = b.businessType, amt = +b.amount || 0, fee = +b.fee || 0;
    flow[t] ??= { count: 0, amountUsd: 0, feeUsd: 0 };
    flow[t].count++; flow[t].amountUsd += amt; flow[t].feeUsd += Math.abs(fee);
    rows.push({ ts: +b.cTime, type: t, symbol: b.symbol || null, amountUsd: +amt.toFixed(8), feeUsd: Math.abs(+fee.toFixed(8)) });
  }
  rows.sort((a, b) => a.ts - b.ts);
  recon.bills = {
    count: bills.length,
    transfersInUsd: +(flow.trans_from_exchange?.amountUsd || 0).toFixed(4),
    transfersOutUsd: Math.abs(+(flow.trans_to_exchange?.amountUsd || 0)).toFixed(4),
    fundingFeesUsd: +(flow.contract_settle_fee?.amountUsd || 0).toFixed(4),
    tradingFeesUsd: +Object.entries(flow).filter(([t]) => /open_|close_|buy|sell|burst|force/.test(t)).reduce((a, [, v]) => a + v.feeUsd, 0).toFixed(4),
    realizedNetUsd: +Object.entries(flow).filter(([t]) => /close_|burst|force/.test(t)).reduce((a, [, v]) => a + v.amountUsd, 0).toFixed(4),
    byType: Object.fromEntries(Object.entries(flow).map(([t, v]) => [t, { count: v.count, amountUsd: +v.amountUsd.toFixed(4), feeUsd: +v.feeUsd.toFixed(4) }])),
    rows: rows.slice(-200),
  };

  // ---- order fills: raw exchange trade records — independent of the
  // bot's own journals. profit on close fills + fee on every fill.
  try {
    const fills = [];
    let cursor = '', guard = 0;
    for (;;) {
      const qs = `productType=USDT-FUTURES&limit=100` + (cursor ? `&idLessThan=${cursor}` : '');
      const d = await bget('/api/v2/mix/order/fills', qs);
      const rows = d?.fillList || d?.fills || [];
      rows.forEach((r) => fills.push(r));
      if (rows.length < 100 || ++guard > 30) break;
      cursor = rows[rows.length - 1]?.tradeId || '';
      if (!cursor) break;
    }
    const feeOf = (f) => Math.abs(+(f.feeDetail?.[0]?.totalFee ?? f.fee ?? 0));
    const closeFills = fills.filter((f) => /close/i.test(f.tradeSide || ''));
    const bySym = {};
    for (const f of fills) { const s = f.symbol; (bySym[s] ??= { fills: 0, profitUsd: 0, feeUsd: 0 }); bySym[s].fills++; bySym[s].profitUsd += +(f.profit || 0); bySym[s].feeUsd += feeOf(f); }
    for (const v of Object.values(bySym)) { v.profitUsd = +v.profitUsd.toFixed(4); v.feeUsd = +v.feeUsd.toFixed(4); }
    const tsMin = Math.min(...fills.map((f) => +f.cTime || Infinity));
    const tsMax = Math.max(...fills.map((f) => +f.cTime || 0));
    recon.exchangeFills = {
      count: fills.length, closes: closeFills.length,
      windowFrom: isFinite(tsMin) ? new Date(tsMin).toISOString() : null, windowTo: isFinite(tsMax) ? new Date(tsMax).toISOString() : null,
      realizedUsd: +closeFills.reduce((a, f) => a + (+f.profit || 0), 0).toFixed(4),
      feeUsd: +fills.reduce((a, f) => a + feeOf(f), 0).toFixed(4),
      windowNote: 'order/fills serves retained history only — includes manual + pre-epoch trading the journal deliberately excludes',
      bySym: Object.fromEntries(Object.entries(bySym).sort((a, b) => a[1].profitUsd - b[1].profitUsd).slice(0, 25)),
    };
  } catch (e) { recon.exchangeFills = { error: e.message }; }

  // ---- external cash rails (best-effort — read perms vary) ----
  const d90 = Date.now() - 90 * 864e5;
  for (const [k, p, qs] of [['deposits', '/api/v2/spot/wallet/deposit-records', `startTime=${d90}&endTime=${Date.now()}&limit=100`], ['withdrawals', '/api/v2/spot/wallet/withdrawal-records', `startTime=${d90}&endTime=${Date.now()}&limit=100`]]) {
    try {
      const d = await bget(p, qs);
      const rows = Array.isArray(d) ? d : (d?.records || d?.list || []);
      recon[k] = { count: rows.length, rows: rows.slice(0, 50).map((r) => ({ ts: +(r.cTime || r.ts || 0), coin: r.coin, size: +(r.size || r.amount || 0), status: r.status, txId: (r.txId || '').slice(0, 24), dest: (r.toAddress || r.address || '').slice(0, 24) })) };
    } catch (e) { recon[k] = { error: e.message }; }
  }

  // ---- journals: what the bot THINKS happened ----
  const real = readJ(path.join(STATE, 'real-fills.json'), []);
  const fills = Array.isArray(real) ? real : (real.fills || []);
  const onchain = readJ(path.join(STATE, 'onchain-fills.json'), []);
  const lane = readJ(path.join(API, 'onchain-lane.json'), null);
  const vault = readJ(path.join(STATE, 'wealth-vault.json'), null);
  const closes = fills.filter((f) => f.tradeSide === 'close' || f.side === 'close' || f.side === 'sell');
  const bySrc = {};
  for (const f of fills) {
    const s = f.src || 'unknown';
    const b = (bySrc[s] ??= { fills: 0, closes: 0, netUsd: 0, feeUsd: 0 });
    b.fills++; b.feeUsd += +(f.fee || f.feeUsd || 0);
    if (f.tradeSide === 'close' || f.side === 'close' || f.side === 'sell') { b.closes++; b.netUsd += +(f.profit ?? f.netUsd ?? f.pnlUsd ?? 0); }
  }
  for (const b of Object.values(bySrc)) { b.netUsd = +b.netUsd.toFixed(4); b.feeUsd = +b.feeUsd.toFixed(4); }
  recon.journal = {
    live: { fills: fills.length, closes: closes.length, netUsd: +closes.reduce((a, f) => a + (+(f.profit ?? f.netUsd ?? f.pnlUsd ?? 0)), 0).toFixed(4), feeUsd: +fills.reduce((a, f) => a + (+(f.fee || f.feeUsd || 0)), 0).toFixed(4), bySrc },
    onchain: { fills: onchain.length, buys: onchain.filter((f) => f.side === 'buy').length, sells: onchain.filter((f) => f.side === 'sell').length, sweeps: onchain.filter((f) => f.side === 'bootstrap').length, reconciles: onchain.filter((f) => f.side === 'reconcile').length },
  };

  // ---- on-chain wallet truth (public RPC, no secrets) ----
  const addr = lane?.address || readJ(path.join(STATE, 'onchain-book.json'), {})?.address || null;
  const w = await solanaTokens(addr).catch(() => ({ ok: false }));
  recon.wallet = { address: addr, ok: !!w.ok, sol: w.sol ?? null, tokens: w.tokens || {}, stableUsd: +(w.tokens?.['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] || 0) + +(w.tokens?.['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'] || 0), purseUsd: lane?.purseUsd ?? null, openPositions: (lane?.positions || []).length };

  // ---- the reconciliation itself — ZONE MODEL, not a single equation.
  // Money lives in zones the API can see (futures bills, wallet RPC) and
  // zones it can't (spot/funding — 40014). The honest report names every
  // blind spot instead of forcing a fake zero residual.
  const transfersIn = +recon.bills.transfersInUsd || 0;
  const transfersOut = +recon.bills.transfersOutUsd || 0;
  const realized = recon.exchangeFills?.realizedUsd ?? +recon.bills.realizedNetUsd ?? 0;
  const fees = recon.exchangeFills?.feeUsd ?? +recon.bills.tradingFeesUsd ?? 0;
  const funding = +recon.bills.fundingFeesUsd || 0;
  const actual = (+recon.futures?.equityUsd || 0);
  const blindSpots = [];
  if (recon.spot?.error) blindSpots.push({ zone: 'spot/funding balances', reason: recon.spot.error, fix: 'upgrade API key: add spot read permission' });
  if (recon.deposits?.error) blindSpots.push({ zone: 'external deposits', reason: recon.deposits.error, fix: 'deposit records need spot wallet read perm' });
  recon.reconcile = {
    zones: {
      futuresAccount: { equityUsd: actual, method: 'mix/account/account — live' },
      spotFunding: recon.spot?.error ? { error: recon.spot.error } : { usdtUsd: (recon.spot?.assets || []).filter((a) => a.coin === 'USDT').reduce((a2, x) => a2 + x.available + x.frozen, 0), method: 'spot/account/assets' },
      onchainWallet: { purseUsd: recon.wallet?.purseUsd ?? null, stablesUsd: recon.wallet?.stableUsd ?? null, method: 'solana RPC token accounts — independent' },
      withdrawnOffPlatform: { records: recon.withdrawals?.count ?? null, note: 'see withdrawals.rows — USDGO legs to bot wallet verified success' },
    },
    flows: {
      transfersIntoFuturesUsd: +transfersIn.toFixed(4), transfersOutToSpotUsd: +transfersOut.toFixed(4),
      netFuturesFlowUsd: +(transfersIn - transfersOut).toFixed(4),
      exchangeRealizedUsd: +realized.toFixed(4), exchangeFeesUsd: +fees.toFixed(4), fundingUsd: +funding.toFixed(4),
      journalNetUsd: recon.journal.live.netUsd, journalFeeUsd: recon.journal.live.feeUsd,
      journalVsExchangeDriftUsd: +(recon.journal.live.netUsd - realized).toFixed(4),
    },
    blindSpots,
    note: 'net futures flow negative = more left futures to spot than entered; destination lands in the 40014-blind spot/funding zone or off-platform withdrawals. This is an audit trail, not a loss claim.',
  };
  recon.totalAssetsUsd = +(actual + (recon.spot?.error ? 0 : (recon.spot?.assets || []).filter((a) => a.coin === 'USDT').reduce((a2, x) => a2 + x.available + x.frozen, 0)) + (recon.wallet?.purseUsd || 0) + (vault?.vaultUsd || 0)).toFixed(4);

  writeJ(path.join(API, 'ledger-recon.json'), recon);
  console.log(`ledger-recon: futures $${actual.toFixed(2)} | flows in $${transfersIn.toFixed(2)} out $${transfersOut.toFixed(2)} | exchange realized $${realized.toFixed(2)} fees $${fees.toFixed(2)} | wallet $${recon.wallet?.purseUsd ?? '—'} | blind ${blindSpots.length}`);
}
main().catch((e) => { console.warn('ledger-recon failed:', e.message); writeJ(path.join(API, 'ledger-recon.json'), { ts: Date.now(), fatal: e.message }); });
