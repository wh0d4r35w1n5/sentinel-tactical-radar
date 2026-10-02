// god.mjs — the overseer. Watches every subsystem each cycle and renders a
// verdict on every invariant the system claims to uphold.
//
// Design: audit artifacts, then inspect the configured exchange through its
// venue adapter. It never opens/closes positions; it repairs missing exchange
// protection only, and reports each read/repair result in api/god.json.
//
// Output: api/god.json { at, verdict, checks[] } consumed by the dashboard.
// Verdict: PERFECT (all pass) / ATTENTION (warns) / BROKEN (any fail).
// Always exits 0 — a red God must never block the snapshot commit that
// would show it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-env.mjs'; // canonical .env loader (audit F2)
import { integrityNote } from './crc32.mjs';
import { makeExchange } from './exchange/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(__dirname, '..', 'api');
const NOW = Date.now();

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });

const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(API, f), 'utf8')); }
  catch { return null; }
};
// fail-closed: an unparseable/ISO timestamp audits as infinitely stale, never
// silently fresh — NaN > ttl is false, which would PASS a corrupt plan
const ageMin = (ts) => {
  const n = fin(ts) ? ts : Date.parse(ts);
  return fin(n) ? (NOW - n) / 6e4 : Infinity;
};
const fin = (x) => Number.isFinite(x);

// ---------- 1. every artifact parses — strict JSON.parse already rejects
// corrupt literals (bare NaN/Infinity/undefined tokens can't parse), so a
// text regex would only false-positive on in-string mentions ----------
{
  const files = fs.readdirSync(API).filter((f) => f.endsWith('.json') && f !== 'god.json');
  const bad = [];
  for (const f of files) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(API, f), 'utf8'));
      if (v === null || typeof v !== 'object') bad.push(`${f}: not an object`);
    } catch { bad.push(`${f}: unparseable`); }
  }
  add('json-integrity', bad.length ? 'FAIL' : 'PASS',
    bad.length ? bad.join('; ') : `${files.length} artifacts parse clean`);
}

// ---------- 2. snapshot freshness ----------
{
  const scan = readJson('market-scanner.json');
  const age = scan ? ageMin(Date.parse(scan.refreshedAt)) : Infinity;
  add('snapshot-fresh', !scan ? 'FAIL' : age > 25 ? 'WARN' : 'PASS',
    scan ? `scanner snapshot ${age.toFixed(1)}min old` : 'market-scanner.json missing');
}
{
  const health = readJson('health.json');
  const age = health?.scanner?.at ? ageMin(Date.parse(health.scanner.at)) : Infinity;
  add('health-fresh', !health ? 'WARN' : age > 25 ? 'WARN' : 'PASS',
    health ? `health ping ${age.toFixed(1)}min old` : 'health.json missing');
}

// ---------- 3. ledger integrity ----------
const ledger = readJson('signal-ledger.json');
if (!ledger) {
  add('ledger-present', 'FAIL', 'signal-ledger.json missing — the book itself is gone');
} else {
  const entries = ledger.entries || [];
  const open = entries.filter((e) => e.status === 'open');
  const closed = entries.filter((e) => e.status !== 'open');
  // fundamental fields are required on every entry ever; full-schema
  // fields (lev/notional/tps) only on versioned entries — pre-ver legacy
  // rows are known data debt, not corruption
  const badFund = open.filter((e) =>
    !e.asset || !fin(e.entry) || e.entry <= 0 || !fin(e.ts) ||
    (e.direction !== 'LONG' && e.direction !== 'SHORT') ||
    (e.lastPrice != null && (!fin(e.lastPrice) || e.lastPrice <= 0)));
  const legacy = open.filter((e) => e.ver == null);
  const badSchema = open.filter((e) => e.ver != null &&
    (!fin(e.lev) || e.lev <= 0 || !fin(e.notional) || !Array.isArray(e.tps) || !fin(e.stopAt)));
  const badClosed = closed.filter((e) => !fin(e.exitPrice) || !fin(e.exitTs) || !e.status);
  const hard = badFund.length + badSchema.length + badClosed.length;
  add('ledger-shape',
    hard ? 'FAIL' : legacy.length ? 'WARN' : 'PASS',
    hard
      ? `${badFund.length} bad fundamentals / ${badSchema.length} malformed versioned / ${badClosed.length} malformed closed`
      : legacy.length
        ? `${legacy.length} legacy-schema open entries (${legacy.map((e) => e.asset).join(',')}) — pre-version data debt`
        : `${entries.length} entries well-formed`);

  const s = ledger.stats || {};
  const drift = [];
  if (s.open !== open.length) drift.push(`stats.open=${s.open} vs actual ${open.length}`);
  if (s.closed !== closed.length) drift.push(`stats.closed=${s.closed} vs actual ${closed.length}`);
  if ((s.wins ?? 0) + (s.losses ?? 0) + (s.flat ?? 0) !== closed.length)
    drift.push(`wins+losses+flat=${(s.wins ?? 0) + (s.losses ?? 0) + (s.flat ?? 0)} vs closed ${closed.length}`);
  // paper book retired — an empty ledger legitimately carries null rate stats;
  // only enforce them once closed rows actually exist
  if (closed.length) {
    if (!fin(s.winRate) || s.winRate < 0 || s.winRate > 100) drift.push(`winRate=${s.winRate}`);
    if (!fin(s.expectancyR)) drift.push(`expectancyR=${s.expectancyR}`);
  }
  add('stats-consistent', drift.length ? 'FAIL' : 'PASS',
    drift.length ? drift.join('; ') : entries.length ? 'derived stats reconcile with the entry list' : 'ledger empty — signal eval + live fills carry the record');

  // ---------- 4. risk rails ----------
  // the real kill rail lives on live-ledger.json (real equity DD); the
  // ledger-side check only applies if a maxDrawdownPct is still published
  const ddBad = fin(s.ddKill?.thresholdPct ?? s.ddKill) && fin(s.maxDrawdownPct) && s.maxDrawdownPct >= (s.ddKill?.thresholdPct ?? s.ddKill);
  // the 25% cap was the old book policy — the mandate now allows an 85%
  // margin single-shot (a stop ~1% on ~90x-margin notional ≈ 45% of equity).
  // WARN at the old line, FAIL only where even a max shot can't explain it.
  const riskHot = fin(s.openRiskPct) && s.openRiskPct > 60;
  const riskWarm = fin(s.openRiskPct) && s.openRiskPct > 25;
  const killThresh = s.ddKill?.thresholdPct ?? s.ddKill;
  const killCur = s.ddKill?.currentPct ?? s.maxDrawdownPct;
  add('risk-rails',
    ddBad || riskHot ? 'FAIL' : riskWarm ? 'WARN' : 'PASS',
    ddBad
      ? `drawdown ${s.maxDrawdownPct}% >= kill ${killThresh}% — switch should have fired`
      : riskHot
        ? `open risk ${s.openRiskPct}% exceeds even the max single-position mandate`
        : `dd ${killCur ?? '—'}%/${killThresh ?? '—'}% kill · open risk ${s.openRiskPct ?? 0}%` +
          (riskWarm ? ' (above 25% — inside the 85%-margin mandate)' : ''));
}

// ---------- 5. plan freshness ----------
{
  const plan = readJson('live-plan.json');
  if (!plan) add('plan-present', 'FAIL', 'live-plan.json missing — executor has nothing to route');
  else {
    const age = ageMin(plan.ts);
    const ttl = (plan.ttlMs || 900e3) / 6e4;
    add('plan-fresh', age > ttl ? 'FAIL' : 'PASS',
      `plan ${age.toFixed(1)}min old (ttl ${ttl}min) — ${(plan.orders || []).length} orders / ${(plan.closes || []).length} closes / ${(plan.trails || []).length} trails`);

    // net-of-cost mandate — every routed order must carry the stamped
    // geometry proving (target−costs)/(stop+costs) >= SENTINEL_MIN_RR (env,
    // default 2). An order without the fields is unroutable-by-design; audit
    // it as a violation.
    const rrMin = +(process.env.SENTINEL_MIN_RR || 2);
    const badRR = (plan.orders || []).filter((o) =>
      !(fin(o.netRR) && o.netRR >= rrMin) &&
      !(fin(o.targetPct) && fin(o.stopPct) &&
        (o.targetPct - 0.2) / (o.stopPct + 0.2) >= rrMin));
    add('rr-mandate', badRR.length ? 'FAIL' : 'PASS',
      badRR.length
        ? `${badRR.length} orders below ${rrMin}:1 net: ${badRR.map((o) => `${o.symbol}(rr=${o.netRR ?? '?'})`).join(',')}`
        : `${(plan.orders || []).length} orders, all >=${rrMin}:1 net-of-cost`);
  }
}

// ---------- 6. executor state ----------
const ll = readJson('live-ledger.json');
const execModes = ['off', 'shadow', 'demo', 'live'];
if (ll) {
  add('exec-mode', execModes.includes(ll.mode) ? 'PASS' : 'FAIL',
    `mode=${ll.mode}${ll.mode === 'live' ? ' (ARMED — real money)' : ''}`);
  // freshness: a live-mode ledger older than 5min means the executor died
  // mid-flight — mode:'live' on a stale file is the lie this audit exists
  // to catch. But ledger age isn't loop liveness: a multi-minute scan phase
  // starves the ledger legitimately. The rapid heartbeat (written at loop
  // top) is the real signal; ledger age is the fallback when unwritten.
  if (ll.mode === 'live' || ll.mode === 'demo') {
    const la = ageMin(Date.parse(ll.refreshedAt || 0));
    let hb = Infinity;
    try {
      hb = ageMin(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state', 'rapid-heartbeat.json'), 'utf8')).ts);
    } catch {}
    const alive = fin(hb) ? hb <= 10 : la <= 5;
    add('exec-alive', alive ? 'PASS' : 'FAIL',
      `heartbeat ${fin(hb) ? hb.toFixed(1) : '∞'}min · live-ledger ${Number.isFinite(la) ? la.toFixed(1) : '∞'}min old${ll.cycleMs != null ? ` · cycle ${ll.cycleMs}ms` : ''}`);
  }
  add('exec-errors', (ll.errors || []).length ? 'WARN' : 'PASS',
    (ll.errors || []).length ? ll.errors.slice(0, 4).join(' · ') : 'clean run, zero errors');

  // ---------- 6b. liquidation-guard liveness — the guard is the last line
  // before liquidation; a dead process means open positions are unwatched.
  // It writes api/liq-guard.json every cycle (~300ms), so minutes = dead.
  {
    const lg = readJson('liq-guard.json');
    const openPos = (ll.positionsAfter || ll.positions || []).length;
    if (!lg) {
      add('liq-guard', openPos ? 'FAIL' : 'WARN',
        openPos ? 'no liq-guard artifact with positions open — guard dead or never started'
                : 'no liq-guard artifact (flat book — tolerable)');
    } else {
      const la = ageMin(lg.at);
      const tracked = Object.keys(lg.positions || {}).length;
      add('liq-guard', la > 2 ? (openPos ? 'FAIL' : 'WARN') : 'PASS',
        `guard state ${Number.isFinite(la) ? la.toFixed(1) : '∞'}min old · ${tracked} tracked · ${(lg.trims || []).length} lifetime trims`);
    }

    // ---------- 6c. circuit-breakers armed — the failure mode that ate a
    // deposit was every safety rail disabled by env. Audit that at least
    // one account-level breaker can actually trip, and report trip state.
    {
      const cb = (ll.risk || {}).circuitBreakers || ll.circuitBreakers;
      if (!cb) {
        add('breakers-armed', ll.mode === 'live' ? 'FAIL' : 'WARN',
          'no circuit-breaker data on ledger — exec predates breaker telemetry');
      } else {
        const t = cb.thresholds || {};
        const allDead = (t.lossHaltPct ?? 0) >= 100 && (t.wrHaltPct ?? 0) <= 0 &&
                        (t.feeHaltPct ?? 0) >= 100 && (t.streakHalt ?? 99) >= 99 && !(t.reserveUsd > 0);
        add('breakers-armed', allDead ? 'FAIL' : cb.tripped ? 'WARN' : 'PASS',
          allDead ? 'ALL account breakers disabled — nothing stops a churn bleed'
          : cb.tripped ? `TRIPPED: ${cb.tripped}`
          : `armed · 24h net $${cb.net24Usd} · fees $${cb.fees24Usd} · posWr20 ${cb.winRate20 ?? '—'}% (n=${cb.positions20 ?? cb.closes20} positions)`);
      }
    }
  }
} else {
  add('exec-mode', 'WARN', 'no live-ledger.json — executor has not run (shadow/off or first cycle)');
}

// ---------- 7. sim ↔ exchange convergence (demo|live only) ----------
if (ll && (ll.mode === 'demo' || ll.mode === 'live')) {
  const exPos = ll.positionsAfter || [];
  // paper ledger retired — there is no sim book to converge with. The real
  // invariant left is: every exchange position must carry loss protection.
  const naked = exPos.filter((p) => {
    const plans = (ll.plans || {})[p.symbol] || [];
    // 'moving_plan' is Bitget's trailing stop — it protects the same side a
    // loss_plan does; the old /loss|stop/ regex audited it as "naked"
    // per-side match: in hedge mode a stop on the OTHER side is not cover
    return !plans.some((x) => /loss|stop|moving/i.test(x.planType || '') &&
      (!x.holdSide || !p.side || x.holdSide === p.side));
  });
  const unprofited = exPos.filter((p) => {
    const plans = (ll.plans || {})[p.symbol] || [];
    return !plans.some((x) => /profit/i.test(x.planType || '') &&
      (!x.holdSide || !p.side || x.holdSide === p.side));
  });
  add('convergence',
    naked.length ? 'FAIL' : unprofited.length ? 'WARN' : 'PASS',
    naked.length
      ? `UNPROTECTED positions: ${naked.map((p) => p.symbol).join(',')} — no stop plan on the exchange`
      : unprofited.length
        ? `positions missing take-profit: ${unprofited.map((p) => p.symbol).join(',')}`
        : `${exPos.length} exchange positions, all protected (TP+SL)`);

  // ---------- 8. never-naked: every open position carries a loss plan ----------
  if (ll.plans && Object.keys(ll.plans).length) {
    const naked = exPos.filter((p) =>
      !(ll.plans[p.symbol] || []).some((x) => /loss|stop|moving/i.test(x.planType || '') &&
        (!x.holdSide || !p.side || x.holdSide === p.side)));
    add('protection', naked.length ? 'FAIL' : 'PASS',
      naked.length
        ? `NAKED: ${naked.map((p) => p.symbol).join(',')} open with no stop plan`
        : `every open position carries a loss plan (${exPos.length} checked)`);
  } else {
    // a plan dump only exists when positions exist — a flat book with no
    // dump is clean, not unverifiable. WARN only when positions are open
    // and the dump that could prove their protection is missing.
    add('protection', exPos.length ? 'WARN' : 'PASS',
      exPos.length
        ? 'no plan dump in ledger — cannot verify protection coverage'
        : 'book flat — nothing requires protection');
  }

  // ---------- 8b. band-integrity: an armed stop past the liquidation band
  // edge can never fire — protection that exists on paper but loses to liq
  // is decoration. Verify each loss trigger sits inside the band. ----------
  const bandBad = exPos.filter((p) => {
    if (!(p.liq > 0) || !(p.entry > 0)) return false; // unverifiable without both
    const stop = (ll.plans?.[p.symbol] || [])
      .find((x) => /loss|stop|moving/i.test(x.planType || '') && +x.triggerPrice > 0 &&
        (!x.holdSide || !p.side || x.holdSide === p.side));
    if (!stop) return false; // naked case is the protection check's job
    const bandPct = (Math.abs(p.entry - p.liq) / p.entry) * 100;
    const stopPct = (Math.abs(p.entry - +stop.triggerPrice) / p.entry) * 100;
    return stopPct >= bandPct * 0.8;
  });
  add('band-integrity', bandBad.length ? 'FAIL' : 'PASS',
    bandBad.length
      ? `${bandBad.map((p) => p.symbol).join(',')} stop at/past liq band edge — cannot fire before liquidation`
      : 'every armed stop sits inside its liquidation band');

  // ---------- 9. untradeable-list hygiene ----------
  const ut = ll.untradeable || [];
  const bad = ut.filter((s) => !/^[A-Z0-9]+USDT$/.test(s));
  add('untradeable-hygiene', bad.length || ut.length > 100 ? 'WARN' : 'PASS',
    ut.length ? `${ut.length} blocked symbols: ${ut.slice(0, 8).join(',')}${ut.length > 8 ? '…' : ''}` : 'no blocked symbols');
}

// ---------- 10. intelligence wire integrity ----------
{
  const news = readJson('news.json');
  if (!news || !(news.items || []).length) {
    add('news-wire', 'WARN', 'no wire items — feeds may be down');
  } else {
    const dirty = news.items.filter((i) => /utm_|fbclid|gclid|CDATA|<|\s/i.test(i.link || ''));
    const stale = news.items.filter((i) => ageMin(i.ts) > 24 * 60);
    // staleness judged by the NEWEST item — a quiet weekend leaves old items
    // lingering legitimately; a dead wire has a stale newest item.
    const newestAge = Math.min(...news.items.map((i) => ageMin(i.ts)));
    add('news-wire', dirty.length ? 'FAIL' : newestAge > 24 * 60 ? 'WARN' : 'PASS',
      dirty.length
        ? `${dirty.length} links still carry tracking junk`
        : newestAge > 24 * 60
          ? `wire silent — newest item ${Math.round(newestAge / 60)}h old`
          : `${news.items.length} items, newest ${Math.round(newestAge)}m old${stale.length ? ` · ${stale.length} aging out` : ''}`);
  }
}

// ---------- 11. eval honesty: no verdicts on zero/thin evidence ----------
{
  const ev = readJson('signal-eval.json');
  const hypo = readJson('hypotheses.json');
  const issues = [];
  if (ev) {
    const bad = (ev.records || []).filter((r) => r.complete && !r.evaluatedAt);
    if (bad.length) issues.push(`${bad.length} eval records marked complete with no evaluatedAt`);
    const nf = (ev.records || []).filter((r) => r.fwd1h != null && !fin(r.fwd1h));
    if (nf.length) issues.push(`${nf.length} records with non-finite forward returns`);
  }
  if (hypo) {
    const premature = (hypo.claims || []).filter((c) =>
      ['SUPPORTED', 'REFUTED'].includes(c.status) && !(c.n > 0));
    if (premature.length) issues.push(`verdicts with n=0: ${premature.map((c) => c.id).join(',')}`);
  }
  add('eval-honesty', issues.length ? 'FAIL' : 'PASS',
    issues.length ? issues.join('; ') : 'no measured claim exceeds its evidence');
}

// ---------- 12. OVERSEER ACTIONS — protection repair only ----------
// God never opens or closes positions. It may attach missing stop/target
// protection to existing positions on the configured exchange, then audits
// coverage and reports any repair failures.
const interventions = [];
const interv = (what, res) => interventions.push({ what, res, at: new Date().toISOString() });
{
  // Audit/repair the exact exchange and mode selected by the executor.
  // Adapter centralizes signing and endpoint selection, so demo oversight
  // cannot accidentally query or repair a different exchange/account.
  const MODE = (process.env.SENTINEL_EXEC || '').toLowerCase();
  const DEMO = MODE === 'demo';
  let X = null;
  try {
    X = makeExchange(process.env);
  } catch (e) {
    add('god-powers', 'FAIL', 'exchange configuration refused: ' + e.message);
  }
  if (X && MODE !== 'demo' && MODE !== 'live') {
    add('god-powers', 'WARN', `mode=${MODE || 'off'} — exchange inspection/repair disabled outside demo/live`);
  } else if (X && !X.hasCreds) {
    add('god-powers', 'WARN', `no ${X.name.toUpperCase()} credentials in env — running degraded audit-only`);
  } else if (X && process.env.GOD_INTERVENE === '0') {
    add('god-powers', 'WARN', 'GOD_INTERVENE=0 — powers disabled');
  } else if (X) {
    try {
      const [positions, acct] = await Promise.all([X.getPos(), X.getAccount()]);
      if (positions.length) {
        const mode = await X.getPosMode('BTCUSDT');
        X.setPosMode?.(mode);
      }
      const contracts = positions.length ? await X.contractMap() : {};
      const roundPrice = (symbol, price) => {
        const c = contracts[symbol] || {};
        const decimals = Number.isInteger(c.pricePlace) ? c.pricePlace : 6;
        const tick = +c.tickSize || 0;
        const rounded = tick > 0 ? Math.round(Number(price) / tick) * tick : Number(price);
        return +rounded.toFixed(decimals);
      };
      // --- a) shield check: every real position carries loss + profit plans
      for (const p of positions || []) {
        const hold = (p.holdSide || p.side || '').toLowerCase();
        const holdSide = hold === 'long' ? 'long' : 'short';
        let plans;
        try {
          plans = await X.getPlans(p.symbol);
        } catch (e) {
          add(`god-plans-${p.symbol}-${holdSide}`, 'FAIL', `cannot verify existing exchange protection; refusing to overwrite blind: ${e.message}`);
          continue;
        }
        const sidePlans = plans.filter((x) => !x.holdSide || x.holdSide.toLowerCase() === hold);
        const hasLoss = sidePlans.some((x) => /loss|moving/i.test(x.planType || ''));
        const hasProfit = sidePlans.some((x) => /profit/i.test(x.planType || ''));
        const entry = +(p.openPriceAvg || p.entry || 0);
        const sgn = holdSide === 'long' ? 1 : -1;
        const mm = (p.marginMode || '').toLowerCase() === 'crossed' ? 'crossed' : 'isolated';
        if (!(entry > 0)) {
          add(`god-shield-${p.symbol}-${holdSide}`, 'FAIL', 'open position has no valid entry price; refusing to invent protection levels');
          continue;
        }
        if (!hasLoss) {
          const liq = +(p.liquidationPrice || 0);
          const bandPct = liq > 0 ? Math.abs(entry - liq) / entry * 100 : Infinity;
          const shieldPct = Math.min(0.03, (bandPct / 100) * 0.7);
          if (!(shieldPct > 0)) {
            add(`god-shield-${p.symbol}-${holdSide}`, 'FAIL', 'cannot calculate a protective stop inside the liquidation band');
          } else {
            const trig = roundPrice(p.symbol, entry * (1 - sgn * shieldPct));
            const insideLiqBand = liq > 0 && (holdSide === 'long' ? trig > liq : trig < liq);
            const correctSide = holdSide === 'long' ? trig < entry : trig > entry;
            if (!insideLiqBand || !correctSide) {
              add(`god-shield-${p.symbol}-${holdSide}`, 'FAIL', 'tick rounding would place stop outside the protective side/liquidation band');
              continue;
            }
            const r = await X.planOrder(p.symbol, 'pos_loss', trig, '0', holdSide, mm)
              .then(() => true).catch((e) => e.message);
            interv(`shield ${p.symbol} ${holdSide}`, r === true ? `pos_loss @${trig} placed` : `FAILED: ${r}`);
            add(`god-shield-${p.symbol}-${holdSide}`, r === true ? 'PASS' : 'FAIL',
              r === true ? `naked position shielded — pos_loss @${trig}` : `shield failed: ${r}`);
          }
        }
        if (!hasProfit) {
          const liq = +(p.liquidationPrice || 0);
          const bandPct = liq > 0 ? Math.abs(entry - liq) / entry * 100 : Infinity;
          const tpPct = Math.min(0.045, (bandPct / 100) * 0.9);
          if (tpPct > 0) {
            const trig = roundPrice(p.symbol, entry * (1 + sgn * tpPct));
            const correctSide = holdSide === 'long' ? trig > entry : trig < entry;
            if (!correctSide) {
              add(`god-profit-${p.symbol}-${holdSide}`, 'WARN', 'tick rounding would place take-profit on the wrong side of entry');
              continue;
            }
            const r = await X.planOrder(p.symbol, 'pos_profit', trig, '0', holdSide, mm)
              .then(() => true).catch((e) => e.message);
            interv(`profit-leg ${p.symbol} ${holdSide}`, r === true ? `pos_profit @${trig} placed` : `FAILED: ${r}`);
            if (r !== true)
              add(`god-profit-${p.symbol}-${holdSide}`, 'WARN', `take-profit repair failed: ${r}`);
          } else {
            add(`god-profit-${p.symbol}-${holdSide}`, 'WARN', 'cannot calculate a take-profit within the liquidation band');
          }
        }
      }
      // --- b) dead-capital audit. Demo equity is account-minted sandbox
      // balance; compare only against the executor's small anchored test book.
      const eq = +(acct.equity || 0), av = +(acct.available || 0);
      const bookEq = +(ll?.equityUsd || 0);
      const idleFloor = Math.max((DEMO ? bookEq : eq) * 0.15, 8);
      const idle = ll?.idleMargin;
      const bookDeployed = (ll?.positions || ll?.positionsAfter || [])
        .reduce((s, p) => s + (+p.margin || 0), 0);
      // In demo, raw exchange availability is minted sandbox balance, not
      // the $65-anchored test book used by executor sizing.
      const bookFree = Math.max(0, bookEq - bookDeployed);
      if (DEMO) {
        const accounted = idle && Number.isFinite(idle.usd) && typeof idle.reason === 'string' && idle.reason.length > 0;
        add('capital-deployed', bookFree > idleFloor && !accounted ? 'WARN' : 'PASS',
          accounted
            ? `$${bookFree.toFixed(2)} free on the $${bookEq.toFixed(2)} demo book ($${bookDeployed.toFixed(2)} deployed); idle accounted: ${idle.reason}`
            : bookFree > idleFloor
              ? `$${bookFree.toFixed(2)} free on the demo book with no idle-margin explanation`
              : `$${bookFree.toFixed(2)} free — within book gas floor`);
      } else {
        add('capital-deployed', av > idleFloor ? 'WARN' : 'PASS',
          av > idleFloor
            ? `$${av.toFixed(2)} free margin idle (floor $${idleFloor.toFixed(2)}) — dead capital, deployment mandate`
            : `$${av.toFixed(2)} free — within gas floor, book deployed`);
      }
      // --- c) position coverage is side-aware for hedge-mode books.
      const llx = readJson('live-ledger.json');
      const known = new Set((llx?.positions || llx?.positionsAfter || [])
        .map((p) => `${p.symbol}:${String(p.side || '').toLowerCase()}`));
      const unknown = (positions || []).filter((p) =>
        !known.has(`${p.symbol}:${String(p.holdSide || p.side || '').toLowerCase()}`));
      add('position-coverage', unknown.length ? 'WARN' : 'PASS',
        unknown.length
          ? 'untracked positions: ' + unknown.map((p) => `${p.symbol}:${p.holdSide || p.side}`).join(',')
          : `${(positions || []).length} exchange positions all ledger-visible`);
      add('god-powers', 'PASS', `armed — ${X.name} ${MODE} watch + protection repair active every cycle`);
    } catch (e) {
      add('god-powers', 'FAIL', 'credentialed layer error: ' + (e.message || e));
    }
  }
}

// ---------- verdict ----------
// integrity audit — do this before calculating the verdict/counts so CRC
// failures and missing manifests are reflected in the published status.
try {
  const integ = JSON.parse(fs.readFileSync(path.join(API, 'integrity.json'), 'utf8'));
  const bad = [...(integ.corrupt || []), ...(integ.missing || [])];
  add('crc32-integrity', bad.length ? 'FAIL' : 'PASS',
    bad.length ? `${bad.length} file(s) failed CRC32: ${bad.slice(0, 3).join(', ')}` : `${integ.checked ?? 0} artifacts CRC32-verified`);
} catch { add('crc32-integrity', 'WARN', 'api/integrity.json absent — crc32-verify.mjs not running'); }

const fails = checks.filter((c) => c.status === 'FAIL');
const warns = checks.filter((c) => c.status === 'WARN');
const verdict = fails.length ? 'BROKEN' : warns.length ? 'ATTENTION' : 'PERFECT';

const out = {
  at: new Date(NOW).toISOString(),
  verdict,
  pass: checks.length - fails.length - warns.length,
  warn: warns.length,
  fail: fails.length,
  checks,
  interventions,
  note: 'overseer — audits artifacts and the configured demo/live exchange; only repairs missing protection. FAIL = invariant violated, WARN = degraded, PASS = held',
};
const godBody = JSON.stringify(out);
fs.writeFileSync(path.join(API, 'god.json.tmp'), godBody);
fs.renameSync(path.join(API, 'god.json.tmp'), path.join(API, 'god.json'));
integrityNote(path.join(API, 'god.json'), godBody);
console.log(`[god] ${verdict} — ${out.pass} pass / ${warns.length} warn / ${fails.length} fail`);
for (const c of checks.filter((c) => c.status !== 'PASS'))
  console.log(`[god] ${c.status} ${c.name}: ${c.detail}`);
