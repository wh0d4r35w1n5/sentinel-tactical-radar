// commod-24h lane — Claude c=30 spec + operator order.
// CLUSDT/XAGUSDT/XAUUSDT/NATGASUSDT longs, max 4 seats (one per symbol).
// ENTRY (closed bars): 1h close > 1h EMA50 AND >=0.3% above it AND last
// daily close > daily EMA20. Maker post-only limit at the bid, taker
// fallback after 90s (rail's entryMode:'resting' + restingLapsed retry).
// EXIT: fixed 24h hold — NO rungs/clips/bank/stall exits. Disaster stop
// only: exchange pos_loss plan 3xATR14(1h) below entry, re-armed if missing.
// Registry state/commod-24h.json lets bitget-watch exempt these seats.
import '/opt/sentinel/scripts/load-env.mjs';
import fs from 'node:fs';
process.env.SENTINEL_EXEC = 'live';
process.env.SENTINEL_PROBE_CELLS = [process.env.SENTINEL_PROBE_CELLS, 'commod-24h:LONG'].filter(Boolean).join(',');
const { makeExchange } = await import('/opt/sentinel/scripts/exchange/index.mjs');
const { openRiskEntry } = await import('/opt/sentinel/scripts/risk-entry.mjs');

const X = makeExchange(process.env);
try { await Promise.resolve(X.setPosMode?.('hedge')); } catch {}
const SYMS = ['CLUSDT', 'XAGUSDT', 'XAUUSDT', 'NATGASUSDT'];
const ROOT = '/opt/sentinel';
const REG = `${ROOT}/state/commod-24h.json`;
const HOLD_MS = 24 * 3600e3;
const STOP_ATR_MULT = 3;
const RISK_USD = +(process.env.SENTINEL_COMMOD_RISK_USD || 1.5); // ~4-5% equity stop-risk/seat

const loadReg = () => { try { return JSON.parse(fs.readFileSync(REG, 'utf8')) || {}; } catch { return {}; } };
const saveReg = (r) => { try { fs.writeFileSync(REG, JSON.stringify(r)); } catch {} };
const J = async (u) => (await (await fetch(u)).json());
let lastFetchErr = '';
const candles = async (sym, gran, limit) => {
  for (let a = 0; a < 8; a++) {
    const url = `https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${sym}&granularity=${gran}&limit=${limit}`;
    const r = await fetch(url).then(async (res) => { if (!res.ok) { lastFetchErr = `HTTP ${res.status}`; return null; } return res.json(); }).catch((e) => { lastFetchErr = String(e.message || e).slice(0, 80); return null; });
    const rows = (r?.data || []).map(c => ({ ts: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
    if (rows.length >= Math.min(20, limit)) return rows;
    if (r && !rows.length) lastFetchErr = `empty msg=${String(r?.msg || '').slice(0, 60)}`;
    await new Promise(s => setTimeout(s, 1200 + a * 400));
  }
  return [];
};
const mark = async (sym) => {
  const r = await J(`https://api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=${sym}`).catch(() => null);
  const d = Array.isArray(r?.data) ? r.data[0] : r?.data;
  return { px: +d?.lastPr || 0, bid: +d?.bidPr || +d?.lastPr || 0 };
};
const ema = (xs, n) => { if (xs.length < n) return NaN; const k = 2 / (n + 1); let e = xs[0]; for (const x of xs) e = x * k + e * (1 - k); return e; };
const atr = (bars, n) => {
  const trs = [];
  for (let i = 1; i < bars.length; i++) trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  return trs.length >= n ? trs.slice(-n).reduce((a, b) => a + b, 0) / n : NaN;
};
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Disaster stop = 3xATR14(1h) below ref price. Returns 0 when it can't compute.
const disasterStop = async (sym, refPx) => {
  if (!(refPx > 0)) return 0;
  const h1 = (await candles(sym, '1H', 30)).slice(1);
  const a14 = atr(h1.slice(0, 30).reverse(), 14);
  if (!(a14 > 0)) return 0;
  return +(refPx - STOP_ATR_MULT * a14).toFixed(+cm[sym]?.pricePlace || 4);
};

let cm;
for (let i = 0; i < 4; i++) {
  try { cm = await X.contractMap(); break; } catch (e) { if (i === 3) throw e; await new Promise(r => setTimeout(r, 2500)); }
}

let cycle = 0;
for (;;) {
  cycle++;
  try {
    const reg = loadReg();
    const positions = (await X.getPos().catch(() => [])) || [];
    const held = {};
    for (const p of positions) if (+p.total > 0) held[p.symbol] = p;
    for (const sym of SYMS) {
      const row = reg[sym];
      const pos = held[sym];
      if (pos && row && +pos.cTime === +row.cTime) {
        // owned commod seat: 24h clock + disaster-stop re-arm — nothing else.
        const age = Date.now() - (+row.entryAt || +pos.cTime || 0);
        if (age >= HOLD_MS) {
          await X.closePosition(sym, 'long').catch(e => log(sym, 'close24h failed:', String(e.message).slice(0, 80)));
          delete reg[sym]; saveReg(reg);
          log(`${sym}: 24h elapsed — seat closed`);
          continue;
        }
        // heal seats adopted/registered with no stop — a 0 stopPx makes
        // planOrder reject forever and leaves the seat bare.
        if (!(+row.stopPx > 0)) {
          try {
            const ref = +pos.openPriceAvg || (await mark(sym)).px;
            const sp = await disasterStop(sym, ref);
            if (sp > 0 && sp < ref) { row.stopPx = sp; reg[sym] = row; saveReg(reg); log(`${sym}: disaster stop healed @ ${sp}`); }
          } catch (e) { log(sym, 'stop-heal failed:', String(e.message).slice(0, 80)); }
        }
        if (+row.stopPx > 0) try {
          // X.getPlans is the only working pending-plan query — the raw
          // orders-plan-pending call needs planType+marginCoin and 400s.
          const legs = await X.getPlans(sym).catch(() => []);
          const hasStop = legs.some(r => /loss/.test(String(r.planType)) && Math.abs(+r.triggerPrice - row.stopPx) / row.stopPx < 0.01);
          if (!hasStop) {
            await X.planOrder(sym, 'pos_loss', String(row.stopPx), null, 'long', 'isolated');
            log(`${sym}: disaster stop re-armed @ ${row.stopPx}`);
          }
        } catch (e) { log(sym, 'stop-verify failed:', String(e.message).slice(0, 80)); }
        continue;
      }
      if (row && !pos) { delete reg[sym]; saveReg(reg); continue; }
      if (pos && !row) {
        // foreign seat: adopt with a computed disaster stop — never stopPx:0.
        let sp = 0, ref = +pos.openPriceAvg || 0;
        try {
          if (!(ref > 0)) ref = (await mark(sym)).px;
          sp = await disasterStop(sym, ref);
        } catch {}
        reg[sym] = { cTime: +pos.cTime, entryAt: +pos.cTime || Date.now(), stopPx: sp, entry: ref, foreign: true };
        saveReg(reg);
        log(`${sym}: foreign seat adopted cTime=${pos.cTime} stop=${sp || 'PENDING'}`);
        continue;
      }

      // entry eval — closed bars only (slice(1) drops the forming bar)
      try {
        const h1 = (await candles(sym, '1H', 60)).slice(1);
        const d1 = (await candles(sym, '1D', 30)).slice(1);
        if (h1.length < 51 || d1.length < 21) { log(sym, `insufficient candles h1=${h1.length} d1=${d1.length} err=${lastFetchErr}`); continue; }
        const last1h = h1[0], e50 = ema(h1.map(b => b.c).reverse(), 50), e20d = ema(d1.map(b => b.c).reverse(), 20);
        const a14 = atr(h1.slice(0, 30).reverse(), 14);
        if (!(last1h.c > e50 * 1.003 && d1[0].c > e20d)) continue;
        if (!(a14 > 0)) continue;
        const { px: refPx, bid } = await mark(sym);
        if (!(refPx > 0)) continue;
        const stopPx = +(refPx - STOP_ATR_MULT * a14).toFixed(+cm[sym]?.pricePlace || 4);
        if (!(stopPx > 0 && stopPx < refPx)) continue;
        const stopFrac = (refPx - stopPx) / refPx;
        const capNotional = RISK_USD / stopFrac;
        const order = { symbol: sym, strategy: 'commod-24h', direction: 'LONG',
          refEntry: refPx, wyckInvalid: stopPx, riskCapNotionalUsd: capNotional,
          entryMode: 'resting', restPx: bid > 0 ? bid : refPx, restMs: 90000 };
        let f;
        try { f = await openRiskEntry(X, order, cm[sym], { riskScale: 1 }); }
        catch (e) {
          if (e?.restingLapsed || e?.restingRejected) {
            const { entryMode, restPx, restMs, ...taker } = order;
            f = await openRiskEntry(X, taker, cm[sym], { riskScale: 1 });
          } else throw e;
        }
        const posNow = (await X.getPos().catch(() => [])).find(p => p.symbol === sym && +p.total > 0);
        reg[sym] = { cTime: +(posNow?.cTime || Date.now()), entryAt: Date.now(), stopPx, atr: a14, entry: +posNow?.openPriceAvg || refPx };
        saveReg(reg);
        log(`FILLED ${sym} commod-24h size=${f.size} margin=$${f.marginUsd} stop=${stopPx} (3xATR=${(3 * a14).toFixed(4)}) risk$${(capNotional * stopFrac).toFixed(2)}`);
      } catch (e) { log(`REFUSED ${sym}: ${String(e.message).slice(0, 140)}`); }
      await new Promise(r => setTimeout(r, 900));
    }
  } catch (e) { log('cycle error:', String(e.message || e).slice(0, 160)); }
  await new Promise(r => setTimeout(r, 60000));
}
