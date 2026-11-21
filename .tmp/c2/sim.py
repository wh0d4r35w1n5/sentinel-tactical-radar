import json,urllib.request,time,os
S=json.load(open('seats-out.json'))['closed']
cache='candles-cache.json'
C=json.load(open(cache)) if os.path.exists(cache) else {}
def get(sym,st,en):
    key=f"{sym}:{st}"
    if key in C: return C[key]
    rows=[]; cur=st
    while cur<en:
        url=f"https://api.bitget.com/api/v2/mix/market/history-candles?symbol={sym}&productType=USDT-FUTURES&granularity=1m&startTime={cur}&endTime={min(en,cur+200*60000)}&limit=200"
        try: d=json.loads(urllib.request.urlopen(url,timeout=15).read())['data']
        except Exception as ex: print('ERR',sym,ex); break
        if not d: break
        rows+=d; cur=cur+200*60000; time.sleep(0.12)
    rows=sorted({int(c[0]):c for c in rows}.values(),key=lambda c:int(c[0]))
    C[key]=rows; json.dump(C,open(cache,'w')); return rows
RUNGS=[0.9,1.5,2.4,4.0,6.5]; ALLOC=[0.08,0.12,0.20,0.22,0.18]; MOON=0.20
FEE=0.12
def sim(cands,e,L,arm,giveS,giveB,floor=0.2,stop=-1.2,hours=8):
    fav=lambda px:((px-e)/e*100) if L else ((e-px)/e*100)
    peak=0; rem=1.0; banked=0.0; consumed=set()
    for c in cands:
        hi=float(c[2]);lo=float(c[3])
        fh=fav(hi) if L else fav(lo); fl=fav(lo) if L else fav(hi)
        lock=None
        if arm is not None and peak>=arm:
            g=giveS if peak<1.2 else giveB
            lock=max(floor,g*peak)
        if fl<=stop: return banked+rem*(stop-0.05)-FEE
        if lock is not None and fl<=lock: return banked+rem*(lock-0.05)-FEE
        for i,r in enumerate(RUNGS):
            if i not in consumed and fh>=r:
                consumed.add(i); banked+=ALLOC[i]*r; rem-=ALLOC[i]
        peak=max(peak,fh)
    return banked+rem*fav(float(cands[-1][4]))-FEE
V={'A_live(arm.35,.66/.55)':(0.35,0.66,0.55),'B(arm.9,.55)':(0.9,0.55,0.55),'C(arm.35,.5/.55)':(0.35,0.5,0.55),'D(arm.6,.6/.55)':(0.6,0.6,0.55),'E(nolock)':(None,0,0),'F(arm1.2,.55)':(1.2,0.55,0.55)}
tot={k:[] for k in V}
for s in S:
    sym,side=s['k'].split(':'); L=side=='long'; e=s['entry']; notion=s['cost']
    cands=get(sym,s['open'],s['open']+8*3600000)
    if len(cands)<5: continue
    for k,(arm,gs,gb) in V.items():
        p=sim(cands,e,L,arm,gs,gb)
        tot[k].append(p/100*notion)
real=[s['net'] for s in S]
print('seats',len(S),'realized net',round(sum(real),3),'avgWin',round(sum(x for x in real if x>0)/max(1,len([x for x in real if x>0])),4),'WR',round(len([x for x in real if x>0])/len(real),2))
for k,v in tot.items():
    w=[x for x in v if x>0]; l=[x for x in v if x<=0]
    print(f"{k:24s} n={len(v)} net={sum(v):+.3f} WR={len(w)/len(v):.2f} avgWin={sum(w)/max(1,len(w)):+.4f} avgLoss={sum(l)/max(1,len(l)):+.4f}")
