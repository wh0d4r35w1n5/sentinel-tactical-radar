// swing-shorts-watch — evidence-deployed daily-signal short lane.
// Three families, all re-validated on ~720 syms with the post-Oct-1 window
// REMOVED (pre-crash-only grade — cannot be today-biased):
//
//  rsi-fade    1D RSI(14) >= 90            → SHORT  SL+8%  TP−15%
//              pre-Oct1: SQN 8.73 (gt95: 11.52) · mean +12.5%/ep · WR ~72%
//  mom-decay   chg20 >= +5% && chg5 < 0 && ema20>ema50 → SHORT  SL+6% TP−12%
//              stalling rally inside an uptrend → mean-revert. SQN 6.66
//  laggard-cont chg60 <= −12% && ema20>ema50 → SHORT  SL+10% TP−20%
//              bleeder inside technical uptrend keeps bleeding.
//              tp20-sl10 grid variant: SQN 5.48 · WR47% · +1.9%/ep
//
// Entry mode 'bounce' at last close = touch-fill ≈ immediate (sim enters
// at next open after the daily signal prints; the forming bar is dropped
// so signals are on CLOSED daily bars only). TTL 6h — a daily signal not
// touched within hours is stale.
// Same research rails as downtrend-watch:
//  - funding veto: never short when funding < −0.03%/8h (crowded = squeeze fuel)
//  - squeeze exclusion: median daily range > 12% skip
//  - emit cap 2/scan, per-lane cap 3 pending, 7d per-lane per-symbol cooldown
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SETUPS = path.join(DIR, '..', 'state', 'cmd-setups.json');
const FIRED = path.join(DIR, '..', 'state', 'swing-fired.json');
const K15 = path.join(DIR, '..', 'state', 'klines-15m.json');
const HOST = 'https://api.bitget.com';

const RISK_PCT = +(process.env.SW_RISK_PCT || 1);
const TTL_MIN = +(process.env.SW_TTL_MIN || 360);
const COOLDOWN_MS = +(process.env.SW_COOLDOWN_D || 7) * 86400e3;
const MAX_EMIT = +(process.env.SW_MAX_EMIT || 2);
const MAX_PENDING = +(process.env.SW_MAX_PENDING || 3);
const MAX_RANGE_PCT = +(process.env.SW_MAX_RANGE_PCT || 12);
const FUND_MIN = +(process.env.SW_FUND_MIN || -0.0003);
const POLL_MS = +(process.env.SW_POLL_MS || 30 * 60e3);
const RSI_MIN = +(process.env.SW_RSI_MIN || 90);
const MD_MOM20 = +(process.env.SW_MD_MOM20 || 5);      // % — rally leg
const MD_MOM5 = +(process.env.SW_MD_MOM5 || 0);        // % — stall leg (<0)
const LC_MOM60 = +(process.env.SW_LC_MOM60 || -12);    // % — laggard depth

const LANES = [
  { name: 'sqn-rsi-fade',    sl: 8,  tp: 15, note: '1D RSI>=' + RSI_MIN + ' fade — sim SQN 8.7-11.5 n=553 WR72% +12.5%/ep' },
  { name: 'sqn-mom-decay',   sl: 6,  tp: 12, note: 'stalled rally (mom20>+' + MD_MOM20 + '%, mom5<0) — sim SQN 6.7 +5.4%/ep' },
  { name: 'sqn-laggard-cont', sl: 10, tp: 20, note: 'uptrend laggard (mom60<' + LC_MOM60 + '%) — sim SQN 5.5-9.1 tp20sl10 WR47%' },
];

const log = (...a) => console.log(`[swing-shorts ${new Date().toISOString().slice(11, 19)}]`, ...a);
const fired = (() => { try { return JSON.parse(fs.readFileSync(FIRED, 'utf8')); } catch { return {}; } })();
const saveFired = () => { try { fs.writeFileSync(FIRED + '.tmp', JSON.stringify(fired)); fs.renameSync(FIRED + '.tmp', FIRED); } catch {} };
const readSetups = () => { try { return JSON.parse(fs.readFileSync(SETUPS, 'utf8')); } catch { return { setups: [] }; } };
const writeSetups = (sf) => { try { fs.writeFileSync(SETUPS + '.tmp', JSON.stringify(sf)); fs.renameSync(SETUPS + '.tmp', SETUPS); } catch {} };

const ema = (cl, n) => { const k = 2 / (n + 1); let e = cl[0]; for (const x of cl.slice(1)) e = x * k + e * (1 - k); return e; };
const rsi = (cl, n = 14) => {
  if (cl.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = cl.length - n; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + (g / n) / (l / n));
};
const pct = (a, b) => (a / b - 1) * 100;

async function dailyBars(sym) {
  try {
    const r = await fetch(`${HOST}/api/v3/market/candles?category=USDT-FUTURES&symbol=${sym}&interval=1D&limit=75`,
      { signal: AbortSignal.timeout(9000) });
    const j = await r.json();
    let rows = (j.data || []).map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
    const today = new Date().setUTCHours(0, 0, 0, 0);
    if (rows.length && rows[rows.length - 1].t >= today) rows = rows.slice(0, -1); // closed bars only
    return rows;
  } catch { return null; }
}

async function fundRate(sym) {
  try {
    const r = await fetch(`${HOST}/api/v3/market/current-fund-rate?category=USDT-FUTURES&symbol=${sym}`,
      { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const d = Array.isArray(j.data) ? j.data[0] : j.data;
    return d?.fundingRate != null ? +d.fundingRate : null;
  } catch { return null; }
}

const TERMINAL = new Set(['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected']);

async function tick() {
  const now = Date.now();
  let universe = [];
  try { universe = Object.keys(JSON.parse(fs.readFileSync(K15, 'utf8'))); } catch {}
  const laneNames = new Set(LANES.map((l) => l.name));
  const sf = readSetups();
  const pending = (sf.setups || []).filter((s) => !TERMINAL.has(s.status));
  const pendLane = (n) => pending.filter((s) => s.strategy === n).length;
  const pendingSyms = new Set(pending.map((s) => s.symbol));
  if ([...laneNames].every((n) => pendLane(n) >= MAX_PENDING)) { log('all lanes at pending cap'); return; }
  let emitted = 0;
  for (const sym of universe) {
    if (emitted >= MAX_EMIT) break;
    if (pendingSyms.has(sym)) continue;
    const bars = await dailyBars(sym);
    if (!bars || bars.length < 65) continue;
    const i = bars.length - 1;
    const cl = bars.map((b) => b.c);
    const e20 = ema(cl.slice(-25), 20), e50 = ema(cl, 50);
    const inUp = e20 > e50;
    const chg5 = pct(cl[i], cl[i - 5]), chg20 = pct(cl[i], cl[i - 20]), chg60 = pct(cl[i], cl[i - 60]);
    const r = rsi(cl);

    // pick the highest-evidence lane that fires on this symbol
    let lane = null;
    if (r != null && r >= RSI_MIN) lane = LANES[0];
    else if (inUp && chg20 >= MD_MOM20 && chg5 < MD_MOM5) lane = LANES[1];
    else if (inUp && chg60 <= LC_MOM60) lane = LANES[2];
    if (!lane) continue;

    const key = `${lane.name}:${sym}`;
    if (fired[key] && now - fired[key] < COOLDOWN_MS) continue;
    if (pendLane(lane.name) + emitted >= MAX_PENDING) continue;

    const rng = bars.slice(-20).map((b) => (b.h - b.l) / b.o * 100).sort((a, b) => a - b)[10];
    if (rng > MAX_RANGE_PCT) { log(`${sym} ${lane.name} skipped — median range ${rng.toFixed(1)}% (squeeze risk)`); continue; }
    const fr = await fundRate(sym);
    if (fr != null && fr < FUND_MIN) { log(`${sym} ${lane.name} skipped — funding ${(fr * 100).toFixed(3)}% (crowded short)`); continue; }

    const entryPx = +cl[i].toPrecision(6);
    const slPx = +(entryPx * (1 + lane.sl / 100)).toPrecision(6);
    const tpPx = +(entryPx * (1 - lane.tp / 100)).toPrecision(6);
    const id = `${lane.name.replace('sqn-', 'sw-')}-${sym}-${now}`;
    sf.setups = (sf.setups || []).filter((s) => s.status !== 'expired').slice(-120);
    sf.setups.push({
      id, symbol: sym, direction: 'SHORT', mode: 'bounce',
      entryPx, slPx, tps: [{ px: tpPx, pct: 100 }],
      riskPct: RISK_PCT, ttlMin: TTL_MIN,
      strategy: lane.name,
      createdAt: new Date(now).toISOString(),
      note: `${lane.name} — rsi=${r?.toFixed(0)} mom5=${chg5.toFixed(1)}% mom20=${chg20.toFixed(1)}% mom60=${chg60.toFixed(1)}% emaUp=${inUp} · sell ${entryPx} · SL +${lane.sl}% · TP -${lane.tp}% · ${lane.note}`,
    });
    writeSetups(sf);
    fired[key] = now; saveFired();
    emitted++;
    log(`FIRED ${sym} ${lane.name} — rsi=${r?.toFixed(0)} mom20=${chg20.toFixed(1)}% mom60=${chg60.toFixed(1)}% · entry ${entryPx} SL ${slPx} TP ${tpPx} · funding ${fr == null ? 'n/a' : (fr * 100).toFixed(3) + '%'} → ${id}`);
    await new Promise((r2) => setTimeout(r2, 300));
  }
  saveFired();
  if (!emitted) log('scan — no qualified swing signals');
}

(async () => {
  log(`armed — 3 daily-signal short lanes · emit cap ${MAX_EMIT}/scan · per-lane pending ${MAX_PENDING} · funding veto ${FUND_MIN} · range cap ${MAX_RANGE_PCT}%`);
  for (;;) {
    try { await tick(); } catch (e) { log(`tick error: ${e.message}`); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
