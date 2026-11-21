import './load-env.mjs';
import crypto from 'node:crypto';
// Operator order 2026-11-19: deploy remaining capital into high-ATR seats.
// isolated lev, market entry, immediate pos_loss stop via place-tpsl-order
// (place-plan-order rejects pos_loss with 400172 on this account).
const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES';
const key = process.env.BITGET_API_KEY, secret = process.env.BITGET_API_SECRET, pass = process.env.BITGET_PASSPHRASE;
if (!key || !secret || !pass) { console.log('NO CREDS'); process.exit(1); }
function hdr(method, path, qs, bodyStr) {
  const ts = String(Date.now());
  const pre = ts + method.toUpperCase() + path + (qs ? '?' + qs : '') + (bodyStr || '');
  const sign = crypto.createHmac('sha256', secret).update(pre).digest('base64');
  return { 'ACCESS-KEY': key, 'ACCESS-SIGN': sign, 'ACCESS-PASSPHRASE': pass, 'ACCESS-TIMESTAMP': ts, 'Content-Type': 'application/json', locale: 'en-US' };
}
async function call(method, path, { qs = '', body = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(HOST + path + (qs ? '?' + qs : ''), { method, headers: hdr(method, path, qs, bodyStr), body: bodyStr || undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && j.code !== '00000')) throw new Error(path + ' -> ' + (j.code || res.status) + ' ' + (j.msg || ''));
  return j.data;
}
const SEATS = JSON.parse(process.env.OPEN_SEATS || '[]'); // [{sym,size,lev,stopPct|stopPx}]
// contract pricePlace drives trigger-price precision — toFixed(8) over-sets
// sub-1dp contracts and Bitget 40808s the stop (VELVET/ZEC/HYPE all bit).
const contracts = await call('GET', '/api/v2/mix/market/contracts', { qs: `productType=${PRODUCT}` });
const pricePlace = {};
for (const c of (contracts?.data || contracts || [])) pricePlace[c.symbol] = +c.pricePlace;
for (const s of SEATS) {
  const { sym, size, lev = 20, stopPct = 2.0, stopPx: absStop } = s;
  try {
    // leverage first (isolated)
    await call('POST', '/api/v2/mix/account/set-leverage', { body: { symbol: sym, productType: PRODUCT, marginCoin: 'USDT', leverage: String(lev), marginMode: 'isolated' } }).catch(e => console.log(sym, 'lev warn:', e.message.slice(0, 80)));
    // RISK CAP ENFORCE (ENSO fix 2026-11-21): the cap was a log line and ENSO
    // slipped 21% risk through it. Now size is clamped pre-order so risk at the
    // intended stop cannot exceed SEAT_MAX_RISK_PCT% of equity.
    let effSize = size;
    try {
      const w = JSON.parse((await import("node:fs")).readFileSync("/opt/sentinel/api/wealth-live.json", "utf8"));
      const eq = +w?.futures?.equityUsd || 0;
      const tick = await call("GET", "/api/v2/mix/market/ticker", { qs: "symbol=" + sym + "&productType=" + PRODUCT });
      const mark = +tick?.lastPr || 0;
      if (eq > 0 && mark > 0) {
        const stopDist = (absStop != null ? mark - +absStop : mark * stopPct / 100);
        const RISK_PCT0 = +(process.env.SEAT_MAX_RISK_PCT || 4);
        if (stopDist > 0) {
          const maxSize = (eq * RISK_PCT0 / 100) / stopDist;
          if (+effSize > maxSize) { console.log(sym, "RISK CLAMP: size", effSize, "->", maxSize.toFixed(6), "cap", RISK_PCT0 + "% eq", eq.toFixed(2)); effSize = maxSize; }
        }
      }
    } catch (e) { console.log(sym, "risk-clamp warn:", e.message.slice(0, 90)); }
    const body = { symbol: sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', size: String(effSize), side: 'buy', tradeSide: 'open', orderType: 'market', clientOid: ('ops' + Date.now().toString(36)).slice(0, 38) };
    let seatTagOverride = null;
    // INSTRUMENT-ID GATE (SSPC lesson 2026-11-21): leveraged/inverse ETF
    // products are NOT chart-pattern trades — they decay, reset daily, and
    // move on the underlying thesis. Tag them sector-play and require sector
    // alignment (breadth >= 50%) instead of a Bulkowski read.
    let secInfo = null;
    try {
      const fsM = await import('node:fs');
      const { classify } = await import('./sector-lib.mjs');
      const sec = classify(sym);
      const sc = JSON.parse(fsM.readFileSync('/opt/sentinel/state/sector-scan.json', 'utf8'));
      if (Date.now() - (sc.ts || 0) < 5 * 60e3) {
        const sd = sc.sectors?.[sec];
        secInfo = { sec, breadth: sd?.breadth ?? null };
        console.log(sym, 'SECTOR', sec, 'breadth', secInfo.breadth != null ? (secInfo.breadth * 100).toFixed(0) + '%' : 'n/a');
        if (sec === 'INVERSE-ETF' || sec === 'LONG-ETF') {
          if (secInfo.breadth == null || secInfo.breadth < 0.5) {
            console.log(sym, 'INSTRUMENT-GATE REJECT: leveraged/ETF seat with', sec, 'breadth', secInfo.breadth, '< 50% — thesis not aligned, seat NOT opened');
            continue;
          }
          console.log(sym, 'INSTRUMENT-GATE PASS:', sec, 'breadth aligned — tagged sector-play, pattern gate bypassed');
          seatTagOverride = 'sector-play';
        }
      } else console.log(sym, 'sector-scan stale — instrument gate skipped');
    } catch (e) { console.log(sym, 'instrument-gate warn:', e.message.slice(0, 70)); }
    // DATA INTEGRATION (2026-11-21): wire the two live feeds into the entry
    // rail. tg-confluence.json = fresh VIP signals; sector-scan.json = 30s
    // market-wide breadth. Previously collected-but-orphaned.
    let confl = null;
    try {
      const fsM = await import('node:fs');
      const tg = JSON.parse(fsM.readFileSync('/opt/sentinel/state/tg-confluence.json', 'utf8'));
      const base = sym.replace(/USDT$/, '');
      const sig = (tg.signals || []).filter(s => s.asset === base && s.side === 'long' && Date.now() - s.ts < 12 * 36e5).at(-1);
      if (sig) { confl = sig; console.log(sym, 'VIP-CONFLUENCE:', sig.raw.slice(0, 90)); }
    } catch (e) { console.log(sym, 'confl warn:', e.message.slice(0, 70)); }
    // PATTERN GATE (Bulkowski edge, 2026-11-21): reject weak-structure entries
    // before the order fires — extended run-ups and no-pattern entries are the
    // ENSO-loss class. PATTERN_GATE=0 disables.
    if (+process.env.PATTERN_GATE !== 0 && seatTagOverride !== 'sector-play') {
      try {
        const { classifyPattern } = await import('./pattern-tag.mjs');
        const k = await call('GET', '/api/v2/mix/market/history-candles', { qs: 'symbol=' + sym + '&productType=' + PRODUCT + '&granularity=15m&limit=30' });
        const rows = (Array.isArray(k?.data) ? k.data : k || []).map(x => ({h:+x[2],l:+x[3],c:+x[4],v:+x[5]})).reverse(); const closes = rows.map(r => r.c);
        const pat = classifyPattern(closes); const smc = (await import('./pattern-tag.mjs')).smcContext(rows); console.log(sym, 'SMC score', smc.score, smc.notes.join(' | ')); if (smc.score <= -2) { console.log(sym, 'SMC-GATE REJECT — bearish structure'); continue; }
        if (pat.tag === 'b-run-up' || (pat.conf < 0.5 && !confl)) {
          console.log(sym, 'PATTERN-GATE REJECT:', pat.tag, 'conf', pat.conf, '—', pat.note, '— seat NOT opened');
          continue;
        }
        seatTagOverride = seatTagOverride || pat.tag; console.log(sym, 'pattern:', pat.tag, 'conf', pat.conf, '—', pat.note);
      } catch (e) { console.log(sym, 'pattern-gate warn:', e.message.slice(0, 80)); }
    }
    console.log(sym, 'OPEN', size, '@~lev' + lev);
    const r = await call('POST', '/api/v2/mix/order/place-order', { body });
    console.log(sym, 'ORDER', JSON.stringify(r).slice(0, 200));
    await new Promise(r2 => setTimeout(r2, 2000));
    const pos = await call('GET', '/api/v2/mix/position/single-position', { qs: `symbol=${sym}&productType=${PRODUCT}&marginCoin=USDT` });
    const p = Array.isArray(pos) ? pos[0] : pos;
    const entry = +p?.openPriceAvg || 0;
    console.log(sym, 'FILLED entry', entry, 'size', p?.total, 'mgn', p?.marginSize);
    if (entry > 0) {
      // open-tag attribution from the rail itself (2026-11-21): the reason is
      // written by the same code path that opened the seat — never separate.
      try {
        const fsM = await import('node:fs');
        const rp = '/opt/sentinel/state/trade-reasons.json';
        const rs = JSON.parse(fsM.readFileSync(rp, 'utf8'));
        if (!Array.isArray(rs[sym])) rs[sym] = rs[sym] ? [rs[sym]] : [];
        rs[sym].push({ tag: seatTagOverride || 'clone-mom', reason: 'open-seat rail deploy', at: Date.now() });
        fsM.writeFileSync(rp, JSON.stringify(rs));
        console.log(sym, 'open-tag pinned:', seatTagOverride || 'clone-mom');
      } catch (e) { console.log(sym, 'reason-write warn:', e.message.slice(0, 80)); }
      // immediate whole-position stop — absolute stopPx if given, else ~stopPct below entry
      const dec = pricePlace[sym] ?? 2;
      let stopPx = (absStop != null ? +absStop : entry * (1 - stopPct / 100)).toFixed(dec);
      // RISK RULES (external review 2026-11-21):
      //  a) min liq buffer: stop clears liq by max(1.5x 1m ATR, 0.5% entry)
      //  b) per-seat risk cap log: size*(entry-stop) vs RISK_PCT x equity
      const RISK_PCT = +(process.env.SEAT_MAX_RISK_PCT || 4);
      try {
        const k = await call('GET', '/api/v2/mix/market/history-candles', { qs: 'symbol=' + sym + '&productType=' + PRODUCT + '&granularity=1m&limit=60' });
        const rows = (k?.data || k || []).map(r => ({ h: +r[2], l: +r[3] }));
        const atr = rows.length ? rows.reduce((a, r) => a + (r.h - r.l), 0) / rows.length : 0;
        const p2 = await call('GET', '/api/v2/mix/position/single-position', { qs: 'symbol=' + sym + '&productType=' + PRODUCT + '&marginCoin=USDT' });
        const pp = Array.isArray(p2) ? p2[0] : p2;
        const liq = +pp?.liquidationPrice || 0;
        if (liq > 0) {
          const minBuf = Math.max(1.5 * atr, entry * 0.005);
          if (+stopPx < liq + minBuf) { console.log(sym, 'buffer clamp: stop', stopPx, '-> liq+max(1.5xATR,0.5%)', (liq + minBuf).toFixed(dec)); stopPx = (liq + minBuf).toFixed(dec); }
          if (+stopPx >= entry) console.log(sym, 'WARN: buffer stop >= entry — seat cannot fit compliant buffer');
          let equity = 0;
          try { const w = JSON.parse((await import('node:fs')).readFileSync('/opt/sentinel/api/wealth-live.json', 'utf8')); equity = +w?.futures?.equityUsd || 0; } catch {}
          const risk = (+p?.total || size) * (entry - +stopPx);
          if (equity > 0 && risk > equity * RISK_PCT / 100) console.log(sym, 'RISK OVER CAP:', risk.toFixed(3) + ' > ' + RISK_PCT + '% of ' + equity.toFixed(2));
        }
      } catch (e) { console.log(sym, 'risk-check warn:', e.message.slice(0, 90)); }
      try {
        await call('POST', '/api/v2/mix/order/place-tpsl-order', { body: { symbol: sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', planType: 'pos_loss', triggerPrice: stopPx, executePrice: '0', triggerType: 'mark_price', holdSide: 'long', clientOid: ('opsstop' + Date.now().toString(36)).slice(0, 38) } });
        console.log(sym, 'STOP placed @', stopPx);
        // widen-only floor in state/stop-override.json so the watcher's band
        // refit can never retreat this stop tighter in the window before
        // cmd-manual-hold lands (the UNITREE wick-kill, 2026-11-20).
        try {
          const { fileURLToPath } = await import('node:url');
          const path = await import('node:path');
          const fsM = await import('node:fs');
          const ovP = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'state', 'stop-override.json');
          const ov = fsM.existsSync(ovP) ? (JSON.parse(fsM.readFileSync(ovP, 'utf8')) || {}) : {};
          const pct = +(((entry - +stopPx) / entry) * 100).toFixed(3);
          if (pct > (+ov[sym]?.stopPct || 0)) { ov[sym] = { stopPct: pct, at: Date.now() }; fsM.writeFileSync(ovP, JSON.stringify(ov)); }
          console.log(sym, 'stop-override floor', pct + '%');
        } catch (e) { console.log(sym, 'override write fail:', e.message.slice(0, 80)); }
      } catch (e) { console.log(sym, 'STOP FAIL:', e.message.slice(0, 120)); }
    }
  } catch (e) { console.log(sym, 'ERR', e.message.slice(0, 160)); }
}
console.log('DONE');
