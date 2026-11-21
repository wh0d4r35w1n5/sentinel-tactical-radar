import { makeExchange } from "./exchange/index.mjs";
const X = makeExchange(process.env);
const sym = "BTCUSDT";
const pos = await (X.getAllPos ? X.getAllPos() : X.getPos());
const p = (Array.isArray(pos) ? pos : []).find((x) => (x.sym || x.symbol) === sym && (x.side || x.holdSide) === "long");
const marginMode = p?.marginMode || "isolated";
const t = await X.ticker(sym); const row = Array.isArray(t) ? t[0] : t;
const mark = +(row.markPrice || row.lastPr);
const trig = +(mark * (1 - 0.0082)).toFixed(1); // ~0.82% under mark: inside 1.2% zone, 3x clip clears dust floor
await X.planOrder(sym, "pos_loss", trig, "0", "long", marginMode);
console.log("placed test pos_loss @", trig, "mark", mark, "margin", marginMode);
const plans = await X.getPlans(sym);
const old = plans.filter((x) => /loss/i.test(x.planType || "") && +x.triggerPrice !== trig);
if (old.length) {
  await X.cancelPlanOrders(sym, "pos_loss", old.map((x) => x.orderId));
  console.log("cancelled old pos_loss @", old.map((x) => x.triggerPrice).join(","));
}
const after = await X.getPlans(sym);
console.log("plans now:", after.map((x) => `${x.planType}@${x.triggerPrice}`).join(" | "));
