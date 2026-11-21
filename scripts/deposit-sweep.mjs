// deposit-sweep: moves any free USDT sitting in SPOT into the USDT-FUTURES
// account so the exec can deploy it. Runs on a timer; idempotent.
import "/opt/sentinel/scripts/load-env.mjs";
import { makeExchange } from "/opt/sentinel/scripts/exchange/index.mjs";
import fs from "node:fs";
const LOG = "/opt/sentinel/state/deposit-sweep.log";
const log = (m) => { const line = `${new Date().toISOString()} ${m}\n`; fs.appendFileSync(LOG, line); console.log(line.trim()); };
const X = await makeExchange(process.env);
const assets = await X.api("GET", "/api/v2/spot/account/assets", {});
const rows = Array.isArray(assets) ? assets : (assets?.assets || []);
const usdt = rows.find((a) => (a.coin || "").toUpperCase() === "USDT");
// vault-carry exemption (operator 2026-11-19): wealth-vault.json's
// transferred-but-undeployed USDT is SEGREGATED carry earmarked for the
// BTC stack — not a stray deposit. Sweeping it fought the vault
// (00:44 log: repatriated $5.00 of carry). Keep it on spot.
const { readFileSync: _rf } = await import('node:fs');
let vaultHeld = 0;
try {
  const v = JSON.parse(_rf("/opt/sentinel/state/wealth-vault.json", "utf8"));
  vaultHeld = Math.max(0, (+v.transferredUsd || 0) - (+v.deployedUsd || 0));
} catch {}
const avail = Math.max(0, +(usdt?.available || usdt?.availableBalance || 0) - vaultHeld);
if (avail >= 1) {
  // Bitget rejects single spot->futures transfers above ~100 USDT (43117).
  // Chunk down until a transfer is accepted, then loop until spot is dust.
  let remaining = avail, moved = 0;
  while (remaining >= 1) {
    let ok = false;
    for (const chunk of [100, 50, 25, 10, 5, 1]) {
      if (chunk > remaining + 0.001) continue;
      try {
        await X.api("POST", "/api/v2/spot/wallet/transfer", {
          body: { fromType: "spot", toType: "usdt_futures", amount: String(+chunk.toFixed(2)), coin: "USDT", clientOid: `sweep-${Date.now()}-${chunk}` },
        });
        moved += chunk; remaining -= chunk; ok = true;
        break;
      } catch (e) {
        if (!/43117|max transferable/i.test(e.message)) throw e;
      }
    }
    if (!ok) break;
    await new Promise((r) => setTimeout(r, 500));
    const a2 = await X.api("GET", "/api/v2/spot/account/assets", {});
    const r2 = Array.isArray(a2) ? a2 : (a2?.assets || []);
    const u2 = r2.find((a) => (a.coin || "").toUpperCase() === "USDT");
    remaining = +(u2?.available || u2?.availableBalance || 0);
  }
  log(`swept ${moved.toFixed(2)} USDT spot->futures (chunked)`);
} else {
  log(`spot USDT ${avail} - nothing to sweep`);
}
