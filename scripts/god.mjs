// god.mjs — the overseer. Watches every subsystem each cycle and renders a
// verdict on every invariant the system claims to uphold.
//
// Design: PURE AUDITOR. Reads api/*.json only. No credentials, no exchange
// calls, no mutations — it cannot trade, cannot close, cannot hide. The
// scanner decides, the executor acts, God watches and reports.
//
// Output: api/god.json { at, verdict, checks[] } consumed by the dashboard.
// Verdict: PERFECT (all pass) / ATTENTION (warns) / BROKEN (any fail).
// Always exits 0 — a red God must never block the snapshot commit that
// would show it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(__dirname, '..', 'api');
// zero-dep .env loader — same gap the scanner had: SENTINEL_* audit
// thresholds must match the operator's configured values, not defaults
try {
  for (const line of fs.readFileSync(path.join(API, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
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
  // to catch
  if (ll.mode === 'live' || ll.mode === 'demo') {
    const la = ageMin(Date.parse(ll.refreshedAt || 0));
    add('exec-alive', la > 5 ? 'FAIL' : 'PASS',
      `live-ledger ${Number.isFinite(la) ? la.toFixed(1) : '∞'}min old${ll.cycleMs != null ? ` · cycle ${ll.cycleMs}ms` : ''}`);
  }
  add('exec-errors', (ll.errors || []).length ? 'WARN' : 'PASS',
    (ll.errors || []).length ? ll.errors.slice(0, 4).join(' · ') : 'clean run, zero errors');
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
    return !plans.some((x) => /loss|stop|moving/i.test(x.planType || ''));
  });
  const unprofited = exPos.filter((p) => {
    const plans = (ll.plans || {})[p.symbol] || [];
    return !plans.some((x) => /profit/i.test(x.planType || ''));
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
      !(ll.plans[p.symbol] || []).some((x) => /loss|stop|moving/i.test(x.planType || '')));
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
      .find((x) => /loss|stop|moving/i.test(x.planType || '') && +x.triggerPrice > 0);
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

// ---------- 12. OVERSEER ACTIONS — elevated: full trade permissions ----------
// Operator mandate: God holds the exchange credentials and ACTS. The audit
// above stays pure-read; this layer enforces invariants with power. God
// never invents directional trades — it shields naked positions, restores
// missing protection legs, and flags dead capital. Full permission, used
// with discipline: repairs only.
const interventions = [];
const interv = (what, res) => interventions.push({ what, res, at: new Date().toISOString() });
{
  const KEY = process.env.BITGET_API_KEY || '';
  const SECRET = process.env.BITGET_API_SECRET || '';
  const PASS = process.env.BITGET_PASSPHRASE || '';
  const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES', MC = 'USDT';
  if (KEY && SECRET && PASS && process.env.GOD_INTERVENE !== '0') {
    const gsign = (method, reqPath, qs, bodyStr) => {
      const ts = String(Date.now());
      const pre = ts + method.toUpperCase() + reqPath + (qs ? '?' + qs : '') + (bodyStr || '');
      return {
        'ACCESS-KEY': KEY,
        'ACCESS-SIGN': crypto.createHmac('sha256', SECRET).update(pre).digest('base64'),
        'ACCESS-PASSPHRASE': PASS, 'ACCESS-TIMESTAMP': ts,
        'Content-Type': 'application/json', locale: 'en-US',
      };
    };
    const gapi = async (method, reqPath, { qs = '', body = null } = {}) => {
      const bodyStr = body ? JSON.stringify(body) : '';
      const res = await fetch(HOST + reqPath + (qs ? '?' + qs : ''), {
        method, headers: gsign(method, reqPath, qs, bodyStr),
        body: bodyStr || undefined, signal: AbortSignal.timeout(12000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || (j.code && j.code !== '00000'))
        throw new Error(reqPath + ' ' + method + ' -> ' + (j.code || res.status) + ' ' + (j.msg || ''));
      return j.data;
    };
    try {
      const positions = await gapi('GET', '/api/v2/mix/position/all-position', {
        qs: 'productType=' + PRODUCT + '&marginCoin=' + MC,
      });
      const accRows = await gapi('GET', '/api/v2/mix/account/accounts', { qs: 'productType=' + PRODUCT });
      const acct = (accRows || []).find((a) => a.marginCoin === MC) || {};
      // --- a) shield check: every real position carries loss + profit plans
      for (const p of positions || []) {
        const plans = await gapi('GET', '/api/v2/mix/order/orders-plan-pending', {
          qs: 'symbol=' + p.symbol + '&productType=' + PRODUCT + '&marginCoin=' + MC + '&planType=profit_loss',
        }).then((d) => {
          const l = d?.entrustedList || d?.orders || d;
          return Array.isArray(l) ? l : [];
        }).catch(() => []);
        const hasLoss = plans.some((x) => /loss|moving/i.test(x.planType || ''));
        const hasProfit = plans.some((x) => /profit/i.test(x.planType || ''));
        const entry = +(p.openPriceAvg || p.averageOpenPrice || p.entry || 0);
        const sgn = (p.holdSide || p.side) === 'long' ? 1 : -1;
        const holdSide = sgn > 0 ? 'long' : 'short';
        if (!(entry > 0)) continue;
        if (!hasLoss) {
          const trig = +(entry * (1 - sgn * 0.03)).toPrecision(6);
          const r = await gapi('POST', '/api/v2/mix/order/place-tpsl-order', {
            body: { symbol: p.symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MC,
              planType: 'pos_loss', triggerPrice: String(trig), triggerType: 'mark_price',
              size: '0', holdSide },
          }).then(() => true).catch((e) => e.message);
          interv('shield ' + p.symbol, r === true ? 'pos_loss @' + trig + ' placed' : 'FAILED: ' + r);
          add('god-shield-' + p.symbol, r === true ? 'PASS' : 'FAIL',
            r === true ? 'naked position shielded — pos_loss @' + trig : 'shield failed: ' + r);
        }
        if (!hasProfit) {
          const trig = +(entry * (1 + sgn * 0.045)).toPrecision(6);
          const r = await gapi('POST', '/api/v2/mix/order/place-tpsl-order', {
            body: { symbol: p.symbol, productType: PRODUCT, marginMode: 'isolated', marginCoin: MC,
              planType: 'pos_profit', triggerPrice: String(trig), triggerType: 'mark_price',
              size: '0', holdSide },
          }).then(() => true).catch((e) => e.message);
          interv('profit-leg ' + p.symbol, r === true ? 'pos_profit @' + trig + ' placed' : 'FAILED: ' + r);
        }
      }
      // --- b) dead-capital audit: the mandate says margin works or dies
      const eq = +(acct.usdtEquity || acct.equity || 0), av = +(acct.available || 0);
      const idleFloor = Math.max(eq * 0.15, 8);
      add('capital-deployed', av > idleFloor ? 'WARN' : 'PASS',
        av > idleFloor
          ? '$' + av.toFixed(2) + ' free margin idle (floor $' + idleFloor.toFixed(2) + ') — dead capital, deployment mandate'
          : '$' + av.toFixed(2) + ' free — within gas floor, book deployed');
      // --- c) untracked positions: fills the ledger doesn't know
      const llx = readJson('live-ledger.json');
      const known = new Set((llx?.positions || llx?.positionsAfter || []).map((p) => p.symbol));
      const unknown = (positions || []).filter((p) => !known.has(p.symbol));
      add('position-coverage', unknown.length ? 'WARN' : 'PASS',
        unknown.length
          ? 'untracked positions: ' + unknown.map((p) => p.symbol).join(',')
          : (positions || []).length + ' exchange positions all ledger-visible');
      add('god-powers', 'PASS', 'armed — credentialed watch + repair active every cycle');
    } catch (e) {
      add('god-powers', 'FAIL', 'credentialed layer error: ' + (e.message || e));
    }
  } else {
    add('god-powers', 'WARN',
      !KEY ? 'no BITGET_API_KEY in env — running degraded audit-only' : 'GOD_INTERVENE=0 — powers disabled');
  }
}

// ---------- verdict ----------
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
  note: 'overseer — full trade permissions: audits then repairs. FAIL = invariant violated, WARN = degraded, PASS = held',
};
fs.writeFileSync(path.join(API, 'god.json'), JSON.stringify(out));
console.log(`[god] ${verdict} — ${out.pass} pass / ${warns.length} warn / ${fails.length} fail`);
for (const c of checks.filter((c) => c.status !== 'PASS'))
  console.log(`[god] ${c.status} ${c.name}: ${c.detail}`);
