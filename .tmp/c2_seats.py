import json,time,sys,urllib.request
d=json.load(open("/opt/sentinel/state/real-fills.json"))["fills"]
d=sorted(d,key=lambda x:x["ts"])
now=time.time()*1000
# rebuild seats by running size per symbol (position side: open buy=long, open sell=short; close buy=long close (bitget hedge-mode: close side = pos side))
seats=[];cur={}
for f in d:
    s=f["symbol"]; ts=f["ts"]; sz=float(f["size"]); px=float(f["price"]); fee=abs(float(f.get("fee") or 0)); pr=float(f.get("profit") or 0)
    c=cur.get(s)
    if f["tradeSide"]=="open":
        side="long" if f["side"]=="buy" else "short"
        if not c:
            c=cur[s]={"sym":s,"side":side,"t0":ts,"sz":0,"osz":0,"onot":0,"fees":0,"gross":0,"closes":[],"risk":None}
        c["sz"]+=sz;c["osz"]+=sz;c["onot"]+=sz*px;c["fees"]+=fee
    else:
        if not c: continue
        c["sz"]-=sz;c["fees"]+=fee;c["gross"]+=pr;c["closes"].append((ts,px,sz,pr))
        if f.get("riskUsd"): c["risk"]=f["riskUsd"]
        if c["sz"]<=1e-9*max(1,c["osz"]) or c["sz"]<c["osz"]*0.001:
            c["t1"]=ts;c["entry"]=c["onot"]/c["osz"];c["net"]=c["gross"]-c["fees"];seats.append(c);cur.pop(s)
json.dump({"seats":seats,"open":cur},open("/tmp/c2-seats.json","w"))
H=float(sys.argv[1]) if len(sys.argv)>1 else 24
def rep(ss,label):
    if not ss: print(label,"n=0");return
    w=[x for x in ss if x["net"]>0]; l=[x for x in ss if x["net"]<=0]
    aw=sum(x["net"] for x in w)/len(w) if w else 0; al=sum(x["net"] for x in l)/len(l) if l else 0
    print(f"{label}: n={len(ss)} net={sum(x['net'] for x in ss):.3f} fees={sum(x['fees'] for x in ss):.3f} WR={len(w)/len(ss):.2f} avgWin={aw:.4f} avgLoss={al:.4f}")
rep([x for x in seats if x["t1"]>now-H*3600e3],f"closed last {H}h")
rep(seats,"all in journal")
cut=1794450000000  # 02:20Z Nov-12
rep([x for x in seats if x["t0"]>cut],"opened after 02:20Z")
print("OPEN:",{k:(v["side"],round(v["sz"],4),round(v["onot"]/v["osz"],4),time.strftime("%m-%d %H:%M",time.gmtime(v["t0"]/1000)),round(v["gross"]-v["fees"],3),len(v["closes"])) for k,v in cur.items()})
print("last 40 seats:")
for x in seats[-40:]:
    ex=sum(p*s for _,p,s,_ in x["closes"])/sum(s for _,_,s,_ in x["closes"])
    pct=(ex/x["entry"]-1)*100*(1 if x["side"]=="long" else -1)
    print(time.strftime("%m-%d %H:%M",time.gmtime(x["t0"]/1000)),time.strftime("%H:%M",time.gmtime(x["t1"]/1000)),x["sym"],x["side"],f"not={x['onot']:.1f} exit%={pct:+.2f} net={x['net']:+.3f} fees={x['fees']:.3f} nclose={len(x['closes'])} risk={x['risk'] and round(x['risk'],2)}")
