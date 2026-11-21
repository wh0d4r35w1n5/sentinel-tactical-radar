// downtrend-watch — evidence-deployed downtrend-continuation short lane.
// 90d sim on 233 Bitget perps (daily bars, fees in): 15d-low break under an
// EMA20<EMA50 downtrend, SL +10% / TP -20% / max 15d hold => n=646,
// mean +2.04%/ep, WR 52.6%, SQN +4.56, positive both sample halves.
// Emits 'br'-mode SHORT setups: tape prints <= breakPx (the broken 15d low),
// then the short SELLS THE RETEST back to entryPx — never chases.
// Research gates baked in:
//  - funding veto: never short when funding < -0.03%/8h (crowded short =
//    squeeze fuel + we PAY carry)
//  - squeeze exclusion: median daily range >12% = squeezy, skip
//  - laggard-only: never shorts winners (rev-fade measured dead, sim + lit)
//  - emit cap 2/scan, 7d per-symbol cooldown, max 3 pending of this lane
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SETUPS = path.join(DIR, '..', 'state', 'cmd-setups.json');
const FIRED = path.join(DIR, '..', 'state', 'downtrend-fired.json');
const K15 = path.join(DIR, '..', 'state', 'klines-15m.json');
const HOST = 'https://api.bitget.com';

const LOOKBACK_LOW = +(process.env.DT_LOOKBACK || 15);   // 15d-low break (sim-best)
const SL_PCT = +(process.env.DT_SL_PCT || 10);           // sim SL
const TP_PCT = +(process.env.DT_TP_PCT || 20);           // sim TP
const RISK_PCT = +(process.env.DT_RISK_PCT || 1);
const TTL_MIN = +(process.env.DT_TTL_MIN || 2880);       // 48h for the retest
const COOLDOWN_MS = +(process.env.DT_COOLDOWN_D || 7) * 86400e3;
const MAX_EMIT = +(process.env.DT_MAX_EMIT || 2);
const MAX_PENDING = +(process.env.DT_MAX_PENDING || 3);
const MAX_RANGE_PCT = +(process.env.DT_MAX_RANGE_PCT || 12); // squeeze exclusion
const FUND_MIN = +(process.env.DT_FUND_MIN || -0.0003);  // -0.03%/8h crowded-short veto
const POLL_MS = +(process.env.DT_POLL_MS || 30 * 60e3);

const log = (...a) => console.log(`[downtrend-watch ${new Date().toISOString().slice(11, 19)}]`, ...a);
const fired = (() => { try { return JSON.parse(fs.readFileSync(FIRED, 'utf8')); } catch { return {}; } })();
const saveFired = () => { try { fs.writeFileSync(FIRED + '.tmp', JSON.stringify(fired)); fs.renameSync(FIRED + '.tmp', FIRED); } catch {} };
const readSetups = () => { try { return JSON.parse(fs.readFileSync(SETUPS, 'utf8')); } catch { return { setups: [] }; } };
const writeSetups = (sf) => { try { fs.writeFileSync(SETUPS + '.tmp', JSON.stringify(sf)); fs.renameSync(SETUPS + '.tmp', SETUPS); } catch {} };

const ema = (cl, n) => { const k = 2 / (n + 1); let e = cl[0]; for (const x of cl.slice(1)) e = x * k + e * (1 - k); return e; };

async function dailyBars(sym) {
  try {
    const r = await fetch(`${HOST}/api/v3/market/candles?category=USDT-FUTURES&symbol=${sym}&interval=1D&limit=70`,
      { signal: AbortSignal.timeout(9000) });
    const j = await r.json();
    let rows = (j.data || []).map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
    const today = new Date().setUTCHours(0, 0, 0, 0);
    if (rows.length && rows[rows.length - 1].t >= today) rows = rows.slice(0, -1); // drop forming bar
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

async function tick() {
  const now = Date.now();
  let universe = [];
  try { universe = Object.keys(JSON.parse(fs.readFileSync(K15, 'utf8'))); } catch {}
  const sf = readSetups();
  const pendThisLane = (sf.setups || []).filter((s) => s.strategy === 'downtrend-short'
    && !['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected'].includes(s.status)).length;
  const pendingSyms = new Set((sf.setups || []).filter((s) => !['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected'].includes(s.status)).map((s) => s.symbol));
  if (pendThisLane >= MAX_PENDING) { log(`${pendThisLane} downtrend setups pending — cap`); return; }
  let emitted = 0;
  for (const sym of universe) {
    if (emitted >= MAX_EMIT || pendThisLane + emitted >= MAX_PENDING) break;
    if (fired[sym] && now - fired[sym] < COOLDOWN_MS) continue;
    if (pendingSyms.has(sym)) continue;
    const bars = await dailyBars(sym);
    if (!bars || bars.length < 35) continue;
    const i = bars.length - 1;
    const cl = bars.map((b) => b.c);
    const e20 = ema(cl.slice(-25), 20), e50 = ema(cl, 50);
    const lowLB = Math.min(...bars.slice(-LOOKBACK_LOW - 1, -1).map((b) => b.l));
    if (!(cl[i] < e20 && e20 < e50 && cl[i] < lowLB)) continue;
    const rng = bars.slice(-20).map((b) => (b.h - b.l) / b.o * 100).sort((a, b) => a - b)[10];
    if (rng > MAX_RANGE_PCT) { log(`${sym} skipped — median daily range ${rng.toFixed(1)}% (squeeze risk)`); continue; }
    const fr = await fundRate(sym);
    if (fr != null && fr < FUND_MIN) { log(`${sym} skipped — funding ${(fr * 100).toFixed(3)}% (crowded short)`); continue; }
    const entryPx = +lowLB.toPrecision(6);
    const slPx = +(entryPx * (1 + SL_PCT / 100)).toPrecision(6);
    const tpPx = +(entryPx * (1 - TP_PCT / 100)).toPrecision(6);
    const id = `dt-${sym}-${now}`;
    sf.setups = (sf.setups || []).filter((s) => s.status !== 'expired').slice(-120);
    sf.setups.push({
      id, symbol: sym, direction: 'SHORT', mode: 'br',
      breakPx: entryPx, entryPx,
      slPx, tps: [{ px: tpPx, pct: 100 }],
      riskPct: RISK_PCT, ttlMin: TTL_MIN,
      strategy: 'downtrend-short',
      createdAt: new Date(now).toISOString(),
      note: `downtrend-short — close<EMA20<EMA50 + ${LOOKBACK_LOW}d-low break ${lowLB.toPrecision(6)} · sell retest ${entryPx} · SL +${SL_PCT}% · TP -${TP_PCT}% · 90d sim n=646 SQN+4.56 mean+2.0%/ep`,
    });
    writeSetups(sf);
    fired[sym] = now; saveFired();
    emitted++;
    log(`FIRED ${sym} SHORT — ${LOOKBACK_LOW}d low ${lowLB.toPrecision(6)} broken · retest entry ${entryPx} · SL ${slPx} · TP ${tpPx} · range ${rng.toFixed(1)}% · funding ${fr == null ? 'n/a' : (fr * 100).toFixed(3) + '%'} → setup ${id}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!emitted) log('scan — no qualified downtrend shorts');
}

(async () => {
  log(`armed — ${LOOKBACK_LOW}d-low break under EMA20<50 · SL+${SL_PCT}% TP-${TP_PCT}% · emit cap ${MAX_EMIT}/scan · funding veto ${FUND_MIN} · range cap ${MAX_RANGE_PCT}%`);
  for (;;) {
    await tick().catch((e) => log('tick err', e.message?.slice(0, 120)));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
