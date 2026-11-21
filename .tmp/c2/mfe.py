import json,urllib.request,time,sys
S=json.load(open('seats-out.json'))['closed']
out=[]
for s in S:
    sym,side=s['k'].split(':')
    st=s['open']-60000; en=s['closeTs']+60000
    url=f"https://api.bitget.com/api/v2/mix/market/history-candles?symbol={sym}&productType=USDT-FUTURES&granularity=1m&startTime={st}&endTime={en}&limit=200"
    try:
        d=json.loads(urllib.request.urlopen(url,timeout=15).read())['data']
    except Exception as e:
        print('ERR',sym,e); continue
    if not d: print('nodata',sym); continue
    hi=max(float(c[2]) for c in d); lo=min(float(c[3]) for c in d)
    e=s['entry']
    mfe=((hi-e)/e*100) if side=='long' else ((e-lo)/e*100)
    mae=((e-lo)/e*100) if side=='long' else ((hi-e)/e*100)
    out.append({'k':s['k'],'open':s['open'],'net':s['net'],'mfe':round(mfe,3),'mae':round(mae,3),'maxExit':max(c['pct'] for c in s['closes']),'n':len(d),'durMin':(s['closeTs']-s['open'])/60000})
    time.sleep(0.15)
json.dump(out,open('mfe-out.json','w'))
print(f"{'seat':20s} {'net':>7s} {'MFE%':>6s} {'MAE%':>6s} {'maxExit%':>8s} {'min':>5s}")
for r in out: print(f"{r['k']:20s} {r['net']:+7.3f} {r['mfe']:6.2f} {r['mae']:6.2f} {r['maxExit']:+8.2f} {r['durMin']:5.0f}")
