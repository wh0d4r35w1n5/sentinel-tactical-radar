// green-watch.mjs — standing operator directive enforcer:
// "there must always be at least 1 green recovery trade."
// Each tick: if no open position shows uplUsd > 0, nominate recovery
// setups for the strongest current 24h gainers (longs only).
// Candidates still pass through EVERY exec gate downstream — drift
// confirm (+0.4% favor), auto-deny, cmd-deny, risk policy, cell rules.
// This script only writes pending setups; it never orders directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE = path.join(ROOT, 'state');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); };
const j = async (u) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};

const MAX_PENDING = +(process.env.GREEN_WATCH_MAX_PENDING || 4);
const TOP_N = +(process.env.GREEN_WATCH_TOP_N || 3);
const MIN_CHG = +(process.env.GREEN_WATCH_MIN_CHG || 0.02);   // +2% 24h minimum
const MIN_VOL = +(process.env.GREEN_WATCH_MIN_VOL || 2e6);    // $2M 24h quote vol
const RISK_PCT = +(process.env.GREEN_WATCH_RISK_PCT || 6);
const TTL_MIN = +(process.env.GREEN_WATCH_TTL_MIN || 30);
const STOP_PCT = +(process.env.GREEN_WATCH_STOP_PCT || 0.015); // 1.5% stop
const MIN_AVAIL = +(process.env.GREEN_WATCH_MIN_AVAIL || 8);  // need margin headroom

const wealth = readJson(path.join(ROOT, 'api', 'wealth-live.json'));
const positions = wealth?.futures?.positions || [];
if (positions.some(p => (+p.uplUsd || 0) > 0)) {
  console.log('green-watch: green seat present —',
    positions.map(p => `${p.k} ${(+p.uplUsd).toFixed(2)}`).join(', '));
  process.exit(0);
}

const avail = +wealth?.futures?.availableUsd || 0;
if (avail < MIN_AVAIL) {
  console.log(`green-watch: no green seat but avail $${avail.toFixed(2)} < $${MIN_AVAIL} — no nomination`);
  process.exit(0);
}

const setupsFile = path.join(STATE, 'cmd-setups.json');
const setupsDoc = readJson(setupsFile) || { setups: [] };
const pending = (setupsDoc.setups || []).filter(s => !s.status || s.status === 'pending');
if (pending.length >= MAX_PENDING) {
  console.log(`green-watch: ${pending.length} pending setups already — holding`);
  process.exit(0);
}

const now = Date.now();
const deny = new Set();
for (const e of readJson(path.join(STATE, 'auto-deny.json'))?.entries || [])
  if ((+e.until || 0) > now && e.side === 'long') deny.add(e.symbol);
for (const s of readJson(path.join(STATE, 'cmd-deny.json'))?.symbols || []) deny.add(s);

const openSyms = new Set(positions.map(p => String(p.k || '').split(':')[0]));
const pendingSyms = new Set(pending.map(s => s.symbol));

const MIN_MOM15 = +(process.env.GREEN_WATCH_MIN_MOM15 || -0.003); // not actively dumping
const mom15 = async (sym) => {
  try {
    const r = await j(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=15m&limit=2`);
    const rows = r.data || [];
    if (rows.length < 2) return null;
    const prev = +rows[rows.length - 2][4], cur = +rows[rows.length - 1][4];
    return prev > 0 ? (cur - prev) / prev : null;
  } catch { return null; }
};

const d = await j('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
const pool = (d.data || [])
  .filter(t => t.symbol.endsWith('USDT'))
  .map(t => ({
    symbol: t.symbol,
    lastPr: +t.lastPr,
    chg: +t.change24h,
    vol: +t.usdtVolume || 0,
  }))
  .filter(t => Number.isFinite(t.lastPr) && t.lastPr > 0
    && t.chg >= MIN_CHG && t.vol >= MIN_VOL
    && !deny.has(t.symbol) && !openSyms.has(t.symbol) && !pendingSyms.has(t.symbol))
  .sort((a, b) => b.chg - a.chg)
  .slice(0, 8);

const cands = [];
for (const c of pool) {
  const m = await mom15(c.symbol);
  if (m == null || m >= MIN_MOM15) { c.mom15 = m; cands.push(c); }
  if (cands.length >= TOP_N) break;
}

if (!cands.length) {
  console.log('green-watch: no qualifying gainers (denied/open/pending filtered) — nothing nominated');
  process.exit(0);
}

const tpsFor = (px) => [
  { px: +(px * 1.006).toPrecision(8), pct: 18 },
  { px: +(px * 1.012).toPrecision(8), pct: 17 },
  { px: +(px * 1.022).toPrecision(8), pct: 20 },
  { px: +(px * 1.04).toPrecision(8),  pct: 20 },
  { px: +(px * 1.08).toPrecision(8),  pct: 15 },
];

const added = [];
setupsDoc.setups = setupsDoc.setups || [];
for (const c of cands) {
  const id = `green-${c.symbol}-${now}`;
  setupsDoc.setups.push({
    id, symbol: c.symbol, direction: 'LONG', mode: 'market',
    entryPx: c.lastPr, slPx: +(c.lastPr * (1 - STOP_PCT)).toPrecision(8), lastPx: c.lastPr,
    tps: tpsFor(c.lastPr),
    riskPct: RISK_PCT, ttlMin: TTL_MIN, strategy: 'operator-green-recovery',
    createdAt: now,
    note: `green-watch recovery — +${(c.chg * 100).toFixed(1)}% 24h, vol $${(c.vol / 1e6).toFixed(1)}M`,
    status: 'pending',
  });
  added.push(`${c.symbol} +${(c.chg * 100).toFixed(1)}%`);
}
writeJson(setupsFile, setupsDoc);
console.log('green-watch: nominated', added.join(', '));
process.exit(0);
