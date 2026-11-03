#!/usr/bin/env node
// genius.mjs — Fee Genius + Arbitrage Genius (operator order: "full
// access to trusted exchanges' data — be like SBF who made his wealth
// from arb opps; works with The Wife").
//
// FEE BRAIN (every loop): reads state/real-fills.json — the Oct-8 lesson
// is law: fees ate $15.31 of a $20.35 loss day. Computes 24h fee spend,
// per-symbol fee drag vs gross profit, and publishes api/fee-genius.json.
// When fees are bleeding, Fee Genius complains to the outbox — and names
// the leak symbol.
//
// ARB BRAIN (every loop): pulls PUBLIC market data from the trusted
// venues — Bitget (home), Binance futures (premiumIndex: mark+funding
// in one call), Bybit v5 linear tickers (price+funding), OKX swaps —
// and computes per-symbol cross-exchange spreads and funding-rate
// differentials. A spread net of round-trip fees ≥ threshold becomes an
// opportunity card in the outbox + api/arb-genius.json. Cross-exchange
// EXECUTION needs keys we don't have — the genius's job is to SEE it
// first, and flag the Bitget-actionable leg (negative funding = longs
// get paid to hold = carry income inside our own book).
//
// THE WIFE COUPLING: state/wife.json mood scales the arb threshold —
// furious wife (mood≥3) → report spreads ≥0.15%; calm → ≥0.45%.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, '..', 'state');
const API_DIR = path.join(__dirname, '..', 'api');
const OUTBOX = path.join(STATE, 'tg-outbox.jsonl');
const MS = +(process.env.GENIUS_MS || 45000);
const RT_FEE_PCT = +(process.env.GENIUS_RT_FEE_PCT || 0.12);   // taker round-trip
const BASE_NET_PCT = +(process.env.GENIUS_NET_PCT || 0.45);    // calm-mode floor
const OPP_DEDUP_MS = +(process.env.GENIUS_OPP_DEDUP_MS || 20 * 60e3);
const FEE_ALERT_USD = +(process.env.GENIUS_FEE_ALERT_USD || 0.5);
const MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'BNBUSDT', 'AVAXUSDT', 'DOTUSDT', 'NEARUSDT', 'ATOMUSDT', 'UNIUSDT', 'TRXUSDT'];
// named correlated clusters — one family = one bet. The SOXL+SNDK+MU
// stack bled -$4.5 in a single dump: three "different" seats that were
// the same semiconductor long. Family cap (default 2) stops the stack.
const FAMILIES = {
  SOXLUSDT: 'SEMI', SOXSUSDT: 'SEMI', SNDKUSDT: 'SEMI', MUUSDT: 'SEMI',
  NVDAUSDT: 'SEMI', TSMUSDT: 'SEMI', AVGOUSDT: 'SEMI', AMDUSDT: 'SEMI',
  INTCUSDT: 'SEMI', QCOMUSDT: 'SEMI', SKHYNIXUSDT: 'SEMI', SKHYUSDT: 'SEMI', SMHUSDT: 'SEMI',
  SOXXUSDT: 'SEMI', ASMLUSDT: 'SEMI', MRVLUSDT: 'SEMI', ARMUSDT: 'SEMI',
  TXNUSDT: 'SEMI', ONUSDT: 'SEMI', NXPIUSDT: 'SEMI',
  CLUSDT: 'ENERGY', BZUSDT: 'ENERGY', NATGASUSDT: 'ENERGY', NGUSDT: 'ENERGY',
  XLEUSDT: 'ENERGY', USOUSDT: 'ENERGY',
  XAUUSDT: 'METALS', XAGUSDT: 'METALS', COPPERUSDT: 'METALS', HGUSDT: 'METALS',
  PLATUSDT: 'METALS', PALLUSDT: 'METALS',
  SP500USDT: 'EQIDX', NDX100USDT: 'EQIDX', QQQUSDT: 'EQIDX', SPYUSDT: 'EQIDX',
  DIAUSDT: 'EQIDX', IWMUSDT: 'EQIDX', DJIUSDT: 'EQIDX', VIXUSDT: 'EQIDX',
  AAPLUSDT: 'MEGA', MSFTUSDT: 'MEGA', GOOGUSDT: 'MEGA', GOOGLUSDT: 'MEGA',
  AMZNUSDT: 'MEGA', METAUSDT: 'MEGA', TSLAUSDT: 'MEGA', NFLXUSDT: 'MEGA',
  MSTRUSDT: 'BTCBETA', COINUSDT: 'BTCBETA', HOODUSDT: 'BTCBETA',
  CLSKUSDT: 'BTCBETA', MARAUSDT: 'BTCBETA', RIOTUSDT: 'BTCBETA',
};

const rj = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return fb; } };
const rjApi = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(API_DIR, f), 'utf8')); } catch { return fb; } };
const wjApi = (f, d) => { try { const t = path.join(API_DIR, f + '.tmp'); fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, path.join(API_DIR, f)); } catch { } };
const wj = (f, d) => { try { const t = path.join(STATE, f + '.tmp'); fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, path.join(STATE, f)); } catch { } };
const outbox = (text) => { try { fs.appendFileSync(OUTBOX, JSON.stringify({ ts: Date.now(), text, to: 'ops' }) + '\n'); } catch { } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// undici can leave an aborted fetch pending with the body stream stalled —
// AbortSignal covers connect+headers, not the .json() read. Hard-race the
// whole call: nothing this daemon awaits may pend past its budget.
const deadline = (ms, tag) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag} wedged >${ms}ms`)), ms));
const j = (u, ms = 4500) => Promise.race([
  fetch(u, { signal: AbortSignal.timeout(ms) }).then((r) => r.json()),
  deadline(ms + 2500, 'fetch'),
]);

let st = rj('genius.json', null) || { seen: {}, lastFeeAt: 0, lastOppAt: 0, oppCount: 0 };
const save = () => { try { fs.writeFileSync(path.join(STATE, 'genius.json'), JSON.stringify(st)); } catch { } };

// ---------- FEE BRAIN ----------
function feeBrain(wifeMood) {
  const d = rj('real-fills.json', { fills: [] });
  let day = Date.now() - 24 * 3600e3;
  const hour = Date.now() - 3600e3;
  // Dead-mix watermark: a cb-reset record means the window before it
  // judged a different trade mix. Fills older than the reset do not
  // count toward bleed — new losses re-arm the brake honestly.
  try { const r = rj('cb-reset.json'); if (r && +r.at > day) day = +r.at; } catch {}
  const fills = (d.fills || []).filter((f) => +f.ts >= day);
  const fills1h = fills.filter((f) => +f.ts >= hour);
  const bySym = {};
  let fees = 0, gross = 0, profit = 0, fees1h = 0;
  for (const f of fills) {
    const fee = Math.abs(+f.fee || 0), pf = +f.profit || 0;
    fees += fee; profit += pf;
    if (pf > 0) gross += pf;
    const s = bySym[f.symbol] || (bySym[f.symbol] = { fees: 0, profit: 0, n: 0 });
    s.fees += fee; s.profit += pf; s.n += 1;
  }
  for (const f of fills1h) fees1h += Math.abs(+f.fee || 0);
  // THE BRAKE — operator order: "balance isn't ever falling due to fees
  // unnecessarily". Two offenses: churn (fee burn rate too hot for the
  // book) and bleed (24h fees existing while the book isn't winning).
  // Engines read state/fee-brake.json before every entry.
  const churn = fees1h >= 0.15;
  const bleed = fees >= 0.5 && profit <= 0;
  const brake = churn || bleed;
  wj('fee-brake.json', {
    at: Date.now(), brake, churn, bleed,
    fees1hUsd: +fees1h.toFixed(4), fees24hUsd: +fees.toFixed(4), profit24hUsd: +profit.toFixed(4),
    reason: churn ? `churn: $${fees1h.toFixed(2)} fees in 60min` : bleed ? `bleed: $${fees.toFixed(2)} fees vs $${profit.toFixed(2)} net in 24h` : null,
  });
  const worst = Object.entries(bySym)
    .map(([sym, v]) => ({ sym, fees: +v.fees.toFixed(4), profit: +v.profit.toFixed(4), n: v.n, drag: v.profit > 0 ? +(v.fees / v.profit).toFixed(2) : null }))
    .filter((v) => v.fees > 0)
    .sort((a, b) => b.fees - a.fees).slice(0, 6);
  const share = gross > 0 ? fees / gross * 100 : (fees > 0 ? 999 : 0);
  wjApi('fee-genius.json', {
    ts: Date.now(), fees24hUsd: +fees.toFixed(4), gross24hUsd: +gross.toFixed(4),
    profit24hUsd: +profit.toFixed(4), feeShareOfGrossPct: +share.toFixed(1),
    fills24h: fills.length, worst,
    note: 'fees = |fee| on all fills 24h; gross = positive close profits only; drag = fees/gross per symbol',
  });
  const nagMs = wifeMood >= 2 ? 15 * 60e3 : 45 * 60e3;
  if (fees >= FEE_ALERT_USD && Date.now() - st.lastFeeAt >= nagMs) {
    st.lastFeeAt = Date.now();
    const w0 = worst[0];
    outbox(`🧠 Fee Genius: you burned $${fees.toFixed(2)} in fees over 24h${share < 900 ? ` — ${share.toFixed(0)}% of gross profit` : ' with NO gross profit to cover it'} across ${fills.length} fills.${w0 ? ` Biggest leak: ${w0.sym} — $${w0.fees.toFixed(2)} fees on $${w0.profit.toFixed(2)} profit. ${w0.profit <= 0 ? 'A bleeder — quarantine it.' : 'Bigger clips or don\'t trade it.'}` : ''}`);
    log(`fee alert: $${fees.toFixed(2)}/24h`);
  }
  return { fees, gross, profit, brake, churn, bleed };
}

// ---------- DEPLOYMENT ENVELOPE — the single deployment authority ----------
// Will-audit answer to "I would prefer one clearly defined risk-management
// system, with a single authority over whether Sentinel is permitted to
// open positions." Every 45s Genius composes the household (fee-brake +
// Wife mood) + per-cell measured edge into state/deploy-envelope.json;
// the exec mandate and the ignition engine obey THIS file (legacy
// fee-brake/wife reads become the degraded fallback, not parallel laws).
//
// CELL EDGE: pair fills FIFO per symbol -> episodes -> realized expectancy
// per cell. Verdicts: proven (exp >= +$0.05/ep over >=3 eps), loser
// (exp <= -$0.05), flat, unproven (n<3). Operator law rides: the book
// never force-deploys a measured-loser cell; unmeasured cells may still
// deploy at probe size ("savers are losers" — no evidence != negative
// evidence; the cells PROVE themselves).
// dual-listed underlyings: Bitget lists the same asset under multiple
// tickers (SKHY vs SKHYNIX = the same SK Hynix stock). Named families
// can't enumerate them all — detect prefix twins dynamically from the
// catalog: two symbols sharing a >=4-char base prefix where one is a
// prefix of the other are the same underlying -> same family.
let _famCache = { at: 0, map: null, twinOf: {} };
function mergedFamilies() {
  if (_famCache.map && Date.now() - _famCache.at < 10 * 60e3) return _famCache.map;
  const fam = { ...FAMILIES };
  const twinOf = {};
  try {
    const cat = rjApi('exec-catalog.json', null);
    const syms = (cat?.contracts || cat?.symbols || (Array.isArray(cat) ? cat : []))
      .map((c) => (typeof c === 'string' ? c : c?.symbol)).filter(Boolean);
    const bases = [...new Set(syms.map((s) => s.replace(/USDT$/, '')))].sort((a, b) => a.length - b.length);
    for (const b of bases) {
      if (b.length < 4) continue;
      for (const b2 of bases) {
        if (b2 === b || !b2.startsWith(b)) continue;
        const f1 = fam[b + 'USDT'], f2 = fam[b2 + 'USDT'];
        // a named family's member drags its twin into the same family —
        // SKHY rides SKHYNIX's SEMI tag, not a separate bucket.
        if (f1 && !f2) fam[b2 + 'USDT'] = f1;
        else if (f2 && !f1) fam[b + 'USDT'] = f2;
        else if (!f1 && !f2) { fam[b + 'USDT'] = 'TWIN:' + b; fam[b2 + 'USDT'] = 'TWIN:' + b; }
        // same underlying = ONE seat regardless of family cap — a dual
        // listing is correlation 1.0 ("one clip per idea", operator law).
        twinOf[b + 'USDT'] = b + 'USDT';
        twinOf[b2 + 'USDT'] = b + 'USDT';
      }
    }
  } catch { }
  _famCache = { at: Date.now(), map: fam, twinOf };
  return fam;
}
function mergedTwinOf() { mergedFamilies(); return _famCache.twinOf || {}; }

function cellEdge() {
  const d = rj('real-fills.json', { fills: [] });
  const bySym = {};
  for (const f of (d.fills || []).slice().sort((a, b) => +a.ts - +b.ts)) {
    (bySym[f.symbol] ||= []).push(f);
  }
  const cells = {};
  for (const [sym, fl] of Object.entries(bySym)) {
    const opens = [], eps = [];
    let lastLossAt = 0, lastCloseAt = 0;
    for (const f of fl) {
      if (f.tradeSide === 'open') opens.push(f);
      else if (opens.length) {
        const o = opens.shift();
        const ep = { net: (+f.profit || 0) - Math.abs(+f.fee || 0) - Math.abs(+o.fee || 0) };
        eps.push(ep);
        lastCloseAt = Math.max(lastCloseAt, +f.ts || 0);
        if (ep.net < 0) lastLossAt = Math.max(lastLossAt, +f.ts || 0);
      }
    }
    if (!eps.length) continue;
    const n = eps.length;
    const net = eps.reduce((a, e) => a + e.net, 0);
    const exp = net / n;
    const wins = eps.filter((e) => e.net > 0);
    const last3 = eps.slice(-3).map((e) => e.net);
    cells[sym] = {
      n, net: +net.toFixed(3), exp: +exp.toFixed(4),
      wr: +(wins.length / n * 100).toFixed(0),
      hot: n >= 3 && last3.every((x) => x > 0),
      lastLossAt, lastCloseAt,
      verdict: n >= 3 ? (exp >= 0.05 ? 'proven' : exp <= -0.05 ? 'loser' : 'flat') : 'unproven',
    };
  }
  return cells;
}

function deployEnvelope(wifeMood, fee) {
  const cells = cellEdge();
  const wealth = rjApi('wealth-live.json', null);
  const equity = +(wealth?.futures?.equityOwnUsd || wealth?.futures?.equityUsd || 0);
  // household tiers — deployment NEVER hits zero (operator law); stress
  // shrinks size and raises the bar instead of closing the door.
  const probeFrac = wifeMood >= 3 ? 0.12 : fee.brake ? 0.20 : +(process.env.GENIUS_PROBE_PCT || 0.25);
  const env = {
    at: Date.now(), author: 'genius',
    brake: fee.brake, churn: fee.churn, bleed: fee.bleed, wifeMood, equity: +equity.toFixed(2),
    deploy: {
      // hard floor only — equity death is the one true deployment stop;
      // drawdown alone scales size, never empties the book.
      allow: equity <= 0 || equity >= +(process.env.GENIUS_EQ_FLOOR_USD || 18),
      probeFrac,
      engineMinScore: wifeMood >= 3 ? 85 : 62 + (fee.brake ? 15 : 0),
      marginMult: fee.brake ? 0.5 : 1,
      seatCap: (fee.brake || wifeMood >= 3) ? 1 : +(process.env.BAGRUNNER_SEATS || 2),
      mandateSeatCap: wifeMood >= 3 ? 1 : fee.brake ? 2 : 3,
      familyCap: +(process.env.GENIUS_FAMILY_CAP || 2),
    },
    cells, families: mergedFamilies(), twinOf: mergedTwinOf(),
    note: 'single deployment authority — exec mandate + bagrunner read this. cells = realized expectancy per symbol from fills; familyCap caps one-cluster stacks.',
  };
  wj('deploy-envelope.json', env);
  const losers = Object.entries(cells).filter(([, c]) => c.verdict === 'loser').map(([s]) => s);
  const proven = Object.entries(cells).filter(([, c]) => c.verdict === 'proven').map(([s]) => s);
  return { cells: Object.keys(cells).length, losers: losers.length, proven: proven.length, frac: probeFrac };
}

// ---------- ARB BRAIN ----------
async function fetchVenues() {
  const out = { prices: {}, fund: {}, ms: {} };
  const t0 = Date.now();
  // Binance premiumIndex — mark price + lastFundingRate for EVERY perp, one call
  try {
    const rows = await j('https://fapi.binance.com/fapi/v1/premiumIndex');
    out.prices.binance = {}; out.fund.binance = {};
    for (const r of rows || []) if (/USDT$/.test(r.symbol)) {
      const p = +r.markPrice || +r.lastPrice;
      if (p > 0) { out.prices.binance[r.symbol] = p; out.fund.binance[r.symbol] = +r.lastFundingRate || 0; }
    }
    out.ms.binance = Date.now() - t0;
  } catch (e) { out.ms.binance = -1; }
  // Bybit v5 linear — one call, includes fundingRate
  try {
    const d = await j('https://api.bybit.com/v5/market/tickers?category=linear');
    out.prices.bybit = {}; out.fund.bybit = {};
    for (const r of d?.result?.list || []) if (/USDT$/.test(r.symbol)) {
      const p = +r.lastPrice;
      if (p > 0) { out.prices.bybit[r.symbol] = p; out.fund.bybit[r.symbol] = +r.fundingRate || 0; }
    }
    out.ms.bybit = Date.now() - t0;
  } catch (e) { out.ms.bybit = -1; }
  // OKX swaps — price only (funding endpoint is per-instId)
  try {
    const d = await j('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    out.prices.okx = {}; out.fund.okx = {};
    for (const r of d?.data || []) {
      const m = /^([A-Z0-9]+)-USDT-SWAP$/.exec(r.instId || '');
      if (!m) continue;
      const p = +r.last; if (p > 0) out.prices.okx[m[1] + 'USDT'] = p;
    }
    out.ms.okx = Date.now() - t0;
  } catch (e) { out.ms.okx = -1; }
  // Bitget home board
  try {
    const d = await j('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    out.prices.bitget = {}; out.fund.bitget = {};
    for (const r of d?.data || []) {
      const p = +r.lastPr;
      if (p > 0) { out.prices.bitget[r.symbol] = p; if (r.fundingRate != null) out.fund.bitget[r.symbol] = +r.fundingRate; }
    }
    out.ms.bitget = Date.now() - t0;
  } catch (e) { out.ms.bitget = -1; }
  return out;
}

async function arbBrain(wifeMood) {
  const v = await fetchVenues();
  const venues = Object.keys(v.prices).filter((k) => Object.keys(v.prices[k]).length);
  const thresh = wifeMood >= 3 ? 0.15 : wifeMood >= 2 ? 0.25 : BASE_NET_PCT;
  // need ≥2 venues for a spread — a one-venue world has no arb
  if (venues.length < 2) {
    wjApi('arb-genius.json', { ts: Date.now(), venues: v.ms, scanned: 0, threshNetPct: thresh, wifeMood, opps: [], fundDiffs: [], bitgetCarry: [], note: '<2 venues answered — nothing to compare' });
    return { opps: 0, common: 0, carry: 0 };
  }
  // intersect symbols across all venues present
  const sets = venues.map((k) => new Set(Object.keys(v.prices[k])));
  const common = [...sets[0]].filter((s) => sets.every((st2) => st2.has(s)));
  const opps = [];
  for (const sym of common) {
    let lo = { v: null, p: 1e99 }, hi = { v: null, p: 0 };
    for (const ven of venues) {
      const p = v.prices[ven][sym];
      if (p < lo.p) lo = { v: ven, p };
      if (p > hi.p) hi = { v: ven, p };
    }
    const spread = (hi.p - lo.p) / lo.p * 100;
    // same-ticker-different-asset guard: a >15% 'spread' is two different
    // instruments sharing a symbol string (BBUSDT on Bitget ≠ BB on OKX),
    // not an arb. Real cross-venue dislocations on liquid perps are <2%.
    if (spread > 15) continue;
    const net = spread - RT_FEE_PCT;
    if (net >= thresh) opps.push({ sym, buy: lo.v, sell: hi.v, buyPx: lo.p, sellPx: hi.p, spreadPct: +spread.toFixed(3), netPct: +net.toFixed(3) });
  }
  opps.sort((a, b) => b.netPct - a.netPct);

  // funding differentials across venues — shorts pay longs at the extreme
  const fundDiffs = [];
  for (const sym of common) {
    const fr = {};
    for (const ven of venues) if (v.fund[ven]?.[sym] != null) fr[ven] = v.fund[ven][sym];
    const vs = Object.entries(fr);
    if (vs.length >= 2) {
      const mx = Math.max(...vs.map(([, x]) => x)), mn = Math.min(...vs.map(([, x]) => x));
      if (mx - mn >= 0.0003) fundDiffs.push({ sym, diffBps: +((mx - mn) * 1e4).toFixed(1), ...fr });
    }
  }
  fundDiffs.sort((a, b) => b.diffBps - a.diffBps);

  // Bitget-internal carry: negative funding = longs get PAID to hold —
  // the only arb leg we can actually take on this venue. Majors only.
  const carry = [];
  try {
    for (const sym of MAJORS) {
      const d = await j(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${sym}&productType=USDT-FUTURES`, 3500).catch(() => null);
      const rate = +d?.data?.fundingRate;
      if (Number.isFinite(rate) && rate < -0.0001) carry.push({ sym, rateBps: +(rate * 1e4).toFixed(2), estApyPct: +(rate * -3 * 365 * 100).toFixed(1) });
    }
  } catch { }
  carry.sort((a, b) => a.rateBps - b.rateBps);

  wjApi('arb-genius.json', {
    ts: Date.now(), venues: v.ms, scanned: common.length, threshNetPct: thresh,
    wifeMood, opps: opps.slice(0, 12), fundDiffs: fundDiffs.slice(0, 8), bitgetCarry: carry,
    note: 'netPct = cross-venue spread − 0.12% RT fees; execution needs accounts on both venues — detection/advisory only. bitgetCarry = negative funding (longs get paid) — actionable inside this book.',
  });

  // outbox — dedupe per sym 20min unless the spread widened materially
  const now = Date.now();
  for (const o of opps.slice(0, 3)) {
    const last = st.seen[o.sym];
    if (last && now - last.at < OPP_DEDUP_MS && o.netPct < last.netPct * 1.5) continue;
    st.seen[o.sym] = { at: now, netPct: o.netPct };
    st.oppCount += 1;
    if (process.env.GENIUS_ARB_NOTIFY === '1') outbox(`🧠 Arb Genius${wifeMood >= 2 ? ' (The Wife is watching — found this FAST)' : ''}: ${o.sym} — ${o.buy} $${o.buyPx} vs ${o.sell} $${o.sellPx} · ${o.spreadPct}% gross · ${o.netPct}% net of fees. Kimchi window. Need accounts on both venues to take it — flagged for the record.`);
    log(`opp ${o.sym} ${o.spreadPct}% (${o.buy}→${o.sell})`);
  }
  for (const c of carry.slice(0, 2)) {
    const k = 'carry-' + c.sym;
    const last = st.seen[k];
    if (last && now - last.at < 6 * 3600e3) continue;
    st.seen[k] = { at: now };
    if (process.env.GENIUS_ARB_NOTIFY === '1') outbox(`🧠 Arb Genius — carry arb WE can actually take: ${c.sym} funding ${c.rateBps}bps/8h (~${c.estApyPct}% APY paid to LONGS). Holding long here collects the rate — actionable on Bitget right now.`);
  }
  save();
  return { opps: opps.length, common: common.length, carry: carry.length };
}

function wifeMood() { return +(rj('wife.json', {})?.mood || 0); }

console.log(`genius up — ${MS}ms · fee brain + arb brain · thresh ${BASE_NET_PCT}% (wife-scaled)`);
let busy = false;
const loop = async () => {
  if (busy) return; busy = true;
  try {
    const m = wifeMood();
    const fee = feeBrain(m);
    const env = deployEnvelope(m, fee);
    // arbBrain hangs are why busy stayed true forever (service `active`,
    // envelope dead for hours). Race it: a wedged brain loses its turn,
    // busy clears, the envelope keeps writing next tick.
    const r = await Promise.race([arbBrain(m), deadline(120000, 'arbBrain').then(() => ({ opps: 0, common: 0, carry: 0, wedged: true }))]);
    wj('genius-heartbeat.json', { at: Date.now(), wifeMood: m, ...r, env });
  } catch (e) { log('err', String(e.message || e).slice(0, 160)); }
  busy = false;
};
setInterval(loop, MS);
setTimeout(loop, 2000);
