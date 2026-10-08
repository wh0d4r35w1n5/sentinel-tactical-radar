import fs from "node:fs";
const allFills = JSON.parse(fs.readFileSync("/opt/sentinel/state/real-fills.json", "utf8"));
const rows = Array.isArray(allFills) ? allFills : allFills.fills || allFills.rows || [];
const cur = {};
for (const f of [...rows].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
  const k = `${f.symbol}:${f.side}`;
  const qty = +f.size || 0;
  if (f.tradeSide === "open") {
    const c = (cur[k] ||= { qty: 0, web: 0, api: 0 });
    c.qty += qty;
    c[(f.src || "api") === "web" ? "web" : "api"] += qty;
  } else if (f.tradeSide === "close") {
    const c = cur[k];
    if (c) {
      f._manual = c.web > c.api;
      c.qty -= qty;
      if (c.qty <= (c.web + c.api) * 1e-3) delete cur[k];
    }
  }
}
const day = rows.filter((f) => Date.now() - (f.ts || 0) < 86400e3 && (!f.src || f.src === "api"));
let all = 0, manual = 0, bot = 0;
const bySym = {};
for (const f of day) {
  const net = (+f.profit || 0) - (+f.fee || 0);
  all += net;
  const s = f.symbol;
  const b = (bySym[s] ||= { bot: 0, manual: 0, nM: 0, nB: 0 });
  if (f._manual && f.tradeSide === "close") { manual += net; b.manual += net; b.nM++; }
  else { bot += net; b.bot += net; b.nB++; }
}
console.log("24h all:", all.toFixed(2), "| manual-attributed:", manual.toFixed(2), "| bot-only:", bot.toFixed(2));
for (const [s, b] of Object.entries(bySym).sort((a, b2) => a[1].bot - b2[1].bot))
  if (Math.abs(b.bot) > 0.01 || Math.abs(b.manual) > 0.01)
    console.log(`${s.padEnd(14)} bot=$${b.bot.toFixed(2)} (${b.nB}) manual=$${b.manual.toFixed(2)} (${b.nM})`);
