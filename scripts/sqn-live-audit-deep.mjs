import fs from 'fs';
const eps=JSON.parse(fs.readFileSync('/opt/sentinel/state/mae-mfe.json','utf8')).episodes;
const FEE=0.12;
const ret=e=>((e.side==='short'?(e.entry-e.exit):(e.exit-e.entry))/e.entry*100)-FEE;
const sqn=rs=>{const n=rs.length;if(n<30)return null;const m=rs.reduce((a,b)=>a+b,0)/n;const sd=Math.sqrt(rs.reduce((a,b)=>a+(b-m)**2,0)/(n-1));return sd>0?{n,mean:m,sd,sqn100:m/sd*10,wr:rs.filter(r=>r>0).length/n,sum:rs.reduce((a,b)=>a+b,0)}:null}; /* sqn-guard */
const fmt=o=>o?`n=${String(o.n).padStart(3)} mean=${o.mean.toFixed(3).padStart(7)}% SQN100=${o.sqn100.toFixed(2).padStart(6)} WR=${(o.wr*100).toFixed(0)}% sum=${o.sum.toFixed(1)}%`:'n<2';
const hb=e=>{const h=new Date(e.ts).getUTCHours();return `${String(Math.floor(h/4)*4).padStart(2,'0')}-${Math.floor(h/4)*4+4}h`};
console.log('== losers that had mfe>=0.18 — their MFE distribution ==');
const L=eps.filter(e=>ret(e)<0&&e.mfePct>=0.18);
const bins={'0.18-0.30':0,'0.30-0.50':0,'0.50-1.0':0,'>1.0':0};const sums={...bins};
for(const e of L){const k=e.mfePct<0.3?'0.18-0.30':e.mfePct<0.5?'0.30-0.50':e.mfePct<1?'0.50-1.0':'>1.0';bins[k]++;sums[k]+=ret(e);}
for(const k in bins) console.log(k.padEnd(10),'n',bins[k],'loss sum',sums[k].toFixed(2)+'%');
console.log('\n== COUNTERFACTUAL: fee-lock arm +0.18 / lock +0.12 (assume -0.05% slippage) applied to all eps ==');
const cf=eps.map(e=>(e.mfePct>=0.18&&ret(e)<0)? -0.05 : ret(e));
console.log('actual     ',fmt(sqn(eps.map(ret))));
console.log('with lock  ',fmt(sqn(cf)));
console.log('\n== COUNTERFACTUAL: dead-seat cut -0.40% (losers with mae>=0.4 -> -0.52 incl fee) ==');
const cf2=eps.map(e=>{const r=ret(e);if(r<-0.52&&e.maePct>=0.4)return -0.52;return r;});
console.log('deadseat   ',fmt(sqn(cf2)));
const cf3=eps.map((e,i)=>cf[i]<0&&e.maePct>=0.4&&cf[i]<-0.52?-0.52:cf[i]);
console.log('lock+dead  ',fmt(sqn(cf3)));
console.log('\n== sentinel-structure by hour block ==');
const g={};for(const e of eps.filter(e=>e.strat==='sentinel-structure')){(g[hb(e)]=g[hb(e)]||[]).push(ret(e))}
for(const k of Object.keys(g).sort()) console.log(k,fmt(sqn(g[k]))||`n=${g[k].length} sum=${g[k].reduce((a,b)=>a+b,0).toFixed(2)}`);
console.log('\n== slot-deploy + unattributed by hour block ==');
const g2={};for(const e of eps.filter(e=>e.strat==='slot-deploy'||e.strat==='unattributed')){(g2[hb(e)]=g2[hb(e)]||[]).push(ret(e))}
for(const k of Object.keys(g2).sort()) console.log(k,fmt(sqn(g2[k])));
console.log('\n== ALL excluding 12-16h & 00-04h blocks ==');
console.log(fmt(sqn(eps.filter(e=>!['12-16h','00-4h'].includes(hb(e))).map(ret))));
console.log('\n== structure-only, lock+dead counterfactual ==');
const S=eps.filter(e=>e.strat==='sentinel-structure');
console.log('actual   ',fmt(sqn(S.map(ret))));
console.log('lock+dead',fmt(sqn(S.map(e=>{let r=ret(e);if(e.mfePct>=0.18&&r<0)r=-0.05;if(r<-0.52&&e.maePct>=0.4)r=-0.52;return r;}))));
console.log('\n== structure eps list (recent 12) ==');
for(const e of S.slice(-12)) console.log(new Date(e.ts).toISOString().slice(5,16),e.sym.padEnd(11),e.side,'ret',ret(e).toFixed(2),'mfe',e.mfePct,'mae',e.maePct,'dur',e.durMin);
console.log('\n== today since 11:26 (post-retune) ==');
for(const e of eps.filter(e=>e.ts>=Date.parse('2026-10-15T11:26Z'))) console.log(new Date(e.ts).toISOString().slice(11,16),e.sym.padEnd(11),(e.strat||'?').padEnd(18),'ret',ret(e).toFixed(2),'mfe',e.mfePct,'mae',e.maePct,'dur',e.durMin);
