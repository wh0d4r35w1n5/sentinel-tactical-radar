// Sentinel live executor — routes api/live-plan.json to Bitget USDT-M futures.
//
// MODES (env SENTINEL_EXEC):
//   off    — do nothing (default)
//   shadow — no keys needed: validates the plan, writes live-shadow.json with
//            the orders it WOULD place. Always safe, runs in CI for free.
//   demo   — Bitget demo trading (paptrading:1 header): real order flow,
//            fake funds. The calibration stage between shadow and live.
//   live   — real money. Requires SENTINEL_LIVE=1 AND CONFIRM_LIVE=YES plus
//            a TRADE-ONLY API key (withdrawals disabled at Bitget).
//
// Sizing (mandate): deploy ALL free margin evenly across the target slots —
// LIVE_TARGET_POSITIONS (default 4) gives ~25% of balance per trade, up to
// LIVE_MAX_POSITIONS (default 10) concurrent. Leverage = contract maxLever
// bounded by the liquidation band (lev <= 80/(stopPct+0.64)) so the stop
// always fires before liquidation. Exits run a staggered TP ladder
// (40/30/15 banks at 0.55x/1.0x/runnerMult of target) with the ~15% moon
// bag left unplanned to ride a trailing stop; the stop ratchets up as each
// bank level approaches. Positions missing protection legs get them
// repaired; positions exceeding their slot margin get partially closed to
// free balance for the other slots.
//
// Failure discipline: if an entry fills but its TP/SL plan orders fail, the
// position is closed immediately — a naked position is a worse error than a
// missed trade. Stale plans (>ttlMs) are refused entirely.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32hex, integrityCheck, integrityNote } from './crc32.mjs';
import { makeExchange } from './exchange/index.mjs';
import './load-env.mjs'; // canonical .env loader (audit F2) — every env-reading script imports this

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(__dirname, '..', 'api');
// atomic artifact writes — a mid-write kill must never leave a truncated
// live-ledger.json (god audits it; the scanner's heat math reads it).
// Every write also records its CRC32 into state/checksums.json — readers
// verify against the manifest, so corruption/tamper is never silent.
const writeJson = (file, obj) => {
  const body = JSON.stringify(obj);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  integrityNote(file, body);
};

const MODE = (process.env.SENTINEL_EXEC || 'off').toLowerCase();
// credentials live inside the exchange adapter — SENTINEL_EXCHANGE picks the
// driver; each env reads its own *_API_KEY/SECRET(+PASSPHRASE) set.
const X = makeExchange(process.env);
// each exchange book is its own epoch: bybit demo fills/vault/peaks must
// never blend into the bitget record (stats would lie about both books).
const BOOK_TAG = X.name === 'bitget' ? '' : `-${X.name}`;
const LIVE_ARMED =
  process.env.SENTINEL_LIVE === '1' && process.env.CONFIRM_LIVE === 'YES';
// mode-scoped fills journal: demo/paper fills must never contaminate the
// live loss record (breakers, streak cooldowns, digest all read this).
const FILLS_FILE = MODE === 'demo' ? `demo-fills${BOOK_TAG}.json` : 'real-fills.json';
// SENTINEL_FILLS_SINCE_MS — test epoch: exchange fills older than this are
// pre-test account history — never journaled, never counted by breakers,
// streaks, cooldowns or rate caps. Lets a shared demo account run a clean
// 100/1000-trade evaluation.
const FILLS_SINCE = +(process.env.SENTINEL_FILLS_SINCE_MS || 0);
const loadFills = () => {
  try {
    const fj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', FILLS_FILE), 'utf8')).fills || [];
    return FILLS_SINCE ? fj.filter((f) => (+f.ts || 0) >= FILLS_SINCE) : fj;
  } catch { return []; }
};
// manual-book attribution: guard/exec protective closes land src 'api'
// even when the POSITION was hand-opened (web/ios/android). Attribute every
// close to its position's open source — majority open qty wins, resets when
// the book flats — so operator trades can neither trip nor defend the
// engine's breakers (the NMR manual dip-buy bleed tripped one falsely).
// Anything NOT 'api' is an operator book; treating non-web as api was the
// second half of the attribution bug (phone trades bled into the breakers).
// Hedge-mode safe: Bitget close fills carry the POSITION side ('close buy'
// closes a long), so symbol:side buckets open/close of the same position.
const tagManualCloses = (rows) => {
  const cur = {};
  for (const f of [...rows].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    const k = `${f.symbol}:${f.side}`;
    const qty = +f.size || 0;
    if (f.tradeSide === 'open') {
      const c = (cur[k] ||= { qty: 0, web: 0, api: 0 });
      c.qty += qty;
      c[(f.src || 'api') === 'api' ? 'api' : 'web'] += qty;
    } else if (f.tradeSide === 'close') {
      const c = cur[k];
      if (c) {
        f._manual = c.web > c.api;
        c.qty -= qty;
        if (c.qty <= (c.web + c.api) * 1e-3) delete cur[k]; // flat — re-attribute next position
      }
    }
  }
};
// R:R ladder profile — picked by scripts/rr-optimizer.mjs (1M-roll Monte
// Carlo over candidate ladders; writes state/rr-config.json). mults are
// stop-distance multiples per leg, alloc is the position fraction banked
// at each leg, moon rides the trail. cum is the cumulative allocation the
// ladder splitter consumes. SENTINEL_RR=off pins the legacy 40/30/15
// @0.55/1/1.8 ladder.
const RR = (() => {
  const legacy = { mults: [0.55, 1.0, 1.8], alloc: [0.40, 0.30, 0.15], moon: 0.15 };
  try {
    if (process.env.SENTINEL_RR === 'off') throw 0;
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'rr-config.json'), 'utf8'));
    if (!Array.isArray(c.mults) || !Array.isArray(c.alloc) || c.mults.length !== c.alloc.length || !c.mults.length) throw 0;
    return { mults: c.mults.map(Number), alloc: c.alloc.map(Number), moon: +c.moon || 0, profile: c.profile };
  } catch { return { ...legacy, profile: 'legacy-default' }; }
})();
// cumulative tranche starts: [0, 0.15, 0.40, 0.85] — alloc sums to 1-moon,
// so the reduce result IS the complete cum table (leg i = cum[i+1]-cum[i],
// moon bag = residual). The old build wrapped that table in an extra
// leading 0 ([0,0,0.15,0.40,0.85]) so leg 0 computed tsize 0 and was
// dropped: the nearest 2R tranche never placed, alloc shifted one slot
// (observed live: legs at 4R/7R only), and small books fell under the
// leg-count floor → single whole-size TP instead of a staggered ladder.
const RR_CUM = RR.alloc.reduce((a, f, i) => (a.push(+(a[i] + f).toFixed(8)), a), [0]);
const RR_MAX_ALLOC = Math.max(...RR.alloc);
// ---- wealth vault: SENTINEL_VAULT_SHARE (default 50%) of every
// profitable close is swept into state/wealth-vault.json — a balance the
// engine can never trade with. Profits lock permanently; the tradable
// book is equity MINUS vault. (Ledger-level in demo; on live this is the
// sizing boundary — a real subaccount transfer wires on top later.)
const VAULT_SHARE = Math.min(0.9, Math.max(0, +(process.env.SENTINEL_VAULT_SHARE ?? 0.5)));
// SENTINEL_VAULT_TRANSFER=1 makes sweeps MOVE funds futures->spot — the
// carry physically leaves the tradable account. Live-only: the demo env
// has no wallet layer (endpoint 404s, demo keys are futures-scoped), so
// accounting carve-out is the only possible behavior there.
const VAULT_TRANSFER = MODE !== 'demo' && process.env.SENTINEL_VAULT_TRANSFER === '1';
// vault asset: swept carry moves to SPOT and buys BTC — operator mandate
// 2026-10-08 (revised): the vault holds sats, not a leveraged meme. The
// USELESS futures bag died in the 10-08 cascade and is written off as
// lostUsd — honest accounting, not a hidden ghost deployment.
const VAULT_SYM = process.env.SENTINEL_VAULT_SYM || 'USELESSUSDT'; // legacy guard (top-up skip); no longer deployed
// vault deploy asset — operator mandate 2026-10-09: stack USELESS on SPOT
// (the 5x leveraged bag died; spot accumulation can't liquidate). Override
// with SENTINEL_VAULT_BUY_SYM if the mandate changes again.
const VAULT_BUY_SYM = process.env.SENTINEL_VAULT_BUY_SYM || 'USELESSUSDT';
const VAULT_BUY_COIN = VAULT_BUY_SYM.replace(/USDT$/i, '');
const VAULT_BUY_MIN_USD = +(process.env.SENTINEL_VAULT_BUY_MIN_USD || 5); // spot min order — batch carry into ≥$5 buys
const VAULT_PATH = path.join(__dirname, '..', 'state', `wealth-vault${BOOK_TAG}.json`);
const loadVault = () => {
  try { return { balanceUsd: 0, sweptIds: {}, sweeps: [], ...JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8')) }; }
  catch { return { balanceUsd: 0, sweptIds: {}, sweeps: [] }; }
};
// ---- entry-edge discipline: rr-backtest.mjs fits how predictive our
// entries actually are from every excursion episode on record. Below
// SENTINEL_EDGE_MIN the marginal entry is a fee donation — skip it. Under
// SENTINEL_CHASE_EDGE an unfilled pullback limit is a saved loss, not a
// missed opportunity — never chase. Between floor and parity, sizing
// scales by edge. Skeptical prior 0.5 until clean data proves better.
const EDGE_LIVE = (() => {
  try {
    const bt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'rr-backtest.json'), 'utf8'));
    if ((bt.episodes || 0) >= 20 && bt.edgeEmpirical > 0) return { v: +bt.edgeEmpirical, src: 'episode-fit' };
  } catch {}
  try {
    const op = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'rr-optimize.json'), 'utf8'));
    if (op.edgeCalibrated > 0 && op.edgeSource !== 'martingale-prior') return { v: +op.edgeCalibrated, src: 'close-share' };
  } catch {}
  return { v: 0.5, src: 'skeptical-prior' };
})();
const EDGE_MIN_TRADE = +(process.env.SENTINEL_EDGE_MIN || 0.35);
const CHASE_EDGE = +(process.env.SENTINEL_CHASE_EDGE || 0.8);
const PULLBACK_PCT = +(process.env.SENTINEL_PULLBACK_PCT || 0.4);
// fee-lock calibration — the system's own excursion record knows how deep
// winners dip after going green (medMaePct). Locking below that band is
// the documented "death by early breakeven": positions scratch at
// entry+fines then run to target without us. Arm above the noise; lock
// above fees. env overrides beat calibration.
const FEE_LOCK_MAE = (() => {
  try {
    const bt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'rr-backtest.json'), 'utf8'));
    const m = +bt?.observed?.medMaePct;
    return m > 0 ? m : null;
  } catch { return null; }
})();
const FEE_LOCK_AT = +(process.env.SENTINEL_FEE_LOCK_AT || 0) ||
  Math.max(0.3, 1.5 * (FEE_LOCK_MAE || 0.58));
const FEE_LOCK_PCT = +(process.env.SENTINEL_FEE_LOCK_PCT || 0) ||
  Math.max(0.15, 0.5 * (FEE_LOCK_MAE || 0.58));
// structural de-risk rails — worst-case loss at the live stop, as a
// fraction of equity. A pyramid that stacks cost basis onto its own stop
// (CLU −$24 autopsy, 2026-10-08) gets force-trimmed to budget BEFORE the
// market collects it. MANUAL-hold symbols exempt — operator owns those.
const POS_DERISK_CAP_PCT = +(process.env.SENTINEL_POS_DERISK_CAP_PCT || 0.30);   // trigger: worst-case > 30% of equity
const POS_DERISK_TARGET_PCT = +(process.env.SENTINEL_POS_DERISK_TARGET_PCT || 0.12); // trim to: ~12% at stop
const POS_DERISK_GAP_MS = +(process.env.SENTINEL_POS_DERISK_GAP_MS || 15 * 60e3); // once per window per symbol
// ---- meta-label (López de Prado, AFML ch.3): the primary model decides
// SIDE; a secondary model answers "will following it make money" and
// scales SIZE. Ours is a shrunk bucketed classifier over the graded
// signal archive — naive-Bayes odds product across strategy × regime ×
// direction, each factor shrunk toward 1 by its cell's evidence. Below
// META_MIN_P the signal is a statistically-informed skip; above it the
// estimate modulates size toward/away from baseline.
const META_MIN_P = +(process.env.SENTINEL_META_MIN_P || 0.30);
const META_MIN_N = +(process.env.SENTINEL_META_MIN_N || 40);
const META = (() => {
  if (+(process.env.SENTINEL_METALABEL ?? 1) === 0) return null;
  try {
    const recs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'signal-eval.json'), 'utf8')).records || [];
    const scored = recs.filter((r) => Number.isFinite(r.outcomePct));
    if (scored.length < META_MIN_N) return null;
    const win = (r) => (r.outcomePct - 0.20) / Math.max(0.5, r.stopPct || 4) > 0; // net R > 0 after round-trip cost
    const shrunk = (rs) => rs.length < 5 ? null : { p: (rs.filter(win).length + 2) / (rs.length + 4), n: rs.length };
    const bucket = (keyFn) => {
      const g = {};
      for (const r of scored) { const k = keyFn(r); if (k) (g[k] ||= []).push(r); }
      const out = {};
      for (const [k, rs] of Object.entries(g)) { const s = shrunk(rs); if (s) out[k] = s; }
      return out;
    };
    const p0c = shrunk(scored);
    return {
      evN: scored.length, p0: p0c ? p0c.p : null,
      strat: bucket((r) => r.strategy), regime: bucket((r) => r.mktType), dir: bucket((r) => r.direction),
    };
  } catch { return null; }
})();
// p(win | features) — odds update from base rate by each factor,
// shrinkage-scaled so thin cells barely move the estimate
function metaProb(o) {
  if (!META || META.p0 == null) return null;
  const f = (tbl, key) => {
    const c = tbl[key];
    return c ? 1 + (c.p / META.p0 - 1) * Math.min(1, c.n / 30) : 1;
  };
  const p = META.p0
    * f(META.strat, o.strategy || 'unattributed')
    * f(META.regime, o.mktType || '')
    * f(META.dir, o.direction);
  return Math.min(0.97, Math.max(0.02, p));
}
// stall-exit: episodes show losers telegraph early — median adverse run
// ~1.3% vs median favorable ~0.33%. A managed position still red at
// STALL_MIN that never showed STALL_MFE favor is statistically a bleeder.
const STALL_MIN_MS = +(process.env.SENTINEL_STALL_MIN || 45) * 60e3;
const STALL_MFE_PCT = +(process.env.SENTINEL_STALL_MFE_PCT || 0.35);
const FAM_STATS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'mae-mfe.json'), 'utf8')).byFamily || {}; }
  catch { return {}; }
})();
// SENTINEL_RISK_PROFILE=max: maximum aggression — kill-switch at 35% DD and
// daily halt at 25% (defaults 8/6). Below those floors the book still stands
// down — a wipeout spiral isn't risk, it's the end of the book.
const RISK_MAX = process.env.SENTINEL_RISK_PROFILE === 'max';
const MAX_POSITIONS = +(process.env.LIVE_MAX_POSITIONS || (RISK_MAX ? 12 : 10));
const TARGET_POSITIONS = +(process.env.LIVE_TARGET_POSITIONS || 4);
// deployment mandate: leftover margin tops up winning positions once the
// order queue is exhausted — pyramiding strength only, never losers.
const TOPUP_FLOOR_USD = +(process.env.SENTINEL_TOPUP_FLOOR_USD || 3);
const TOPUP_MAX = +(process.env.SENTINEL_TOPUP_MAX || 2);
const DD_KILL = +(process.env.SENTINEL_DD_KILL_PCT || (RISK_MAX ? 35 : 8));
// EXEC_EARLY_CUTS — the verdict-ladder time/redness cuts ('scalp-timeout').
// Operator mandate: positions exit via exchange TP/SL or manual flatten ONLY
// — early closes pay a taker fee to second-guess a bounded plan. Set '1' to
// re-enable the TrendRider time-cut mechanics.
const EARLY_CUTS = process.env.EXEC_EARLY_CUTS === '1';
// dust-floor for synthesized TP ladders — a tranche under this notional costs
// more in fee friction than the level is worth (audit F3: HBAR was churning
// $5-28 fills). Legs below the floor fold into the moon bag.
const MIN_TRANCHE_USD = +(process.env.EXEC_MIN_TRANCHE_USD || 25);
const DAILY_HALT = +(process.env.SENTINEL_DAILY_HALT_PCT || (RISK_MAX ? 25 : 6));
// dust-account mode: when scaled notional lands under the contract minimum,
// floor up to the exchange minimum instead of skipping — for tiny real
// accounts proving the pipeline. Requires LIVE_FLOOR_MIN=1; never default.
const FLOOR_MIN = process.env.LIVE_FLOOR_MIN === '1';
// user mandate: longs only — SENTINEL_LONG_ONLY=1 refuses every SHORT order
// at routing time (defense-in-depth under the scanner's shorts-banned gate).
const LONG_ONLY = process.env.SENTINEL_LONG_ONLY === '1';
// idempotent-order window: a signal that already produced an entry attempt
// inside this horizon is a replay, not a new opportunity — skip it.
const ENTRY_DEDUP_MS = +(process.env.SENTINEL_ENTRY_DEDUP_MS || 10 * 60e3);
// min-hold on scanner-driven closes: a managed position younger than this
// can't be closed by plan emissions — exchange-side SL/TP still fire.
const MIN_HOLD_MS = +(process.env.SENTINEL_MIN_HOLD_MS || 10 * 60e3);
// manually-placed positions the executor must NOT auto-manage — no
// rebalance, decay, flip, or scalp-timeout exits. Exchange-side TP/SL
// still protect them; the ledger still reports them.
const MANUAL = new Set(
  (process.env.SENTINEL_MANUAL_HOLD || '').split(',').map((s) => s.trim()).filter(Boolean)
);
const PAPER_EQUITY = 10000; // plan notional is denominated in the $10k model
// core-carry: dead capital is dead capital. When the signal queue leaves
// free margin above the floor, deploy the remainder into a protected
// low-lev LONG on a liquid major — a carry position with its own TP/SL,
// not an idle balance. Capped gearing (default 8x) on purpose: the core
// exists to hold exposure, not to gamble the book.
const CORE_LEV = +(process.env.SENTINEL_CORE_LEV || 8);
// operator order 2026-10-08: every entry rides >=20x where the liq band
// holds it — the band cap still wins when it can't (a stop past
// liquidation is a broken trade, not a leveraged one).
const LEV_FLOOR = +(process.env.SENTINEL_MIN_LEV || 20);
const CORE_FLOOR_PCT = +(process.env.SENTINEL_CORE_FLOOR_PCT || 0.15);
const CORE_FLOOR_USD = +(process.env.SENTINEL_CORE_FLOOR_USD || 8);
const CORE_STOP_PCT = +(process.env.SENTINEL_CORE_STOP_PCT || 3);
const CORE_TARGET_PCT = +(process.env.SENTINEL_CORE_TARGET_PCT || 5.5);
const CORE_SYMS = (process.env.SENTINEL_CORE_SYMS ?? 'ETHUSDT,BTCUSDT')
  .split(',').map((x) => x.trim()).filter(Boolean);
// user mandate: symbols the executor must NEVER open — covers signal
// entries AND mandate roles (core-carry). Empty = no restriction.
const DENY_SYMS = new Set(
  (process.env.SENTINEL_DENY_SYMS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

const log = (...a) => console.log('[exec]', ...a);
const round = (x, p = 6) => +(+x).toFixed(p);

// ---- all-time record helpers: FIFO episode reconstruction over any fill
// journal. Opens accumulate qty per symbol+positionSide; closes consume;
// flat => episode ends. Position side resolves per fill: hedge-mode close
// fills carry the POSITION side ('close buy' closed a long); oneway close
// fills carry the ORDER side ('sell' closed a long); opens always carry
// the position side directly. Per-side keys keep a hedged same-symbol book
// from merging both directions into one corrupt episode.
const fillPosDir = (f) =>
  f.tradeSide === 'close'
    ? (POS_MODE === 'hedge' ? f.side === 'buy' : f.side === 'sell') ? 'long' : 'short'
    : (f.side === 'buy' ? 'long' : 'short');
const fifoEpisodes = (fills) => {
  const qty = new Map(); const cur = new Map(); const out = [];
  for (const f of [...(fills || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    const sym = f.symbol; const sz = +f.size || 0;
    const dir = fillPosDir(f);
    const k = `${sym}:${dir}`;
    const isClose = f.tradeSide === 'close' || (f.profit || 0) !== 0;
    if (!cur.has(k)) {
      cur.set(k, { symbol: sym, dir, openTs: f.ts, fills: 0, fees: 0, profit: 0, notional: 0, riskUsd: 0, bot: f.src == null ? null : f.src === 'api', strat: null });
    }
    const e = cur.get(k); e.fills++; e.fees += +f.fee || 0;
    if (+f.riskUsd > e.riskUsd) e.riskUsd = +f.riskUsd;
    if (!isClose) { qty.set(k, (qty.get(k) || 0) + sz); e.notional += +f.notionalUsd || 0; }
    else {
      e.profit += +f.profit || 0;
      qty.set(k, (qty.get(k) || 0) - sz);
      if ((qty.get(k) || 0) <= Math.max(sz * 0.01, 1e-9)) { e.closeTs = f.ts; e.netUsd = e.profit - e.fees; out.push(e); cur.delete(k); }
    }
  }
  for (const e of cur.values()) { e.open = true; e.netUsd = e.profit - e.fees; out.push(e); }
  return out;
};
const episodeStats = (epis) => {
  const closed = epis.filter((e) => !e.open);
  const wins = closed.filter((e) => e.netUsd > 0);
  const gW = wins.reduce((a, e) => a + e.netUsd, 0);
  const gL = Math.abs(closed.filter((e) => e.netUsd <= 0).reduce((a, e) => a + e.netUsd, 0));
  const rs = closed.filter((e) => e.riskUsd > 0).map((e) => e.netUsd / e.riskUsd);
  const m = rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : 0;
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, x) => a + (x - m) ** 2, 0) / (rs.length - 1)) : 0;
  return {
    episodes: closed.length, open: epis.length - closed.length,
    botEpisodes: closed.filter((e) => e.bot === true).length,
    wins: wins.length, winRatePct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    netUsd: round(closed.reduce((a, e) => a + e.netUsd, 0), 4),
    feesUsd: round(closed.reduce((a, e) => a + e.fees, 0), 4),
    profitFactor: gL > 0 ? round(gW / gL, 2) : null,
    sqn: rs.length > 1 && sd > 0 ? round((m / sd) * Math.sqrt(rs.length), 2) : null,
    sqnN: rs.length, meanR: rs.length ? round(m, 3) : null,
    firstTs: epis.length ? Math.min(...epis.map((e) => e.openTs || Infinity)) : null,
    lastTs: epis.length ? Math.max(...epis.map((e) => e.closeTs || e.openTs || 0)) : null,
  };
};

// ---------- exchange adapter ----------
// All wire ops delegate to scripts/exchange/ — SENTINEL_EXCHANGE selects the
// driver (bitget default, bybit for V5). Aliases keep every call site below
// unchanged; the adapters return identical normalized shapes.
const getPos = () => X.getPos();
const getAccount = () => X.getAccount();
const getPlans = (symbol) => X.getPlans(symbol);
let POS_MODE = 'oneway'; // mirrored into the adapter via setPosMode below
// getPosMode also pushes the detected mode into the adapter so its
// marketOrder emits the right close semantics (reduceOnly vs tradeSide)
const getPosMode = (symbol) =>
  X.getPosMode(symbol).then((m) => { X.setPosMode?.(m); return m; });
const setIsolated = (symbol) => X.setIsolated(symbol);
const setLeverage = (symbol, leverage) => X.setLeverage(symbol, leverage);
const marketOrder = (symbol, side, size, intent, extra = {}) =>
  X.marketOrder(symbol, side, size, intent, extra);
// EXEC_MAKER_ENTRIES (default ON — fee mandate: save max on fees). Entries
// route through a post-only limit at touch when the book allows (maker
// ~0.02% vs taker ~0.06%); an unfilled/rejected attempt falls back to market
// for the REMAINDER — a certified entry is never sacrificed for a bp.
const MAKER_ENTRIES = process.env.EXEC_MAKER_ENTRIES !== '0';
const limitOrder = (symbol, side, size, price, extra = {}) =>
  X.limitOrder(symbol, side, size, price, extra);
const pendingOrders = (symbol) => X.pendingOrders(symbol);
const planOrder = (symbol, planType, triggerPrice, size, holdSide, marginMode) =>
  X.planOrder(symbol, planType, triggerPrice, size, holdSide, marginMode);
// real vault segregation (live only — SENTINEL_VAULT_TRANSFER=1): the
// sweep MOVES funds out of the tradable account (futures->spot on Bitget,
// UNIFIED->FUND on Bybit). api() never retries POSTs — a failed transfer
// surfaces as an error, never double-moves.
const vaultTransfer = (amtUsd) => X.vaultTransfer(amtUsd);
// Transient placement errors: Bitget 43023 'Insufficient position' fires
// when the position index hasn't caught up to a fresh fill; 43059 is the
// generic transient. Bybit equivalents: 10016 (server busy), 170213 (order
// race), 110025 (position idx sync). Retry 2x with backoff before declaring
// protection failed — the emergency-close path relies on a real failure.
const planWithRetry = async (fn) => {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!/43023|43059|10016|110025|170213/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
};
// recent fills — the REAL trade journal: every actual fill the exchange
// recorded, deduped into the mode-scoped fills file so the public ledger
// shows real entries/exits with real fees, not just the sim's paper model
const getFills = () => X.getFills();
// full-position close — dedicated endpoint on Bitget; Bybit adapter
// resolves size itself and sends a reduceOnly market order
const closePosition = (symbol, holdSide) => X.closePosition(symbol, holdSide);
const cancelPlanOrders = (symbol, planType, orderIds) =>
  X.cancelPlanOrders(symbol, planType, orderIds);
const cancelByType = async (symbol, pred) => {
  const plans = await getPlans(symbol).catch(() => []);
  const byType = {};
  for (const p of plans || [])
    if (p.orderId && p.planType && pred(p)) (byType[p.planType] ??= []).push(p.orderId);
  let n = 0;
  for (const [pt, ids] of Object.entries(byType)) {
    await cancelPlanOrders(symbol, pt, ids).catch(() => {});
    n += ids.length;
  }
  return n;
};
const cancelPlans = (symbol) => cancelByType(symbol, () => true);
// cancel ONLY loss-side plans — a blanket cancel was wiping the TP ladder
// off the exchange every time a trail ratcheted. 'moving_plan' is the
// trailing-stop type — it stops the same side a loss plan does, so it must
// match too (a /loss|stop/ regex alone leaves it orphaned).
const cancelLossPlans = (symbol) =>
  cancelByType(symbol, (p) => /loss|stop|moving/i.test(p.planType || ''));

// ---------- contracts: size rounding + minimums ----------
// demo environments list a SUBSET of the live catalog — the adapter sources
// contracts from the ACTIVE environment so orders never size for symbols
// this environment can't route
const contractMap = () => X.contractMap();
const sizeFor = (cm, symbol, notionalUsd, price) => {
  const c = cm[symbol];
  if (!c) return null;
  let size = notionalUsd / price;
  const p = Math.pow(10, c.sizePlace);
  size = Math.floor(size * p) / p;
  const minSize = Math.max(c.minTradeNum, c.minTradeUSDT / price);
  return size >= minSize ? size : null;
};

// ---------- main ----------
async function main() {
  const tRun = Date.now();
  const planPath = path.join(API_DIR, 'live-plan.json');
  const outPath = path.join(API_DIR, 'live-ledger.json');
  const state = { mode: MODE, exchange: X.name, refreshedAt: new Date().toISOString(), actions: [], errors: [] };
  // untradeable symbols persist across runs — the scanner blocks entries on
  // them, so the executor never re-attempts and never re-fails. Without the
  // merge the block would flap off every other cycle. Authoritative store is
  // exec-catalog.json (survives ledger rewrites); live-ledger kept in sync
  // for the dashboard.
  const catPath = path.join(API_DIR, 'exec-catalog.json');
  const priorPlanSyms = new Set();
  // engine-managed symbols: positions THIS executor entered (persisted in
  // the ledger across restarts). A symbol not in the set is a foreign
  // position — opened manually on the app/exchange — which we arm with
  // protection but never expose to scanner-driven exits.
  const managed = new Set();
  // prior-cycle leg/size memory — the banked-tranche floor detects a filled
  // TP leg by it vanishing from the pending book while its level sits behind
  // the mark; position-size memory catches non-ladder trims (guard/manual)
  // the same way. Persisted via state.legs + positionsAfter on the ledger.
  const priorLegMap = {};   // sym -> [tp limit px] armed last cycle
  const priorSizeMap = {};  // sym -> position size last cycle
  const curLegMap = {};     // sym -> [tp limit px] armed this cycle
  const trimGuard = {};     // sym -> ts of last structural de-risk trim
  let priorDayPeak = null;  // {day, usd} — session high watermark for the massacre governor
  try {
    const sameBook = (prior) => prior.mode === MODE && (prior.exchange || 'bitget') === X.name;
    for (const f of [outPath, catPath]) {
      const prior = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (sameBook(prior) && prior.untradeable?.length)
        state.untradeable = [...new Set([...(state.untradeable || []), ...prior.untradeable])];
      // protection-failure circuit breaker rides in the ledger: after a
      // TPSL placement failure that forced an emergency close, entries halt
      // until the timestamp — one 30min probe costs a fee, a 15s probe loop
      // drains the account on retries that can't succeed
      if (sameBook(prior) && Number.isFinite(prior.protectionHaltUntil))
        state.protectionHaltUntil = Math.max(state.protectionHaltUntil || 0, prior.protectionHaltUntil);
      // Van Tharp Model 17 carry-over: last cycle's position-level SQN
      // sets this cycle's risk tier — risk follows demonstrated quality.
      if (sameBook(prior) && prior.sqnR) state.priorSqnR = prior.sqnR;
      // entry-attempt log rides the ledger too — the fills journal lags
      // ~30s behind live order routing, so a probe loop can slip extra
      // opens under the rate cap before the fills ever record. Attempts
      // (not fills) are what cost fees; count them locally.
      if (sameBook(prior) && Array.isArray(prior.entriesLog)) {
        // merge, don't overwrite — this block runs once per file; a second
        // file's entriesLog must ADD to the first's, not replace it.
        // Dedupe on the serialized row (same entry = same JSON).
        const merged = new Map((state.entriesLog || []).map((e) => [typeof e === 'object' ? JSON.stringify(e) : String(e), e]));
        for (const e of prior.entriesLog) {
          if (e == null) continue; // a null row would throw on .ts access below
          // entries may be bare timestamps (legacy) or {ts,symbol,direction}.
          // 24h retention — the hourly cap filters to the window itself; a
          // true DAILY cap needs the whole day's attempts retained.
          if (!Number.isFinite(e.ts ?? e) || Date.now() - (e.ts ?? e) >= 24 * 3600e3) continue;
          merged.set(typeof e === 'object' ? JSON.stringify(e) : String(e), e);
        }
        state.entriesLog = [...merged.values()].slice(-500); // hard cap — a churn storm can't grow the ledger row unbounded
      }
      // symbols that carried pending plans last cycle — orphan-plan sweep
      // uses this to find triggers still live on symbols now flat
      if (sameBook(prior) && prior.plans)
        for (const s of Object.keys(prior.plans)) priorPlanSyms.add(s);
      if (sameBook(prior) && prior.legs)
        for (const [s, l] of Object.entries(prior.legs)) if (Array.isArray(l)) priorLegMap[s] = l;
      if (sameBook(prior) && Array.isArray(prior.positionsAfter))
        for (const pp2 of prior.positionsAfter) if (pp2?.symbol) priorSizeMap[pp2.symbol] = +pp2.size || 0;
      if (sameBook(prior) && prior.trimGuard)
        for (const [s, t] of Object.entries(prior.trimGuard)) trimGuard[s] = +t || 0;
      if (sameBook(prior) && prior.dayPeak?.day) priorDayPeak = prior.dayPeak;
      if (sameBook(prior) && Array.isArray(prior.managed))
        for (const s of prior.managed) managed.add(s);
    }
  } catch {}
  // setup-armed symbols: positions born from the operator setup queue
  // (state/cmd-setups.json) carry the operator's OWN absolute SL/TP
  // prices — the keepTrigs rebuild path below must preserve those levels
  // instead of re-laddering at engine RR bands. Persisted per-symbol so a
  // restart can't strip the levels; pruned when the position goes flat.
  const armsPath = path.join(__dirname, '..', 'state', 'setup-syms.json');
  const setupArms = (() => {
    try { return JSON.parse(fs.readFileSync(armsPath, 'utf8')) || {}; }
    catch { return {}; }
  })();
  let armsDirty = false;
  if (MODE === 'off') {
    log('mode=off — set SENTINEL_EXEC=shadow|demo|live');
    return;
  }
  // ---- run lock: cycles spawn on a fixed timer, but a run's network
  // latency can outlive its slot. One live run at a time — exchange-side
  // plans keep every position protected while a cycle is skipped.
  const lockPath = path.join(__dirname, '..', 'state', 'exec.lock');
  try {
    const lk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    let alive = false;
    if (Number.isFinite(lk.pid) && Date.now() - (lk.ts || 0) < 180e3) {
      try { process.kill(lk.pid, 0); alive = true; }
      catch (e) { alive = e.code === 'EPERM'; }
    }
    if (alive) {
      log(`prior run still working (pid ${lk.pid}, ${Math.round((Date.now() - lk.ts) / 1e3)}s) — skipping cycle`);
      return;
    }
  } catch {}
  try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(lockPath); } catch {} });
  // 🌆 pimpcity tick — attribution, turf war, intent reconcile, save.
  // Needs only the fill journal + the set of open symbols, so it runs on
  // EVERY path a cycle takes — including stale-plan and unreadable-plan
  // bails, where accounting continuity matters most (positions still
  // close via exchange stops while the exec refuses to route).
  let war = null, pc = null;
  const pimpTick = async (openSyms) => {
    try {
      pc = pc || await import('./pimpcity.mjs');
      war = pc.loadWar();
      const warFills = loadFills();
      for (const l of pc.attribute(war, warFills)) state.actions.push('🌆 ' + l);
      for (const l of pc.fight(war)) state.actions.push('🌆 ' + l);
      // reconcile intents vs the fill journal: a nomination earns "on
      // shift" only with a matching open fill AND a live position —
      // queued-never-filled nominations stay pending, expire at 15min.
      // Preferred bind: intent.coid → orderMap (exchange orderId written at
      // submit) → fill.orderId — deterministic. Fallback: newest engine
      // open fill on the symbol (src 'api' or legacy-unknown — never a
      // manual ios/android/web fill).
      for (const it of war.intents || []) {
        if (it.filledAt == null) {
          const ids = it.coid
            ? [it.coid, it.coid + 'r', it.coid + 'm'].map((k) => war.orderMap?.[k]).filter(Boolean)
            : [];
          const of = ids.length
            ? [...warFills].reverse().find((f) => f.tradeSide === 'open' && ids.includes(String(f.orderId)))
            : [...warFills].reverse().find((f) => f.tradeSide === 'open' && f.symbol === it.symbol
                && !/ios|android|web/i.test(f.src || '') && (+f.ts || 0) >= it.ts - 60e3);
          if (of) { it.filledAt = +of.ts || Date.now(); if (of.orderId) it.orderId = String(of.orderId); }
        }
        it.live = it.filledAt != null && openSyms.has(it.symbol);
      }
      war.intents = (war.intents || []).filter((it) => it.live || Date.now() - it.ts < 15 * 60 * 1000);
      // orderMap is a bridge, not a ledger — bound intents don't need it
      // anymore; cap the map so a long session can't grow it unbounded
      const omk = Object.keys(war.orderMap || {});
      if (omk.length > 200) for (const k of omk.slice(0, omk.length - 200)) delete war.orderMap[k];
      try { pc.saveWar(war); } catch {}
    } catch (e) { state.errors.push('pimpcity: ' + e.message); }
  };
  const openSymsNow = async () => {
    const ps = await getPos().catch(() => []);
    return new Set((ps || []).filter((p) => +p.total > 0).map((p) => p.symbol));
  };
  let plan = null;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    if (MODE !== 'off') {
      state.errors.push(`live-plan.json unreadable: ${e.message}`);
      await pimpTick(await openSymsNow());
      writeJson(outPath, state);
    }
    log('no readable plan — nothing to route');
    return;
  }
  plan.orders = Array.isArray(plan.orders) ? plan.orders : [];
  plan.closes = Array.isArray(plan.closes) ? plan.closes : [];
  plan.trails = Array.isArray(plan.trails) ? plan.trails : [];
  state.planAgeMs = Number.isFinite(plan.ts) ? Date.now() - plan.ts : null;
  // gate-reject transparency: the scanner now tells us WHY each candidate
  // was stood down — surface the counts so "nothing opened" has a reason
  // attached instead of silence
  if (Array.isArray(plan.rejects) && plan.rejects.length)
    state.rejects = plan.rejects.slice(0, 12);
  const stale = !Number.isFinite(plan.ts) || Date.now() - plan.ts > (plan.ttlMs || 900e3);

  if (stale) {
    state.errors.push(`plan stale (${Math.round((Date.now() - plan.ts) / 6e4)}min > ${(plan.ttlMs / 6e4)|0}min) — refused`);
    await pimpTick(await openSymsNow());
    writeJson(outPath, state);
    log('stale plan — refused to route old prices');
    return;
  }
  if (MODE === 'shadow') {
    fs.writeFileSync(
      path.join(API_DIR, 'live-shadow.json'),
      JSON.stringify({ ...state, plan, note: 'would execute exactly this — no keys needed, nothing sent' })
    );
    log(`shadow: ${plan.orders.length} orders / ${plan.closes.length} closes / ${plan.trails.length} trail amends`);
    const bad = plan.orders.filter((o) => !o.symbol || !Number.isFinite(o.refEntry) || !Number.isFinite(o.notionalUsd) || !Number.isFinite(o.stopPct) || !Number.isFinite(o.targetPct) || !o.direction || !o.leverage);
    if (bad.length) log(`shadow WARNING: ${bad.length} orders missing required fields — executor would refuse them live`);
    return;
  }
  // mode whitelist — anything that isn't demo/live must never reach a
  // signed endpoint. A typo'd SENTINEL_EXEC would otherwise bypass the
  // live-arming gate entirely.
  if (MODE !== 'demo' && MODE !== 'live') {
    state.errors.push(`unknown SENTINEL_EXEC="${MODE}" — refusing (off|shadow|demo|live)`);
    writeJson(outPath, state);
    log('unknown mode — refusing');
    return;
  }
  if (!X.hasCreds) {
    state.errors.push(`missing ${X.name.toUpperCase()} API credentials (${X.name === 'bybit' ? 'BYBIT_DEMO_API_KEY/SECRET' : 'BITGET_DEMO_API_KEY/SECRET/PASSPHRASE'})`);
    writeJson(outPath, state);
    log('no credentials — set env keys');
    return;
  }
  if (MODE === 'live' && !LIVE_ARMED) {
    state.errors.push('live requires SENTINEL_LIVE=1 AND CONFIRM_LIVE=YES');
    writeJson(outPath, state);
    log('live mode not armed — refusing');
    return;
  }

  const cm = await contractMap();
  // persist the environment catalog + runtime rejections as a sidecar — the
  // scanner gates entries on this so it never simulates positions the active
  // environment can never hold (demo lists ~45 symbols vs live's ~800)
  try {
    fs.writeFileSync(catPath, JSON.stringify({
      mode: MODE, exchange: X.name, at: new Date().toISOString(),
      symbols: Object.keys(cm),
      untradeable: state.untradeable || [],
    }));
  } catch {}
  // probe posMode on a symbol guaranteed to exist — a bad first plan symbol
  // would otherwise fail the probe and refuse the entire run
  const probeSym = 'BTCUSDT';
  const [positions, acct] = await Promise.all([
    getPos().catch((e) => (state.errors.push('positions: ' + e.message), [])),
    getAccount().catch(() => ({ equity: 0, available: 0 })),
    getPosMode(probeSym)
      .then((m) => { POS_MODE = m; })
      .catch((e) => state.errors.push('posMode detect failed — fail-closed: ' + e.message)),
  ]);
  if (state.errors.some((e) => e.startsWith('posMode'))) {
    writeJson(outPath, state);
    log('cannot determine position mode — refusing to guess close semantics');
    return;
  }
  // SENTINEL_EQUITY_OVERRIDE_USD (demo only) — paper-test a small book on
  // a big demo balance: sizing, caps, breakers and the equity floor all
  // judge the book as if equity were this figure. Never pretends the book
  // is bigger than the real balance, and never applies live — real money
  // always sizes off real equity.
  const EQ_OVERRIDE = MODE === 'demo' ? +(process.env.SENTINEL_EQUITY_OVERRIDE_USD || 0) : 0;
  // the override is the STARTING book, not a permanent pin — the test
  // account compounds/suffers its own realized record: book = base +
  // epoch net (every journaled fill: open fees + close P&L) - the vault.
  const epochNet = EQ_OVERRIDE > 0 ? loadFills().reduce((a, f) => a + (+f.profit || 0) - (+f.fee || 0), 0) : 0;
  const vaultState0 = loadVault();
  const vaultNow = +vaultState0.balanceUsd || 0;
  // subtract only the UNMOVED vault balance: funds already transferred to
  // spot left the futures account — acct.equity excludes them, so a blind
  // subtraction would double-count the carry out of the book.
  // unmoved = carry still sitting in the futures account (pending USDT not
  // yet transferred to spot). deployed ⊆ transferred — BTC buys spend the
  // transferred bucket, so subtracting deployed too would double-count.
  const vaultUnmoved = vaultNow - (+vaultState0.transferredUsd || 0) - (+vaultState0.lostUsd || 0);
  const equityUsd = EQ_OVERRIDE > 0
    ? Math.max(0, Math.min(acct.equity, EQ_OVERRIDE + epochNet) - vaultUnmoved)
    : Math.max(0, acct.equity - vaultUnmoved);
  state.epochNetUsd = EQ_OVERRIDE ? round(epochNet, 2) : undefined;
  state.vaultUsd = round(vaultNow, 2);
  state.vaultSweeps = (loadVault().sweeps || []).length;
  state.edgeLive = round(EDGE_LIVE.v, 3);
  state.edgeSrc = EDGE_LIVE.src;
  // `available` ignores crossed-position unrealized losses — a cross book
  // deep in the red still reports the raw balance, while Bitget's order
  // validator nets upl before accepting margin. Overestimating here was
  // the recurring 40762 loop: size off equity-equivalent spendable, not
  // the flattering balance number.
  const crossUplNeg = (positions || []).reduce(
    (a, p) => a + ((p.marginMode || '').toLowerCase() === 'crossed' ? Math.min(0, +p.unrealizedPL || 0) : 0), 0);
  // entries run isolated (setIsolated) — isolatedMaxAvailable is the
  // validator's own spendable number; trust it when present, else fall back
  // to the upl-adjusted balance. 0 means 0 — a $26 book soaked by a crossed
  // loser must not keep probing orders it can never fund (40762 loop).
  let marginFree = Number.isFinite(acct.isoMax)
    ? Math.max(0, acct.isoMax)
    : Math.max(0, Math.min(acct.available, acct.available + crossUplNeg));
  const scale = equityUsd > 0 ? Math.min(1, equityUsd / PAPER_EQUITY) : 0;
  state.equityUsd = round(equityUsd, 2);
  if (EQ_OVERRIDE) state.equityReal = round(acct.equity, 2);
  state.marginFreeUsd = round(marginFree, 2);
  state.posMode = POS_MODE;
  const rawPos = (positions || []).filter((p) => +p.total > 0);
  // ---- extended Telegram C2 channels — one-line state files the operator
  // drives from Saved Messages. Merged HERE, before the hold/stale reports
  // and every downstream gate, so handset adds take effect this same cycle.
  // They merge with (never shrink) the env-side lists — a handset add can't
  // unprotect an env-declared hold.
  const cmdJson = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', name), 'utf8')); }
    catch { return null; }
  };
  for (const s of (cmdJson('cmd-manual-hold.json')?.symbols || [])) MANUAL.add(String(s).toUpperCase());
  for (const s of (cmdJson('cmd-deny.json')?.symbols || [])) DENY_SYMS.add(String(s).toUpperCase());
  // auto-quarantine merge: state/auto-deny.json is written by the self-audit
  // in the breaker block below — measured-negative symbols earn a bounded,
  // self-expiring deny (the "attack itself to find the holes" desk rule,
  // run every cycle instead of every Sunday).
  try {
    const ad = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'auto-deny.json'), 'utf8'));
    for (const e of ad.entries || [])
      if (+e.until > Date.now()) DENY_SYMS.add(String(e.symbol).toUpperCase());
  } catch {}
  // a MANUAL_HOLD on a flat symbol silently exempts future auto-entries from
  // management — flag it so the exemption can't linger forgotten
  state.manualHoldStale = [...MANUAL].filter((s) => !rawPos.some((p) => p.symbol === s && +p.total > 0));
  state.manualHoldActive = [...MANUAL].filter((s) => rawPos.some((p) => p.symbol === s && +p.total > 0));
  state.positions = rawPos.map((p) => ({
    symbol: p.symbol, side: p.holdSide, size: +p.total,
    entry: +p.openPriceAvg, upl: +p.unrealizedPL, lev: +p.leverage,
    margin: +p.marginSize || 0,
    marginMode: p.marginMode, cTime: +(p.cTime || 0), liq: +p.liquidationPrice || 0,
  }));
  // hedge-mode accounts can hold both directions on one symbol — a
  // symbol-keyed map would silently pick one and close the wrong side
  const ambiguous = new Set();
  for (const p of rawPos) {
    if (rawPos.some((q) => q.symbol === p.symbol && q.holdSide !== p.holdSide)) ambiguous.add(p.symbol);
  }
  const posBySym = new Map();
  for (const p of state.positions) {
    if (ambiguous.has(p.symbol)) continue;
    posBySym.set(p.symbol, p);
  }
  for (const s of ambiguous) state.errors.push(`${s}: both long AND short open — refusing to guess, close manually`);
  // 🌆 pimpcity — tick runs EARLY on purpose: cycles under box load get
  // killed before the tail, and a stale war file means stale attribution +
  // a dashboard lying about who's on shift. Needs only posBySym + the fill
  // journal — both available now. Advisory; nomination consumes the roster
  // downstream.
  await pimpTick(new Set(posBySym.keys()));
  // excursion tracking for the stall-exit gate — peak/trough per open
  // position, refreshed each cycle by the excursion block below
  const maeTrack = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'mae-track.json'), 'utf8')); }
    catch { return {}; }
  })();
  // integrity verify — the money files (journal, vault, ladder config)
  // are never trusted blind: recompute CRC32 vs the write manifest; a
  // mismatch means corruption or tamper and lands on the error feed.
  for (const cf of [
    path.join(__dirname, '..', 'state', FILLS_FILE),
    VAULT_PATH,
    path.join(__dirname, '..', 'state', 'rr-config.json'),
  ]) {
    const c = integrityCheck(cf);
    if (c.ok === false)
      state.errors.push(`integrity: ${path.basename(cf)} checksum mismatch (${c.actual || 'unreadable'} != manifest ${c.expected || '?'}) — verify provenance`);
  }
  log(`${MODE}: equity $${equityUsd.toFixed(2)} | ${state.positions.length} open | scale ${scale.toFixed(3)}`);

  // prune managed to still-open symbols — if the engine's position is flat
  // and the user re-opens the same symbol by hand, the new one is foreign
  // and must not inherit engine exits. Publish for the ledger persist.
  for (const s of [...managed]) if (!posBySym.has(s)) managed.delete(s);
  for (const s of Object.keys(setupArms))
    if (!posBySym.has(s)) { delete setupArms[s]; armsDirty = true; }
  // foreign = open on the exchange but not engine-entered and not
  // MANUAL-whitelisted — protection synthesis applies, scanner exits do not.
  const foreign = (sym) => !managed.has(sym) && !MANUAL.has(sym);

  // ---- operator panic flatten: state/cmd-flatten.json (telegram C2,
  // CONFIRM-gated at the source) closes EVERY open position — engine,
  // manual, foreign — at market. One-shot: the flag self-clears after the
  // sweep so a stale file can't flatten a future book.
  const flatPath = path.join(__dirname, '..', 'state', 'cmd-flatten.json');
  let cmdFlat = null;
  try { const c = JSON.parse(fs.readFileSync(flatPath, 'utf8')); if (c.flatten) cmdFlat = c; } catch {}
  if (cmdFlat) {
    try {
      fs.writeFileSync(flatPath, JSON.stringify({ flatten: false, doneAt: new Date().toISOString(), positions: posBySym.size }));
    } catch {}
    for (const [sym, p] of posBySym) {
      try {
        await cancelPlans(sym);
        await closePosition(sym, p.side);
        state.actions.push(`🧯 flatten: closed ${sym} ${p.side} ${p.size}`);
        posBySym.delete(sym);
      } catch (e) { state.errors.push(`flatten ${sym}: ${e.message}`); }
    }
  }

  // ---- closes first: freeing margin and killing contradicted exposure is
  // always the priority ----
  // EXEC_SCANNER_CLOSES=0 (operator mandate): scanner/sim closes are OFF —
  // a sim ledger settle is paper bookkeeping; it must not spend real taker
  // fees cancelling a protected position. Real exits = exchange TP/SL +
  // manual flatten only. The stop IS the exit decision, made in advance.
  if (process.env.EXEC_SCANNER_CLOSES !== '0')
  for (const c of plan.closes) {
    // manual-hold and foreign positions are exempt from scanner-driven
    // exits — a paper ledger expiry/reversal must not kill a deliberately
    // held position, nor one the user opened outside the engine
    if (MANUAL.has(c.symbol) || foreign(c.symbol)) {
      state.actions.push(`📤 close ${c.symbol} skipped — ${MANUAL.has(c.symbol) ? 'manual hold' : 'foreign position'}`);
      continue;
    }
    const pos = posBySym.get(c.symbol);
    if (!pos) continue;
    // min-hold: a scanner close inside the floor is the flip-flop vector —
    // the position was opened seconds ago and never got to be a trade.
    // The exchange-side SL covers a genuine dump meanwhile; nothing the
    // scanner says at <10min age is worth two more taker fees.
    if (pos.cTime && Date.now() - pos.cTime < MIN_HOLD_MS) {
      state.actions.push(`📤 close ${c.symbol} ignored — position ${Math.round((Date.now() - pos.cTime) / 1e3)}s old (< ${Math.round(MIN_HOLD_MS / 1e3)}s min-hold)`);
      continue;
    }
    try {
      await cancelPlans(c.symbol);
      await closePosition(c.symbol, pos.side);
      state.actions.push(`📤 closed ${c.symbol} ${pos.side} ${pos.size}`);
      posBySym.delete(c.symbol);
    } catch (e) {
      // already flat / position gone — the sim's own exit path (stop, TP,
      // expiry) fired first; a close for a missing position is convergence
      // confirmed, not an error
      if (/22002|no position|not exist|40034/i.test(e.message))
        state.actions.push(`📤 close ${c.symbol}: already flat`);
      else state.errors.push(`📤 close ${c.symbol}: ${e.message}`);
    }
  }

  // trailing stops removed by mandate — stops stay where the entry set them

  // ---- real-equity drawdown guard: the kill-switch keys off the ACTUAL
  // account equity curve (peak persisted across runs), not the sim ledger —
  // sim bookkeeping diverges from exchange truth and must not gate money.
  // The same file keeps a rolling equity tape so a rolling-24h loss halt
  // exists too — max daily drawdown is the rail the teardown flagged missing.
  // mode-scoped DD tape: demo equity must never contaminate the live
  // drawdown series — a $10k demo peak against a $6 live book reads as a
  // permanent ~99.9% wipeout and trips every DD rail on return to live.
  const peakPath = path.join(__dirname, '..', 'state', `equity-peak-${MODE}${BOOK_TAG}.json`);
  let eqTrack = { peak: equityUsd, samples: [], deposits: 0, lastEq: 0, lastUpl: 0 };
  try {
    const prior = JSON.parse(fs.readFileSync(peakPath, 'utf8'));
    eqTrack.peak = +prior.peak || 0;
    eqTrack.samples = Array.isArray(prior.samples) ? prior.samples : [];
    eqTrack.deposits = +prior.deposits || 0;
    eqTrack.lastEq = +prior.lastEq || 0;
    eqTrack.lastUpl = +prior.lastUpl || 0;
    eqTrack.lastEqAt = +prior.lastEqAt || 0;
    eqTrack.lastVault = Number.isFinite(+prior.lastVault) ? +prior.lastVault : null;
    eqTrack.netIds = Array.isArray(prior.netIds) ? prior.netIds : [];
  } catch {}
  const nowMs = Date.now();
  // deposit detection: equity moves unexplained by the change in open UPL
  // (realized closes bank into equity with ~no net change; fees shave
  // cents) are external funding. Deposits corrupt peak/dd — a deposit
  // resets the peak, fakes zero drawdown, and silently disarms the risk
  // throttle, so peak/dd must run on trading equity = equity − deposits.
  const uplNow = [...posBySym.values()].reduce((a, p) => a + (+p.upl || 0), 0);
  // pinned-equity test books: with equity fixed at the override, every real
  // balance move would masquerade as a deposit — tracking stays off so
  // peak/dd run on the test book, not the demo account's actual balance.
  if (eqTrack.lastEq > 0 && !EQ_OVERRIDE) {
    // realized flows explain the equity move: fills banked since the last
    // check land in balance, and vault sweeps leave tradable equity without
    // touching balance. Without both terms a >$5 win books as a "deposit"
    // and a >$15 loss as a "withdrawal" — tradingEq stays flat and the dd
    // tape never sees the loss (kill-switch blindness). 2min overlap +
    // tradeId dedupe tolerates out-of-order/late fill delivery.
    const prevAt = eqTrack.lastEqAt || nowMs;
    const netIdSet = new Set(eqTrack.netIds);
    let tradeNet = 0;
    try {
      for (const f of loadFills()) {
        const ts = +f.ts || 0;
        if (ts <= prevAt - 120e3 || netIdSet.has(f.tradeId)) continue;
        netIdSet.add(f.tradeId);
        tradeNet += (+f.profit || 0) - (+f.fee || 0);
      }
    } catch {}
    eqTrack.netIds = [...netIdSet].slice(-400);
    const dVault = vaultNow - (eqTrack.lastVault ?? vaultNow);
    const unexplained = equityUsd - eqTrack.lastEq - (uplNow - eqTrack.lastUpl) - tradeNet + dVault;
    if (unexplained > 5) {
      eqTrack.deposits += unexplained;
      state.actions.push(`💰 deposit detected +$${round(unexplained, 2)} (total funding $${round(eqTrack.deposits, 2)})`);
      try {
        fs.appendFileSync(path.join(__dirname, '..', 'state', 'tg-outbox.jsonl'),
          JSON.stringify({ at: Date.now(), text: `💰 DEPOSIT +$${unexplained.toFixed(2)} detected — deploying per mandate.` }) + '\n');
      } catch {}
    } else if (unexplained < -15) {
      eqTrack.deposits += unexplained; // withdrawals shrink the funding baseline too
      state.actions.push(`🏧 withdrawal detected $${round(unexplained, 2)}`);
    }
  }
  eqTrack.lastEq = equityUsd;
  eqTrack.lastUpl = uplNow;
  eqTrack.lastEqAt = nowMs;
  eqTrack.lastVault = vaultNow;
  const tradingEq = equityUsd - eqTrack.deposits;
  eqTrack.peak = Math.max(tradingEq, eqTrack.peak);
  // a failed account read returns equity=0 — pushing that sample would fake
  // a total wipeout on the rolling DD tape. Only record real reads.
  if (equityUsd > 0) eqTrack.samples.push([nowMs, tradingEq]);
  eqTrack.samples = eqTrack.samples.filter(([t]) => nowMs - t < 36e5 * 24.5).slice(-7000);
  try { writeJson(peakPath, { peak: eqTrack.peak, samples: eqTrack.samples, deposits: eqTrack.deposits, lastEq: eqTrack.lastEq, lastUpl: eqTrack.lastUpl, lastEqAt: eqTrack.lastEqAt, lastVault: eqTrack.lastVault, netIds: eqTrack.netIds, at: new Date().toISOString() }); } catch {}
  // dd base = funded capital + best trading gain. The raw peak/tradingEq
  // form divides by peak≈0 when an epoch starts near-empty then gets
  // funded — tradingEq can even go negative, producing >100% dd forever
  // and permanently tripping every rail (observed: ddPct 345 phantom).
  // With zero deposits this reduces to the classic equity-peak formula.
  const ddBase = eqTrack.deposits + Math.max(0, eqTrack.peak);
  const realDdPct = ddBase > 0 ? Math.max(0, (ddBase - equityUsd) / ddBase) * 100 : 0;
  const peak24 = Math.max(tradingEq, ...eqTrack.samples.filter(([t]) => nowMs - t <= 36e5 * 24).map(([, q]) => q));
  const ddBase24 = eqTrack.deposits + Math.max(0, peak24);
  const dd24 = ddBase24 > 0 ? Math.max(0, (ddBase24 - equityUsd) / ddBase24) * 100 : 0;
  state.depositsUsd = round(eqTrack.deposits, 2);
  state.ddPct = round(realDdPct, 2);
  state.dd24Pct = round(dd24, 2);
  // intraday massacre governor — session drawdown measured off TODAY's
  // equity peak, not the funded-capital basis (dd24's denominator rolls and
  // reads low while the session bleeds). Past MASSACRE_DD_PCT every
  // deployment path stands down: entries, top-ups, carry, mandate. Exits
  // and protection are untouched — stops still ratchet, trims still bank.
  const dayKey = new Date().toISOString().slice(0, 10);
  const dayPeakUsd = Math.max(equityUsd, priorDayPeak?.day === dayKey ? +priorDayPeak.usd || 0 : 0);
  state.dayPeak = { day: dayKey, usd: round(dayPeakUsd, 2) };
  const dayDDpct = dayPeakUsd > 0 ? Math.max(0, (dayPeakUsd - equityUsd) / dayPeakUsd) * 100 : 0;
  state.dayDDPct = round(dayDDpct, 2);
  const MASSACRE_DD_PCT = +(process.env.SENTINEL_MASSACRE_DD_PCT || 20);
  // DD-scaled risk — a wounded book defends with smaller knives. Survival
  // first: size follows the session's damage, not the mandate's appetite.
  const ddRiskScale = dayDDpct >= 30 ? 0 : dayDDpct >= 20 ? 0.25 : dayDDpct >= 10 ? 0.5 : 1;
  state.ddRiskScale = ddRiskScale;
  const MIN_TRADE_EQUITY = +(process.env.SENTINEL_MIN_EQUITY || 5.5);
  // ---- operator halt: state/cmd-halt.json written by the telegram C2 —
  // joins the same rail as the kill-switch: entries only, existing
  // positions keep their stops/management
  const cmdHalt = (() => {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'cmd-halt.json'), 'utf8')); return c.halted ? c : null; }
    catch { return null; }
  })();
  // risk multiplier override — clamped hard so a fat-finger can't 50x the book
  const cmdRisk = cmdJson('cmd-risk.json');
  const riskMulOverride = Number.isFinite(+cmdRisk?.mul) ? Math.min(Math.max(+cmdRisk.mul, 0), 8) : null;
  // targeted close — one-shot like flatten: {symbol, ts} closes that symbol's
  // position at market, then self-clears with an ack for the C2 layer.
  const cmdClosePath = path.join(__dirname, '..', 'state', 'cmd-close.json');
  const cmdClose = (() => { try { const c = cmdJson('cmd-close.json'); return c?.symbol ? c : null; } catch { return null; } })();
  if (cmdClose) {
    const p = posBySym.get(String(cmdClose.symbol).toUpperCase());
    try { fs.writeFileSync(cmdClosePath, JSON.stringify({ symbol: null, ackedAt: new Date().toISOString() })); } catch {}
    if (p) {
      try {
        await cancelPlans(p.symbol);
        await closePosition(p.symbol, p.side);
        state.actions.push(`🎯 cmd-close: ${p.symbol} ${p.side} ${p.size} closed by operator`);
        posBySym.delete(p.symbol);
      } catch (e) { state.errors.push(`cmd-close ${p.symbol}: ${e.message}`); }
    } else state.actions.push(`cmd-close ${cmdClose.symbol}: no open position`);
  }
  // operator breaker override — state/cmd-override.json {entries:true, until:ts}.
  // Bounded and self-expiring: the operator can order capital deployed past
  // the circuit breakers, but the safeties re-arm themselves when the window
  // lapses instead of being silently dead forever.
  const cmdOverride = (() => { try { const c = cmdJson('cmd-override.json'); return c && c.entries === true && +c.until > Date.now() ? c : null; } catch { return null; } })();
  // Position-level grading: the journal counts close FILLS, but the trim
  // ladder means one position journals many closes (a 6-leg TP ladder is one
  // trade, not six wins). Every consumer of the record — breakers, CUSUM,
  // Kelly, realizedStats, sqnR — must grade grouped POSITIONS or the
  // architecture flatters itself. Group key = the risk-bearing entriesLog
  // entry the close joins back to (top-ups carry no riskUsd so they never
  // split a position); fills with no joinable entry cluster into
  // 'campaign' buckets by (symbol, close-side) — coarse but honest.
  const groupIntoPositions = (rows, entries, netFn, epochTs) => {
    // epoch boundary = journal's first instrumented OPEN fill (permanent
    // marker — entriesLog only retains 24h and fill tradeIds are per-leg
    // unique, so neither can carry the boundary). Campaign groups whose
    // closes all precede it = pre-epoch legacy positions — opened under a
    // different sizing regime (pre equity-anchor ~$6k raw book) — real
    // dollars on the ledger but not this model's record.
    const groups = new Map();
    for (const f of rows) {
      const fTs = +(f.ts || f.cTime || 0);
      const ent = (entries || []).filter(
        (e) => e.symbol === f.symbol && e.ts <= fTs && e.riskUsd > 0
      ).pop();
      const key = ent ? `pos:${f.symbol}:${ent.ts}`
        : (Number.isFinite(epochTs) && fTs < epochTs
          ? `campaign-pre:${f.symbol}:${f.side}`   // pre-epoch legacy fill
          : `campaign:${f.symbol}:${f.side}`);
      const g = groups.get(key) || { key, symbol: f.symbol, side: f.side, fills: 0, netUsd: 0, riskUsd: ent?.riskUsd ?? null, openTs: ent?.ts ?? null, lastTs: 0 };
      g.fills += 1;
      g.netUsd += netFn(f);
      g.lastTs = Math.max(g.lastTs, fTs);
      groups.set(key, g);
    }
    for (const g of groups.values())
      g.preEpoch = g.key.startsWith('campaign-pre:');
    return [...groups.values()].sort((a, b) => b.lastTs - a.lastTs); // newest-first, like the journal
  };

  // ---- account-level circuit breakers: per-trade stops protect single
  // positions; these stop the ENGINE from grinding the account down via
  // redeploy-after-loss churn (the 181-closes / -$176 / 16% win bleed that
  // ate a deposit). Rolling 24h on BOT fills only (src 'api' + untagged
  // legacy) — the user's manual trades never trip the engine's breakers.
  let cbReason = null;
  try {
    // loss measured against equity at the START of the 24h window, not the
    // shrunken current equity — otherwise the same dollar loss trips an
    // ever-tighter percentage as the book bleeds (denominator drift)
    const winT = Date.now() - 86400e3;
    let eqStart = null;
    for (const [t, q] of eqTrack.samples || [])
      if (t <= winT && (!eqStart || t > eqStart[0])) eqStart = [t, q];
    const lossBasis = eqStart && eqStart[1] > 0 ? eqStart[1] : equityUsd;
    // manual-book attribution: guard/exec protective closes land src 'api'
    // even when the POSITION was hand-opened (web). Attribute every close to
    // its position's open source — majority open qty wins, resets when the
    // book flats — so operator trades can neither trip nor defend the
    // engine's breakers (the NMR manual dip-buy bleed tripped one falsely).
    const allFills = loadFills();
    tagManualCloses(allFills);
    const fills = allFills.filter((f) => (!f.src || f.src === 'api') && !f._manual);
    const day = fills.filter((f) => Date.now() - (f.ts || 0) < 86400e3);
    const closes = fills.filter((f) => f.tradeSide === 'close');
    // grade POSITIONS, not fills: a winning position paying out through a
    // 6-leg trim ladder used to read as 6/6 wins and could hold the
    // win-rate breaker open through a bleed — the same flattery bug in
    // reverse. Groups are newest-first like the journal.
    const openTs = fills.filter((f) => f.tradeSide === 'open').map((f) => +f.ts || Infinity);
    const epochTs = openTs.length ? Math.min(...openTs) : Infinity;
    const posAll = groupIntoPositions(closes, state.entriesLog, (f) => (+f.profit || 0) - (+f.fee || 0), epochTs);
    // pre-epoch positions (opened before journaled entries existed — e.g.
    // legacy fills from the pre-equity-anchor ~$6k book) are real dollars
    // but not THIS model's record — they can't trip or defend the breakers.
    const pos = posAll.filter((g) => !g.preEpoch);
    const last20 = pos.slice(0, 20);
    const dayPnl = day.reduce((a, f) => a + (f.profit || 0), 0);
    const fees24 = day.reduce((a, f) => a + (f.fee || 0), 0);
    const net24 = dayPnl - fees24;
    // transparency split for the dashboard: how much of the 24h window was
    // the ENGINE's book vs operator-attributed closes. The breaker only ever
    // reads the bot column — this surfaces why the two numbers differ.
    const dayAll = allFills.filter((f) => Date.now() - (f.ts || 0) < 86400e3 && (!f.src || f.src === 'api') && f.tradeSide === 'close');
    const net24Manual = dayAll.filter((f) => f._manual).reduce((a, f) => a + (f.profit || 0) - (f.fee || 0), 0);
    const wr = last20.length ? last20.filter((g) => g.netUsd > 0).length / last20.length : null;
    const LOSS_HALT_PCT = +(process.env.SENTINEL_LOSS_HALT_PCT || 8);   // realized bleed vs equity
    const WR_HALT_PCT = +(process.env.SENTINEL_WR_HALT_PCT || 30);      // rolling win-rate floor
    const WR_MIN_N = +(process.env.SENTINEL_WR_MIN_N || 12);            // sample size before WR gates
    const FEE_HALT_PCT = +(process.env.SENTINEL_FEE_HALT_PCT || 10);    // fee churn vs equity
    const STREAK_HALT = +(process.env.SENTINEL_STREAK_HALT || 6);       // consecutive losers stand-down
    const RESERVE_USD = +(process.env.SENTINEL_RESERVE_USD || 0);       // equity reserved from deployment
    if (net24 < -lossBasis * LOSS_HALT_PCT / 100)
      cbReason = `circuit-breaker: 24h bot realized -$${round(-net24, 2)} >= ${LOSS_HALT_PCT}% of window-start equity $${round(lossBasis, 2)}`;
    // profit is the metric, not hit-rate: a low-WR stream only halts when
    // it's actually losing money — profitable asymmetry (few big winners)
    // must never trip a win-rate fetish breaker. Net-negative + collapsed
    // WR = genuinely broken; that case still halts.
    else if (last20.length >= WR_MIN_N && wr != null && wr < WR_HALT_PCT / 100 &&
             last20.reduce((a, g) => a + g.netUsd, 0) <= 0)
      cbReason = `circuit-breaker: rolling win-rate ${round(wr * 100, 0)}% over last ${last20.length} positions < ${WR_HALT_PCT}% AND net $${round(last20.reduce((a, g) => a + g.netUsd, 0), 2)} <= 0`;
    else if (fees24 > equityUsd * FEE_HALT_PCT / 100)
      cbReason = `circuit-breaker: 24h fee burn $${round(fees24, 2)} > ${FEE_HALT_PCT}% of equity — churning`;
    else if (pos.length >= STREAK_HALT &&
             pos.slice(0, STREAK_HALT).every((g) => g.netUsd <= 0))
      cbReason = `circuit-breaker: last ${STREAK_HALT} positions all losers — stand-down`;
    else if (RESERVE_USD > 0 && equityUsd < RESERVE_USD)
      cbReason = `circuit-breaker: equity $${round(equityUsd, 2)} below reserve floor $${RESERVE_USD}`;
    // CUSUM edge-death detector (Page's sequential test, the quant
    // standard for "when to stop trading a strategy"): accumulates the
    // per-position shortfall below the null mean 0 — k=0.25σ slack keeps
    // ordinary noise from accumulating, h=4σ threshold. Detects a
    // persistent MEAN shift (edge evaporation) that magnitude breakers
    // can't see — a slow bleed never trips a streak rule. Runs on
    // position nets so a trim ladder can't smear the distribution.
    let cusum = null;
    if (pos.length >= 10) {
      const nets = pos.slice().reverse().map((g) => g.netUsd); // oldest -> newest
      const m = nets.reduce((a, b) => a + b, 0) / nets.length;
      const sd = Math.sqrt(nets.reduce((a, b) => a + (b - m) ** 2, 0) / (nets.length - 1)) || 1e-9;
      const k = 0.25 * sd, h = 4 * sd;
      let S = 0;
      for (const x of nets) S = Math.max(0, S - x - k);
      cusum = { n: nets.length, meanUsd: round(m, 4), sdUsd: round(sd, 4), S: round(S, 3), h: round(h, 3) };
      if (S > h && !cbReason)
        cbReason = `edge-death CUSUM: position-stream mean shifted negative (S ${round(S, 2)} > h ${round(h, 2)} · mean $${round(m, 3)}/position, n=${nets.length})`;
    }
    // half-Kelly risk ceiling — the realized position record implies an
    // optimal risk fraction f* = p − q/b; we deploy at most half of it
    // (fractional Kelly — the variance-robust textbook choice). f*≤0
    // means the account's own record says negative edge: hard floor.
    let kelly = null;
    if (pos.length >= 15) {
      const wins = pos.filter((g) => g.netUsd > 0);
      const losses = pos.filter((g) => g.netUsd <= 0);
      if (wins.length && losses.length) {
        const p = wins.length / pos.length;
        const avgW = wins.reduce((a, g) => a + g.netUsd, 0) / wins.length;
        const avgL = Math.abs(losses.reduce((a, g) => a + g.netUsd, 0) / losses.length);
        const fStar = p - (1 - p) / Math.max(0.05, avgW / avgL);
        kelly = { fStar: round(fStar, 3), n: pos.length, halfKellyRiskUsd: round(Math.max(0, 0.5 * fStar * equityUsd), 2) };
      }
    }
    state.circuitBreakers = {
      net24Usd: round(net24, 2), fees24Usd: round(fees24, 2), basisUsd: round(lossBasis, 2),
      net24ManualUsd: round(net24Manual, 2), epochMs: FILLS_SINCE || null,
      winRate20: wr != null ? round(wr * 100, 1) : null, positions20: last20.length,
      edgeDeath: cusum, kelly,
      thresholds: { lossHaltPct: LOSS_HALT_PCT, wrHaltPct: WR_HALT_PCT, feeHaltPct: FEE_HALT_PCT, streakHalt: STREAK_HALT, reserveUsd: RESERVE_USD },
      tripped: cbReason,
    };
    var kellyRiskUsd = kelly ? kelly.halfKellyRiskUsd : null;
    // ---- per-symbol bleed quarantine: a symbol whose last AQ_N grouped
    // positions are ALL losers AND that has bled >= AQ_USD net in the window
    // is a measured-negative cell — deny it before redeploy churn grinds the
    // account (the NMR pattern: 14 closes / -$14.79 before anyone noticed).
    // Bounded and self-expiring: entries lapse, the symbol can re-earn its
    // place. Deny merges at the top of this cycle's gate set via the
    // auto-deny.json read near DENY_SYMS — this write feeds the NEXT cycle.
    try {
      const AQ_N = +(process.env.SENTINEL_AQ_N || 4);
      const AQ_USD = +(process.env.SENTINEL_AQ_USD || 1);
      const AQ_MS = +(process.env.SENTINEL_AQ_HOURS || 24) * 3600e3;
      const adPath = path.join(__dirname, '..', 'state', 'auto-deny.json');
      let ad = { entries: [] };
      try { ad = JSON.parse(fs.readFileSync(adPath, 'utf8')); } catch {}
      ad.entries = (ad.entries || []).filter((e) => +e.until > Date.now());
      const bySym = new Map();
      for (const g of pos) {
        if (!bySym.has(g.symbol)) bySym.set(g.symbol, []);
        bySym.get(g.symbol).push(g); // groups are newest-first
      }
      for (const [sym, gs] of bySym) {
        const recent = gs.slice(0, AQ_N);
        const net = recent.reduce((a, g) => a + g.netUsd, 0);
        if (recent.length >= AQ_N && recent.every((g) => g.netUsd <= 0) && net <= -AQ_USD &&
            !ad.entries.some((e) => e.symbol === sym)) {
          ad.entries.push({ symbol: sym, until: Date.now() + AQ_MS, netUsd: round(net, 3), at: Date.now() });
          state.actions.push(`🚫 AUTO-QUARANTINE ${sym}: ${AQ_N} straight losing positions, net $${round(net, 2)} — denied ${AQ_MS / 3600e3}h (measured-negative cell)`);
        }
      }
      fs.writeFileSync(adPath, JSON.stringify(ad));
      state.autoDeny = ad.entries.map((e) => `${e.symbol} until ${new Date(e.until).toISOString().slice(11, 16)}Z`);
    } catch {}
  } catch {}
  // Van Tharp Model 17 — risk tier follows demonstrated SQN, never leads
  // it. priorSqnR is last cycle's persisted position-level SQN: unproven
  // records (n<15 instrumented epochs) or poor quality (<1.6) get the
  // minimum tier; quality earns size. SENTINEL_MAX_RISK_PCT is the
  // absolute ceiling — tiers only ever scale DOWN from it.
  const sqnPrev = state.priorSqnR;
  const sqnN = +(sqnPrev && sqnPrev.n) || 0, sqnV = sqnPrev && sqnPrev.sqn;
  const RISK_CAP_PCT = Math.min(
    +(process.env.SENTINEL_MAX_RISK_PCT || 0.12),
    sqnN < 15 || sqnV == null ? +(process.env.SENTINEL_RISK_TIER_MIN || 0.05)
      : sqnV < 1.6 ? 0.05
      : sqnV < 2.5 ? 0.08
      : +(process.env.SENTINEL_MAX_RISK_PCT || 0.12));
  const entriesBlocked =
    cmdOverride ? null // operator override — deploy regardless; still logged below
    : cmdHalt ? `operator halt — ${cmdHalt.reason || 'manual'} (telegram ${cmdHalt.at || ''})`
    : realDdPct >= DD_KILL ? `kill-switch (real equity dd ${state.ddPct}% >= ${DD_KILL}%)`
    : dd24 >= DAILY_HALT ? `daily-loss halt (equity -${state.dd24Pct}% in rolling 24h >= ${DAILY_HALT}%)`
    // Buffett rule #1 enforced mechanically: below the survival floor the
    // account can't post margin for even two contract-min positions —
    // every further entry is just donating fees. Preserve the last chip.
    : equityUsd < MIN_TRADE_EQUITY ? `equity floor ($${round(equityUsd,2)} < $${MIN_TRADE_EQUITY} — capital preservation, entries halted)`
    : dayDDpct >= MASSACRE_DD_PCT ? `massacre-governor (session dd ${state.dayDDPct}% >= ${MASSACRE_DD_PCT}% — deployment frozen, protection lives)`
    : cbReason; // account-level breakers join the same rail — entries only, never exits
  if (cmdOverride) {
    const rail = cmdHalt || (realDdPct >= DD_KILL ? `dd ${state.ddPct}%` : null) || (dd24 >= DAILY_HALT ? `dd24 ${state.dd24Pct}%` : null) || cbReason;
    state.actions.push(`⚠️ OVERRIDE active until ${new Date(+cmdOverride.until).toISOString().slice(11, 19)}Z — entries forced past ${rail || 'breakers'}`);
  }

  // published risk rails — the machine-readable answer to "where are the
  // kill-switches / position limits / disconnect handling" — rendered on
  // the dashboard and exported with the ledger.
  state.risk = {
    riskProfile: RISK_MAX ? 'max' : 'default',
    riskMultiplier: +(riskMulOverride ?? (process.env.SENTINEL_RISK_MUL || (RISK_MAX ? 3 : 1))),
    sizingUsd: TARGET_POSITIONS > 0
      ? `all free margin / ${TARGET_POSITIONS} target slots (~${round(100 / TARGET_POSITIONS, 1)}% equity each) × risk multiplier`
      : 'deployment frozen — 0 target slots',
    maxPositions: MAX_POSITIONS,
    leverageRule: 'contract maxLever, bounded so the stop stays inside the liq band: lev <= 80/(stopPct+0.64); carry/mandate orders floored at SENTINEL_MIN_LEV (20) when the band holds it',
    killSwitchPct: DD_KILL,
    dailyHaltPct: DAILY_HALT,
    riskCapPct: RISK_CAP_PCT, // Model 17 tier — scaled by prior cycle's position SQN
    sqnTier: { n: sqnN, sqn: sqnV ?? null },
    ddPct: state.ddPct,
    dd24Pct: state.dd24Pct,
    protectionRule: 'exactly one TP + one SL per position; orphan positions get protection synthesized; entry emergency-closes if protection placement fails — never naked',
    rebalanceRule: 'a position holding > slot margin gets partially closed to free balance for other slots',
    disconnectRule: 'TP/SL are exchange-side plan orders — a VPS/network outage cannot leave a position unprotected',
    deniedSymbols: [...DENY_SYMS],
    manualHold: [...MANUAL],
    depositsUsd: state.depositsUsd ?? 0,
    relaxGates: process.env.SENTINEL_GATES_RELAX === '1',
    circuitBreakers: state.circuitBreakers || null,
  };

  // ---- margin rebalance: a single position may not hold more margin than
  // the per-position cap. Slot-share trimming (equity/TARGET_POSITIONS)
  // fought the entry sizer — it deployed at the 85% cap, then rebalance
  // burned a reduce-fee cutting it to 24% AND orphaned the plan sizes
  // (the drift that left the stop oversized and unfireable). The cap IS
  // the sizing mandate; rebalance only enforces it.
  const slotMargin = equityUsd * +(process.env.SENTINEL_POS_CAP_PCT || 0.85);
  for (const p of posBySym.values()) {
    if (MANUAL.has(p.symbol) || foreign(p.symbol)) continue;
    try {
      const levNow = Math.max(1, p.lev || 1);
      const marginEst = (p.size * p.entry) / levNow;
      const excess = marginEst - slotMargin;
      if (excess <= Math.max(0.5, slotMargin * 0.15)) continue;
      const c = cm[p.symbol];
      if (!c) { state.errors.push(`${p.symbol}: no contract meta — cannot rebalance`); continue; }
      const prec = Math.pow(10, c.sizePlace);
      const closeSize = Math.floor(((excess * levNow) / p.entry) * prec) / prec;
      const remain = p.size - closeSize;
      const minSz = Math.max(c.minTradeNum, c.minTradeUSDT / p.entry);
      if (closeSize < minSz) continue;
      if (remain > 0 && remain < minSz) {
        // remainder dust — close the whole slot instead of leaving an
        // un-closeable stub
        await closePosition(p.symbol, p.side);
        state.actions.push(`⚖️ rebalanced ${p.symbol}: closed fully (remainder under min ${minSz})`);
      } else {
        // full-close endpoints ignore `size` (whole-side only — a 'partial'
        // call flattened a live position). True partial = market close order;
        // the adapter resolves the reduceOnly/hedge-side convention itself.
        await marketOrder(p.symbol, p.side === 'long' ? 'sell' : 'buy', closeSize, 'close',
          { marginMode: p.marginMode === 'crossed' ? 'crossed' : 'isolated' });
        state.actions.push(`⚖️ rebalanced ${p.symbol}: closed ${closeSize}/${p.size} — margin ~$${round(marginEst, 2)} -> slot ~$${round(slotMargin, 2)}`);
        p.size -= closeSize;
        p.marginFreed = (closeSize * p.entry) / levNow;
        marginFree += p.marginFreed;
      }
    } catch (e) {
      state.errors.push(`rebalance ${p.symbol}: ${e.message}`);
    }
  }

  // ---- thesis-decay exit: prospective eval shows direction accuracy
  // decays 62%@1h -> 48%@24h — a position still underwater DECAY_HOURS in
  // has a dead thesis. Closing it converts an expected -1R stop-out into a
  // smaller realized loss AND frees margin for fresher signals. This is
  // not a trailing stop: TP/SL plans stay exactly as placed on every
  // position that hasn't gone stale.
  const DECAY_MS = (+(process.env.EXEC_DECAY_HOURS || 5)) * 3600e3;
  for (const p of posBySym.values()) {
    if (MANUAL.has(p.symbol) || foreign(p.symbol)) continue;
    try {
      if (!p.cTime) continue;
      const ageMs = Date.now() - p.cTime;
      if (ageMs < DECAY_MS) continue;
      const notionalUsd = p.size * p.entry;
      const pnlPct = notionalUsd > 0 ? (p.upl / notionalUsd) * 100 : 0;
      if (pnlPct >= 0) continue; // profitable = thesis working, leave it
      if (!EARLY_CUTS) {
        // exit mandate: positions close via exchange TP/SL or manual flatten
        // only. Report the stale thesis for audit — don't spend a taker fee.
        state.actions.push(
          `decay-note ${p.symbol}: age ${(ageMs / 36e5).toFixed(1)}h uPnL ${round(pnlPct, 2)}% — stale thesis, riding stop (early cuts disabled)`
        );
        continue;
      }
      await closePosition(p.symbol, p.side);
      state.actions.push(
        `decay-exit ${p.symbol}: age ${(ageMs / 36e5).toFixed(1)}h uPnL ${round(pnlPct, 2)}% — thesis stale, margin recycled`
      );
      posBySym.delete(p.symbol);
    } catch (e) {
      state.errors.push(`decay-exit ${p.symbol}: ${e.message}`);
    }
  }

  // ---- thesis-flip exit: if the freshest scan emitted a graded liquidity
  // sweep or SFP AGAINST an open position's direction, the thesis is dead —
  // exit now rather than donating the full stop distance. The scanner emits
  // plan.thesisFlips from its signal set regardless of the order gates.
  // Minimum age: a position younger than this is still within the entry
  // candle's noise — signal whipsaw between scans is not thesis death.
  const FLIP_MIN_AGE_MS = (+(process.env.EXEC_FLIP_MIN_MIN || 15)) * 60e3;
  try {
    const flips = new Map(
      (plan.thesisFlips || []).map((f) => [f.symbol, f.direction])
    );
    for (const p of posBySym.values()) {
      if (MANUAL.has(p.symbol) || foreign(p.symbol)) continue;
      const flip = flips.get(p.symbol);
      const posDir = p.side === 'long' ? 'LONG' : 'SHORT';
      if (!flip || flip === posDir) continue;
      // Young positions are managed by their stop — a flip signal that
      // whipsaws within minutes is noise, not thesis death. Only an
      // opposing signal against a mature position counts as a flip.
      if (Date.now() - Number(p.cTime) < FLIP_MIN_AGE_MS) continue;
      if (!EARLY_CUTS) {
        // same mandate — a flip signal can veto the THESIS, not spend a
        // taker fee cutting a position whose stop already bounds the loss
        state.actions.push(`🔀 flip-note ${p.symbol}: fresh ${flip} vs open ${posDir} — riding stop (early cuts disabled)`);
        continue;
      }
      await closePosition(p.symbol, p.side);
      state.actions.push(
        `thesis-flip ${p.symbol}: fresh ${flip} signal vs open ${posDir} — exited before stop`
      );
      posBySym.delete(p.symbol);
    }
  } catch (e) {
    state.errors.push(`thesis-flip: ${e.message}`);
  }

  // ---- loss-streak cooldown: a symbol whose last two closed trades were
  // losers goes on a 6h entry timeout — repeated bleed on one name is a
  // signal the engine's model of that market is wrong right now.
  const cooledSym = new Set();
  try {
    const fj = loadFills();
    const bySym = {};
    for (const f of fj) {
      if (!(f.tradeSide === 'close' || (f.profit || 0) !== 0)) continue;
      // a close within ±0.1% of notional is a scratch (fee drag on a
      // near-breakeven exit — e.g. an emergency close after a protection
      // placement failure), not a market verdict. Neither a loser nor a
      // streak-breaker: it carries no information about direction, so it
      // must not arm — or reset — the loss-streak cooldown.
      const notional = (+f.price || 0) * (+f.size || 0);
      if (notional > 0 && Math.abs(f.profit || 0) <= 0.001 * notional) continue;
      (bySym[f.symbol] = bySym[f.symbol] || []).push(f);
    }
    for (const [s, arr] of Object.entries(bySym)) {
      const last2 = arr.slice(0, 2);
      if (
        last2.length === 2 &&
        last2.every((x) => (x.profit || 0) < 0) &&
        Date.now() - last2[0].ts < 6 * 3600e3
      )
        cooledSym.add(s);
    }
  } catch {}

  // ---- universal re-entry cooldown + daily fee-burn governor ----
  // ANY close on a symbol benches re-entry for the cooldown window — the
  // churn autopsy showed open->close->open loops at 15-90s spacing; a flat
  // cooldown makes that loop structurally impossible regardless of which
  // layer emitted the closes.
  const REENTRY_MS = +(process.env.SENTINEL_REENTRY_COOLDOWN_MS || 60 * 60e3);
  const lastCloseBySym = {};
  const lastLossCloseBySym = {}; // losing closes only — gates top-up re-adds
  let feesToday = 0;
  try {
    const fj = loadFills();
    const dayStart = new Date().setUTCHours(0, 0, 0, 0);
    for (const f of fj) {
      if (f.tradeSide === 'close') {
        lastCloseBySym[f.symbol] = Math.max(lastCloseBySym[f.symbol] || 0, +f.ts || 0);
        if ((f.profit || 0) < 0)
          lastLossCloseBySym[f.symbol] = Math.max(lastLossCloseBySym[f.symbol] || 0, +f.ts || 0);
      }
      if (+f.ts >= dayStart) feesToday += +f.fee || 0;
    }
  } catch {}
  // fee-burn halt: commissions >5% of equity in a day stands the book
  // down — a fee-churn day is always a regime the engine can't read, and
  // the only winning move is to stop paying.
  // NOTE: percent units, distinct env from the breaker's SENTINEL_FEE_HALT_PCT
  // (that one is also a percent but gates 24h burn at a different threshold)
  const FEE_DAY_HALT_PCT = +(process.env.SENTINEL_FEE_DAY_HALT_PCT || 5);
  const feeHalted = equityUsd > 0 && feesToday >= equityUsd * FEE_DAY_HALT_PCT / 100;

  // ---- regime-chop gate: trailing-4h closes running negative net means the
  // tape is unreadable for this engine right now — stand new entries down
  // until the window clears, instead of feeding it fees. Core-carry margin
  // deployment is exempt (it's not a swing trade).
  const REGIME_MIN_CLOSES = +(process.env.SENTINEL_REGIME_MIN_CLOSES || 6);
  const REGIME_WINDOW_MS = +(process.env.SENTINEL_REGIME_WINDOW_MS || 4 * 3600e3);
  let regimeNet = 0, regimeCloses = 0;
  try {
    const fj4 = loadFills();
    for (const f of fj4) {
      if (Date.now() - (+f.ts || 0) > REGIME_WINDOW_MS) continue;
      if (f.tradeSide === 'close') { regimeCloses++; regimeNet += (f.profit || 0) - (f.fee || 0); }
    }
  } catch {}
  const regimeChop = +(process.env.SENTINEL_REGIME_GATE || 1) && regimeCloses >= REGIME_MIN_CLOSES && regimeNet < 0;
  if (regimeChop) state.actions.push(`🌊 regime-chop armed — ${regimeCloses} closes net ${round(regimeNet, 2)} in ${Math.round(REGIME_WINDOW_MS / 3600e3)}h — new entries standing down`);

  // ---- correlation cluster cap: corr>=0.6 in the same direction is ONE
  // bet. correlation.json's own contract — nothing enforced it until now.
  const CORR_MIN = +(process.env.SENTINEL_CORR_MIN || 0.6);
  const corrMap = {};
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'correlation.json'), 'utf8'));
    const A = cj.boardAssets || [], Mx = cj.boardMatrix || [];
    A.forEach((a, i) => A.forEach((b, j) => {
      if (i !== j && Math.abs(+(Mx[i]?.[j] || 0)) >= CORR_MIN) (corrMap[a + 'USDT'] ||= {})[b + 'USDT'] = +Mx[i][j];
    }));
  } catch {}

  // ---- funding hostility: positive rate => longs pay shorts. An entry that
  // pays funding every 8h starts life bleeding — veto past the threshold.
  const FUND_VETO = +(process.env.SENTINEL_FUNDING_VETO_PCT || 0.03);
  const fundMap = {};
  try {
    const fj2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'funding.json'), 'utf8'));
    for (const r of fj2.rows || fj2.best || []) if (r.asset && Number.isFinite(+r.ratePct)) fundMap[r.asset + 'USDT'] = +r.ratePct;
  } catch {}

  // ---- entry rate cap — rolling 1h window, not a calendar cliff: a scalp
  // regime turns positions over fast, so the guard limits RATE not daily
  // total. Max 3 new entries per rolling hour stops fee-churn sprays while
  // the book never sits dead waiting for a window to drain.
  const windowStart = Date.now() - 3600e3;
  let entriesThisHour = 0;
  let entriesThisDay = 0;
  try {
    const fj = loadFills();
    for (const f of fj)
      // opens only — a scratch close (profit 0, tradeSide missing) must not
      // eat the rate budget the same way a real entry does. Attribution fix:
      // MANUAL opens (ios/web — src set and not 'api') must not starve the
      // bot's entry budget either; they never paid the engine's planning toll
      if ((f.tradeSide === 'open' || (f.tradeSide == null && (f.profit || 0) === 0)) && f.ts >= windowStart &&
          (!f.src || f.src === 'api'))
        entriesThisHour++;
    // journaled fills lag live opens by up to ~30s; the local attempt log
    // (persisted via ledger) sees them immediately — take the higher count
    entriesThisHour = Math.max(
      entriesThisHour,
      (state.entriesLog || []).filter((e) => Date.now() - (e.ts ?? e) < 3600e3).length
    );
    entriesThisDay = Math.max(
      entriesThisDay,
      (state.entriesLog || []).filter((e) => Date.now() - (e.ts ?? e) < 24 * 3600e3).length
    );
  } catch {}
  // EXEC_MAX_ENTRIES_DAY now means what it says — the old wiring let 'day'
  // act as the HOURLY cap: 99 opens in 38h on a $65 book.
  const MAX_ENTRIES_HOUR = +(process.env.EXEC_MAX_ENTRIES_HOUR || 3);
  // 0/unset-able: operator mandate removes the daily ceiling entirely —
  // a negative or zero value disables the day-count check.
  const MAX_ENTRIES_DAY = +(process.env.EXEC_MAX_ENTRIES_DAY || 8);

  // ---- protection repair: EVERY open position must carry a loss plan AND
  // a staggered take-profit ladder — never a single take-profit level.
  // Orphaned/manual positions get synthesized protection: stop distance is
  // inferred from an existing loss plan, else 1.2%; the TP ladder anchors
  // at 2R of that distance.
  // Staggered TP tranches — the mandate: EVERY position (managed, manual,
  // foreign, hedged) banks in levels, never one take-profit. 40% at 0.55x
  // of the position's target distance, 30% at 1.0x, 15% at 1.8x; the last
  // ~15% stays unplanned as the moon bag riding the stop. baseDistPct is
  // the position's TP distance: the signal target on managed entries, the
  // trader's own trigger distance on a retrofit, 2R when synthesized.
  // Returns legs placed; 0 = too small to split, caller falls back to one
  // full-size pos_profit.
  const placeTpLadder = async (p, baseDistPct) => {
    const sgn = p.side === 'long' ? 1 : -1;
    const sp = Math.pow(10, cm[p.symbol]?.sizePlace ?? 4);
    const pp = cm[p.symbol]?.pricePlace ?? 6;
    // cumulative-difference allocation — tranche_i = floor(size*cum[i+1]) -
    // floor(size*cum[i]): rounding residue lands in the moon bag, not lost
    const cum = RR_CUM;
    const mults = RR.mults;
    const legs = [];
    for (let i = 0; i < mults.length; i++) {
      const tsize =
        (Math.floor(p.size * cum[i + 1] * sp) - Math.floor(p.size * cum[i] * sp)) / sp;
      if (tsize > 0 && tsize * p.entry >= MIN_TRANCHE_USD)
        legs.push({
          tsize,
          px: round(p.entry * (1 + (sgn * baseDistPct * mults[i]) / 100), pp),
        });
    }
    if (legs.length < 2) return 0;
    for (const l of legs)
      await planOrder(p.symbol, 'profit_plan', l.px, String(l.tsize), p.side, p.marginMode);
    return legs.length;
  };
  // rebuildProfitCover — cancel ONLY the profit legs (the stop stays armed
  // throughout the swap) and re-cover at LIVE size. Manual/foreign
  // positions keep their own trigger prices re-split across the live size
  // — sizes get fixed, targets never move; engine positions get a fresh
  // band ladder. Whole-position pos_profit is the fallback whenever the
  // tranches can't meet contract minimums. Cancel-first is forced anyway:
  // pending plan qty counts against the position, so placing beside stale
  // legs just 43023-blocks.
  const rebuildProfitCover = async (p, keepTrigs, bandPct) => {
    await cancelByType(p.symbol, (x) => /profit/i.test(x.planType || ''));
    const sgn = p.side === 'long' ? 1 : -1;
    const pp = cm[p.symbol]?.pricePlace ?? 6;
    const spx = Math.pow(10, cm[p.symbol]?.sizePlace ?? 4);
    if (keepTrigs.length) {
      let prev = 0, placed = 0;
      for (let i = 0; i < keepTrigs.length; i++) {
        const cum = Math.floor(((p.size * 0.85 * (i + 1)) / keepTrigs.length) * spx) / spx;
        const ts = +(cum - prev).toFixed(8); prev = cum;
        if (ts > 0 && ts * p.entry >= MIN_TRANCHE_USD) {
          await planOrder(p.symbol, 'profit_plan', keepTrigs[i], String(ts), p.side, p.marginMode);
          placed++;
        }
      }
      if (placed) return;
      await planOrder(p.symbol, 'pos_profit', keepTrigs[0], '0', p.side, p.marginMode);
      return;
    }
    const placed = await placeTpLadder(p, bandPct);
    if (placed < 2)
      await planOrder(p.symbol, 'pos_profit',
        round(p.entry * (1 + (sgn * bandPct) / 100), pp), '0', p.side, p.marginMode);
  };
  // Prefetch all pending plans in parallel — a serial await-per-symbol made
  // each position pay a full round-trip inside the loop (~200ms × N symbols).
  const planCache = new Map();
  await Promise.all(
    [...posBySym.keys(), ...ambiguous].map(async (sym) =>
      planCache.set(sym, await getPlans(sym).catch(() => []))
    )
  );
  const plansOf = (sym) => planCache.get(sym) || [];
  // resting limit TP legs — bitget-watch owns the steady-state ladder as
  // post-only limits (maker fills; trigger profit_plans were measured
  // paying 0.06% taker on every close). vtp-* clientOid tags them; they
  // count as profit cover everywhere a profit plan would below.
  const pendCache = new Map();
  await Promise.all(
    [...posBySym.keys(), ...ambiguous].map(async (sym) =>
      pendCache.set(sym, await pendingOrders(sym).catch(() => []))
    )
  );
  const tpLimsOf = (sym) =>
    (pendCache.get(sym) || []).filter((o) => /^vtp-/.test(String(o.clientOid || '')));
  // ---- orphan-plan sweep: triggers left live on a symbol that went flat
  // (emergency close, stop fill, manual close between cycles) either
  // trigger-reject forever or — worse — fire a close-side order into a
  // NEW unrelated position on that symbol. Cancel them.
  for (const sym of priorPlanSyms) {
    if (posBySym.has(sym) || ambiguous.has(sym) || MANUAL.has(sym)) continue;
    try {
      const stale = await getPlans(sym).catch(() => []);
      if (stale.length) {
        await cancelPlans(sym);
        state.actions.push(`🧹 swept ${stale.length} orphan plan(s) on flat ${sym}`);
      }
    } catch (e) {
      state.errors.push(`orphan-sweep ${sym}: ${e.message}`);
    }
  }
  for (const p of posBySym.values()) {
    try {
      // foreign positions (app/exchange/manual opens) get the same hands-off
      // treatment as MANUAL_HOLD: armed with synthesized protection, but no
      // ratchets, time-cuts, or scanner-driven exits — the staggered TP
      // ladder still applies (mandate: every position banks in levels).
      // The user's trade is the user's trade — the engine guards it, it
      // doesn't manage it.
      const manualHold = MANUAL.has(p.symbol) || foreign(p.symbol);
      const existing = plansOf(p.symbol);
      // 'moving_plan' (trailing stop) IS loss protection — without it in the
      // regex the repair loop would stack a second stop on a trailed position
      const lossPlan = existing.find((x) => /loss|stop|moving/i.test(x.planType || ''));
      const profitPlan = existing.find((x) => /profit/i.test(x.planType || ''));
      const limLegs = tpLimsOf(p.symbol); // resting maker TP legs = profit cover
      curLegMap[p.symbol] = limLegs.map((o) => +o.price).filter((t) => t > 0);
      const hasProfit = !!profitPlan || limLegs.length > 0;
      // ---- structural de-risk: worst-case loss at the live stop must fit
      // the book. A position whose stop-out would wound the account beyond
      // POS_DERISK_CAP gets trimmed to budget before the market collects —
      // the CLU autopsy: pyramids stacked entry onto the stop, one −0.5%
      // dip realised −$24 on a ~$50 book. Explicit MANUAL holds exempt.
      if (lossPlan && p.size > 0 && !MANUAL.has(p.symbol)
          && Date.now() - (trimGuard[p.symbol] || 0) > POS_DERISK_GAP_MS) {
        const slPx = +lossPlan.triggerPrice || 0;
        const dist = Math.abs(p.entry - slPx);
        if (slPx > 0 && dist > 0) {
          const lossAtStop = dist * p.size; // USDT-M linear: |Δpx| × contracts
          const capUsd = equityUsd * POS_DERISK_CAP_PCT;
          if (lossAtStop > capUsd) {
            const keepUsd = equityUsd * POS_DERISK_TARGET_PCT;
            const keepSize = keepUsd / dist;
            const c = cm[p.symbol] || {};
            const sp = Math.pow(10, c.sizePlace ?? 3);
            const trimQty = Math.floor((p.size - keepSize) * sp) / sp;
            const minSz = Math.max(+c.minTradeNum || 0, (+c.minTradeUSDT || 0) / Math.max(1e-9, p.entry));
            if (trimQty >= minSz && trimQty < p.size * 0.999) {
              try {
                await marketOrder(p.symbol, p.side === 'long' ? 'sell' : 'buy', String(trimQty), 'close');
                trimGuard[p.symbol] = Date.now();
                state.actions.push(`🛡 de-risk ${p.symbol}: worst-case $${round(lossAtStop, 2)} at stop ${slPx} > ${POS_DERISK_CAP_PCT * 100}% equity — trimmed ${trimQty}, keeps ~$${round(keepUsd, 2)} at stop`);
              } catch (e) { state.errors.push(`de-risk ${p.symbol}: ${e.message.slice(0, 100)}`); }
            } else if (lossAtStop > equityUsd * 0.6) {
              // too small to partially trim but worst-case is existential —
              // a >60%-of-book loss at stop is a defect, not a position
              try {
                await closePosition(p.symbol, p.holdSide || p.side);
                trimGuard[p.symbol] = Date.now();
                state.actions.push(`🛡 de-risk ${p.symbol}: worst-case $${round(lossAtStop, 2)} = ${round(lossAtStop / equityUsd * 100, 0)}% of book, below min-trim — closed`);
                continue;
              } catch (e) { state.errors.push(`de-risk-close ${p.symbol}: ${e.message.slice(0, 100)}`); }
            }
          }
        }
      }
      // manual-hold with an operator stop = zero reconcile. The drift
      // teardown and resync paths re-pin operator stops to band width and
      // re-split legs every cycle (observed live) — for scalps that
      // widens the very invalidation the entry was sized around. Requiring
      // profit legs too created a race: every swap window let the teardown
      // fire and re-ladder at exec targets. The stop is the nakedness
      // floor; profit geometry is the operator's call (liq-guard
      // synthesizes a stop if the book ever goes fully naked).
      if (manualHold && lossPlan) continue;
      // stall-exit — the excursion record shows losers telegraph early:
      // median adverse run ~1.3% vs median favorable ~0.33%. A managed
      // position still red past STALL_MIN that never showed STALL_MFE
      // favor is statistically a bleeder — close it for the small loss
      // instead of donating the full stop distance. Manual positions are
      // never touched.
      if (!manualHold && managed.has(p.symbol) && +p.cTime > 0 && Date.now() - p.cTime > STALL_MIN_MS) {
        const tr = maeTrack[`${p.symbol}:${p.side}`];
        const peakGain = tr && tr.entry > 0
          ? (p.side === 'long' ? (tr.peak - tr.entry) / tr.entry : (tr.entry - tr.trough) / tr.entry) * 100
          : null;
        if ((peakGain == null || peakGain < STALL_MFE_PCT) && (p.upl || 0) < 0) {
          try {
            await closePosition(p.symbol, p.side);
            state.actions.push(`✂️ stall-exit ${p.symbol} ${p.side}: ${Math.round((Date.now() - p.cTime) / 6e4)}m old, peak favor ${peakGain == null ? 'untracked' : round(peakGain, 2) + '%'}, upl ${round(p.upl, 2)} — closed before the stop`);
            continue;
          } catch (e) {
            state.errors.push(`${p.symbol} stall-exit failed: ${String(e).slice(0, 100)}`);
          }
        }
      }
      // breakeven ratchet — "no one went broke taking profit": with the TP
      // ladder live, progress is measured against the NEAREST profit
      // trigger, so the tranche-1 fill (0.55x target) is the ratchet point.
      // After TP1 banks, the stop moves to entry + ~0.2% (covers round-trip
      // fees) — tranches 2-3 are then free runners: worst case scratch,
      // upside runs to 1.8x target. Legacy single-TP positions ratchet at
      // ~90% to their only target.
      const profitPlans = existing.filter((x) => /profit/i.test(x.planType || ''));
      // plan-size drift: after a rebalance or TP-tranche bank the pending
      // plans still quote the OLD size — and Bitget counts CUMULATIVE
      // pending plan qty against the position, so any oversized leftover
      // 43023-blocks every new placement (observed live: 0.55 of plans on
      // a 0.09 position). Only a full teardown rebuilds capacity: cancel
      // every pending plan, then re-place whole-position protection
      // (pos_loss/pos_profit omit size = cover all). The retrofit ladder
      // re-splits the TP next cycle.
      const sp = Math.pow(10, cm[p.symbol]?.sizePlace ?? 4);
      const sizeStr = String(Math.floor(p.size * sp) / sp);
      // Bitget counts CUMULATIVE pending plan qty against the position, so
      // the drift guard sums every sized leg. Bybit reduce-only conditionals
      // don't reserve position qty — there the defect is only a stop quoting
      // more than the live book (stale oversized leg). Counting profit legs
      // into the budget made a full-size stop + a partial TP ladder read as
      // permanent drift (1.12 vs 0.8) and resynced every cycle forever.
      const lossQty = existing
        .filter((x) => /loss|stop|moving/i.test(x.planType || ''))
        .reduce((a, x) => a + (+x.size || 0), 0);
      const profitQty = existing
        .filter((x) => /profit/i.test(x.planType || ''))
        .reduce((a, x) => a + (+x.size || 0), 0);
      // resting vtp- TP limits reserve close-qty against the position the
      // same way sized plans do — leave them out of the budget and a
      // trigger-leg + limit-leg coexistence window could read 1.7x and
      // resync forever.
      const limQty = limLegs.reduce((a, o) => a + (+o.size || 0), 0);
      // On Bybit only the LOSS side can over-cover — TP legs are a sized
      // subset of the same position (reduce-only, capped at fill), so a
      // full-size stop + a partial ladder is a valid 1.12-quoted book, not
      // drift. Summing them resynced every cycle forever.
      const planQty = X.name === 'bitget' ? lossQty + profitQty + limQty : lossQty;
      // THE DRIFT SWAP IS BITGET-ONLY MACHINERY. It exists to unwind
      // Bitget's cumulative pending-qty 43023 deadlock. On Bybit it can
      // only do damage: conditional rows + mirrors double-count (lossQty
      // reads 2x), `covered` is satisfied by a pos_loss mirror OF the very
      // order being canceled, and the swap deletes the real StopLoss then
      // `continue`s — leaving the position NAKED and starving the ladder
      // retrofit / ratchet / band-repair below (all observed live on
      // HYPE/ZEC). Bybit protection is maintained by the band-recheck and
      // repair paths further down instead.
      const planDrift = X.name === 'bitget' &&
        p.size > 0 &&
        (planQty > p.size * 1.001 ||
          (lossPlan &&
            /loss_plan|moving_plan/i.test(lossPlan.planType || '') &&
            Number.isFinite(+lossPlan.size) && +lossPlan.size >= p.size * 0.999));
      if (planDrift) {
        let trig = lossPlan && +lossPlan.triggerPrice > 0 ? +lossPlan.triggerPrice : null;
        const sgn = p.side === 'long' ? 1 : -1;
        const pp0 = cm[p.symbol]?.pricePlace ?? 6;
        let stopPct = trig ? (Math.abs(p.entry - trig) / p.entry) * 100 : 0;
        // a drifted stop parked past the liquidation band protects nothing —
        // the rebuild must clamp it inside the band, not re-place the defect
        const liqPct = p.liq > 0 ? (Math.abs(p.entry - p.liq) / p.entry) * 100 : 0;
        if (!stopPct) stopPct = Math.max(1.2, Math.min(liqPct * 0.7, 5)); // mandate: band room, not a fixed tight stop
        if (liqPct > 0 && stopPct >= liqPct * 0.8) {
          stopPct = Math.max(liqPct * 0.75, 0.05);
          trig = round(p.entry * (1 - (sgn * stopPct) / 100), pp0);
        }
        try {
          // never-naked rebuild: the stop stays armed while profit cover
          // swaps — sized profit legs die first (their pending qty was what
          // blocked new placements), then re-cover at LIVE size in the same
          // breath. Manual positions keep their own trigger prices.
          const keepTrigs = (manualHold || setupArms[p.symbol])
            ? [...profitPlans.map((x) => +x.triggerPrice), ...limLegs.map((o) => +o.price)]
                .filter((t) => t > 0)
                .sort((a, b) => (sgn === 1 ? a - b : b - a))
            : [];
          await rebuildProfitCover(p, keepTrigs, 2 * stopPct);
          // a sized loss_plan/moving_plan quoting more than the live size
          // swaps into a whole-position pos_loss — place-first so the book
          // is never uncovered on the downside; only on an exchange refusal
          // (qty-cap reject) does it fall back to cancel-then-place.
          // a sized loss_plan at >= live size covers the whole book but
          // still counts its qty in planQty — which keeps planDrift true
          // every cycle, resyncing forever and starving the ratchet below.
          // Whole-cover sized stops get swapped into the size-0 pos_loss
          // form (the canonical "protect everything, count nothing" leg).
          const sizedLoss = lossPlan &&
            /loss_plan|moving_plan/i.test(lossPlan.planType || '') &&
            Number.isFinite(+lossPlan.size) && +lossPlan.size >= p.size * 0.999;
          if (!lossPlan || sizedLoss) {
            const newTrig = trig || round(p.entry * (1 - (sgn * stopPct) / 100), pp0);
            // if a whole-position stop already covers this trigger, the only
            // defect is the redundant sized leg — cancel it and skip the
            // place entirely. Re-placing gets '34040 not modified' forever
            // (observed: ZEC pos_loss at the same trigger refused every cycle).
            const covered = sizedLoss && existing.some((x) =>
              x.planType === 'pos_loss' &&
              Math.abs(+x.triggerPrice - newTrig) <= p.entry * 0.0005);
            let placed = covered;
            if (!covered)
              try {
                await planWithRetry(() =>
                  planOrder(p.symbol, 'pos_loss', newTrig, '0', p.side, p.marginMode));
                placed = true;
              } catch (e) {
                if (!sizedLoss) throw e;
                state.errors.push(`resync ${p.symbol}: second pos_loss refused (${e.message}) — swapping stale leg`);
              }
            if (sizedLoss) {
              const id = lossPlan.orderId || lossPlan.planId || lossPlan.id;
              await cancelPlanOrders(p.symbol, lossPlan.planType, [String(id)]).catch(() => {});
              if (!placed)
                await planWithRetry(() =>
                  planOrder(p.symbol, 'pos_loss', newTrig, '0', p.side, p.marginMode));
            }
          }
          state.actions.push(
            `🔄 resynced ${p.symbol}: rebuilt protection at live size (pending ${round(planQty, 4)} vs size ${p.size})`
          );
        } catch (e) {
          state.errors.push(`resync ${p.symbol}: ${e.message}`);
        }
        continue;
      }
      // under-laddered: manual adds or top-ups grew the position after the
      // ladder was built — the size-zero pos_loss tracks live size, but
      // sized profit legs stay small and the added size banks nothing.
      // Legs banked by the ladder's OWN progression look identical to
      // under-coverage, so compare the biggest leg (the 40% tranche) to
      // the live size: implied build-size = leg/0.40. Only rebuild when
      // the position genuinely outgrew its ladder — and never when the
      // mark is already through the ladder zone, where entry-priced legs
      // would sit below mark and instant-close the runner.
      const wholeProfit = profitPlans.some((x) => !(+x.size > 0)); // size-0 leg covers all
      const bigLeg = Math.max(0, ...profitPlans.map((x) => +x.size || 0), ...limLegs.map((o) => +o.size || 0));
      const impliedSize = bigLeg / RR_MAX_ALLOC;
      const sgn2 = p.side === 'long' ? 1 : -1;
      const markPx = p.entry + (sgn2 * p.upl) / p.size;
      const stopD = lossPlan && +lossPlan.triggerPrice > 0
        ? (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100
        : Math.max(1.2, Math.min((p.liq > 0 ? (Math.abs(p.entry - p.liq) / p.entry) * 100 : 3) * 0.7, 5));
      const legFloor = p.entry * (1 + (sgn2 * 2 * RR.mults[0] * stopD) / 100); // 2x TP1-mult band
      const runner = sgn2 === 1 ? markPx >= legFloor : markPx <= legFloor;
      if (!wholeProfit && bigLeg > 0 && impliedSize < p.size * 0.8 && !runner) {
        try {
          const keepTrigs = (manualHold || setupArms[p.symbol])
            ? [...profitPlans.map((x) => +x.triggerPrice), ...limLegs.map((o) => +o.price)]
                .filter((t) => t > 0)
                .sort((a, b) => (sgn2 === 1 ? a - b : b - a))
            : [];
          await rebuildProfitCover(p, keepTrigs, 2 * stopD);
          state.actions.push(`🔄 reladdered ${p.symbol}: legs sized for ~${round(impliedSize, 4)} -> position ${p.size}`);
        } catch (e) { state.errors.push(`reladder ${p.symbol}: ${e.message}`); }
      }
      let stopWritten = false; // a fresher stop write this cycle beats stale-snapshot checks below
      if (lossPlan && p.size > 0 && !manualHold) {
        const sgn = p.side === 'long' ? 1 : -1;
        const mark = p.entry + (sgn * p.upl) / p.size; // entry + realized move
        // nearest profit trigger in the trade direction = next bank level
        const nearTp = [
            ...profitPlans.map((x) => +x.triggerPrice),
            ...limLegs.map((o) => +o.price),
          ]
          .filter((t) => t > 0 && (sgn === 1 ? t > p.entry : t < p.entry))
          .sort((a, b) => (sgn === 1 ? a - b : b - a))[0];
        const slTrig = +lossPlan.triggerPrice;
        const dist = nearTp ? Math.abs(nearTp - p.entry) : 0;
        const prog = dist > 0 ? (sgn * (mark - p.entry)) / dist : 0;
        const pp = cm[p.symbol]?.pricePlace ?? 6;
        let wantPx = null, why = null;
        if ((profitPlans.length || limLegs.length) && prog >= 0.9) {
          // ratchet tiers — the stop locks ~55% of the NEXT bank level once
          // price is within 10% of it, then keeps climbing: near TP1 the
          // stop lands at entry+0.30xT; near TP2 it locks TP1; near TP3 it
          // locks TP2. Only ever moves in the trade's favor.
          const lockPct = Math.max(0.25, 0.55 * ((dist / p.entry) * 100));
          wantPx = round(p.entry * (1 + (sgn * lockPct) / 100), pp);
          why = `ratchet ${p.symbol}: ${round(prog * 100, 0)}% to next TP — stop locked at +${round(lockPct, 2)}% (${wantPx})`;
        } else if (!profitPlans.length && !limLegs.length && sgn * (mark - p.entry) > 0) {
          // moon-bag trail — all TP tranches banked, the leftover runner has
          // no target. Trail the stop 1.0% under price every cycle: the last
          // piece rides until the move actually reverses, never a fixed cap.
          wantPx = round(mark * (1 - (sgn * 1.0) / 100), pp);
          why = `trail ${p.symbol}: stop following winner @ ${wantPx}`;
        }
        // move-lock — deep winners bank BEFORE the ladder reaches them:
        // once price has run >=1.5% in favor, floor the stop at +55% of the
        // move regardless of how far the next TP sits. The TP-progress
        // ratchet only arms near a target, so a +119% ROE short with a far
        // ladder used to ride all the way back to a -$9 stop-out. That
        // retrace-to-loser path is the expectancy leak this tier closes.
        const movePct = (sgn * (mark - p.entry)) / p.entry * 100;
        if (movePct >= 1.5) {
          const lockPct = Math.max(0.2, 0.55 * movePct);
          const cand = round(p.entry * (1 + (sgn * lockPct) / 100), pp);
          const candBetter = wantPx == null || (sgn === 1 ? cand > wantPx : cand < wantPx);
          if (candBetter) {
            wantPx = cand;
            why = `move-lock ${p.symbol}: +${round(movePct, 2)}% run — stop locked at +${round(lockPct, 2)}% (${wantPx})`;
          }
        }
        // fee-lock — the operator's standing rule mechanized: "no one went
        // broke taking profit." Trigger calibrated to the measured noise
        // band (1.5x medMAE — early-EM locks are the documented expectancy
        // killer), lock level covers fees + half the noise so a normal dip
        // doesn't scratch it. The position cannot lose once armed while
        // the ladder keeps the full upside. Higher tiers (0.9-to-TP,
        // move-lock) still override whenever they offer a better stop.
        if (movePct >= FEE_LOCK_AT) {
          const cand = round(p.entry * (1 + (sgn * FEE_LOCK_PCT) / 100), pp);
          const candBetter = wantPx == null || (sgn === 1 ? cand > wantPx : cand < wantPx);
          if (candBetter) {
            wantPx = cand;
            why = `fee-lock ${p.symbol}: +${round(movePct, 2)}% run — stop floored at entry+${FEE_LOCK_PCT}% (${wantPx})`;
          }
        }
        // banked-tranche floor — profit already taken is never handed back.
        // A TP leg on the book last cycle that is now gone with its level
        // behind the mark = that tranche FILLED. Floor the stop just under
        // the last banked level: TP1 banked ⇒ the stop lives under TP1, not
        // entry. Level must sit behind the mark — a pos_loss trigger on the
        // wrong side of price fires instantly (would market-close the trade).
        {
          const priorL = priorLegMap[p.symbol] || [];
          const tick2 = 2 * 10 ** -(pp ?? 6);
          const banked = priorL.filter(
            (t) => (sgn === 1 ? mark > t : mark < t)
              && !limLegs.some((o) => Math.abs(+o.price - t) <= tick2)
              && !profitPlans.some((x) => Math.abs(+x.triggerPrice - t) <= tick2)
          );
          if (banked.length) {
            const last = sgn === 1 ? Math.max(...banked) : Math.min(...banked);
            const cand = round(last * (1 - (sgn * 0.25) / 100), pp);
            const candBetter = wantPx == null || (sgn === 1 ? cand > wantPx : cand < wantPx);
            if (candBetter) {
              wantPx = cand;
              why = `banked-floor ${p.symbol}: TP tranche @ ${round(last, pp)} filled — stop floored under it (${wantPx})`;
            }
          }
        }
        // realized-trim lock — ANY size drop while in profit (TP leg, guard
        // trim, operator tap) lifts the stop to breakeven+fees at minimum.
        {
          const psz = priorSizeMap[p.symbol] || 0;
          if (psz > 0 && p.size < psz * 0.98 && sgn * (mark - p.entry) > 0) {
            const cand = round(p.entry * (1 + (sgn * FEE_LOCK_PCT) / 100), pp);
            const candBetter = wantPx == null || (sgn === 1 ? cand > wantPx : cand < wantPx);
            if (candBetter) {
              wantPx = cand;
              why = `trim-lock ${p.symbol}: ${round(psz, 4)}→${round(p.size, 4)} banked in profit — stop floored entry+${FEE_LOCK_PCT}% (${wantPx})`;
            }
          }
        }
        const slBetter =
          wantPx != null && slTrig > 0 &&
          (sgn === 1 ? wantPx > slTrig : wantPx < slTrig);
        if (wantPx != null && slBetter) {
          const planId = lossPlan.orderId || lossPlan.planId || lossPlan.id;
          const newSize = /pos_/.test(lossPlan.planType) ? '0' : sizeStr;
          // place-then-cancel — cancel-first leaves the position naked for
          // ~200ms every ratchet. pos_loss is a singleton slot (a new place
          // replaces the incumbent and retires its orderId), so the cleanup
          // must run off a FRESH list — cancelling by the stale id can
          // alias onto the just-placed plan and wipe the stop entirely.
          try {
            await planOrder(p.symbol, lossPlan.planType, wantPx, newSize, p.side, p.marginMode);
            const live = await getPlans(p.symbol).catch(() => []);
            for (const x of live.filter((z) =>
              /loss|stop|moving/i.test(z.planType || '') &&
              +z.triggerPrice !== +wantPx &&
              (!z.holdSide || z.holdSide === p.side)))
              await cancelPlanOrders(p.symbol, x.planType, [String(x.orderId || x.planId || x.id)]).catch(() => {});
          } catch {
            if (planId) await cancelPlanOrders(p.symbol, lossPlan.planType, [String(planId)]).catch(() => {});
            await planOrder(p.symbol, lossPlan.planType, wantPx, newSize, p.side, p.marginMode);
          }
          state.actions.push(why);
          stopWritten = true;
        }
        // verdict ladder — hours-scale to match the 1h signal horizon:
        //   216s : genuinely adverse (>0.4% on notional) -> thesis instantly
        //          wrong, cut before the chop even develops
        //   2h   : still >60% of stop depth underwater -> early loss cut
        //   4h   : still >35% of stop depth underwater -> early loss cut
        //   90m  : <35% to next TP and not green -> stall, cut
        //   4h   : <65% progress and not meaningfully green -> deadline, cut
        // Anything that clears all five is a live runner the
        // ladder/moon-bag trail manages.
        // Runner exemption: once tranches start banking, progress-to-next-TP
        // resets and a moon bag carries prog=0 — gates that only read prog
        // would murder winners. The upl guard spares anything actually green;
        // a position with NO remaining profit plans (all banked) answers to
        // the trail, not the stall clock.
        const uplPct = (p.upl / (p.size * p.entry)) * 100;
        const ageMs = p.cTime ? Date.now() - p.cTime : 0;
        const runnerMode = !profitPlans.length && !limLegs.length;
        // the 216s gate must clear the FEE-NOISE band, not any redness: a
        // 59x taker fill opens ~-0.12% red on notional instantly, so 'red
        // at all' auto-executed every chop market entry at +4min — the
        // scalp-churn loop that burned the account on fees (observed live).
        // Cut only when the move against us is genuine: >0.4% adverse on
        // notional — past halfway to a typical 0.7% stop. Anything less is
        // noise the exchange-side SL already manages.
        // Time×loss cascade (TrendRider's verified mechanic — PF 1.03→1.41,
        // maxDD −6.1%→−1.4% in their A/B): kill positions STILL deep-red
        // hours after entry. Depth thresholds scale to this position's own
        // stop distance (60% at 2h, 35% at 4h) — a 1h-candle thesis needs
        // hours to work, so progress deadlines run at hours scale, not the
        // old 15/45-minute churn window that killed developing winners.
        const slDepthPct =
          slTrig > 0 ? (Math.abs(slTrig - p.entry) / p.entry) * 100 : 0;
        const scalpDead = !EARLY_CUTS ? null
          : ageMs > 216e3 && uplPct < -0.4
            ? `red ${round(uplPct, 2)}% at ${(ageMs / 1e3).toFixed(0)}s`
            : slDepthPct > 0 && ageMs > 2 * 3600e3 && uplPct < -slDepthPct * 0.6
            ? `still ${round(uplPct, 2)}% past 60% of stop depth at 2h — early loss cut`
            : slDepthPct > 0 && ageMs > 4 * 3600e3 && uplPct < -slDepthPct * 0.35
            ? `still ${round(uplPct, 2)}% past 35% of stop depth at 4h — early loss cut`
            : !runnerMode && ageMs > 90 * 60e3 && prog < 0.35 && uplPct < 0.3
            ? `${round(prog * 100, 0)}% progress at ${(ageMs / 60e3).toFixed(0)}m`
            : !runnerMode && ageMs > 4 * 3600e3 && prog < 0.65 && uplPct < 0.8
            ? `${round(prog * 100, 0)}% progress at ${(ageMs / 60e3).toFixed(0)}m`
            : null;
        if (scalpDead) {
          await closePosition(p.symbol, p.side);
          state.actions.push(`⏱ scalp-timeout ${p.symbol}: ${scalpDead} — margin recycled`);
          posBySym.delete(p.symbol);
          continue;
        }
      }
      // retrofit: an open position still carrying ONE full-size profit plan
      // gets the staggered ladder — tranches placed BEFORE cancelling the
      // original TP so the position is never uncovered. Applies to managed,
      // manual, and foreign positions alike — the trader's own TP distance
      // is preserved as the middle rung (0.55x/1.0x/1.8x tranches). A
      // position too small to split into >=2 tranches keeps its single TP.
      // a position-level TP surfaces as profit_plan + pos_profit (same
      // trigger) — that is ONE logical TP. Counting the adapter's mirror as
      // a second leg made the `===1` test never true and positions (HYPE,
      // NEAR, SOL, ZEC) silently ran a single full-size TP forever. Dedupe
      // the mirror first, then retrofit; cancelling removes BOTH the plan
      // leg and the position-level TP (bbpos:tp id → takeProfit:0) so the
      // ladder becomes the only profit side.
      const mirrorTps = profitPlans.filter((x) => x.planType === 'pos_profit' &&
        profitPlans.some((y) => y.planType === 'profit_plan' &&
          Math.abs(+y.triggerPrice - +x.triggerPrice) < 1e-9));
      const logicalProfit = profitPlans.filter((x) => !mirrorTps.includes(x));
      // resting vtp- limit legs are already a ladder — a lone pos_profit
      // fallback beside them is NOT an under-laddered position; retrofitting
      // here would re-lay trigger legs the watcher just replaced (churn war)
      if (logicalProfit.length === 1 && !limLegs.length && p.size > 0) {
        const tpTrig = +logicalProfit[0].triggerPrice;
        const distPct = tpTrig > 0 ? (Math.abs(tpTrig - p.entry) / p.entry) * 100 : 0;
        if (distPct > 0) {
          const srcs = [logicalProfit[0], ...mirrorTps];
          const placed = await placeTpLadder(p, distPct);
          if (placed >= 2) {
            for (const src of srcs) {
              const pid = src.orderId || src.planId || src.id;
              if (!pid) continue;
              try {
                await cancelPlanOrders(p.symbol, src.planType, [String(pid)]);
              } catch (e) {
                state.errors.push(`ladder-cancel ${p.symbol}: ${e.message}`);
              }
            }
            state.actions.push(
              `laddered ${p.symbol}${manualHold ? ' (manual/foreign)' : ''}: TP split ${placed} ways @ ${RR.mults.map((m) => round(distPct * m, 2)).join('/')}% + moon bag`
            );
          }
        }
      }
      // band re-check — runs even on fully-armed positions: isolated-margin
      // liq creeps toward entry as funding/fees accrue, so a stop that was
      // inside the band at placement can end up past it and never fire. A
      // stop that can't beat liquidation protects nothing — rebuild it.
      const bandPct = p.liq > 0
        ? (Math.abs(p.entry - p.liq) / p.entry) * 100
        : (p.lev > 0 ? Math.max(0.2, 90 / p.lev) : 0); // liq field absent → estimate band from leverage
      // skip when a stop was already written this cycle — lossPlan here is a
      // stale snapshot; re-banding it after a ratchet/lock write would
      // overwrite the fresh (better) stop with band-edge geometry.
      if (!stopWritten && lossPlan && bandPct > 0) {
        const armedStopPct = (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100;
        // a stop past entry in the WIN direction is a profit lock, not a
        // risk stop — the liquidation band is irrelevant to it. Without
        // this gate the abs() distance makes a deep lock look
        // liq-adjacent and the re-band un-locks it every cycle.
        const lossSide = p.side === 'long'
          ? +lossPlan.triggerPrice < p.entry
          : +lossPlan.triggerPrice > p.entry;
        if (lossSide && armedStopPct >= bandPct * 0.8) {
          const sgn0 = p.side === 'long' ? 1 : -1;
          const pp0 = cm[p.symbol]?.pricePlace ?? 6;
          const newStop = round(p.entry * (1 - (sgn0 * Math.max(bandPct * 0.75, 0.05)) / 100), pp0);
          try {
            // place-then-cancel, same rule as the ratchet — cancel-first
            // leaves the position naked for the round-trip gap. Cleanup
            // runs off a fresh list: pos_loss is a singleton slot and a
            // stale id can alias onto the plan just written.
            await planWithRetry(() => planOrder(p.symbol, 'pos_loss', newStop, '0', p.side, p.marginMode));
            const live = await getPlans(p.symbol).catch(() => []);
            for (const x of live.filter((z) =>
              /loss|stop|moving/i.test(z.planType || '') &&
              +z.triggerPrice !== +newStop &&
              (!z.holdSide || z.holdSide === p.side)))
              await cancelPlanOrders(p.symbol, x.planType, [String(x.orderId || x.planId || x.id)]).catch(() => {});
            state.actions.push(`📏 re-banded ${p.symbol}: stop ${+lossPlan.triggerPrice} at/past liq edge (${round(bandPct, 2)}% band) -> ${newStop}`);
          } catch (e) {
            state.errors.push(`re-band ${p.symbol}: ${e.message}`);
          }
        }
      }
      if (manualHold && lossPlan && bandPct > 1.5) {
        const armedPct = (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100;
        // same profit-lock carve-out: an operator stop parked in the win
        // direction is their locked profit — never drag it back to risk.
        const opLossSide = p.side === 'long'
          ? +lossPlan.triggerPrice < p.entry
          : +lossPlan.triggerPrice > p.entry;
        // Garbage-band guard: cross/demo accounts report liquidation prices
        // thousands of percent away from entry — "the room the band affords"
        // is fictional there. Widening against it fired EVERY cycle (place
        // pos_loss at an absurd price → stale-id cancel wiped the stop →
        // god's shield re-placed → repeat), leaving the position naked at
        // dump time and failing the never-naked audit forever. Only widen
        // when the band is a plausible real band (≤30%).
        const saneBand = bandPct <= 30;
        if (opLossSide && saneBand && armedPct < bandPct * 0.5) {
          const sgn2 = p.side === 'long' ? 1 : -1;
          const pp2 = cm[p.symbol]?.pricePlace ?? 6;
          const wStop = round(p.entry * (1 - (sgn2 * bandPct * 0.7) / 100), pp2);
          try {
            await planOrder(p.symbol, 'pos_loss', wStop, '0', p.side, p.marginMode);
            // fresh-list cleanup — cancelling lossPlan by its (possibly
            // stale) id can alias onto the plan just written and wipe the
            // stop entirely (the documented ratchet trap; this path still
            // had it). Only rows at a DIFFERENT trigger get cancelled.
            const live = await getPlans(p.symbol).catch(() => []);
            for (const x of live.filter((z) =>
              /loss|stop|moving/i.test(z.planType || '') &&
              +z.triggerPrice !== +wStop &&
              (!z.holdSide || z.holdSide === p.side)))
              await cancelPlanOrders(p.symbol, x.planType, [String(x.orderId || x.planId || x.id)]).catch(() => {});
            state.actions.push(`📏 widened ${p.symbol} stop ${round(armedPct, 2)}% -> ${round(bandPct * 0.7, 2)}% — using the room the band affords`);
          } catch (e) { state.errors.push(`widen ${p.symbol}: ${e.message}`); }
        }
      }
      if (lossPlan && hasProfit) continue;
      const sgn = p.side === 'long' ? 1 : -1;
      const pp = cm[p.symbol]?.pricePlace ?? 6;
      let stopPct = lossPlan && +lossPlan.triggerPrice > 0
        ? (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100
        : 0;
      // the synthesized stop must fire BEFORE liquidation or it protects
      // nothing — 100x liq sits ~0.9% out, under the 1.2% default. Clamp to
      // 80% of the entry→liq distance (same bound entry sizing uses).
      // Manual/foreign positions repair WIDER (78% band): the operator's
      // mandate is survival room on hand-managed trades, not the engine's
      // tighter 70% floor — a stop they keep deleting protects nothing.
      const liqPct = bandPct;
      if (!stopPct) stopPct = Math.max(1.2, Math.min(liqPct * (manualHold ? 0.78 : 0.7), 5)); // mandate: band room, not a fixed tight stop
      if (liqPct > 0 && stopPct >= liqPct * 0.8) {
        const raw = stopPct;
        stopPct = Math.max(liqPct * 0.75, 0.05); // never tighter than 0.05%
        state.actions.push(`📏 clamped ${p.symbol} synth stop ${round(raw, 2)}% -> ${round(stopPct, 2)}% (liq ${round(liqPct, 2)}% away)`);
      }
      if (!lossPlan) {
        await planOrder(p.symbol, 'pos_loss',
          round(p.entry * (1 - (sgn * stopPct) / 100), pp), '0', p.side, p.marginMode);
        state.actions.push(`🔧 repaired ${p.symbol}: added pos_loss @ ${round(p.entry * (1 - (sgn * stopPct) / 100), pp)}`);
      }
      if (!hasProfit) {
        // staggered TPs even on synthesized protection — 2R is the base
        // distance, so tranches land at ~1.1R/2R/3.6R + the moon bag.
        // Too small to split -> one whole-position pos_profit as before.
        const placed = await placeTpLadder(p, 2 * stopPct);
        if (placed >= 2) {
          state.actions.push(
            `🔧 repaired ${p.symbol}: TP ladder ${placed} legs @ ${RR.mults.map((m) => round(2 * stopPct * m, 2)).join('/')}% + moon bag`
          );
        } else {
          const tpPrice = round(p.entry * (1 + (sgn * 2 * stopPct) / 100), pp);
          try {
            await planOrder(p.symbol, 'pos_profit', tpPrice, '0', p.side, p.marginMode);
          } catch {
            await planOrder(p.symbol, 'pos_profit', tpPrice, String(p.size), p.side, p.marginMode);
          }
          state.actions.push(`🔧 repaired ${p.symbol}: added pos_profit @ ${tpPrice}`);
        }
      }
    } catch (e) {
      state.errors.push(`protect ${p.symbol}: ${e.message}`);
    }
  }

  // ambiguous (dual-sided hedge) positions get NO auto-management — no
  // exits, no ratchets — but they still deserve protection: repair missing
  // TP/SL legs so they can't sit naked on the exchange.
  for (const p of state.positions) {
    if (!ambiguous.has(p.symbol)) continue;
    try {
      const existing = plansOf(p.symbol);
      const sgn = p.side === 'long' ? 1 : -1;
      const pp = cm[p.symbol]?.pricePlace ?? 6;
      const lossPlan = existing.find((x) => /loss|stop|moving/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
      const hasProfit = existing.some((x) => /profit/i.test(x.planType || '') && (!x.holdSide || x.holdSide === p.side));
      let stopPct = lossPlan && +lossPlan.triggerPrice > 0
        ? (Math.abs(p.entry - +lossPlan.triggerPrice) / p.entry) * 100
        : 0;
      const liqPct = p.liq > 0
        ? (Math.abs(p.entry - p.liq) / p.entry) * 100
        : (p.lev > 0 ? Math.max(0.2, 90 / p.lev) : 0);
      if (!stopPct) stopPct = Math.max(1.2, Math.min(liqPct * 0.7, 5)); // mandate: band room, not a fixed tight stop
      if (liqPct > 0 && stopPct >= liqPct * 0.8) stopPct = Math.max(liqPct * 0.75, 0.05);
      if (!lossPlan) {
        await planOrder(p.symbol, 'pos_loss',
          round(p.entry * (1 - (sgn * stopPct) / 100), pp), '0', p.side, p.marginMode);
        state.actions.push(`🛡️ protected ${p.symbol} ${p.side} (hedged): added pos_loss`);
      }
      if (!hasProfit) {
        const placed = await placeTpLadder(p, 2 * stopPct);
        if (placed >= 2) {
          state.actions.push(`🛡️ protected ${p.symbol} ${p.side} (hedged): TP ladder ${placed} legs`);
        } else {
          await planOrder(p.symbol, 'pos_profit',
            round(p.entry * (1 + (sgn * 2 * stopPct) / 100), pp), '0', p.side, p.marginMode);
          state.actions.push(`🛡️ protected ${p.symbol} ${p.side} (hedged): added pos_profit`);
        }
      }
    } catch (e) {
      state.errors.push(`protect ${p.symbol} ${p.side} (hedged): ${e.message}`);
    }
  }

  // ---- entries: only when the real drawdown guards are clear and capacity
  // allows — plan.killSwitch is sim-derived and logged for reference only ----
  let protectionHalted =
    Number.isFinite(state.protectionHaltUntil) && Date.now() < state.protectionHaltUntil;
  if (protectionHalted) {
    // auto-clear: the halt exists so entries can't fire while a placement
    // failure might have left a position naked. The repair loops above
    // already ran — if every position now verifies SL+TP on the exchange
    // the risk is gone and the remaining timer only blocks deployment.
    const allProtected = state.positions.every((p) => {
      const ex = plansOf(p.symbol).filter((x) => !x.holdSide || x.holdSide === p.side);
      return ex.some((x) => /loss|stop|moving/i.test(x.planType || '')) &&
             ex.some((x) => /profit/i.test(x.planType || ''));
    });
    if (allProtected) {
      delete state.protectionHaltUntil;
      protectionHalted = false;
      state.actions.push('protection-halt cleared early — all positions verified SL+TP on exchange');
    } else {
      state.actions.push(
        `🧯 protection-halt until ${new Date(state.protectionHaltUntil).toISOString().slice(11, 19)}Z — TPSL placement failed earlier, entries paused (no naked probes)`
      );
    }
  }
  // ---- orphan-entry sweep ----
  // Maker entries rest ~2.5s by design, then the placer cancels them. A
  // cycle that dies mid-attempt leaves a LIVE limit order on the exchange
  // that bypasses every gate when price later dips through it — the 12:31
  // CLU re-buy (19 contracts during an active fee-burn halt) was exactly
  // this ghost. Sweep rules: our `s*`-prefixed orders die at ORPHAN age;
  // when deployment is blocked ANY open-side pending order dies — nothing
  // may open while the book is stood down. reduceOnly legs are protection
  // and are never touched.
  try {
    const ORPHAN_MS = +(process.env.SENTINEL_ORPHAN_ORDER_MS || 90e3);
    const sweepSyms = new Set([
      ...posBySym.keys(),
      ...(plan?.orders || []).map((o) => o.symbol),
      ...(state.entriesLog || []).filter((e) => Date.now() - e.ts < 36e5).map((e) => e.symbol),
    ]);
    for (const s of sweepSyms) {
      const pend = await pendingOrders(s).catch(() => []);
      for (const o of pend) {
        const opening = String(o.reduceOnly || '').toUpperCase() !== 'YES' && o.tradeSide !== 'close';
        if (!opening) continue;
        const age = Date.now() - (+o.cTime || +o.uTime || Date.now());
        // ONLY ours — engine orders carry the `s*` clientOid prefix.
        // Anything else is the operator trading manually; never touch it.
        if (/^s\d/.test(String(o.clientOid || o.clientOrderId || '')) && age > ORPHAN_MS) {
          await X.cancelOrder(s, String(o.orderId)).then(() =>
            state.actions.push(`🧹 orphan-sweep ${s}: cancelled stale engine entry ${String(o.orderId).slice(-8)} age ${Math.round(age / 1000)}s`)
          ).catch(() => {});
        }
      }
    }
  } catch {}
  if (protectionHalted || entriesBlocked) {
    if (entriesBlocked) state.actions.push(`${entriesBlocked} — no new entries`);
  } else {
    let opened = 0;
    const openedSym = new Set(); // a dup symbol in the plan must not stack

    // ---- operator setup queue (VEMA-style): state/cmd-setups.json ----
    // Operator-authored entries — market / bounce / break-and-retest —
    // evaluated here each cycle and injected into plan.orders with
    // setup:true. The operator is the signal: statistical gates (edge,
    // meta-label, family, regime/corr/funding tape gates) don't apply to
    // o.setup orders, but every hard rail still rides (deny, dedup,
    // manual-hold, rate caps, protection-halt, drift sanity, exchange-side
    // SL+TP placement with emergency-close on failure).
    const setupPath = path.join(__dirname, '..', 'state', 'cmd-setups.json');
    const setupFile = cmdJson('cmd-setups.json');
    const setupSeen = []; // setups injected this cycle — resolved after the loop
    let setupDirty = false;
    if (setupFile && Array.isArray(setupFile.setups) && setupFile.setups.length) {
      const SETUP_RISK_DEF = +(process.env.SENTINEL_SETUP_RISK_PCT || 1);
      const SETUP_RR_FLOOR = +(process.env.SENTINEL_SETUP_MIN_RR || 1);
      const tickLast = async (sym) => {
        try {
          const q = await X.ticker(sym);
          const tk = Array.isArray(q) ? q[0] : q;
          return +(tk?.lastPr || 0);
        } catch { return 0; }
      };
      for (const s of setupFile.setups) {
        if (!s || !s.id) continue;
        if (['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected'].includes(s.status)) continue;
        setupDirty = true;
        const createdMs = +new Date(s.createdAt || 0) || 0;
        const ttlMs = (+s.ttlMin || 720) * 60e3;
        if (createdMs > 0 && Date.now() > createdMs + ttlMs) { s.status = 'expired'; continue; }
        const sym = String(s.symbol || '').toUpperCase();
        const sgn = s.direction === 'LONG' ? 1 : -1;
        if (s.status === 'triggered') {
          // injected on a previous cycle but the resolve write never
          // landed (cycle died between). Resolve against the book — do
          // NOT re-inject; a second market order is the failure mode.
          if (posBySym.has(sym)) {
            s.status = 'filled'; s.filledAt = Date.now();
            s.fillPx = posBySym.get(sym).entry ?? s.lastPx ?? null;
            setupArms[sym] = { id: s.id, slPx: +s.slPx || null, tps: s.tps || [], since: s.filledAt };
            armsDirty = true;
          } else {
            s.status = 'failed'; s.reason = 'entry never filled (gated or cycle died)';
          }
          continue;
        }
        const rej = (r) => { s.status = 'rejected'; s.reason = r; };
        // deterministic rejections — fail fast with a reason the operator
        // can read on the board instead of silently looping dead
        if (DENY_SYMS.has(sym)) { rej('denied-symbol'); continue; }
        if (LONG_ONLY && s.direction === 'SHORT') { rej('longs-only-mandate'); continue; }
        if (MANUAL.has(sym)) { rej('manual-hold-symbol'); continue; }
        if (!cm[sym]) { rej('unroutable-in-this-env'); continue; }
        if (posBySym.has(sym) || ambiguous.has(sym)) { s.blockedBy = 'position-open'; continue; }
        s.blockedBy = null;
        const last = await tickLast(sym);
        if (!(last > 0)) continue; // ticker unreadable — try next cycle
        s.lastPx = last;
        let go = false;
        if (s.mode === 'bounce') {
          // limit-style: long buys the pullback INTO the level, short
          // sells the rally into it — fills only when price trades at it
          go = +s.entryPx > 0 && (sgn > 0 ? last <= +s.entryPx : last >= +s.entryPx);
        } else if (s.mode === 'br') {
          // stage 1 break: price must trade through breakPx; stage 2
          // retest: price must come back to entryPx — then market-fill
          if (s.stage !== 'await-retest') {
            if (+s.breakPx > 0 && (sgn > 0 ? last >= +s.breakPx : last <= +s.breakPx)) {
              s.stage = 'await-retest'; s.brokeAt = Date.now();
            }
          } else {
            go = +s.entryPx > 0 && (sgn > 0 ? last <= +s.entryPx : last >= +s.entryPx);
          }
        } else { // market — operator's ref px is advisory; mark fills anyway
          go = true;
        }
        if (!go) continue;
        const slPx = +s.slPx;
        if (!(slPx > 0)) { rej('missing-stop-loss'); continue; }
        // stop must sit on the losing side of the CURRENT mark — a stop
        // already passed is a born-dead position (Bitget 43023-style)
        if (sgn > 0 ? slPx >= last : slPx <= last) { rej('stop-on-wrong-side-of-mark'); continue; }
        const tps = (Array.isArray(s.tps) ? s.tps : [])
          .map((t) => ({ px: +t.px, pct: +t.pct || 0 }))
          .filter((t) => t.px > 0 && t.pct > 0);
        if (!tps.length) { rej('no-valid-take-profits'); continue; }
        if (tps.some((t) => (sgn > 0 ? t.px <= last : t.px >= last))) { rej('tp-already-passed'); continue; }
        const stopPct = (Math.abs(last - slPx) / last) * 100;
        const wsum = tps.reduce((a, t) => a + t.pct, 0);
        const targetPct = tps.reduce((a, t) => a + (Math.abs(t.px - last) / last) * 100 * t.pct, 0) / Math.max(1, wsum);
        const costPct = 0.20; // same fee+slip floor the RR gate applies
        const netRR = (targetPct - costPct) / (stopPct + costPct);
        if (!(netRR >= SETUP_RR_FLOOR)) { rej(`net-rr ${round(netRR, 2)} < ${SETUP_RR_FLOOR}`); continue; }
        const riskUsd = equityUsd * ((+s.riskPct || SETUP_RISK_DEF) / 100) * ddRiskScale;
        plan.orders.push({
          symbol: sym, direction: s.direction, refEntry: last,
          notionalUsd: round(riskUsd / Math.max(0.0005, stopPct / 100), 2),
          stopPct, targetPct, leverage: 10, conv: 1,
          strategy: s.strategy || 'vema-setup', setupId: s.id, setup: true, mode: s.mode,
          riskUsd: round(riskUsd, 2), absSl: slPx, absTps: tps,
          note: s.note || null,
        });
        s.status = 'triggered'; s.triggeredAt = Date.now();
        setupSeen.push(s);
        state.actions.push(
          `🛠 setup ${s.id} ${sym} ${s.direction} ${s.mode} triggered @ ${round(last, 6)} — risk $${round(riskUsd, 2)} · stop ${round(stopPct, 2)}% · netRR ${round(netRR, 2)} → queued`
        );
      }
    }

    // ---- core-carry injection: the mandate is deployment. Margin that
    // qualifies for no signal still works — appended LAST in the queue so
    // real signals take their share first, then the remainder deploys into
    // a protected carry instead of sitting as dead balance. It rides every
    // in-loop gate (dedup, cooldown, RR, drift, rate caps, catalog) like a
    // normal order.
    if (marginFree > Math.max(equityUsd * CORE_FLOOR_PCT, CORE_FLOOR_USD)) {
      for (const sym of CORE_SYMS) {
        if (posBySym.has(sym) || ambiguous.has(sym) || MANUAL.has(sym) || !cm[sym]) continue;
        try {
          const tk = await X.ticker(sym);
          const last = +(Array.isArray(tk) ? tk[0].lastPr : tk?.lastPr);
          if (!(last > 0)) continue;
          plan.orders.push({
            symbol: sym, direction: 'LONG', refEntry: last,
            notionalUsd: round(marginFree, 2),
            stopPct: CORE_STOP_PCT, targetPct: CORE_TARGET_PCT,
            leverage: CORE_LEV, conv: 1, runnerMult: 1.8,
            strategy: 'core-carry', core: true,
          });
          state.actions.push('core-carry: deploying $' + round(marginFree, 2) + ' idle margin into ' + sym + ' long @ lev<=' + CORE_LEV);
        } catch (e) { /* ticker unreadable — try next symbol */ }
        break; // one core order per cycle — first eligible symbol wins
      }
    }
    // ---- slot-fill mandate: operator rule — keep the book deployed at
    // LIVE_TARGET_POSITIONS while margin is free. Rides the queue LAST so
    // every gate-passing signal gets first claim on margin; mandate orders
    // then deploy marginFree/slots each into the best available longs.
    // Hard vetoes still ride (deny/manual/ambiguous/2-loss cooldown/
    // re-entry/already-planned) — idle slots are the mandate's failure
    // state, journaled loudly when it happens.
    // the vault bag isn't a trading slot — it accumulates carry, it doesn't
    // compete for LIVE_TARGET_POSITIONS capacity
    const vaultHeld = posBySym.has(VAULT_SYM) ? 1 : 0;
    const slotsAvail = Math.max(0, TARGET_POSITIONS - (posBySym.size - vaultHeld) - plan.orders.filter((o) => !o.mandate).length);
    // 🌆 pimpcity nomination phase — the war state was loaded, attributed,
    // fought and SAVED early (killed cycles used to strand it); here we only
    // need the roster to order slot candidates. war/pc are in scope already.
    if (slotsAvail > 0 && marginFree > 0.5) {
      const softOnly = (r) =>
        r.direction === 'LONG' &&
        (r.gates || []).length &&
        (r.gates || []).every((g) => /sqn-chain|fake-move|rr|score|meta|funding|chop|range|drift|short/i.test(g));
      // measured byMktType alpha (signal-eval): side-normal +0.39 /
      // bear-normal +0.27 are the only positive cells; bull-volatile −0.41
      // is the worst. Rank mandate picks toward the proven regime.
      const GOOD_MKT = new Set(['side-normal', 'bear-normal']);
      const BAD_MKT = new Set(['bull-volatile']);
      // crackwhore mandate: the trail only pays after +0.2% — rank deployment
      // by who is actually MOVING, not just static score. |24h change| is the
      // cheapest live proxy for current volatility in the reject row.
      const pool = (plan.rejects || []).filter(softOnly).map((r) => ({
        ...r,
        symbol: r.symbol,
        score: (+r.score || 0) + (GOOD_MKT.has(r.mktType) ? 15 : BAD_MKT.has(r.mktType) ? -10 : 0)
          + Math.min(20, Math.abs(+r.changePct || 0) * 4),
      }));
      // majors mandate: high-volume/high-liquidity contracts get a standing
      // seat in the slot pool — ranked by the venue's own 24h quote volume so
      // the list maintains itself (no hand-curated majors list). Seeds run
      // just under CORE_SYMS (45) but above weak rejects; every downstream
      // guard (dedup/cooldown/deny/ambiguous/manual/re-entry) still applies.
      if (process.env.SENTINEL_MAJORS_TILT !== '0' && X.name === 'bitget') {
        try {
          const tj = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES')
            .then((r) => r.json());
          const vols = (tj.data || [])
            .map((t) => ({ symbol: t.symbol, vol: +(t.usdtVolume ?? t.quoteVolume ?? 0) }))
            .filter((t) => t.vol > 0 && cm[t.symbol])
            .sort((a, b) => b.vol - a.vol)
            .slice(0, +(process.env.SENTINEL_MAJORS_TOP_N || 30));
          const seen = new Set([...CORE_SYMS, ...pool.map((p) => p.symbol)]);
          let added = 0;
          for (const m of vols) {
            if (seen.has(m.symbol)) continue;
            seen.add(m.symbol);
            pool.push({ symbol: m.symbol, direction: 'LONG', score: Math.round(38 + Math.min(15, Math.log10(Math.max(1, m.vol / 1e6)) * 3)), gates: ['majors-seed'], majors: true, volUsd: m.vol });
            added++;
          }
          if (added) state.actions.push(`🏦 majors tilt: seeded ${added} high-volume contracts into the slot pool (top ${vols.length} by 24h turnover)`);
        } catch { /* ticker board unreachable — pool proceeds without majors */ }
      }
      let cand = [...CORE_SYMS.map((symbol) => ({ symbol, score: 45 })), ...pool.sort((a, b) => b.score - a.score)];
      try {
        const noms = war && pc ? pc.nominate(war, cand, slotsAvail) : [];
        if (noms.length) {
          const bySym = new Map(cand.map((c) => [c.symbol, c]));
          const nomCand = [];
          for (const n of noms) {
            const row = bySym.get(n.cand.symbol) || n.cand;
            nomCand.push({ ...row, symbol: n.cand.symbol, score: Math.round(n.sc), pimp: n.pimp, crack: n.crack });
          }
          for (const c of cand) if (!nomCand.some((n) => n.symbol === c.symbol)) nomCand.push(c);
          cand = nomCand;
          state.actions.push(`🌆 pimpcity: ${noms.slice(0, slotsAvail).map((n) => `${n.pimp ? `${n.pimp} fields` : 'freelance'} ${n.crack}→${n.cand.symbol}`).join(' · ')}`);
        }
      } catch (e) { state.errors.push('pimpcity: ' + e.message); }
      const perSlotUsd = marginFree / slotsAvail;
      let picked = 0;
      for (const c of cand) {
        if (picked >= slotsAvail) break;
        if (posBySym.has(c.symbol) || ambiguous.has(c.symbol) || MANUAL.has(c.symbol) || cooledSym.has(c.symbol) || DENY_SYMS.has(c.symbol) || !cm[c.symbol] || plan.orders.some((o) => o.symbol === c.symbol)) continue;
        const lc = lastCloseBySym[c.symbol];
        if (lc && Date.now() - lc < REENTRY_MS) continue;
        try {
          const tk = await X.ticker(c.symbol);
          const last = +(Array.isArray(tk) ? tk[0].lastPr : tk?.lastPr);
          if (!(last > 0)) continue;
          plan.orders.push({
            symbol: c.symbol, direction: 'LONG', refEntry: last,
            notionalUsd: round(perSlotUsd * CORE_LEV, 2),
            stopPct: CORE_STOP_PCT, targetPct: CORE_TARGET_PCT,
            leverage: CORE_LEV, conv: 1, runnerMult: 1.8,
            strategy: 'slot-deploy', core: true, mandate: true,
            pimp: c.pimp, crack: c.crack,
          });
          // deterministic persona binding: the order's clientOid is
          // s{plan.ts}{SYMBOL} — stamp it on the intent so the reconcile can
          // bind the fill by order id, not a timestamp guess
          if (war && (c.pimp || c.crack)) (war.intents || (war.intents = [])).push({ symbol: c.symbol, direction: 'LONG', ts: Date.now(), pimp: c.pimp || null, crack: c.crack, coid: `s${plan.ts}${c.symbol}`.slice(0, 38) });
          state.actions.push(`📌 SLOT-FILL mandate — $${round(perSlotUsd, 2)} margin into ${c.symbol} long${c.crack ? ` · ${c.crack}${c.pimp ? ` working for ${c.pimp}` : ' freelance (no pimp)'}` : ` (score ${c.score})`} · ${CORE_LEV}x · stop ${CORE_STOP_PCT}% · slot ${picked + 1}/${slotsAvail}`);
          picked++;
        } catch { /* ticker dead — next candidate */ }
      }
      if (!picked) state.actions.push('📌 SLOT-FILL mandate — no eligible long (all candidates denied/cooling/manual/ambiguous) — slots stay idle');
    }
    // prune dead intents: live = open position; pending = unfilled but
    // fresh (<15min); everything else is a dead nomination — drop it so
    // the dashboard never shows a girl "on shift" who never clocked in
    if (war && war.intents) war.intents = war.intents.filter((it) => it.live || Date.now() - it.ts < 15 * 60 * 1000);
    if (war && pc) { try { pc.saveWar(war); } catch {} }
    for (const [oi, o] of plan.orders.entries()) {
      // ambiguous symbols are excluded from posBySym — a .has() check would
      // pass and stack a third order on a symbol already holding both sides
      if (posBySym.has(o.symbol) || openedSym.has(o.symbol) || ambiguous.has(o.symbol) || opened + posBySym.size >= MAX_POSITIONS) continue;
      // mandate fills empty slots only — once the book reaches the
      // position target it stands down; signals fill first (queue order)
      if (o.mandate && opened + posBySym.size >= TARGET_POSITIONS) continue;
      // MANUAL_HOLD is a hands-off claim on the SYMBOL, not just the open
      // position — an auto-entry on a held symbol would open then go
      // unmanaged (management exempts itself by design). Entries blocked.
      if (MANUAL.has(o.symbol)) {
        state.actions.push(`${o.symbol}: ✋ manual-hold symbol — entry skipped (symbol is hands-off)`);
        continue;
      }
      if (cooledSym.has(o.symbol)) {
        state.actions.push(`${o.symbol}: ⏳ cooldown — last two closes were losers, 6h timeout`);
        continue;
      }
      if ((MAX_ENTRIES_HOUR > 0 && entriesThisHour >= MAX_ENTRIES_HOUR) || (MAX_ENTRIES_DAY > 0 && entriesThisDay >= MAX_ENTRIES_DAY)) {
        if (o.mandate) { /* churn cap limits turnover, not coverage — a flat book is exempt */ } else {
        state.actions.push(`🚦 entry rate cap (${entriesThisHour}/${MAX_ENTRIES_HOUR}/h · ${entriesThisDay}/${MAX_ENTRIES_DAY}/day) — standing down`);
        continue;
        }
      }
      if (feeHalted) {
        state.actions.push(`🔥 fee-burn halt — ${round(feesToday, 2)} commissions today >= ${FEE_DAY_HALT_PCT}% of equity — standing down`);
        break;
      }
      const lastClose = lastCloseBySym[o.symbol];
      if (lastClose && Date.now() - lastClose < REENTRY_MS) {
        state.actions.push(`${o.symbol}: ⏳ re-entry cooldown — closed ${Math.round((Date.now() - lastClose) / 6e4)}m ago (< ${Math.round(REENTRY_MS / 6e4)}m)`);
        continue;
      }
      if (!Number.isFinite(o.refEntry) || !Number.isFinite(o.notionalUsd) ||
          !Number.isFinite(o.stopPct) || !Number.isFinite(o.targetPct) ||
          !Number.isFinite(o.leverage) || (o.direction !== 'LONG' && o.direction !== 'SHORT')) {
        state.errors.push(`${o.symbol || '?'}: malformed order fields — skipped`);
        continue;
      }
      // user mandate: denied symbols refuse every entry — signal and
      // mandate roles alike. Placed before all other gates.
      if (DENY_SYMS.has(o.symbol)) {
        state.actions.push(`${o.symbol} ${o.direction}: 🚫 denied-symbol — entries refused by mandate`);
        (state.rejects = state.rejects || []).push({ symbol: o.symbol, direction: o.direction, score: o.score, rangePosition: o.rangePosition ?? null, changePct: o.changePct ?? null, gates: ['denied-symbol'] });
        continue;
      }
      // user mandate: no shorts — hard refusal independent of scanner gating,
      // so a stale or hand-built plan can never route a short entry.
      if (LONG_ONLY && o.direction === 'SHORT') {
        state.actions.push(`${o.symbol}: ⛔ SHORT blocked — longs-only mandate`);
        continue;
      }
      // shorts = mean-reversion scalps only (mandate, mirrored from the
      // scanner): a stale or hand-built short gets the same bar — fade
      // family, high score, capped target. Net-RR floor is enforced in
      // the RR defense block below.
      if (o.direction === 'SHORT' && !o.setup) {
        const ok = (process.env.SENTINEL_SHORT_STRATS || 'Liquidity Sweep,Key Level SFP,PA Quartile').split(',').map((x) => x.trim());
        const sMin = +(process.env.SENTINEL_SHORT_MIN_SCORE || 75);
        const sTgt = +(process.env.SENTINEL_SHORT_MAX_TGT_PCT || 2.5);
        const why = !o.strategy || !ok.includes(o.strategy) ? 'short-strat (mean-rev only)'
          : (o.score ?? 0) < sMin ? `short-score<${sMin}`
          : (o.targetPct ?? 99) > sTgt ? `short-tgt>${sTgt}% (scalp-only)`
          : null;
        if (why) { state.actions.push(`${o.symbol}: ${why}`); continue; }
      }
      if (!o.core && !o.setup) { // mandate roles (core-carry deploys) and operator setups are exempt from tape gates
        if (regimeChop) {
          state.actions.push(`${o.symbol} ${o.direction}: regime-chop — entries halted this window`);
          (state.rejects = state.rejects || []).push({ symbol: o.symbol, direction: o.direction, score: o.score, rangePosition: o.rangePosition ?? null, changePct: o.changePct ?? null, gates: ['regime-chop'] });
          continue;
        }
        const corrHit = Object.entries(corrMap[o.symbol] || {}).find(([s2]) => {
          const pv = posBySym.get(s2);
          const sd = pv?.side || pv?.holdSide;
          return sd === (o.direction === 'LONG' ? 'long' : 'short');
        });
        if (corrHit) {
          state.actions.push(`${o.symbol} ${o.direction}: 🧬 corr-cluster — ${corrHit[0]} already held same direction (rho ${corrHit[1]})`);
          (state.rejects = state.rejects || []).push({ symbol: o.symbol, direction: o.direction, score: o.score, rangePosition: o.rangePosition ?? null, changePct: o.changePct ?? null, gates: ['corr-cluster'] });
          continue;
        }
        const fr = fundMap[o.symbol];
        if (fr != null && ((o.direction === 'LONG' && fr > FUND_VETO) || (o.direction === 'SHORT' && fr < -FUND_VETO))) {
          state.actions.push(`${o.symbol} ${o.direction}: 💸 funding ${fr}%/8h hostile — vetoed`);
          (state.rejects = state.rejects || []).push({ symbol: o.symbol, direction: o.direction, score: o.score, rangePosition: o.rangePosition ?? null, changePct: o.changePct ?? null, gates: ['funding-hostile'] });
          continue;
        }
      }
      // idempotent execution: the same signal must physically be unable to
      // fire twice. A prior attempt on this symbol+direction inside the
      // dedup window means this order is a replay (fill-index lag, plan
      // re-emission, loop restart) — skip it.
      if ((state.entriesLog || []).some(
        (e) => e.symbol === o.symbol && e.direction === o.direction &&
               Date.now() - e.ts < ENTRY_DEDUP_MS
      )) {
        state.actions.push(`${o.symbol} ${o.direction}: 🔁 duplicate signal — idempotent skip`);
        continue;
      }
      // ≥RR_MIN net R:R defense — the scanner stamps netRR/costPct; recompute
      // here with a conservative cost floor (0.12% RT fees + 0.08 slip +
      // 0.1 spread = 0.30%) so a stale/noncompliant plan can never route.
      {
        // operator setups get their own floor — the operator owns the
        // trade, but the floor still refuses geometry that pays for the
        // stop with a target that's already inside the fee line
        const RR_MIN = Math.max(
          o.direction === 'SHORT' && !o.setup ? +(process.env.SENTINEL_SHORT_MIN_RR || 1.5) : 0,
          o.setup ? +(process.env.SENTINEL_SETUP_MIN_RR || 1) : +(process.env.SENTINEL_MIN_RR || 2)
        );
        // floor at UNAVOIDABLE cost only: taker RT 0.12 + modeled slip 0.08 =
        // 0.20%. The 0.30% floor invented a spread the scanner measured as
        // ~0 on liquid majors — every marginal plan died at ~2.4:1 effective.
        // Scanner-stamped costPct (spread + funding) rides on top.
        const cost = Math.max(Number.isFinite(o.costPct) ? o.costPct : 0, 0.20);
        const netRR = (o.targetPct - cost) / (o.stopPct + cost);
        if (!(netRR >= RR_MIN)) {
          state.actions.push(`${o.symbol}: 📐 net R:R ${netRR.toFixed(2)} < ${RR_MIN}:1 after costs — rejected`);
          continue;
        }
      }
      // entry-edge gate — when the excursion record says entries are
      // net-negative expectancy (fitted edge < EDGE_MIN_TRADE) the
      // marginal entry is a fee donation to the exchange. Skip it.
      const metaP = metaProb(o);
      let metaMul = 1;
      if (!o.setup && metaP != null && META.evN >= META_MIN_N) {
        if (metaP < META_MIN_P) {
          state.actions.push(`${o.symbol} ${o.direction}: 🧠 meta-label — p(profit) ${round(metaP, 2)} < ${META_MIN_P} over n=${META.evN} graded signals — skipped`);
          (state.rejects = state.rejects || []).push({ symbol: o.symbol, direction: o.direction, score: o.score, rangePosition: o.rangePosition ?? null, changePct: o.changePct ?? null, gates: ['meta-label'] });
          continue;
        }
        // above the floor the estimate modulates size — LdP: the meta
        // model owns SIZE while the primary model owns SIDE
        metaMul = Math.min(1.3, Math.max(0.5, metaP / Math.max(0.05, META.p0)));
      }
      if (!o.setup && !o.mandate && EDGE_LIVE.v < EDGE_MIN_TRADE) {
        state.actions.push(`${o.symbol}: ⛔ edge-gated — fitted entry edge ${EDGE_LIVE.v.toFixed(2)} < ${EDGE_MIN_TRADE} (${EDGE_LIVE.src}) — skipped`);
        continue;
      }
      // family gate — strategy families that have had their trial (n>=8
      // episodes) and lost on average stop getting bullets until fresh
      // evidence acquits them
      const fam = FAM_STATS[o.strategy || 'unattributed'];
      if (fam && fam.n >= 8 && fam.meanRetPct < 0 && fam.winShare < 0.35) {
        state.actions.push(`${o.symbol}: ⛔ family-gated — '${o.strategy || 'unattributed'}' n=${fam.n} wr ${Math.round(fam.winShare * 100)}% ret ${fam.meanRetPct}% — skipped`);
        continue;
      }
      // drift guard — the plan can be up to 15min old; a market order at a
      // price that already ran past the modeled entry breaks the 3:1
      // geometry the scanner certified. Chase-fade tolerance: 0.6%.
      try {
        const tk = await X.ticker(o.symbol);
        const last = +(Array.isArray(tk) ? tk[0].lastPr : tk?.lastPr);
        const drift = (o.direction === 'LONG' ? last - o.refEntry : o.refEntry - last) / o.refEntry;
        if (last > 0 && drift > (o.setup ? +(process.env.SENTINEL_SETUP_DRIFT || 0.015) : 0.006)) {
          state.actions.push(`${o.symbol}: 🏃 price ran ${round(drift * 100, 2)}% past ref entry — skipped (chasing = worse R:R)`);
          continue;
        }
        // trigger-side sanity: if mark already sits beyond the modeled stop,
        // the SL trigger is wrong-side the instant it lands (Bitget 43023 /
        // instant trigger) — the position is born dead; if it's already past
        // the target there's nothing left to capture. Either way: skip.
        const sgn0 = o.direction === 'LONG' ? 1 : -1;
        const slTrig = o.refEntry * (1 - sgn0 * (o.stopPct / 100));
        const tpTrig = o.refEntry * (1 + sgn0 * (o.targetPct / 100));
        if (last > 0 && (sgn0 === 1 ? last <= slTrig : last >= slTrig)) {
          state.actions.push(`${o.symbol}: mark already through modeled stop (${last} vs ${round(slTrig, 6)}) — skipped`);
          continue;
        }
        if (last > 0 && (sgn0 === 1 ? last >= tpTrig : last <= tpTrig)) {
          state.actions.push(`${o.symbol}: mark already through modeled target (${last} vs ${round(tpTrig, 6)}) — skipped`);
          continue;
        }
      } catch {} // ticker unreadable — proceed on the plan's own staleness TTL
      // not in this environment's catalog = unroutable here — record it so
      // the scanner stops emitting entries the executor can never fill
      if (!cm[o.symbol]) {
        state.untradeable = [...new Set([...(state.untradeable || []), o.symbol])];
        state.errors.push(`${o.symbol}: absent from ${MODE} contract catalog — unroutable`);
        continue;
      }
      // sizing: deploy ALL free margin evenly across the remaining target
      // slots (~25% of balance per trade at the 4-slot target); once the
      // target is met, leftovers spread across any remaining max slots.
      const openNow = posBySym.size + opened;
      const slotsLeft = Math.max(0, MAX_POSITIONS - openNow);
      const targetLeft = Math.max(0, TARGET_POSITIONS - openNow);
      // denominator counts REMAINING plan orders, not a static slot count —
      // orders skipped by the gates free their share forward, and the last
      // eligible order deploys everything that's left. No idle margin.
      const ordersLeft = Math.max(1, plan.orders.length - oi);
      const denom = Math.min(
        Math.max(1, targetLeft > 0 ? targetLeft : slotsLeft),
        ordersLeft
      );
      // risk multiplier: max profile (or SENTINEL_RISK_MUL) puts 3x the
      // per-slot share on each order — same slot logic, triple the slice.
      // Capped at the full free margin after the fee reserve either way.
      // Equity-curve throttle: while the book runs >10% below its real
      // peak the multiplier halves — protect capital during a bleed, press
      // it during equity highs. Sizing still uses whatever margin is free.
      const riskMul =
        +(riskMulOverride ?? (process.env.SENTINEL_RISK_MUL || (RISK_MAX ? 3 : 1))) *
        ((state.ddPct ?? 0) > 10 ? 0.5 : 1) *
        // edge-scaled sizing — unproven entries earn proportional
        // bullets: edge 0.5 fires at half size, edge >=1 at full
        Math.min(1, EDGE_LIVE.v);
      // leverage: contract max, bounded so the designed stop still sits
      // inside the liquidation band — lev <= 80/(stopPct + 0.64) keeps the
      // stop at <=80% of the band edge, otherwise liquidation fires first.
      // Operator floor: LEV_FLOOR (SENTINEL_MIN_LEV, default 20) lifts the
      // carry/mandate cap — the band cap still wins when it can't hold 20x.
      const lev = Math.max(
        1,
        Math.min(
          cm[o.symbol].maxLev || 125,
          Math.floor(80 / (o.stopPct + 0.64)),
          +(process.env.SENTINEL_MAX_LEV || 40), // account ceiling — the max-safety profile pins it lower
          o.core ? Math.max(CORE_LEV, LEV_FLOOR) : Infinity // carry gears to the operator floor when the band allows
        )
      );
      // fee headroom: Bitget charges the taker fee on NOTIONAL from free
      // balance — at 37x the round-trip (open taker + conditional exit)
      // eats ~4.4% of the margin slice. Sizing to 100% of marginFree was
      // the source of the 40762 'order amount exceeds the balance'
      // rejections — the fee landed on top of a fully-deployed balance.
      const FEE_RT = 0.0012; // 0.06% taker x2 sides of notional
      // over-reserve fees 30% — exact-fit sizing still produced 40762
      // 'order amount exceeds the balance' rejections (rate-tier and
      // rounding slop land the fee on top of a fully-deployed balance)
      // conviction-weighted deployment — the plan stamps each order with
      // its strategy's measured forward-alpha tier: proven-edge setups take
      // their full slot, unproven ones take a probe-size fraction. The
      // per-position cap below stays the absolute ceiling either way.
      const convMul = Math.min(1.1, Math.max(+(process.env.SENTINEL_CONV_FLOOR || 0.2), +(o.conv ?? 1))) * metaMul;
      const marginUsd = o.mandate
        ? // flat-book deployment: max available margin, fee-headroom only —
          // the mandate IS the position; conviction/risk ceilings are for
          // signals competing for slots, not the coverage order
          marginFree / (1 + lev * FEE_RT * 1.3)
        : o.setup
        ? Math.min(
            // VEMA-style risk-% sizing: notional such that a stop-out
            // loses ≈ riskUsd (stop distance + round-trip fee drag on
            // notional), converted to margin at the computed leverage.
            // Kelly/slot-share don't apply — the operator sized it.
            o.riskUsd / Math.max(0.0005, o.stopPct / 100 + FEE_RT) / lev,
            equityUsd * +(process.env.SENTINEL_POS_CAP_PCT || 0.85),
            marginFree / (1 + lev * FEE_RT * 1.3)
          )
        : Math.min(
            (Math.min(riskMul / denom, 1) * marginFree) / (1 + lev * FEE_RT * 1.3) * convMul,
            // single-position margin cap — 85%: near-full aggression on a
            // qualifying shot while still banking one reload. Ruin is the
            // only unrecoverable outcome; every other loss is tuition.
            equityUsd * +(process.env.SENTINEL_POS_CAP_PCT || 0.85),
            // Van Tharp sizing ceiling: a stop-out may not cost more than
            // MAX_RISK_PCT of equity. Margin-share sizing let -$20 losses
            // land on a $33 book (~60% risk/trade) — R-variance that no
            // edge survives. Same formula the operator setups use.
            Number.isFinite(o.stopPct) && o.stopPct > 0
              ? (equityUsd * RISK_CAP_PCT) /
                Math.max(0.0005, o.stopPct / 100 + FEE_RT) / lev
              : Infinity,
            // half-Kelly ceiling: equity-at-risk (margin×lev×stopPct) stays
            // under half the realized record's optimal fraction — dormant
            // until n>=15 closes; f*<=0 collapses it to zero = full stand-down
            ...(kellyRiskUsd != null ? [kellyRiskUsd / Math.max(0.05, (lev * (o.stopPct || 3)) / 100)] : [])
          );
      // effective-notional cap: margin_cap × lev ≈ 50x equity → the 0.12%
      // round-trip eats ~6% of equity per trade while measured signal
      // expectancy is +0.05%/trade — structurally unbeatable. Every
      // live-verified public strategy runs <=5x effective notional for
      // exactly this reason. Cap is env-tunable (0/absent = legacy uncapped).
      const NOTIONAL_MULT_CAP = +(process.env.SENTINEL_MAX_NOTIONAL_MULT || 0) || Infinity;
      const notional = Math.min(marginUsd * lev, equityUsd * NOTIONAL_MULT_CAP);
      let size = sizeFor(cm, o.symbol, notional, o.refEntry);
      let minMarginNeeded = null;
      if (!size && FLOOR_MIN) {
        // floor to the contract minimum — but only if the margin needed
        // (notional/leverage) leaves >20% of equity free afterwards
        const c = cm[o.symbol];
        const minQty = Math.max(c.minTradeNum, c.minTradeUSDT / o.refEntry);
        const minNotional = minQty * o.refEntry;
        const marginNeeded = minNotional / lev;
        minMarginNeeded = marginNeeded + minNotional * 0.0006;
        // margin must cover size AND the open taker fee on that notional —
        // out of FREE margin, not equity: comparing against equity*0.8 while
        // marginFree was ~0 was the recurring 40762 'exceeds the balance'
        // spam. Reserve 20% of equity in the default profile; max profile
        // spends down to fees-only.
        const feeNeeded = minNotional * 0.0006;
        const budget = marginFree - (RISK_MAX ? 0 : equityUsd * 0.2);
        if (marginNeeded + feeNeeded <= budget) {
          // Van Tharp cap applies to floored size too — a position that can
          // only exist by over-risking is a σ[R] leak, not a trade.
          const riskIfStopped = minNotional * (o.stopPct / 100 + FEE_RT);
          if (riskIfStopped > equityUsd * RISK_CAP_PCT) {
            state.actions.push(`${o.symbol}: ⛔ min-size risk $${round(riskIfStopped, 2)} > ${round(RISK_CAP_PCT * 100, 1)}% equity cap — not floored`);
            continue;
          }
          const p = Math.pow(10, c.sizePlace);
          size = Math.ceil(minQty * p) / p; // round UP to clear the minimum
          state.actions.push(`${o.symbol}: 📏 scaled size below min — floored to contract minimum $${round(minNotional, 2)} notional`);
        }
      }
      if (!size) {
        // can't fund even the contract minimum from free margin = fully
        // deployed, not a fault — log as an action, not an error
        const msg = `${o.symbol}: insufficient free margin for contract minimum — skipped`;
        ((minMarginNeeded ?? Infinity) > marginFree ? state.actions : state.errors).push(msg);
        continue;
      }
      const sgn = o.direction === 'LONG' ? 1 : -1;
      const holdSide = o.direction === 'LONG' ? 'long' : 'short';
      const coid = `s${plan.ts}${o.symbol}`.slice(0, 38);
      const t0 = Date.now();
      try {
        await setIsolated(o.symbol);
        try {
          await setLeverage(o.symbol, lev);
        } catch (le) {
          // 40940: the exchange drops the leverage ceiling below contract
          // maxLev during low-liquidity windows. Retry at the announced
          // max and shrink notional onto the same margin slice — a smaller
          // entry beats a dead one, and the tighter leverage only reduces
          // the designed risk. Any other set-leverage failure is fatal.
          const cap = /leverage is (\d+)x/i.exec(String((le && le.message) || le));
          if (!cap) throw le;
          const levEff = Math.min(lev, +cap[1]);
          await setLeverage(o.symbol, levEff);
          const n2 = marginUsd * levEff;
          size = sizeFor(cm, o.symbol, n2, o.refEntry);
          if (!size) {
            state.actions.push(`${o.symbol}: lev capped ${levEff}x — notional below contract min — skipped`);
            continue;
          }
          state.actions.push(`${o.symbol}: ⚠️ lev ${lev}→${levEff}x (exchange cap) — notional → $${round(n2, 2)}`);
        }
        let needSize = size;
        // operator setups fill at market on trigger (VEMA semantics:
        // condition met → market order) — the pullback quote could leave
        // a triggered setup unfilled while the level runs away
        if (MAKER_ENTRIES && !o.setup) {
          try {
            const q = await X.ticker(o.symbol);
            const tk = Array.isArray(q) ? q[0] : q;
            const touch = sgn > 0 ? +tk?.bidPr : +tk?.askPr; // join own side — post-only, never crosses
            if (touch > 0) {
              // pullback pricing — the excursion record shows entries
              // running ~1.3% against before moving for us (MAE ≈ 4×
              // MFE). Quoting PULLBACK_PCT deeper than touch converts
              // that typical adverse excursion into a better fill
              // instead of buying the local top/bottom.
              const pull = touch * (1 - (sgn * PULLBACK_PCT) / 100);
              const lo = await limitOrder(o.symbol, sgn > 0 ? 'buy' : 'sell', size, round(pull, cm[o.symbol]?.pricePlace ?? 6), { clientOid: coid });
              const oid = String(lo?.orderId || '');
              if (war && (o.pimp || o.crack) && oid) (war.orderMap ||= {})[coid] = oid;
              await new Promise((r) => setTimeout(r, 2500));
              let still = (await pendingOrders(o.symbol).catch(() => [])).find((x) => String(x.orderId) === oid);
              if (still) {
                const filled = +(still.filledVolume ?? still.filledQty ?? 0) || 0;
                const sp2 = Math.pow(10, cm[o.symbol]?.sizePlace ?? 4);
                needSize = filled > 0 ? Math.floor((size - filled) * sp2) / sp2 : size;
                await X.cancelOrder(o.symbol, oid).catch(() => {});
                // second bite: requote the REMAINDER at touch — still a
                // passive maker fill, just no pullback discount. Below
                // CHASE_EDGE we never cross the spread, but an unearned
                // discount isn't a reason to skip a qualified entry.
                if (needSize > 0 && EDGE_LIVE.v < CHASE_EDGE) {
                  const q2 = await X.ticker(o.symbol).catch(() => null);
                  const tk2 = Array.isArray(q2) ? q2[0] : q2;
                  const touch2 = sgn > 0 ? +tk2?.bidPr : +tk2?.askPr;
                  if (touch2 > 0) {
                    const lo2 = await limitOrder(o.symbol, sgn > 0 ? 'buy' : 'sell', needSize, round(touch2, cm[o.symbol]?.pricePlace ?? 6), { clientOid: (coid + 'r').slice(0, 38) }).catch(() => null);
                    const oid2 = String(lo2?.orderId || '');
                    if (war && (o.pimp || o.crack) && oid2) (war.orderMap ||= {})[(coid + 'r').slice(0, 38)] = oid2;
                    await new Promise((r) => setTimeout(r, 2000));
                    const still2 = oid2 ? (await pendingOrders(o.symbol).catch(() => [])).find((x) => String(x.orderId) === oid2) : null;
                    if (still2) {
                      const f2 = +(still2.filledVolume ?? still2.filledQty ?? 0) || 0;
                      needSize = f2 > 0 ? Math.floor((needSize - f2) * sp2) / sp2 : needSize;
                      await X.cancelOrder(o.symbol, oid2).catch(() => {});
                    } else if (oid2) needSize = 0;
                  }
                }
              } else needSize = 0;
            }
          } catch { /* limit path failed — taker covers full size below */ }
        }
        if (needSize > 0) {
          if (EDGE_LIVE.v >= CHASE_EDGE || o.setup || o.mandate) {
            const mo = await marketOrder(o.symbol, sgn > 0 ? 'buy' : 'sell', needSize, 'open', { clientOid: (coid + 'm').slice(0, 38) });
            if (war && (o.pimp || o.crack) && mo?.orderId) (war.orderMap ||= {})[(coid + 'm').slice(0, 38)] = String(mo.orderId);
          } else {
            state.actions.push(`${o.symbol}: 🛡️ pullback unfilled — no market chase at edge ${EDGE_LIVE.v.toFixed(2)} < ${CHASE_EDGE}`);
            continue;
          }
        }
        else state.actions.push(`${o.symbol}: 💚 maker fill — taker fee saved`);
        // record the attempt immediately — the fills journal won't see this
        // for ~30s, and the rate cap must count it now (probe loops burn
        // fees per attempt, not per recorded fill)
        (state.entriesLog = state.entriesLog || []).push({
          ts: Date.now(), symbol: o.symbol, direction: o.direction,
          strategy: o.strategy || null, setupId: o.setupId ?? null,
          setupMode: o.setup ? (o.mode || null) : null,
          note: o.setup ? (o.note || null) : null,
          // entry-quality telemetry — the calibration journal needs where
          // in the day's range and at what conviction each entry fired
          rangePosition: Number.isFinite(o.rangePosition) ? o.rangePosition : null,
          changePct: Number.isFinite(o.changePct) ? o.changePct : null,
          score: Number.isFinite(o.score) ? o.score : null,
          conv: Number.isFinite(o.conv) ? o.conv : null,
          marginUsd: round(marginUsd, 2), lev, notionalUsd: round(notional, 2),
          // Van Tharp R-basis: the $ the position loses if the entry stop
          // fires (stop distance + round-trip fee drag on notional). The
          // fills journal joins entries -> closes and grades each close in
          // true R — SQN is only confirmable in R units.
          stopPct: Number.isFinite(o.stopPct) ? o.stopPct : null,
          riskUsd: Number.isFinite(o.stopPct)
            ? round(notional * (o.stopPct / 100 + FEE_RT), 2) : null,
          mktType: o.mktType ?? null,
          // structural evidence — the indicator thesis + the level that
          // would falsify it (EW W1 / wyckoff spring-UTAD extreme)
          structInvalid: o.structInvalid ?? null,
          ewTarget: o.ewTarget ?? null,
          wyckTarget: o.wyckTarget ?? null,
          effortDir: o.effortDir ?? null,
        });
        state.entriesLog = state.entriesLog.slice(-500);
        // commit the attempt NOW — the ledger normally writes at run end;
        // a mid-run kill must still leave this entry visible to the next
        // cycle's dedup/rate caps (belt-and-suspenders under the run lock)
        try { writeJson(outPath, state); } catch {}
        managed.add(o.symbol); // engine-entered — exits apply to managed only
        entriesThisHour++;
        // protective levels anchor to the ACTUAL fill, not the plan's ref
        // price — market orders slip, and a stop quoted off an unfilled
        // reference can sit on the wrong side of price. Same for SIZE: a
        // partial fill must not leave plans quoting the intended size (they
        // trigger-reject 43023) — size protection off what actually filled.
        let fill = o.refEntry, filledSize = size;
        // Bitget's position index trails the fill by seconds — TPSL placed
        // on a not-yet-indexed position returns 43023 and trips the
        // emergency close at full round-trip fees (observed live). Poll
        // until the position is visible before placing protection.
        let pp2 = null;
        for (let i = 0; i < 9 && !pp2; i++) {
          const ps = await getPos().catch(() => []);
          pp2 = ps.find(
            (x) =>
              x.symbol === o.symbol && +x.total > 0 &&
              (!x.holdSide || x.holdSide === (o.direction === 'LONG' ? 'long' : 'short'))
          );
          if (!pp2) await new Promise((r) => setTimeout(r, 1000));
        }
        if (pp2) {
          if (+pp2.openPriceAvg > 0) fill = +pp2.openPriceAvg;
          filledSize = Math.min(size, +pp2.total);
          if (filledSize < size)
            state.actions.push(`◐ partial fill ${o.symbol}: ${filledSize}/${size}`);
        } else {
          state.actions.push(`${o.symbol}: position not visible after 8s — protecting on intended size`);
        }
        // query failed silently (network blip) — proceed on intended size;
        // a confirmed zero-position is handled below when plans land on
        // nothing (exchange rejects with no-position errors, caught by the
        // emergency-close path as benign)
        // staggered TP ladder (reinstated): 45% banks at 0.55x target —
        // first-passage probability of a nearer level is strictly higher,
        // and once it fills the breakeven ratchet makes tranches 2-3 free
        // runners — 35% at the original target, 20% runner at 1.8x target
        // captures the tail a single TP forfeits. EV = sum over tranches of
        // P(reach)*size*dist; the ratchet zeroes post-TP1 downside, so the
        // ladder dominates single-TP for any distribution with a tail.
        const pp = cm[o.symbol]?.pricePlace ?? 6;
        const sp = Math.pow(10, cm[o.symbol]?.sizePlace ?? 4);
        const minQty = Math.max(
          cm[o.symbol]?.minTradeNum || 0,
          (cm[o.symbol]?.minTradeUSDT || 0) / fill
        );
        // plan orders accept sub-minimum sizes (conditional triggers aren't
        // market entries — verified live) — the only real constraints are
        // tranche-1 clearing round-trip fees and nonzero sizes after rounding
        const ladder = o.targetPct * RR.mults[0] >= 0.9;
        // runner distance scales with signal confluence — strong setups
        // earn a longer tail; the optimizer's final leg is the floor, the
        // signal can only extend it
        const runnerMult = Math.max(RR.mults[RR.mults.length - 1], +(o.runnerMult || 0));
        // plan thunks — executed SEQUENTIALLY below. Concurrent
        // place-tpsl-order calls on one fresh position race Bitget's
        // position index (43023/43059 observed live) and the loss plan
        // goes FIRST: if ordering ever constrains placement, the stop is
        // already on the exchange before any TP exists.
        const plans = [];
        plans.push(() =>
          planWithRetry(() =>
            planOrder(
              o.symbol, 'loss_plan',
              // operator setups arm their stop at the OPERATOR'S price —
              // the absolute level is the plan, not a % of the fill
              round(o.setup && +o.absSl > 0 ? +o.absSl : fill * (1 - sgn * (o.stopPct / 100)), pp),
              filledSize, holdSide, pp2?.marginMode || 'isolated'
            )
          )
        );
        if (o.setup && Array.isArray(o.absTps) && o.absTps.length) {
          // operator TP ladder — absolute prices with pct-of-size
          // tranches, cumulative-difference rounding so residue lands in
          // the un-planned remainder that rides the stop (moon bag when
          // the operator's allocations sum <100%)
          let cumF = 0; const opLegs = [];
          for (const t of o.absTps) {
            const tEnd = Math.min(1, cumF + (+t.pct || 0) / 100);
            const ts = (Math.floor(filledSize * tEnd * sp) - Math.floor(filledSize * cumF * sp)) / sp;
            cumF = tEnd;
            if (ts > 0 && ts * fill >= MIN_TRANCHE_USD) opLegs.push({ ts, px: +t.px });
          }
          if (opLegs.length) {
            for (const l of opLegs)
              plans.push(() =>
                planWithRetry(() =>
                  planOrder(
                    o.symbol, 'profit_plan',
                    round(l.px, pp),
                    String(l.ts), holdSide, pp2?.marginMode || 'isolated'
                  )
                )
              );
          } else {
            // too small to split at contract minimums — a whole-position
            // TP at the nearest operator level still banks the plan
            plans.push(() =>
              planWithRetry(() =>
                planOrder(
                  o.symbol, 'pos_profit',
                  round(+o.absTps[0].px, pp),
                  '0', holdSide, pp2?.marginMode || 'isolated'
                )
              )
            );
          }
        } else if (ladder) {
          // 40/30/15 staggered banks — the leftover ~15% is the moon bag:
          // deliberately given NO profit plan so it rides the trailing stop
          // and lets a real winner run past every target
          const cum = RR_CUM;
          const mults = [...RR.mults.slice(0, -1), runnerMult];
          const trancheSizes = [];
          for (let i = 0; i < mults.length; i++) {
            const tsize =
              (Math.floor(filledSize * cum[i + 1] * sp) - Math.floor(filledSize * cum[i] * sp)) / sp;
            if (tsize > 0) trancheSizes.push({ tsize, mult: mults[i] });
          }
          // a single surviving tranche protects only a fraction of the
          // position — fall back to one full-size TP instead
          if (trancheSizes.length >= 2) {
            for (const tr of trancheSizes)
              plans.push(() =>
                planWithRetry(() =>
                  planOrder(
                    o.symbol, 'profit_plan',
                    round(fill * (1 + sgn * (o.targetPct * tr.mult) / 100), pp),
                    String(tr.tsize), holdSide, pp2?.marginMode || 'isolated'
                  )
                )
              );
          } else {
            plans.push(() =>
              planWithRetry(() =>
                planOrder(
                  o.symbol, 'profit_plan',
                  round(fill * (1 + sgn * (o.targetPct / 100)), pp),
                  filledSize, holdSide, pp2?.marginMode || 'isolated'
                )
              )
            );
          }
        } else {
          plans.push(() =>
            planWithRetry(() =>
              planOrder(
                o.symbol, 'profit_plan',
                round(fill * (1 + sgn * (o.targetPct / 100)), pp),
                filledSize, holdSide, pp2?.marginMode || 'isolated'
              )
            )
          );
        }
        for (const fn of plans) await fn();
        const usedMargin = (filledSize * fill) / lev;
        marginFree = Math.max(0, marginFree - usedMargin);
        // observable execution quality: slippage vs the scanner's reference
        // print + how long the fill took to confirm — the journal that
        // proves whether modeled SLIP_PCT matches reality
        const slipPct = ((fill - o.refEntry) / o.refEntry) * 100 * sgn;
        state.actions.push(
          `opened ${o.symbol} ${o.direction} ${filledSize} @~${round(fill, 6)} lev ${lev}x margin $${round(usedMargin, 2)} notional $${round(filledSize * fill, 2)} · slip ${slipPct >= 0 ? '+' : ''}${round(slipPct, 3)}% · ${Date.now() - t0}ms`
        );
        opened++;
        openedSym.add(o.symbol);
      } catch (e) {
        // unroutable symbols get recorded so the scanner stops emitting
        // entries the exchange can't hold: 40805 'Unsupported operation'
        // (RWA perps listed but not orderable) and 40034 'does not exist'
        // (sim priced an asset that has no futures contract — PAXGUSDT)
        if (/40805|40034|unsupported|does not exist/i.test(e.message)) {
          state.untradeable = [...new Set([...(state.untradeable || []), o.symbol])];
        }
        // Two distinct failures share this catch: the market order rejected
        // (40762 et al — NO position exists, nothing to protect, don't arm
        // the halt) vs a fill followed by protection failure (naked on the
        // exchange — emergency close + 30min entry halt so the next cycle
        // doesn't re-probe at full round-trip fees).
        const p = posBySym.get(o.symbol) ||
          (await getPos().catch(() => [])).find((x) => x.symbol === o.symbol && +x.total > 0);
        if (!p) {
          state.errors.push(`open ${o.symbol}: ${e.message}`);
          // 40762 = Bitget's own margin math says we're out — trust it over
          // our estimate for the rest of this cycle or every remaining
          // order retries the same doomed probe (fee-churn + error spam)
          if (/40762|exceeds the balance/i.test(e.message)) { marginFree = 0; break; }
          continue;
        }
        state.protectionHaltUntil = Date.now() + 30 * 60e3;
        state.errors.push(`open ${o.symbol}: ${e.message} — attempting emergency close`);
        try {
          await cancelPlans(o.symbol);
          await closePosition(o.symbol, p.holdSide || p.side);
          state.actions.push(`🚨 emergency-closed ${o.symbol} (protection failed)`);
        } catch (e2) {
          state.errors.push(`EMERGENCY CLOSE FAILED ${o.symbol}: ${e2.message}`);
        }
        break; // one failed probe is enough — don't burn fees probing the rest
      }
    }

    // ---- setup resolve: orders injected this cycle landed in openedSym
    // on success — anything else hit a gate and is terminal (operator
    // sees the reject gate as the reason). Then persist the queue state
    // and publish the public status board the dashboard renders.
    for (const s of setupSeen) {
      if (s.status !== 'triggered') continue;
      if (openedSym.has(s.symbol)) {
        s.status = 'filled'; s.filledAt = Date.now(); s.fillPx = s.lastPx ?? null;
        setupArms[s.symbol] = { id: s.id, slPx: +s.slPx || null, tps: s.tps || [], since: s.filledAt };
        armsDirty = true;
      } else {
        const r = (state.rejects || []).filter((x) => x.symbol === s.symbol).at(-1);
        s.status = 'failed'; s.reason = r?.gates?.join('+') || 'entry-gated';
      }
    }
    if (setupDirty) {
      setupFile.setups = setupFile.setups.slice(-50); // bound the audit trail
      try {
        const tmp = setupPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(setupFile));
        fs.renameSync(tmp, setupPath);
      } catch (e) { state.errors.push(`setups persist: ${e.message}`); }
    }
    if (setupFile?.setups?.length) {
      try {
        writeJson(path.join(API_DIR, 'setups.json'), {
          refreshedAt: new Date().toISOString(),
          setups: setupFile.setups.map((s) => ({
            id: s.id, symbol: s.symbol, direction: s.direction, mode: s.mode,
            entryPx: s.entryPx ?? null, breakPx: s.breakPx ?? null, slPx: s.slPx ?? null,
            tps: s.tps || [], riskPct: s.riskPct ?? null, be: !!s.be,
            status: s.status || 'armed', stage: s.stage || null,
            reason: s.reason || null, blockedBy: s.blockedBy || null,
            lastPx: s.lastPx ?? null, fillPx: s.fillPx ?? null,
            note: s.note || null, by: s.by || null, strategy: s.strategy || null,
            createdAt: s.createdAt || null, triggeredAt: s.triggeredAt || null,
            filledAt: s.filledAt || null,
          })),
        });
      } catch (e) { state.errors.push(`setups api: ${e.message}`); }
    }
  }

  // ---- deployment mandate: capital never idles. When the order queue is
  // exhausted (gated/cooldowns/denied) but margin remains, top up the
  // strongest open positions — pyramiding winners, NEVER averaging losers.
  // unified deployment rail — entriesBlocked covers the loss breaker, DD
  // kill-switch, massacre governor and CUSUM edge-death. A breaker that
  // gates the queue but not pyramiding is no breaker (CLU autopsy: top-ups
  // re-bought the stopped position 53s later, mid fee-halt).
  if (!protectionHalted && !cmdFlat && !feeHalted && !entriesBlocked && marginFree > TOPUP_FLOOR_USD) {
    const capUsd = equityUsd * +(process.env.SENTINEL_POS_CAP_PCT || 0.85);
    // pyramiding throttle: persisted because rapid mode respawns the process
    // each cycle. One add per position per window, and only while the trade
    // keeps paying (upl above the last add's mark). Without it the loop
    // churns — observed on the Bybit book: ~10 adds/trims in an hour.
    const TOPUP_GAP_MS = +(process.env.SENTINEL_TOPUP_GAP_MS || 15 * 60e3);
    const throttlePath = path.join(__dirname, '..', 'state', `topup-throttle${BOOK_TAG}.json`);
    let throttle = {};
    try { throttle = JSON.parse(fs.readFileSync(throttlePath, 'utf8')); } catch {}
    let throttleDirty = false;
    const winners = [...posBySym.values()]
      .filter((p) => +p.upl > 0 && !MANUAL.has(p.symbol) && !DENY_SYMS.has(p.symbol) && (p.marginMode || '') !== 'crossed')
      .sort((a, b) => (b.upl / (b.size * b.entry)) - (a.upl / (a.size * a.entry)))
      .slice(0, TOPUP_MAX);
    for (const p of winners) {
      if (p.symbol === VAULT_SYM) continue; // vault grows via sweeps, not top-ups
      if (!(marginFree > TOPUP_FLOOR_USD)) break;
      try {
        const tk = await X.ticker(p.symbol);
        const t0 = Array.isArray(tk) ? tk[0] : tk; // adapters return the array row shape
        const px = +(t0?.lastPr || t0?.markPr || 0);
        if (!(px > 0)) continue;
        const lev = Math.max(1, Math.min(Math.max(+p.lev || 10, LEV_FLOOR), +(process.env.SENTINEL_MAX_LEV || 40)));
        // room is measured with the SAME ruler the margin-rebalance gate
        // uses (size*entry/lev), not the exchange-reported marginSize: on
        // cross-margin venues positionIM diverges from posted margin during
        // flux, so top-up saw room where rebalance saw excess and the two
        // fought every cycle — buy ~$1.2k notional, trim it back, repeat.
        // Same ruler => top-up can never push past what rebalance tolerates.
        const levNow = Math.max(1, p.lev || 1);
        const marginEst = (p.size * p.entry) / levNow;
        const room = Math.max(0, capUsd - marginEst);
        if (room <= Math.max(0.5, capUsd * 0.15)) continue; // at cap — same tolerance as rebalance
        const lt = throttle[p.symbol];
        if (lt && Date.now() - lt.ts < TOPUP_GAP_MS) continue;
        if (lt && +p.upl <= +lt.upl) continue; // add only while the trade keeps improving
        // post-loss ban: a losing close on this symbol benches re-adds for
        // the re-entry window. Observed live: CLU stopped at a loss 11:41,
        // top-up re-bought it 53s later — a stop-out is not a dip to buy.
        const lc = lastLossCloseBySym[p.symbol];
        if (lc && Date.now() - lc < REENTRY_MS) {
          state.actions.push(`${p.symbol}: top-up banned — losing close ${Math.round((Date.now() - lc) / 6e4)}m ago (< ${Math.round(REENTRY_MS / 6e4)}m)`);
          continue;
        }
        // pyramid-gap guard: never let an add drag blended entry within a
        // scratch of the live stop. At high lev the pyramid stacks entry on
        // top of the stop — a 0.5% dip then realises the whole pile as a
        // loss (CLU −$24: adds pushed avg ~92.4 over stop ~91.9).
        const TOPUP_STOP_GAP_PCT = +(process.env.SENTINEL_TOPUP_STOP_GAP_PCT || 0.4);
        try {
          const lp = (await getPlans(p.symbol).catch(() => []))
            .find((x) => /loss|stop|moving/i.test(x.planType || ''));
          const slPx = +lp?.triggerPrice || 0;
          if (slPx > 0) {
            const marginUsd0 = Math.min(marginFree, room) / (1 + lev * 0.0012 * 1.3);
            const addSz = sizeFor(cm, p.symbol, marginUsd0 * lev, px) || 0;
            const blend = (p.entry * p.size + px * addSz) / Math.max(1e-12, p.size + addSz);
            const gapPct = (Math.abs(blend - slPx) / blend) * 100;
            const underStop = p.side === 'long' ? px <= slPx : px >= slPx;
            if (underStop || gapPct < TOPUP_STOP_GAP_PCT) {
              state.actions.push(`${p.symbol}: top-up skipped — add would stack blended entry ${round(blend, 4)} within ${round(gapPct, 2)}% of stop ${slPx}`);
              continue;
            }
          }
        } catch {}
        const marginUsd = Math.min(marginFree, room) / (1 + lev * 0.0012 * 1.3) * ddRiskScale; // same fee headroom as entries; session-DD shrinks size
        const size = sizeFor(cm, p.symbol, marginUsd * lev, px);
        if (!size) { state.actions.push(`${p.symbol}: top-up skipped — below contract minimum`); continue; }
        await marketOrder(p.symbol, p.side === 'short' ? 'sell' : 'buy', size, 'open');
        marginFree -= marginUsd;
        throttle[p.symbol] = { ts: Date.now(), upl: +p.upl };
        throttleDirty = true;
        // top-ups are real entries — journal them so dedup, rate stats and
        // the calibration layer count the deployment, strategy:'top-up'
        // keeps them separable from signal entries
        (state.entriesLog = state.entriesLog || []).push({
          ts: Date.now(), symbol: p.symbol, direction: p.side === 'short' ? 'SHORT' : 'LONG',
          strategy: 'top-up', marginUsd: round(marginUsd, 2), lev, notionalUsd: round(marginUsd * lev, 2),
          mktType: (plan?.mktType) ?? null,
        });
        p.margin = (+p.margin || 0) + marginUsd;
        p.size += +size || 0; // keep the in-cycle ruler honest on repeat adds
        state.actions.push(`➕ top-up ${p.symbol}: +${size} ${p.side} @~${px} — deployed leftover margin (upl ${round(p.upl, 2)})`);
      } catch (e) { state.errors.push(`➕ top-up ${p.symbol}: ${e.message}`); }
    }
    if (throttleDirty) try { fs.writeFileSync(throttlePath, JSON.stringify(throttle)); } catch {}
  }
  // idle-margin explainer: capital left undeployed carries its reason on
  // the ledger — the dashboard answers "why is money sitting" itself
  if (marginFree > 0.01) {
    const capUsd = equityUsd * +(process.env.SENTINEL_POS_CAP_PCT || 0.85);
    const winners = [...posBySym.values()].filter((p) => +p.upl > 0 && (p.margin || 0) < capUsd);
    state.idleMargin = {
      usd: round(marginFree, 2),
      reason: marginFree <= TOPUP_FLOOR_USD ? 'below top-up floor + contract minimums — dust, undeployable'
        : entriesBlocked ? `deployment rail down — ${entriesBlocked}`
        : protectionHalted ? 'protection-halt active — entries and top-ups paused'
        : cmdFlat ? 'flatten pending — refusing to deploy into a closing book'
        : !winners.length ? 'no profitable positions below cap to top up (never averages losers)'
        : 'winners capped or add-size below contract minimum',
    };
  } else delete state.idleMargin;

  // ---- real fill journal: pull the exchange's fill list, dedupe into a
  // persistent store, expose the last 50 on the ledger. This is the actual
  // track record — fees and profits as charged, not modeled.
  try {
    const fillsPath = path.join(__dirname, '..', 'state', FILLS_FILE);
    let store = { fills: [] };
    try { store = JSON.parse(fs.readFileSync(fillsPath, 'utf8')); } catch {}
    if (!Array.isArray(store.fills)) store.fills = [];
    // epoch reset: pre-test account history is dropped from the journal
    // entirely — the count starts clean, not merely filtered at read time
    if (FILLS_SINCE) store.fills = store.fills.filter((f) => (+f.ts || 0) >= FILLS_SINCE);
    const seen = new Set(store.fills.map((f) => f.tradeId));
    const byId = new Map(store.fills.map((f) => [f.tradeId, f]));
    let added = 0;
    let repaired = 0;
    for (const f of await getFills().catch(() => [])) {
      const id = f.tradeId || f.fillId || `${f.orderId}:${f.cTime}`;
      if (!id) continue;
      // pre-epoch exchange fills never enter the test journal
      if (FILLS_SINCE && +(f.cTime ?? f.uTime ?? 0) < FILLS_SINCE) continue;
      // exchange fees arrive NEGATIVE (a charge) — journal stores the
      // positive magnitude; every consumer subtracts it. feeDetail can hold
      // several legs (multi-coin splits) — sum them all, not just [0].
      const feeRaw = Array.isArray(f.feeDetail) && f.feeDetail.length
        ? f.feeDetail.reduce((a, d) => a + (+d.totalFee || 0), 0)
        : +(f.fee ?? f.totalFee ?? 0);
      const fee = Math.abs(feeRaw);
      const size = +(f.baseVolume ?? f.size ?? f.volume ?? f.qty ?? 0);
      // backfill: entries recorded before the feeDetail/baseVolume fix
      // carry fee=0/size=0 — patch them from the exchange record
      if (seen.has(id)) {
        const old = byId.get(id);
        // also patch fills missing ONLY the src tag — otherwise every
        // pre-attribution record stays 'legacy' forever even though the
        // exchange's own record carries enterPointSource
        if (old && (!old.fee || !old.size || (!old.src && f.enterPointSource))) {
          if (!old.fee) old.fee = fee;
          if (!old.size) old.size = size;
          if (f.quoteVolume) old.notionalUsd = +f.quoteVolume;
          if (f.tradeSide) old.tradeSide = f.tradeSide;
          if (!old.src && f.enterPointSource) old.src = f.enterPointSource;
          // patched fields change the record — recompute fcrc exactly as
          // crc32-verify does (strip the tag, checksum the rest) or every
          // repaired fill flags as corrupt on the next audit pass
          const { fcrc: _stale, ...rest } = old;
          old.fcrc = crc32hex(JSON.stringify(rest));
          repaired++;
        }
        continue;
      }
      seen.add(id);
      const rec = {
        tradeId: id,
        orderId: f.orderId != null ? String(f.orderId) : null,
        symbol: f.symbol,
        side: f.side,
        price: +f.price,
        size,
        notionalUsd: +(f.quoteVolume ?? 0),
        fee,
        profit: +(f.profit ?? 0),
        tradeSide: f.tradeSide || null,
        src: f.enterPointSource || null, // 'api' = bot · 'ios'/'android'/'web' = manual
        ts: +(f.cTime ?? f.uTime ?? Date.now()),
        // regime attribution — the entriesLog carries mktType at decision
        // time; on a close we look back and stamp which market type the
        // position was opened in, so per-regime expectancy stays honest
        mktAtEntry: f.tradeSide === 'close'
          ? (state.entriesLog || []).filter((e) => e.symbol === f.symbol && e.ts <= +(f.cTime ?? f.uTime ?? Date.now())).pop()?.mktType ?? null
          : null,
        // structural thesis that opened this trade — journaled onto the
        // close so expectancy can be sliced by evidence type later
        structInvalid: f.tradeSide === 'close'
          ? (state.entriesLog || []).filter((e) => e.symbol === f.symbol && e.ts <= +(f.cTime ?? f.uTime ?? Date.now())).pop()?.structInvalid ?? null
          : null,
        // R-basis: the $ risk the entry planned (top-ups don't log riskUsd,
        // so the join naturally lands on the primary entry). The SQN block
        // below only counts closes whose R-unit is on the record — foreign
        // or pre-instrumentation closes are ungraded, not guessed.
        riskUsd: f.tradeSide === 'close'
          ? (state.entriesLog || []).filter((e) => e.symbol === f.symbol && e.ts <= +(f.cTime ?? f.uTime ?? Date.now()) && e.riskUsd > 0).pop()?.riskUsd ?? null
          : null,
      };
      // per-record checksum — proves WHICH fill changed, not just that
      // the file did; recomputed by crc32-verify.mjs on every audit pass
      rec.fcrc = crc32hex(JSON.stringify(rec));
      store.fills.unshift(rec);
      added++;
    }
    if (added || repaired) {
      // newest-first is REQUIRED downstream (cooldown slices [0,2], the
      // rolling entry window, the journal) — unshift order depends on the
      // API's return direction, so sort explicitly rather than trust it
      store.fills.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      store.fills = store.fills.slice(0, 400);
      writeJson(fillsPath, store);
    }
    // tag AFTER the merge so this cycle's fresh closes attribute too —
    // fills appended above would otherwise read as bot until next run
    tagManualCloses(store.fills);
    state.realFills = store.fills.slice(0, 50);
    state.realFillCount = store.fills.length;
    // ---- manual book + churn meter: a held symbol whose most recent OPEN
    // fill came from the app (src ios/android/web) is operator-originated —
    // liq-guard runs it under the bagrunner profile (fee-lock at ~breakeven,
    // dense greedy trail, fast vanish). Closes don't need qty bookkeeping:
    // the flag rides the journal's newest-first order and only held
    // symbols matter downstream.
    try {
      const lastOpen = {};
      for (const f of store.fills) {
        if (f.tradeSide !== 'open' || !f.symbol || lastOpen[f.symbol]) continue;
        lastOpen[f.symbol] = f;
      }
      const held = new Set(posBySym.keys());
      const manSyms = Object.entries(lastOpen)
        .filter(([sym, f]) => held.has(sym) && f.src && f.src !== 'api')
        .map(([sym]) => sym);
      writeJson(path.join(__dirname, '..', 'state', 'manual-book.json'), { at: Date.now(), syms: manSyms });
      // 24h churn meter — manual opens are the fee bleed the audit caught;
      // page the operator when the daily toll crosses thresholds (once each)
      const day = store.fills.filter((f) => f.src && f.src !== 'api' && (nowMs - (f.ts || 0)) < 864e5);
      const manFees = day.reduce((a, f) => a + (+f.fee || 0), 0);
      const manOpens = day.filter((f) => f.tradeSide === 'open').length;
      state.manualChurn = { opens24h: manOpens, fees24hUsd: round(manFees, 2) };
      const FLAGS = [5, 10, 20];
      const flags = (state.manualChurnFlags ||= {});
      for (const lvl of FLAGS) {
        const dayKey = `${lvl}:${new Date().toISOString().slice(0, 10)}`;
        if (manFees >= lvl && !flags[dayKey]) {
          flags[dayKey] = 1;
          const msg = `🎰 OPERATOR FEE BURN — ${manOpens} manual opens / $${manFees.toFixed(2)} fees in 24h. Bagrunner rule: fees must come back before the trade ends — let the trail work or don't take the trade.`;
          state.actions.push(msg);
          try {
            fs.appendFileSync(path.join(__dirname, '..', 'state', 'tg-outbox.jsonl'),
              JSON.stringify({ at: Date.now(), text: msg }) + '\n');
          } catch {}
        }
      }
    } catch (e) { state.errors.push(`manual-book: ${e.message}`); }
    // ---- wealth vault — high-water-mark incentive fee ----
    // VAULT_SHARE of net-new total-equity highs moves out of the tradable
    // book, permanently: the engine collects carry only when NAV (epoch
    // baseline + cumulative journaled net, or live exchange equity) makes
    // a new high — nothing is banked while the book is underwater.
    // SweptIds dedupes so a fill can never double-pay; the balance
    // subtracts from equity at the top of every cycle.
    if (VAULT_SHARE > 0) {
      try {
        const vault = loadVault();
        vault.sweptIds ||= {}; vault.sweeps ||= [];
        vault.hwmUsd = Math.max(vault.hwmUsd || 0, EQ_OVERRIDE || 0);
        const hwmLoaded = vault.hwmUsd;
        // navNow counts vault holdings still alive — lostUsd is real money
        // already lost (the USELESS bag); adding it back would inflate NAV
        // and mint carry room on a drawdown the vault already ate.
        const navNow = EQ_OVERRIDE > 0 ? EQ_OVERRIDE + epochNet : equityUsd + (vault.balanceUsd || 0) - (vault.lostUsd || 0);
        // room = the above-water tranche created since the last high.
        // Each profitable fill consumes `net` of it (swept or not) — total
        // carry lands at exactly SHARE × net-new-high NAV across a cycle.
        let room = Math.max(0, navNow - vault.hwmUsd);
        let chg = 0;
        for (const f of store.fills) {
          if (vault.sweptIds[f.tradeId]) continue;
          const net = (+f.profit || 0) - (+f.fee || 0);
          if (!(net > 0)) continue;
          const amt = Math.max(0, Math.min(net * VAULT_SHARE, room));
          room = Math.max(0, room - net);
          if (!(amt > 0)) { vault.sweptIds[f.tradeId] = 1; continue; }
          // transfer mode: the carry must actually MOVE to spot before it
          // counts as vaulted — a failed transfer records an error and the
          // fill stays unswept for next cycle's retry (dedup marks only on
          // success, so nothing mints phantom carry).
          if (VAULT_TRANSFER) {
            try {
              await vaultTransfer(amt);
              vault.transferredUsd = round((vault.transferredUsd || 0) + amt, 4);
            } catch (e) {
              state.errors.push(`vault transfer ${f.symbol} $${round(amt, 2)}: ${String(e.message || e).slice(0, 100)}`);
              continue;
            }
          }
          vault.sweptIds[f.tradeId] = 1;
          vault.sweeps.push({ ts: f.ts || Date.now(), tradeId: f.tradeId, symbol: f.symbol, amountUsd: round(amt, 4), hwm: round(navNow, 2), moved: VAULT_TRANSFER ? 'spot' : 'accounting' });
          vault.balanceUsd = round(vault.balanceUsd + amt, 4);
          chg += amt;
        }
        vault.hwmUsd = round(Math.max(vault.hwmUsd, navNow), 4);
        state.vaultHwmUsd = vault.hwmUsd;
        // persist on ANY state change — hwmUsd must survive the per-cycle
        // reload or the mark never ratchets: every cycle would re-open
        // `navNow - 65` room and keep paying carry on the same tranche.
        if (chg > 0 || vault.hwmUsd !== hwmLoaded || !vault.updatedAt) {
          vault.sweeps = vault.sweeps.slice(-1000);
          // sweptIds is a dedupe map — one key per sweep forever. Cap it:
          // ids older than the newest 5000 entries can never reappear in a
          // bounded fill journal anyway (fills roll off before ids recur).
          const ids = Object.keys(vault.sweptIds || {});
          if (ids.length > 5000) {
            const keep = new Set(vault.sweeps.slice(-5000).map((s) => s.tradeId));
            for (const k of ids) if (!keep.has(k)) delete vault.sweptIds[k];
          }
          vault.updatedAt = new Date().toISOString();
          writeJson(VAULT_PATH, vault);
        }
        if (chg > 0)
          state.actions.push(`🏦 vault carry: +$${round(chg, 2)} banked at HWM $${round(vault.hwmUsd, 2)} — untouchable total $${round(vault.balanceUsd, 2)}`);
        // vault deploy: pending carry moves futures->spot and buys the
        // mandate asset (operator 2026-10-09: USELESS on spot — accumulates,
        // can't liquidate). Batched at VAULT_BUY_MIN_USD (spot min order) so
        // fees stay a small fraction; deployedUsd tracks cost basis, spot
        // assets reconcile the qty. Migration: a legacy deployedUsd from a
        // dead mandate gets written off to lostUsd — pending can't pretend
        // it still exists.
        try {
          if (vault.asset !== VAULT_BUY_COIN && (vault.deployedUsd || 0) > 0) {
            vault.lostUsd = round((vault.lostUsd || 0) + vault.deployedUsd, 4);
            vault.sweeps.push({ ts: Date.now(), symbol: VAULT_SYM, amountUsd: -vault.deployedUsd, hwm: vault.hwmUsd, moved: 'writeoff-legacy' });
            vault.deployedUsd = 0;
            writeJson(VAULT_PATH, vault);
            state.actions.push(`🏦 vault write-off: legacy bag $${round(vault.lostUsd, 2)} marked lost — vault asset -> ${VAULT_BUY_COIN} spot`);
          }
          vault.asset = VAULT_BUY_COIN;
          const pendingFutures = round((vault.balanceUsd || 0) - (vault.transferredUsd || 0) - (vault.lostUsd || 0), 4);
          const spotPending = round((vault.transferredUsd || 0) - (vault.deployedUsd || 0), 4);
          // perms gate — the Bitget key needs spot order write + wallet
          // transfer write. On 40014 hold carry in futures and re-probe
          // every 30min; don't burn an API call every cycle on a dead perm.
          const permsOk = vault.permsOk !== false || Date.now() - (vault.permsProbeAt || 0) > 30 * 60e3;
          try {
            if (permsOk && pendingFutures + spotPending >= VAULT_BUY_MIN_USD) {
              const spendable = Math.max(0, (+acct.available || 0) - 1); // $1 ops reserve stays
              const moveUsd = round(Math.min(pendingFutures, spendable), 2);
              if (moveUsd >= VAULT_BUY_MIN_USD) {
                await vaultTransfer(moveUsd); // futures -> spot — throws 40014 without transfer-write perm
                vault.transferredUsd = round((vault.transferredUsd || 0) + moveUsd, 4);
                writeJson(VAULT_PATH, vault);
                state.actions.push(`🏦 vault transfer: $${round(moveUsd, 2)} futures->spot (carry earmark)`);
              }
              const buyUsd = round((vault.transferredUsd || 0) - (vault.deployedUsd || 0), 4);
              if (buyUsd >= VAULT_BUY_MIN_USD && X.spotMarketBuy) {
                const bo = await X.spotMarketBuy(VAULT_BUY_SYM, buyUsd);
                vault.deployedUsd = round((vault.deployedUsd || 0) + buyUsd, 4);
                (vault.buys ||= []).push({ ts: Date.now(), usd: buyUsd, sym: VAULT_BUY_SYM, orderId: bo?.orderId || null });
                writeJson(VAULT_PATH, vault);
                state.actions.push(`🏦 vault deploy: $${round(buyUsd, 2)} -> ${VAULT_BUY_COIN} spot · cost basis $${round(vault.deployedUsd, 2)}`);
              }
              vault.permsOk = true;
            }
            // holdings truth = the exchange's own spot balance, not a
            // ledger estimate — a dead bag can't hide behind deployedUsd
            if (permsOk && X.spotAssets) {
              const assets = await X.spotAssets(); // 40014 propagates -> perms gate below
              const coin = assets.find((a) => a.coin === VAULT_BUY_COIN);
              const qty = coin ? (+coin.available || 0) + (+coin.frozen || 0) + (+coin.locked || 0) : 0;
              const tk = await X.ticker(VAULT_BUY_SYM).catch(() => null);
              const t0 = Array.isArray(tk) ? tk[0] : tk;
              const px = +(t0?.lastPr || t0?.markPr || 0);
              vault.assetQty = round(qty, 8);
              vault.assetUsd = round(qty * px, 2);
              vault.btcQty = vault.assetQty; vault.btcUsd = vault.assetUsd; // dashboard compat keys
              writeJson(VAULT_PATH, vault);
              state.vaultAssetQty = vault.assetQty;
              state.vaultAssetUsd = vault.assetUsd;
            }
          } catch (e) {
            if (/40014|permission/i.test(String(e.message || e))) {
              vault.permsOk = false;
              vault.permsProbeAt = Date.now();
              writeJson(VAULT_PATH, vault);
              state.errors.push('vault deploy paused: API key needs spot-trade + wallet-transfer perms (40014) — carry held in futures');
            } else throw e;
          }
          if (vault.permsOk === false)
            state.actions.push('🏦 vault: carry held in futures — Bitget key missing spot/transfer perms, re-probing every 30min');
          // vaultUsd = holdings value: pending futures USDT + unbought
          // spot USDT + BTC at mark (last reconciled qty × live price)
          state.vaultUsd = round(
            Math.max(0, pendingFutures) + Math.max(0, spotPending) + (vault.btcUsd || 0), 2);
        } catch (e) {
          state.errors.push('vault deploy failed: ' + String(e.message || e).slice(0, 100));
        }
      } catch (e) {
        state.errors.push('vault sweep failed: ' + String(e).slice(0, 100));
      }
    }
    // realized scoreboard from the exchange's own record — close fills
    // carry realized profit; net-of-fee win rate is the number that matters
    const closes = store.fills.filter((f) => f.tradeSide === 'close' || (f.profit || 0) !== 0);
    const netCloses = closes.filter((f) => f.profit != null);
    const allFees = store.fills.reduce((a, f) => a + (f.fee || 0), 0);
    // a fill's true cost = its own fee + the ~0.06% taker on its entry side —
    // close-side-only accounting was flattering the record by ~40% of costs
    const netOfFee = (f) => f.profit - (f.fee || 0) - (f.notionalUsd || 0) * 0.0006;
    const wins = netCloses.filter((f) => netOfFee(f) > 0);
    const grossW = wins.reduce((a, f) => a + netOfFee(f), 0);
    const grossL = Math.abs(
      netCloses.filter((f) => netOfFee(f) <= 0).reduce((a, f) => a + netOfFee(f), 0)
    );
    const statsFor = (rows) => {
      const cl = rows.filter((f) => f.tradeSide === 'close' || (f.profit || 0) !== 0).filter((f) => f.profit != null);
      const fees = rows.reduce((a, f) => a + (f.fee || 0), 0);
      const w = cl.filter((f) => netOfFee(f) > 0);
      const gW = w.reduce((a, f) => a + netOfFee(f), 0);
      const gL = Math.abs(cl.filter((f) => netOfFee(f) <= 0).reduce((a, f) => a + netOfFee(f), 0));
      return {
        closes: cl.length,
        winRatePct: cl.length ? round((w.length / cl.length) * 100, 1) : null,
        netUsd: round(cl.reduce((a, f) => a + f.profit, 0) - fees, 4),
        feesUsd: round(fees, 4),
        profitFactor: gL > 0 ? round(gW / gL, 2) : null,
      };
    };
    const openTs = store.fills.filter((f) => f.tradeSide === 'open').map((f) => +f.ts || Infinity);
    const epochTs = openTs.length ? Math.min(...openTs) : Infinity;
    const posGroups = groupIntoPositions(netCloses, state.entriesLog, netOfFee, epochTs);
    state.realizedStats = {
      // scope: every close-side fill incl. foreign/manual fills — the raw
      // journal total. trades-taken.json episodes aggregate differently.
      scope: 'all close fills (incl. foreign)',
      closes: netCloses.length,
      winRatePct: netCloses.length ? round((wins.length / netCloses.length) * 100, 1) : null,
      // bottom line = realized profit minus EVERY fee on record — the old
      // netUsd only deducted close-side fees, hiding the entry toll
      netUsd: round(netCloses.reduce((a, f) => a + f.profit, 0) - allFees, 4),
      feesUsd: round(allFees, 4),
      profitFactor: grossL > 0 ? round(grossW / grossL, 2) : null,
      // attribution split: enterPointSource 'api' = this engine; ios/android/
      // web = manual account trading; null = legacy fill recorded pre-tag
      bySource: {
        bot: statsFor(store.fills.filter((f) => f.src === 'api' && !f._manual)),
        manual: statsFor(store.fills.filter((f) => (f.src && f.src !== 'api') || f._manual)),
        legacy: statsFor(store.fills.filter((f) => !f.src && !f._manual)),
      },
      // the headline number an investor should quote — per-POSITION record.
      // The fill-level stats above stay (every realized dollar is real) but
      // their win rate is architecture-biased: the trim ladder fragments one
      // trade into many journaled 'closes'.
      byPosition: (() => {
        const pg = posGroups.filter((g) => !g.preEpoch);
        const pre = posGroups.filter((g) => g.preEpoch);
        const pW = pg.filter((g) => g.netUsd > 0), pL = pg.filter((g) => g.netUsd <= 0);
        return {
          scope: 'close fills grouped into positions via entriesLog join (riskUsd entry anchor); campaign:* = pre-instrumentation clusters by symbol+side; preEpoch excluded from headline',
          positions: pg.length,
          winners: pW.length,
          winRatePct: pg.length ? round((pW.length / pg.length) * 100, 1) : null,
          netUsd: round(pg.reduce((a, g) => a + g.netUsd, 0), 4),
          expectancyUsd: pg.length ? round(pg.reduce((a, g) => a + g.netUsd, 0) / pg.length, 4) : null,
          avgWinUsd: pW.length ? round(pW.reduce((a, g) => a + g.netUsd, 0) / pW.length, 4) : null,
          avgLossUsd: pL.length ? round(pL.reduce((a, g) => a + g.netUsd, 0) / pL.length, 4) : null,
          // pre-epoch legacy closes (opened before journaled entries) — real
          // dollars on the ledger, excluded from the model's WR/expectancy
          preEpoch: pre.length ? {
            positions: pre.length,
            netUsd: round(pre.reduce((a, g) => a + g.netUsd, 0), 4),
          } : undefined,
          rows: pg.slice(0, 15).map((g) => ({ symbol: g.symbol, side: g.side, fills: g.fills, netUsd: round(g.netUsd, 4), riskUsd: g.riskUsd, key: g.key.startsWith('pos:') ? null : 'campaign' })),
        };
      })(),
    };
    // Van Tharp SQN — graded in true R at POSITION level: a position's total
    // net divided by the risk its entry planned. Per-fill R fragments one
    // trade's R across its trim ladder (12 trims at +0.7R each is one
    // +8.4R trade, not twelve +1R trades). n>=30 is the honest sample floor.
    const rGroups = posGroups.filter((g) => g.riskUsd > 0);
    if (rGroups.length) {
      const rs = rGroups.map((g) => g.netUsd / g.riskUsd);
      const m = rs.reduce((a, x) => a + x, 0) / rs.length;
      const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, x) => a + (x - m) ** 2, 0) / (rs.length - 1)) : 0;
      state.sqnR = {
        unit: 'position',
        n: rGroups.length,
        meanR: round(m, 3),
        sdR: round(sd, 3),
        sqn: sd > 0 ? round((m / sd) * Math.sqrt(rGroups.length), 2) : null,
        winRatePct: round((rs.filter((x) => x > 0).length / rs.length) * 100, 1),
        avgWinR: (() => { const w = rs.filter((x) => x > 0); return w.length ? round(w.reduce((a, x) => a + x, 0) / w.length, 3) : null; })(),
        avgLossR: (() => { const l = rs.filter((x) => x <= 0); return l.length ? round(l.reduce((a, x) => a + x, 0) / l.length, 3) : null; })(),
        note: 'positions graded in true R (total net-of-fee / entry risk). n>=30 before trusting the point estimate.',
      };
    } else delete state.sqnR;
  } catch (e) {
    state.errors.push(`fills journal: ${e.message}`);
  }

  // ---- all-time record across every real fill journal this deployment has
  // ever written (live + demo books). Reporting only — the risk tier stays
  // keyed to the live book's own sqnR.
  try {
    const allBooks = {};
    const allEpis = [];
    for (const [bk, fname] of Object.entries({
      'bitget-demo': 'demo-fills.json',
      'bybit-demo': 'demo-fills-bybit.json',
      'bitget-live': 'real-fills.json',
    })) {
      let fs2 = [];
      try { fs2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', fname), 'utf8')).fills || []; } catch {}
      // epoch boundary — the same SENTINEL_FILLS_SINCE_MS reset that zeroes
      // the headline record zeroes the all-time aggregate too; a 'since'
      // filter that only half-applies is a stats leak, not a clean start.
      if (FILLS_SINCE) fs2 = fs2.filter((f) => (+f.ts || 0) >= FILLS_SINCE);
      const epis = fifoEpisodes(fs2);
      // strategy attribution — entriesLog belongs to this mode's own journal,
      // so it only joins fills from the active book; the rest stay honestly
      // 'unattributed' instead of borrowing a foreign book's labels.
      if (fname === FILLS_FILE) {
        for (const e of epis) {
          const ent = (state.entriesLog || [])
            .filter((en) => en.symbol === e.symbol && en.strategy && en.ts >= (e.openTs || 0) - 600e3 && en.ts <= (e.closeTs || Date.now()))
            .pop();
          e.strat = ent?.strategy || 'unattributed';
        }
      }
      allEpis.push(...epis);
      allBooks[bk] = episodeStats(epis);
    }
    // family evidence from the money itself — replaces the excursion
    // tracker's survivorship-biased winShare as the family-gate input.
    // Buckets under n<3 keep the mae-mfe estimate until fills prove better.
    const fams = {};
    for (const e of allEpis.filter((x) => !x.open)) {
      const k = e.strat || 'unattributed';
      const g = fams[k] || (fams[k] = { n: 0, w: 0, ret: 0, retN: 0 });
      g.n++;
      if (e.netUsd > 0) g.w++;
      // return base = open-side notional; a close-first episode with no
      // journaled open has no base — it counts toward winShare only, not a
      // fabricated return percentage
      const base = e.notional > 0 ? e.notional : e.riskUsd > 0 ? e.riskUsd : 0;
      if (base > 0) { g.ret += (100 * e.netUsd) / base; g.retN++; }
    }
    const fillFams = {};
    for (const [k, g] of Object.entries(fams)) {
      if (g.n < 3) continue;
      fillFams[k] = { n: g.n, winShare: round(g.w / g.n, 3), meanRetPct: g.retN ? round(g.ret / g.retN, 3) : null, src: 'fills' };
    }
    Object.assign(FAM_STATS, fillFams);
    const at = {
      refreshedAt: new Date().toISOString(),
      scope: 'all real exchange fill journals (live + demo books) — FIFO position episodes per symbol',
      combined: episodeStats(allEpis),
      books: allBooks,
      families: fillFams,
    };
    state.allTime = at;
    writeJson(path.join(API_DIR, 'alltime-stats.json'), at);
  } catch (e) { state.errors.push(`alltime stats: ${e.message}`); }

  // final position snapshot — exchange state is the ledger's ground truth
  try {
    const pos2 = await getPos();
    state.positionsAfter = (pos2 || [])
      .filter((p) => +p.total > 0)
      .map((p) => ({ symbol: p.symbol, side: p.holdSide, size: +p.total, upl: +p.unrealizedPL, entry: +p.openPriceAvg || null, lev: +p.leverage || null, margin: +p.marginSize || 0, marginMode: p.marginMode, liq: +p.liquidationPrice || 0 }));
  } catch {}
  // dump pending protection plans per open symbol — the god.mjs overseer
  // audits these to prove no position is ever naked on the exchange
  try {
    state.plans = {};
    await Promise.all(
      (state.positionsAfter || []).map(async (p) => {
        state.plans[p.symbol] = (await getPlans(p.symbol).catch(() => []))
          .map((x) => ({ planType: x.planType, triggerPrice: +x.triggerPrice, size: +x.size, holdSide: x.holdSide }));
      })
    );
  } catch {}
  // persist this cycle's armed TP-limit prices — next cycle's banked-tranche
  // floor diffs them against the live book to detect tranche fills
  state.legs = {};
  for (const p of state.positionsAfter || [])
    state.legs[p.symbol] = curLegMap[p.symbol] || priorLegMap[p.symbol] || [];
  state.trimGuard = trimGuard;
  state.cycleMs = Date.now() - tRun;
  state.refreshedAt = new Date().toISOString(); // freshness = write time, not run start
  state.managed = [...managed]; // materialize at write time — entries late in the cycle count
  // setup-arm map: filled setups and flat-prunes above flag dirty —
  // write once at the commit point so the TP-preservation map survives
  // restarts exactly like `managed` does via the ledger
  if (armsDirty) {
    try {
      const t = armsPath + '.tmp';
      fs.writeFileSync(t, JSON.stringify(setupArms));
      fs.renameSync(t, armsPath);
    } catch (e) { state.errors.push(`setupArms persist: ${e.message}`); }
  }
  // ---- gate-reject histogram: rolling 24h counts by gate name ----
  try {
    const gsPath = path.join(__dirname, '..', 'api', 'gate-stats.json');
    let gs = { buckets: [] }; try { gs = JSON.parse(fs.readFileSync(gsPath, 'utf8')); } catch {}
    const counts = {};
    for (const r of state.rejects || []) for (const g of r.gates || []) counts[g] = (counts[g] || 0) + 1;
    gs.buckets = (gs.buckets || []).filter((b) => Date.now() - b.ts < 24 * 3600e3);
    gs.buckets.push({ ts: Date.now(), counts });
    const totals = {};
    for (const b of gs.buckets) for (const [g, n] of Object.entries(b.counts || {})) totals[g] = (totals[g] || 0) + n;
    gs.totals24h = totals;
    gs.refreshedAt = new Date().toISOString();
    writeJson(gsPath, gs);
  } catch {}

  // ---- excursion tracker (MAE/MFE): peak/trough mark per open position,
  // finalized on close -> calibration data for stop/target geometry ----
  try {
    const trackPath = path.join(__dirname, '..', 'state', 'mae-track.json');
    const epiPath = path.join(__dirname, '..', 'state', 'mae-mfe.json');
    const apiPath = path.join(__dirname, '..', 'api', 'mae-mfe.json');
    let track = {}; try { track = JSON.parse(fs.readFileSync(trackPath, 'utf8')); } catch {}
    const pos3 = await getPos().catch(() => []);
    const openKeys = new Set();
    for (const p of pos3 || []) {
      if (!(+p.total > 0)) continue;
      const mk = +p.markPrice || 0;
      if (!(mk > 0)) continue;
      const key = `${p.symbol}:${p.holdSide}`;
      openKeys.add(key);
      const t = (track[key] ||= { sym: p.symbol, side: p.holdSide, entry: +p.openPriceAvg, peak: mk, trough: mk, firstTs: Date.now(), strat: null });
      t.peak = Math.max(t.peak, mk); t.trough = Math.min(t.trough, mk); t.lastMark = mk;
      if (!t.strat) {
        // attribute only to a SAME-DIRECTION entry attempt near this
        // position's open time — otherwise a manual position inherits a
        // stale bot strategy and the family medians lie
        const dir = p.holdSide === 'long' ? 'LONG' : 'SHORT';
        const e = (state.entriesLog || []).filter((x) => x.symbol === p.symbol &&
          x.direction === dir && Math.abs((x.ts ?? 0) - (+p.cTime || 0)) < 30 * 60e3).slice(-1)[0];
        if (e?.strategy) t.strat = e.strategy;
      }
    }
    const done = Object.keys(track).filter((k) => !openKeys.has(k));
    if (done.length) {
      let epis = []; try { epis = JSON.parse(fs.readFileSync(epiPath, 'utf8')).episodes || []; } catch {}
      for (const k of done) {
        const t = track[k]; delete track[k];
        if (!t.entry || !t.lastMark) continue;
        const mae = t.side === 'long' ? (t.entry - t.trough) / t.entry * 100 : (t.peak - t.entry) / t.entry * 100;
        const mfe = t.side === 'long' ? (t.peak - t.entry) / t.entry * 100 : (t.entry - t.trough) / t.entry * 100;
        epis.push({ sym: t.sym, side: t.side, entry: t.entry, exit: t.lastMark,
          maePct: round(mae, 3), mfePct: round(mfe, 3),
          durMin: Math.round((Date.now() - t.firstTs) / 6e4), strat: t.strat || 'unattributed', ts: Date.now() });
      }
      epis = epis.slice(-300);
      writeJson(epiPath, { episodes: epis });
      const byKey = {};
      for (const e of epis) (byKey[`${e.sym}:${e.side}`] ||= []).push(e);
      const med = (a) => { const q = [...a].sort((x, y) => x - y); return q.length ? q[q.length >> 1] : null; };
      const agg = {};
      for (const [k, arr] of Object.entries(byKey)) {
        agg[k] = { n: arr.length, medMaePct: round(med(arr.map((e) => e.maePct)), 2), medMfePct: round(med(arr.map((e) => e.mfePct)), 2) };
      }
      // family rollup — the number that calibrates strategy stop floors
      const byFam = {};
      for (const e of epis) (byFam[e.strat] ||= []).push(e);
      const fam = {};
      for (const [k, arr] of Object.entries(byFam)) {
        const rets = arr.map((e) => ((e.exit - e.entry) / e.entry) * (e.side === 'long' ? 1 : -1) * 100);
        fam[k] = {
          n: arr.length,
          medMaePct: round(med(arr.map((e) => e.maePct)), 2),
          medMfePct: round(med(arr.map((e) => e.mfePct)), 2),
          winShare: round(rets.filter((r) => r > 0).length / (arr.length || 1), 3),
          meanRetPct: round(rets.reduce((a, b) => a + b, 0) / (arr.length || 1), 3),
        };
      }
      writeJson(apiPath, { refreshedAt: new Date().toISOString(), bySymbol: agg, byFamily: fam, episodes: epis.slice(-50) });
      state.maeMfe = fam;
      state.actions.push(`🧪 excursion: finalized ${done.length} episode(s) — mae/mfe journal updated`);
    }
    writeJson(trackPath, track);
  } catch (e) { state.errors.push(`mae/mfe: ${e.message}`); }

  writeJson(outPath, { ...state, actions: [...new Set(state.actions)], errors: [...new Set(state.errors)].slice(0, 50), rejects: (state.rejects || []).slice(0, 60) });
  log(`done — ${state.actions.length} actions, ${state.errors.length} errors`);
  if (state.errors.length) console.log(state.errors.join('\n'));
}

main().catch((e) => {
  console.error('[exec] fatal:', e.message);
  process.exitCode = 1;
});
