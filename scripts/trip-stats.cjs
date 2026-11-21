// trip-stats.cjs - per-position round-trip attribution from a copy of state/real-fills.json. Usage: node scripts/trip-stats.cjs <fills.json> [sinceISO]. Run LOCALLY on a copy; never on the VPS. (Claude, 2026-11-15)
const fs=require('fs');let j=JSON.parse(fs.readFileSync(process.argv[2]));const a=(Array.isArray(j)?j:Object.values(j).find(Array.isArray)).sort((x,y)=>+x.ts-+y.ts);
const since=Date.parse(process.argv[3]||'2026-11-14T00:00:00Z');
const st={},trips=[];
for(const x of a){const dir=x.side==='buy'?'long':'short',k=x.symbol+':'+dir;const s=st[k]=st[k]||{o:0,c:0,ontl:0,pnl:0,fee:0,t0:0,n:0,srcs:[]};
 if(x.tradeSide==='open'){if(s.o===0&&s.c===0)s.t0=+x.ts;s.o+= +x.size;s.ontl+= +x.notionalUsd;s.fee+= +x.fee;}
 else{ if(s.o===0)continue; s.c+= +x.size;s.pnl+= +x.profit;s.fee+= +x.fee;s.n++;s.srcs.push(x.src);
  if(s.c>=s.o*0.995){trips.push({k,t0:s.t0,t1:+x.ts,ntl:s.ontl,pnl:s.pnl,fee:s.fee,n:s.n,exit:s.srcs[s.srcs.length-1]});delete st[k];}}}
const T=trips.filter(t=>t.t0>=since);
const w=T.filter(t=>t.pnl-t.fee>0),l=T.filter(t=>t.pnl-t.fee<=0);
const S=(arr,f)=>arr.reduce((s,t)=>s+f(t),0);
console.log('trips since',process.argv[3]||'2026-11-14T00:00Z','n',T.length,'| open now:',Object.keys(st).join(',')||'none');
console.log('net wins',w.length,'net losses',l.length,'WR(net)',(100*w.length/Math.max(1,T.length)).toFixed(0)+'%');
console.log('gross',S(T,t=>t.pnl).toFixed(2),'fees',S(T,t=>t.fee).toFixed(2),'net',S(T,t=>t.pnl-t.fee).toFixed(2));
console.log('avg win net',(S(w,t=>t.pnl-t.fee)/Math.max(1,w.length)).toFixed(3),'avg loss net',(S(l,t=>t.pnl-t.fee)/Math.max(1,l.length)).toFixed(3),'payoff',(Math.abs(S(w,t=>t.pnl-t.fee)/Math.max(1,w.length))/Math.abs(S(l,t=>t.pnl-t.fee)/Math.max(1,l.length)||1)).toFixed(2));
const pc=t=>100*(t.pnl-t.fee)/t.ntl;console.log('net % of opened notional: avg win',(S(w,pc)/Math.max(1,w.length)).toFixed(2)+'%','avg loss',(S(l,pc)/Math.max(1,l.length)).toFixed(2)+'%','| avg hold min',(S(T,t=>(t.t1-t.t0)/6e4)/Math.max(1,T.length)).toFixed(0),'| avg notional',(S(T,t=>t.ntl)/Math.max(1,T.length)).toFixed(0));
const ex={};for(const t of T){const e=t.exit||'?';ex[e]=ex[e]||{n:0,p:0};ex[e].n++;ex[e].p+=t.pnl-t.fee}
console.log('by last-exit src:',Object.entries(ex).map(([k,v])=>`${k} n=${v.n} net=${v.p.toFixed(2)}`).join(' | '));
console.log('fees as % of gross |pnl|:',(100*S(T,t=>t.fee)/Math.max(1e-9,S(T,t=>Math.abs(t.pnl)))).toFixed(0)+'%','| trips with net%>-0.2 and <0.2 (fee-scale scratches):',T.filter(t=>Math.abs(pc(t))<0.2).length);
console.log('\nlast 26 round trips:');for(const t of T.slice(-26))console.log(new Date(t.t0).toISOString().slice(5,16),t.k.padEnd(17),'ntl',t.ntl.toFixed(0).padStart(4),'hold',((t.t1-t.t0)/6e4).toFixed(0).padStart(4)+'m','fills',t.n,'net',(t.pnl-t.fee).toFixed(3).padStart(7),'('+pc(t).toFixed(2)+'%)',t.exit);
// ---- split by direction / size / hold (appended)
const grp=(label,fn)=>{const m={};for(const t of T){const k=fn(t);m[k]=m[k]||[];m[k].push(t)}console.log('\nby '+label+':');for(const [k,v] of Object.entries(m).sort())console.log(' ',k.padEnd(14),'n',String(v.length).padStart(3),'net',S(v,t=>t.pnl-t.fee).toFixed(2).padStart(7),'WR',(100*v.filter(t=>t.pnl-t.fee>0).length/v.length).toFixed(0)+'%','avg%',(S(v,pc)/v.length).toFixed(2))};
grp('direction',t=>t.k.split(':')[1]);
grp('hold bucket',t=>{const m=(t.t1-t.t0)/6e4;return m<5?'a <5m':m<20?'b 5-20m':m<60?'c 20-60m':'d 60m+'});
grp('notional bucket',t=>t.ntl<30?'a <30':t.ntl<80?'b 30-80':'c 80+');
grp('UTC hour block',t=>{const h=new Date(t.t0).getUTCHours();return h<6?'a 00-06':h<12?'b 06-12':h<18?'c 12-18':'d 18-24'});
