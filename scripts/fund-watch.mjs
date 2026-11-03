// fund-watch — funding-rate harvest emitter.
// Polls Bybit linear tickers; when |fundingRate| clears the threshold on a
// demo-routable symbol, writes a market-mode setup toward the COLLECTING
// side into state/cmd-setups.json. Negative rate → shorts pay longs → LONG
// collects (same shape as the proven dip-buy: fade the crowded side).
// Positive rate → longs pay shorts → SHORT collects — emitted only at
// FUND_SHORT_MIN (fat premium only): that rate is the squeeze premium and
// the shape that convicted pump-shorts, so the cell earns or dies on its
// own forward record under 'funding-carry:SHORT'.
// The exec's setup channel fires it next cycle — hard rails still ride
// (deny, dedup, RR floor, stop-side, protection, A$100 caps).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SETUPS = path.join(DIR, '..', 'state', 'cmd-setups.json');
const FIRED = path.join(DIR, '..', 'state', 'fund-watch-fired.json');
const CONTRACTS = path.join(DIR, '..', 'api', 'exec-catalog.json');

const LONG_MIN = +(process.env.FUND_LONG_MIN || 0.04);   // collect long when rate <= -this %/8h
const SHORT_MIN = +(process.env.FUND_SHORT_MIN || 0.10); // collect short only at fat premium %/8h
const STOP_LONG = +(process.env.FUND_STOP_LONG || 1.5);
const STOP_SHORT = +(process.env.FUND_STOP_SHORT || 1.0);
const TP_PCT = +(process.env.FUND_TP_PCT || 2.0);
const RISK_PCT = +(process.env.FUND_RISK_PCT || 1);
const TTL_MIN = +(process.env.FUND_TTL_MIN || 30);
const COOLDOWN_MS = +(process.env.FUND_COOLDOWN_H || 8) * 3600e3;
const MAX_FIRED = +(process.env.FUND_MAX_FIRED || 2);    // per poll, |rate| desc
const POLL_MS = +(process.env.FUND_POLL_MS || 300e3);
const HOSTS = ['https://api-demo.bybit.com', 'https://api.bybit.com'];
const DENY = (process.env.FUND_DENY_SYMS || '').split(',').filter(Boolean);

const fired = (() => { try { return JSON.parse(fs.readFileSync(FIRED, 'utf8')); } catch { return {}; } })();
const saveFired = () => { try { fs.writeFileSync(FIRED + '.tmp', JSON.stringify(fired)); fs.renameSync(FIRED + '.tmp', FIRED); } catch {} };
const readSetups = () => { try { return JSON.parse(fs.readFileSync(SETUPS, 'utf8')); } catch { return { setups: [] }; } };
const writeSetups = (j) => { fs.writeFileSync(SETUPS + '.tmp', JSON.stringify(j)); fs.renameSync(SETUPS + '.tmp', SETUPS); };
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function tickers() {
  for (const h of HOSTS) {
    try {
      const r = await fetch(`${h}/v5/market/tickers?category=linear`);
      const j = await r.json();
      if (Array.isArray(j?.result?.list) && j.result.list.length) return j.result.list;
    } catch {}
  }
  return null;
}

const demoSymbols = () => {
  try {
    const j = JSON.parse(fs.readFileSync(CONTRACTS, 'utf8'));
    const syms = j.symbols || (Array.isArray(j) ? j : Object.keys(j));
    return new Set(syms);
  } catch { return null; }
};

log(`fund-watch up — long<=-${LONG_MIN}%/8h · short>=+${SHORT_MIN}%/8h · poll ${POLL_MS / 60000}m`);

async function tick() {
  const now = Date.now();
  const list = await tickers();
  if (!list) return log('tickers unavailable');
  const routable = demoSymbols(); // null = fail-open (exec's !cm gate still rides)
  let untradeable = new Set();
  try { untradeable = new Set(JSON.parse(fs.readFileSync(ROOT + '/api/live-ledger.json', 'utf8')).untradeable || []); } catch {}
  const cands = [];
  for (const t of list) {
    const sym = t.symbol;
    if (!/USDT$/.test(sym) || DENY.includes(sym)) continue;
    if (untradeable.has(sym)) continue;
    if (routable && !routable.has(sym)) continue;
    const rate = +t.fundingRate * 100; // %/8h
    if (!Number.isFinite(rate)) continue;
    const px = +t.lastPrice;
    if (!(px > 0)) continue;
    if (rate <= -LONG_MIN) cands.push({ sym, dir: 'LONG', rate, px });
    else if (rate >= SHORT_MIN) cands.push({ sym, dir: 'SHORT', rate, px });
  }
  cands.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
  let n = 0;
  for (const c of cands) {
    if (n >= MAX_FIRED) break;
    const key = `${c.sym}:${c.dir}`;
    if (fired[key] && now - fired[key] < COOLDOWN_MS) continue;
    const sf = readSetups();
    const pending = (sf.setups || []).some(
      (s) => s.symbol === c.sym && s.strategy === 'funding-carry' &&
        !['filled', 'cancelled', 'expired', 'failed', 'missed', 'rejected'].includes(s.status));
    if (pending) continue;
    const sgn = c.dir === 'LONG' ? 1 : -1;
    const stopPct = c.dir === 'LONG' ? STOP_LONG : STOP_SHORT;
    const slPx = +(c.px * (1 - sgn * stopPct / 100)).toPrecision(6);
    const tpPx = +(c.px * (1 + sgn * TP_PCT / 100)).toPrecision(6);
    const id = `fund-${c.sym}-${now}`;
    sf.setups = (sf.setups || []).filter((s) => s.status !== 'expired').slice(-100);
    sf.setups.push({
      id, symbol: c.sym, direction: c.dir, mode: 'market',
      slPx, tps: [{ px: tpPx, pct: 100 }],
      riskPct: RISK_PCT, ttlMin: TTL_MIN,
      strategy: 'funding-carry',
      createdAt: new Date(now).toISOString(),
      note: `funding harvest — rate ${c.rate.toFixed(3)}%/8h → ${c.dir.toLowerCase()} collects · px ${c.px}`,
    });
    writeSetups(sf);
    fired[key] = now; saveFired();
    n++;
    log(`FIRED ${c.sym} ${c.dir} — funding ${c.rate.toFixed(3)}%/8h · px ${c.px} · sl ${slPx} · tp ${tpPx} → setup ${id}`);
  }
  if (!n && cands.length) log(`no fire — ${cands.length} candidate(s) on cooldown/pending`);
}

for (;;) {
  await tick().catch((e) => log(`tick err ${e.message?.slice(0, 120)}`));
  await new Promise((r) => setTimeout(r, POLL_MS));
}
