// pump-watch — census-validated pump-short entry engine (mirror of dip-watch).
// Watches whitelist 5m closes; when a symbol's 2h ROC spikes >= +PUMP_PCT%,
// writes a SHORT market-mode setup (slPx +STOP% above mark, tp -TP% below).
// 50/50 dual-positive on held-out data, ~95% WR at >=2% trigger (13.4M tests).
// Only 'pump-short' setups are exempted from the global longs-only mandate —
// every other path stays long-only per operator rule.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SETUPS = path.join(DIR, '..', 'state', 'cmd-setups.json');
const FIRED = path.join(DIR, '..', 'state', 'pump-watch-fired.json');

const SYMS = (process.env.PUMP_SYMS || 'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,XRPUSDT,AVAXUSDT,NEARUSDT,LINKUSDT,ARBUSDT,OPUSDT,SUIUSDT,INJUSDT,MAGICUSDT,USUSDT,LUMIAUSDT,CKBUSDT').split(',');
const PUMP_PCT = +(process.env.PUMP_PCT || 2.0);     // 2h pump threshold %
const STOP_PCT = +(process.env.PUMP_STOP_PCT || 1.2);
const TP_PCT = +(process.env.PUMP_TP_PCT || 2.0);
const RISK_PCT = +(process.env.PUMP_RISK_PCT || 1);
const TTL_MIN = +(process.env.PUMP_TTL_MIN || 30);
const COOLDOWN_MS = +(process.env.PUMP_COOLDOWN_H || 6) * 3600e3;
// same-beta cap: every alt pump-short is the same melt-up bet (operator rule
// 2026-10-13 — 'all the shorts look the same, too much concentration').
// One pump-short seat at a time: an open short (pump-short is the book's
// ONLY short lane — a manual short counts too) or a pending pump setup on
// ANY symbol blocks a new emit.
const MAX_OPEN = +(process.env.PUMP_MAX_OPEN || 1);
const POLL_MS = +(process.env.PUMP_POLL_MS || 60000);
// confirmation doctrine (operator order 2026-10-14): no more shorting a
// live melt-up — emit a 'br' breakdown setup: the tape must first print
// <= hi2h*(1-BRKDN_PCT), then the SHORT sells the retest back toward
// structure. SL sits above the pump high (true invalidation).
const BRKDN_PCT = +(process.env.PUMP_BRKDN_PCT || 0.7);
const SL_BUF_PCT = +(process.env.PUMP_SL_BUF_PCT || 0.8);
const HOST = 'https://api.bitget.com';
const LIQ_INTEL = path.join(DIR, '..', 'api', 'liq-intel.json');
const SHADOW = path.join(DIR, '..', 'state', 'liq-shadow.jsonl');
import { shortFactors } from './short-factors.mjs';
// A/B evidence: gate-blocked setups log the full counterfactual so the
// grader scores "what the blocked short would have done" on identical tape.
const shadow = (row) => { try { fs.appendFileSync(SHADOW, JSON.stringify(row) + '\n'); } catch {} };
// aggr-grade intel — stale/unavailable feed degrades to no-gate
const liqIntel = () => {
  try {
    const j = JSON.parse(fs.readFileSync(LIQ_INTEL, 'utf8'));
    if (Date.now() - new Date(j.ts).getTime() > 90e3) return null;
    return j;
  } catch { return null; }
};

const fired = (() => { try { return JSON.parse(fs.readFileSync(FIRED, 'utf8')); } catch { return {}; } })();
const saveFired = () => { try { fs.writeFileSync(FIRED + '.tmp', JSON.stringify(fired)); fs.renameSync(FIRED + '.tmp', FIRED); } catch {} };

async function lastTwoHourRoc(sym) {
  try {
    const r = await fetch(`${HOST}/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=5m&limit=25`);
    const j = await r.json();
    const k = j.data;
    if (!Array.isArray(k) || k.length < 25) return null;
    k.sort((a, b) => +a[0] - +b[0]);
    const c0 = +k[k.length - 25][4], c1 = +k[k.length - 1][4];
    const hi = Math.max(...k.map((r) => +r[2]));
    return { roc: (c1 / c0 - 1) * 100, px: c1, hi };
  } catch { return null; }
}
const readSetups = () => { try { return JSON.parse(fs.readFileSync(SETUPS, 'utf8')); } catch { return { setups: [] }; } };
const writeSetups = (j) => { fs.writeFileSync(SETUPS + '.tmp', JSON.stringify(j)); fs.renameSync(SETUPS + '.tmp', SETUPS); };
const LEDGER = path.join(DIR, '..', 'api', 'live-ledger.json');
// open shorts = every short seat on the book right now (pump-short is the
// only machine short channel; manual app shorts count too — same beta risk)
const openShortCount = () => {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return (j.positionsAfter || []).filter((p) => p.side === 'short').length;
  } catch { return 0; }
};

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
log(`pump-watch up — ${SYMS.length} syms · pump>=+${PUMP_PCT}% · stop +${STOP_PCT}% · tp -${TP_PCT}% · max-open ${MAX_OPEN} (same-beta cap) · poll ${POLL_MS / 1000}s`);

async function tick() {
  const now = Date.now();
  for (const sym of SYMS) {
    try {
      if (fired[sym] && now - fired[sym] < COOLDOWN_MS) continue;
      const sf = readSetups();
      const pending = (sf.setups || []).some(
        (s) => s.symbol === sym && s.strategy === 'pump-short' &&
          !['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected'].includes(s.status),
      );
      if (pending) continue;
      const q = await lastTwoHourRoc(sym);
      if (!q || q.roc < PUMP_PCT) continue;
      // same-beta cap — open shorts + pending pump setups across ALL symbols.
      // Setups route through cmd-setups (operator queue), which skips the
      // exec's corr-cluster tape gate — the cap has to live HERE or three
      // correlated alts can stack identical melt-up bets in one window.
      const shortsHeld = openShortCount();
      const pendingPumps = (sf.setups || []).filter(
        (s) => s.strategy === 'pump-short' &&
          !['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected'].includes(s.status),
      ).length;
      if (shortsHeld + pendingPumps >= MAX_OPEN) {
        shadow({ ts: now, src: 'pump', sym, px: q.px, side: 'short',
          gate: 'same-beta-cap', gateUsd: shortsHeld + pendingPumps,
          trig: `roc2h +${q.roc.toFixed(2)}%`,
          rule: { slPct: STOP_PCT, tpPct: TP_PCT, ttlMin: TTL_MIN } });
        log(`${sym} SKIP — same-beta cap: ${shortsHeld} short(s) held + ${pendingPumps} pending >= ${MAX_OPEN}`);
        continue;
      }
      // ---- liq-intel gate ----
      // Active SHORT squeeze on the symbol = the pump's engine is forced
      // buying — shorting into it is suicide (the GOMO defect). Global
      // short cascade = market melt-up — stand down entirely. Fresh LONG
      // liqs = the pump losing fuel — proceed, annotated.
      const liq = liqIntel();
      let liqNote = '';
      if (liq) {
        if (liq.global?.cascade === 'short') {
          shadow({ ts: now, src: 'pump', sym, px: q.px, side: 'short',
            gate: 'global-short-cascade', gateUsd: liq.global.cascadeUsd || 0,
            trig: `roc2h +${q.roc.toFixed(2)}%`,
            rule: { slPct: STOP_PCT, tpPct: TP_PCT, ttlMin: TTL_MIN } });
          log(`${sym} SKIP — global short-liq cascade $${((liq.global.cascadeUsd || 0) / 1e6).toFixed(0)}M/15m (melt-up)`);
          continue;
        }
        const c = liq.symbols?.[sym];
        if (c) {
          const sl15 = c.liq15m?.short || 0, ll15 = c.liq15m?.long || 0;
          if (sl15 >= 25e3 && sl15 > 2 * ll15) {
            shadow({ ts: now, src: 'pump', sym, px: q.px, side: 'short',
              gate: 'sym-short-squeeze', gateUsd: sl15,
              trig: `roc2h +${q.roc.toFixed(2)}%`,
              rule: { slPct: STOP_PCT, tpPct: TP_PCT, ttlMin: TTL_MIN } });
            log(`${sym} SKIP — active short squeeze $${(sl15 / 1e3).toFixed(0)}k rekt/15m`);
            continue;
          }
          if (ll15 >= 25e3) liqNote += ` · $${(ll15 / 1e3).toFixed(0)}k longs rekt/15m (fuel spent)`;
          if (sl15 >= 10e3) liqNote += ` · $${(sl15 / 1e3).toFixed(0)}k squeeze fading`;
          const d = c.flow15m?.delta || 0;
          if (Math.abs(d) >= 20e3) liqNote += ` · flow ${d > 0 ? '+' : '-'}$${(Math.abs(d) / 1e3).toFixed(0)}k`;
        }
      }
      const comp = shortFactors(sym, { breakdown: true });
      const hi = q.hi > 0 ? q.hi : q.px;
      const breakPx = +(hi * (1 - BRKDN_PCT / 100)).toPrecision(6);   // roll-over print required FIRST
      const entryPx = +(hi * (1 - BRKDN_PCT * 0.3 / 100)).toPrecision(6); // sell the retest of broken structure
      const slPx = +(hi * (1 + SL_BUF_PCT / 100)).toPrecision(6);     // invalidation = above the pump high
      const tpPx = +(entryPx * (1 - TP_PCT / 100)).toPrecision(6);
      const id = `pump-${sym}-${now}`;
      sf.setups = (sf.setups || []).filter((s) => s.status !== 'expired').slice(-100);
      sf.setups.push({
        id, symbol: sym, direction: 'SHORT', mode: 'br',
        breakPx, entryPx,
        slPx, tps: [{ px: tpPx, pct: 100 }],
        riskPct: RISK_PCT, ttlMin: Math.max(TTL_MIN, 90),
        strategy: 'pump-short', factors: comp.factors, factorScore: comp.score,
        createdAt: new Date(now).toISOString(),
        note: `census pump-short — 2h ROC +${q.roc.toFixed(2)}% >= +${PUMP_PCT}% · CONFIRMED breakdown: print <=${breakPx} then sell retest ~${entryPx} · SL above pump high ${hi.toPrecision(6)} · factors ${comp.score}/9${liqNote}`,
      });
      writeSetups(sf);
      fired[sym] = now; saveFired();
      log(`FIRED ${sym} SHORT — 2h ROC +${q.roc.toFixed(2)}% · px ${q.px} · sl ${slPx} · tp ${tpPx} → setup ${id}`);
    } catch (e) { log(`${sym} err ${e.message?.slice(0, 80)}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
}

for (;;) {
  await tick();
  await new Promise((r) => setTimeout(r, POLL_MS));
}
