import json,math,os,time
S=json.load(open("/tmp/c2-seats.json"))["seats"]
ap={};sub=[]
for ln in open("/opt/sentinel/state/entry-risk-audit.jsonl"):
    try:r=json.loads(ln)
    except: continue
    if r.get("event")=="approved": ap[r["clientOid"]]=r
    elif r.get("event")=="submitted" and r.get("clientOid") in ap: sub.append((r["ts"],r["symbol"],ap[r["clientOid"]]))
RUNG=[0.9,1.5,2.4,4.0,6.5];ALLOC=[.08,.12,.20,.22,.18]
def sim(x,cs,stopPct):
    e=x["entry"];L=1 if x["side"]=="long" else -1
    fav=lambda p:(p/e-1)*100*L
    rem=1.0;pnl=0.0;fee=0.06;nr=0
    for ts,o,h,l,c in cs:
        if ts<x["t0"]: continue
        hi=fav(h if L==1 else l); lo=fav(l if L==1 else h)
        if lo<=-stopPct:
            pnl+=rem*(-stopPct-0.03);fee+=rem*0.06;rem=0;break
        while nr<5 and hi>=RUNG[nr]:
            pnl+=ALLOC[nr]*RUNG[nr];fee+=ALLOC[nr]*0.02;rem-=ALLOC[nr];nr+=1
    if rem>1e-9: pnl+=rem*fav(cs[-1][4]);fee+=rem*0.06
    return pnl-fee
def st(v):
    n=len(v)
    if n<2: return f"n={n}"
    m=sum(v)/n;sd=math.sqrt(sum((a-m)**2 for a in v)/(n-1)) or 1e-9
    return f"n={n} sumR={sum(v):+.2f} avgR={m:+.3f} WR={sum(a>0 for a in v)/n:.2f} SQN={m/sd*math.sqrt(n):+.2f}"
rows=[]
for x in S:
    m=[a for (ts,sym,a) in sub if sym==x["sym"] and abs(ts-x["t0"])<120000]
    fn=f"/tmp/c2c/{x['sym']}-{int(x['t0'])}.json"
    if not m or not os.path.exists(fn): continue
    a=m[0];cs=json.load(open(fn))
    if len(cs)<5: continue
    cl=x["closes"];span=cl[-1][0]-cl[0][0]
    ex=sum(p*s for _,p,s,_ in cl)/sum(s for _,_,s,_ in cl)
    L=1 if x["side"]=="long" else -1
    act=(ex/x["entry"]-1)*100*L
    sp=a["stopFraction"]*100
    simNetPct=sim(x,cs,sp)
    risk=a["riskUsd"]
    rows.append(dict(sym=x["sym"],t0=x["t0"],hold=(x["t1"]-x["t0"])/60000,margin=a["marginUsd"],sp=sp,act=act,span=span,
        actR=x["net"]/risk, simR=simNetPct/100*x["onot"]/risk, cell=a["cell"], notional=x["onot"]))
wd=[r for r in rows if r["span"]<5000 and 0.18<=r["act"]<=0.5]
print("all matched:",len(rows)," wind-down-signature (single whole close at +0.18..+0.5%):",len(wd))
print("  margin<1.25:",sum(r["margin"]<1.25 for r in wd)," margin<2:",sum(r["margin"]<2 for r in wd)," median margin %.2f"%sorted(r["margin"] for r in wd)[len(wd)//2], " median stop%% %.2f"%sorted(r["sp"] for r in wd)[len(wd)//2], "median hold min %.0f"%sorted(r["hold"] for r in wd)[len(wd)//2])
def blk(rs,l):
    print("==",l);print("   actual  :",st([r["actR"] for r in rs]));print("   designed:",st([r["simR"] for r in rs]))
blk(wd,"wind-down-signature seats");h=len(wd)//2;blk(wd[:h],"  older half");blk(wd[h:],"  newer half")
d=[r for r in wd if r["margin"]<1.25];blk(d,"  of which margin<1.25 (dust flag at today's equity)")
blk([r for r in wd if r["margin"]>=1.25],"  margin>=1.25 (dust at higher equity / over-tier / denied)")
blk([r for r in rows if r not in wd],"all OTHER seats (control: designed-exit sim vs actual)")
for r in wd[-25:]: print(time.strftime("%m-%d %H:%M",time.gmtime(r["t0"]/1000)),r["sym"],r["cell"],f"m=${r['margin']:.2f} stop={r['sp']:.1f}% hold={r['hold']:.0f}m act={r['act']:+.2f}% actR={r['actR']:+.2f} simR={r['simR']:+.2f}")
