import json,time,collections,sys
F=json.load(open('real-fills.json'))['fills']
F=[f for f in F if f.get('src')!='demo']
F.sort(key=lambda f:f['ts'])
now=1794450500000
WIN=48*3600*1000
F=[f for f in F if f['ts']>=now-WIN]
# position side: open buy->long, open sell->short, close sell->long, close buy->short
def pside(f):
    return 'long' if f['side']=='buy' else 'short'
seats=[]; cur={}
for f in F:
    k=f['symbol']+':'+pside(f)
    s=cur.get(k)
    if f['tradeSide']=='open':
        if s is None:
            s={'k':k,'open':f['ts'],'size':0,'cost':0,'fees':0,'profit':0,'closes':[],'opens':[]}; cur[k]=s
        s['size']+=f['size']; s['cost']+=f['size']*f['price']; s['fees']+=f['fee']; s['opens'].append(f)
    else:
        if s is None: continue  # close of seat opened before window
        s['size']-=f['size']; s['fees']+=f['fee']; s['profit']+=f['profit']
        entry=s['cost']/max(1e-12,sum(o['size'] for o in s['opens']))
        pct=(f['price']/entry-1)*100*(1 if k.endswith('long') else -1)
        s['closes'].append({'ts':f['ts'],'px':f['price'],'size':f['size'],'pct':round(pct,3),'profit':f['profit'],'fee':f['fee']})
        if s['size']<=1e-9:
            s['closeTs']=f['ts']; s['entry']=entry; s['net']=s['profit']-s['fees']; seats.append(s); del cur[k]
for k,s in cur.items():
    s['entry']=s['cost']/max(1e-12,sum(o['size'] for o in s['opens'])); s['net']=s['profit']-s['fees']
def fmt(ts): return time.strftime('%m-%d %H:%M',time.gmtime(ts/1000))
print("CLOSED seats (48h):")
for s in seats:
    mx=max([c['pct'] for c in s['closes']] or [0])
    print(f"{fmt(s['open'])} -> {fmt(s['closeTs'])} {s['k']:18s} n_close={len(s['closes']):2d} net={s['net']:+.3f} fees={s['fees']:.3f} maxExitPct={mx:+.2f}% minExitPct={min(c['pct'] for c in s['closes']):+.2f}%")
print()
cut=1794450000000  # 02:20Z Nov12
post=[s for s in seats if s['open']>=cut]
pre=[s for s in seats if s['open']<cut and s['closeTs']>=now-24*3600*1000]
def stats(lbl,ss):
    if not ss: print(lbl,'n=0'); return
    w=[s['net'] for s in ss if s['net']>0]; l=[s['net'] for s in ss if s['net']<=0]
    print(f"{lbl}: n={len(ss)} net={sum(s['net'] for s in ss):+.3f} WR={len(w)/len(ss):.2f} avgWin={sum(w)/max(1,len(w)):+.4f} avgLoss={sum(l)/max(1,len(l)):+.4f} fees={sum(s['fees'] for s in ss):.3f}")
stats('closed seats, closed within 24h (pre-02:20Z open)',pre)
stats('seats opened >=02:20Z and closed',post)
print()
print("OPEN seats:")
for k,s in cur.items():
    print(k, 'open',fmt(s['open']),'entry',round(s['entry'],4),'size left',round(s['size'],4),'realized net',round(s['net'],4))
    for c in s['closes']: print('   ',fmt(c['ts']),c)
json.dump({'closed':seats,'open':cur},open('seats-out.json','w'),default=str)
