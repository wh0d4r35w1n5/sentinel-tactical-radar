// sqn-factory-live — realtime trigger daemon.
// Every 30s: pull the live tickers board once, synthesize today's
// in-progress daily bar per symbol, evaluate the top promoted factory
// triggers against it, and arm setups the moment a threshold crosses.
// Deploys through cmd-setups.json — full risk rails still apply.
import fs from 'fs';
import path from 'path';
const STATE = '/opt/sentinel/state';
const MAX_LIVE = 6, PROBE_RISK = +(process.env.SQN_FAC_PROBE_RISK || 5), TOPN = 12, LOOP_MS = 30000;

const j = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const setupPath = path.join(STATE, 'cmd-setups.json');
let kl4 = {};
let board = { at: 0, m: {} };

const refreshBoard = async () => {
  const tj = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES',
    { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  const m = {};
  for (const t of (tj.data || [])) if (t.symbol) m[t.symbol] = { last: +t.lastPr || 0, open: +t.openUtc || +t.open || 0, high: +t.high24h || 0, low: +t.low24h || 0 };
  board = { at: Date.now(), m };
};
const trend4h = (sym) => {
  const rows = kl4[sym] && kl4[sym].rows; if (!rows || rows.length < 25) return 0;
  const cl = rows.map((r) => r.c), i = cl.length - 1;
  let s = 0; for (let x = i - 19; x <= i; x++) s += cl[x];
  const sma20 = s / 20;
  return cl[i] > sma20 * 1.005 ? 1 : cl[i] < sma20 * 0.995 ? -1 : 0;
};
const parse = (key) => {
  const m = key.match(/^fac:mom(\d+)-(lt|gt)-(\d+)-(cont|fade):tp(\d+)-sl(\d+):(long|short)$/);
  return m ? { n: +m[1], cmp: m[2], t: +m[3], kind: m[4], tp: +m[5], sl: +m[6], side: m[7] } : null;
};

const pass = async () => {
  try { await refreshBoard(); } catch { return; }
  kl4 = j(path.join(STATE, 'klines-4H.json'), kl4) || kl4;
  const kl = j(path.join(STATE, 'klines-1D.json')); if (!kl) return;
  const fac = j(path.join(STATE, 'sqn-factory.json')); if (!fac) return;
  const q = j(setupPath); if (!q) return;
  const setups = Array.isArray(q) ? q : (q.setups || []);
  const liveFac = setups.filter((s) => String(s.id || '').startsWith('fac-') && s.status === 'armed').length;
  if (liveFac >= MAX_LIVE) return;
  const top = Object.entries(fac.promoted || {})
    .filter(([k]) => /tp\d+-sl\d+:/.test(k))
    .sort((a, b) => b[1].sqn - a[1].sqn).slice(0, TOPN);
  let authored = 0;
  for (const [key, g] of top) {
    if (liveFac + authored >= MAX_LIVE) break;
    const p = parse(key); if (!p) continue; if (p.side === "short") continue; // sqn-factory:SHORT convicted -2.61/55 episodes 2026-11-09
    for (const sym of Object.keys(kl)) {
      if (liveFac + authored >= MAX_LIVE) break;
      const live = board.m[sym]; if (!live || !(live.last > 0)) continue;
      const rows = kl[sym] && kl[sym].rows; if (!rows || rows.length < p.n + 1) continue;
      // n-day change: live last vs the close p.n daily bars back —
      // last kline row may be today's in-progress bar or yesterday's close
      const lastRow = rows[rows.length - 1];
      const isToday = Date.now() - lastRow.t < 26 * 3600e3;
      const idx = isToday ? rows.length - 1 - p.n : rows.length - p.n;
      if (idx < 0) continue;
      const ref = rows[idx].c;
      const chg = (live.last - ref) / ref * 100;
      const fired = p.cmp === 'lt' ? chg < -p.t : chg > p.t;
      if (!fired) continue;
      const dayOpen = isToday && +lastRow.o > 0 ? +lastRow.o : ref; // today's in-progress open, else the 10d ref
      if (p.kind === 'cont') {
        if (p.side === 'short' && !(live.last < dayOpen)) continue; // continuation short needs a red day — SNDK: market-shorted a +4% bounce 3x on a stale 10d trigger
        if (p.side === 'long' && !(live.last > dayOpen)) continue;
      }
      const t = trend4h(sym);
      if (p.side === 'short' && t > -1) continue;
      if (p.side === 'long' && t < 1) continue;
      const FAC_SYM_CD_MS = 6 * 3600e3;
      if (setups.some((s) => s.symbol === sym && String(s.id || '').startsWith('fac-') && Date.now() - (+s.createdAt || 0) < FAC_SYM_CD_MS)) continue; // recently fired (any status) — stop re-shorting the same loser
      const e = live.last, sgn = p.side === 'long' ? 1 : -1;
      setups.push({
        id: 'fac-' + sym + '-' + Date.now(), symbol: sym, direction: p.side.toUpperCase(),
        mode: 'bounce', entryPx: e,
        slPx: +(e * (1 - sgn * p.sl / 100)).toPrecision(6),
        tps: [{ px: +(e * (1 + sgn * p.tp / 100)).toPrecision(6), pct: 85 }],
        pattern: 'fac:mom' + p.n + '-' + p.cmp + '-' + p.t + '-' + p.kind + ':tp' + p.tp + '-sl' + p.sl,
        riskPct: PROBE_RISK, ttlMin: 240, strategy: 'sqn-factory', auto: true,
        createdAt: Date.now(), blockedBy: null, status: 'armed',
        note: 'sqn-factory-live ' + key + ' — sqn ' + g.sqn + ' wr ' + g.wr + '% — live trigger chg' + p.n + '=' + chg.toFixed(1) + '%',
      });
      authored++;
      console.log('[fac-live] AUTHORED', sym, p.side, key, 'chg' + p.n + '=' + chg.toFixed(1) + '%');
    }
  }
  if (authored) {
    if (Array.isArray(q)) fs.writeFileSync(setupPath, JSON.stringify(setups, null, 1));
    else { q.setups = setups; fs.writeFileSync(setupPath, JSON.stringify(q, null, 1)); }
  }
};

console.log('[fac-live] realtime trigger daemon —', LOOP_MS / 1000 + 's cadence');
const loop = async () => { try { await pass(); } catch (e) { console.log('[fac-live] err:', e.message); } setTimeout(loop, LOOP_MS); };
loop();
