// liq-guard.mjs — last-ditch survival trimmer for open futures positions.
//
// Behaviour (operator mandate):
//   * watches EVERY open position (foreign/manual included — they need the
//     net most); LIQ_GUARD_SYM seeds a symbol even while flat
//   * dormant unless mark approaches liquidation within LIQ_GUARD_ZONE_PCT
//   * fires ONE ~5% reduceOnly market close per trigger event — never a
//     cascade: re-arm requires a fresh price deterioration past the mark
//     recorded at the last trim, and a SPACING_MS floor serializes orders
//   * after a trim the deeper liquidation band lets the stop reset lower —
//     the guard re-places pos_loss at ~75% of the new band (inside the
//     executor's clamp range so nothing fights it) via place-then-cancel
//   * stops trimming a position below its min-closeable size — the residual
//     runner belongs to its stop, not to shavings
//
// Env: LIQ_GUARD=1 arms it (absent/disabled = pure dormant).  300ms loop fed
// by sanity-checked public ws tickers (REST fallback); signed position/plan
// calls only inside the watch band or on the 30s anchor refresh, fresh again
// at fire time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { integrityNote } from './crc32.mjs';
import { makeExchange } from './exchange/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const ENABLED = process.env.LIQ_GUARD === '1';
const SEED_SYM = process.env.LIQ_GUARD_SYM || 'HBARUSDT'; // watched even while flat
const TRIM_PCT = +(process.env.LIQ_GUARD_TRIM_PCT || 5);
const ZONE_PCT = +(process.env.LIQ_GUARD_ZONE_PCT || 0.8);   // % from liq = danger
const NEAR_PCT = +(process.env.LIQ_GUARD_NEAR_PCT || 2.5);   // % from liq = refresh position truth fast
const SPACING_MS = +(process.env.LIQ_GUARD_SPACING_MS || 4e3); // serialization floor between close orders
const MIN_SIZE = +(process.env.LIQ_GUARD_MIN_SIZE || 2500);  // residual floor for the seed symbol
const POLL_MS = +(process.env.LIQ_GUARD_POLL_MS || 300);
// stop-approach trims: before a position's own pos_loss can kill the WHOLE
// size, shave contract-minimum clips on new lows inside STOP_ZONE of the
// trigger and re-pin the stop deeper toward the liq edge — the position
// bleeds through the dip instead of stopping out all at once.
const STOP_TRIM = process.env.LIQ_GUARD_STOP_TRIM !== '0';
const STOP_ZONE = +(process.env.LIQ_GUARD_STOP_ZONE_PCT || 1.2); // % above stop = trim zone
// tight stops ARE the cut — the shed-through-the-dip ladder needs room
// to work. Below MIN_WIDTH every clip is a fee+loss donation racing a
// trigger that fires in seconds anyway (observed: 130 stop-approach clips
// in one session on 0.55% stops — the zone covered the position's whole
// life). Stops >=1.5% wide keep the ladder, zoned to their last 45%.
const STOP_TRIM_MIN_WIDTH = +(process.env.LIQ_GUARD_STOP_TRIM_MIN_WIDTH_PCT || 1.5);
const STOP_ZONE_FRAC = +(process.env.LIQ_GUARD_STOP_ZONE_FRAC || 0.45);
const STOP_CLIP_MAX = +(process.env.LIQ_GUARD_STOP_CLIP_MAX || 4);
// 0.9 parked every stop PAST god.mjs's band-integrity edge (stopPct >= 0.8 x
// bandPct => "cannot fire before liquidation" FAIL) — the guard was writing
// the exact stops the audit flags. 0.75 sits inside the edge with margin.
const DEEPEN_BAND = +(process.env.LIQ_GUARD_DEEPEN_BAND || 0.75); // stop re-pinned at N% of liq band
// minimum absolute gap between a synthesized/re-pinned stop trigger and the
// liquidation price, % of entry. On a thin high-lev band (BTCUSDT 0.67%)
// a 75% pin still lands ~0.17% from liq — a wick can gap past the trigger
// into the liq engine. The floor keeps the race winnable on thin bands.
const LIQ_GAP_MIN_PCT = +(process.env.LIQ_GUARD_LIQ_GAP_MIN_PCT || 0.25);
// symbols excluded from stop-deepening: scalp entries carry deliberately
// tight operator stops — re-pinning them at the band edge widens the very
// invalidation the entry was sized around. Trims still shed size; the stop
// just stays where the operator put it.
const NO_DEEPEN = new Set(
  (process.env.LIQ_GUARD_NO_DEEPEN_SYMS || '').split(',').map((s) => s.trim()).filter(Boolean)
);
// degenerate-liq guard: on cross-margin accounts with collateral far bigger
// than the position, the exchange's liqPrice sits hundreds of % from entry
// (Bybit demo cross: XRP liq $842 vs entry $1.53 -> band 55046%). Pinning a
// stop at N% of THAT band writes a trigger at absurd prices and the cancel
// sweep then strips the REAL stop. Any band beyond the cap is unusable for
// stop geometry — skip deepen/synth for it (MAXLOSS still applies; it's
// margin-based, not liq-based). Isolated bands are ~100/lev ≈ 2-15%.
const BAND_CAP_PCT = +(process.env.LIQ_GUARD_BAND_CAP_PCT || 40);
// margin-loss circuit: pos_loss stops sit at ~60-80% of posted margin at
// these leverages — letting one fire delivers the whole -1R+ band as a
// tail loss (the epoch's three -$11/-$12/-$20 closes ARE the deficit).
// The floor closes at -(MAXLOSS_PCT x posted margin) — a defined ~-0.6R
// cut while the deep stop stays armed behind it as catastrophe backstop.
const MAXLOSS_PCT = +(process.env.LIQ_GUARD_MAXLOSS_PCT || 0.55);
// naked-position synthesis: an open book with NO pos_loss gets one pinned
// at the liq-band inner edge — same geometry as the deepen path.
const NAKED_SYNTH = process.env.LIQ_GUARD_NAKED_SYNTH !== '0';
const NAKED_COOLDOWN_MS = +(process.env.LIQ_GUARD_NAKED_COOLDOWN_MS || 60e3);
// rebuild gaps last seconds — nakedness must persist across guard cycles
// before it's real enough to write a plan over
const NAKED_CONFIRM_MS = +(process.env.LIQ_GUARD_NAKED_CONFIRM_MS || 9e3);
// breakeven lock for operator scalp positions (the NO_DEEPEN set — these
// are deliberately tight-stopped and skip exec management, so nothing else
// ratchets them). Once the trade runs >= BE_ARM_PCT in favor, pin the stop
// to entry + BE_LOCK_PCT in the trade's direction — covers round-trip
// fees, so the position physically cannot close red from that point.
// Tighten-only: a keeper already better than the lock is left alone.
const BE_ARM_PCT = +(process.env.LIQ_GUARD_BE_ARM_PCT || 0.6);
// swing positions (wider ~3.5% stops, 5% targets) need room to breathe —
// arming BE at 0.6% would scratch trades that still have a live thesis.
// They lock green at a deeper favor threshold instead.
const BE_ARM_SWING_PCT = +(process.env.LIQ_GUARD_BE_ARM_SWING_PCT || 1.2);
const BE_LOCK_PCT = +(process.env.LIQ_GUARD_BE_LOCK_PCT || 0.15);
// progressive profit trail: the BE lock is tier zero. Each deeper favor
// tier ratchets the stop tighter — banks incrementally more of the run
// without capping the upside. Applies book-wide (managed positions compose
// fine — the exec's own ratchets are also tighten-only, tighter wins).
// Foreign/manual positions get their full trail HERE — the exec doesn't
// ratchet what it doesn't own, so without this they lock once and stall.
// progressive profit trail: the BE lock is tier zero, then a DENSE greedy
// ladder — each tier banks ~80-85% of the run. The stop IS the take-profit:
// any green trade that breathes gets its profit locked tighter every tick,
// so a retrace closes it green instead of round-tripping to fees. Operator
// mandate: addicted to banking profit, allergic to giving it back.
const TRAIL_SWING = [
  [BE_ARM_SWING_PCT, BE_LOCK_PCT],
  [0.4, 0.3], [0.6, 0.48], [0.8, 0.65], [1.0, 0.85],
  [1.3, 1.1], [1.6, 1.4], [2.0, 1.75], [2.5, 2.25], [3.0, 2.75],
];
const TRAIL_SCALP = [
  [BE_ARM_PCT, BE_LOCK_PCT],
  [0.35, 0.3], [0.5, 0.42], [0.7, 0.6], [0.9, 0.78],
  [1.1, 0.95], [1.4, 1.25], [1.7, 1.5], [2.1, 1.9],
];
// bagrunner profile — operator manual opens (state/manual-book.json, last
// opener non-api). The audit's bleed was fee-churn: gross wins flipped red
// by round-trip cost. The trail banks fees the moment the move covers them
// (taker RT ≈ 0.12% of price) then ratchets greedily — profit locked is
// profit kept, runners still ride the upper tiers. Tighten-only, composes
// with any stop the operator placed themselves.
const BAGRUN_ON = process.env.LIQ_GUARD_BAGRUN !== '0';
const TRAIL_BAGRUN = [
  [0.18, 0.12],                     // fee-recovery: covers ~RT taker fees
  [0.28, 0.22], [0.4, 0.33], [0.55, 0.46], [0.75, 0.64],
  [1.0, 0.87], [1.3, 1.15], [1.7, 1.5], [2.2, 2.0], [3.0, 2.8],
];
// manual positions vanish faster too — a bagrunner doesn't ride a turn
const BAGRUN_VANISH_MIN_PEAK = +(process.env.LIQ_GUARD_BAGRUN_VANISH_PEAK || 0.35);
const BAGRUN_VANISH_FRAC = +(process.env.LIQ_GUARD_BAGRUN_VANISH_FRAC || 0.32);
const BAGRUN_VANISH_MIN_FAV = +(process.env.LIQ_GUARD_BAGRUN_VANISH_FAV || 0.12);
// scalp stall-cut (NO_DEEPEN symbols): a mean-reversion scalp still deep
// in the red after SCALP_STALL_MS is a failed thesis — closing early
// banks ~30% of the stop distance instead of donating the whole stop.
// Fires only when adverse run >= SCALP_STALL_FRAC of the entry->stop
// distance AND the position is old enough. The live stop remains the
// backstop if this never trips.
const SCALP_STALL_MS = +(process.env.LIQ_GUARD_SCALP_STALL_MS || 30 * 60e3);
const SCALP_STALL_FRAC = +(process.env.LIQ_GUARD_SCALP_STALL_FRAC || 0.7);
// software take-profit for scalp positions that can't hold a TP plan
// (min-size overcover invalidation). 0 disables — sized legs carry it.
const SCALP_TP_PCT = +(process.env.LIQ_GUARD_SCALP_TP_PCT || 1.5);
// crash brake: a mark that gaps adversely >= CRASH_PCT within CRASH_MS is a
// wick the trim ladder cannot outrun — a 28% candle at 30x crosses the whole
// band between polls, and the 0.8% zone arms too late by design. Fire a big
// close immediately; if the gap already ate >=75% of the remaining distance
// to liquidation the residual is dead — close the whole side.
const CRASH_PCT = +(process.env.LIQ_GUARD_CRASH_PCT || 0.8);
const CRASH_MS = +(process.env.LIQ_GUARD_CRASH_MS || 5e3);
const CRASH_CLOSE_PCT = +(process.env.LIQ_GUARD_CRASH_CLOSE_PCT || 50);
const CRASH_DEAD_PCT = +(process.env.LIQ_GUARD_CRASH_DEAD_PCT || 0.4); // dist-to-liq after gap = unsalvageable
// high-lev arming: a fixed 0.8% zone leaves a 30x band (3.3%) asleep until
// the last quarter of it. Scale the arming zone to the band so leverage
// earns an earlier trim response, capped so low-lev books stay dormant.
const ZONE_BAND_FRAC = +(process.env.LIQ_GUARD_ZONE_BAND_FRAC || 0.45);
const ZONE_MAX_PCT = +(process.env.LIQ_GUARD_ZONE_MAX_PCT || 6);
// stop-approach clips whose protective value (clipNotional x dist-to-stop)
// is under this are skipped — see the floor comment at the fire gate.
const DUST_USD = +(process.env.LIQ_GUARD_DUST_USD || 0.15);
// peak-giveback vanish — the desk rule "disappear the second the tape turns
// on you". Each position's peak favor is tracked; a locked-green trade that
// retraces >= VANISH_FRAC of its best run while still green gets market-
// closed — bank the turn rather than riding it back through the stop.
const VANISH_MIN_PEAK = +(process.env.LIQ_GUARD_VANISH_MIN_PEAK || 0.6);  // smallest peak worth protecting
const VANISH_FRAC = +(process.env.LIQ_GUARD_VANISH_FRAC || 0.4);          // giveback fraction of peak
const VANISH_MIN_FAV = +(process.env.LIQ_GUARD_VANISH_MIN_FAV || 0.15);   // below this the stop owns it
// continuous ratchet: once the first tier arms, the lock additionally
// follows KEEP_FRAC of peak favor — fills the gaps between rungs, never
// looser than a rung, tighten-only so it composes with the tier ladder.
const KEEP_FRAC = +(process.env.LIQ_GUARD_KEEP_FRAC || 0.75);
// manual-book: exec writes the set of held symbols whose last open fill
// was operator/app-originated (src != api). Cached 20s like plans.
const manualCache = { at: 0, syms: new Set() };
const manualSyms = () => {
  if (Date.now() - manualCache.at < 20e3) return manualCache.syms;
  manualCache.at = Date.now();
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'manual-book.json'), 'utf8'));
    manualCache.syms = new Set(d.syms || []);
  } catch { manualCache.syms = new Set(); }
  return manualCache.syms;
};
const planCache = {}; // sym -> { at, rows } — plans change slowly, poll 20s
// pc.at only advances on a successful fetch — a network blip used to freeze
// the plan view for a full 20s (blind stop-approach/vanish tier on stale rows)
async function plansFor(sym) {
  const pc = planCache[sym] || (planCache[sym] = { at: 0, rows: [] });
  if (Date.now() - pc.at > 20000) {
    const rows = await getPlans(sym).catch(() => null);
    if (rows) { pc.rows = rows; pc.at = Date.now(); pc.fails = 0; }
    else { pc.fails = (pc.fails || 0) + 1; pc.at = Date.now() - 20000 + 3000; } // retry in ~3s, not 20
  }
  return pc;
}
const STATE = path.join(__dirname, '..', 'state', 'liq-guard.json');

// demo/paper mode: same SENTINEL_EXEC switch as the exec — the guard must
// watch the SAME account the engine trades, or demo positions run naked
// while the guard stares at an empty live book. SENTINEL_EXCHANGE picks
// the driver; all signed wire ops go through scripts/exchange/ so hedge
// semantics, margin-mode params and plan verbs stay consistent with exec.
const MODE = (process.env.SENTINEL_EXEC || 'off').toLowerCase();
const DEMO = MODE === 'demo';
const X = makeExchange(process.env);
const log = (...a) => console.log('[liq-guard]', ...a);

if (!ENABLED) { log('LIQ_GUARD not armed — exiting'); process.exit(0); }
if (!X.hasCreds) { log(`no ${X.name} ${MODE} creds — exiting`); process.exit(1); }

const pubTicker = async (sym) => {
  const t = await X.ticker(sym).catch(() => null);
  const row = Array.isArray(t) ? t[0] : t;
  return +(row?.markPrice || row?.lastPr || row?.lastPrice || 0);
};
const getAllPos = async () => {
  const rows = await X.getPos();
  return (rows || []).filter((x) => +x.total > 0).map((p) => ({
    sym: p.symbol, side: p.holdSide || p.side, size: +p.total, entry: +p.openPriceAvg,
    upl: +p.unrealizedPL, liq: +p.liquidationPrice || 0, marginMode: p.marginMode, lev: +p.leverage,
    margin: +p.marginSize || 0, cTime: +p.cTime || 0,
  }));
  // no liq>0 filter: Bybit cross positions can report empty liqPrice
  // (collateral >> position => effectively un-liquidatable). liq-geometry
  // paths treat liq=0 as infinite distance; margin-based circuits still run.
};
const getPlans = (sym) => X.getPlans(sym);
const cancelPlan = (sym, planType, orderId) =>
  X.cancelPlanOrders(sym, planType, [String(orderId)]);
// pos_loss covers the whole position — size stays '0' so both adapters omit it.
const planLoss = (sym, side, trigger, marginMode) =>
  X.planOrder(sym, 'pos_loss', trigger, '0', side, marginMode);
// shared stop geometry for deepen/synth/repair: park at DEEPEN_BAND of the
// band, but never closer to liq than LIQ_GAP_MIN_PCT — the floor dominates
// on thin bands so the trigger keeps a winnable gap from the liq engine.
const bandStopTrig = (entry, liq, side, pxDec) => {
  const bandPct = Math.abs(entry - liq) / entry * 100;
  const deep = side === 'long'
    ? entry * (1 - (bandPct * DEEPEN_BAND) / 100)
    : entry * (1 + (bandPct * DEEPEN_BAND) / 100);
  const floor = side === 'long' ? liq * (1 + LIQ_GAP_MIN_PCT / 100) : liq * (1 - LIQ_GAP_MIN_PCT / 100);
  const t = side === 'long' ? Math.max(deep, floor) : Math.min(deep, floor);
  return +t.toFixed(pxDec);
};
// INSTANT ADAPTATION: after any trim the position size has changed — kick the
// protection watcher (state/bw-kick, fs.watch'd there) so the SL and the
// staggered TP ladder re-arm against the NEW size in the same second instead
// of waiting out its poll cycle.
const kickWatcher = () => {
  try { fs.writeFileSync(path.join(__dirname, '..', 'state', 'bw-kick'), String(Date.now())); } catch {}
};
// limit-chase close for NON-emergency exits (vanish, scalp-TP): post just
// through the touch so the fill is near-instant but price-bounded — takes
// liquidity like a market order but caps the slip. One reprice, then the
// market fallback guarantees the exit. Crash/liq/loss-cap paths keep the
// unconditional market close — emergencies don't haggle.
const closeSmart = async (sym, side, sizeStr, marginMode) => {
  const c = cm[sym] || {};
  const pxDec = +c.pricePlace ?? 6;
  const mm = marginMode === 'crossed' ? 'crossed' : 'isolated';
  for (const slip of [4e-4, 12e-4]) {
    const m = await pickMark(sym);
    if (!m) break;
    const px = +(side === 'long' ? m * (1 - slip) : m * (1 + slip)).toFixed(pxDec);
    try {
      // hedge-mode close rides the same inverted-side shape the proven
      // marketOrder path uses (long close = 'buy' + tradeSide:'close');
      // 'normal' not post_only — a chase order must be allowed to take.
      const extra = posMode === 'hedge'
        ? { side: side === 'long' ? 'buy' : 'sell', tradeSide: 'close', timeInForceValue: 'normal', marginMode: mm }
        : { reduceOnly: 'YES', timeInForceValue: 'normal', marginMode: mm };
      const r = await X.limitOrder(sym, side === 'long' ? 'sell' : 'buy', sizeStr, String(px), extra);
      await new Promise((rs) => setTimeout(rs, 900));
      const pos = (await getAllPos().catch(() => [])).find((x) => x.sym === sym && x.side === side);
      if (!pos || +pos.size <= 0) return true;                 // fully filled
      const oid = r?.orderId || r?.ordId;
      if (oid) await X.cancelOrder(sym, String(oid)).catch(() => {});
      sizeStr = String(pos.size);                              // chase the remainder only
    } catch { break; }                                         // limit path dead — go market
  }
  return closeMarket(sym, side, sizeStr, posMode, marginMode); // guaranteed fill
};
const closeMarket = async (sym, side, sizeStr, posMode, marginMode) => {
  const closeSide = side === 'long' ? 'sell' : 'buy'; // order side — adapters map close semantics
  // the position's REAL margin mode — bot entries are isolated, manual
  // positions are usually crossed. Bitget rejects a mismatched mode (40774)
  // exactly when the guard exists to fire; Bybit ignores the field entirely.
  const extra = X.name === 'bitget' ? { marginMode: marginMode === 'crossed' ? 'crossed' : 'isolated' } : {};
  try {
    return await X.marketOrder(sym, closeSide, sizeStr, 'close', extra);
  } catch (e) {
    // margin-mode mismatch is the only retryable close failure — flip and
    // try once. posMode side semantics live inside the adapter.
    if (X.name !== 'bitget' || !/margin ?mode|40774/.test(e.message)) {
      outboxDedup(`cf:${sym}:${side}`, `🚨 CLOSE-FAIL ${sym} ${side} ${sizeStr}: ${e.message} — position still open, retrying next tick`);
      throw e;
    }
    try {
      return await X.marketOrder(sym, closeSide, sizeStr, 'close', {
        marginMode: marginMode === 'crossed' ? 'isolated' : 'crossed',
      });
    } catch (e2) {
      outboxDedup(`cf2:${sym}:${side}`, `🚨 CLOSE-FAIL ${sym} ${side} ${sizeStr} (both margin modes): ${e2.message}`);
      throw e2;
    }
  }
};

// --- realtime mark feed: exchange public WS, REST ticker stays the fallback ---
// READ-ONLY public channel — no credentials near it, cannot place orders.
//   * no ws mark accepted until a REST anchor exists; a frame >5% off the
//     anchor is rejected and the socket resyncs — a poisoned/garbled feed can
//     never reach the trigger math
//   * ws mark stale >1.5s => treated as dead; REST polling resumes
const WS_DRIVERS = {
  bitget: {
    url: 'wss://ws.bitget.com/v2/ws/public',
    subMsg: (syms) => ({ op: 'subscribe', args: syms.map((s) => ({ instType: 'USDT-FUTURES', channel: 'ticker', instId: s })) }),
    ping: 'ping', // raw text heartbeat
    parse: (m) => {
      const d = m?.data?.[0];
      return { sym: m?.arg?.instId, px: +(d?.markPrice || d?.lastPr || 0) };
    },
  },
  bybit: {
    url: DEMO ? 'wss://stream-demo.bybit.com/v5/public/linear' : 'wss://stream.bybit.com/v5/public/linear',
    subMsg: (syms) => ({ op: 'subscribe', args: syms.map((s) => `tickers.${s}`) }),
    ping: { op: 'ping' }, // v5 wants a JSON op frame
    parse: (m) => ({
      sym: (m?.topic || '').startsWith('tickers.') ? m.topic.slice(8) : null,
      px: +(m?.data?.markPrice || m?.data?.lastPrice || 0),
    }),
  },
};
const WSD = WS_DRIVERS[X.name] || WS_DRIVERS.bitget;

const wsMarks = new Map();   // sym -> { px, at }
const restMarks = new Map(); // sym -> { px, at }  (sanity anchor + fallback)
const subbed = new Set();
let wsRef = null, wsRetryMs = 1000;
function startWs() {
  const ws = new WebSocket(WSD.url);
  wsRef = ws;
  let ping = null, watchdog = null;
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { try { ws.terminate(); } catch {} }, 60e3); };
  ws.on('open', () => {
    wsRetryMs = 1000;
    if (subbed.size) ws.send(JSON.stringify(WSD.subMsg([...subbed])));
    ping = setInterval(() => { try { ws.send(typeof WSD.ping === 'string' ? WSD.ping : JSON.stringify(WSD.ping)); } catch {} }, 20e3);
    arm();
    log(`ws feed connected (${X.name}) — ${subbed.size} ticker(s)`);
  });
  ws.on('message', (buf) => {
    arm();
    let m; try { m = JSON.parse(buf.toString()); } catch { return; } // heartbeat
    const { sym, px } = WSD.parse(m);
    if (!sym || !(px > 0)) return;
    const anchor = restMarks.get(sym)?.px || 0;
    if (!anchor) return; // untrusted until a REST anchor exists for this symbol
    if (Math.abs(px / anchor - 1) > 0.05) {
      log(`ws ${sym} mark ${px} rejected (${(Math.abs(px / anchor - 1) * 100).toFixed(1)}% off REST anchor ${anchor}) — resyncing`);
      try { ws.terminate(); } catch {}
      return;
    }
    wsMarks.set(sym, { px, at: Date.now() });
  });
  const bye = () => {
    clearInterval(ping); clearTimeout(watchdog);
    wsMarks.clear();
    if (wsRef === ws) wsRef = null;
    setTimeout(startWs, wsRetryMs);
    wsRetryMs = Math.min(wsRetryMs * 2, 30e3);
  };
  ws.on('close', bye);
  ws.on('error', () => { try { ws.close(); } catch { bye(); } });
}
const ensureSub = (sym) => {
  if (subbed.has(sym)) return;
  subbed.add(sym);
  if (wsRef?.readyState === WebSocket.OPEN)
    try { wsRef.send(JSON.stringify(WSD.subMsg([sym]))); } catch {}
};
const markMeta = {}; // sym -> { src, at } — audit trail: which feed served the last decision-grade mark
const pickMark = async (sym) => {
  const w = wsMarks.get(sym);
  if (w && Date.now() - w.at < 1500) {
    const r = restMarks.get(sym);
    if (!r || Date.now() - r.at > 30e3) { // keep the sanity anchor honest while ws feeds
      const p = await pubTicker(sym).catch(() => 0);
      if (p) restMarks.set(sym, { px: p, at: Date.now() });
    }
    markMeta[sym] = { src: 'ws', at: w.at };
    return w.px;
  }
  const r = restMarks.get(sym);
  if (!r || Date.now() - r.at > 3500) { // ws dead/stale — REST fallback at the old cadence
    const p = await pubTicker(sym).catch(() => 0);
    if (p) restMarks.set(sym, { px: p, at: Date.now() });
  }
  const rr = restMarks.get(sym);
  // staleness bound: a REST mark that failed to refresh must not masquerade
  // as current — a 60s-old price can fire trims/vanish on phantom geometry.
  // No fresh mark = blind, and the caller reports it rather than acting.
  if (rr && Date.now() - rr.at > 15e3) { markMeta[sym] = { src: 'stale-rest', at: rr.at }; return 0; }
  const px = rr?.px || 0;
  if (px) markMeta[sym] = { src: 'rest', at: rr.at };
  return px;
};

// ---- flow toxicity (VPIN-lite): one-sided recent volume means the tape is
// being DRIVEN, not traded — informed flow eats stale geometry (the market
// makers' answer to adverse selection: tighten before the cascade, not
// after). Signed up/down volume share over the last 8 x 1m candles; when
// >= TOX_FRAC of it runs AGAINST our side, the keep-ratchet tightens and
// the vanish threshold halves. Public klines, cached per TOX_MS, zero creds.
const TOX_MS = +(process.env.LIQ_GUARD_TOX_MS || 45e3);
const TOX_FRAC = +(process.env.LIQ_GUARD_TOX_FRAC || 0.7);
const toxCache = {}; // sym -> { at, upFrac }
const toxFor = async (sym) => {
  const t = toxCache[sym];
  if (t && Date.now() - t.at < TOX_MS) return t;
  try {
    let rows = [];
    if (X.name === 'bybit') {
      const j = await (await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=1&limit=8`, { signal: AbortSignal.timeout(8e3) })).json();
      rows = (j?.result?.list || []).map((r) => ({ o: +r[1], c: +r[4], v: +r[5] }));
    } else {
      const j = await (await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1m&limit=8`, { signal: AbortSignal.timeout(8e3) })).json();
      rows = (j?.data || []).map((r) => ({ o: +r[1], c: +r[4], v: +r[5] }));
    }
    let up = 0, dn = 0;
    for (const r of rows) (r.c >= r.o ? (up += r.v) : (dn += r.v));
    const tot = up + dn;
    toxCache[sym] = { at: Date.now(), upFrac: tot > 0 ? up / tot : 0.5 };
  } catch {}
  return toxCache[sym] || null;
};

// ---- fill markout grading ("grade every fill at 1s/10s/60s"): every close
// fill gets its mark recorded at fixed post-exit horizons. Positive drift =
// price kept moving the way we were positioned after the exit — money left
// on the table (exit early/loose); negative = the tape faded right after —
// the exit dodged it. Journaled to api/markouts.json (rolling 400) so the
// trail tiers can be tuned against measured post-exit drift, not vibes.
const MK_HORIZONS = [1e3, 10e3, 60e3, 300e3]; // +5min leg: exits that look flat at 60s can still leak at 5min
const MK_PATH = path.join(__dirname, '..', 'api', 'markouts.json');
const markoutSweep = async () => {
  try {
    const pend = gates.__mkPending || (gates.__mkPending = []);
    // first run: don't backfill — historical fills graded against today's
    // marks are garbage. Skip to live flow.
    if (!gates.__mkSeen) gates.__mkSeen = Date.now();
    let rows = [];
    try { rows = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', DEMO ? 'demo-fills.json' : 'real-fills.json'), 'utf8')).fills) || []; } catch {}
    for (const f of rows) {
      if ((f.ts || 0) <= (gates.__mkSeen || 0) || f.tradeSide !== 'close') continue;
      gates.__mkSeen = f.ts;
      pend.push({ sym: f.symbol, px: +f.price, ts: +f.ts, dir: f.side === 'sell' ? 1 : -1, got: {} });
    }
    if (pend.length > 80) pend.splice(0, pend.length - 80);
    for (const q of pend)
      for (const h of MK_HORIZONS)
        if (q.got[h] == null && Date.now() - q.ts >= h) {
          const m = await pickMark(q.sym);
          if (m) q.got[h] = +(((m - q.px) / q.px) * 100 * q.dir).toFixed(3);
        }
    const done = pend.filter((q) => MK_HORIZONS.every((h) => q.got[h] != null));
    if (done.length) {
      gates.__mkPending = pend.filter((q) => !done.includes(q));
      let rec = { rows: [] };
      try { rec = JSON.parse(fs.readFileSync(MK_PATH, 'utf8')); } catch {}
      rec.at = Date.now();
      rec.note = 'drift% in position direction post-exit: + = money left on table, - = exit dodged the fade';
      rec.rows = (rec.rows || []).concat(done.map((q) => ({ sym: q.sym, exitPx: q.px, ts: q.ts, d1: q.got[1e3], d10: q.got[10e3], d60: q.got[60e3], d300: q.got[300e3] }))).slice(-400);
      fs.writeFileSync(MK_PATH, JSON.stringify(rec));
    }
    // staleness floor — a pending markout that never got marks dies at 10min
    gates.__mkPending = (gates.__mkPending || []).filter((q) => Date.now() - q.ts < 600e3);
  } catch (e) { log(`markout error: ${e.message}`); }
};

// ---- markout-driven trail tuning: the exits grade themselves. Median 60s
// post-exit drift > +0.05% = price kept running our way — we sold early →
// loosen (keep less of peak, tolerate deeper giveback). < -0.05% = exits
// dodge fades → tighten is free. Winsorized, bounded, 30min cadence,
// persisted in gates.__tune and journaled. Needs MK_MIN_N measured exits.
const MK_MIN_N = +(process.env.LIQ_GUARD_MK_MIN_N || 30);
const TUNE_MS = +(process.env.LIQ_GUARD_TUNE_MS || 30 * 60e3);
const tuneNow = async () => {
  gates.__tune = gates.__tune || { keep: KEEP_FRAC, vanish: VANISH_FRAC, at: 0 };
  if (Date.now() - gates.__tune.at < TUNE_MS) return;
  gates.__tune.at = Date.now();
  try {
    const rows = (JSON.parse(fs.readFileSync(MK_PATH, 'utf8')).rows) || [];
    const ds = rows.map((r) => r.d60).filter((x) => x != null).sort((a, b) => a - b);
    gates.__tune.n = ds.length;
    if (ds.length < MK_MIN_N) return;
    const w = ds.slice(Math.floor(ds.length * 0.1), Math.ceil(ds.length * 0.9));
    const med = w[Math.floor(w.length / 2)];
    let k = gates.__tune.keep ?? KEEP_FRAC, v = gates.__tune.vanish ?? VANISH_FRAC;
    if (med > 0.05) { k = Math.max(0.55, k - 0.02); v = Math.min(0.6, v + 0.05); }        // leaving money — let it breathe
    else if (med < -0.05) { k = Math.min(0.85, k + 0.02); v = Math.max(0.25, v - 0.05); } // dodging fades — greed is free
    if (k !== gates.__tune.keep || v !== gates.__tune.vanish) {
      log(`TUNE: markout med d60 ${med}% n=${ds.length} → keep ${k} vanish ${v}`);
      outbox(`🎛 TRAIL TUNE — measured exits: med 60s post-exit drift ${med}% (n=${ds.length}). Ratchet now keeps ${Math.round(k * 100)}% of peak; vanish at ${Math.round(v * 100)}% giveback.`);
    }
    gates.__tune.keep = k; gates.__tune.vanish = v; gates.__tune.med60 = med;
  } catch {}
};

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const API_STATE = path.join(__dirname, '..', 'api', 'liq-guard.json');
const writeState = (o) => {
  const body = JSON.stringify(o);
  try { fs.writeFileSync(STATE + '.tmp', body); fs.renameSync(STATE + '.tmp', STATE); integrityNote(STATE, body); } catch {}
  // publish to api/ too — the dashboard reads artifacts, not state/
  try { fs.writeFileSync(API_STATE, body); integrityNote(API_STATE, body); } catch {}
};
// outbound alerts — tg-watch drains this JSONL into Saved Messages (~30s lag)
const OUTBOX = path.join(__dirname, '..', 'state', 'tg-outbox.jsonl');
const outbox = (text) => { try { fs.appendFileSync(OUTBOX, JSON.stringify({ ts: Date.now(), text }) + '\n'); } catch {} };
const pageDedupe = {}; // tag -> last page ts — repeating failures page once per 10min, not per tick
const outboxDedup = (tag, text, windowMs = 600e3) => {
  const now = Date.now();
  if (now - (pageDedupe[tag] || 0) < windowMs) return;
  pageDedupe[tag] = now;
  outbox(text);
};
// outbox hygiene: tg-watch deletes the file after delivering, but if the
// watcher is down the queue would grow forever — hard-cap at 200 lines,
// newest wins (a flood of repeats must not evict the newest alarm).
setInterval(() => {
  try {
    if (!fs.existsSync(OUTBOX) || fs.statSync(OUTBOX).size < 64 * 1024) return;
    const lines = fs.readFileSync(OUTBOX, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 200) fs.writeFileSync(OUTBOX, lines.slice(-200).join('\n') + '\n');
  } catch {}
}, 60e3);
// proximity ladder — alert once per tier crossed downward; reset on recovery
const ALERT_TIERS = [4, 2.5, 1.5];

// per-position trigger memory, keyed `${sym}:${side}` — survives restarts
let gates = readState().gates || {};
const trims = (readState().trims || []).slice(-500); // cap — a long trim cascade must not grow state forever
let posMode = 'oneway';
const cm = {}; // sym -> contract meta

let posCache = [], posCacheAt = 0, lastStateWrite = 0, emptyReads = 0;
const BOOTED_AT = Date.now();
const anyNear = () =>
  posCache.some((p) => {
    const m = wsMarks.get(p.sym)?.px || restMarks.get(p.sym)?.px || 0;
    if (!m) return true; // unknown mark — stay awake
    const g = p.liq > 0 ? (p.side === 'long' ? (m - p.liq) / p.liq * 100 : (p.liq - m) / p.liq * 100) : Infinity;
    // high-lev bands are thin — a 30x book is "near" at half its band, not
    // at a flat 2.5% that only wakes the poller inside the kill zone.
    const band = p.liq > 0 && p.entry > 0 ? Math.abs(p.entry - p.liq) / p.entry * 100 : 0;
    return g <= Math.max(NEAR_PCT, Math.min(ZONE_MAX_PCT, band * ZONE_BAND_FRAC) + 1);
  });

async function tick() {
  // position discovery cadence: 2.5s while anything is near danger, else 30s
  const wantMs = posCache.length && anyNear() ? 2500 : 30e3;
  if (Date.now() - posCacheAt > wantMs) {
    const p = await getAllPos().catch(() => null);
    // suspicious-empty guard: a flaky [] while positions are held must not
    // blind the watcher — 3 consecutive empties = genuinely flat. A real
    // flatten confirms in <=3 polls; a bad read never costs coverage.
    if (p) {
      if (p.length) { emptyReads = 0; posCache = p; posCacheAt = Date.now(); p.forEach((x) => ensureSub(x.sym)); }
      else if (!posCache.length || ++emptyReads >= 3) { emptyReads = 0; posCache = p; posCacheAt = Date.now(); }
      else posCacheAt = Date.now() - wantMs + 1200; // suspect — retry in ~1s, not 30s
    }
    if (!posModeConfirmed) posMode = await probePosMode();
  }
  ensureSub(SEED_SYM);

  // feed hygiene — a symbol's ticker subscription, cached mark and metadata
  // outlive the position by design (cheap), but forever is a leak: prune
  // entries for symbols no longer held (SEED_SYM stays — it's the probe).
  const heldSyms = new Set([...posCache.map((p) => p.sym), SEED_SYM]);
  for (const s of [...subbed]) if (!heldSyms.has(s)) { subbed.delete(s); wsMarks.delete(s); delete markMeta[s]; restMarks.delete(s); }

  const stOut = { at: Date.now(), positions: {}, trims };
  let dirty = false;
  for (const p of posCache) {
    const key = `${p.sym}:${p.side}`;
    const mark = await pickMark(p.sym);
    if (!mark) {
      // blind coverage gap — a held position with no mark source gets NO
      // protection this tick and previously vanished from state entirely.
      // Surface it (stOut.blind) and page once per 10min — an unpriced
      // position is exactly the one that can die unseen.
      const g = (gates[key] ||= { lastTrim: 0, lastTrimMark: null });
      g.blindSince = g.blindSince || Date.now();
      stOut.positions[key] = { size: p.size, liq: p.liq || null, mark: null, blindMs: Date.now() - g.blindSince };
      if (Date.now() - g.blindSince > 30e3 && Date.now() - (g.blindPaged || 0) > 600e3) {
        g.blindPaged = Date.now(); dirty = true;
        outbox(`🚨 BLIND MARK — ${p.sym} ${p.side} ${p.size}: no mark for ${Math.round((Date.now() - g.blindSince) / 1e3)}s — protections parked. Exchange-side stop still armed.`);
      }
      continue;
    }
    // flow toxicity for this symbol — adverse = the last minutes' volume is
    // dominated by trade AGAINST our side (a long staring at seller-driven tape)
    const tox = await toxFor(p.sym);
    const toxAdv = !!(tox && (p.side === 'long' ? (1 - tox.upFrac) >= TOX_FRAC : tox.upFrac >= TOX_FRAC));
    // liq=0 => un-liquidatable book math (cross collateral >> position) —
    // report infinite distance so proximity/danger paths stay dormant.
    const distPct = p.liq > 0
      ? (p.side === 'long' ? (mark - p.liq) / p.liq * 100 : (p.liq - mark) / p.liq * 100)
      : Infinity;
    const g = (gates[key] ||= { lastTrim: 0, lastTrimMark: null });
    if (g.blindSince) { g.blindSince = 0; g.blindPaged = 0; dirty = true; } // mark recovered — clear the blind flag
    // new-arrival alert: a position the guard has never seen gets a
    // one-time "now watching" ping — silent arming meant the operator
    // couldn't tell a protected position from an untracked one.
    if (!g.seen) {
      g.seen = true; dirty = true;
      outbox(`👁 LIQ-GUARD armed — ${p.sym} ${p.side} ${p.size} @ ${p.entry} · ${distPct.toFixed(1)}% from liq ${p.liq} · ${p.marginMode || ''}`);
    }
    // proximity ladder: alert on each tier crossed downward, re-arm above 4.5%
    const sev = ALERT_TIERS.filter((t) => distPct <= t).length;
    if (sev > (g.tier || 0)) {
      // fresh-verify before raising the alarm — posCache can sit ~30s stale
      // when nothing is near danger, and a position the operator just closed
      // must not cry wolf. Fetch fails -> alert anyway on cached truth (a
      // network blip shouldn't silence a real proximity warning).
      const fresh = await getAllPos().catch(() => null);
      if (fresh) { posCache = fresh; posCacheAt = Date.now(); }
      const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
      const fpDist = fp ? (fp.side === 'long' ? (mark - fp.liq) / fp.liq * 100 : (fp.liq - mark) / fp.liq * 100) : null;
      if (!fresh || (fp && fpDist <= ALERT_TIERS[0])) {
        g.tier = sev;
        // boundary-flutter guard: hovering at a tier edge re-fires on every
        // re-cross — space repeats per position so Telegram stays signal,
        // not noise. A NEW deeper tier always fires immediately.
        if (Date.now() - (g.lastAlert || 0) >= 10 * 60e3 || sev > (g.lastAlertTier || 0)) {
          g.lastAlert = Date.now(); g.lastAlertTier = sev;
          const pv = fp || p, pd = fpDist ?? distPct;
          outbox(`⚠️ LIQ PROXIMITY — ${p.sym} ${p.side} ${pd.toFixed(2)}% from liquidation\nmark ${mark} · liq ${pv.liq} · size ${pv.size} · upl $${(+pv.upl).toFixed(2)}`);
        }
      }
    } else if (distPct > ALERT_TIERS[0] + 0.5) g.tier = 0;
    stOut.positions[key] = { size: p.size, liq: p.liq || null, mark, distPct: Number.isFinite(distPct) ? +distPct.toFixed(3) : null, lastTrim: g.lastTrim, lastTrimMark: g.lastTrimMark, tox: toxAdv ? 1 : 0, peakFav: g.peakFav ? +g.peakFav.toFixed(2) : null, markSrc: markMeta[p.sym]?.src || null, markAgeMs: markMeta[p.sym] ? Date.now() - markMeta[p.sym].at : null };

    // ---- crash brake: wick velocity, not proximity. A mark that gapped
    // >=CRASH_PCT adverse within CRASH_MS is a cascade the 0.8% zone can't
    // catch — the whole band crosses between polls (that's what killed NMR).
    // Fires on ANY open position incl. operator-managed; scaled response:
    // still-salvageable => cut CRASH_CLOSE_PCT, already at the lip => full.
    {
      const h = (g.markHist ||= []);
      h.push({ at: Date.now(), px: mark });
      while (h.length > 1 && Date.now() - h[0].at > CRASH_MS) h.shift();
      const ref = h[0];
      const gapPct = ref ? (p.side === 'long' ? (ref.px - mark) / ref.px * 100 : (mark - ref.px) / ref.px * 100) : 0;
      // threshold scales with the band: a 30x band (3.3%) fires at 0.8%,
      // a 5x band (20%) needs a 2% gap — keeps low-lev noise out of it.
      const band0 = p.liq > 0 && p.entry > 0 ? Math.abs(p.entry - p.liq) / p.entry * 100 : Infinity;
      const crashTrig = Math.max(CRASH_PCT, band0 * 0.1);
      if (gapPct >= crashTrig && Date.now() - (g.lastCrash || 0) >= SPACING_MS) {
        const fresh = await getAllPos().catch(() => null);
        if (fresh) { posCache = fresh; posCacheAt = Date.now(); }
        const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
        if (fp) {
          const fdist = fp.liq > 0
            ? (fp.side === 'long' ? (mark - fp.liq) / fp.liq * 100 : (fp.liq - mark) / fp.liq * 100)
            : Infinity;
          const q = fdist <= CRASH_DEAD_PCT ? fp.size : Math.floor((fp.size * CRASH_CLOSE_PCT / 100) * Math.pow(10, +(cm[p.sym]?.sizePlace ?? 6))) / Math.pow(10, +(cm[p.sym]?.sizePlace ?? 6));
          if (q > 0 && q <= fp.size) {
            try {
              await closeMarket(fp.sym, fp.side, String(q), posMode, fp.marginMode);
              kickWatcher();
              g.lastCrash = Date.now();
              h.length = 0; // consume the window — next gap needs a fresh base
              log(`CRASH-BRAKE ${key}: mark ${mark} gapped ${gapPct.toFixed(2)}% in <=${CRASH_MS}ms — closed ${q}/${fp.size} (${fdist.toFixed(2)}% from liq)`);
              outbox(`🚨 CRASH-BRAKE — ${fp.sym} ${fp.side}: -${gapPct.toFixed(2)}% wick in <${CRASH_MS / 1000}s. Closed ${q}/${fp.size} @ ${mark}${fdist <= CRASH_DEAD_PCT ? ' (full — at liq lip)' : ''}. Wick survival > proximity trims.`);
              dirty = true;
            } catch (e) { log(`CRASH-BRAKE ${key} close failed: ${e.message}`); }
          }
        }
      }
    }

    // ---- margin-loss circuit: close the whole position when mark-to-market
    // loss crosses -(MAXLOSS_PCT x posted margin). Fires BEFORE the deep
    // pos_loss band — converts tail stop-outs into bounded ~-0.6R losses.
    if (MAXLOSS_PCT > 0 && p.margin > 0 && p.upl <= -(MAXLOSS_PCT * p.margin)) {
      const fresh = await getAllPos().catch(() => null);
      const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
      if (fp && fp.margin > 0 && fp.upl <= -(MAXLOSS_PCT * fp.margin)) {
        const capUsd = (MAXLOSS_PCT * fp.margin).toFixed(2);
        try {
          await closeMarket(fp.sym, fp.side, String(fp.size), posMode, fp.marginMode);
          kickWatcher(); // watcher sweeps the orphan plans NOW, not next poll
          log(`LOSS-CAP ${key}: upl ${fp.upl.toFixed(2)} <= -${capUsd} (${(MAXLOSS_PCT * 100).toFixed(0)}% margin) — full close @ ${mark}`);
          outbox(`🛑 LOSS-CAP — ${fp.sym} ${fp.side}: upl $${fp.upl.toFixed(2)} breached -$${capUsd} floor (${(MAXLOSS_PCT * 100).toFixed(0)}% of margin). Full close @ ${mark} — bounded loss, not a band hit.`);
          g.capped = true; dirty = true;
        } catch (e) { log(`LOSS-CAP ${key} close failed: ${e.message}`); }
        continue; // position flat or closing — nothing below applies
      }
    }

    // ---- naked-stop synthesis: open position with no pos_loss gets one ----
    // Pinned at the liq-band inner edge (DEEPEN_BAND geometry — same place
    // the deepen path parks it). GOD flags naked books every cycle; the
    // flag doesn't move price, a plan does. 60s cooldown per symbol so a
    // rejected place can't spam the exchange.
    if (NAKED_SYNTH) {
      try {
        const pc = await plansFor(p.sym);
        let hasLoss = pc.rows.some((x) => /loss|stop|moving/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
        // false-naked guard: the exec's rebuild cancels plans then re-places
        // them over several seconds — a single read (cached OR fresh) can
        // land inside the teardown window. Nakedness is only real when it
        // persists across cycles (~9s > any rebuild); verify fresh each pass.
        if (!hasLoss) {
          const fresh = await getPlans(p.sym).catch(() => pc.rows);
          hasLoss = fresh.some((x) => /loss|stop|moving/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
        }
        if (hasLoss) g.nakedSeen = 0;
        const confirmedNaked = !hasLoss && (g.nakedSeen ? Date.now() - g.nakedSeen >= NAKED_CONFIRM_MS : (g.nakedSeen = Date.now(), false));
        if (confirmedNaked && p.liq > 0 && p.entry > 0 && Date.now() - (g.nakedAt || 0) >= NAKED_COOLDOWN_MS) {
          const bandPct = Math.abs(p.entry - p.liq) / p.entry * 100;
          const pxDec = +(cm[p.sym]?.pricePlace ?? 6); // parens: +x ?? 6 yields NaN on a contract-map miss
          const trig = bandStopTrig(p.entry, p.liq, p.side, pxDec);
          const sane = bandPct <= BAND_CAP_PCT && trig > 0 && (p.side === 'long' ? trig < mark : trig > mark);
          if (sane) {
            g.nakedAt = Date.now(); // cooldown even on success — no plan spam
            await planLoss(p.sym, p.side, trig, p.marginMode);
            pc.at = 0;
            log(`NAKED-FIX ${key}: synthesized pos_loss @ ${trig} (${bandPct.toFixed(2)}% band) — position had no stop`);
            outbox(`🩹 NAKED-FIX — ${p.sym} ${p.side} had NO stop plan. Synthesized pos_loss @ ${trig} (liq-band edge).`);
            dirty = true;
          }
        }
      } catch (e) { log(`${key} naked-synth error: ${e.message}`); }
    }

    // ---- band-breach stop repair: an armed loss-side stop sitting at/past
    // 80% of the liq band can lose the race to liquidation — the trigger
    // exists on paper but a fast wick skips it into the liq engine (god.mjs
    // band-integrity FAILs exactly this). Re-pin inside the band via the
    // shared bandStopTrig geometry: place-first-then-cancel, never naked.
    // Loss-SIDE plans only — a trigger past entry on the win side is a
    // profit lock, not this tier's problem.
    if (p.liq > 0 && p.entry > 0 && mark > 0) {
      try {
        const bandPct = Math.abs(p.entry - p.liq) / p.entry * 100;
        if (bandPct <= BAND_CAP_PCT && Date.now() - (g.bandFixAt || 0) >= NAKED_COOLDOWN_MS) {
          const pc = await plansFor(p.sym);
          const bad = pc.rows.filter((x) =>
            /loss|stop|moving/i.test(x.planType || '') && +x.triggerPrice > 0 &&
            (!x.holdSide || x.holdSide === p.side) &&
            (p.side === 'long' ? +x.triggerPrice < p.entry : +x.triggerPrice > p.entry) &&
            (Math.abs(p.entry - +x.triggerPrice) / p.entry * 100) >= bandPct * 0.8);
          if (bad.length) {
            const pxDec = +(cm[p.sym]?.pricePlace ?? 6);
            const trig = bandStopTrig(p.entry, p.liq, p.side, pxDec);
            const sane = trig > 0 && (p.side === 'long' ? (trig < mark && trig > p.liq) : (trig > mark && trig < p.liq));
            if (sane) {
              g.bandFixAt = Date.now(); // cooldown even on success — no plan spam
              await planLoss(p.sym, p.side, trig, p.marginMode);
              for (const x of bad) await cancelPlan(p.sym, x.planType, x.orderId).catch(() => {});
              pc.at = 0; kickWatcher();
              log(`BAND-FIX ${key}: stop past band edge ${bad.map((x) => x.triggerPrice).join(',')} -> ${trig} (${bandPct.toFixed(2)}% band)`);
              outbox(`🔧 BAND-FIX — ${p.sym} ${p.side}: armed stop was at/past the liq-band edge and could lose the race to liquidation. Re-pinned inside the band @ ${trig}.`);
              dirty = true;
            }
          }
        }
      } catch (e) { log(`${key} band-fix error: ${e.message}`); }
    }

    // ---- scalp target close (NO_DEEPEN symbols): Bitget silently
    // invalidates pos_profit and full-size TP legs on minimum-size
    // positions (observed live on XAUUSDT — accepted, dead in <10s). For
    // those, the guard IS the take-profit: a run >= SCALP_TP_PCT in favor
    // closes the whole position at market. Fee-aware: only when the move
    // clearly covers round-trip costs.
    if (NO_DEEPEN.has(p.sym) && p.entry > 0 && SCALP_TP_PCT > 0) {
      const favPct = (p.side === 'long' ? (mark - p.entry) / p.entry : (p.entry - mark) / p.entry) * 100;
      if (favPct >= SCALP_TP_PCT) {
        try {
          // if the position DOES hold live profit legs, they own the exits —
          // the software TP is only the fallback for un-supportable books
          const pc = await plansFor(p.sym);
          const hasTp = pc0.rows.some((x) => /profit/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
          if (hasTp) { /* exchange ladder working — leave it */ }
          else {
          const fresh = await getAllPos().catch(() => null);
          const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
          if (fp) {
            await closeSmart(fp.sym, fp.side, String(fp.size), fp.marginMode);
            const pc = planCache[p.sym];
            for (const x of (pc?.rows || []).filter((z) => /profit/i.test(z.planType || '') && (!z.holdSide || z.holdSide === p.side)))
              await cancelPlan(p.sym, x.planType, x.orderId).catch(() => {});
            kickWatcher();
            log(`SCALP-TP ${key}: +${favPct.toFixed(2)}% >= ${SCALP_TP_PCT}% — closed @ ${mark} (software TP; exchange plan unsupportable at this size)`);
            outbox(`🎯 SCALP-TP — ${p.sym} ${p.side} banked +${favPct.toFixed(2)}% @ ${mark} — target hit, position closed.`);
            dirty = true;
            continue;
          }
          }
        } catch (e) { log(`${key} scalp-tp error: ${e.message}`); }
      }
    }

    // ---- breakeven lock, book-wide: manual opens (operator's bagrunners)
    // get the tightest profile — fee-lock at +0.18% favor, dense greedy
    // tiers; scalp symbols (NO_DEEPEN) arm fast; swing keeps breathing
    // room. Tighten-only, so it composes with the exec's own ratchets on
    // managed positions (tighter wins) and never loosens an operator stop.
    const isManual = BAGRUN_ON && manualSyms().has(p.sym);
    const trail = isManual ? TRAIL_BAGRUN : NO_DEEPEN.has(p.sym) ? TRAIL_SCALP : TRAIL_SWING;
    if (isManual && !g.bagrunTold) {
      g.bagrunTold = true; dirty = true;
      outbox(`🏃‍♂️ BAGRUNNER armed — ${p.sym} ${p.side}: operator open detected. Fee-lock at +0.18%, greedy trail, fast vanish. Set your own stop and I'll only tighten it.`);
    }
    if (!isManual) g.bagrunTold = false;
    if (p.entry > 0) {
      try {
        const favPct = (p.side === 'long' ? (mark - p.entry) / p.entry : (p.entry - mark) / p.entry) * 100;
        // highest tier armed — a run that skips tiers lands on the deepest lock
        let lockPct = 0;
        for (const [arm, lock] of trail) if (favPct >= arm) lockPct = lock;
        // continuous peak ratchet: once the first tier's territory is
        // reached the lock also trails KEEP_FRAC of the best favor seen —
        // a run between rungs still drags the stop up behind it. Toxic tape
        // (one-sided volume against us) tightens the keep to 85%.
        g.peakFav = Math.max(g.peakFav || 0, favPct);
        const keepBase = gates.__tune?.keep ?? KEEP_FRAC;
        const keepF = toxAdv ? Math.min(0.9, keepBase + 0.1) : keepBase;
        const keepPct = g.peakFav >= trail[0][0] ? g.peakFav * keepF : 0;
        if (keepPct > lockPct) lockPct = keepPct;
        if (lockPct > 0) {
          const sgn = p.side === 'long' ? 1 : -1;
          const pxDec = +(cm[p.sym]?.pricePlace ?? 6);
          const lockTrig = +(p.entry * (1 + (sgn * lockPct) / 100)).toFixed(pxDec);
          const pc = await plansFor(p.sym);
          const cur = pc.rows.find((x) => /loss/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
          const curTrig = cur ? +cur.triggerPrice : 0;
          // tighten-only: skip if a keeper already sits at/inside the lock
          const better = curTrig > 0 && (p.side === 'long' ? curTrig >= lockTrig : curTrig <= lockTrig);
          // the lock must sit between mark and the old stop — sane check,
          // with a 5bp flutter buffer: mark can drift past lockTrig between
          // this read and exchange validation (live 40917 rejects on NEAR)
          const sane = p.side === 'long' ? lockTrig < mark * 0.9995 && lockTrig > (curTrig || 0) : lockTrig > mark * 1.0005 && (curTrig === 0 || lockTrig < curTrig);
          if (!better && sane && Date.now() - (g.beAt || 0) >= 12e3) {
            g.beAt = Date.now();
            await planLoss(p.sym, p.side, lockTrig, p.marginMode); // place-first, never naked
            for (const x of pc.rows.filter((z) => /loss/i.test(z.planType || '') && +z.triggerPrice !== lockTrig && (!z.holdSide || z.holdSide === p.side)))
              await cancelPlan(p.sym, x.planType, x.orderId).catch(() => {});
            pc.at = 0;
            kickWatcher();
            log(`BE-LOCK ${key}: fav ${favPct.toFixed(2)}% — stop ${curTrig || 'none'} -> ${lockTrig} (entry+${lockPct}%)`);
            outbox(`🔒 ${isManual ? 'BAGRUN-LOCK' : 'BE-LOCK'} — ${p.sym} ${p.side}: +${favPct.toFixed(2)}% favor, stop moved to entry+${lockPct}% (${lockTrig}) — worst case is now green after fees.`);
            dirty = true;
          }
        }
      } catch (e) { log(`${key} be-lock error: ${e.message}`); }
    }

    // ---- giveback vanish: peak-armed, tape turned, still green — sell the
    // turn NOW instead of donating the remaining giveback down to wherever
    // the ratcheted stop sits. Whole-position market close, like stall-cut;
    // re-verify on fresh signed truth so a stale mark can't fire it.
    if ((g.peakFav || 0) >= (isManual ? BAGRUN_VANISH_MIN_PEAK : VANISH_MIN_PEAK) && VANISH_FRAC > 0) {
      try {
        const favNow = (p.side === 'long' ? (mark - p.entry) / p.entry : (p.entry - mark) / p.entry) * 100;
        const gb = (g.peakFav - favNow) / g.peakFav;
        // toxic tape halves the patience — one-sided flow against us means
        // the giveback probably isn't noise, it's the turn. Manual bagrunners
        // run tighter vanish params — bank the turn, don't ride it.
        const vBase = (gates.__tune?.vanish ?? VANISH_FRAC) * (isManual ? BAGRUN_VANISH_FRAC / VANISH_FRAC : 1);
        const vFrac = toxAdv ? vBase * 0.5 : vBase;
        const vMinFav = isManual ? BAGRUN_VANISH_MIN_FAV : VANISH_MIN_FAV;
        if (favNow > vMinFav && gb >= vFrac && Date.now() - (g.vanishAt || 0) >= 60e3) {
          const fresh = await getAllPos().catch(() => null);
          const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
          if (fp && +fp.upl > 0) {
            g.vanishAt = Date.now();
            await closeSmart(fp.sym, fp.side, String(fp.size), fp.marginMode);
            kickWatcher();
            log(`VANISH ${key}: peak +${g.peakFav.toFixed(2)}% -> +${favNow.toFixed(2)}% (${(gb * 100).toFixed(0)}% giveback) — closed green @ ${mark}`);
            outbox(`🏃 VANISH — ${fp.sym} ${fp.side}: gave back ${(gb * 100).toFixed(0)}% of a +${g.peakFav.toFixed(2)}% run — closed @ ${mark} still green (+$${(+fp.upl).toFixed(2)}). Banked the turn.`);
            dirty = true;
            continue;
          }
        }
      } catch (e) { log(`${key} vanish error: ${e.message}`); }
    }

    // ---- scalp stall-cut (NO_DEEPEN symbols): red beyond SCALP_STALL_FRAC
    // of the stop distance AND older than SCALP_STALL_MS = failed reversion
    // thesis. Close now for the partial loss instead of donating the rest
    // of the stop. Plans are cancelled first so the fill can't straddle a
    // stale TP; the whole-position pos_loss stays as backstop until the
    // close lands (it auto-dies with the position).
    if (NO_DEEPEN.has(p.sym) && p.entry > 0 && p.cTime > 0 && SCALP_STALL_MS > 0) {
      try {
        const ageMs = Date.now() - p.cTime;
        if (ageMs >= SCALP_STALL_MS && p.upl < 0) {
          const pc = await plansFor(p.sym);
          const sl = pc.rows.find((x) => /loss/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
          const stopDistPct = sl && +sl.triggerPrice > 0 ? (Math.abs(+sl.triggerPrice - p.entry) / p.entry) * 100 : 0;
          const advPct = (p.side === 'long' ? (p.entry - mark) / p.entry : (mark - p.entry) / p.entry) * 100;
          if (stopDistPct > 0 && advPct >= SCALP_STALL_FRAC * stopDistPct && advPct < stopDistPct) {
            const fresh = await getAllPos().catch(() => null);
            const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
            if (fp && fp.upl < 0 && Date.now() - fp.cTime >= SCALP_STALL_MS) {
              // close FIRST — if the market close throws, every plan stays
              // armed and nothing is left half-stripped
              await closeSmart(fp.sym, fp.side, String(fp.size), fp.marginMode);
              for (const x of pc.rows.filter((z) => /profit/i.test(z.planType || '') && (!z.holdSide || z.holdSide === p.side)))
                await cancelPlan(p.sym, x.planType, x.orderId).catch(() => {});
              kickWatcher();
              log(`STALL-CUT ${key}: ${Math.round(ageMs / 6e4)}m old, ${advPct.toFixed(2)}% adverse (${(advPct / stopDistPct * 100).toFixed(0)}% of stop) — cut early @ ${mark}`);
              outbox(`✂️ STALL-CUT — ${p.sym} ${p.side}: ${Math.round(ageMs / 6e4)}m old and ${(advPct / stopDistPct * 100).toFixed(0)}% toward its stop — reversion thesis dead, closed @ ${mark} for the smaller loss.`);
              dirty = true;
              continue;
            }
          }
        }
      } catch (e) { log(`${key} stall-cut error: ${e.message}`); }
    }

    // ---- stop-approach tier: mark nearing this position's OWN pos_loss —
    // clip the contract minimum on each new low and push the stop deeper
    // toward the liq edge. Minimum size, not percentage: the position sheds
    // risk gradually through the dip instead of dying whole at the trigger.
    if (STOP_TRIM) {
      try {
        const pc = await plansFor(p.sym);
        const loss = pc.rows.find((x) => /loss|stop|moving/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
        const trig = +loss?.triggerPrice || 0;
        const sDist = trig > 0 ? (p.side === 'long' ? (mark - trig) / trig * 100 : (trig - mark) / trig * 100) : null;
        if (sDist != null) stOut.positions[key].stopDist = +sDist.toFixed(3);
        // stop WIDTH drives everything: tight stops skip the ladder, wide
        // stops zone it to the last fraction of the run (not an absolute %
        // that covered the position's entire life on tight stops)
        const stopWidthPct = trig > 0 && p.entry > 0 ? Math.abs(p.entry - trig) / p.entry * 100 : 0;
        const zonePct = Math.min(STOP_ZONE, stopWidthPct * STOP_ZONE_FRAC);
        const ladderOn = STOP_TRIM && stopWidthPct >= STOP_TRIM_MIN_WIDTH;
        const newLow = g.lastStopMark == null || (p.side === 'long' ? mark < g.lastStopMark : mark > g.lastStopMark);
        // sDist > 0.05 required — a mark already THROUGH the trigger means
        // the stop is mid-fire; clipping then races the exchange's close.
        // Shared clip clock: the liq-zone path and this path must never
        // machine-gun the same slide (they did — alternating 4s clips).
        if (ladderOn && sDist != null && sDist > 0.05 && sDist <= zonePct && newLow
          && (g.stopClipN || 0) < STOP_CLIP_MAX
          && Date.now() - (g.lastStopTrim || 0) >= SPACING_MS
          && Date.now() - (g.lastTrim || 0) >= SPACING_MS) {
          // fresh-verify before firing — same discipline as the liq path
          const fresh = await getAllPos().catch(() => null);
          if (fresh) { posCache = fresh; posCacheAt = Date.now(); }
          const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
          const c = cm[p.sym] || {};
          const precN = Number.isFinite(+c.sizePlace) ? +c.sizePlace : (+c.volumePlace || 0);
          const prec = Math.pow(10, precN);
          // absolute-minimum clip: contract min, or the smallest $-sized
          // unit the exchange accepts — not a percentage of the position
          const minClip = Math.max(
            +c.minTradeNum || 0,
            Math.ceil(((+c.minTradeUSDT || 5) * 1.02) / mark * prec) / prec
          );
          // first clip of a zone-entry front-loads at 3× min (front-cut the
          // risk when it matters most); subsequent clips run at true minimum
          const clipMult = g.stopClipN ? 1 : 3;
          let q = Math.floor(minClip * clipMult * prec) / prec;
          // dust floor: a clip must carry real protective value (notional x
          // distance-to-stop >= DUST_USD). Exchange min-clips on expensive
          // contracts make that unreachable — e.g. BTC min 0.0001 @ 0.2%
          // sDist = $0.017, so every follow-on clip skipped silently. Fix:
          // scale the clip UP to the floor instead of starving the ladder.
          // Capped at ~1/3 of remaining size so a single clip can't gut the
          // position; if the cap can't clear the floor the residual rides
          // its stop (same worst case). LIQ_GUARD_DUST_USD=0 disables.
          const needQ = sDist > 0 ? (DUST_USD * 100) / (mark * sDist) : Infinity;
          const capQ = fp ? Math.floor(fp.size * 0.34 * prec) / prec : 0;
          if (q < needQ) q = Math.min(Math.ceil(needQ * prec) / prec, capQ);
          const clipValue = (q * mark * sDist) / 100;
          if (fp && fp.size > minClip && q > 0 && q < fp.size && clipValue >= DUST_USD) {
            await closeMarket(p.sym, p.side, String(q), posMode, fp.marginMode);
            g.lastStopTrim = Date.now(); g.lastStopMark = mark; g.stopClipN = (g.stopClipN || 0) + 1;
            kickWatcher();
            trims.push({ at: g.lastStopTrim, iso: new Date(g.lastStopTrim).toISOString(), sym: p.sym, side: p.side, size: q, mark, postSz: +(fp.size - q).toFixed(precN), kind: 'stop-approach' });
            dirty = true;
            log(`STOP-TRIM ${key}: clipped ${q} of ${fp.size} @ ${mark} — ${sDist.toFixed(2)}% above stop ${trig}`);
            outbox(`✂️ STOP-TRIM — ${p.sym} ${p.side}: clipped ${q} of ${fp.size} @ ${mark} (${sDist.toFixed(2)}% above stop). Shedding, not dying.`);
            // deepen the stop toward the liq edge — place-first-then-cancel,
            // never naked; only ever moves the stop FURTHER from price
            try {
              const np = (await getAllPos().catch(() => []))?.find((x) => x.sym === p.sym && x.side === p.side);
              if (np?.liq) {
                const bandPct = Math.abs(np.entry - np.liq) / np.entry * 100;
                // trigger must land on the contract's price grid — a blanket
                // toFixed(6) violates checkBDScale (SNDK=2dp, CLU=3dp -> 40808)
                const pxDec = +(cm[p.sym]?.pricePlace ?? 6);
                const deepTrig = bandStopTrig(np.entry, np.liq, np.side, pxDec);
                // a stop past entry in the win direction is a profit lock —
                // the band edge is the LOSS side, so "deepening" would
                // release locked profit back to risk. Never touch those.
                const armedLossSide = np.side === 'long' ? trig < np.entry : trig > np.entry;
                const deeper = bandPct <= BAND_CAP_PCT && armedLossSide && (np.side === 'long' ? deepTrig < trig : deepTrig > trig);
                if (deeper && deepTrig > 0 && !NO_DEEPEN.has(p.sym)) {
                  await planLoss(p.sym, p.side, deepTrig, np.marginMode || p.marginMode);
                  // loss-SIDE plans only — a profit-side loss-typed plan
                  // (a lock) must never be stripped by the reset sweep
                  for (const x of (await getPlans(p.sym)).filter((z) => /loss/i.test(z.planType || '') && +z.triggerPrice !== deepTrig && (!z.holdSide || z.holdSide === p.side) && (np.side === 'long' ? +z.triggerPrice < np.entry : +z.triggerPrice > np.entry)))
                    await cancelPlan(p.sym, x.planType, x.orderId).catch(() => {});
                  pc.at = 0; // force plan refresh next tick
                  log(`${key} stop deepened -> ${deepTrig} (${bandPct.toFixed(2)}% band)`);
                }
              }
            } catch (e) { log(`${key} stop-deepen failed (stop still armed): ${e.message}`); }
          }
        } else if (sDist != null && sDist > zonePct + 0.8) {
          g.lastStopMark = null; g.stopClipN = 0; // recovered clear — re-arm gate and first-clip front-load
        }
      } catch (e) { log(`${key} stop-trim error: ${e.message}`); }
    }

    // leverage-scaled zone: a fixed 0.8% leaves a 30x position asleep until
    // the last quarter of its 3.3% band. Zone = 45% of the band, floored at
    // ZONE_PCT, capped at ZONE_MAX_PCT so wide bands stay sane.
    const bandPct0 = p.liq > 0 && p.entry > 0 ? Math.abs(p.entry - p.liq) / p.entry * 100 : 0;
    const zonePct = Math.min(ZONE_MAX_PCT, Math.max(ZONE_PCT, bandPct0 * ZONE_BAND_FRAC));
        // zonePct surface: the live danger-band edge per position — a viewer
        // can see exactly how much room remains before trims wake, not just
        // the raw liq distance
        if (stOut.positions[key]) stOut.positions[key].zonePct = +zonePct.toFixed(3);
        if (distPct > zonePct) continue;                                    // outside danger zone — dormant
    // shared clip clock — the stop-approach ladder and this path must not
    // alternate 4s clips down the same slide
    if (Date.now() - g.lastTrim < SPACING_MS || Date.now() - (g.lastStopTrim || 0) < SPACING_MS) continue;
    // deterioration gate: re-arm only when price prints worse than at the
    // last trim. Waterfall => clips every ~4s; hovering in-zone => zero.
    const worse = g.lastTrimMark == null || (p.side === 'long' ? mark < g.lastTrimMark : mark > g.lastTrimMark);
    if (!worse) continue;
    const c = cm[p.sym] || {};
    const minFloor = Math.max(
      +c.minTradeNum || 0,
      ((+c.minTradeUSDT || 5) * 3) / mark,
      p.sym === SEED_SYM ? MIN_SIZE : 0,
    );
    if (p.size <= minFloor) continue; // residual rides its stop — shavings are pointless here

    // FIRE PATH — re-verify on FRESH signed truth, never the cache
    const fresh = await getAllPos().catch(() => null);
    posCache = fresh || posCache; posCacheAt = Date.now();
    const fp = (fresh || []).find((x) => x.sym === p.sym && x.side === p.side);
    if (!fp?.liq) continue;
    const fdist = fp.side === 'long' ? (mark - fp.liq) / fp.liq * 100 : (fp.liq - mark) / fp.liq * 100;
    if (fdist > zonePct || fp.size <= minFloor) continue;   // bounced / shrank between checks — stand down
    const prec = Math.pow(10, +c.sizePlace || 0);
    // floor the clip at the exchange minimum — a small-% clip of a <$100
    // position lands below minTradeUSDT and reject-loops instead of
    // trimming. If the min clip IS the position, the residual rides its
    // stop (guarded below) — a 'partial' must never equal the whole side.
    const minClip = Math.max(+c.minTradeNum || 0, ((+c.minTradeUSDT || 5) * 1.02) / mark);
    const q = Math.floor(Math.max((fp.size * TRIM_PCT) / 100, minClip) * prec) / prec;
    if (!(q > 0) || q >= fp.size) continue;                 // never let a 'partial' equal the whole side
    log(`DANGER: ${key} mark ${mark} is ${fdist.toFixed(2)}% from liq ${fp.liq} — trimming ${q} of ${fp.size}`);
    await closeMarket(p.sym, p.side, String(q), posMode, fp.marginMode);
    kickWatcher();
    g.lastTrim = Date.now();
    g.lastTrimMark = mark;
    trims.push({ at: g.lastTrim, iso: new Date(g.lastTrim).toISOString(), sym: p.sym, side: p.side, size: q, mark, postSz: +(fp.size - q).toFixed(+c.sizePlace || 6), kind: 'liq-zone' });
    if (trims.length > 200) trims.splice(0, trims.length - 200); // bounded history — state can't grow forever
    dirty = true;
    outbox(`✂️ LIQ-GUARD TRIM — ${p.sym} ${p.side}: closed ${q} of ${fp.size} @ ${mark} (${fdist.toFixed(2)}% from liq). Re-arms on a new low.`);
    // reset the stop deeper into the widened band — place new, then cancel old
    try {
      const np = (await getAllPos().catch(() => []))?.find((x) => x.sym === p.sym && x.side === p.side);
      if (np?.liq) {
        const sgn = np.side === 'long' ? 1 : -1;
        const bandPct = Math.abs(np.entry - np.liq) / np.entry * 100;
        const pxDec = +(cm[p.sym]?.pricePlace ?? 6);
        const trig = +(np.entry * (1 - (sgn * bandPct * 0.75) / 100)).toFixed(pxDec);
        if (bandPct > BAND_CAP_PCT) throw new Error(`band ${bandPct.toFixed(0)}% degenerate — keeping existing stop`);
        await planLoss(p.sym, p.side, trig, np.marginMode || p.marginMode);
        const plans = await getPlans(p.sym);
        // holdSide filter is mandatory in hedge mode — an unfiltered cancel
        // would strip the OTHER side's stop while resetting this one. The
        // loss-side trigger test does the same for profit locks on THIS side.
        for (const x of plans.filter((z) => /loss/i.test(z.planType || '') && +z.triggerPrice !== trig && (!z.holdSide || z.holdSide === p.side) && (p.side === 'long' ? +z.triggerPrice < np.entry : +z.triggerPrice > np.entry)))
          await cancelPlan(p.sym, x.planType, x.orderId).catch(() => {});
        log(`${key} stop reset -> ${trig} (liq ${np.liq}, band ${bandPct.toFixed(2)}%)`);
      }
    } catch (e) { log(`${key} stop-reset failed (exec clamp covers): ${e.message}`); }
    log(`${key} trimmed ${q} @ ${mark} — re-arms on a new low (spacing floor ${SPACING_MS / 1e3}s)`);
  }
  // post-exit grading + self-tuning run every cycle — cheap, additive
  await markoutSweep();
  await tuneNow();
  // gate hygiene: drop stale symbol gates (no activity in 7d, not held now)
  // — the map grew to 40+ dead keys bloating every state write. __ keys are
  // engine state (markouts, tune) and always kept.
  const liveSyms = new Set(posCache.map((p) => `${p.sym}:${p.side}`));
  for (const [k, gv] of Object.entries(gates)) {
    if (k.startsWith('__') || liveSyms.has(k)) continue;
    const last = Math.max(gv.lastTrim || 0, gv.lastStopTrim || 0, gv.lastAlert || 0, gv.nakedSeen || 0, gv.nakedAt || 0, gv.beAt || 0);
    if (last && Date.now() - last > 7 * 86400e3) { delete gates[k]; dirty = true; }
  }
  // legacy top-level mirror of the seed symbol for older readers
  const seed = stOut.positions[`${SEED_SYM}:long`] || stOut.positions[`${SEED_SYM}:short`];
  if (seed) Object.assign(stOut, { lastLiq: seed.liq, size: seed.size, mark: seed.mark, distPct: seed.distPct, note: 'tracking' });
  stOut.uptimeS = Math.round((Date.now() - BOOTED_AT) / 1e3);
  stOut.tickMs = Date.now() - tickStartedAt;
  if (trims.length > 500) trims.splice(0, trims.length - 500); // rolling 500 — cascades can't grow the journal forever
  // tox cache hygiene — entries for symbols no longer held are dead weight
  for (const s of Object.keys(toxCache))
    if (!posCache.some((p) => p.sym === s)) delete toxCache[s];
  // plan cache hygiene — same rule
  for (const s of Object.keys(planCache))
    if (!posCache.some((p) => p.sym === s)) delete planCache[s];
  if (Date.now() - lastStateWrite > 1000 || dirty) {
    lastStateWrite = Date.now();
    writeState({ ...stOut, gates });
  }
}

// posMode probe — a failed probe used to silently default 'oneway' forever,
// which fires 40774 on every trim of a hedge-mode account. The demo env
// lists a SUBSET of symbols — probing on the seed (HBARUSDT) 40034s there,
// so probe on a symbol the contract map actually contains. Retry at boot,
// and if still unknown mark it unconfirmed so tick() keeps re-probing.
let posModeConfirmed = false, probeLogged = false;
const probePosMode = async () => {
  const sym = cm[SEED_SYM] ? SEED_SYM : Object.keys(cm)[0] || SEED_SYM;
  const m = await X.getPosMode(sym)
    .catch((e) => { if (!probeLogged) { probeLogged = true; log(`posMode probe on ${sym}: ${e.message}`); } return null; });
  if (m) { posModeConfirmed = true; X.setPosMode(m); return m; }
  return posMode;
};

async function boot() {
  const cs = await X.contractMap().catch(() => ({}));
  Object.assign(cm, cs);
  let pm = posMode;
  for (let i = 0; i < 3 && !posModeConfirmed; i++) {
    pm = await probePosMode();
    if (!posModeConfirmed) await new Promise((r) => setTimeout(r, 1500));
  }
  log(`armed — all positions · trim ${TRIM_PCT}% · zone ${ZONE_PCT}% (lev-scaled ×${ZONE_BAND_FRAC} band, cap ${ZONE_MAX_PCT}%) · crash-brake ${CRASH_PCT}%/${CRASH_MS / 1e3}s → ${CRASH_CLOSE_PCT}% · spacing ${SPACING_MS / 1e3}s + new-low gate · seed ${SEED_SYM} min ${MIN_SIZE} · posMode ${pm}${posModeConfirmed ? '' : ' (UNCONFIRMED — probing every cycle)'}`);
  return pm;
}

let busy = false; // setInterval doesn't await ticks — lock so a slow tick can't overlap the next
let tickStartedAt = 0;
const loop = async () => {
  if (busy) return;
  busy = true;
  tickStartedAt = Date.now();
  try { await tick(); } catch (e) { log('tick error:', e.message); } finally { busy = false; tickStartedAt = 0; }
};
// Stall watchdog: one never-settling await inside tick() (a blackholed keep-
// alive socket that dodges AbortSignal) used to leave busy=true forever —
// the process stayed "running" while the state file went stale for hours.
// If a tick overruns 120s we exit hard; systemd Restart=always revives us
// fresh within RestartSec. Self-healing beats rotting silently.
setInterval(() => {
  if (busy && tickStartedAt && Date.now() - tickStartedAt > 120e3) {
    log(`FATAL: tick wedged for ${Math.round((Date.now() - tickStartedAt) / 1000)}s — exiting for systemd restart`);
    process.exit(1);
  }
}, 10e3);
boot().then((pm) => { posMode = pm; startWs(); setInterval(loop, POLL_MS); loop(); });
