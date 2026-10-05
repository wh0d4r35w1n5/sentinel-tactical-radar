// bitget-protection.mjs — watches Bitget positions and arms stop + TP ladders
// for manual trades (the main executor is now Bybit-only; this is the sidecar).
//
// Adapter contract (scripts/exchange/index.mjs + bitget-exec.mjs call sites):
//   X.getPos()        -> rows {symbol, holdSide, total, openPriceAvg, marginMode, ...}
//                        (the same fields the executor consumes)
//   X.planOrder(sym, planType, triggerPrice, size, holdSide, marginMode)
//     pos_loss / pos_profit are WHOLE-position plans — size must be '0' so the
//     adapter omits it (liq-guard: "pos_loss covers the whole position");
//     profit_plan legs carry their own tranche size.
//     Triggers are rounded to the contract's pricePlace; marginMode is the
//     row's REAL mode (anything but 'crossed' is coerced to 'isolated' by the
//     adapter — never invent a mode).
//
// Pure helpers are exported so scripts/bitget-protection.test.mjs can pin the
// planOrder argument shapes without touching the network; the daemon loop only
// runs when this file is executed directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeExchange } from './exchange/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// Force Bitget (ignore SENTINEL_EXCHANGE)
process.env.SENTINEL_EXCHANGE = 'bitget';
const DEMO = process.env.SENTINEL_EXEC === 'demo';

const X = makeExchange(process.env);
const POLL_MS = 15e3; // 15s
const STATE = path.join(__dirname, '..', 'state', 'bitget-protection.json');
const catalogPath = path.join(__dirname, '..', 'api', 'exec-catalog.json');

// TP ladder allocation (same as executor)
const RR_CUM = [0, 0.40, 0.70, 0.85]; // 40%, 30%, 15% tiered; 15% moon bag
const RR = { mults: [0.55, 1.0, 1.8] };
const MIN_TRANCHE_USD = 5;
const STOP_PCT = 1.5;
const TARGET_PCT = STOP_PCT * 2; // 2R default

// exec-catalog.json carries `symbols` as a plain string array (bitget-exec
// writes Object.keys(contractMap)) — the old `cm[c.symbol]` read silently
// keyed everything `undefined`. Accept strings AND {symbol} rows for safety.
export const loadCatalog = (symbols) => {
  const cm = {};
  for (const s of symbols || []) {
    const k = typeof s === 'string' ? s : s?.symbol;
    if (k) cm[k] = typeof s === 'string' ? {} : s;
  }
  return cm;
};

// Normalize a raw position row to what this sidecar needs; null = skip.
// Field aliases cover the raw Bitget v2 row shape and legacy names.
export const normalizePosRow = (p) => {
  if (!p?.symbol) return null;
  const size = +(p.total ?? p.size);
  const entry = +(p.openPriceAvg ?? p.entryPrice ?? p.markPrice);
  const side = String(p.holdSide ?? p.side ?? '').toLowerCase();
  if (!(size > 0) || !(entry > 0)) return null;
  if (side !== 'long' && side !== 'short') return null;
  const mm = String(p.marginMode || '').toLowerCase();
  return { symbol: p.symbol, side, size, entry, marginMode: mm.startsWith('cross') ? 'crossed' : 'isolated' };
};

// Plans filtered to the protected side — a short's stop must never count as
// the long's protection (same rule god.mjs audits with).
export const sidePlans = (plans, side) =>
  (plans || []).filter((x) => !x.holdSide || String(x.holdSide).toLowerCase() === side);

// Build the planOrder argument tuples for one position: exactly one
// exchange-side stop (1.5%) plus a 3-rung TP ladder at 2R — or one whole-
// position 2R TP when the ladder can't clear the dust floor.
export const buildArms = ({ pos, plans, cm = {} }) => {
  const { symbol, side, size, entry, marginMode } = pos;
  const sp = sidePlans(plans, side);
  const hasStop = sp.some((x) => /loss|stop|moving/i.test(x.planType || ''));
  const hasProfit = sp.some((x) => /profit/i.test(x.planType || ''));
  const arms = [];
  const sgn = side === 'long' ? 1 : -1;
  const pp = cm[symbol]?.pricePlace ?? 6;
  const szp = Math.pow(10, cm[symbol]?.sizePlace ?? 4);
  const rnd = (x) => +(+x).toFixed(pp);

  if (!hasStop)
    arms.push({ planType: 'pos_loss', triggerPrice: rnd(entry * (1 - (sgn * STOP_PCT) / 100)), size: '0', holdSide: side, marginMode });

  if (!hasProfit) {
    const legs = [];
    for (let i = 0; i < RR.mults.length; i++) {
      const tsize = (Math.floor(size * RR_CUM[i + 1] * szp) - Math.floor(size * RR_CUM[i] * szp)) / szp;
      if (tsize > 0 && tsize * entry >= MIN_TRANCHE_USD)
        legs.push({ size: tsize, triggerPrice: rnd(entry * (1 + (sgn * TARGET_PCT * RR.mults[i]) / 100)) });
    }
    if (legs.length >= 2)
      for (const l of legs)
        arms.push({ planType: 'profit_plan', triggerPrice: l.triggerPrice, size: String(l.size), holdSide: side, marginMode });
    else
      arms.push({ planType: 'pos_profit', triggerPrice: rnd(entry * (1 + (sgn * TARGET_PCT) / 100)), size: '0', holdSide: side, marginMode });
  }
  return arms;
};

const seen = new Set(); // sym:side -> armed this session

const loadCatalogFile = () => {
  try { return loadCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8')).symbols); }
  catch { return {}; }
};

async function main() {
  console.log(`[${new Date().toISOString()}] Bitget protection daemon started (demo=${DEMO})`);
  let cm = loadCatalogFile();
  while (true) {
    try {
      const rows = (await X.getPos()) || [];
      const armed = [];

      for (const raw of rows) {
        const pos = normalizePosRow(raw);
        if (!pos) continue;
        const key = `${pos.symbol}:${pos.side}`;
        if (seen.has(key)) continue; // already armed this session

        // re-read the catalog lazily — it only exists after an exec run
        if (!Object.keys(cm).length) cm = loadCatalogFile();
        const plans = await X.getPlans(pos.symbol).catch(() => []);
        const arms = buildArms({ pos, plans, cm });
        if (!arms.length) { seen.add(key); continue; }

        for (const a of arms) {
          await X.planOrder(pos.symbol, a.planType, a.triggerPrice, a.size, a.holdSide, a.marginMode);
          console.log(`[${new Date().toISOString()}] Armed ${a.planType} ${pos.symbol} ${a.holdSide} @ ${a.triggerPrice}`);
        }
        seen.add(key);
        armed.push(pos.symbol);
      }

      fs.writeFileSync(STATE, JSON.stringify({ at: Date.now(), demo: DEMO, armed, seen: [...seen] }, null, 2));
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Error:`, e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// direct-execution guard — importing (the test) must not spawn the loop
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch(console.error);
