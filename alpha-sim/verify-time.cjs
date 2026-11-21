// verify-time.cjs — out-of-time robustness: does the winner hold across
// mandate lengths AND unseen seed ranges? Run after optimize.cjs prints the top config.
const Sim = require('./sim.js');
const med = (xs) => { const s=[...xs].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
function evalCfg(slots, seeds, days, base) {
  const rets=[],dds=[],shs=[]; let ruin=0;
  for(let i=0;i<seeds;i++){const g=new Sim.Game({seed:base+i,maxDay:days,slots});while(!g.over)g.step();const r=g.result;if(r.status==='LIQUIDATED')ruin++;rets.push(r.totalRet);dds.push(r.maxDD);shs.push(r.sharpe);}
  return {ruin:ruin/seeds, medRet:med(rets), medDD:med(dds), medSharpe:med(shs)};
}
// paste the winner's slots here when optimize finishes
const WINNER = null;
if (WINNER) {
  for (const [days,base] of [[60,90000],[120,50000],[240,120000]]) {
    const e=evalCfg(WINNER,300,days,base);
    console.log(`${days}d :: sharpe ${e.medSharpe.toFixed(2)} ret ${(e.medRet*100).toFixed(1)}% dd ${(e.medDD*100).toFixed(1)}% ruin ${(e.ruin*100).toFixed(0)}%`);
  }
}
