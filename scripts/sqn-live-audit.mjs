import fs from 'fs';
const d=JSON.parse(fs.readFileSync('/opt/sentinel/state/mae-mfe.json','utf8'));
const eps=d.episodes;
const FEE=0.12; // round-trip taker % of notional
const ret=e=>((e.side==='short'?(e.entry-e.exit):(e.exit-e.entry))/e.entry*100)-FEE;
const sqn=rs=>{const n=rs.length;if(n<30)return null;const m=rs.reduce((a,b)=>a+b,0)/n;const sd=Math.sqrt(rs.reduce((a,b)=>a+(b-m)**2,0)/(n-1));return sd>0?{n,mean:m,sd,sqn:m/sd*Math.sqrt(Math.min(n,100)),sqn100:m/sd*10,wr:rs.filter(r=>r>0).length/n,sum:rs.reduce((a,b)=>a+b,0)}:null}; /* sqn-guard */
const fmt=o=>o?`n=${String(o.n).padStart(3)} mean=${o.mean.toFixed(3).padStart(7)}% sd=${o.sd.toFixed(2)} SQN100=${o.sqn100.toFixed(2).padStart(6)} WR=${(o.wr*100).toFixed(0)}% sum=${o.sum.toFixed(1)}%`:'n<2';
const group=(key)=>{const g={};for(const e of eps){const k=key(e);(g[k]=g[k]||[]).push(ret(e));}return Object.entries(g).map(([k,v])=>[k,sqn(v)]).filter(x=>x[1]).sort((a,b)=>b[1].sqn100-a[1].sqn100);};
const T0=Date.parse('2026-10-11T00:00Z'), T1=Date.parse('2026-10-15T11:26Z');
console.log('ALL        ',fmt(sqn(eps.map(ret))));
console.log('since 10-11',fmt(sqn(eps.filter(e=>e.ts>=T0).map(ret))));
console.log('since dead-seat retune 11:26 today',fmt(sqn(eps.filter(e=>e.ts>=T1).map(ret))));
console.log('\n== by strat (all) =='); for(const [k,v] of group(e=>e.strat||'?')) console.log(k.padEnd(22),fmt(v));
console.log('\n== by hold band =='); const band=m=>m<5?'<5m':m<30?'5-30m':m<120?'30-120m':'>120m'; for(const [k,v] of group(e=>band(e.durMin))) console.log(k.padEnd(10),fmt(v));
console.log('\n== by symbol (n>=4) =='); for(const [k,v] of group(e=>e.sym)) if(v.n>=4) console.log(k.padEnd(12),fmt(v));
console.log('\n== by side =='); for(const [k,v] of group(e=>e.side)) console.log(k.padEnd(6),fmt(v));
console.log('\n== by UTC hour-block =='); for(const [k,v] of group(e=>{const h=new Date(e.ts).getUTCHours();return `${Math.floor(h/4)*4}-${Math.floor(h/4)*4+4}h`})) console.log(k.padEnd(8),fmt(v));
console.log('\n== by day =='); for(const [k,v] of group(e=>new Date(e.ts).toISOString().slice(5,10)).sort((a,b)=>a[0]<b[0]?-1:1)) console.log(k.padEnd(6),fmt(v));
// MFE capture: how much of peak did we bank?
const cap=eps.filter(e=>e.mfePct>0.3).map(e=>Math.max(0,ret(e)+FEE)/e.mfePct);
console.log('\nMFE capture ratio (mfe>0.3%): median',cap.sort((a,b)=>a-b)[Math.floor(cap.length/2)]?.toFixed(2),'n',cap.length);
const died=eps.filter(e=>ret(e)<0&&e.mfePct>=0.18); console.log('losers that had been >= +0.18% (fee-lock armable):',died.length,'of',eps.filter(e=>ret(e)<0).length,'losers; their sum',died.reduce((a,e)=>a+ret(e),0).toFixed(2)+'%');
