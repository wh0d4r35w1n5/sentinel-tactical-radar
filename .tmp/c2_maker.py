import json,math
S=json.load(open("/tmp/c2-seats.json"))["seats"]
def st(v):
    n=len(v)
    if n<2: return f"n={n}"
    m=sum(v)/n;sd=math.sqrt(sum((a-m)**2 for a in v)/(n-1)) or 1e-9
    return f"n={n} sum=${sum(v):+.2f} mean=${m:+.4f} WR={sum(a>0 for a in v)/n:.2f} t={m/sd*math.sqrt(n):+.2f}"
import os
for K in (2,5,15):
  for off in (0.0002,0.0005):
    fil=[];mis=[];allp=[]
    for x in S:
        fn=f"/tmp/c2c/{x['sym']}-{int(x['t0'])}.json"
        if not os.path.exists(fn): continue
        cs=json.load(open(fn));e=x["entry"];L=x["side"]=="long"
        nxt=[c for c in cs if c[0]>x["t0"] and c[0]<=x["t0"]+K*60000]
        if not nxt: continue
        hit=(min(c[3] for c in nxt)<e*(1-off)) if L else (max(c[2] for c in nxt)>e*(1+off))
        save=x["onot"]*0.0004
        allp.append(x["net"])
        (fil if hit else mis).append(x["net"]+(save if hit else 0))
    print(f"K={K}m off={off*100:.2f}%  fillrate={len(fil)/len(allp):.2f}")
    print("   taker-all :",st(allp))
    print("   maker-fill:",st(fil))
    print("   missed    :",st(mis), "(actual taker result of seats a maker order would have missed)")
