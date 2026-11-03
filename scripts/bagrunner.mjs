#!/usr/bin/env node
// bagrunner.mjs — lightning ignition engine (operator order: "always
// running at lightning speed, hive-mind tidal-wave data, always winning
// as bagrunners — crackwhore thesis").
//
// Every ~4s: pull the full public ticker board, keep a rolling
// velocity/acceleration window per symbol, fuse it with the hive layer
// (liq-intel buy/sell flow + 15m liquidation tide per symbol), score
// ignition = velocity × flow-imbalance × short-liq fuel − long-liq drag
// − chase penalty − thin-board penalty. Top scorer above the floor gets
// a bounded LONG seat: isolated margin, band-fit leverage, market entry
// with an exchange-side pos_loss stop placed in the same breath — never
// naked (a TPSL failure closes the seat immediately). The seat is
// journaled to state/bagrunner-seats.json, which liq-guard reads —
// those seats then ride the full BAGRUNNER trail: fee-lock at +0.18%
// (can't close red past it), dense greedy tiers, fast vanish.
// "Always winning" is mechanical, not hopeful.
//
// Rails that still ride: longs-only, deny/auto-deny/manual-hold/
// manual-book, armed-setup dedupe, per-symbol cooldown after a close,
// 2-loss quarantine, global seat cap, equity floor, min-notional,
// isolated margin, kill file, engine-wide sleep after 3 straight losses.
// Every seat is journaled — the ledger's Kelly/CUSUM verdicts apply to
// this engine's record like any other cell.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import './load-env.mjs'; // canonical .env loader — same as exec
import { makeExchange } from './exchange/index.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, '..', 'state');
const API_DIR = path.join(__dirname, '..', 'api');
const rj = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return fb; } };
const rjApi = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(API_DIR, f), 'utf8')); } catch { return fb; } };
const wj = (f, d) => { try { const t = path.join(STATE, f + '.tmp'); fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, path.join(STATE, f)); } catch { /* state write best-effort */ } };

const MS = +(process.env.BAGRUNNER_MS || 4000);
const MAX_SEATS = +(process.env.BAGRUNNER_SEATS || 2);
const MARGIN_USD = +(process.env.BAGRUNNER_MARGIN_USD || 2.0);
const LEV = Math.max(20, +(process.env.BAGRUNNER_LEV || 25)); // min-lev law
const STOP_PCT = +(process.env.BAGRUNNER_STOP_PCT || 0.9);
const TP_PCT = +(process.env.BAGRUNNER_TP_PCT || 1.3);
const TP_FRAC = +(process.env.BAGRUNNER_TP_FRAC || 0.4);
const EQ_FLOOR = +(process.env.BAGRUNNER_EQ_FLOOR_USD || 25);
const DEAD_MS = +(process.env.BAGRUNNER_DEAD_MS || 90e3);        // dead-impulse cut
const DEAD_FAV = +(process.env.BAGRUNNER_DEAD_FAV || -0.20);    // % underwater → cut
const MIN_SCORE = +(process.env.BAGRUNNER_MIN_SCORE || 62);
const VEL_MIN = +(process.env.BAGRUNNER_VEL_MIN || 0.10);      // % over window
const CHASE_MAX = +(process.env.BAGRUNNER_CHASE_MAX || 2.0);   // % above window low
const CD_MS = +(process.env.BAGRUNNER_COOLDOWN_MS || 45 * 60e3);
const QUAR_MS = +(process.env.BAGRUNNER_QUAR_MS || 6 * 3600e3);
const SLEEP_MS = +(process.env.BAGRUNNER_SLEEP_MS || 30 * 60e3);
const WIN_N = +(process.env.BAGRUNNER_WIN_N || 12);            // ~48s at 4s
const TICK_URL = 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES';
const LIVE = (process.env.SENTINEL_EXEC || '').toLowerCase() === 'live' && process.env.SENTINEL_LIVE === '1' && process.env.CONFIRM_LIVE === 'YES';

const X = makeExchange(process.env);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- persistent engine state ----------
let st = rj('bagrunner-seats.json', null) || {};
st.seats = st.seats || {};
st.cooldowns = st.cooldowns || {};
st.lossStreak = st.lossStreak || {};
st.quarantine = st.quarantine || {};
st.stats = st.stats || { opens: 0, wins: 0, losses: 0, netUsd: 0 };
st.history = st.history || [];
const save = () => { st.at = Date.now(); st.syms = Object.keys(st.seats); wj('bagrunner-seats.json', st); };
const hist = (ev) => { st.history.push({ t: Date.now(), ...ev }); st.history = st.history.slice(-60); };

// ---------- rolling price windows ----------
const win = new Map();    // sym -> [{t,p}]
const prevVel = new Map();// sym -> last computed vel
const note = (sym, p) => {
  let w = win.get(sym); if (!w) { w = []; win.set(sym, w); }
  w.push({ t: Date.now(), p }); while (w.length > WIN_N) w.shift();
};

const ignite = (sym, ctx) => {
  const w = win.get(sym); if (!w || w.length < 5) return null;
  const first = w[0].p, last = w[w.length - 1].p;
  if (!(first > 0 && last > 0)) return null;
  const vel = (last - first) / first * 100;
  const prev = prevVel.get(sym) || 0;
  const acc = vel - prev;
  prevVel.set(sym, vel);
  const winLow = Math.min(...w.map((x) => x.p));
  const chase = (last - winLow) / winLow * 100;
  let score = 50 + vel * 28 + Math.max(0, acc) * 12 + Math.max(-4, Math.min(14, ctx.dayPct)) * 1.3;
  if (ctx.flow) { const fb = ctx.flow.buy + ctx.flow.sell; if (fb > 0) score += (ctx.flow.delta / fb) * 18; }
  if (ctx.liq) {
    score += Math.min(8, Math.log1p((ctx.liq.short || 0) / 5e3) * 2.5); // shorts rekt = fuel
    score -= Math.min(10, Math.log1p((ctx.liq.long || 0) / 5e3) * 3);   // longs rekt = knife
  }
  if (chase > CHASE_MAX) score -= 20;
  if (ctx.volUsd < 5e6) score -= 25; else if (ctx.volUsd < 15e6) score -= 6;
  if (ctx.dayPct < -4) score -= 15;
  return { score, vel, acc, chase, dayPct: ctx.dayPct };
};

// ---------- gate helpers ----------
const symSet = (file, keys = ['syms', 'deny', 'symbols', 'mints']) => {
  const d = rj(file, null); if (!d) return new Set();
  for (const k of keys) if (Array.isArray(d[k])) return new Set(d[k]);
  return new Set();
};

let cm = {};
async function boot() {
  try { cm = await X.contractMap(); } catch (e) { log('contractMap err', e.message); }
  try { const pm = await X.getPosMode('BTCUSDT'); X.setPosMode(pm); log('posMode:', pm); } catch { }
  log(`bagrunner up — ${LIVE ? 'LIVE' : 'SHADOW'} · ${MS}ms · seats<=${MAX_SEATS} · margin $${MARGIN_USD} · lev ${LEV}x · stop ${STOP_PCT}% · score>=${MIN_SCORE}`);
}

async function equity() {
  const w = rjApi('wealth-live.json', null);
  const eq = +(w?.futures?.equityOwnUsd || 0);
  if (eq > 0) return eq;
  try { const a = await X.getAccount(); return +(a.equity || 0); } catch { return 0; }
}

async function tick() {
  const t0 = Date.now();
  // kill file — operator off-switch
  if (fs.existsSync(path.join(STATE, 'bagrunner-off.json'))) { wj('bagrunner-heartbeat.json', { at: Date.now(), paused: 'kill-file' }); return; }
  if (st.sleepUntil && Date.now() < st.sleepUntil) { wj('bagrunner-heartbeat.json', { at: Date.now(), paused: 'sleep', until: st.sleepUntil }); return; }

  // --- hive feed: whole board tick + liq-intel flow/liq context ---
  let ticks = [];
  try {
    const r = await fetch(TICK_URL, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    ticks = Array.isArray(d?.data) ? d.data : [];
  } catch (e) { wj('bagrunner-heartbeat.json', { at: Date.now(), err: 'tick ' + String(e.message).slice(0, 80) }); return; }
  const intel = rjApi('liq-intel.json', null);
  const intelFresh = intel && Date.now() - (+intel.ts || 0) < 5 * 60e3;
  const isyms = intel?.symbols || {};

  const px = new Map();
  for (const t of ticks) {
    const s = t.symbol, p = +t.lastPr;
    if (!(p > 0)) continue;
    px.set(s, p); note(s, p);
  }
  const tmap = new Map(ticks.map((t) => [t.symbol, t]));

  // --- exchange truth: positions + seats bookkeeping ---
  let pos = [];
  try { pos = await X.getPos(); } catch (e) { log('getPos err', e.message); return; }
  const posBySym = new Map(pos.map((p) => [p.symbol + ':' + p.holdSide, p]));

  // close detection — seat sym gone from positions
  let closedAny = false;
  let fills = null;
  for (const sym of Object.keys(st.seats)) {
    if (!posBySym.has(sym + ':long')) {
      const seat = st.seats[sym];
      // fill truth beats ticker approximation — the close fill carries the
      // real exit price + realized profit (a fee-locked stop fills green
      // even when the last observed mark reads flat).
      let exitPx = px.get(sym) || seat.lastPx || seat.entry, exitPnl = null;
      try {
        if (!fills) fills = await X.getFills();
        const f = (fills || []).filter((x) => x.symbol === sym && /close|reduce/i.test(String(x.tradeSide || '') + String(x.side || ''))).pop()
          || (fills || []).filter((x) => x.symbol === sym).pop();
        if (f) { exitPx = +f.price || exitPx; if (f.profit != null && f.profit !== '') exitPnl = +f.profit; }
      } catch { }
      const pnl = exitPnl != null ? exitPnl
        : seat.entry > 0 ? (exitPx - seat.entry) / seat.entry * (seat.notionalUsd || seat.marginUsd * (seat.lev || LEV)) : 0;
      const winTrade = pnl > 0.001;
      st.stats[winTrade ? 'wins' : 'losses'] += 1;
      st.stats.netUsd = +(st.stats.netUsd + pnl).toFixed(4);
      st.cooldowns[sym] = Date.now() + CD_MS;
      if (!winTrade) {
        st.lossStreak[sym] = (st.lossStreak[sym] || 0) + 1;
        st.consecLoss = (st.consecLoss || 0) + 1;
        if (st.lossStreak[sym] >= 2) { st.quarantine[sym] = Date.now() + QUAR_MS; st.lossStreak[sym] = 0; }
        if (st.consecLoss >= 3) { st.sleepUntil = Date.now() + SLEEP_MS; st.consecLoss = 0; hist({ ev: 'sleep', why: '3 consec losses' }); }
      } else { st.lossStreak[sym] = 0; st.consecLoss = 0; }
      hist({ ev: 'close', sym, entry: seat.entry, last: exitPx, pnlUsd: +pnl.toFixed(3), win: winTrade });
      log(`${winTrade ? '✅' : '❌'} seat closed ${sym} entry ${seat.entry} exit ${exitPx} $${pnl.toFixed(3)}`);
      delete st.seats[sym]; closedAny = true;
    } else if (px.get(sym)) { st.seats[sym].lastPx = px.get(sym); }
  }
  if (closedAny) save();

  // --- dead-impulse cut: a seat still underwater at DEAD_MS is a failed
  // impulse — close it at ~-0.2% instead of donating the full -0.9% stop.
  // Crackwhore doctrine: losers die fast and cheap. (Fee-lock greens are
  // immune — this only fires while the seat is red.)
  for (const [sym, seat] of Object.entries(st.seats)) {
    const p = px.get(sym); if (!p || !seat.openedAt) continue;
    const age = Date.now() - seat.openedAt;
    const fav = (p - seat.entry) / seat.entry * 100;
    if (age >= DEAD_MS && fav <= DEAD_FAV) {
      log(`✂️ dead-impulse cut ${sym} fav ${fav.toFixed(2)}% age ${Math.round(age / 1e3)}s — closing before the full stop`);
      hist({ ev: 'dead-cut', sym, fav: +fav.toFixed(2), ageS: Math.round(age / 1e3) });
      try { await X.closePosition(sym, 'long'); } catch (e) { log('cut err', String(e.message).slice(0, 90)); }
      // next tick's close-detection journals it
    }
  }

  // --- the household: Genius's deploy-envelope is the single deployment
  // authority (Will-audit: one risk system, not five competing gates). It
  // composes brake + Wife + measured cell edge every 45s. Stale/absent →
  // the legacy file reads are the degraded fallback.
  let env = null;
  try { const e = rj('deploy-envelope.json', null); if (e && Date.now() - +e.at < 180e3) env = e; } catch { }
  const feeBrake = rj('fee-brake.json', null);
  const brakeOn = env ? !!env.brake : !!feeBrake?.brake;
  const wifeMood = env ? +(env.wifeMood || 0) : +(rj('wife.json', null)?.mood || 0);
  // the house NEVER empties the book — operator order. Wife fury doesn't
  // close the door, it raises the bar: only top-conviction ignitions
  // (the recovery crew) may enter while she's furious — a flat book
  // can't recover the balance she's screaming about.
  const furyScore = wifeMood >= 3 ? 85 : 0;
  const effScore = env ? Math.max(+(env.deploy?.engineMinScore || MIN_SCORE), furyScore) : Math.max(MIN_SCORE + (brakeOn ? 15 : 0), furyScore);
  const effMargin = env ? MARGIN_USD * +(env.deploy?.marginMult ?? 1) : (brakeOn ? MARGIN_USD / 2 : MARGIN_USD);
  const effSeats = env ? +(env.deploy?.seatCap ?? MAX_SEATS) : (brakeOn || wifeMood >= 3 ? 1 : MAX_SEATS);
  const envCells = env?.cells || {};
  const envFam = env?.families || {};
  const envTwins = env?.twinOf || {};
  const canon = (s) => envTwins[s] || s;
  const famCap = +(env?.deploy?.familyCap || 0);

  // --- gates ---
  const eq = await equity();
  const gated = { floor: eq < EQ_FLOOR, seats: Object.keys(st.seats).length >= effSeats, brake: brakeOn, wife: wifeMood, effScore };
  const deny = new Set([...symSet('cmd-deny.json'), ...symSet('auto-deny.json'), 'USELESSUSDT']);
  const hands = new Set([...symSet('manual-book.json'), ...symSet('cmd-manual-hold.json'), ...Object.keys(st.seats)]);
  const armed = new Set((rj('cmd-setups.json', { setups: [] }).setups || []).filter((s) => /arm|trigger|queue/i.test(s.status || '')).map((s) => s.symbol));
  const openSyms = new Set(pos.map((p) => p.symbol));
  const openCanon = new Set(pos.map((p) => canon(p.symbol)));
  // one family = one bet: an ignition seat is an impulse chase — stacking
  // it onto an already-open cluster (SOXL+SNDK+MU bled -$4.5 as one trade)
  // is concentration, not deployment.
  const famCount = {};
  const famSeen = new Set();
  if (famCap > 0) for (const p of pos) {
    const cs = canon(p.symbol); if (famSeen.has(cs)) continue; famSeen.add(cs);
    const f = envFam[cs] || envFam[p.symbol]; if (f) famCount[f] = (famCount[f] || 0) + 1;
  }
  // scanner momentum per symbol — the chase gate's fuel
  const momBySym = {};
  try {
    const ms = rjApi('market-scanner.json', null);
    for (const s of (ms?.signals || [])) {
      const sym = /USDT$/.test(s.symbol || '') ? s.symbol : String(s.symbol || '').replace(/USD$/, 'USDT');
      if (sym && s.momScore != null) momBySym[sym] = +s.momScore;
    }
  } catch { }

  // --- score the board ---
  let best = null;
  const top = [];
  for (const [s, p] of px) {
    const t = tmap.get(s);
    if (!t) continue;
    const volUsd = +t.quoteVolume || +t.usdtVolume || 0;
    const dayPct = +t.change24h || +t.changeUtc24h || 0;
    const it = isyms[s] || {};
    const g = ignite(s, { dayPct, volUsd, flow: intelFresh ? it.flow15m : null, liq: intelFresh ? it.liq15m : null });
    if (!g) continue;
    // measured evidence rides the score: proven cells (positive realized
    // expectancy over the fill journal) get a lighter bar; loser cells are
    // skipped outright — chasing ignition in a cell that demonstrably
    // bleeds is paying fees to lose.
    const cellV = envCells[s]?.verdict || envCells[canon(s)]?.verdict;
    if (cellV === 'proven') g.score += 8;
    // mc-million sweep: mom>=70 entries are the bleed cells — the engine
    // ignites INTO extended moves; gate the chase, bonus the pullback.
    const mom = momBySym[s];
    if (mom != null && mom >= 70) continue;
    if (mom != null && mom < 55) g.score += 8;
    if (top.length < 6 || g.score > top[top.length - 1].s) { top.push({ s, sc: +g.score.toFixed(1), v: +g.vel.toFixed(2) }); top.sort((a, b) => b.sc - a.sc); top.length = Math.min(top.length, 6); }
    const cellLossAt = Math.max(envCells[s]?.lastLossAt || 0, envCells[canon(s)]?.lastLossAt || 0);
    const skip = deny.has(s) || hands.has(s) || armed.has(s) || openSyms.has(s) || openCanon.has(canon(s))
      || cellV === 'loser'
      || (cellLossAt && Date.now() - cellLossAt < 45 * 60e3)
      || (famCap > 0 && (envFam[s] || envFam[canon(s)]) && (famCount[envFam[s] || envFam[canon(s)]] || 0) >= famCap)
      || (st.cooldowns[s] || 0) > Date.now() || (st.quarantine[s] || 0) > Date.now() || (st.quarantine[canon(s)] || 0) > Date.now();
    if (skip) continue;
    if (g.score >= effScore && g.vel >= VEL_MIN && g.chase <= CHASE_MAX && g.dayPct > -4 && (!best || g.score > best.g.score)) best = { sym: s, px: p, g };
  }

  wj('bagrunner-heartbeat.json', {
    at: Date.now(), tickMs: Date.now() - t0, mode: LIVE ? 'live' : 'shadow',
    seats: Object.keys(st.seats), equity: +eq.toFixed(2), gated,
    top: top.slice(0, 4), candidate: best ? { sym: best.sym, sc: +best.g.score.toFixed(1), vel: +best.g.vel.toFixed(2) } : null,
  });

  if (!best || gated.floor || gated.seats) return;
  // Ignition is unqualified. Even an accidental service restart cannot route
  // orders around the shared entry firewall. Keep observations shadow-only.
  if (LIVE) {
    hist({ ev: 'shadow-only', sym: best.sym, reason: 'no validated canonical entry model' });
    return;
  }

  // --- fire: bounded seat, stop attached in the same breath ---
  const c = cm[best.sym] || {};
  const sp = Math.pow(10, +(c.sizePlace ?? 4));
  const pp = Math.pow(10, +(c.pricePlace ?? 6));
  const notional = effMargin * LEV;
  let size = Math.floor((notional / best.px) * sp) / sp;
  const minSz = Math.max(+c.minTradeNum || 0, (+c.minTradeUSDT || 0) / best.px);
  if (size < minSz) { hist({ ev: 'skip-min', sym: best.sym, size, minSz }); return; }

  log(`🎯 ignition ${best.sym} score ${best.g.score.toFixed(1)} vel ${best.g.vel.toFixed(2)}% day ${best.g.dayPct.toFixed(1)}% → ${LIVE ? 'FIRE' : 'shadow'} $${effMargin}×${LEV}${brakeOn ? ' (brake)' : ''}`);
  hist({ ev: 'fire', sym: best.sym, px: best.px, score: +best.g.score.toFixed(1), vel: +best.g.vel.toFixed(3), live: LIVE });
  if (!LIVE) return;

  try {
    await X.setIsolated(best.sym);
    // low-liquidity contracts cap max lev (40797) — walk the ladder down
    // like the exec's 40940 handling until one lands; sizing re-derives
    // notional off the accepted lev so the margin slice stays constant.
    let levUsed = 0;
    for (const lv of [LEV, 20, 15, 10, 5, 2]) {
      try { await X.setLeverage(best.sym, lv); levUsed = lv; break; } catch { }
    }
    if (!levUsed) throw new Error('set-leverage refused at every rung');
    const notional2 = effMargin * levUsed;
    size = Math.floor((notional2 / best.px) * sp) / sp;
    if (size < minSz) { hist({ ev: 'skip-min', sym: best.sym, size, minSz, levUsed }); return; }
    await X.marketOrder(best.sym, 'buy', size, 'open', { clientOid: `bagr-${Date.now()}`.slice(0, 38) });
    const pos2 = (await X.getPos()).find((p) => p.symbol === best.sym && p.holdSide === 'long');
    const entry = +pos2?.openPriceAvg || best.px;
    const realSize = +pos2?.total || size;
    const stopPx = Math.round(entry * (1 - STOP_PCT / 100) * pp) / pp;
    await X.planOrder(best.sym, 'pos_loss', stopPx, null, 'long', pos2?.marginMode || 'isolated');
    st.seats[best.sym] = { entry, size: realSize, marginUsd: +(notional2 / levUsed).toFixed(3), notionalUsd: +(realSize * entry).toFixed(2), lev: levUsed, openedAt: Date.now(), stopPx, score: +best.g.score.toFixed(1) };
    const tpSize = Math.floor(realSize * TP_FRAC * sp) / sp;
    if (tpSize >= minSz) {
      const tpPx = Math.round(entry * (1 + TP_PCT / 100) * pp) / pp;
      await X.planOrder(best.sym, 'profit_plan', tpPx, String(tpSize), 'long', pos2?.marginMode || 'isolated');
      st.seats[best.sym].tpPx = tpPx;
    }
    st.stats.opens += 1;
    save();
    hist({ ev: 'open', sym: best.sym, entry, size: realSize, stopPx, score: +best.g.score.toFixed(1) });
    log(`✅ SEAT ${best.sym} long ${realSize} @ ${entry} · stop ${stopPx} · bagrunner trail armed via liq-guard`);
  } catch (e) {
    // no naked probes — TPSL failure = close immediately
    log('⚠️ entry/tpsl err', String(e.message).slice(0, 120), '— flattening');
    try { await X.closePosition(best.sym, 'long'); } catch { }
    st.cooldowns[best.sym] = Date.now() + CD_MS;
    delete st.seats[best.sym]; save();
    hist({ ev: 'entry-fail', sym: best.sym, err: String(e.message).slice(0, 120) });
  }
}

await boot();
let running = false;
const loop = async () => {
  if (running) return; running = true;
  try { await tick(); } catch (e) { log('tick err', String(e.message || e).slice(0, 160)); }
  running = false;
};
setInterval(loop, MS);
setTimeout(loop, 500);
