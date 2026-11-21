import json,time,os,sys,urllib.request,math
S=json.load(open("/tmp/c2-seats.json"))["seats"]
os.makedirs("/tmp/c2c",exist_ok=True)
HZ=24*3600e3
now=time.time()*1000
def candles(sym,t0,t1):
    fn=f"/tmp/c2c/{sym}-{int(t0)}.json"
    if os.path.exists(fn): return json.load(open(fn))
    out={};end=t1
    for _ in range(12):
        u=f"https://api.bitget.com/api/v2/mix/market/history-candles?symbol={sym}&productType=USDT-FUTURES&granularity=1m&limit=200&endTime={int(end)}"
        try:
            r=json.load(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"curl/8"}),timeout=15))
        except Exception as e:
            time.sleep(1);continue
        rows=r.get("data") or []
        if not rows: break
        for c in rows: out[int(c[0])]=[int(c[0]),float(c[1]),float(c[2]),float(c[3]),float(c[4])]
        mn=min(int(c[0]) for c in rows)
        time.sleep(0.07)
        if mn<=t0: break
        end=mn
    rows=[out[k] for k in sorted(out) if k>=t0-60000 and k<=t1]
    json.dump(rows,open(fn,"w"));return rows
RUNG=[0.9,1.5,2.4,4.0,6.5];ALLOC=[.08,.12,.20,.22,.18]
def sim(x,cs,pol):
    e=x["entry"];L=1 if x["side"]=="long" else -1
    fav=lambda p:(p/e-1)*100*L
    stop=-pol["S"];peak=0;rem=1.0;pnl=0.0;fee=0.06 # pct of notional, entry taker
    nr=0
    for ts,o,h,l,c in cs:
        if ts<x["t0"]-60000: continue
        hi=fav(h if L==1 else l); lo=fav(l if L==1 else h); cl=fav(c)
        if ts<x["t0"]: # entry bar: only use close
            hi=lo=cl
        if lo<=stop:
            px=stop-0.03
            pnl+=rem*px;fee+=rem*0.06;rem=0;break
        while nr<5 and hi>=RUNG[nr]:
            pnl+=ALLOC[nr]*RUNG[nr];fee+=ALLOC[nr]*0.02;rem-=ALLOC[nr];nr+=1
        peak=max(peak,hi)
        lock=None
        if pol.get("be") and peak>=pol["be"][0]: lock=pol["be"][1]
        if peak>=pol["A"]:
            g=pol["gs"] if peak<1.2 else pol["gb"]
            lk=max(0.2,g*peak); lock=max(lock,lk) if lock is not None else lk
        if lock is not None and lock<=cl-0.15 and lock>stop: stop=lock
    if rem>1e-9:
        pnl+=rem*fav(cs[-1][4]);fee+=rem*0.06
    return pnl-fee, pnl, fee, peak
POLS={
 "P0 current .35/.66/.55":dict(S=1.1,A=.35,gs=.66,gb=.55),
 "P1 lock from 1.2 only":dict(S=1.1,A=1.2,gs=.55,gb=.55),
 "P2 BE+.15@.6, trail 1.2":dict(S=1.1,A=1.2,gs=.55,gb=.55,be=(.6,.15)),
 "P3 BE+.15@.9, trail 1.2":dict(S=1.1,A=1.2,gs=.55,gb=.55,be=(.9,.15)),
 "P4 no lock":dict(S=1.1,A=99,gs=0,gb=0),
 "P5 A.6 gs.5":dict(S=1.1,A=.6,gs=.5,gb=.55),
 "P6 BE+.15@.9, trail 2.0 g.5":dict(S=1.1,A=2.0,gs=.5,gb=.5,be=(.9,.15)),
 "P7 BE+.15@.6, trail 1.2, S1.5":dict(S=1.5,A=1.2,gs=.55,gb=.55,be=(.6,.15)),
}
rows=[]
for x in S:
    t1=min(x["t0"]+HZ,now)
    cs=candles(x["sym"],x["t0"],t1)
    if len(cs)<5: continue
    ex=sum(p*s for _,p,s,_ in x["closes"])/sum(s for _,_,s,_ in x["closes"])
    L=1 if x["side"]=="long" else -1
    act=(ex/x["entry"]-1)*100*L
    seg=[c for c in cs if c[0]>=x["t0"] and c[0]<=x["t1"]]
    mfe=max([(c[2]/x["entry"]-1)*100 if L==1 else (1-c[3]/x["entry"])*100 for c in seg] or [0])
    mae=min([(c[3]/x["entry"]-1)*100 if L==1 else (1-c[2]/x["entry"])*100 for c in seg] or [0])
    post=[c for c in cs if c[0]>x["t1"]]
    mfe24=max([(c[2]/x["entry"]-1)*100 if L==1 else (1-c[3]/x["entry"])*100 for c in cs if c[0]>=x["t0"]] or [0])
    r={"sym":x["sym"],"side":x["side"],"t0":x["t0"],"t1":x["t1"],"not":x["onot"],"act":act,"actNetPct":x["net"]/x["onot"]*100,"mfe":mfe,"mae":mae,"mfe24":mfe24,"sim":{}}
    for k,p in POLS.items(): r["sim"][k]=sim(x,cs,p)[0]
    rows.append(r)
json.dump(rows,open("/tmp/c2-mfe.json","w"))
print("seats with candles:",len(rows),"of",len(S))
def stats(v):
    n=len(v);
    if n<2: return "n<2"
    m=sum(v)/n;sd=math.sqrt(sum((a-m)**2 for a in v)/(n-1)) or 1e-9
    w=[a for a in v if a>0];l=[a for a in v if a<=0]
    return f"n={n} mean={m:+.3f}% sum={sum(v):+.1f}% WR={len(w)/n:.2f} avgW={sum(w)/max(1,len(w)):+.2f} avgL={sum(l)/max(1,len(l)):+.2f} SQN={m/sd*math.sqrt(n):+.2f}"
def block(rs,label):
    print("==",label)
    print("  ACTUAL net%/notional:",stats([r["actNetPct"] for r in rs]))
    for k in POLS: print(f"  {k:32s}",stats([r["sim"][k] for r in rs]))
block(rows,"ALL")
h=len(rows)//2
block(rows[:h],"older half (train)");block(rows[h:],"newer half (test)")
block([r for r in rows if r["side"]=="long"],"longs");block([r for r in rows if r["side"]=="short"],"shorts")
rp=[r for r in rows if r["t0"]>1794405840000]  # after rung-push 11-11 14:04Z
block(rp,"post-rung-push seats")
# clipped winners: actual exit +0.15..+0.45
cl=[r for r in rows if 0.15<=r["act"]<=0.45]
print("CLIPPED (+0.15..+0.45 exits): n=%d  median MFE-in-seat=%.2f  median MFE24=%.2f  share MFE24>=0.9: %.2f  >=1.5: %.2f  >=2.4: %.2f"%(len(cl),sorted(r["mfe"] for r in cl)[len(cl)//2],sorted(r["mfe24"] for r in cl)[len(cl)//2],sum(r["mfe24"]>=.9 for r in cl)/len(cl),sum(r["mfe24"]>=1.5 for r in cl)/len(cl),sum(r["mfe24"]>=2.4 for r in cl)/len(cl)))
block(cl,"clipped subset")
