// bitget-watch.mjs — protection-only Bitget watcher. NEVER enters, closes,
// or resizes positions. Every cycle it guarantees each open Bitget position
// carries, engine-style (mirrors bitget-exec's rules):
//   1. exactly ONE whole-position stop (pos_loss), band-clamped:
//        stopPct = max(1.2, min(liqPct*0.7, 5))
//        if stopPct >= liqPct*0.8 -> stopPct = liqPct*0.75   (always > liq)
//      and profit-locked (move-lock: a >=1.5% favourable move floors the
//      stop at +55% of the move — never moves against the position).
//   2. the staggered TP ladder from state/rr-config.json (default sniper
//      15/25/45 @ 2R/4R/7R with base = 2 x stopPct, moon bag left
//      uncovered), sized to the CURRENT position via cumulative-difference
//      rounding, re-armed whenever size/entry drift (adds/resizes).
//   3. no leftover plans on symbols that went flat (orphan sweep).
// Everything is idempotent: identical plans are left untouched; only
// missing/stale/under-covering/wiped protection is replaced. A heartbeat
// lands in api/bitget-watch.json each cycle. Systemd Restart=always covers
// crashes; a failed API call just logs and retries next cycle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-env.mjs';
import { makeExchange } from './exchange/index.mjs';
import { executionSeat, protectRiskSeat } from './risk-entry.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MS = Math.max(10_000, +(process.env.BITGET_WATCH_MS || 30_000));
const MIN_TRANCHE = +(process.env.EXEC_MIN_TRANCHE_USD || 25);
const TAG = () => `[bw ${new Date().toISOString().slice(11, 19)}]`;

// This watcher's entire identity: Bitget LIVE, no matter what .env says.
const X = makeExchange({ ...process.env, SENTINEL_EXCHANGE: 'bitget', SENTINEL_EXEC: 'live' });
if (typeof X.hasCreds === 'boolean' && !X.hasCreds) {
  console.error(TAG(), 'FATAL: Bitget live credentials missing from env — exiting so systemd surfaces it');
  process.exit(1);
}
// position mode drives the close-order wire shape: hedge wants the
// POSITION side + tradeSide:'close', oneway the opposite order side +
// reduceOnly. Account-wide — resolved once at boot.
let POS_MODE = 'oneway';
try { POS_MODE = await X.getPosMode('BTCUSDT'); X.setPosMode(POS_MODE); } catch {}

const DEFAULT_RR = { mults: [0.15, 0.35, 0.7], alloc: [0.35, 0.3, 0.2], moon: 0.15, stopPct: 1 };
const loadRR = () => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'rr-config.json'), 'utf8'));
    if (Array.isArray(c.mults) && Array.isArray(c.alloc) && c.mults.length === c.alloc.length) return c;
  } catch {}
  return DEFAULT_RR;
};

const roundTo = (x, dec) => +x.toFixed(dec);
const ceilTick = (x, dec) => Math.ceil(x * 10 ** dec) / 10 ** dec;
const floorTick = (x, dec) => Math.floor(x * 10 ** dec) / 10 ** dec;

// MANUAL_HOLD symbols — mirrors bitget-exec: env list + the operator cmd
// file (state/cmd-manual-hold.json). Operator-placed orders are SACRED:
// nothing below cancels a non-vtp order on these symbols. The visible vtp
// ladder still re-arms alongside them (full visibility mandate) — fills
// resolve first-come and the size reconcile heals cover after any fill.
// The stop section is deliberately NOT skipped —
// it is tighten-only and repairs missing/liq-unsafe stops, which can only
// ever help an operator-held position. Loaded per cycle so handset adds
// take effect without a restart.
const loadManual = () => {
  const s = new Set(
    (process.env.SENTINEL_MANUAL_HOLD || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
  );
  try {
    for (const sym of JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'cmd-manual-hold.json'), 'utf8'))?.symbols || [])
      s.add(String(sym).toUpperCase());
  } catch {}
  return s;
};

// MANUAL-STOP-1 (2026-10-19 operator order): manual seats get exactly ONE
// catastrophic pos_loss ~1.2% inside liquidation — the ONLY machine write
// allowed. Any loss plan already present (his own counts) = we place
// nothing. Ours is tracked in manual-stop-track.json so only rows we
// placed can be re-placed if liq drifts across them.
const MAN_STOP_BUF = 0.012;
const mstRead = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'manual-stop-track.json'), 'utf8')); } catch { return {}; } };
const mstWrite = (o) => { try { fs.writeFileSync(path.join(ROOT, 'state', 'manual-stop-track.json'), JSON.stringify(o)); } catch {} };

// band-clamped stop + move-lock, per side. Returned px is guaranteed above
// liq for longs / below liq for shorts whenever liq > 0 (0.75-of-band rule).
function desiredSl(pos, dec) {
  const entry = +pos.openPriceAvg;
  const liq = +pos.liquidationPrice || 0;
  const size = +pos.total;
  const upl = +pos.unrealizedPL || 0;
  const long = pos.holdSide === 'long';
  const liqPct = liq > 0 ? (Math.abs(entry - liq) / entry) * 100 : 5;
  let stopPct = Math.max(1.2, Math.min(liqPct * 0.7, 5));
  if (stopPct >= liqPct * 0.8) stopPct = Math.max(liqPct * 0.75, 0.05);
  try {
    const ov = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'stop-override.json'), 'utf8')) || {};
    const o = ov[pos.symbol];
    if (o && +o.stopPct > stopPct) stopPct = +o.stopPct; // operator-set floor: widen only, never a retreat
  } catch {}
  let px = long ? ceilTick(entry * (1 - stopPct / 100), dec) : floorTick(entry * (1 + stopPct / 100), dec);
  const mark = size > 0 ? entry + (long ? 1 : -1) * (upl / size) : entry;
  const movePct = ((long ? mark - entry : entry - mark) / entry) * 100;
  let peakPct = movePct;
  try {
    const gv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'liq-guard.json'), 'utf8')) || {};
    const prow = (gv.positions || {})[`${pos.symbol}:${pos.holdSide}`] || {};
    // seat-bound: a peak only counts if the guard recorded it for THIS seat —
    // a dead seat's peakFav armed phantom locks on fresh positions (the
    // manual-seat kill chain, 2026-10-19).
    if (+prow.seatCtime > 0 && +prow.seatCtime === +pos.cTime) {
      const pk = +prow.peakFav;
      if (Number.isFinite(pk) && pk > peakPct) peakPct = pk; // peak-anchored: a clipped seat keeps its lock after the retrace
    }
  } catch {}
  const clearPx = mark > 0 ? (long ? floorTick(mark * (1 - 0.0015), dec) : ceilTick(mark * (1 + 0.0015), dec)) : 0;
  // zero-risk asap (operator order 2026-11-02): engage the lock once favor
  // clears the round-trip fee toll (~0.3%), not at +1.5% — fees bank first,
  // then the ratchet carries the runner. Floor +0.2% ≈ taker RT + slip.
  if (peakPct >= 0.35) {
    const lockPct = Math.max(0.2, 0.55 * peakPct);
    const lock = long ? ceilTick(entry * (1 + lockPct / 100), dec) : floorTick(entry * (1 - lockPct / 100), dec);
    // placeable-only: a lock the mark already crossed can't rest — clamping
    // it to mark-0.15% arms a hair-trigger that dies on noise. Skip, don't
    // clamp; the band stop below remains the floor.
    if (long ? lock <= clearPx : lock >= clearPx) px = long ? Math.max(px, lock) : Math.min(px, lock);
  }
  // mark clamp: Bitget refuses a long's SL trigger at/above the mark and a
  // short's at/below it (40808 "trigger price check") — happens the moment
  // price trades through the band stop. Pull the trigger just clear of the
  // mark; then re-clamp to the liq-safe side (liq wins: wrong side of liq is
  // unplaceable too, and surviving beats pretty).
  if (mark > 0) px = long ? Math.min(px, clearPx) : Math.max(px, clearPx);
  if (liq > 0) px = long ? Math.max(px, ceilTick(liq * 1.0005, dec)) : Math.min(px, floorTick(liq * 0.9995, dec));
  return { px, stopPct, liqPct, movePct, mark };
}

function desiredLegs(pos, rr, stopPct, dec, sizeDec, mark, contractSizeStep = 0, contractMinSize = 0) {
  const entry = +pos.openPriceAvg;
  const size = +pos.total;
  const long = pos.holdSide === 'long';
  const cum = [0];
  let a = 0;
  for (const f of rr.alloc) { a = +(a + f).toFixed(8); cum.push(a); }
  const sp = Math.pow(10, sizeDec);
  const stepSize = Math.max(1 / sp, +contractSizeStep || 0);
  const floorSize = (value) => Math.floor((value + stepSize * 1e-9) / stepSize) * stepSize;
  const minSlice = Math.ceil(((+contractMinSize || stepSize) - stepSize * 1e-9) / stepSize) * stepSize;
  // spacing floor: when the liq band squeezes stopPct (it can collapse to
  // ~0.1% on a razor-thin margin), 2x-stopPct puts every TP within pennies
  // of entry — i.e. BELOW mark — and Bitget rejects the ladder (40915),
  // leaving the position with no TPs while we retry forever. Keep the
  // normal 2x-stopPct grid when it's sane, else a 2% grid so legs clear
  // the mark. (Normal stops are >=1.2% → base >=2.4% → floor never binds.)
  const base = Math.max(2 * stopPct, 2);
  const legs = [];
  for (let i = 0; i < rr.mults.length; i++) {
    const qty = floorSize(size * cum[i + 1]) - floorSize(size * cum[i]);
    // absPct rungs (crackwhore grid): fixed % above/below entry, decoupled
    // from stop width — the old base*mult ladder spread rungs by stopPct*2
    // and banked nothing for ages. Fall back to R-grid when absPct absent.
    const rungPct = Array.isArray(rr.absPct) && rr.absPct[i] != null
      ? rr.absPct[i]
      : base * rr.mults[i];
    const px = long
      ? roundTo(entry * (1 + rungPct / 100), dec)
      : roundTo(entry * (1 - rungPct / 100), dec);
    // legs at/below mark are unplaceable (40915) — skip them; that slice
    // rides with the stop until price pulls back and the leg becomes valid
    const clearsMark = mark <= 0 || (long ? px > mark * 1.0002 : px < mark * 0.9998);
    // 2026-10-15 operator order (adaptive): the ladder scales to the seat —
    // a rung is legal at ~posNotional/4.5 (3 rungs + moon bag) instead of a
    // fixed $25, so micro seats still bank 3 partials via reduce-side plan
    // orders; on bigger books the $25 tranche floor binds as before.
    // floor ~80% of the smallest rung's share so back-rungs (smallest alloc)
    // aren't filtered off a 5-way split
    const minAlloc = Math.min(...rr.alloc);
    const legFloorUsd = Math.min(MIN_TRANCHE, Math.max(0.5, size * entry * minAlloc * 0.8));
    if (qty >= minSlice && qty * entry >= legFloorUsd && clearsMark) legs.push({ px, size: qty });
  }
  // seats under the slice floor but with >=2 contract steps still ladder:
  // one step per rung price (a 0.02-contract seat gets 2 rungs, 0.03 gets 3).
  // A single-step seat can't split — it keeps the whole-position pos_profit.
  // Also upgrades a PARTIAL slice: if rounding produced fewer rungs than the
  // seat's steps allow, equal-step the first N rungs instead (front-loaded —
  // earliest rungs bank first, the crackwhore way).
  const step = minSlice;
  const steps = Math.floor(size / minSlice + 1e-9);
  const maxLegs = steps >= 2 ? Math.min(rr.mults.length, steps) : 0;
  if (legs.length < maxLegs) {
    legs.length = 0;
    for (let i = 0; i < maxLegs; i++) {
      const rungPct = Array.isArray(rr.absPct) && rr.absPct[i] != null
        ? rr.absPct[i]
        : base * rr.mults[i];
      const px = long
        ? roundTo(entry * (1 + rungPct / 100), dec)
        : roundTo(entry * (1 - rungPct / 100), dec);
      const clearsMark = mark <= 0 || (long ? px > mark * 1.0002 : px < mark * 0.9998);
      if (clearsMark) legs.push({ px, size: step });
    }
  }
  return legs;
}

const reportedUnsplittable = new Set();
const reportedHandsOff = new Set();
const clearedManual = new Map();
const reportedFitFloor = new Set();
const legsMatch = (rows, legs, dec, sp) => {
  if (rows.length !== legs.length) return false;
  const used = new Set();
  for (const l of legs) {
    // size must match to the EXACT contract count: the old tolerance was
    // `<= sp` (=100 for 2dp sizes), which swallowed every real drift — a
    // trim shifting a leg by one contract (0.01) never re-armed the ladder.
    // Compare in integer contract units so fp noise can't hide a 1-tick gap.
    const i = rows.findIndex((r, k) => !used.has(k)
      && Math.abs(+r.triggerPrice - l.px) <= Math.max(2 * 10 ** -dec, l.px * 0.003)
      && Math.round(Math.abs((+r.size || 0) - l.size) * sp) === 0);
    if (i < 0) return false;
    used.add(i);
  }
  return true;
};

async function cancelRows(sym, rows) {
  const byType = {};
  for (const r of rows) {
    const id = r.orderId || r.planId || r.id;
    if (id == null) continue;
    (byType[r.planType] ||= []).push(String(id));
  }
  for (const [t, ids] of Object.entries(byType)) {
    await X.cancelPlanOrders(sym, t, ids);
  }
}

async function reconcileK2TakeProfits(p, rr, dec, sizeDec, rows, actions, errors) {
  const mark = +p.markPrice || 0;
  const stop = desiredSl(p, dec);
  const legs = desiredLegs(p, rr, stop.stopPct, dec, sizeDec, mark,
    +cmCache?.[p.symbol]?.sizeMultiplier || 0, +cmCache?.[p.symbol]?.minTradeNum || 0);
  const legRows = rows.filter((r) => r.planType === 'profit_plan');
  if (legs.length) {
    if (!legsMatch(legRows, legs, dec, Math.pow(10, sizeDec))) {
      await cancelRows(p.symbol, legRows);
      let placed = 0;
      for (const l of legs) {
        try {
          await X.planOrder(p.symbol, 'profit_plan', String(l.px), String(l.size), p.holdSide, p.marginMode);
          placed++;
        } catch (e) {
          errors.push(`${p.symbol}: K2 TP leg ${l.px} failed: ${e.message.slice(0, 100)}`);
        }
      }
      const check = await X.getPlans(p.symbol).catch(() => null);
      if (check === null || !legsMatch(check.filter((r) => r.planType === 'profit_plan'), legs, dec, Math.pow(10, sizeDec)))
        errors.push(`${p.symbol}: K2 TP ladder verification failed`);
      if (placed) actions.push(`${p.symbol}: K2 TP ladder armed ${placed}/${legs.length} configured rungs`);
    }
    return;
  }

  // A position too small to split still gets one whole-position target from
  // the configured grid. The normal K2 stop continues to manage the runner
  // whenever the exchange supports partial TP legs.
  const existing = rows.filter((r) => r.planType === 'pos_profit');
  if (existing.length) return;
  const entry = +p.openPriceAvg || +p.averageOpenPrice || 0;
  const long = p.holdSide === 'long';
  const grid = Array.isArray(rr.absPct) ? rr.absPct : [];
  const pct = +grid[Math.floor(grid.length / 2)] || 0.9;
  const target = entry > 0
    ? roundTo(long ? entry * (1 + pct / 100) : entry * (1 - pct / 100), dec) : 0;
  if (!(target > 0) || (mark > 0 && (long ? target <= mark * 1.0002 : target >= mark * 0.9998))) {
    errors.push(`${p.symbol}: K2 seat cannot split and configured TP is not placeable above/below mark`);
    return;
  }
  try {
    await X.planOrder(p.symbol, 'pos_profit', String(target), '0', p.holdSide, p.marginMode);
    const check = await X.getPlans(p.symbol).catch(() => null);
    if (!check?.some((r) => r.planType === 'pos_profit' && Math.abs(+r.triggerPrice - target) <= 2 * 10 ** -dec))
      errors.push(`${p.symbol}: K2 whole-position TP verification failed`);
    else actions.push(`${p.symbol}: K2 whole-position TP armed @ ${target}`);
  } catch (e) {
    errors.push(`${p.symbol}: K2 fallback TP failed: ${e.message.slice(0, 100)}`);
  }
}

let cmCache = null;
// decimals fallback helpers (see cycle() — used only when the contract map
// lacks a symbol). Price grid from the live ticker string: the exchange
// formats markPrice to the tick, so the fraction length IS the grid.
const fracLen = (v) => { const s = String(v); const i = s.indexOf('.'); return i < 0 ? 0 : s.slice(i + 1).length; };
const decCache = {}; // sym -> price decimals
const priceDecOf = async (sym) => {
  try {
    const t = await X.ticker(sym);
    const row = Array.isArray(t) ? t[0] : t;
    const px = row?.markPrice || row?.lastPr || row?.lastPrice;
    if (px) return Math.min(8, fracLen(px));
  } catch {}
  return 2; // sane last resort for USDT-perp grids (better than 5dp garbage)
};
const readHeartbeat = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'api', 'bitget-watch.json'), 'utf8')); } catch { return null; }
};
const writeHeartbeat = (obj) => {
  const p = path.join(ROOT, 'api', 'bitget-watch.json');
  const tmp = p + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, p); } catch {}
};

async function cycle() {
  const t0 = Date.now();
  const rr = loadRR();
  // NEVER cache an empty map: one failed contractMap call under IO load used
  // to stick {} forever -> dec/sizeDec fell back to 5/0 -> 5dp triggers
  // (Bitget 40808 price-check) and TP sizes floored to 0 legs. Retry until
  // the map actually arrives.
  if (!cmCache || !Object.keys(cmCache).length) cmCache = await X.contractMap().catch(() => ({}));
  const pos = await X.getPos().catch((e) => { throw new Error(`getPos: ${e.message}`); });
  const open = new Map(pos.filter((p) => +p.total > 0).map((p) => [p.symbol, p]));
  const actions = [];
  const errors = [];

  // orphan sweep: plans AND resting TP limits on symbols that went flat
  // since last cycle
  const prev = readHeartbeat();
  for (const sym of prev?.flatWatched || []) {
    if (open.has(sym)) continue;
    try {
      const rows = await X.getPlans(sym).catch(() => []);
      if (rows.length) { await cancelRows(sym, rows); actions.push(`${sym}: swept ${rows.length} orphan plan(s) after flat`); }
      const pend = await X.pendingOrders(sym).catch(() => []);
      const orphans = pend.filter((o) => /^vtp-/.test(String(o.clientOid || '')));
      for (const o of orphans) {
        const oid = o.orderId || o.id;
        if (oid) await X.cancelOrder(sym, String(oid)).catch(() => {});
      }
      if (orphans.length) actions.push(`${sym}: swept ${orphans.length} orphan TP limit(s) after flat`);
      // resting ENTRY orders on the flat sym are the cooldown bypass: a dip-
      // quote/setup bid left over from before the close fills inside the gap
      // between close and the exec's gate-time sweep (SOL re-opened ~90s
      // post-flat through exactly this window). Kill them at the transition.
      const deadBids = pend.filter((o) => String(o.reduceOnly || '').toUpperCase() !== 'YES' && o.tradeSide !== 'close');
      for (const o of deadBids) {
        const oid = o.orderId || o.id;
        if (oid) await X.cancelOrder(sym, String(oid)).catch(() => {});
      }
      if (deadBids.length) actions.push(`${sym}: swept ${deadBids.length} resting entry bid(s) after flat — cooldown owns re-entry`);
    } catch (e) { errors.push(`${sym} sweep: ${e.message.slice(0, 100)}`); }
  }

  // standing cooldown sweep: the transition kill only fires once, but eval
  // can place a fresh entry bid MINUTES later inside the same 60m window
  // (SOL's setup bid armed ~9m post-close, filled at 10:38). While a flat
  // symbol sits inside its cooldown, kill non-close resting orders every
  // tick — the bench owns the symbol for the whole window, not just the
  // transition second.
  const COOLDOWN_MS = 60 * 60e3;
  const cd = { ...(prev?.cooldown || {}) };
  // journal every flat transition as a close timestamp — position state is
  // ground truth, immune to fills-feed lag/flakes. The exec merges this file
  // into its cooldown map so a mid-cycle close benches the symbol even when
  // the fills API misses it.
  const rcPath = new URL('../state/recent-closes.json', import.meta.url).pathname;
  let recentCloses = {};
  try { recentCloses = JSON.parse(fs.readFileSync(rcPath, 'utf8')); } catch { }
  let rcDirty = false;
  for (const sym of prev?.flatWatched || []) if (!open.has(sym) && !cd[sym]) { cd[sym] = Date.now() + COOLDOWN_MS; recentCloses[sym] = Date.now(); rcDirty = true; }
  for (const [s2, t2] of Object.entries(recentCloses)) if (Date.now() - t2 > 2 * COOLDOWN_MS) { delete recentCloses[s2]; rcDirty = true; }
  if (rcDirty) try { fs.writeFileSync(rcPath, JSON.stringify(recentCloses)); } catch { }
  for (const [sym, until] of Object.entries(cd)) {
    if (Date.now() > until || open.has(sym)) { delete cd[sym]; continue; }
    try {
      const pend = await X.pendingOrders(sym).catch(() => []);
      const deadBids = pend.filter((o) => String(o.reduceOnly || '').toUpperCase() !== 'YES' && o.tradeSide !== 'close');
      for (const o of deadBids) {
        const oid = o.orderId || o.id;
        if (oid) { await X.cancelOrder(sym, String(oid)).catch(() => {}); actions.push(`${sym}: swept resting entry during cooldown — bench owns ${Math.round((until - Date.now()) / 6e4)}m more`); }
      }
    } catch (e) { errors.push(`${sym} cooldown-sweep: ${e.message.slice(0, 100)}`); }
  }

  const manualSet = loadManual();
  // auto-detected manual seats (2026-10-17): an ios/web open on a held sym
  // means the OPERATOR owns exit geometry — same protection as cmd-manual-hold.
  // manual-book.json lags up to one exec cycle, so also check live fill-source:
  // last opens all non-api = his seat, exempt THIS cycle, not next.
  try {
    for (const s of JSON.parse(fs.readFileSync(path.join(ROOT, "state", "manual-book.json"), "utf8"))?.syms || [])
      manualSet.add(String(s).toUpperCase());
  } catch {}
  try {
    const rf = await X.getFills({ limit: 50 });
    // seat-scoped provenance (2026-10-19): same fail-closed rule as the
    // guard — machine only when this seat's own opens prove api.
    const seatsPath = path.join(ROOT, 'state', 'machine-seats.json');
    let seats = {}; try { seats = JSON.parse(fs.readFileSync(seatsPath, 'utf8')) || {}; } catch { }
    let seatsDirty = false;
    for (const p of open.values()) {
      if (manualSet.has(p.symbol)) continue;
      const key = `${p.symbol}:${p.holdSide}`;
      const opens = (rf || []).filter((f) => f.symbol === p.symbol && f.tradeSide === "open")
        .sort((a, b) => +(b.cTime || b.ts || 0) - +(a.cTime || a.ts || 0));
      const pCt = +p.cTime || 0;
      const seatOpens = pCt > 0 ? opens.filter((f) => +(f.cTime || f.ts || 0) >= pCt - 2000) : opens.slice(0, 1);
      const apiProven = seatOpens.length > 0 && seatOpens.every((f) => f.enterPointSource === 'api');
      if (apiProven) {
        if (seats[key] !== pCt) { seats[key] = pCt; seatsDirty = true; }
      } else if (seatOpens.length === 0 && pCt > 0 && seats[key] === pCt) {
        // proven machine seat; open rolled off the fills window
      } else {
        manualSet.add(p.symbol);
        actions.push(p.symbol + ": manual-open detected (fill src " + String(seatOpens[0] && seatOpens[0].enterPointSource || 'unproven') + ") — operator owns exits");
      }
    }
    if (seatsDirty) try { fs.writeFileSync(seatsPath, JSON.stringify(seats)); } catch { }
  } catch {}
  // cmd-machine-manage.json - operator handover: machine owns these
  // outright (exits + future seats); override every manual-detection path.
  try {
    for (const s of JSON.parse(fs.readFileSync(path.join(ROOT, "state", "cmd-machine-manage.json"), "utf8"))?.symbols || [])
      manualSet.delete(String(s).toUpperCase());
  } catch {}
  // margin/size delta baseline from last cycle's heartbeat. Survives
  // restarts (the heartbeat file persists), so a daemon bounce never
  // re-fires an already-handled event, and a first boot records the
  // baseline instead of inventing events.
  const prevSnap = prev?.posSnap || {};
  const snapNext = {};
  const marginEvents = [];
  const DERISK_CAP = +(process.env.SENTINEL_POS_DERISK_CAP_PCT || 0.30);
  const equityUsd = (() => {
    try { return +JSON.parse(fs.readFileSync(path.join(ROOT, 'api', 'live-ledger.json'), 'utf8'))?.equityUsd || 0; }
    catch { return 0; }
  })();
  for (const p of open.values()) {
    try {
      const c = cmCache[p.symbol] || {};
      // Fallback decimals when the contract map lacks (or lost) this symbol:
      // the old 5/0 defaults produced 5dp triggers (Bitget 40808) and TP
      // sizes floored to zero legs — forever, because the map never had the
      // symbol. Derive price decimals from the LIVE price grid (ticker,
      // cached per symbol) and size decimals from the position's own size.
      const dec = Number.isFinite(+c.pricePlace)
        ? +c.pricePlace
        : (decCache[p.symbol] ??= await priceDecOf(p.symbol));
      const sizeDec = Number.isFinite(+c.sizePlace) ? +c.sizePlace : fracLen(p.total);
      const sp = Math.pow(10, sizeDec);
      const rows = await X.getPlans(p.symbol).catch((e) => null);
      if (rows === null) {
        // A getPlans ERROR must never be treated as an empty book: acting on
        // it used to place a duplicate SL and re-lay TPs on top of the
        // existing ones (the cancel path saw no rows to cancel). Skip the
        // symbol this cycle — the next cycle retries.
        errors.push(`${p.symbol}: getPlans failed — skipping this symbol this cycle`);
        continue;
      }
      const size = +p.total;
      const liq = +p.liquidationPrice || 0;

      // manual seat (declared OR fill-detected): near-zero machine contact —
      // no TP legs, no re-fit, no clips, no lev changes. ONE exception per
      // 2026-10-19 operator order: a single catastrophic pos_loss ~1.2%
      // inside liq, placed only when no loss plan exists (his own stops
      // are sacred — any existing loss row counts as covered).
      // 2026-10-18: the "can only help" stop re-fit clipped ICNT+Q for
      // -$12 in 20min. Snapshot still records so a later hand-back diffs
      // cleanly.
      if (manualSet.has(p.symbol)) {
        // stale-plan sweep by AGE, not blanket: plans created before this
        // seat opened are residue from a prior seat (the 11:57 Q kill) and
        // get cancelled. Plans created AFTER the open = exec's synthesized
        // protection, which the operator chose to keep (option 1, 12:15) —
        // so the sweep must not touch this seat's own armed SL/TP.
        const posCt = +p.cTime || 0;
        const firstSight = clearedManual.get(p.symbol) !== posCt;
        const stale = rows.filter((r) => {
          if (!/loss|profit|moving|_plan/i.test(r.planType || '')) return false;
          const rt = +r.cTime || +r.uTime || +r.createTime || 0;
          return rt > 0 ? rt < posCt - 30e3 : firstSight;
        });
        if (stale.length) {
          await cancelRows(p.symbol, stale);
          actions.push(p.symbol + ": swept " + stale.length + " stale pre-seat plan(s) — synthesized protection kept");
        }
        clearedManual.set(p.symbol, posCt);
        // MANUAL-STOP-1 arm/repair — the single allowed write
        try {
          const mst = mstRead();
          const mLoss = rows.filter((r) => /loss|stop|moving/i.test(r.planType || '') && (!r.holdSide || r.holdSide === p.holdSide));
          const tk = mst[p.symbol];
          const ours = tk && tk.seatCt === posCt && tk.side === p.holdSide && tk.trig > 0
            ? mLoss.find((r) => Math.abs(+r.triggerPrice - tk.trig) / tk.trig < 0.004)
            : null;
          const mLong = p.holdSide === 'long';
          const mMark = +p.markPrice || +p.openPriceAvg || 0;
          const nearLiq = mLong ? liq * (1 + MAN_STOP_BUF) : liq * (1 - MAN_STOP_BUF);
          if (liq > 0 && mMark > 0) {
            if (ours && (mLong ? +ours.triggerPrice <= liq : +ours.triggerPrice >= liq)) {
              // our stop drifted outside the liq line (seat resized) — re-place
              await cancelRows(p.symbol, [ours]);
              const t = +nearLiq.toFixed(dec);
              await X.planOrder(p.symbol, 'pos_loss', String(t), '0', p.holdSide, p.marginMode);
              mst[p.symbol] = { trig: t, seatCt: posCt, side: p.holdSide, at: Date.now() };
              mstWrite(mst);
              actions.push(p.symbol + ": manual catastrophic stop re-armed @ " + t + " (~1.2% inside liq " + liq + ")");
            } else if (!mLoss.length) {
              const t = +nearLiq.toFixed(dec);
              if (mLong ? t < mMark : t > mMark) {
                await X.planOrder(p.symbol, 'pos_loss', String(t), '0', p.holdSide, p.marginMode);
                mst[p.symbol] = { trig: t, seatCt: posCt, side: p.holdSide, at: Date.now() };
                mstWrite(mst);
                actions.push(p.symbol + ": manual catastrophic stop armed @ " + t + " (~1.2% inside liq " + liq + ")");
              }
            }
          }
        } catch (e) { errors.push(p.symbol + ": manual-stop failed: " + String(e.message || e).slice(0, 100)); }
        snapNext[p.symbol] = { m: +p.marginSize || 0, s: +p.total, e: +p.openPriceAvg || 0, l: liq, u: +p.unrealizedPL || 0, ct: +p.cTime || 0 };
        if (!reportedHandsOff.has(p.symbol)) {
          reportedHandsOff.add(p.symbol);
          actions.push(p.symbol + ": manual seat — hands off except catastrophic liq stop");
        }
        continue;
      }

      if (executionSeat(p)) {
        await protectRiskSeat(X, p, c);
        await reconcileK2TakeProfits(p, rr, dec, sizeDec, rows, actions, errors);
        snapNext[p.symbol] = { m: +p.marginSize || 0, s: size, e: +p.openPriceAvg,
          l: liq, u: +p.unrealizedPL || 0, ct: +p.cTime || 0 };
        actions.push(`${p.symbol}: hourly K2 stop and configured take-profit protection active`);
        continue;
      }
      // ---- margin/size event: posted margin or contracts changed since
      // the last snapshot (manual isolated top-up, auto-margin-transfer,
      // add-order resize). marginSize on CROSSED positions drifts with
      // uPL, so only the uPL-unexplained part of the delta counts; on
      // isolated it never drifts, so any delta beyond the threshold is a
      // real add/remove. The snapshot updates at the END of the try —
      // if the re-adapt below errors, the event re-fires next cycle.
      const mNow = +p.marginSize || 0;
      const eNow = +p.openPriceAvg || 0;
      const uNow = +p.unrealizedPL || 0;
      const ctNow = +p.cTime || 0;
      const snap = prevSnap[p.symbol];
      // cTime guard: a flat->reopen between cycles is a NEW position —
      // baseline only, never an event.
      const samePos = snap && (!snap.ct || !ctNow || String(snap.ct) === String(ctNow));
      let marginEvent = null;
      if (samePos) {
        const thr = Math.max(0.10, Math.abs(+snap.m || 0) * 0.015);
        const mD = mNow - (+snap.m || 0);
        const uD = uNow - (+snap.u || 0);
        const addU = mD - Math.max(0, uD);    // margin grew beyond PnL share
        const remU = -mD + Math.min(0, uD);   // margin shrank beyond PnL drag
        const sD = size - (+snap.s || 0);
        if (addU > thr) marginEvent = { kind: 'margin-added', amt: addU, m: mNow, prevM: +snap.m || 0 };
        else if (remU > thr) marginEvent = { kind: 'margin-removed', amt: remU, m: mNow, prevM: +snap.m || 0 };
        if (Math.abs(sD) * sp >= 0.5) {
          // size change outranks margin noise — adds reslice margin anyway
          marginEvent = { kind: sD > 0 ? 'size-added' : 'size-reduced', amt: sD, m: mNow, prevM: +snap.m || 0 };
        }
      }
      if (marginEvent) {
        actions.push(`${p.symbol}: ${marginEvent.kind} ${marginEvent.kind.startsWith('margin') ? `$${marginEvent.amt.toFixed(2)} ($${marginEvent.prevM.toFixed(2)}→$${marginEvent.m.toFixed(2)})` : `Δ${marginEvent.amt}`} — re-adapting SL/TP`);
        marginEvents.push({ ts: Date.now(), sym: p.symbol, kind: marginEvent.kind, amt: +marginEvent.amt.toFixed(4), margin: mNow });
      }

      // ---- STOP: exactly one whole-position pos_loss (or an engine trail)
      const lossRows = rows.filter((r) => /loss|stop|moving/i.test(r.planType || ''));
      const moving = lossRows.find((r) => /moving/i.test(r.planType || ''));
      const want = desiredSl(p, dec);
      if (moving) {
        // a trailing stop IS the stop — leave it to the engine semantics
      } else {
        const posLoss = lossRows.filter((r) => r.planType === 'pos_loss');
        const sized = lossRows.filter((r) => /loss_plan/i.test(r.planType || ''));
        const keeper = posLoss[0] || sized[0] || null;
        const dupes = lossRows.filter((r) => r !== keeper);
        if (dupes.length) { await cancelRows(p.symbol, dupes); actions.push(`${p.symbol}: deduped ${dupes.length} extra stop row(s)`); }
        const fullCover = keeper && (keeper.planType === 'pos_loss' || +keeper.size >= size * 0.999);
        const eps = 10 ** -dec;
        const long = p.holdSide === 'long';
        // liq-safe side is DIRECTIONAL: a long's stop must sit ABOVE
        // liquidation, a short's BELOW it. A direction-blind `> liq` made
        // every short look invalid — refusing to place and erroring each cycle.
        const liqSafe = (pxv) => !(liq > 0) || (long ? pxv > liq : pxv < liq);
        // de-risk band re-fit (EVERY cycle, not just margin events): Bitget
        // wipes position-bound plans on isolated margin/size churn, so a
        // band-capped refit placed on an event was re-placed UNCAPPED the
        // next cycle after the wipe — the band silently re-breached. Same
        // % stop on a bigger base is a bigger $ worst-case; exec's band
        // (worst-case at stop ≤ 30% equity) is enforced here at stop level.
        // Tighten-only + inside-mark/liq-safe guards — it can never loosen
        // an existing stop or fight liq-guard's tighter trails.
        if (equityUsd > 0 && want.mark > 0 && size > 0) {
          const capUsd = equityUsd * DERISK_CAP;
          const worstUsd = Math.abs(eNow - want.px) * size;
          if (worstUsd > capUsd) {
            const fit = long ? eNow - capUsd / size : eNow + capUsd / size;
            const fp = long ? floorTick(fit, dec) : ceilTick(fit, dec);
            // only tighten, and only if the fitted px stays placeable
            // (inside the mark and on the liq-safe side — otherwise the
            // position is beyond stop-level repair and exec's trim owns it)
            const tighter = long ? fp > want.px : fp < want.px;
            const insideMark = long ? fp < want.mark * 0.9995 : fp > want.mark * 1.0005;
            // sane-width floor (2026-10-18): a cap-fitted stop narrower than
            // half the designed width sits inside ordinary wick noise — that
            // re-fit doesn't reduce risk, it guarantees the donation (it ate
            // ICNT -$9 and Q -$3 in 20min). Over-cap seats keep their designed
            // stop; exec's POS_DERISK trim (12%-at-stop) owns the resize.
            const fitPct = Math.abs(eNow - fp) / eNow * 100;
            const saneFloor = Math.max(want.stopPct * 0.5, +(process.env.SENTINEL_REFIT_FLOOR_PCT || 0.4));
            if (tighter && insideMark && liqSafe(fp)) {
              if (fitPct < saneFloor) {
                if (!reportedFitFloor.has(p.symbol)) {
                  reportedFitFloor.add(p.symbol);
                  actions.push(`${p.symbol}: over-cap (worst $${worstUsd.toFixed(2)}) but cap-fit stop ${fitPct.toFixed(2)}% < ${saneFloor.toFixed(2)}% sane-floor — designed stop kept, exec trim owns the resize`);
                }
              } else {
                actions.push(`${p.symbol}: worst-case $${worstUsd.toFixed(2)} > ${DERISK_CAP * 100}% equity${marginEvent ? ` on ${marginEvent.kind}` : ''} — stop re-fit @ ${fp}`);
                want.px = fp;
              }
            }
          }
        }
        // hysteresis: the move-lock target recomputes from the live mark every
        // cycle, so a 1-tick tolerance re-clamped the stop on EVERY cycle —
        // order churn that invites rate limits. Only move the stop when it
        // drifts more than 0.15% from where it already sits.
        const slack = Math.max(eps, want.px * 0.0015);
        // tighten-only: the executor runs live on this book and may hold a stop
        // tighter than our band/move-lock target (fee-lock, ratchet). A
        // two-sided compare would fight it — cancel/replace ping-pong every
        // cycle with no protection gained. This watcher may only TIGHTEN a
        // stop, or repair one failing the invariants (coverage / wrong side
        // of liquidation). A looser keeper than want = act; tighter = leave.
        const tooLoose = keeper
          ? (long ? +keeper.triggerPrice < want.px - slack : +keeper.triggerPrice > want.px + slack)
          : true;
        const keeperOk = keeper && fullCover && !tooLoose && liqSafe(+keeper.triggerPrice);
        if (!keeperOk) {
          if (!liqSafe(want.px)) {
            errors.push(`${p.symbol}: desired SL ${want.px} not on the safe side of liq ${liq} — keeping current stop`);
          } else {
            // PLACE-FIRST, then retire the stale keeper (the pattern liq-guard
            // uses proven live on this account): cancel-then-place opened a
            // naked window, and a failed place after the cancel left the
            // position with NO stop until the fallback re-place landed.
            try {
              await X.planOrder(p.symbol, 'pos_loss', String(want.px), '0', p.holdSide, p.marginMode);
              actions.push(`${p.symbol}: ${keeper ? 're-clamped' : 'added'} SL @ ${want.px} (stopPct ${want.stopPct.toFixed(2)}%, liq ${liq})`);
              if (keeper) await cancelRows(p.symbol, [keeper]).catch(() => {});
            } catch (e) {
              errors.push(`${p.symbol}: SL place failed: ${e.message.slice(0, 100)}${keeper ? ' — existing stop kept' : ''}`);
              // keeper (if any) was never cancelled — it still protects the
              // position while we retry next cycle. No re-place needed.
            }
          }
        }
      }

      // ---- TP LADDER: resting post-only limit legs, tagged vtp-* so they
      // are never confused with exec pullback entries or foreign orders.
      // The old trigger 'profit_plan' legs filled as TAKER on every winner
      // (a limit posted at the trigger instant always crosses — measured
      // 0.06% on every close in real-fills); resting legs sit in the book
      // ahead of the touch and bank at ~0.02% maker with queue priority.
      // Vestigial per-leg profit_plan triggers get swept: a trigger and a
      // resting limit at the same px double-fire the tranche. Exactly one
      // whole-position pos_profit trigger at the TOP leg price rides
      // underneath as the taker fallback — it fires only if the resting
      // legs are gone (exchange-cancelled, watcher restart gap, qty-cap
      // edge cases). MANUAL_HOLD symbols are skipped — the operator owns
      // profit geometry.
      const legs = desiredLegs(p, rr, want.stopPct, dec, sizeDec, want.mark,
        +c.sizeMultiplier || 0, +c.minTradeNum || 0);
      if (!legs.length && !reportedUnsplittable.has(p.symbol)) {
        reportedUnsplittable.add(p.symbol);
        actions.push(`${p.symbol}: seat ${p.total} < 2 contract steps — unsplittable, whole-position TP only`);
      } else if (legs.length) reportedUnsplittable.delete(p.symbol);
      const legRows = rows.filter((r) => r.planType === 'profit_plan');
      const fbRows = rows.filter((r) => r.planType === 'pos_profit');
      {
        const manualSym = manualSet.has(p.symbol);
        // 2026-10-15 operator order: TPs are PARTIAL TRIGGER orders —
        // profit_plan legs close their slice at each rung's trigger and
        // live under the plan/trigger tab, not the visible open-orders
        // book. vtp-* resting limit legs are retired: same rung prices,
        // same partial sizes, conditional close instead of resting asks.
        const pend = await X.pendingOrders(p.symbol).catch(() => null);
        if (pend === null) {
          errors.push(`${p.symbol}: pendingOrders failed — legacy TP sweep skipped`);
        } else {
          const vtp = pend.filter((o) => /^vtp-/.test(String(o.clientOid || '')));
          for (const o of vtp) {
            const oid = o.orderId || o.id;
            if (oid) await X.cancelOrder(p.symbol, String(oid)).catch(() => {});
          }
          if (vtp.length) actions.push(`${p.symbol}: swept ${vtp.length} legacy limit TP leg(s) — trigger rungs take over`);
        }
        if (!manualSym && !legsMatch(legRows, legs, dec, sp)) {
          await cancelRows(p.symbol, legRows);
          let placed = 0;
          for (const l of legs) {
            try {
              await X.planOrder(p.symbol, 'profit_plan', String(l.px), String(l.size), p.holdSide, p.marginMode);
              placed++;
            } catch (e) { errors.push(`${p.symbol}: TP leg ${l.px} failed: ${e.message.slice(0, 100)}`); }
          }
          if (placed || legRows.length) actions.push(`${p.symbol}: trigger TP ladder armed ${placed}/${legs.length} legs (partial close, plan tab)`);
        } else if (manualSym && legRows.length) {
          await cancelRows(p.symbol, legRows);
          actions.push(`${p.symbol}: swept ${legRows.length} profit_plan leg(s) — MANUAL_HOLD owns exits`);
        }
          // fallback trigger: keep any existing pos_profit (exec places its
          // own — price is its call, it is only a backstop); dedupe extras;
          // arm ours at the top leg when none exists. Once every leg has
          // banked the moon bag rides the trailing stop — no fixed cap.
          if (!fbRows.length && !manualSym) {
            // 1-contract seat: no ladder possible (legs=[]) but it still
            // deserves a whole-position TP, not just a stop. Arm pos_profit
            // at the middle configured rung ≈ the blended exit a full
            // ladder would average (guard: skip when it'd sit under mark —
            // Bitget rejects 40915 anyway).
            const fbLong = p.holdSide === 'long';
            const fbEntry = +p.openPriceAvg || +p.averageOpenPrice || 0;
            const midPct = Array.isArray(rr.absPct) && rr.absPct.length ? rr.absPct[Math.floor(rr.absPct.length / 2)] : 1.5;
            const topPx = legs.length
              ? legs[legs.length - 1].px
              : roundTo(fbLong ? fbEntry * (1 + midPct / 100) : fbEntry * (1 - midPct / 100), dec);
            const fbOk = legs.length || (fbEntry > 0 && (want.mark <= 0 || (fbLong ? topPx > want.mark * 1.0002 : topPx < want.mark * 0.9998)));
            if (fbOk) try {
              await X.planOrder(p.symbol, 'pos_profit', String(topPx), '0', p.holdSide, p.marginMode);
              actions.push(`${p.symbol}: fallback pos_profit @ ${topPx}${legs.length ? '' : ' (unsplittable seat, blended rung)'}`);
            } catch (e) { errors.push(`${p.symbol}: fallback TP failed: ${e.message.slice(0, 100)}`); }
          } else if (!manualSym && legs.length && fbRows.length) {
            // a fallback sitting INSIDE the ladder fires before the upper
            // rungs and steals them — move it to the top leg. One above the
            // ladder (long: higher) is harmless. Dedupe extras meanwhile.
            const topPx = legs[legs.length - 1].px;
            const long = p.holdSide === 'long';
            const stale = fbRows.filter((r) => (long ? +r.triggerPrice < topPx * 0.998 : +r.triggerPrice > topPx * 1.002));
            if (stale.length) {
              await cancelRows(p.symbol, stale);
              try {
                await X.planOrder(p.symbol, 'pos_profit', String(topPx), '0', p.holdSide, p.marginMode);
                actions.push(`${p.symbol}: fallback pos_profit moved to top rung @ ${topPx} (was inside ladder)`);
              } catch (e) { errors.push(`${p.symbol}: fallback TP failed: ${e.message.slice(0, 100)}`); }
            } else if (fbRows.length > 1) {
              await cancelRows(p.symbol, fbRows.slice(1));
              actions.push(`${p.symbol}: deduped ${fbRows.length - 1} extra pos_profit row(s)`);
            }
          }
      }
      // baseline commit — AFTER the re-adapt attempt so a failed cycle
      // re-fires the same event next pass rather than swallowing it
      snapNext[p.symbol] = { m: mNow, s: size, e: eNow, l: liq, u: uNow, ct: ctNow };
    } catch (e) { errors.push(`${p.symbol}: ${e.message.slice(0, 120)}`); }
  }

  const heartbeat = {
    ts: new Date().toISOString(),
    ok: errors.length === 0,
    cycleMs: Date.now() - t0,
    positions: open.size,
    flatWatched: [...open.keys()],
    cooldown: cd,
    posSnap: snapNext,
    marginEvents: [...marginEvents, ...(prev?.marginEvents || [])].slice(0, 20),
    actions: actions.slice(-20),
    errors: errors.slice(-10),
  };
  writeHeartbeat(heartbeat);
  for (const a of actions) console.log(TAG(), a);
  for (const e of errors) console.error(TAG(), 'ERR', e);
  if (actions.length || errors.length) console.log(TAG(), `cycle done in ${heartbeat.cycleMs}ms — ${open.size} position(s) watched, ${actions.length} action(s), ${errors.length} error(s)`);
}

let busy = false;
let cycleStartedAt = 0;
let pendingKick = false;
const run = async () => {
  if (busy) return;
  busy = true;
  cycleStartedAt = Date.now();
  try { await cycle(); }
  catch (e) { console.error(TAG(), 'cycle failed:', e.message.slice(0, 160)); writeHeartbeat({ ts: new Date().toISOString(), ok: false, error: String(e.message).slice(0, 200), flatWatched: (readHeartbeat() || {}).flatWatched || [] }); }
  finally {
    busy = false; cycleStartedAt = 0;
    // a kick landed while this cycle ran — go again immediately
    if (pendingKick) { pendingKick = false; setTimeout(run, 50); }
  }
};
// INSTANT RESYNC KICK: liq-guard touches state/bw-kick right after any
// emergency trim, so the SL/TP book re-arms against the NEW position size
// in the same second instead of waiting out the 10s poll. The kick file is
// watched (not polled) and the run() lock coalesces bursts.
const KICK = path.join(ROOT, 'state', 'bw-kick');
try { if (!fs.existsSync(KICK)) fs.writeFileSync(KICK, '0'); } catch {}
try {
  fs.watch(KICK, () => {
    if (busy) pendingKick = true;
    else { console.log(TAG(), 'kick — resyncing plans immediately'); run(); }
  });
} catch (e) { console.error(TAG(), 'kick watch unavailable:', e.message); }
// Stall watchdog: a never-settling API await would leave busy=true forever —
// process "runs" while protection silently rots. Exceed the wedge threshold
// and we exit hard; systemd Restart=always revives us within RestartSec.
const WEDGE_MS = +(process.env.BITGET_WATCH_WEDGE_MS || Math.max(120e3, MS * 3));
setInterval(() => {
  if (busy && cycleStartedAt && Date.now() - cycleStartedAt > WEDGE_MS) {
    console.error(TAG(), `FATAL: cycle wedged for ${Math.round((Date.now() - cycleStartedAt) / 1000)}s — exiting for systemd restart`);
    process.exit(1);
  }
}, 10e3);

console.log(TAG(), `starting — exchange=bitget mode=live cycle=${MS}ms + instant kick (protection only, never enters)`);
setInterval(run, MS);
run();
process.on('SIGTERM', () => { console.log(TAG(), 'SIGTERM — exiting'); process.exit(0); });
