// war-engine.mjs — BONUS ADDON. War-basket watcher that opens ONE small
// "war-bid" bonus seat on spare margin when the war tape actually bids.
// Bounds (operator order: addon, not takeover):
//   - never touches existing seats/stops/ladders
//   - never uses margin reserved for the main book (buffer enforced)
//   - max 1 concurrent war seat, per-symbol cooldown
//   - same manual-seat contract: isolated lev, pos_loss above liq, ladder,
//     reason record + manual-hold registration
// Writes /opt/sentinel/state/war-engine.json + /opt/sentinel/api/war-engine.json.
import './load-env.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_STATE = `${ROOT}/state/war-engine.json`;
const OUT_API = `${ROOT}/api/war-engine.json`;
const REASONS_P = `${ROOT}/state/trade-reasons.json`;
const HOLD_P = `${ROOT}/state/cmd-manual-hold.json`;
const OVR_P = `${ROOT}/state/stop-override.json`;
const WEALTH_P = `${ROOT}/api/wealth-live.json`;

const HOST = 'https://api.bitget.com', PRODUCT = 'USDT-FUTURES';
const key = process.env.BITGET_API_KEY, secret = process.env.BITGET_API_SECRET, pass = process.env.BITGET_PASSPHRASE;

// knobs — all env-tunable
const LOOP_MS        = +(process.env.WAR_LOOP_MS || 60000);
const SEAT_USD       = +(process.env.WAR_SEAT_USD || 1.2);   // margin per bonus seat
const RESERVE_USD    = +(process.env.WAR_RESERVE_USD || 0.5);// floor left after seat
const LEV            = +(process.env.WAR_LEV || 13);
const STOP_PCT       = +(process.env.WAR_STOP_PCT || 5);
const COOLDOWN_MS    = +(process.env.WAR_COOLDOWN_MS || 30 * 60e3);
const MIN_VOL_M      = +(process.env.WAR_MIN_VOL_M || 0.5);  // $0.5M 24h volume floor
const MIN_DAY_PCT    = +(process.env.WAR_MIN_DAY_PCT || 1.5);// must be green on day
const MAX_SEATS      = +(process.env.WAR_MAX_SEATS || 1);
const TAG            = 'war-bid';

// The basket: weapons primes, defense tech, war-adjacent energy/metals.
const WAR = ('LMT NOC RTX GD BA LHX HII TXT LDO ITA DFEN PLTR RHM SAAB KOG AVAV KTOS ' +
  'LDOS ESLT CW TDG HEI WWD HON MRCY AXON ATRO HXL SPR TGI RKLB ASTS RDW ' +
  'XOM CVX OXY SLB COP EOG XLE USO OIH NATGAS LNG VLO PSX MPC FRO STNG ZIM ' +
  'URA URNM CCJ UUUU DNN LEU UEC NXE OKLO SMR ' +
  'GDX GDXJ NEM GOLD KGC AEM XAU XAG PAXG XAUT').split(' ');

function hdr(method, p, qs, bodyStr) {
  const ts = String(Date.now());
  const pre = ts + method.toUpperCase() + p + (qs ? '?' + qs : '') + (bodyStr || '');
  const sign = crypto.createHmac('sha256', secret).update(pre).digest('base64');
  return { 'ACCESS-KEY': key, 'ACCESS-SIGN': sign, 'ACCESS-PASSPHRASE': pass, 'ACCESS-TIMESTAMP': ts, 'Content-Type': 'application/json', locale: 'en-US' };
}
async function call(method, p, { qs = '', body = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const res = await fetch(HOST + p + (qs ? '?' + qs : ''), { method, headers: hdr(method, p, qs, bodyStr), body: bodyStr || undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && j.code !== '00000')) throw new Error(p + ' -> ' + (j.code || res.status) + ' ' + (j.msg || ''));
  return j.data;
}
const candles = async (sym, gran, limit) =>
  fetch(`${HOST}/api/v2/mix/market/history-candles?symbol=${sym}&productType=${PRODUCT}&granularity=${gran}&limit=${limit}`,
    { signal: AbortSignal.timeout(8000) }).then(r => r.json()).then(j => (j.data || []).map(r => +r[4]).reverse());
const readJ = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJ = (p, o) => { fs.writeFileSync(p + '.tmp', JSON.stringify(o)); fs.renameSync(p + '.tmp', p); };

const st = readJ(OUT_STATE) || { seats: {}, cooldowns: {}, opened: 0, lastScan: null };

async function scan() {
  const r = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const rows = (j?.data || []).filter(t => t.symbol?.endsWith('USDT'));
  const bySym = {}; for (const t of rows) bySym[t.symbol] = t;
  const war = [];
  for (const n of WAR) {
    const t = bySym[n + 'USDT'];
    if (!t) continue;
    war.push({ sym: t.symbol, base: n, chg: +(t.change24h * 100).toFixed(2), vol: +((+t.usdtVolume || +t.quoteVolume || 0) / 1e6).toFixed(2), last: +t.lastPr });
  }
  const up = war.filter(w => w.chg > 0.5).length;
  return { war, breadth: war.length ? +(up / war.length).toFixed(2) : 0, bySym };
}

async function qualify(c) {
  // needs: green day, vol floor, above 1h EMA20, and 15m not falling.
  if (c.chg < MIN_DAY_PCT || c.vol < MIN_VOL_M) return null;
  const emaSrc = await candles(c.sym, '1h', 25);
  if (emaSrc.length < 21) return null;
  const k = 2 / 21; let ema = emaSrc[0];
  for (const v of emaSrc) ema = v * k + ema * (1 - k);
  const above = +( ((c.last / ema - 1) * 100).toFixed(2) );
  const m15 = await candles(c.sym, '15m', 6);
  const t15 = m15.length > 2 ? +(((m15.at(-1) / m15[0] - 1) * 100).toFixed(2)) : 0;
  if (above < 0.2 || t15 < -0.5) return null;
  return { aboveEma: above, t15 };
}

async function deploy(c, q) {
  // contract spec for size rounding + trigger precision
  const ctr = await call('GET', '/api/v2/mix/market/contracts', { qs: `productType=${PRODUCT}` });
  const spec = (ctr?.data || ctr || []).find(x => x.symbol === c.sym);
  if (!spec) return { ok: false, err: 'no contract' };
  const sizeMin = +spec.sizeMin || 1, sizePlace = +spec.sizePlace ?? 0, pricePlace = +spec.pricePlace ?? 2;
  const notional = SEAT_USD * LEV;
  let size = Math.max(sizeMin, +(notional / c.last).toFixed(sizePlace));
  size = +size.toFixed(sizePlace);
  if (size * c.last < (+spec.minTradeNum || 5)) {
    size = +(((+spec.minTradeNum || 5) / c.last) * 1.02).toFixed(sizePlace);
    if (size < sizeMin) size = sizeMin;
  }
  // register BEFORE opening (wind-down guard) + reason record
  const hold = readJ(HOLD_P) || { symbols: [] };
  if (!hold.symbols.includes(c.sym)) { hold.symbols.push(c.sym); writeJ(HOLD_P, hold); }
  const rs = readJ(REASONS_P) || {};
  (rs[c.sym] ||= []).push({
    tag: TAG,
    reason: `war-basket qualifier day${c.chg}% vol$${c.vol}M +${q.aboveEma}%>1hEMA 15m${q.t15}%`,
    pub: `war-engine bonus seat (breadth ${st.lastScan?.breadth})`,
    at: Date.now(),
  });
  writeJ(REASONS_P, rs);

  await call('POST', '/api/v2/mix/account/set-leverage', { body: { symbol: c.sym, productType: PRODUCT, marginCoin: 'USDT', leverage: String(LEV), marginMode: 'isolated' } }).catch(e => console.log(c.sym, 'lev warn:', e.message.slice(0, 80)));
  const r = await call('POST', '/api/v2/mix/order/place-order', { body: { symbol: c.sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', size: String(size), side: 'buy', tradeSide: 'open', orderType: 'market', clientOid: ('war' + Date.now().toString(36)).slice(0, 38) } });
  await new Promise(r2 => setTimeout(r2, 2000));
  const pos = await call('GET', '/api/v2/mix/position/single-position', { qs: `symbol=${c.sym}&productType=${PRODUCT}&marginCoin=USDT` });
  const p = Array.isArray(pos) ? pos[0] : pos;
  const entry = +p?.openPriceAvg || 0, liq = +p?.liquidationPrice || 0, held = +p?.total || size;
  if (!entry) return { ok: false, err: 'no fill seen', orderId: r?.orderId };
  // stop above liq: structural -STOP_PCT, but never under liq*1.02
  let stop = entry * (1 - STOP_PCT / 100);
  if (liq && stop <= liq * 1.02) stop = liq * 1.02;
  stop = +stop.toFixed(pricePlace);
  await call('POST', '/api/v2/mix/order/place-tpsl-order', { body: { symbol: c.sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', planType: 'pos_loss', triggerPrice: String(stop), executePrice: '0', triggerType: 'mark_price', holdSide: 'long', clientOid: ('warstop' + Date.now().toString(36)).slice(0, 38) } });
  const ov = readJ(OVR_P) || {};
  const pct = +(((entry - stop) / entry) * 100).toFixed(3);
  if (pct > (+ov[c.sym]?.stopPct || 0)) { ov[c.sym] = { stopPct: pct, at: Date.now() }; writeJ(OVR_P, ov); }
  // staggered ladder — granularity-aware; single profit if only 1-2 contracts
  const rungs = [];
  if (held >= 3) {
    const px = [1.035, 1.07, 1.12];
    const per = Math.floor(held / (px.length + 1));
    const run = held - per * px.length;
    px.forEach(m => rungs.push({ px: +(entry * m).toFixed(pricePlace), sz: per }));
    if (run > 0) rungs.push({ px: +(entry * 1.18).toFixed(pricePlace), sz: run, runner: true });
  } else {
    rungs.push({ px: +(entry * 1.05).toFixed(pricePlace), sz: held });
  }
  for (const g of rungs) {
    try {
      await call('POST', '/api/v2/mix/order/place-tpsl-order', { body: { symbol: c.sym, productType: PRODUCT, marginMode: 'isolated', marginCoin: 'USDT', planType: 'pos_profit', triggerPrice: String(g.px), executePrice: '0', triggerType: 'mark_price', holdSide: 'long', size: String(g.sz), clientOid: ('wartp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 38) } });
    } catch (e) { console.log(c.sym, 'rung fail', g.px, e.message.slice(0, 80)); }
  }
  return { ok: true, sym: c.sym, size: held, entry, liq, stop, rungs };
}

async function tick() {
  const w = readJ(WEALTH_P)?.futures;
  const avail = w ? +w.availableUsd : 0;
  const liveSyms = new Set((w?.positions || []).map(p => p.k.split(':')[0]));
  const scan0 = await scan();
  const liveWarSeats = Object.keys(st.seats).filter(s => liveSyms.has(s));
  for (const s of Object.keys(st.seats)) if (!liveSyms.has(s)) { st.cooldowns[s] = Date.now() + COOLDOWN_MS; delete st.seats[s]; }
  const cands = [];
  for (const c of scan0.war.sort((a, b) => b.chg - a.chg)) {
    if (liveSyms.has(c.sym) || (st.cooldowns[c.sym] || 0) > Date.now()) continue;
    const q = await qualify(c);
    if (q) cands.push({ ...c, ...q });
    if (cands.length >= 3) break;
  }
  // tag self-cut (same rule as operator-clone): once war-bid has 20+ closed
  // episodes it must carry positive expectancy or it stops taking bullets.
  let tagCut = false;
  try {
    const t = readJ(`${ROOT}/state/status.json`)?.tags?.[TAG];
    if (t && t.ep >= 20 && t.exp < 0) tagCut = true;
  } catch {}
  if (tagCut) console.log(`TAG-CUT ${TAG}: expectancy negative at 20+ episodes — addon halted, not forced`);
  let deployed = null;
  if (cands.length && !tagCut && liveWarSeats.length < MAX_SEATS && avail >= SEAT_USD + RESERVE_USD) {
    try { deployed = await deploy(cands[0], cands[0]); if (deployed?.ok) { st.seats[cands[0].sym] = deployed; st.opened++; } }
    catch (e) { deployed = { ok: false, err: e.message.slice(0, 140) }; }
  }
  st.lastScan = { ts: Date.now(), breadth: scan0.breadth, warN: scan0.war.length, up: scan0.war.filter(x => x.chg > 0.5).length,
    avail: +avail.toFixed(2), liveWarSeats, cands: cands.slice(0, 3), deployed,
    bounds: { SEAT_USD, RESERVE_USD, LEV, STOP_PCT, MAX_SEATS, MIN_VOL_M, MIN_DAY_PCT } };
  writeJ(OUT_STATE, st); writeJ(OUT_API, st.lastScan);
  const top = scan0.war.slice().sort((a, b) => b.chg - a.chg).slice(0, 3).map(x => `${x.base}${x.chg > 0 ? '+' : ''}${x.chg}%`).join(' ');
  console.log(`[${new Date().toISOString()}] war breadth ${(scan0.breadth * 100) | 0}% seats:${liveWarSeats.length} avail:$${avail.toFixed(2)} | ${top}${deployed?.ok ? ' DEPLOYED ' + deployed.sym + '@' + deployed.entry : ''}`);
}

(async () => {
  if (!key || !secret || !pass) { console.log('NO CREDS — scan-only mode still needs creds for deploys'); }
  for (;;) { try { await tick(); } catch (e) { console.log('tick fail:', String(e.message || e).slice(0, 140)); } await new Promise(r => setTimeout(r, LOOP_MS)); }
})();
