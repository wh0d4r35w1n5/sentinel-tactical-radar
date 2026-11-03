#!/usr/bin/env node
// forward-evidence.mjs — the Will Evans audit instrument.
//
// Pairs real open->close fills into position outcomes, attributes ownership
// from the opening fill, and publishes an
// honest forward-evidence scoreboard:
//   * net P&L after fees per engine and overall
//   * independent-episode count (episodes whose windows don't overlap —
//     Will's standing critique of "millions of overlapping sim trades")
//   * equity curve + max drawdown from realized episode nets
//   * live mean%/WR vs the frozen backtest claim the engine was deployed on
//
// Runs every 5 min via systemd timer; writes api/forward-evidence.json.
import fs from 'fs';
import path from 'path';

const ROOT = '/opt/sentinel';
const S = (f) => path.join(ROOT, 'state', f);
const A = (f) => path.join(ROOT, 'api', f);
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// the deployed spec each engine was frozen on — kept here so the scoreboard
// can't quietly move goalposts. dip: +1.79%/trade 95%WR; pump: +1.25% 95%WR.
const CLAIM = {
  dip: { meanPctPerTrade: 1.79, wrPct: 95, note: 'dip>=2%/2h -> 1.2% stop +2% TP, held-out' },
  pump: { meanPctPerTrade: 1.25, wrPct: 95, note: 'pump>=3%/2h short -> 2% stop +1.5% TP, held-out' },
};

const fills = (readJ(S('real-fills.json'), {}).fills || [])
  .filter((f) => f.tradeSide === 'open' || f.tradeSide === 'close')
  .sort((a, b) => (+a.ts || 0) - (+b.ts || 0));

// ---- pair fills into position outcomes (FIFO, including partial closes) -----
// Bitget can split one position exit over several fills. Keep a single outcome
// per position seat so fragments never inflate the forward sample count.
const seats = Object.values(readJ(S('execution-seats.json'), {}) || {})
  .filter((s) => s && s.cell && s.symbol && +s.cTime > 0);
const seatFor = (symbol, dir, ts) => seats
  .filter((s) => s.symbol === symbol && (!s.side || s.side === dir))
  .map((s) => ({ s, delta: Math.abs((+s.cTime || 0) - (+ts || 0)) }))
  .filter((x) => x.delta < 90e3)
  .sort((a, b) => a.delta - b.delta)[0]?.s || null;
const ownerOfOpen = (f) => f._manual === false || f.src === 'api' ? 'bot'
  : f._manual === true || ['ios', 'web', 'manual', 'operator'].includes(String(f.src || '').toLowerCase()) ? 'manual'
    : 'unattributed';
const queues = Object.create(null); // `${symbol}:${dir}` -> FIFO opening lots
const positions = new Map();
const positionFor = (key, seed) => {
  if (!positions.has(key)) positions.set(key, {
    ...seed, key, openedQty: 0, remainingQty: 0, closedQty: 0,
    entryCost: 0, closedEntryCost: 0, exitValue: 0, net: 0, closeTs: null,
  });
  return positions.get(key);
};
for (const f of fills) {
  const dir = f.side === 'buy' ? 'long' : 'short';
  const k = `${f.symbol}:${dir}`;
  queues[k] ||= [];
  if (f.tradeSide === 'open') {
    const size = +f.size || 0;
    if (!(size > 0)) continue;
    const seat = seatFor(f.symbol, dir, f.ts);
    const orderKey = f.orderId || f.tradeId || f.ts;
    const pKey = seat ? `seat:${f.symbol}:${dir}:${seat.cTime}:${seat.cell}`
      : `order:${f.symbol}:${dir}:${orderKey}`;
    const p = positionFor(pKey, {
      symbol: f.symbol, dir, owner: ownerOfOpen(f), cell: seat?.cell || null,
      openTs: +f.ts || null, seatTime: seat ? +seat.cTime : null,
    });
    if (p.owner !== ownerOfOpen(f)) p.owner = 'unattributed';
    const openTs = +f.ts;
    if (Number.isFinite(openTs) && openTs > 0) p.openTs = p.openTs ? Math.min(p.openTs, openTs) : openTs;
    p.openedQty += size;
    p.remainingQty += size;
    p.entryCost += size * (+f.price || 0);
    queues[k].push({ f, p, remain: size, feeRemain: +f.fee || 0 });
    continue;
  }

  const closeSize = +f.size || 0;
  let qty = closeSize, matchedQty = 0;
  const chunks = [];
  while (qty > 1e-12 && queues[k].length) {
    const o = queues[k][0];
    const before = o.remain;
    const take = Math.min(qty, before);
    const openFee = before > 0 ? o.feeRemain * (take / before) : 0;
    o.feeRemain -= openFee;
    o.remain -= take;
    qty -= take;
    matchedQty += take;
    chunks.push({ o, take, openFee });
    o.p.remainingQty = Math.max(0, o.p.remainingQty - take);
    o.p.closedQty += take;
    o.p.closedEntryCost += take * (+o.f.price || 0);
    o.p.exitValue += take * (+f.price || 0);
    o.p.closeTs = Math.max(o.p.closeTs || 0, +f.ts || 0);
    if (o.remain <= 1e-12) queues[k].shift();
  }
  if (matchedQty > 0 && closeSize > 0) {
    for (const { o, take, openFee } of chunks) {
      const share = take / closeSize;
      o.p.net += (+f.profit || 0) * share - (+f.fee || 0) * share - openFee;
    }
  }
  // A close with no opening lot in this ledger is still real exchange P&L, but
  // its owner and entry basis cannot be established safely.
  if (qty > 1e-12 && closeSize > 0) {
    const share = qty / closeSize;
    const orphanKey = `orphan:${f.symbol}:${dir}:${f.orderId || f.tradeId || f.ts}`;
    const orphan = positionFor(orphanKey, {
      symbol: f.symbol, dir, owner: f._manual === true ? 'manual' : 'unattributed',
      cell: null, openTs: null, seatTime: null,
    });
    orphan.closedQty += qty;
    orphan.exitValue += qty * (+f.price || 0);
    orphan.net += (+f.profit || 0) * share - (+f.fee || 0) * share;
    orphan.closeTs = Math.max(orphan.closeTs || 0, +f.ts || 0);
  }
}
const episodes = [...positions.values()]
  .filter((p) => p.closedQty > 0)
  .map((p) => {
    const complete = p.openedQty > 0 && p.remainingQty <= Math.max(1e-10, p.openedQty * 1e-8);
    const entryPx = p.closedQty > 0 ? p.closedEntryCost / p.closedQty : null;
    const exitPx = p.closedQty > 0 ? p.exitValue / p.closedQty : null;
    const notionalUsd = p.closedEntryCost || null;
    const returnPct = notionalUsd > 0 ? p.net / notionalUsd * 100 : null;
    const engine = p.owner === 'bot' ? (p.dir === 'long' ? 'dip' : 'pump')
      : p.owner === 'manual' ? 'operator' : 'unattributed';
    return { ...p, engine, complete, entryPx, exitPx, notionalUsd, returnPct };
  });

// ---- independence: episodes whose windows overlap any other engine episode --
const eng = episodes.filter((e) => e.owner === 'bot');
for (const e of eng) {
  e.overlap = eng.some((o) => o !== e && o.closeTs && e.openTs &&
    o.openTs < (e.closeTs || Infinity) && e.openTs < o.closeTs);
}
const indep = eng.filter((e) => !e.overlap);

// ---- equity curve + maxDD on realized nets ----------------------------------
let eq = 0, peak = 0, maxDD = 0;
const curve = [];
for (const e of [...eng].sort((a, b) => a.closeTs - b.closeTs)) {
  eq += e.net;
  peak = Math.max(peak, eq);
  maxDD = Math.max(maxDD, peak - eq);
  curve.push({ t: e.closeTs, eq: +eq.toFixed(4) });
}

const stats = (list) => {
  const n = list.length;
  if (!n) return { n: 0 };
  const nets = list.map((e) => e.net);
  const wins = nets.filter((x) => x > 0).length;
  const rets = list.filter((e) => Number.isFinite(e.returnPct)).map((e) => e.returnPct);
  return {
    n,
    netUsd: +nets.reduce((a, x) => a + x, 0).toFixed(4),
    wrPct: +(wins / n * 100).toFixed(1),
    meanPct: rets.length ? +(rets.reduce((a, x) => a + x, 0) / rets.length).toFixed(3) : null,
  };
};

const since = eng.length ? Math.min(...eng.map((e) => e.openTs || e.closeTs)) : null;
const out = {
  ts: new Date().toISOString(),
  windowStart: since ? new Date(since).toISOString() : null,
  episodes: {
    total: eng.length,
    independent: indep.length,
    clustered: eng.length - indep.length,
    dip: stats(eng.filter((e) => e.engine === 'dip')),
    pump: stats(eng.filter((e) => e.engine === 'pump')),
    operator: stats(episodes.filter((e) => e.owner === 'manual')),
    unattributed: stats(episodes.filter((e) => e.owner === 'unattributed')),
  },
  realized: {
    netUsd: +eng.reduce((a, e) => a + e.net, 0).toFixed(4),
    equityCurve: curve.slice(-500),
    maxDrawdownUsd: +maxDD.toFixed(4),
  },
  claims: Object.fromEntries(Object.entries(CLAIM).map(([k, c]) => {
    const live = stats(eng.filter((e) => e.engine === k));
    return [k, { backtest: c, live }];
  })),
  verdict: (() => {
    const net = eng.reduce((a, e) => a + e.net, 0);
    if (eng.length < 10) return 'insufficient live episodes — backtest claims remain unverified';
    return net > 0 ? `live net positive over ${eng.length} episodes (+$${net.toFixed(2)})`
                   : `live net NEGATIVE over ${eng.length} episodes ($${net.toFixed(2)}) — backtest edge not confirmed`;
  })(),
};
fs.writeFileSync(A('forward-evidence.json'), JSON.stringify(out, null, 1));
console.log(`forward-evidence: ${eng.length} episodes (${indep.length} indep) net $${out.realized.netUsd} maxDD $${out.realized.maxDrawdownUsd} — ${out.verdict}`);

// ==================== cell-admission validator (the 24/7 proof loop) =========
// Operator standing order 2026-10-20: "produce highly profitable highly proven
// strategies 24/7". This is where forward proof earns its tier — no committee,
// no vibes: seat-attributed forward episodes promote probation -> live at
// n>=3 with positive CI95, demote to 'dead' at n>=3 with a confidently-
// negative CI95, and reviewedAt refreshes only while the record still
// qualifies for its tier — a stale stamp halts entries by design.
// (Operator order 2026-10-20: promotion threshold 30 -> 3 episodes. Small
// samples get honest CIs — Student-t criticals, not the 1.96 normal
// approximation: at df=2 the bar is 4.30, so 3 episodes promote only when
// they're consistently and strongly positive.)
const T95 = [[60, 2.000], [40, 2.021], [30, 2.042], [20, 2.086], [15, 2.131],
  [12, 2.179], [10, 2.228], [9, 2.262], [8, 2.306], [7, 2.365], [6, 2.447],
  [5, 2.571], [4, 2.776], [3, 3.182], [2, 4.303], [1, 12.706]];
const tCrit95 = (df) => (T95.find(([d]) => df >= d) || [0, 2.0])[1];
try {
  const admPath = S('cell-admission.json');
  const adm = readJ(admPath, null);
  if (adm && adm.cells) {
    const cellEps = {};
    for (const e of episodes) {
      if (e.owner === 'bot' && e.complete && e.cell) (cellEps[e.cell] ||= []).push(e);
    }
    for (const [name, c] of Object.entries(adm.cells)) {
      const eps = cellEps[name] || [];
      const n = eps.length;
      const netUsd = +eps.reduce((a, e) => a + e.net, 0).toFixed(4);
      const rets = eps.filter((e) => Number.isFinite(e.returnPct)).map((e) => e.returnPct);
      const meanPct = rets.length ? rets.reduce((a, x) => a + x, 0) / rets.length : null;
      const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, x) => a + (x - meanPct) ** 2, 0) / (rets.length - 1)) : null;
      const tc = rets.length > 1 ? tCrit95(rets.length - 1) : null;
      const ci95 = meanPct != null && sd != null
        ? [+(meanPct - tc * sd / Math.sqrt(rets.length)).toFixed(4),
           +(meanPct + tc * sd / Math.sqrt(rets.length)).toFixed(4)] : null;
      c.forward = { episodes: n, netUsd, meanPct: meanPct != null ? +meanPct.toFixed(4) : null, ci95, asOf: new Date().toISOString() };
      if (c.status === 'probation' && n >= 3 && netUsd > 0 && ci95 && ci95[0] > 0) {
        Object.assign(c, { status: 'live', source: 'validated-forward-exits',
          episodes: n, netAfterCost: +meanPct.toFixed(4), ci: ci95,
          promotedAt: new Date().toISOString() });
        console.log(`cell-admission: ${name} PROMOTED probation->live on ${n} forward episodes (net $${netUsd}, CI95 ${ci95})`);
      } else if (n >= 3 && ci95 && ci95[1] < 0 && netUsd < 0) {
        c.status = 'dead';
        c.deadAt = new Date().toISOString();
        console.log(`cell-admission: ${name} DEMOTED to dead — ${n} forward episodes confidently negative (net $${netUsd}, CI95 ${ci95})`);
      }
      // Re-verify the record still qualifies for its tier before renewing the
      // stamp — a cell that stops qualifying rots on purpose.
      const qualifies =
        (c.status === 'live' && c.source === 'validated-forward-exits' &&
         c.episodes >= 3 && c.netAfterCost > 0 && c.ci?.[0] > 0) ||
        (c.status === 'probation' && c.source === 'mega-backtest-1m' &&
         c.episodes >= 200 && c.netAfterCost > 0 && (c.sqn >= 1 || c.ci?.[0] > 0));
      c.reviewedAt = qualifies ? new Date().toISOString() : c.reviewedAt;
    }
    fs.writeFileSync(admPath, JSON.stringify(adm, null, 1));
    const st = Object.entries(adm.cells).map(([k, c]) => `${k}:${c.status}${c.forward?.episodes ? `(${c.forward.episodes}fwd)` : ''}`).join(' ');
    console.log(`cell-admission: ${st}`);
  }
} catch (e) {
  console.log('cell-admission validator skipped:', e.message);
}

// ==================== shadow-grader (counterfactual expectancy) ====================
// Resolves shadow/census rows against subsequent 15m candles: did the refused
// trade hit its SL? How far did it run (MFE)? Where was it at the 4h horizon?
// This is what turns "we logged the refusal" into "we measured the refusal".
try {
  const KL = readJ(S('klines-15m.json'), {});
  const gradedPath = S('shadow-graded.json');
  const graded = new Set(Object.keys(readJ(gradedPath, {})));
  const resolutions = [];
  const FEE_RT = 0.12; // round-trip taker fee %
  const HORIZON_BARS = 16; // 4h of 15m candles
  const ledgers = [
    ['liq-shadow', S('liq-shadow.jsonl')],
    ['census', S('pattern-census.jsonl')],
  ];
  let scanned = 0;
  for (const [led, file] of ledgers) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').trim().split('\n'); } catch { continue; }
    for (const l of lines.slice(-6000)) {
      if (scanned > 12000) break;
      let r; try { r = JSON.parse(l); } catch { continue; }
      const entry = +(r.entryPx || r.px), ts = +r.ts;
      if (!(entry > 0 && ts > 0)) continue;
      const rule = (r.rule && typeof r.rule === 'object') ? r.rule : {};
      const _s0 = r.side || r.dir || '';
      const _long0 = _s0 ? _s0 === 'long' : (+r.slPx || entry * (1 - (+(rule.slPct) || 0) / 100)) < entry;
      const slPct = +(rule.slPct) || null, tpPct = +(rule.tpPct) || null;
      const sl = +r.slPx || (slPct ? (_long0 ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100)) : NaN);
      const tp = tpPct ? (_long0 ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100)) : NaN;
      const managed = sl > 0 || tp > 0;
      const key = `v2:${led}:${ts}:${r.sym}`;
      if (graded.has(key)) continue;
      const k = KL[r.sym]; if (!k?.rows?.length) continue;
      const rows = k.rows;
      // first candle strictly after the journal timestamp
      let i0 = rows.length - 1;
      while (i0 > 0 && rows[i0 - 1].t > ts) i0--;
      if (i0 >= rows.length || rows[i0].t <= ts) { if (rows[i0].t > ts) void 0; else continue; }
      const side = _s0 || (sl < entry ? 'long' : 'short');
      const long = side === 'long';
      scanned++;
      let slHit = false, tpHit = false, mfe = 0, mae = 0, ret = null, bars = 0, resolved = false;
      for (let i = i0; i < rows.length && bars < HORIZON_BARS; i++, bars++) {
        const c = rows[i];
        const fav = long ? (c.h - entry) / entry : (entry - c.l) / entry;
        const adv = long ? (c.l - entry) / entry : (entry - c.h) / entry;
        if (fav > mfe) mfe = fav;
        if (adv < mae) mae = adv;
        if (sl > 0 && (long ? c.l <= sl : c.h >= sl)) { slHit = true; resolved = true; break; }
        if (tp > 0 && (long ? c.h >= tp : c.l <= tp)) { tpHit = true; resolved = true; break; }
      }
      if (!slHit && bars >= HORIZON_BARS) {
        const last = rows[Math.min(i0 + HORIZON_BARS - 1, rows.length - 1)];
        ret = long ? (last.c - entry) / entry : (entry - last.c) / entry;
        resolved = true;
      }
      if (!resolved) continue; // still in-flight — grade next cycle
      graded.add(key);
      const f = r.factors ? Object.keys(r.factors).filter(k2 => r.factors[k2])                        : [r.gate, r.rule].filter(Boolean).map(x => typeof x === 'object' ? JSON.stringify(x) : String(x));
      resolutions.push({
        ts, sym: r.sym, led, side, pattern: r.pattern || null,
        score: r.score ?? r.titanScore ?? null,
        factors: f, bars, slHit, tpHit, managed,
        mfePct: +(mfe * 100).toFixed(3), maePct: +(mae * 100).toFixed(3),
        retPct: ret == null ? null : +(ret * 100).toFixed(3),
        netPct: tpHit ? +((Math.abs(tp - entry) / entry) * 100 - FEE_RT).toFixed(3)
                     : slHit ? -((Math.abs(entry - sl) / entry) * 100 + FEE_RT)
                     : +((ret * 100) - FEE_RT).toFixed(3),
      });
      if (resolutions.length >= 4000) break;
    }
  }
  if (resolutions.length) {
    fs.appendFileSync(S('shadow-grades.jsonl'), resolutions.map(r => JSON.stringify(r)).join('\n') + '\n');
    const keep = Object.fromEntries([...graded].slice(-30000).map(k => [k, 1]));
    fs.writeFileSync(gradedPath, JSON.stringify(keep));
  }
  // ---- scoreboard: expectancy by score bucket + factor ----
  let all = [];
  try { all = fs.readFileSync(S('shadow-grades.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { }
  const agg = (rows) => {
    const n = rows.length;
    if (!n) return null;
    const nets = rows.map(r => r.netPct);
    return {
      n, slHitPct: +(100 * rows.filter(r => r.slHit).length / n).toFixed(1),
      tpHitPct: +(100 * rows.filter(r => r.tpHit).length / n).toFixed(1),
      meanMfePct: +(nets && rows.reduce((a, r) => a + r.mfePct, 0) / n).toFixed(3),
      meanNetPct: +(nets.reduce((a, b) => a + b, 0) / n).toFixed(3),
      winPct: +(100 * rows.filter(r => r.netPct > 0).length / n).toFixed(1),
    };
  };
  const byScore = {}, byFactor = {}, byLedgerSide = {};
  for (const r of all) {
    const sb = r.score == null ? 'na' : `s${r.score}`;
    (byScore[sb] = byScore[sb] || []).push(r);
    for (const f2 of r.factors || []) { if (typeof f2 !== 'string') continue; (byFactor[f2] = byFactor[f2] || []).push(r); }
    const ls = `${r.led}:${r.side}`;
    (byLedgerSide[ls] = byLedgerSide[ls] || []).push(r);
  }
  const ev = {
    at: Date.now(), graded: all.length, newThisRun: resolutions.length,
    horizon: '4h/SL', feeRtPct: FEE_RT,
    byScore: Object.fromEntries(Object.entries(byScore).map(([k, v]) => [k, agg(v)])),
    byFactor: Object.fromEntries(Object.entries(byFactor).map(([k, v]) => [k, agg(v)])),
    byLedgerSide: Object.fromEntries(Object.entries(byLedgerSide).map(([k, v]) => [k, agg(v)])),
  };
  fs.writeFileSync(A('shadow-evidence.json'), JSON.stringify(ev, null, 1));
  console.log(`shadow-grader: +${resolutions.length} resolutions (${all.length} total) → api/shadow-evidence.json`);
} catch (e) {
  console.log('shadow-grader error:', e?.message || e);
}
