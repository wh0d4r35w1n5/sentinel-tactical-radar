import json,urllib.request,time
S=json.load(open('seats-out.json'))['closed']
M={r['k']+str(r['open']):r for r in json.load(open('mfe-out.json'))}
res=[]
for s in S:
    sym,side=s['k'].split(':'); e=s['entry']; L=side=='long'
    r=M.get(s['k']+str(s['open']))
    if not r: continue
    st=s['closeTs']; en=st+180*60000
    url=f"https://api.bitget.com/api/v2/mix/market/history-candles?symbol={sym}&productType=USDT-FUTURES&granularity=1m&startTime={st}&endTime={en}&limit=200"
    try: d=json.loads(urllib.request.urlopen(url,timeout=15).read())['data']
    except Exception as ex: print('ERR',sym,ex); continue
    d.sort(key=lambda c:int(c[0]))
    fav=lambda px:((px-e)/e*100) if L else ((e-px)/e*100)
    # walk forward: first touch of +0.9 rung1 vs -1.2 band stop (from entry)
    first=None; pk=-9
    for c in d:
        hi=float(c[2]);lo=float(c[3])
        f_hi=fav(hi) if L else fav(lo); f_lo=fav(lo) if L else fav(hi)
        pk=max(pk,f_hi)
        if first is None:
            if f_lo<=-1.2: first='stop'
            elif f_hi>=0.9: first='rung1'
    res.append({'k':s['k'],'net':s['net'],'mfe':r['mfe'],'maxExit':r['maxExit'],'post3h_peak':round(pk,2),'first':first,'n':len(d)})
    time.sleep(0.15)
json.dump(res,open('cf-out.json','w'))
print(f"{'seat':20s} {'net':>7s} {'MFE':>5s} {'exit':>6s} {'post3hPk':>8s} first")
for r in res: print(f"{r['k']:20s} {r['net']:+7.3f} {r['mfe']:5.2f} {r['maxExit']:+6.2f} {r['post3h_peak']:8.2f} {r['first']}")
w=[r for r in res if r['net']>0 and r['maxExit']<0.9]
print('\nlock-clipped winners (exit<0.9%):',len(w))
import collections; print(collections.Counter(r['first'] for r in w))
print('median post3h peak',sorted(r['post3h_peak'] for r in w)[len(w)//2])
