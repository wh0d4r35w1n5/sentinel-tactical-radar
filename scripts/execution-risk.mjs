// One source of truth for entry identity, risk sizing and the Bitget write boundary.
// All fractions below are fractions (0.005 = 0.5%), never percent units.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXIT_MODEL = 'wyckoff-1h-atr2-v1';
const WYCKOFF = new Set(['Wyckoff', 'Wyckoff Event', 'Wyckoff Spring',
  'Wyckoff Test', 'Wyckoff JTC', 'Wyckoff LPS', 'Wyckoff Ice Break', 'Wyckoff Upthrust']);
export const canonicalCell = (strategy, direction) =>
  !['LONG', 'SHORT'].includes(direction) ? null
    : WYCKOFF.has(strategy) ? `Wyckoff:${direction}`
    : typeof strategy === 'string' && strategy ? `${strategy}:${direction}` : null;
export const isWyckoffTrail = (strategy, direction) =>
  canonicalCell(strategy, direction) === 'Wyckoff:LONG';
const fail = (message) => { throw new Error(`entry-risk: ${message}`); };
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const positive = (x) => finite(x) && x > 0;
const reducing = (body) => String(body?.reduceOnly).toUpperCase() === 'YES' ||
  String(body?.tradeSide).toLowerCase() === 'close';

export function readJson(file, optional = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; fail(`unreadable ${path.basename(file)}`); }
}

export function validateRiskPolicy(p) {
  if (p?.version !== 1) fail('missing or unsupported risk policy');
  for (const k of ['riskPerTradeFraction', 'maxPortfolioRiskFraction',
    'maxPositionMarginFraction', 'roundTripFeeFraction',
    'slippageFraction', 'liquidationBufferFraction', 'liquidationBandUseFraction',
    'maxPriceDriftFraction']) {
    if (!positive(p[k]) || p[k] >= 1) fail(`invalid ${k}`);
  }
  // 0 is a valid reserve: operator ordered 100% deployment 2026-11-04.
  if (!(+p.cashReserveFraction >= 0) || p.cashReserveFraction >= 1) fail('invalid cashReserveFraction');
  for (const k of ['maxGrossNotionalMultiple', 'maxPositionNotionalMultiple',
    'maxSnapshotAgeMs', 'maxEvidenceAgeMs']) if (!positive(p[k])) fail(`invalid ${k}`);
  if (!Number.isInteger(p.maxLeverage) || p.maxLeverage < 1) fail('invalid maxLeverage');
  if (p.minLeverage != null && (!Number.isInteger(p.minLeverage) || p.minLeverage < 1 || p.minLeverage > p.maxLeverage)) fail('invalid minLeverage');
  if (p.riskPerTradeFraction > p.maxPortfolioRiskFraction ||
      p.maxPositionNotionalMultiple > p.maxGrossNotionalMultiple) fail('inconsistent risk caps');
  if (p.allowTopUps !== false || p.requireForwardEvidence !== true ||
      p.exitModel !== EXIT_MODEL) fail('unvalidated entry/exit policy');
  return p;
}

export function assertAdmission(intent, { allowlist, admission, envelope, now = Date.now(), risk }) {
  validateRiskPolicy(risk);
  const cell = canonicalCell(intent.strategy, intent.direction);
  const pocket = `${cell}:${intent.symbol}`;
  // OPEN SEASON (operator order 2026-11-04 — "trade literally anything you
  // want, no restrictions from my side"): state/open-season.json lifts the
  // listing requirement — an unrecorded or below-bar-but-unconvicted cell
  // admits at probation (half risk) and its episodes become the record.
  // Convictions still ride: 'dead' records, non-positive means, measured-
  // losing symbols and the envelope brake all still refuse.
  const openSeason = process.env.SENTINEL_OPEN_SEASON != null
    ? process.env.SENTINEL_OPEN_SEASON === '1'
    : readJson(path.join(ROOT, 'state', 'open-season.json'), true)?.enabled === true;
  const listed = openSeason ||
    allowlist?.cells?.includes(cell) || allowlist?.cells?.includes(pocket);
  if (!cell || allowlist?.enabled !== true || !listed)
    fail(`strategy not admitted: ${intent.strategy || 'unattributed'} ${intent.direction || '?'}`);
  if (!['LONG', 'SHORT'].includes(intent.direction)) fail('unvalidated direction');
  const evidence = admission?.cells?.[pocket] || admission?.cells?.[cell];
  // Two evidence tiers, both honestly labeled. 'live' = the cell holds
  // qualifying FORWARD episodes under this exact exit model — full risk
  // budget. 'probation' = backtest-scale proof only — the cell trades at
  // half risk while it accrues the forward record needed for promotion.
  // A name prefix alone, or evidence under a different exit model, admits
  // nothing.
  let tier =
    evidence?.status === 'live' && evidence.source === 'validated-forward-exits' &&
    evidence.episodes >= 3 ? 'live'
    : evidence?.status === 'probation' && evidence.source === 'mega-backtest-1m' &&
      evidence.episodes >= 200 ? 'probation'
    : null;
  // 'live' needs significance: positive CI lower bound. 'probation' is the
  // evidence-accrual tier — half risk budget — so its bar is a positive
  // mean plus either SQN>=1 or a positive CI bound, not promotion-grade
  // significance. Cells below the bar present nothing.
  // Exit-model parity is required for 'live' tier — that evidence was
  // measured under this exact live exit. 'probation' is explicitly the
  // not-yet-live-validated tier: model variance is priced by half-risk
  // while the forward record accrues under the real exit.
  if (intent.exitModel && tier === 'live' && intent.exitModel !== evidence?.exitModel)
    fail('unvalidated exit model');
  if (!tier && openSeason && evidence?.status !== 'dead' && !(evidence && !(evidence.netAfterCost > 0)))
    tier = 'probation';
  if (!tier || (evidence && (
      !(evidence.netAfterCost > 0) ||
      (tier === 'live' && !(evidence.ci?.[0] > 0)) ||
      (tier === 'probation' && !openSeason && !(evidence.sqn >= 1 || evidence.ci?.[0] > 0)))))
    fail(`${cell} has no qualifying evidence`);
  const evidenceAt = Date.parse(evidence?.reviewedAt);
  if (evidence && (!finite(evidenceAt) || now < evidenceAt || now - evidenceAt > risk.maxEvidenceAgeMs))
    fail('stale admission evidence');
  const at = +envelope?.at;
  if (!positive(at) || now < at || now - at > 180000) fail('stale deployment envelope');
  if (envelope.brake) fail('deployment envelope brake');
  const canonical = envelope.twinOf?.[intent.symbol] || intent.symbol;
  if ([intent.symbol, canonical].some(s => envelope.cells?.[s]?.verdict === 'loser'))
    fail('measured-losing symbol');
  return { cell, tier };
}

export function sizeEntry(input, policy) {
  const p = validateRiskPolicy(policy);
  const { equityUsd, availableUsd, entryPrice, stopPrice, direction, contract,
    existingNotionalUsd = 0, existingRiskUsd = 0, riskScale = 1,
    requestedNotionalUsd = Infinity, leverageCap = Infinity, fixedLeverage } = input;
  if (![equityUsd, availableUsd, entryPrice, stopPrice].every(positive))
    fail('no ownable equity/free margin or invalid price');
  if (!finite(existingNotionalUsd) || existingNotionalUsd < 0 ||
      !finite(existingRiskUsd) || existingRiskUsd < 0) fail('unknown portfolio exposure/stop risk');
  if (!finite(riskScale) || riskScale <= 0 || riskScale > 1) fail('invalid risk scale');
  if (!['LONG', 'SHORT'].includes(direction) ||
      (direction === 'LONG' ? stopPrice >= entryPrice : stopPrice <= entryPrice))
    fail('stop is not on the loss side');
  if (!(requestedNotionalUsd > 0) || !(leverageCap > 0)) fail('zero requested budget or leverage cap');
  const stopFraction = Math.abs(entryPrice - stopPrice) / entryPrice;
  const costFraction = p.roundTripFeeFraction + p.slippageFraction;
  const riskFraction = stopFraction + costFraction;
  const riskBudgetUsd = Math.min(equityUsd * p.riskPerTradeFraction * riskScale,
    equityUsd * p.maxPortfolioRiskFraction - existingRiskUsd);
  const cashBudget = availableUsd - equityUsd * p.cashReserveFraction;
  const bandCap = Math.floor(p.liquidationBandUseFraction /
    (stopFraction + p.liquidationBufferFraction + costFraction));
  const cap = Math.floor(Math.min(p.maxLeverage, +contract?.maxLev, leverageCap, bandCap));
  if (!(riskBudgetUsd > 0) || !(cashBudget > 0) || !(cap >= 1)) fail('risk/cash/liquidation budget exhausted');
  let notionalUsd = Math.min(riskBudgetUsd / riskFraction,
    equityUsd * p.maxPositionNotionalMultiple,
    equityUsd * p.maxGrossNotionalMultiple - existingNotionalUsd, requestedNotionalUsd,
    cashBudget / (1 / cap + costFraction), equityUsd * p.maxPositionMarginFraction * cap);
  if (!(notionalUsd > 0)) fail('notional budget exhausted');
  const marginBudget = Math.min(equityUsd * p.maxPositionMarginFraction,
    cashBudget - notionalUsd * costFraction);
  // leverage floor (operator order 2026-11-04 — wants real leverage on
  // seats): the seat borrows at policy.minLeverage minimum; risk budget
  // still sizes the notional, the stop still sizes the loss.
  const levFloor = Number.isInteger(p.minLeverage) && p.minLeverage >= 1 ? Math.min(p.minLeverage, cap) : 1;
  let leverage = fixedLeverage ?? Math.max(levFloor, Math.ceil(notionalUsd / marginBudget - 1e-12));
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > cap) fail('leverage exceeds risk/liquidation cap');
  // A lower exchange leverage cap shrinks affordable size; it never enlarges the risk budget.
  notionalUsd = Math.min(notionalUsd, cashBudget / (1 / leverage + costFraction),
    equityUsd * p.maxPositionMarginFraction * leverage);
  const places = +contract?.sizePlace;
  const step = +contract?.sizeMultiplier || 10 ** -places;
  if (!Number.isInteger(places) || places < 0 || places > 12 || !positive(step)) fail('invalid contract step');
  let size = Number((Math.floor((notionalUsd / entryPrice) / step) * step).toFixed(places));
  if (size * entryPrice > notionalUsd) size = Number((size - step).toFixed(places));
  if (!(size > 0) || size < +contract.minTradeNum ||
      size * entryPrice < +contract.minTradeUSDT) fail('contract minimum exceeds risk-sized quantity');
  notionalUsd = size * entryPrice;
  return { size, leverage, notionalUsd, marginUsd: notionalUsd / leverage,
    riskUsd: notionalUsd * riskFraction, riskBudgetUsd, stopFraction, costFraction,
    feeReserveUsd: notionalUsd * costFraction,
    effectiveNotional: notionalUsd / equityUsd };
}

export function portfolioExposure(positions, plansBySymbol) {
  let notionalUsd = 0, riskUsd = 0;
  for (const p of positions) {
    const qty = +p.total;
    if (!(qty > 0)) continue;
    const mark = +p.markPrice;
    if (!positive(mark) || !['long', 'short'].includes(p.holdSide)) fail('unknown position valuation');
    notionalUsd += qty * mark;
    const stops = (plansBySymbol[p.symbol] || []).filter(s =>
      /loss|stop|moving/.test(s.planType || '') && (!s.holdSide || s.holdSide === p.holdSide) &&
      positive(+s.triggerPrice) && (s.planType === 'pos_loss' || +s.size >= qty));
    if (!stops.length) fail(`no verified whole-position stop for ${p.symbol}`);
    const stop = p.holdSide === 'long'
      ? Math.max(...stops.map(s => +s.triggerPrice)) : Math.min(...stops.map(s => +s.triggerPrice));
    riskUsd += qty * Math.max(0, p.holdSide === 'long' ? mark - stop : stop - mark);
  }
  return { notionalUsd, riskUsd };
}

// Dependency-injected for transport-free regression tests. prepare() is read-only.
export function createEntryGuard({ root = ROOT, mode, snapshot, now = Date.now }) {
  const intents = new Map();
  const state = (name, optional = false) => readJson(path.join(root, 'state', name), optional);
  const audit = (record) => fs.appendFileSync(path.join(root, 'state', 'entry-risk-audit.jsonl'),
    JSON.stringify({ ts: now(), ...record }) + '\n');
  const controls = () => {
    if (state('execution-maintenance.json', true)?.active === true) fail('execution maintenance');
    if (state('cmd-halt.json', true)?.halted === true) fail('operator halt');
    const risk = validateRiskPolicy(state('execution-risk.json'));
    return { risk, allowlist: state('live-cell-allowlist.json'),
      admission: state('cell-admission.json'), envelope: state('deploy-envelope.json'), now: now() };
  };
  // A pending record means an earlier submitted order was never reconciled.
  // Self-heal when the outcome is provable: no position = nothing to protect;
  // a position whose whole-size stop is verified = protected. Anything else
  // (position with unverified cover, a resting open order, an unreadable
  // snapshot) keeps the book blocked.
  const reconcilePending = async () => {
    const pending = state('entry-risk-pending.json', true);
    if (!pending) return;
    const s = await snapshot(pending.symbol).catch(() => null);
    if (!s) fail('previous entry needs position/stop reconciliation');
    if (s.pending.some(o => !reducing(o) && o.symbol === pending.symbol))
      fail('previous entry still rests on the book');
    const pos = s.positions.find(p => p.symbol === pending.symbol && +p.total > 0);
    if (pos) portfolioExposure([pos], s.plans); // throws unless a whole-stop is verified
    fs.unlinkSync(path.join(root, 'state', 'entry-risk-pending.json'));
    audit({ event: 'reconciled', clientOid: pending.clientOid, symbol: pending.symbol,
      how: pos ? 'protected' : 'no-position' });
  };
  const calculate = async (intent, fixedLeverage) => {
    const c = controls();
    await reconcilePending();
    const { cell, tier } = assertAdmission(intent, c);
    const s = await snapshot(intent.symbol);
    const twin = (symbol) => c.envelope.twinOf?.[symbol] || symbol;
    if (s.positions.some(p => +p.total > 0 && twin(p.symbol) === twin(intent.symbol)))
      fail('underlying already held; duplicate/twin entries are disabled');
    if (s.positions.some(p => +p.total > 0 && p.symbol === intent.symbol))
      fail('position already exists; top-ups and manual-position additions are disabled');
    if (s.pending.some(o => !reducing(o))) fail('pending opening order must be reconciled first');
    const price = s.price;
    if (!positive(price) || Math.abs(price / intent.entryPrice - 1) > c.risk.maxPriceDriftFraction)
      fail('stale entry price');
    const exp = portfolioExposure(s.positions, s.plans);
    // open season: unproven cells pay full risk — the operator ordered
    // maximal deployment; half-size probation was the listing-era caution.
    const openSeasonNow = process.env.SENTINEL_OPEN_SEASON != null
      ? process.env.SENTINEL_OPEN_SEASON === '1'
      : readJson(path.join(root, 'state', 'open-season.json'), true)?.enabled === true;
    const tierScale = tier === 'probation' && !openSeasonNow ? 0.5 : 1; // backtest-only proof earns half risk
    const sized = sizeEntry({ ...intent, equityUsd: s.equityUsd, availableUsd: s.availableUsd,
      entryPrice: price, contract: s.contract, existingNotionalUsd: exp.notionalUsd,
      riskScale: (intent.riskScale ?? 1) * tierScale,
      existingRiskUsd: exp.riskUsd + exp.notionalUsd *
        (c.risk.roundTripFeeFraction / 2 + c.risk.slippageFraction), fixedLeverage }, c.risk);
    return { ...sized, cell, evidenceTier: tier, exitModel: EXIT_MODEL, entryPrice: price, stopPrice: intent.stopPrice,
      symbol: intent.symbol, direction: intent.direction, actualLeverage: s.actualLeverage,
      marginMode: s.marginMode, checkedAt: now() };
  };
  async function prepare(intent) {
    if (mode !== 'live') fail('risk-controlled entries require an explicit live adapter');
    for (const [k, v] of intents) if (now() - v.at > 30000) intents.delete(k); // sweep expired permits
    const result = await calculate(intent);
    const clientOid = `risk-${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    intents.set(clientOid, { ...intent, result, at: now() });
    return { ...result, clientOid };
  }
  async function run(method, endpoint, body, send) {
    if (mode !== 'live' || method.toUpperCase() === 'GET') return send();
    if (/\/(?:set-leverage|set-margin-mode)$/.test(endpoint)) {
      const c = controls(), s = await snapshot(body?.symbol);
      const manual = new Set([
        ...(state('manual-book.json', true)?.syms || []),
        ...(state('cmd-manual-hold.json', true)?.syms || []),
      ].map(s => String(s).toUpperCase()));
      if (s.positions.some(p => +p.total > 0 && p.symbol === body?.symbol) &&
          !manual.has(String(body?.symbol || '').toUpperCase()))
        fail('automatic leverage/margin changes on held positions are disabled');
      if (endpoint.endsWith('set-leverage') &&
          (!Number.isInteger(+body?.leverage) || +body.leverage < 1 || +body.leverage > c.risk.maxLeverage))
        fail('invalid exchange leverage request');
      if (endpoint.endsWith('set-margin-mode') && body?.marginMode !== 'isolated')
        fail('new machine positions must be isolated');
      return send();
    }
    const placement = /\/(?:place-order|batch-place-order|place-plan-order)$/.test(endpoint);
    const mutation = /\/(?:modify-order|modify-plan-order|modify-batch-orders)$/.test(endpoint);
    if (!placement && !mutation) return send();
    if (endpoint === '/api/v2/mix/order/place-order' && reducing(body)) return send();
    // Raw API, spot-buy, batch, trigger-entry and amend routes cannot bypass a permit.
    if (endpoint !== '/api/v2/mix/order/place-order') fail('unvalidated opening/amendment route');
    const id = String(body?.clientOid || '');
    const intent = intents.get(id);
    if (!intent || now() - intent.at > 30000) fail('missing or expired risk-sized entry permit');
    const lock = path.join(root, 'state', 'entry-risk.lock');
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
    } catch (e) {
      if (fd != null) fs.closeSync(fd);
      // A crashed process leaves the lock forever — recover locks older
      // than 60s (no entry can legitimately hold one that long) once.
      try {
        const st = fs.statSync(lock);
        if (now() - st.mtimeMs > 60000) {
          fs.unlinkSync(lock);
          fd = fs.openSync(lock, 'wx');
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now(), recovered: true }));
        }
      } catch {}
      if (fd == null) fail('another entry is in flight (or unresolved entry lock)');
    }
    try {
      const fresh = await calculate(intent, intent.result.leverage);
      const askQty = +body.size;
      if (body.symbol !== intent.symbol || body.side !== (intent.direction === 'LONG' ? 'buy' : 'sell') ||
          body.marginMode !== 'isolated' || body.orderType !== 'market' ||
          +body.presetStopLossPrice !== intent.stopPrice)
        fail(`order differs from its approved risk budget (sym=${body.symbol} side=${body.side} sl=${body.presetStopLossPrice} vs intent ${intent.symbol} sl=${intent.stopPrice})`);
      // Budget shrank between prepare and place? The seat takes
      // min(ask, approved, fresh) — never more than the budget allows.
      const qty = Math.min(askQty, intent.result.size, fresh.size);
      if (!positive(qty)) fail('order size not positive');
      if (fresh.marginMode !== 'isolated' || fresh.actualLeverage !== intent.result.leverage)
        fail('exchange leverage/margin mode not verified');
      // Consume before transport. An uncertain POST must never be retried as a new entry.
      intents.delete(id);
      audit({ event: 'approved', clientOid: id, symbol: body.symbol, ...fresh, size: qty });
      const pendingFile = path.join(root, 'state', 'entry-risk-pending.json');
      fs.writeFileSync(pendingFile,
        JSON.stringify({ clientOid: id, symbol: body.symbol, at: now(),
          size: qty, stopPrice: intent.stopPrice, leverage: intent.result.leverage }), { flag: 'wx' });
      try {
        const result = await send();
        audit({ event: 'submitted', clientOid: id, symbol: body.symbol, orderId: result?.orderId || null });
        return result;
      } catch (e) {
        // A synchronous API rejection ('->' marker) provably did not fill —
        // the pending record would deadlock every later entry. Only
        // transport uncertainty (timeout/5xx) keeps it for reconciliation.
        if (e.message.includes('->')) { try { fs.unlinkSync(pendingFile); } catch {} }
        throw e;
      }
    } catch (e) {
      audit({ event: 'refused-or-uncertain', clientOid: id, symbol: body.symbol, reason: e.message });
      throw e;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
  async function complete(clientOid) {
    const pending = state('entry-risk-pending.json', true);
    if (!pending || pending.clientOid !== clientOid) fail('entry reconciliation identity mismatch');
    const s = await snapshot(pending.symbol);
    const pos = s.positions.find(p => p.symbol === pending.symbol && p.holdSide === 'long' && +p.total > 0);
    if (!pos || +pos.cTime < pending.at - 5000 || +pos.total > pending.size ||
        +pos.leverage !== pending.leverage) fail('entry position not reconciled');
    portfolioExposure([pos], s.plans); // Stop coverage must be verified before another entry.
    const stops = (s.plans[pending.symbol] || []).filter(p => /loss/.test(p.planType || ''));
    if (!stops.some(p => +p.triggerPrice >= pending.stopPrice &&
        (p.planType === 'pos_loss' || +p.size >= +pos.total))) fail('designed stop not verified');
    fs.unlinkSync(path.join(root, 'state', 'entry-risk-pending.json'));
    audit({ event: 'protected', clientOid, symbol: pending.symbol, seatCtime: +pos.cTime });
    return pos;
  }
  return { prepare, run, complete };
}

// Same historical geometry: 14 *closed hourly* true ranges, best prior hourly close.
// side-aware (2026-11-04): shorts trail trough + 2*ATR14 and ratchet DOWN only.
export function hourlyTrail({ rows, entryPrice, initialStop, openedAt, now = Date.now(), priorStop = initialStop, side = 'long' }) {
  const S = side === 'short';
  const closed = rows.filter(r => r.t + 3600000 <= now).sort((a, b) => a.t - b.t);
  if (closed.length < 15 || now - (closed.at(-1).t + 3600000) > 600000) return null;
  if (closed.some((r, i) => ![r.t, r.o, r.h, r.l, r.c].every(finite) ||
      r.h < r.l || r.c <= 0 || (i && r.t - closed[i - 1].t !== 3600000))) return null;
  // Need all closes since entry; otherwise a truncated window could forget the peak.
  if (closed[0].t > openedAt) return null;
  let stop = S ? Math.min(initialStop, priorStop) : Math.max(initialStop, priorStop), peak = entryPrice;
  for (let i = 14; i < closed.length; i++) {
    const b = closed[i];
    if (b.t + 3600000 <= openedAt) continue;
    peak = S ? Math.min(peak, b.c) : Math.max(peak, b.c);
    let tr = 0;
    for (let k = i - 13; k <= i; k++) {
      const r = closed[k], prev = closed[k - 1];
      tr += Math.max(r.h - r.l, Math.abs(r.h - prev.c), Math.abs(r.l - prev.c));
    }
    stop = S ? Math.min(stop, peak + 2 * tr / 14) : Math.max(stop, peak - 2 * tr / 14);
  }
  return { stop, peak, asOf: closed.at(-1).t + 3600000 };
}
