// fade-watch — evidence-deployed pump-fade short lane (15m bars).
// Sim on THIS book's live 15m klines (940 syms, fees in): a 5-bar up-move
// with z>=3.0 on >=2x median volume reverts within 3-12 bars — SHORT the
// close, n=916, WR 63-73%, mean +0.29..0.51%/ep, SQN +9.2..13.7, monotone
// with strictness (structural plateau, not a fit). Long crash-fades were
// fee-thin (+0.10%/ep) — this lane is SHORT-only by evidence.
// Curupira/VYX mechanism: forced flow exhausts, displacement reverts.
// Emits 'bounce'-mode SHORT setups at the signal close (fills on touch ≈
// immediately; dies on ttl if it can't). Same hard rails via the exec:
// funding veto (crowded-short = squeeze fuel), emit cap, per-symbol
// cooldown, max pending. Probationary — SQN-grader convicts it if it bleeds.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SETUPS = path.join(DIR, '..', 'state', 'cmd-setups.json');
const FIRED = path.join(DIR, '..', 'state', 'fade-fired.json');
const K15 = path.join(DIR, '..', 'state', 'klines-15m.json');
const SEEN = path.join(DIR, '..', 'state', 'fade-seen.json');
const HOST = 'https://api.bitget.com';

const Z_MIN = +(process.env.FADE_Z || 3.0);          // sim best plateau
const VOL_X = +(process.env.FADE_VOL_X || 2.0);      // >=2x median quote vol
const MOVE_BARS = +(process.env.FADE_MOVE_BARS || 4);// 4-bar displacement (z on close-to-close4)
const SL_PCT = +(process.env.FADE_SL_PCT || 1.5);    // sim SL1.5/TP2.5 SQN 9.91
const TP_PCT = +(process.env.FADE_TP_PCT || 2.5);
const RISK_PCT = +(process.env.FADE_RISK_PCT || 1);
const TTL_MIN = +(process.env.FADE_TTL_MIN || 10);   // fade must fill fast or die
const COOLDOWN_MS = +(process.env.FADE_COOLDOWN_H || 4) * 3600e3;
const MAX_EMIT = +(process.env.FADE_MAX_EMIT || 2);
const MAX_PENDING = +(process.env.FADE_MAX_PENDING || 3);
const FUND_MIN = +(process.env.FADE_FUND_MIN || -0.0003); // crowded-short veto
const POLL_MS = +(process.env.FADE_POLL_MS || 60e3);
const MIN_ROWS = 40;

const log = (...a) => console.log(`[fade-watch ${new Date().toISOString().slice(11, 19)}]`, ...a);
const fired = (() => { try { return JSON.parse(fs.readFileSync(FIRED, 'utf8')); } catch { return {}; } })();
const seen = (() => { try { return JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch { return {}; } })();
const save = (p, o) => { try { fs.writeFileSync(p + '.tmp', JSON.stringify(o)); fs.renameSync(p + '.tmp', p); } catch {} };
const readSetups = () => { try { return JSON.parse(fs.readFileSync(SETUPS, 'utf8')); } catch { return { setups: [] }; } };
const writeSetups = (sf) => save(SETUPS, sf);

async function fundRate(sym) {
  try {
    const r = await fetch(`${HOST}/api/v3/market/current-fund-rate?category=USDT-FUTURES&symbol=${sym}`,
      { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const d = Array.isArray(j.data) ? j.data[0] : j.data;
    return d?.fundingRate != null ? +d.fundingRate : null;
  } catch { return null; }
}

async function tick() {
  const now = Date.now();
  let book = {};
  try { book = JSON.parse(fs.readFileSync(K15, 'utf8')); } catch { return; }
  const sf = readSetups();
  const dead = ['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected'];
  const pendThisLane = (sf.setups || []).filter((s) => s.strategy === 'pump-fade' && !dead.includes(s.status)).length;
  const pendingSyms = new Set((sf.setups || []).filter((s) => !dead.includes(s.status)).map((s) => s.symbol));
  if (pendThisLane >= MAX_PENDING) { log(`${pendThisLane} fade setups pending — cap`); return; }
  let emitted = 0;
  for (const [sym, blob] of Object.entries(book)) {
    if (emitted >= MAX_EMIT || pendThisLane + emitted >= MAX_PENDING) break;
    const rows = (blob?.rows || blob) || [];
    if (rows.length < MIN_ROWS) continue;
    const last = rows[rows.length - 1];
    const bt = last.t ?? last[0];
    if (seen[sym] === bt) continue;                    // only on a newly closed bar
    seen[sym] = bt;
    if (fired[sym] && now - fired[sym] < COOLDOWN_MS) continue;
    if (pendingSyms.has(sym)) continue;
    const c = rows.map((r) => r.c ?? r[4]);
    const vs = rows.map((r) => r.qv ?? r[5] ?? 0);
    const rets = [];
    for (let i = MOVE_BARS; i < c.length; i++) rets.push((c[i] - c[i - MOVE_BARS]) / c[i - MOVE_BARS]);
    if (rets.length < 20) continue;
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1)) || 1e-9;
    const vmed = [...vs].sort((a, b) => a - b)[Math.floor(vs.length / 2)] || 1;
    const i = c.length - 1;
    const z = (rets[rets.length - 1] - mu) / sd;
    if (z < Z_MIN || vs[i] < VOL_X * vmed) continue;   // pump bar only → SHORT
    const fr = await fundRate(sym);
    if (fr != null && fr < FUND_MIN) { seen[sym] = bt; save(SEEN, seen); log(`${sym} skipped — funding ${(fr * 100).toFixed(3)}% (crowded short)`); continue; }
    const entryPx = +c[i].toPrecision(6);
    const slPx = +(entryPx * (1 + SL_PCT / 100)).toPrecision(6);
    const tpPx = +(entryPx * (1 - TP_PCT / 100)).toPrecision(6);
    const id = `fade-${sym}-${now}`;
    sf.setups = (sf.setups || []).filter((s) => s.status !== 'expired').slice(-120);
    sf.setups.push({
      id, symbol: sym, direction: 'SHORT', mode: 'bounce',
      entryPx, slPx, tps: [{ px: tpPx, pct: 100 }],
      riskPct: RISK_PCT, ttlMin: TTL_MIN,
      strategy: 'pump-fade',
      createdAt: new Date(now).toISOString(),
      note: `pump-fade — 15m z=${z.toFixed(1)} vol=${(vs[i] / vmed).toFixed(1)}x · sell ${entryPx} · SL +${SL_PCT}% · TP -${TP_PCT}% · 15m sim n=916 SQN+9.9 WR66%`,
    });
    writeSetups(sf); save(SEEN, seen);
    fired[sym] = now; save(FIRED, fired);
    emitted++;
    log(`FIRED ${sym} SHORT — 15m pump z=${z.toFixed(1)} vol=${(vs[i] / vmed).toFixed(1)}x · entry ${entryPx} · SL ${slPx} · TP ${tpPx} · funding ${fr == null ? 'n/a' : (fr * 100).toFixed(3) + '%'} → setup ${id}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  save(SEEN, seen);
  if (!emitted) log('scan — no qualified pump fades');
}

(async () => {
  log(`armed — 15m pump-fade SHORT · z>=${Z_MIN} vol>=${VOL_X}x · SL+${SL_PCT}% TP-${TP_PCT}% · emit cap ${MAX_EMIT}/scan · funding veto ${FUND_MIN}`);
  for (;;) {
    await tick().catch((e) => log('tick err', e.message?.slice(0, 120)));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
