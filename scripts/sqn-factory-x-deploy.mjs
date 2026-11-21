// SQN Factory X — deployment pass. Reads sqn-factory-x.json lastSignals +
// promoted cells, authors armed probe setups into cmd-setups.json.
// Only deploys cells whose BEST promoted exit has explicit geometry:
//   tp{a}-sl{b} -> fixed SL/TP  |  h{n} -> disaster stop + TTL horizon
// atr-trail exits are skipped v1 (exec K2 trail owns runner management).
// Probe sizing only — backtest-promoted cells are not forward-proven.
import fs from 'fs';
import path from 'path';
const STATE = '/opt/sentinel/state';
const API = '/opt/sentinel/api';
const MAX_LIVE = 48;           // X lane cap — apex expansion 2026-11-12: deep
                               // armed queue; seats only consume margin when
                               // triggered, so flow scales without capital
const PROBE_RISK = 2;          // pct-equity risk per probe seat
const TOPN = 60;               // best promoted trig+side combos eligible
// non-crypto bar (operator 2026-11-12 — "sometimes they are a great idea
// though"): RWA/index/metal/commodity/fx perps trend smoothly so their
// backtests score well without real edge — "any dumb cunt can short gold".
// They may deploy, but only on overwhelming evidence: SQN >= this floor
// (crypto cells keep the standard promotion bar). Same sets as the
// scanner's assetClass + the exec NON_CRYPTO list.
const NON_CRYPTO_BASES = new Set((
  'XAU XAG XPT XPD HG COPPER COP PAXG XAUT ' +                       // metals
  'SPX SPY QQQ VOO IWM SP500 NDX100 NDX NAS100 US500 US30 DJT DJI DAX FTSE NI225 JP225 HSI KR200 TQQQ SQQQ QLD SPXU UDOW SDOW TNA TZA UVXY SOXL SOXS SOXX SMH XLE XLU XLK XLV XBI GDX URNM BOTZ KWEB EWJ EWY EWT INDA EWH EWZ TLT TMF TBT JEPQ SGOV BITO IBIT AGPU BITU ETHU SOLX ' + // index/ETF
  'CL BZ NATGAS OIL UKOIL USOIL WTI BRENT CORN WHEAT SOY SUGAR COFFEE COCOA ' + // commodity
  'EURUSD USDJPY GBPUSD AUDUSD USDCAD USDCHF NZDUSD EURGBP EURJPY GBPJPY DXY USDCNH USDBRL ' + // fx
  'AAPL MSFT TSLA NVDA AMZN META GOOG GOOGL NFLX AMD INTC COIN MSTR MCD BABA EBAY SAMSUNG MDB GS ZHONGJIU TOKYOEL AMC GILD GE NKE WMT JPM V MA DIS PYPL PLTR ORCL IBM CSCO XOM CVX JNJ PFE BAC WFC KO PEP HD COST TGT'
).split(/\s+/).filter(Boolean));
const NON_CRYPTO_MIN_SQN = +(process.env.SENTINEL_FACX_NONCRYPTO_SQN || 5.5);
const isNonCrypto = (sym) => NON_CRYPTO_BASES.has(String(sym || '').replace(/USDT$/, '').toUpperCase());
const METALS_BASES = new Set('XAU XAG XPT XPD HG COPPER COP PAXG XAUT'.split(/\s+/));
const isMetal = (sym) => METALS_BASES.has(String(sym || '').replace(/USDT$/, '').toUpperCase());

const fac = JSON.parse(fs.readFileSync(path.join(STATE, 'sqn-factory-x.json'), 'utf8'));
const promoted = fac.promoted || {};
const signals = fac.lastSignals || [];
if (!signals.length) { console.log('no last-bar signals'); process.exit(0); }

// group promoted cells by (tf,trig,side) -> best exit by sqn
const best = new Map();
for (const [key, g] of Object.entries(promoted)) {
  const m = key.match(/^x(4h)?:([^:]+):([^:]+):(long|short)$/);
  if (!m) continue;
  const [, tf4, trig, exit, side] = m;
  const tf = tf4 ? '4H' : '1D';
  const kk = tf + '|' + trig + '|' + side;
  const cur = best.get(kk);
  if (!cur || g.sqn > cur.g.sqn) best.set(kk, { trig, exit, side, g, tf });
}
const ranked = [...best.entries()].sort((a, b) => b[1].g.sqn - a[1].g.sqn).slice(0, TOPN);
if (!ranked.length) { console.log('no promoted x cells'); process.exit(0); }

// exec-consistent trend gate (2026-11-12): the old SMA20 check read rows
// with NO freshness window and a different 'trend' definition than the
// exec's htfTrend — one pass authored 28 facx shorts that ALL died at the
// exec's short-trend-rule. Mirror the exec exactly: same klines files,
// same 45min row.at freshness, same fast/slow mean + HL/LH structure,
// plus the exec's 1H-uptrend and funding vetoes for shorts.
const klCache = {};
const htfTrend = (sym, tf) => {
  try {
    if (!klCache[tf]) klCache[tf] = JSON.parse(fs.readFileSync(path.join(STATE, 'klines-' + tf + '.json'), 'utf8'));
    const row = klCache[tf]?.[sym];
    const cl = row?.payload?.closes || (Array.isArray(row?.rows) ? row.rows.map((r) => +r.c).filter(Number.isFinite) : null);
    const at = +row?.at || 0;
    if (!Array.isArray(cl) || cl.length < 24 || Date.now() - at > 45 * 60e3) return null;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const fast = mean(cl.slice(-4)), slow = mean(cl.slice(-12));
    const hi1 = Math.max(...cl.slice(-24, -12)), hi2 = Math.max(...cl.slice(-12));
    const lo1 = Math.min(...cl.slice(-24, -12)), lo2 = Math.min(...cl.slice(-12));
    if (fast > slow * 1.0005 && lo2 > lo1) return 'up';
    if (fast < slow * 0.9995 && hi2 < hi1) return 'down';
    return 'flat';
  } catch { return null; }
};
let fundMap = {};
try {
  const fj = JSON.parse(fs.readFileSync(path.join(API, 'funding.json'), 'utf8'));
  for (const r of fj.rows || fj.best || []) if (r.asset && Number.isFinite(+r.ratePct)) fundMap[r.asset + 'USDT'] = +r.ratePct;
} catch {}

const setupPath = path.join(STATE, 'cmd-setups.json');
const q = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
const setups = Array.isArray(q) ? q : (q.setups || []);
// live-mark anchoring (2026-11-12): signal px is a stale 1D/4H bar close —
// geometry computed off it fails the exec's netRR gate vs the live mark
// (ETH facx authored sl/tp off 2074 while mark was 1999 -> netRR 0.44 ->
// auto-rejected). Fetch the current ticker for every authored symbol.
const markCache = new Map();
const liveMark = async (sym) => {
  if (markCache.has(sym)) return markCache.get(sym);
  let px = null;
  try {
    const r = await fetch(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${sym}&productType=USDT-FUTURES`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    px = +(j?.data?.[0]?.lastPr) || null;
  } catch {}
  markCache.set(sym, px);
  return px;
};
let liveX = setups.filter((s) => String(s.id || '').startsWith('facx-') && s.status === 'armed').length;
if (liveX >= MAX_LIVE) { console.log('factory-x seats full: ' + liveX); process.exit(0); }

let authored = 0;
// metals same-beta guard (operator 2026-11-12): one macro bet = one seat.
// Skip authoring a metals setup whose direction is already held live or
// already armed by this lane — the exec's metals-dup veto would kill it
// at order time anyway; don't waste the queue slot.
const metalsHeldDir = new Set();
try {
  const w = JSON.parse(fs.readFileSync(path.join(API, 'wealth-live.json'), 'utf8'));
  for (const p of w?.futures?.positions || []) {
    const [sym, dir] = String(p.k || '').split(':');
    if (isMetal(sym)) metalsHeldDir.add(dir === 'short' ? 'short' : 'long');
  }
} catch {}
const metalsArmedDir = new Set();
for (const s of setups) {
  if (String(s.id || '').startsWith('facx-') && s.status === 'armed' && isMetal(s.symbol))
    metalsArmedDir.add(String(s.direction || '').toLowerCase());
}
const metalsBusy = (sym, side) => isMetal(sym) && (metalsHeldDir.has(side) || metalsArmedDir.has(side));
for (const sig of signals) {
  if (liveX + authored >= MAX_LIVE) break;
  const hit = ranked.find(([, b]) => b.tf === sig.tf && b.trig === sig.trig && b.side === sig.side);
  if (!hit) continue;
  const { trig, exit, side, g, tf } = hit[1];
  const sym = sig.sym;
  // SHORTS OFF (operator order 2026-11-12 — "my edge was always catch the
  // runners — longs almost always", manual record 1020L/7S): the factory's
  // promoted book is ~95% shorts and the base factory's shorts already
  // realized-convicted (SQN -2.25 live vs positive backtest). Same bet,
  // re-skinned. Env escape hatch if a short cell ever earns live proof.
  if (side === 'short' && process.env.SENTINEL_FACX_SHORTS !== '1') continue;
  // non-crypto cells must clear the overwhelming-evidence bar
  if (isNonCrypto(sym) && !(+g.sqn >= NON_CRYPTO_MIN_SQN)) continue;
  if (metalsBusy(sym, side)) continue;
  if (setups.some((s) => s.symbol === sym && s.status === 'armed' && String(s.id || '').startsWith('facx-'))) continue;
  // exec-identical admission: shorts need 4H 'down' + 1H not 'up' +
  // funding >= 0 (exec short-trend-rule ~4451); longs need live 4H data
  // that is not a confirmed downtrend.
  const h4 = htfTrend(sym, '4H');
  if (side === 'short') {
    const h1 = htfTrend(sym, '1h');
    const fr = fundMap[sym];
    if (h4 !== 'down' || h1 === 'up' || (fr != null && fr < 0)) continue;
  } else if (h4 == null || h4 === 'down') continue;
  // skip symbols the envelope has convicted — authoring setups that can
  // only die at DENY_SYMS wastes the queue (ETH/XRP/SOL facx all rejected
  // 'denied-symbol' 2026-11-12). Loser verdicts are symbol-wide.
  try {
    const envCells = JSON.parse(fs.readFileSync(path.join(STATE, 'deploy-envelope.json'), 'utf8'))?.cells || {};
    if (envCells[sym]?.verdict === 'loser') continue;
  } catch {}
  const e = (await liveMark(sym)) || sig.px, sgn = side === 'long' ? 1 : -1;
  const em = exit.match(/^(tp([\d.]+)-sl([\d.]+)|h(\d+)|atr([\d.]+))$/);
  if (!em) continue;
  let slPx, tps, ttlMin, note;
  if (em[2]) {           // tp{a}-sl{b}
    const tp = +em[2], sl = +em[3];
    slPx = +(e * (1 - sgn * sl / 100)).toPrecision(6);
    tps = [{ px: +(e * (1 + sgn * tp / 100)).toPrecision(6), pct: 85 }];
    ttlMin = tf === '4H' ? 2400 : 4320;
    note = `tp${tp}/sl${sl}`;
  } else if (em[4]) {    // h{n} time exit
    const h = +em[4];
    slPx = +(e * (1 - sgn * 0.08)).toPrecision(6);  // disaster stop only — cell had no stop
    // exec setup gate requires >=1 TP and netRR >= 1.0 — empty tps auto-
    // rejected EVERY h-exit probe (the top SQN cells: rs-lag3:h10 sqn 3.68
    // wr 66%, nr-comp:h5 sqn 4.51 wr 67.5%). Far TP at +9% vs 8% disaster
    // stop = netRR ~1.07; the K2 trail/time logic manages the real exit,
    // the TP exists so the seat can legally open.
    tps = [{ px: +(e * (1 + sgn * 0.09)).toPrecision(6), pct: 85 }];
    ttlMin = Math.round(h * (tf === '4H' ? 240 : 1440) * 0.9);
    note = `time-exit h${h} ${tf}`;
  } else continue;       // atr — skipped v1
  // pre-flight the exec's own netRR floor vs the live mark — cells whose
  // geometry can't clear SENTINEL_SETUP_MIN_RR (1.0) die at the gate;
  // don't author them (tp1/sl0.75-style tight-RR cells stay home)
  {
    const sp = (Math.abs(e - slPx) / e) * 100;
    const wsum = tps.reduce((a, t) => a + t.pct, 0);
    const tpct = tps.reduce((a, t) => a + (Math.abs(t.px - e) / e) * 100 * t.pct, 0) / Math.max(1, wsum);
    if (!((tpct - 0.20) / (sp + 0.20) >= 1.0)) continue;
  }
  setups.push({
    id: 'facx-' + sym + '-' + Date.now(), symbol: sym, direction: side.toUpperCase(),
    mode: 'market', entryPx: e, slPx, tps,
    pattern: 'facx:' + trig + ':' + exit,
    riskPct: PROBE_RISK, ttlMin, strategy: 'sqn-factory-x', auto: true,
    createdAt: Date.now(), blockedBy: null, status: 'armed',
    note: `sqn-factory-x ${trig}:${exit} ${side} ${note} — sqn ${g.sqn} wr ${g.wr}% n ${g.n} (${g.dirN}d) — backtest-promoted probe`,
  });
  if (isMetal(sym)) metalsArmedDir.add(side);
  authored++;
  console.log('AUTHORED', sym, side, trig, exit, 'sqn', g.sqn);
}
if (Array.isArray(q)) fs.writeFileSync(setupPath, JSON.stringify(setups, null, 1));
else { q.setups = setups; fs.writeFileSync(setupPath, JSON.stringify(q, null, 1)); }
console.log('authored ' + authored + ' factory-x setups (live ' + (liveX + authored) + '/' + MAX_LIVE + ')');
