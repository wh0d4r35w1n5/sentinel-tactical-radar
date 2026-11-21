#!/usr/bin/env python3
# devin-momentum author — zero-touch momentum lane feeder.
# Screen: 15m klines, above 96-bar session VWAP, 5-bar momentum +2.5-8%,
# ATR14 stop 2x, 1.5R/3R ladder, riskPct 5, max 2 seats (same-beta cap).
# Dedupes: held, denied, envelope losers, armed/triggered, attempted <4h.
# Gates downstream (exec): vwap-side, evidence, RR floor, margin, portfolio cap.
import json, time, os
ROOT = '/opt/sentinel'
now = int(time.time()*1000)
COOLDOWN_MS = 4 * 3600e3
MAX_PER_RUN = 6
MAX_MOM_SEATS = 2  # same-beta cap: at most 2 momentum seats live at once —
                   # the 3rd slot must come from a different lane/class so one
                   # market move can't hit the whole book (JTO/CLSK/SPCX lesson)
K = json.load(open(f'{ROOT}/state/klines-15m.json'))
wl = json.load(open(f'{ROOT}/api/wealth-live.json'))
held = {p['k'].split(':')[0] for p in wl['futures'].get('positions',[])}
deny = set()
try:
    ad = json.load(open(f'{ROOT}/state/auto-deny.json'))
    for e in ad.get('entries',[]):
        if e.get('side')=='long' and e.get('until',0) > now: deny.add(e['symbol'])
except Exception: pass
try:
    env = json.load(open(f'{ROOT}/state/deploy-envelope.json'))
    for s,c in (env.get('cells') or {}).items():
        if c.get('verdict')=='loser': deny.add(s)
except Exception: pass
p = f'{ROOT}/state/cmd-setups.json'
d = json.load(open(p))
s = d.get('setups', d if isinstance(d,list) else [])
attempted = {x.get('symbol') for x in s
             if 'devin-mom' in str(x.get('id','')) and now - int(x.get('createdAt') or 0) < COOLDOWN_MS}
# routable-only: exec catalog — unroutable symbols just burn cycles (Claude c14)
try:
    cat = json.load(open(f'{ROOT}/api/exec-catalog.json'))
    routable = set(cat.get('symbols') or [])
except Exception:
    routable = set()
armed = {x.get('symbol') for x in s if x.get('status') in ('armed','triggered')}
mom_open = len(held)  # every seat on this book is LONG — total open count is
                      # the honest same-beta proxy regardless of setup provenance
budget = max(0, MAX_MOM_SEATS - mom_open)
cands = []
for sym,v in K.items():
    if sym in held or sym in deny or sym in attempted or sym in armed: continue
    if routable and sym not in routable: continue
    rows = v.get('rows') or []
    if len(rows) < 40: continue
    win = rows[-96:]
    pv = sum(((r['h']+r['l']+r['c'])/3)*r.get('qv',0) for r in win)
    vv = sum(r.get('qv',0) for r in win)
    if vv <= 0: continue
    vwap = pv/vv
    last = rows[-1]['c']
    if not (last > vwap): continue
    mom = (last/rows[-6]['c'] - 1)*100
    if not (2.5 <= mom <= 8.0): continue
    trs = []
    for i in range(-14,0):
        r,pc = rows[i], rows[i-1]['c']
        trs.append(max(r['h']-r['l'], abs(r['h']-pc), abs(r['l']-pc)))
    atr = sum(trs)/len(trs)/last*100
    if not (0.2 <= atr <= 3.0): continue
    cands.append((round(mom,2), sym, last, round(atr,3)))
cands.sort(reverse=True)
added = 0
for mom, sym, last, atr in cands[:min(MAX_PER_RUN, budget)]:
    stopPct = 2*atr
    sl = round(last*(1-stopPct/100), 8)
    tp1 = round(last*(1+1.5*stopPct/100), 8)
    tp2 = round(last*(1+3.0*stopPct/100), 8)
    s.append({'id': f'devin-mom-{sym}-{now}','symbol': sym,'direction': 'LONG','mode': 'market',
      'entryPx': last,'slPx': sl,'lastPx': last,
      'tps': [{'px': tp1,'pct': 55},{'px': tp2,'pct': 45}],
      'riskPct': 5,'ttlMin': 240,'strategy': 'devin-momentum','createdAt': now,
      'note': f'momentum-breakout — devin lane auto, vwap+{mom}% 5bar, atr {atr}% stop 2x, full-size',
      'blockedBy': None,'status': 'armed','auto': True})
    added += 1
if added:
    tmp = p + '.tmp'
    json.dump(d, open(tmp,'w'))
    os.rename(tmp, p)
print(f'{time.strftime("%H:%M:%SZ", time.gmtime())} qualifiers={len(cands)} authored={added} mom_open={mom_open} budget={budget}')
