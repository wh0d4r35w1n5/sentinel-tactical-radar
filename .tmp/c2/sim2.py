import json,urllib.request,time,os
exec(open('sim.py').read().split("V={")[0])  # reuse get/sim
S=json.load(open('seats-out.json'))['closed']
V={'A stop-1.2':(0.35,0.66,0.55,-1.2),'A stop-0.8':(0.35,0.66,0.55,-0.8),'A stop-0.6':(0.35,0.66,0.55,-0.6),'A stop-1.6':(0.35,0.66,0.55,-1.6),'A stop-2.0':(0.35,0.66,0.55,-2.0),'E stop-0.8':(None,0,0,-0.8),'E stop-1.6':(None,0,0,-1.6),'F1.2 stop-0.8':(1.2,0.55,0.55,-0.8)}
tot={k:[] for k in V}; ext=[]
for s in S:
    sym,side=s['k'].split(':'); L=side=='long'; e=s['entry']; notion=s['cost']
    cands=get(sym,s['open'],s['open']+8*3600000)
    if len(cands)<5: continue
    for k,(arm,gs,gb,st) in V.items():
        tot[k].append(sim(cands,e,L,arm,gs,gb,stop=st)/100*notion)
    pre=get(sym,s['open']-30*60000,s['open']-60000)
    if pre:
        lo=min(float(c[3]) for c in pre); hi=max(float(c[2]) for c in pre)
        x=((e-lo)/e*100) if L else ((hi-e)/e*100)
        ext.append((s['k'],round(x,2),s['net']))
for k,v in tot.items():
    w=[x for x in v if x>0]; l=[x for x in v if x<=0]
    print(f"{k:16s} n={len(v)} net={sum(v):+.3f} WR={len(w)/len(v):.2f} avgWin={sum(w)/max(1,len(w)):+.4f} avgLoss={sum(l)/max(1,len(l)):+.4f}")
print('\nentry extension vs prior-30m low (longs)/high (shorts):')
ext.sort(key=lambda r:r[1])
for lbl,grp in [('ext<0.5',[r for r in ext if r[1]<0.5]),('0.5-1.0',[r for r in ext if 0.5<=r[1]<1.0]),('1.0-2.0',[r for r in ext if 1.0<=r[1]<2.0]),('>=2.0',[r for r in ext if r[1]>=2.0])]:
    if grp: print(f"{lbl:8s} n={len(grp)} net={sum(r[2] for r in grp):+.3f} WR={len([r for r in grp if r[2]>0])/len(grp):.2f} avg={sum(r[2] for r in grp)/len(grp):+.3f}")
print([r for r in ext if r[1]>=1.5])
