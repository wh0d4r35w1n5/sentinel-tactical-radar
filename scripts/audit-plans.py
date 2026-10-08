import json
led = json.load(open('/opt/sentinel/api/live-ledger.json'))
plans = led.get('plans') or {}
for p in led.get('positionsAfter', []):
    sym = p['symbol']; side = p['side']; entry = p['entry']
    liq = p.get('liq') or 0; size = p['size']
    pl = plans.get(sym, [])
    sl = [x['triggerPrice'] for x in pl if 'loss' in x.get('planType', '')]
    tps = [(x['triggerPrice'], x['size']) for x in pl if 'profit' in x.get('planType', '')]
    tpsz = sum(x[1] for x in tps)
    if side == 'long':
        ok = all(liq < t < entry for t in sl) if sl else False
        gap = (min(sl) - liq) / entry * 100 if sl and liq else None
    else:
        ok = all(entry < t < liq for t in sl) if sl else False
        gap = (liq - max(sl)) / entry * 100 if sl and liq else None
    print(sym, side, 'sz', size, 'entry', round(entry, 5), 'liq', round(liq, 4),
          '| SL', sl, 'inside-band:', ok, 'gap%:', round(gap, 3) if gap else None,
          '| TP legs', len(tps), 'cover', round(tpsz, 4), '/', size)
