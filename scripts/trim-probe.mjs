import { makeExchange } from "./exchange/index.mjs";
const X = makeExchange(process.env);
const cm = await X.contractMap();
const pos = await (X.getAllPos ? X.getAllPos() : X.getPos());
const arr = Array.isArray(pos) ? pos : [];
const p = arr.find((x) => (x.sym || x.symbol) === "BTCUSDT" && (x.side || x.holdSide) === "long");
console.log("fp:", JSON.stringify(p));
const plans = await X.getPlans("BTCUSDT");
const loss = plans.find((x) => /loss|stop|moving/i.test(x.planType || "") && (!x.holdSide || x.holdSide === "long"));
const trig = +loss?.triggerPrice || 0;
const t = await X.ticker("BTCUSDT");
const row = Array.isArray(t) ? t[0] : t;
const mark = +(row.markPrice || row.lastPr);
const sDist = trig > 0 ? (mark - trig) / trig * 100 : null;
const c = cm.BTCUSDT || {};
const precN = Number.isFinite(+c.sizePlace) ? +c.sizePlace : (+c.volumePlace || 0);
const prec = Math.pow(10, precN);
const minClip = Math.max(+c.minTradeNum || 0, Math.ceil(((+c.minTradeUSDT || 5) * 1.02) / mark * prec) / prec);
const fpSize = +(p?.size ?? p?.total ?? 0);
const q = Math.floor(minClip * 1 * prec) / prec;
const clipValue = sDist != null ? (q * mark * sDist) / 100 : 0;
console.log(JSON.stringify({
  mark, trig, sDist: sDist != null ? +sDist.toFixed(3) : null,
  cmBTC: { minTradeNum: c.minTradeNum, minTradeUSDT: c.minTradeUSDT, sizePlace: c.sizePlace, volumePlace: c.volumePlace },
  minClip, q, clipValue: +clipValue.toFixed(4), fpSize,
  pass: !!(p && fpSize > minClip && q > 0 && q < fpSize && clipValue >= 0.15),
}));
