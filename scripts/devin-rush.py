#!/usr/bin/env python3
# devin-rush v3 — volume-gated drift-aware market-setup author.
# Only names with real 24h turnover (>$4M) get tickets: dead perps never
# print the +0.4% drift the tape-confirm gate demands. Scores by 5-bar
# momentum above VWAP + own-sample 45s drift.
import json, time, os, urllib.request
ROOT='/opt/sentinel'
TICKS=f'{ROOT}/state/rush-ticks.json'
def load(p,default):
    try: return json.load(open(p))
    except Exception: return default
K4H=load(f'{ROOT}/state/klines-4H.json',{})
K1H=load(f'{ROOT}/state/klines-1h.json',{})
def _closes(row):
    if not row: return None
    cl=row.get('payload',{}).get('closes') if isinstance(row,dict) else None
    if not cl and isinstance(row,dict):
        rows=row.get('rows') or []
        cl=[float(r['c']) for r in rows if r.get('c') is not None]
    return cl if cl and len(cl)>=24 else None
def trend(data,sym):
    cl=_closes(data.get(sym))
    if not cl: return None
    mean=lambda a:sum(a)/len(a)
    fast=mean(cl[-4:]); slow=mean(cl[-12:])
    hi1=max(cl[-24:-12]); hi2=max(cl[-12:])
    lo1=min(cl[-24:-12]); lo2=min(cl[-12:])
    if fast>slow*1.0005 and lo2>lo1: return 'up'
    if fast<slow*0.9995 and hi2<hi1: return 'down'
    return 'flat'
def vetoed(sym):
    # mirror exec long-trend-rule: refuse long when 4H down AND 1h not proven up
    h4=trend(K4H,sym); h1=trend(K1H,sym)
    return h4=='down' and h1!='up'
def tickers():
    try:
        u='https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'
        d=json.load(urllib.request.urlopen(u,timeout=15))['data']
        out={}
        for t in d:
            try: out[t['symbol']]={'px':float(t['lastPr']),'vol':float(t.get('quoteVolume') or 0),'chg':float(t.get('change24h') or 0)*100}
            except: pass
        return out
    except Exception: return {}
ticks=load(TICKS,{})
while True:
    try:
        now=int(time.time()*1000)
        K=load(f'{ROOT}/state/klines-15m.json',{})
        K4H=load(f'{ROOT}/state/klines-4H.json',{})
        K1H=load(f'{ROOT}/state/klines-1h.json',{})
        wl=load(f'{ROOT}/api/wealth-live.json',{})
        held={p['k'].split(':')[0] for p in wl.get('futures',{}).get('positions',[])}
        deny=set()
        ad=load(f'{ROOT}/state/auto-deny.json',{})
        for e in (ad.get('entries') or []):
            if e.get('side')=='long' and e.get('until',0)>now: deny.add(e['symbol'])
        env=load(f'{ROOT}/state/deploy-envelope.json',{})
        for s,c in (env.get('cells') or {}).items():
            if c.get('verdict')=='loser': deny.add(s)
        cat=load(f'{ROOT}/api/exec-catalog.json',{})
        routable=set(cat.get('symbols') or [])
        plan=load(f'{ROOT}/api/live-plan.json',{})
        plan_syms={str(o.get('symbol','')).upper() for o in (plan.get('orders') or [])}
        tk=tickers()
        p=f'{ROOT}/state/cmd-setups.json'
        d=load(p,{})
        s=d.get('setups',d if isinstance(d,list) else [])
        s[:]=[x for x in s if not (str(x.get('id','')).startswith('devin-rush-') and x.get('status') in ('failed','rejected','expired','cancelled') and now-int(x.get('createdAt') or 0)>600e3)]
        rush_armed={x.get('symbol') for x in s if 'devin-rush' in str(x.get('id','')) and x.get('status') in ('armed','triggered')}
        armed_syms={x.get('symbol') for x in s if x.get('status') in ('armed','triggered')}
        TARGET=10
        room=max(0,TARGET-len(rush_armed))
        cands=[]; newticks={}
        # lane B: top-15 by 24h volume — perpetual tickets on names that
        # actually tick; the confirm gate itself times the entry.
        volrank=sorted(tk.items(), key=lambda kv:-kv[1]['vol'])[:15]
        liquid={s for s,_ in volrank}
        for sym,v0 in K.items():
            is_liquid = sym in liquid
            v=v0 if isinstance(v0,list) else (v0.get('rows') or [])
            if len(v)<40: continue
            t=tk.get(sym)
            if not t or t['vol']<1e6: continue           # dead tape = no drift prints
            if t['chg']<0.1 and not is_liquid: continue   # liquid lane exempt — drift is the signal
            last=t['px']
            newticks[sym]={'px':last,'ts':now}
            if sym in held or sym in deny or sym in armed_syms or sym in plan_syms: continue
            if vetoed(sym): continue
            if routable and sym not in routable: continue
            win=v[-96:]
            pv=sum(((r['h']+r['l']+r['c'])/3)*r.get('qv',0) for r in win); vv=sum(r.get('qv',0) for r in win)
            vwap=pv/vv if vv>0 else 0
            mom=(last/v[-6]['c']-1)*100 if len(v)>=7 else 0
            trs=[]
            for i in range(-14,0):
                r,pc=v[i],v[i-1]['c']; trs.append(max(r['h']-r['l'],abs(r['h']-pc),abs(r['l']-pc)))
            atr=sum(trs)/len(trs)/last*100 if trs else 1.0
            if not (0.15<=atr<=4.0): continue
            prev=ticks.get(sym,{}).get('px')
            drift=(last/prev-1)*100 if prev else 0.0
            above=last>vwap
            if is_liquid:
                # liquid lane: no momentum requirement — drift IS the signal.
                # score purely on recent drift so actively-rising names rank top.
                score=drift*8.0 + (2.0 if above else 0.0)
                mom_eff=mom
            else:
                if t['chg']<0.1 or not (0.0<=mom<=15): continue
                score=mom+max(0.0,drift)*4.0+t['chg']*0.1
                mom_eff=mom
            cands.append((round(score,2),round(mom_eff,2),round(drift,2),sym,last,round(atr,3),int(t['vol']/1e6)))
        cands.sort(reverse=True)
        added=0
        for score,mom,drift,sym,last,atr,volM in cands:
            if added>=room: break
            stopPct=3.5*atr; sl=round(last*(1-stopPct/100),8)
            tp1=round(last*(1+1.5*stopPct/100),8); tp2=round(last*(1+3*stopPct/100),8)
            s.append({'id':f'devin-rush-{sym}-{now}','symbol':sym,'direction':'LONG','mode':'market',
              'entryPx':last,'slPx':sl,'lastPx':last,
              'tps':[{'px':tp1,'pct':55},{'px':tp2,'pct':45}],
              'riskPct':3,'ttlMin':120,'strategy':'sentinel-structure','createdAt':now,
              'note':f'rush-v3 devin — score {score} mom5 {mom}% drift45 {drift}% atr {atr}% vol {volM}M','blockedBy':None,'status':'armed','auto':True})
            added+=1
        if added:
            tmp=p+'.tmp'; json.dump(d,open(tmp,'w')); os.rename(tmp,p)
        tmp=TICKS+'.tmp'; json.dump(newticks,open(tmp,'w')); os.rename(tmp,TICKS)
        print(time.strftime('%H:%M:%SZ',time.gmtime()),'quals',len(cands),'rush_armed',len(rush_armed),'added',added,flush=True)
    except Exception as e:
        print('ERR',repr(e),flush=True)
    time.sleep(45)
