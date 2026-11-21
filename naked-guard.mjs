// naked-guard.mjs — fail-closed seatbelt invariant, runs forever (30s cycle).
// Every exchange position MUST have (a) a live stop-loss plan and (b) at least
// one take-profit plan on Bitget. If a seat is naked:
//   1) try to attach an emergency SL (~1.5% adverse of mark) + TP (~+3%);
//   2) if SL placement fails -> CLOSE THE POSITION. No naked seats, ever.
// Also writes /opt/sentinel/state/naked-guard.json for the board and
// restarts sentinel-statusd when status.json goes stale (>120s).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

for (const line of fs.readFileSync('/opt/sentinel/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES';
const KEY = process.env.BITGET_API_KEY || process.env.BITGET_KEY;
const SEC = process.env.BITGET_API_SECRET || process.env.BITGET_SECRET;
const PAS = process.env.BITGET_API_PASSPHRASE || process.env.BITGET_PASSPHRASE;
const OUT = '/opt/sentinel/state/naked-guard.json';
const STATUS = '/opt/sentinel/state/status.json';
const log = (...a) => console.log(`[guard ${new Date().toISOString().slice(11, 19)}]`, ...a);

const hdr = (method, path, qs, body) => {
  const ts = Date.now().toString();
  return {
    'ACCESS-KEY': KEY,
    'ACCESS-SIGN': crypto.createHmac('sha256', SEC).update(ts + method.toUpperCase() + path + (qs ? '?' + qs : '') + body).digest('base64'),
    'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': PAS, 'Content-Type': 'application/json', locale: 'en-US',
  };
};
async function call(method, path, { qs = '', body = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(HOST + path + (qs ? '?' + qs : ''), { method, headers: hdr(method, path, qs, bodyStr), body: bodyStr || undefined });
  const j = await res.json().catch(() => ({}));
  if (j.code && j.code !== '00000') { const e = new Error(j.code + ' ' + (j.msg || '')); e.code = j.code; throw e; }
  return j.data;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const roundTo = (v, p) => { const f = 10 ** p; return Math.round(v * f) / f; };

async function cycle() {
  const report = { ts: Date.now(), seats: [], closedNaked: [], armedNaked: [], errors: [] };
  const [pos, plans] = await Promise.all([
    call('GET', '/api/v2/mix/position/all-position', { qs: `productType=${PRODUCT}&marginCoin=USDT` }),
    call('GET', '/api/v2/mix/order/orders-plan-pending', { qs: `productType=${PRODUCT}&planType=profit_loss` }).catch(() => null),
  ]);
  const planList = plans?.entrustedList || plans || [];
  const hasSL = (sym) => planList.some(o => o.symbol === sym && /loss/i.test(o.planType || ''));
  const hasTP = (sym) => planList.some(o => o.symbol === sym && /profit/i.test(o.planType || ''));

  for (const p of pos || []) {
    const sym = p.symbol, side = p.holdSide, mark = +p.markPrice;
    const seat = { sym, side, mark, sl: hasSL(sym), tp: hasTP(sym) };
    if (seat.sl && seat.tp) { report.seats.push(seat); continue; }

    // naked on some axis — try to armor
    try {
      const contracts = await call('GET', '/api/v2/mix/market/contracts', { qs: `productType=${PRODUCT}&symbol=${sym}` }).catch(() => []);
      const pp = contracts?.[0]?.pricePlace ?? 4;
      if (!seat.sl) {
        const slPx = side === 'long' ? roundTo(mark * 0.985, pp) : roundTo(mark * 1.015, pp);
        await call('POST', '/api/v2/mix/order/place-tpsl-order', { body: { symbol: sym, marginCoin: 'USDT', productType: PRODUCT, planType: 'pos_loss', triggerPrice: String(slPx), holdSide: side, size: String(p.total) } });
        log(`${sym} emergency SL @ ${slPx} (${side})`);
        seat.sl = true;
      }
      if (!seat.tp) {
        const tpPx = side === 'long' ? roundTo(mark * 1.03, pp) : roundTo(mark * 0.97, pp);
        await call('POST', '/api/v2/mix/order/place-tpsl-order', { body: { symbol: sym, marginCoin: 'USDT', productType: PRODUCT, planType: 'pos_profit', triggerPrice: String(tpPx), holdSide: side, size: String(p.total) } }).catch(e => log(`${sym} TP attach failed: ${e.message}`));
        seat.tp = true;
      }
      report.armedNaked.push(sym);
    } catch (e) {
      // armor failed — FAIL CLOSED
      log(`${sym} armor FAILED (${e.message}) -> closing seat`);
      try {
        await call('POST', '/api/v2/mix/order/close-positions', { body: { symbol: sym, productType: PRODUCT, holdSide: side } });
        report.closedNaked.push(sym);
        log(`${sym} CLOSED (naked, unarmorable)`);
      } catch (ce) {
        report.errors.push(`${sym} close failed: ${ce.message}`);
        log(`${sym} CLOSE FAILED: ${ce.message}`);
      }
    }
    report.seats.push(seat);
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  return report;
}

function statusdWatchdog() {
  try {
    const age = Date.now() - fs.statSync(STATUS).mtimeMs;
    if (age > 120_000) {
      log(`status.json stale ${(age / 1000).toFixed(0)}s -> restarting statusd`);
      execSync('systemctl restart sentinel-statusd');
    }
  } catch { /* non-fatal */ }
}

(async () => {
  log('naked-guard online — fail-closed invariant active');
  for (;;) {
    try { const r = await cycle(); if (r.closedNaked.length || r.armedNaked.length) log('naked handled:', JSON.stringify({ armed: r.armedNaked, closed: r.closedNaked })); }
    catch (e) { log('cycle error:', e.message); }
    try { statusdWatchdog(); } catch {}
    await sleep(30_000);
  }
})();
