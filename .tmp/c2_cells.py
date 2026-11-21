import json,math,time,collections
S=json.load(open("/tmp/c2-seats.json"))["seats"]
ap={};sub=[]
for ln in open("/opt/sentinel/state/entry-risk-audit.jsonl"):
    try:r=json.loads(ln)
    except: continue
    if r.get("event")=="approved": ap[r["clientOid"]]=r
    elif r.get("event")=="submitted" and r.get("clientOid") in ap: sub.append((r["ts"],r["symbol"],ap[r["clientOid"]]))
print("submitted entries in audit:",len(sub), "first", time.strftime("%m-%d %H:%M",time.gmtime(sub[0][0]/1000)))
adm=json.load(open("/opt/sentinel/state/cell-admission.json"))
print("cell-admission keys:",list(adm.keys())[:8])
cells=adm.get("cells") or adm
def stats(v):
    n=len(v)
    if n<2: return f"n={n} sum={sum(v):+.2f}"
    m=sum(v)/n;sd=math.sqrt(sum((a-m)**2 for a in v)/(n-1)) or 1e-9
    return f"n={n} sumR={sum(v):+.2f} avgR={m:+.3f} WR={sum(a>0 for a in v)/n:.2f} SQN={m/sd*math.sqrt(n):+.2f}"
by=collections.defaultdict(list);bt=collections.defaultdict(list);un=0
rows=[]
for x in S:
    c=[a for (ts,sym,a) in sub if sym==x["sym"] and abs(ts-x["t0"])<120000]
    if not c: un+=1;continue
    a=c[0];R=x["net"]/a["riskUsd"] if a.get("riskUsd") else 0
    by[a.get("cell")].append(R);bt[a.get("evidenceTier")].append(R)
    rows.append((x["t0"],x["sym"],a.get("cell"),a.get("evidenceTier"),round(R,2),round(x["net"],3),round(a["stopFraction"]*100,2),a.get("leverage")))
print("unmatched seats:",un,"matched:",len(rows))
print("== by evidenceTier");[print(" ",k,stats(v)) for k,v in bt.items()]
print("== by cell");[print(" ",k,stats(v)) for k,v in sorted(by.items(),key=lambda kv:sum(kv[1]))]
print("== last 20 matched")
for r in rows[-20:]: print(time.strftime("%m-%d %H:%M",time.gmtime(r[0]/1000)),*r[1:])
print("== admission rows for live cells")
for k in by:
    v=cells.get(k) if isinstance(cells,dict) else None
    print(" ",k,json.dumps(v)[:400] if v else None)
print("== recency by cell (last entry, n last 72h, R last 72h)")
import collections
lc=collections.defaultdict(lambda:[0,0,0.0])
now=time.time()*1000
for r in rows:
    c=lc[r[2]];c[0]=max(c[0],r[0])
    if r[0]>now-72*3600e3: c[1]+=1;c[2]+=r[4]
for k,v in sorted(lc.items(),key=lambda kv:-kv[1][0]): print(" ",k,time.strftime("%m-%d %H:%M",time.gmtime(v[0]/1000)),v[1],round(v[2],2))
