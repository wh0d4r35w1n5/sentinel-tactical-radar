// dip-watch — census-validated dip-scalp entry engine.
// Watches whitelist 5m closes; when a symbol's 2h ROC dips <= -DIP_PCT%,
// writes a market-mode operator setup (slPx -STOP%, tp +TP%) into
// state/cmd-setups.json. The exec's setup channel fires it next cycle —
// hard rails still ride (deny, dedup, RR floor, stop-side, protection).
// Cell proven on census v3: dip24gt1 x s3 x tp2 x h0 x c288 — held-out
// SQN ~3.5-4.4, +0.59-0.67%/trade, ~74% WR on 3,392 real episodes.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SETUPS = path.join(DIR, '..', 'state', 'cmd-setups.json');
const FIRED = path.join(DIR, '..', 'state', 'dip-watch-fired.json');

const SYMS = (process.env.DIP_SYMS || 'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,XRPUSDT,AVAXUSDT,NEARUSDT,LINKUSDT,ARBUSDT,OPUSDT,SUIUSDT,INJUSDT').split(',');
const DIP_PCT = +(process.env.DIP_PCT || 1.0);      // 2h dip threshold %
const DEEP_2H = +(process.env.DIP_DEEP_2H || 1.0);  // deepDip: 2h leg
const DEEP_6H = +(process.env.DIP_DEEP_6H || 2.0);  // deepDip: 6h leg
const STOP_PCT = +(process.env.DIP_STOP_PCT || 3.0); // stop width (plateau 2-4%)
const TP_PCT = +(process.env.DIP_TP_PCT || 2.0);    // fixed target
const RISK_PCT = +(process.env.DIP_RISK_PCT || 1);  // equity % risked per setup
const TTL_MIN = +(process.env.DIP_TTL_MIN || 30);   // setup dies if unfilled
const COOLDOWN_MS = +(process.env.DIP_COOLDOWN_H || 6) * 3600e3; // per-symbol re-fire gap
const POLL_MS = +(process.env.DIP_POLL_MS || 60000);
const HOST = 'https://api.bitget.com';
const LIQ_INTEL = path.join(DIR, '..', 'api', 'liq-intel.json');
const SHADOW = path.join(DIR, '..', 'state', 'liq-shadow.jsonl');
// A/B evidence for Will's review: every gate-blocked setup logs the full
// counterfactual (symbol, price, trigger, gate) so the grader can score
// "what the blocked trade would have done" on identical real tape.
const shadow = (row) => { try { fs.appendFileSync(SHADOW, JSON.stringify(row) + '\n'); } catch {} };
// aggr-grade intel — stale/unavailable feed degrades to no-gate, never blocks
const liqIntel = () => {
  try {
    const j = JSON.parse(fs.readFileSync(LIQ_INTEL, 'utf8'));
    if (Date.now() - new Date(j.ts).getTime() > 90e3) return null;
    return j;
  } catch { return null; }
};

const fired = (() => { try { return JSON.parse(fs.readFileSync(FIRED, 'utf8')); } catch { return {}; } })();
const saveFired = () => { try { fs.writeFileSync(FIRED + '.tmp', JSON.stringify(fired)); fs.renameSync(FIRED + '.tmp', FIRED); } catch {} };

async function lastRocs(sym) {
  try {
    const r = await fetch(`${HOST}/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=5m&limit=73`);
    const j = await r.json();
    const k = j.data;
    if (!Array.isArray(k) || k.length < 73) return null;
    k.sort((a, b) => +a[0] - +b[0]);
    const c1 = +k[k.length - 1][4];
    return {
      roc2h: (c1 / +k[k.length - 25][4] - 1) * 100,
      roc6h: (c1 / +k[k.length - 73][4] - 1) * 100,
      px: c1,
    };
  } catch { return null; }
}

function readSetups() {
  try { return JSON.parse(fs.readFileSync(SETUPS, 'utf8')); } catch { return { setups: [] }; }
}
function writeSetups(j) {
  fs.writeFileSync(SETUPS + '.tmp', JSON.stringify(j));
  fs.renameSync(SETUPS + '.tmp', SETUPS);
}

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
log(`dip-watch up — ${SYMS.length} syms · dip<=-${DIP_PCT}% · stop ${STOP_PCT}% · tp +${TP_PCT}% · poll ${POLL_MS / 1000}s`);

async function tick() {
  const now = Date.now();
  for (const sym of SYMS) {
    try {
      // cooldown
      if (fired[sym] && now - fired[sym] < COOLDOWN_MS) continue;
      // already an open/pending dip setup for this sym?
      const sf = readSetups();
      const pending = (sf.setups || []).some(
        (s) => s.symbol === sym && s.strategy === 'dip24-census' &&
          !['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected'].includes(s.status),
      );
      if (pending) continue;
      const q = await lastRocs(sym);
      // two census-validated triggers: plain 2h dip OR deepDip (2h dip on a
      // bigger 6h washout — the 99% WR pocket cell)
      const plainDip = q && q.roc2h <= -DIP_PCT;
      const deepDip = q && q.roc2h <= -DEEP_2H && q.roc6h <= -DEEP_6H;
      if (!plainDip && !deepDip) continue;
      // ---- liq-intel gate: global waterfall freezes entries; symbol
      // capitulation is the thesis's fuel (annotate, don't block) ----
      const liq = liqIntel();
      let liqNote = '';
      if (liq) {
        if (liq.global?.cascade === 'long') {
          shadow({ ts: now, src: 'dip', sym, px: q.px, side: 'long',
            gate: 'global-long-cascade', gateUsd: liq.global.cascadeUsd || 0,
            trig: deepDip ? 'deepDip' : 'dip24',
            rule: { slPct: STOP_PCT, tpPct: TP_PCT, ttlMin: TTL_MIN } });
          log(`${sym} SKIP — global long-liq cascade $${((liq.global.cascadeUsd || 0) / 1e6).toFixed(0)}M/15m`);
          continue;
        }
        const c = liq.symbols?.[sym];
        if (c) {
          if ((c.liq15m?.long || 0) >= 25e3) liqNote += ` · $${(c.liq15m.long / 1e3).toFixed(0)}k longs rekt/15m (capitulation)`;
          else if ((c.liq15m?.short || 0) >= 25e3) liqNote += ` · $${(c.liq15m.short / 1e3).toFixed(0)}k shorts rekt/15m`;
          const d = c.flow15m?.delta || 0;
          if (Math.abs(d) >= 20e3) liqNote += ` · flow ${d > 0 ? '+' : '-'}$${(Math.abs(d) / 1e3).toFixed(0)}k`;
        }
      }
      const slPx = +(q.px * (1 - STOP_PCT / 100)).toPrecision(6);
      const tpPx = +(q.px * (1 + TP_PCT / 100)).toPrecision(6);
      const id = `dip-${sym}-${now}`;
      sf.setups = (sf.setups || []).filter((s) => s.status !== 'expired').slice(-100);
      sf.setups.push({
        id, symbol: sym, direction: 'LONG', mode: 'market',
        slPx, tps: [{ px: tpPx, pct: 100 }],
        riskPct: RISK_PCT, ttlMin: TTL_MIN,
        strategy: 'dip24-census',
        createdAt: new Date(now).toISOString(),
        note: `census dip entry — 2h ${q.roc2h.toFixed(2)}% · 6h ${q.roc6h.toFixed(2)}% · ${deepDip ? 'deepDip' : 'dip24'} trigger${liqNote}`,
      });
      writeSetups(sf);
      fired[sym] = now; saveFired();
      log(`FIRED ${sym} — 2h ${q.roc2h.toFixed(2)}% 6h ${q.roc6h.toFixed(2)}% [${deepDip ? 'deepDip' : 'dip24'}] · px ${q.px} · sl ${slPx} · tp ${tpPx} → setup ${id}`);
    } catch (e) { log(`${sym} err ${e.message?.slice(0, 80)}`); }
    await new Promise((r) => setTimeout(r, 250)); // polite API pacing
  }
}

for (;;) {
  await tick();
  await new Promise((r) => setTimeout(r, POLL_MS));
}
