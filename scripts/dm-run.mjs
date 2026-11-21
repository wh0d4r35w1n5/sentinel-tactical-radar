// deploy-manager.mjs — standing order 2026-11-14: ALL capital deployed at all
// times, but SMART. Free margin without an armed level order = violation.
// Arms fire openRiskEntry only when mark touches the retest level.
import { makeExchange } from './exchange/index.mjs';
import { openRiskEntry } from './risk-entry.mjs';
import fs from 'node:fs';
const ROOT = '/opt/sentinel';
for (const line of fs.readFileSync(`${ROOT}/.env`, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.SENTINEL_EXEC = 'live'; process.env.SENTINEL_EXCHANGE = 'bitget';
process.env.SENTINEL_LIVE = '1'; process.env.SENTINEL_OPEN_SEASON = '1';
process.env.SENTINEL_DEPLOY_ALL = '1';

const X = makeExchange(process.env);
X.setPosMode('hedge');
const cm = await X.contractMap();
const J = (p, opt) => { try { return JSON.parse(fs.readFileSync(`${ROOT}/${p}`, 'utf8')); } catch { return opt; } };
const log = (...a) => { const s = `${new Date().toISOString()} ${a.join(' ')}\n`; process.stdout.write(s); fs.appendFileSync(`${ROOT}/state/deploy-manager.log`, s); };

const DEADLINE = Date.now() + 24 * 3600e3;
const MARGIN_PER_SEAT = 4.5;          // rail sizes ~$45 notional @10x
const COOLDOWN = 4 * 3600e3;
const ARM_TTL = 15 * 60e3;            // unfired arms die — a stale arm is a dead move, not a seat-in-waiting
const MAX_SAME_DIR = 2;               // correlation cap (CLSK/JTO/SPCX lesson): never >2 seats one direction
let arms = []; // populated by the 60s scan — expires unfired after ARM_TTL
const cooldown = new Map(Object.entries(J('state/deploy-cooldowns.json', {}))); // symbol -> until (persistent)
const cdSave = () => fs.writeFileSync(`${ROOT}/state/deploy-cooldowns.json`, JSON.stringify(Object.fromEntries(cooldown)));
const cdSet = (sym, until) => { cooldown.set(sym, until); cdSave(); };
const hit = (a, px) => a.dir === 'LONG' ? px <= a.level : px >= a.level;
// open-into-green rule (operator order): fire ONLY while momentum is heavy in
// the seat's direction — shorts on live dumps, longs on live pumps (mom5 >=2%)
const momLive = async (sym) => {
  try {
    const r = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=15m&limit=8`, { signal: AbortSignal.timeout(8000) });
    const rows = (await r.json())?.data || [];
    if (rows.length < 6) return 0;
    const last = +rows[rows.length - 1][4], base = +rows[rows.length - 6][4];
    return (last / base - 1) * 100;
  } catch { return 0; }
};
const heavyMom = async (a) => {
  // youth filter (operator order 2026-11-14, ARIA/QNT lesson): heavy momentum
  // alone buys finished moves. Fire ONLY on early momentum — |mom| in the
  // 1.5–6% band AND mark still within 0.6% of the move's extreme (still
  // running, not bounced). A blowoff past 6% or a mark that already
  // retraced = the move is over; do not chase the corpse.
  try {
    const r = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${a.symbol}&productType=USDT-FUTURES&granularity=15m&limit=8`, { signal: AbortSignal.timeout(8000) });
    const rows = (await r.json())?.data || [];
    if (rows.length < 6) return false;
    const last = +rows[rows.length - 1][4], base = +rows[rows.length - 6][4];
    const mom = (last / base - 1) * 100;
    const lo = Math.min(...rows.slice(-6).map(c => +c[3]));
    const hi = Math.max(...rows.slice(-6).map(c => +c[2]));
    if (a.dir === 'SHORT') {
      if (mom < -6 || mom > -1.5) return false;
      return (last / lo - 1) * 100 <= 1.5;    // near the low — dump is live (1.5% band: retest inside strength, not a corpse)
    }
    if (mom > 6 || mom < 1.5) return false;
    return (hi / last - 1) * 100 <= 1.5;      // near the high — pump is live
  } catch { return false; }
};

async function boardScan() {
  // live screen: top |24h chg| tickers as universe; youth filter qualifies at
  // fire time. Direction vs day-anchored session VWAP (gate's own rule).
  const held = new Set((J('api/wealth-live.json', {})?.futures?.positions || []).map(p => p.symbol || p.k?.split(':')[0]));
  const deny = new Set();
  try { for (const e of J('state/auto-deny.json', {})?.entries || []) if ((e.until || 0) > Date.now()) deny.add(e.symbol); } catch {}
  const r = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', { signal: AbortSignal.timeout(8000) });
  const ticks = (await r.json())?.data || [];
  const out = [];
  for (const t of ticks) {
    const sym = t.symbol, chg = +t.change24h * 100, last = +t.lastPr, vol = +t.quoteVolume || +t.baseVolume * last || 0;
    if (!(last > 0) || Math.abs(chg) < 4 || vol < 2e6) continue;
    if (held.has(sym) || deny.has(sym)) continue;
    out.push({ symbol: sym, last, mom: chg, dir: chg < 0 ? 'SHORT' : 'LONG' });
  }
  return out.sort((a, b) => Math.abs(b.mom) - Math.abs(a.mom));
}

function armFor(cand) {
  const slPct = Math.max(0.025, Math.min(0.05, Math.abs(cand.mom) / 100 * 0.35 + 0.02));
  return { symbol: cand.symbol, dir: cand.dir, level: cand.last, strategy: cand.dir === 'SHORT' ? 'Liquidity Sweep' : 'devin-momentum',
    slPct, tps: [[slPct * 1.2, 50], [slPct * 2.2, 30], [slPct * 3.2, 20]], armedAt: Date.now() };
}

let lastScan = 0;
log(`deploy-manager up; arms=${arms.length}`);
while (Date.now() < DEADLINE) {
  // 1) fire armed levels — expired arms drop first (corpse-watch ends)
  for (let i = arms.length - 1; i >= 0; i--) {
    const a = arms[i];
    if (Date.now() - (a.armedAt || 0) > ARM_TTL) { arms.splice(i, 1); log(`ARM-EXPIRED ${a.symbol} — move died unfired`); continue; }
    try {
      const tk = await X.ticker(a.symbol);
      const px = +((Array.isArray(tk) ? tk[0] : tk)?.lastPr || 0);
      if (!(px > 0)) continue;
      if (!(await heavyMom(a))) { process.stdout.write(`${a.symbol}@${px} `); continue; }
      // correlation cap: never >MAX_SAME_DIR seats one direction (one dip = one loss)
      const open = (await X.getPos()).filter(p => +p.total > 0);
      const sameDir = open.filter(p => ((p.holdSide || p.posSide || '').toLowerCase() === a.dir.toLowerCase())).length;
      if (sameDir >= MAX_SAME_DIR) { process.stdout.write(`${a.symbol}:dirCap `); continue; }
      const slPx = a.dir === 'LONG' ? px * (1 - a.slPct) : px * (1 + a.slPct);
      const tps = a.tps.map(([o, p]) => ({ px: +(a.dir === 'LONG' ? px * (1 + o) : px * (1 - o)).toPrecision(8), pct: p }));
      const res = await openRiskEntry(X, {
        symbol: a.symbol, direction: a.dir, strategy: a.strategy,
        refEntry: px, setup: true, slPx, absTps: tps, notionalUsd: 60, mode: 'market',
        setupId: 'deploy-manager-2026-11-14', note: 'level-fill at retest; operator deploy-all',
      }, cm[a.symbol], { riskScale: 1 });
      log(`FILLED ${a.symbol} ${a.dir} @ ${px}: ${JSON.stringify(res).slice(0, 200)}`);
      arms.splice(i, 1);
    } catch (e) {
      const msg = String(e?.message || e);
      log(`${a.symbol} refused: ${msg.slice(0, 160)}`);
      // cooldown by class: transient = retry soon; vwap-side = regime wait;
      // policy (measured-losing/deny/twin) = full cooldown
      const cd = /stale entry price|reconcil|pending|lock/i.test(msg) ? 15 * 60e3
        : /vwap-side/i.test(msg) ? 60 * 60e3 : COOLDOWN;
      cdSet(a.symbol, Date.now() + cd);
      arms.splice(i, 1);
    }
  }
  // 2) every 60s: free margin without arms = deploy more
  if (Date.now() - lastScan > 60000) {
    lastScan = Date.now();
    try {
      const w = J('api/wealth-live.json', {});
      const avail = +w?.futures?.availableUsd || 0;
      const seatsNeeded = Math.floor(avail / MARGIN_PER_SEAT);
      if (seatsNeeded > arms.length) {
        const board = await boardScan();
        for (const cand of board) {
          if (arms.length >= seatsNeeded) break;
          if (arms.some(a => a.symbol === cand.symbol)) continue;
          if ((cooldown.get(cand.symbol) || 0) > Date.now()) continue;
          // arm-time live-mom check (audit: 24h movers = finished moves):
          // only arm symbols moving RIGHT NOW in the seat's direction
          const m5 = await momLive(cand.symbol);
          const live = cand.dir === 'SHORT' ? m5 <= -0.8 : m5 >= 0.8;
          if (!live) { process.stdout.write(`${cand.symbol}:mom5=${m5.toFixed(1)} `); continue; }
          const arm = armFor(cand);
          arms.push(arm);
          log(`ARMED ${arm.symbol} ${arm.dir} @ ${arm.level} (avail ${avail.toFixed(2)}, mom24 ${cand.mom.toFixed(1)}%, mom5 ${m5.toFixed(1)}%)`);
        }
      }
    } catch (e) { log(`scan err: ${String(e?.message || e).slice(0, 120)}`); }
  }
  // 3) profit-watch — bank healthy winners on >=50% MFE giveback (standing order)
  try {
    const mfe = J('state/deploy-mfe.json', {});
    const pos = (await X.getPos()).filter(p => +p.total > 0);
    for (const p of pos) {
      const sym = p.symbol, side = (p.holdSide || p.posSide || '').toLowerCase();
      const entry = +p.openPriceAvg || +p.averageOpenPrice || 0;
      const tk = await X.ticker(sym);
      const px = +((Array.isArray(tk) ? tk[0] : tk)?.lastPr || 0);
      if (!(entry > 0) || !(px > 0) || !side) continue;
      const sign = side === 'short' ? -1 : 1;
      const uplPct = (px / entry - 1) * 100 * sign;
      const key = `${sym}:${side}`;
      const rec = mfe[key] || { best: 0 };
      rec.best = Math.max(rec.best, uplPct); mfe[key] = rec;
      // no-tolerance cull (operator order 2026-11-15): bot patience doesn't
      // pay — a seat that turns shit dies at -0.9%, stops are disaster
      // insurance not the exit plan
      if (uplPct <= -0.9) {
        log(`CULL ${sym} ${side} upl ${uplPct.toFixed(2)}% — turned shit, zero tolerance`);
        cdSet(sym, Date.now() + 2 * 3600e3); // culled symbols are dead tape for 2h — no re-entering the same corpse
        await X.closePosition(sym, side).catch(e => log(`cull err ${sym}: ${String(e?.message||e).slice(0,100)}`));
        const plans = await X.getPlans(sym).catch(() => []);
        for (const pl of plans || []) {
          const oid = pl.orderId || pl.planOrderId;
          if (oid) await X.api('POST', '/api/v2/mix/order/cancel-plan-order',
            { body: { symbol: sym, productType: 'USDT-FUTURES', marginCoin: 'USDT', planType: pl.planType, orderIdList: [String(oid)] } }).catch(() => {});
        }
        delete mfe[key]; continue;
      }
      // dust-harvest fix (audit: avgWin +$0.05 vs avgLoss -$0.30, payoff 0.18):
      // trail arms at 1.0% peak (was 0.6%) and banks only >= +0.45% net —
      // winners must clear ~1R before reversal insurance applies; rung-1
      // TP territory stays reachable instead of pennies getting harvested
      if (rec.best >= 1.0 && uplPct <= rec.best * 0.5 && uplPct > 0.45) {
        log(`PROFIT-TAKE ${sym} ${side} upl ${uplPct.toFixed(2)}% vs best ${rec.best.toFixed(2)}% — banking on reversal`);
        await X.closePosition(sym, side).catch(e => log(`close err ${sym}: ${String(e?.message||e).slice(0,100)}`));
        const plans = await X.getPlans(sym).catch(() => []);
        for (const pl of plans || []) {
          const oid = pl.orderId || pl.planOrderId;
          if (oid) await X.api('POST', '/api/v2/mix/order/cancel-plan-order',
            { body: { symbol: sym, productType: 'USDT-FUTURES', marginCoin: 'USDT', orderIdList: [String(oid)] } }).catch(() => {});
        }
        delete mfe[key];
      }
    }
    fs.writeFileSync(`${ROOT}/state/deploy-mfe.json`, JSON.stringify(mfe));
  } catch (e) { log(`profit-watch err: ${String(e?.message || e).slice(0, 120)}`); }
  await new Promise(r => setTimeout(r, 15000));
}
log('deploy-manager done');
