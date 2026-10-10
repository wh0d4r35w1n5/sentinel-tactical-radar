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
// file (state/cmd-manual-hold.json). The operator owns PROFIT geometry on
// these: the RR ladder re-arm below would cancel operator scalp TPs every
// 10s cycle (observed live). The stop section is deliberately NOT skipped —
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
  let px = long ? ceilTick(entry * (1 - stopPct / 100), dec) : floorTick(entry * (1 + stopPct / 100), dec);
  const mark = size > 0 ? entry + (long ? 1 : -1) * (upl / size) : entry;
  const movePct = ((long ? mark - entry : entry - mark) / entry) * 100;
  if (movePct >= 1.5) {
    const lockPct = Math.max(0.2, 0.55 * movePct);
    const lock = long ? ceilTick(entry * (1 + lockPct / 100), dec) : floorTick(entry * (1 - lockPct / 100), dec);
    px = long ? Math.max(px, lock) : Math.min(px, lock);
  }
  // mark clamp: Bitget refuses a long's SL trigger at/above the mark and a
  // short's at/below it (40808 "trigger price check") — happens the moment
  // price trades through the band stop. Pull the trigger just clear of the
  // mark; then re-clamp to the liq-safe side (liq wins: wrong side of liq is
  // unplaceable too, and surviving beats pretty).
  if (mark > 0) {
    const clear = long ? floorTick(mark * (1 - 0.0015), dec) : ceilTick(mark * (1 + 0.0015), dec);
    px = long ? Math.min(px, clear) : Math.max(px, clear);
  }
  if (liq > 0) px = long ? Math.max(px, ceilTick(liq * 1.0005, dec)) : Math.min(px, floorTick(liq * 0.9995, dec));
  return { px, stopPct, liqPct, movePct, mark };
}

function desiredLegs(pos, rr, stopPct, dec, sizeDec, mark) {
  const entry = +pos.openPriceAvg;
  const size = +pos.total;
  const long = pos.holdSide === 'long';
  const cum = [0];
  let a = 0;
  for (const f of rr.alloc) { a = +(a + f).toFixed(8); cum.push(a); }
  const sp = Math.pow(10, sizeDec);
  // spacing floor: when the liq band squeezes stopPct (it can collapse to
  // ~0.1% on a razor-thin margin), 2x-stopPct puts every TP within pennies
  // of entry — i.e. BELOW mark — and Bitget rejects the ladder (40915),
  // leaving the position with no TPs while we retry forever. Keep the
  // normal 2x-stopPct grid when it's sane, else a 2% grid so legs clear
  // the mark. (Normal stops are >=1.2% → base >=2.4% → floor never binds.)
  const base = Math.max(2 * stopPct, 2);
  const legs = [];
  for (let i = 0; i < rr.mults.length; i++) {
    const qty = (Math.floor(size * cum[i + 1] * sp) - Math.floor(size * cum[i] * sp)) / sp;
    const px = long
      ? roundTo(entry * (1 + (base * rr.mults[i]) / 100), dec)
      : roundTo(entry * (1 - (base * rr.mults[i]) / 100), dec);
    // legs at/below mark are unplaceable (40915) — skip them; that slice
    // rides with the stop until price pulls back and the leg becomes valid
    const clearsMark = mark <= 0 || (long ? px > mark * 1.0002 : px < mark * 0.9998);
    if (qty > 0 && qty * entry >= MIN_TRANCHE && clearsMark) legs.push({ px, size: qty });
  }
  return legs;
}

const legsMatch = (rows, legs, dec, sp) => {
  if (rows.length !== legs.length) return false;
  const used = new Set();
  for (const l of legs) {
    // size must match to the EXACT contract count: the old tolerance was
    // `<= sp` (=100 for 2dp sizes), which swallowed every real drift — a
    // trim shifting a leg by one contract (0.01) never re-armed the ladder.
    // Compare in integer contract units so fp noise can't hide a 1-tick gap.
    const i = rows.findIndex((r, k) => !used.has(k)
      && Math.abs(+r.triggerPrice - l.px) <= 10 ** -dec
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
    } catch (e) { errors.push(`${sym} sweep: ${e.message.slice(0, 100)}`); }
  }

  const manualSet = loadManual();
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
        // margin/size-add re-fit: same % stop on a bigger base is a bigger
        // $ worst-case. Exec's de-risk band (worst-case at stop ≤ 30% equity)
        // enforced here at stop level — tighten-only, so it can never loosen
        // an existing stop, only pull it inside the band on a margin event.
        if (marginEvent && /added/.test(marginEvent.kind) && equityUsd > 0 && want.mark > 0) {
          const capUsd = equityUsd * DERISK_CAP;
          if (Math.abs(eNow - want.px) * size > capUsd) {
            const fit = long ? eNow - capUsd / size : eNow + capUsd / size;
            const fp = long ? floorTick(fit, dec) : ceilTick(fit, dec);
            // only tighten, and only if the fitted px stays placeable
            // (inside the mark and on the liq-safe side — otherwise the
            // position is beyond stop-level repair and exec's trim owns it)
            const tighter = long ? fp > want.px : fp < want.px;
            const insideMark = long ? fp < want.mark * 0.9995 : fp > want.mark * 1.0005;
            if (tighter && insideMark && liqSafe(fp)) {
              actions.push(`${p.symbol}: worst-case $${(Math.abs(eNow - want.px) * size).toFixed(2)} > ${DERISK_CAP * 100}% equity on ${marginEvent.kind} — stop re-fit @ ${fp}`);
              want.px = fp;
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
      const legs = desiredLegs(p, rr, want.stopPct, dec, sizeDec, want.mark);
      const legRows = rows.filter((r) => r.planType === 'profit_plan');
      const fbRows = rows.filter((r) => r.planType === 'pos_profit');
      if (!manualSet.has(p.symbol)) {
        if (legRows.length) {
          await cancelRows(p.symbol, legRows);
          actions.push(`${p.symbol}: swept ${legRows.length} vestigial profit_plan leg(s)`);
        }
        const pend = await X.pendingOrders(p.symbol).catch(() => null);
        if (pend === null) {
          // same rule as getPlans: an API error must never read as an empty
          // book — skip TP maintenance this cycle rather than double-lay.
          errors.push(`${p.symbol}: pendingOrders failed — TP legs skipped this cycle`);
        } else {
          const tpLims = pend.filter((o) => /^vtp-/.test(String(o.clientOid || '')));
          const limMatch = (orders) => {
            if (orders.length !== legs.length) return false;
            const used = new Set();
            for (const l of legs) {
              const i = orders.findIndex((o, k) => !used.has(k)
                && Math.abs(+o.price - l.px) <= 10 ** -dec
                && Math.round(Math.abs((+o.size || 0) - l.size) * sp) === 0);
              if (i < 0) return false;
              used.add(i);
            }
            return true;
          };
          if (!limMatch(tpLims)) {
            for (const o of tpLims) {
              const oid = o.orderId || o.id;
              if (oid) await X.cancelOrder(p.symbol, String(oid)).catch(() => {});
            }
            const long = p.holdSide === 'long';
            let placed = 0;
            for (let i = 0; i < legs.length; i++) {
              const l = legs[i];
              // a leg px the mark has already crossed can't post_only —
              // gtc lets it fill immediately at the better price instead
              // of error-looping while profit sits unclaimed
              const crossed = want.mark > 0 && (long ? l.px <= want.mark * 1.0002 : l.px >= want.mark * 0.9998);
              const extra = { clientOid: `vtp-${i}-${Date.now().toString(36).slice(-4)}` };
              if (POS_MODE === 'hedge') extra.tradeSide = 'close';
              else extra.reduceOnly = 'YES';
              if (crossed) extra.timeInForceValue = 'gtc';
              try {
                await X.limitOrder(
                  p.symbol,
                  POS_MODE === 'hedge' ? (long ? 'buy' : 'sell') : (long ? 'sell' : 'buy'),
                  String(l.size), String(l.px), extra
                );
                placed++;
              } catch (e) { errors.push(`${p.symbol}: TP limit ${l.px} failed: ${e.message.slice(0, 100)}`); }
            }
            if (placed || tpLims.length) actions.push(`${p.symbol}: maker TP ladder re-armed ${placed}/${legs.length} legs (${tpLims.length ? 'replaced' : 'new'})`);
          }
          // fallback trigger: keep any existing pos_profit (exec places its
          // own — price is its call, it is only a backstop); dedupe extras;
          // arm ours at the top leg when none exists. Once every leg has
          // banked the moon bag rides the trailing stop — no fixed cap.
          if (legs.length && !fbRows.length) {
            const topPx = legs[legs.length - 1].px;
            try {
              await X.planOrder(p.symbol, 'pos_profit', String(topPx), '0', p.holdSide, p.marginMode);
              actions.push(`${p.symbol}: fallback pos_profit @ ${topPx}`);
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
const WEDGE_MS = Math.max(120e3, MS * 3);
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
