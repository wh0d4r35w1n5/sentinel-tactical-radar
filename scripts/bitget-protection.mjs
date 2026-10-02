// bitget-protection.mjs — watches Bitget positions and arms stop + TP ladders
// for manual trades (the main executor is now Bybit-only; this is the sidecar).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const cm = {};
for (const c of catalog.symbols || []) cm[c.symbol] = c;

const seen = new Set(); // sym -> seen so we don't re-arm repeatedly

async function main() {
  console.log(`[${new Date().toISOString()}] Bitget protection daemon started (demo=${DEMO})`);
  while (true) {
    try {
      const positions = await X.getPosition();
      const armed = [];

      for (const p of positions) {
        const size = +p.size;
        if (!size || size < 0) continue;
        const sym = p.symbol;
        const side = p.side === 'long' ? 'long' : 'short';
        const entry = +p.entryPrice || +p.markPrice || 0;
        if (!entry) continue;

        const key = `${sym}:${side}`;
        if (seen.has(key)) continue; // already armed this session

        // Check if already has protection
        const plans = await X.getPlans(sym).catch(() => []);
        const hasStop = plans.some(x => /loss|stop/i.test(x.planType || ''));
        const hasProfit = plans.some(x => /profit/i.test(x.planType || ''));

        if (hasStop && hasProfit) {
          seen.add(key);
          continue;
        }

        // Default stop: 1.5% for most, 2% for high vol (use atrPct if available, else 1.5%)
        const stopPct = 1.5;
        const targetPct = stopPct * 2; // 2R default

        // Arm stop
        if (!hasStop) {
          const sgn = side === 'long' ? 1 : -1;
          const stopPx = entry * (1 - sgn * stopPct / 100);
          await X.planOrder(sym, 'pos_loss', stopPx, String(size), side, p.marginMode || 'cross');
          console.log(`[${new Date().toISOString()}] Armed stop on ${sym} ${side} @ ${stopPx.toFixed(6)}`);
        }

        // Arm TP ladder
        if (!hasProfit) {
          const sgn = side === 'long' ? 1 : -1;
          const sp = Math.pow(10, cm[sym]?.sizePlace ?? 4);
          const pp = cm[sym]?.pricePlace ?? 6;
          const legs = [];
          for (let i = 0; i < RR.mults.length; i++) {
            const tsize = (Math.floor(size * RR_CUM[i + 1] * sp) - Math.floor(size * RR_CUM[i] * sp)) / sp;
            if (tsize > 0 && tsize * entry >= MIN_TRANCHE_USD) {
              legs.push({
                tsize,
                px: parseFloat((entry * (1 + (sgn * targetPct * RR.mults[i]) / 100)).toFixed(pp)),
              });
            }
          }
          if (legs.length >= 2) {
            for (const l of legs) {
              await X.planOrder(sym, 'profit_plan', l.px, String(l.tsize), side, p.marginMode || 'cross');
            }
            console.log(`[${new Date().toISOString()}] Armed ${legs.length}-rung TP ladder on ${sym} ${side}`);
          } else {
            // Fallback: single TP at 2R
            const tpPx = entry * (1 + sgn * targetPct / 100);
            await X.planOrder(sym, 'pos_profit', tpPx, '0', side, p.marginMode || 'cross');
            console.log(`[${new Date().toISOString()}] Armed single TP on ${sym} ${side} @ ${tpPx.toFixed(6)}`);
          }
        }

        seen.add(key);
        armed.push(sym);
      }

      const state = { at: Date.now(), demo: DEMO, armed, seen: [...seen] };
      fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

    } catch (e) {
      console.error(`[${new Date().toISOString()}] Error:`, e.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(console.error);
