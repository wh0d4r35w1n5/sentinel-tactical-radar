import json, os, time, urllib.request, hmac, hashlib, base64, fcntl

# singleton: only ONE status daemon may write status.json — duplicated
# sudo-python orphans have repeatedly raced the systemd unit and clobbered
# the feed with stale-shaped output.
_lf = open('/opt/sentinel/state/.statusd.lock', 'w')
try:
    fcntl.flock(_lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    raise SystemExit('another sentinel-statusd holds the lock — exiting')

RATE = {'v': 1.55, 'at': 0}
def aud_rate():
    # Live-ish AUD/USD: Yahoo chart API tracks intraday FX (Frankfurter is a
    # once-daily ECB fix — up to ~2% stale intraday = ~A$4 drift on A$190).
    # Cache 120s; Frankfurter only as fallback. Last-good survives outages.
    if time.time() - RATE['at'] > 120:
        ok = False
        # USDT/AUD from exchange markets — what the Bitget app's AUD wallet
        # valuation tracks (USDT quoted directly in AUD, not a USD fiat fix).
        try:
            d = json.loads(urllib.request.urlopen('https://api.kraken.com/0/public/Ticker?pair=USDTAUD', timeout=5).read())
            res = d.get('result') or {}
            row = res.get('USDTAUD') or next(iter(res.values()))
            p = float(row['c'][0])
            if 1.0 < p < 3.0:
                RATE['v'] = p; ok = True
        except Exception:
            pass
        if not ok:
            try:
                d = json.loads(urllib.request.urlopen('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=aud', timeout=5).read())
                p = float(d['tether']['aud'])
                if 1.0 < p < 3.0:
                    RATE['v'] = p; ok = True
            except Exception:
                pass
        if not ok:
            try:
                u = 'https://query1.finance.yahoo.com/v8/finance/chart/AUDUSD=X?interval=1m&range=1d'
                req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
                d = json.loads(urllib.request.urlopen(req, timeout=5).read())
                RATE['v'] = 1.0 / float(d['chart']['result'][0]['meta']['regularMarketPrice'])  # AUDUSD=X is USD-per-AUD; we need USD->AUD
                ok = True
            except Exception:
                pass
        if not ok:
            try:
                d = json.loads(urllib.request.urlopen('https://api.frankfurter.app/latest?from=USD&to=AUD', timeout=5).read())
                RATE['v'] = float(d['rates']['AUD']); ok = True
            except Exception:
                pass
        if ok:
            RATE['at'] = time.time()
    return RATE['v']

def tick(sym):
    try:
        u = f"https://api.bitget.com/api/v2/mix/market/ticker?symbol={sym}&productType=USDT-FUTURES"
        d = json.loads(urllib.request.urlopen(u, timeout=3).read())
        row = d['data'][0]
        # markPrice is the exchange's own valuation (what uPnL/liq use);
        # lastPr freezes for minutes on illiquid stock-perps (KLAC lastPr
        # sat 147.67 while mark ran to 148.36 — dashboard upl looked dead).
        return float(row.get('markPrice') or row.get('lastPr'))
    except Exception:
        return None

# batch marks: ONE tickers call per loop serves every seat + arm symbol.
# Replaces N serial 3s-timeout calls that could stall a 1s poll cycle.
TICKS = {'at': 0, 'm': {}}
def marks():
    if time.time() - TICKS['at'] > 3:
        try:
            d = json.loads(urllib.request.urlopen(
                'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', timeout=4).read())
            TICKS['m'] = {r['symbol']: float(r.get('markPrice') or r.get('lastPr'))
                          for r in d['data'] if r.get('symbol')}
            TICKS['at'] = time.time()
        except Exception:
            pass
    return TICKS['m']

# tail-read: never slurp a growing log to grab its last lines
def tail(path, n, span=400000):
    try:
        sz = os.path.getsize(path)
        with open(path, 'rb') as f:
            f.seek(max(0, sz - span))
            data = f.read().decode('utf-8', 'replace')
        return data.strip().split('\n')[-n:]
    except Exception:
        return []

# mtime-cached fills: the heavy episode/pnl scans only re-parse when the
# file actually changed — most poll cycles have zero new fills.
def fills_now():
    try:
        mt = os.path.getmtime('/opt/sentinel/state/real-fills.json')
        if mt != C.get('fills_mt'):
            d = json.load(open('/opt/sentinel/state/real-fills.json'))
            C['fills_mt'] = mt
            C['fills'] = d.get('fills', d if isinstance(d, list) else [])
    except Exception:
        pass
    return C.get('fills') or []

# ---- armed plan truth: live-ledger's plans dict went stale with the old
# engine; the only honest source is the exchange's pending-plan endpoint ----
CREDS = {}
def _load_creds():
    if CREDS.get('k'): return True
    try:
        for l in open('/opt/sentinel/.env'):
            if l.startswith('BITGET_API_KEY='): CREDS['k'] = l.split('=', 1)[1].strip()
            if l.startswith('BITGET_API_SECRET='): CREDS['s'] = l.split('=', 1)[1].strip()
            if l.startswith('BITGET_PASSPHRASE='): CREDS['p'] = l.split('=', 1)[1].strip()
    except Exception:
        pass
    return bool(CREDS.get('k'))

def pending_plans(symbols):
    out = {}
    if not _load_creds(): return out
    pth = '/api/v2/mix/order/orders-plan-pending'
    for sym in (symbols or []):
        try:
            qs = f'symbol={sym}&productType=USDT-FUTURES&marginCoin=USDT&planType=profit_loss'
            ts = str(int(time.time() * 1000))
            sign = base64.b64encode(hmac.new(CREDS['s'].encode(), (ts + 'GET' + pth + '?' + qs).encode(), hashlib.sha256).digest()).decode()
            req = urllib.request.Request('https://api.bitget.com' + pth + '?' + qs, headers={
                'ACCESS-KEY': CREDS['k'], 'ACCESS-SIGN': sign, 'ACCESS-PASSPHRASE': CREDS['p'],
                'ACCESS-TIMESTAMP': ts, 'locale': 'en-US'})
            d = json.loads(urllib.request.urlopen(req, timeout=5).read())
            l = (d.get('data') or {}).get('entrustedList') or (d.get('data') or {}).get('orders') or []
            for it in l:
                out.setdefault(sym, []).append({'planType': it.get('planType'),
                                              'triggerPrice': float(it.get('triggerPrice') or it.get('price') or 0)})
        except Exception:
            pass
    return out

C = {'w_at': 0, 'led_at': 0, 'log_at': 0, 'trip_at': 0, 'dm_at': 0, 'pnl_at': 0, 'hist_at': 0, 'mfe_at': 0,
     'total': None, 'avail': None, 'roster': [], 'ledger': [], 'dm_log': [], 'last_trip': None, 'dm': None,
     'pnl': None, 'hist': [], 'mfe': {}}

while True:
    out = {}
    try:
        if time.time() - C['w_at'] > 8:
            w = json.load(open('/opt/sentinel/api/wealth-live.json'))
            f = w['futures']
            # total = Bitget account truth (futures equity + spot). Off-exchange
            # holdings (solana web3 wallet, external onchain) reported separately —
            # they aren't part of the exchange balance the operator compares to.
            C['total'] = round(f['equityUsd'] + ((w.get('spot') or {}).get('totalUsd') or 0), 3)
            C['offx'] = round(((w.get('solana') or {}).get('totalUsd') or 0) +
                              ((w.get('external') or {}).get('totalUsd') or 0), 4)
            C['avail'] = round(f['availableUsd'], 2)
            C['dep'] = round(f['marginUsedUsd'] / f['equityUsd'] * 100, 1) if f.get('equityUsd') else None
            C['wpos'] = f.get('positions', [])
            C['spotUsd'] = (w.get('spot') or {}).get('totalUsd')
            C['w_at'] = time.time()
    except Exception as e:
        out['wealth_err'] = str(e)
    out['total'] = C['total']; out['avail'] = C['avail']; out['dep'] = C.get('dep'); out['offx'] = C.get('offx')

    try:
        if time.time() - C['led_at'] > 10:
            d = json.load(open('/opt/sentinel/api/live-ledger.json'))
            C['roster'] = d.get('openPositions') or d.get('positions') or []
            C['ledger'] = d.get('actions', [])[-5:]
            C['plans'] = d.get('plans') or {}
            C['led_at'] = time.time()
    except Exception:
        pass
    out['ledger'] = C['ledger']

    led_map = {p.get('symbol'): p for p in C['roster']}
    pos = []
    upl_delta = 0.0
    wpos = C.get('wpos') or []
    if not wpos and C['roster']:
        wpos = [{'k': f"{p.get('symbol')}:{p.get('side')}", 'uplUsd': p.get('upl'),
                 'size': p.get('size'), 'marginUsd': p.get('margin')} for p in C['roster']]
    mm = marks()
    for wp in wpos:
        sym, side = wp['k'].split(':')[0], wp['k'].split(':')[1].upper()
        sgn = -1 if side == 'SHORT' else 1
        lp = led_map.get(sym, {})
        mark = mm.get(sym) or tick(sym)
        upl = wp.get('uplUsd')
        ent = lp.get('entry'); sz = wp.get('size') or lp.get('size')
        if not ent and mark and sz and upl is not None and sgn and (sz * sgn):
            ent = round(mark - upl / (sz * sgn), 8)
        if mark and ent and sz:
            upl = round((mark - ent) * sz * sgn, 4)
            upl_delta += upl - (wp.get('uplUsd') or 0)
        p = lp
        age_s = round((time.time() * 1000 - (p.get('cTime') or 0)) / 1000) if p.get('cTime') else None
        liq_dist = None
        if mark and lp.get('liq'):
            liq_dist = round((mark - lp['liq']) / mark * 100 * (1 if side == 'LONG' else -1), 2)
        stop_px = tp_px = stop_dist = tp_dist = None
        _pls = (C.get('plans2') or {}).get(sym) or (C.get('plans') or {}).get(sym, [])
        for pl in _pls:
            if pl.get('planType') in ('loss_plan', 'pos_loss'):
                stop_px = pl.get('triggerPrice')
            elif pl.get('planType') in ('profit_plan', 'pos_profit'):
                tp = pl.get('triggerPrice')
                if tp and mark:
                    ahead = (tp - mark) * sgn > 0
                    if ahead and (tp_px is None or abs(tp - mark) < abs(tp_px - mark)):
                        tp_px = tp
        if mark and stop_px:
            stop_dist = round((mark - stop_px) / mark * 100 * sgn, 2)
        if mark and tp_px:
            tp_dist = round(abs(tp_px - mark) / mark * 100, 2)
        m = (C['mfe'] or {}).get(f"{sym}:{side.lower()}", {})
        lev = lp.get('lev')
        mg = wp.get('marginUsd') or lp.get('margin')
        rlist = (C.get('reasons') or {}).get(sym) or []
        if not isinstance(rlist, list): rlist = [rlist]
        rlist = [r for r in rlist if isinstance(r, dict)]
        rcur = rlist[-1] if rlist else None
        _ct = p.get('cTime') or 0
        if _ct and rlist and (rlist[-1].get('at') or 0) - _ct <= 600000:
            # no relabel after open — pin the reason written nearest the seat's cTime
            for e in reversed(rlist):
                if abs((e.get('at') or 0) - _ct) < 600000:
                    rcur = e
                    break
        _tag = (rcur or {}).get('tag')
        _pf = (C.get('tags') or {}).get(_tag) if _tag else None
        if not lev and ent and sz and mg:
            lev = round(ent * sz / mg)
        _kl = (C.get('kl') or {}).get(sym) or {}
        _spark = [r.get('c') for r in (_kl.get('rows') or [])[-40:] if r.get('c')]
        pos.append({'sym': sym, 'side': side, 'entry': ent, 'mark': mark, 'spark': _spark,
                    'upl': upl, 'lev': lev, 'margin': mg,
                    'size': sz if sz else (round((mg * lev / mark), 8) if (mg and lev and mark) else None),
                    'notional': round((sz * mark) if (sz and mark) else ((mg or 0) * (lev or 0)), 2) if (mg or sz) else None,
                    'age_s': age_s, 'liq_dist': liq_dist,
                    'liqok': (liq_dist > stop_dist) if (liq_dist is not None and stop_dist is not None) else None,
                    'stop_px': stop_px, 'stop_dist': stop_dist,
                    'tp_px': tp_px, 'tp_dist': tp_dist,
                    'pk': round(m.get('best', 0), 3) if m else None,
                    'tr': round(m.get('worst', 0), 3) if m else None,
                    'reason': (rcur or {}).get('reason'),
                    'rpub': (rcur or {}).get('pub'), 'rtag': _tag,
                    'rproof': _pf})
    out['pos'] = pos
    # total = exchange truth (wealth-live totalUsd). upl_delta mark-source
    # reconciliation removed 2026-11-16 — it double-counted mark drift and
    # inflated the displayed book vs the actual Bitget balance.

    try:
        if os.path.getmtime('/opt/sentinel/state/klines-15m.json') != C.get('kl_mt'):
            C['kl'] = json.load(open('/opt/sentinel/state/klines-15m.json'))
            C['kl_mt'] = os.path.getmtime('/opt/sentinel/state/klines-15m.json')
    except Exception:
        pass
    try:
        if time.time() - C['dm_at'] > 5:
            C['dm'] = json.load(open('/opt/sentinel/state/dm-status.json'))
            C['dm_at'] = time.time()
        out['dm'] = C['dm']
        out['dm_age_s'] = round(time.time() - os.path.getmtime('/opt/sentinel/state/dm-status.json'))
    except Exception:
        pass

    try:
        if time.time() - C['log_at'] > 5:
            lines = tail('/opt/sentinel/state/deploy-manager.log', 700)
            C['dm_log'] = lines[-3:]
            C['log_at'] = time.time()
            arms = []
            gone = set()
            for l in reversed(lines[-400:]):
                if 'ARM-EXPIRED' in l or ' FILLED' in l or 'refused:' in l:
                    for tok in l.replace('—', ' ').split():
                        if tok.endswith('USDT'):
                            gone.add(tok)
                    continue
                if ' ARMED ' in l:
                    try:
                        seg = l.split('ARMED ')[1]
                        parts = seg.split()
                        asym, adir = parts[0], parts[1]
                        alev = float(parts[3])
                        if asym not in gone:
                            arms.append({'sym': asym, 'dir': adir, 'level': alev})
                        if len(arms) >= 4: break
                    except Exception:
                        pass
            C['arms'] = arms
            for l in reversed(lines[-200:]):
                if 'breadth' in l:
                    import re
                    m = re.search(r'breadth up=(\d+)% dn=(\d+)%', l)
                    if m:
                        C['breadth'] = {'up': int(m.group(1)), 'dn': int(m.group(2))}
                    break
        out['dm_log'] = C['dm_log']
        out['breadth'] = C.get('breadth')
        arm_out = []
        for a in (C.get('arms') or []):
            mk = mm.get(a['sym']) or tick(a['sym'])
            dist = None
            if mk and a['level']:
                dist = round((mk - a['level']) / a['level'] * 100, 3)
            arm_out.append({'sym': a['sym'], 'dir': a['dir'], 'level': a['level'], 'mark': mk, 'dist': dist})
        out['arms'] = arm_out
    except Exception:
        pass

    try:
        if time.time() - C['trip_at'] > 30:
            lines = tail('/opt/sentinel/state/deploy-trips.jsonl', 50)
            t = json.loads(lines[-1])
            C['last_trip'] = f"{t.get('symbol')} {t.get('side')} best {round(t.get('best',0),2)} worst {round(t.get('worst',0),2)} {t.get('exit')}"
            C['trip_at'] = time.time()
        out['last_trip'] = C['last_trip']
    except Exception:
        pass

    try:
        if time.time() - C['pnl_at'] > 60:
            d = json.load(open('/opt/sentinel/api/autonomous-pnl.json'))
            a = d.get('exchange', {}).get('autonomous', {})
            C['pnl'] = {'fills': a.get('fills'), 'closes': a.get('closes'),
                        'net': a.get('netUsd'), 'fees': a.get('feesUsd')}
            C['pnl_at'] = time.time()
        out['pnl'] = C['pnl']
    except Exception:
        pass

    try:
        if os.path.getmtime('/opt/sentinel/state/deploy-mfe.json') != C.get('mfe_mt'):
            C['mfe'] = json.load(open('/opt/sentinel/state/deploy-mfe.json'))
            C['mfe_mt'] = os.path.getmtime('/opt/sentinel/state/deploy-mfe.json')
        out['mfe'] = C['mfe']
    except Exception:
        pass

    try:
        if time.time() - C.get('pln_at', 0) > 15:
            C['plans2'] = pending_plans([(w.get('k') or '').split(':')[0] for w in (C.get('wpos') or [])])
            C['pln_at'] = time.time()
    except Exception:
        pass

    # ---- per-reason proof: every close-fill attributed to the reason tag that
    # opened the seat (personal stats, not textbook priors) ----
    try:
        if os.path.getmtime('/opt/sentinel/state/trade-reasons.json') != C.get('rsn_mt'):
            C['reasons'] = json.load(open('/opt/sentinel/state/trade-reasons.json'))
            C['rsn_mt'] = os.path.getmtime('/opt/sentinel/state/trade-reasons.json')
    except Exception:
        pass
    try:
        fills_now()
        if C.get('fills_mt') != C.get('proof_mt') or time.time() - C.get('proof_at', 0) > 300:
            fills = C.get('fills') or []
            rb = C.get('reasons') or {}
            def tag_at(sym, ts):
                tag, best = 'untracked', -1
                _rr = rb.get(sym) or []
                if isinstance(_rr, dict): _rr = [_rr]
                for e in [x for x in _rr if isinstance(x, dict)]:
                    ea = e.get('at') or 0
                    if ea <= ts and ea > best:
                        tag, best = e.get('tag') or tag, ea
                return tag
            agg = {}
            for f in fills:
                if f.get('tradeSide') != 'close': continue
                net = float(f.get('profit') or 0) - float(f.get('fee') or 0)
                a = agg.setdefault(tag_at(f.get('symbol'), f.get('ts') or 0), [0, 0, 0.0])
                a[0] += 1; a[2] += net
                if net > 0: a[1] += 1
            C['proof'] = {t: {'n': a[0], 'wr': round(a[1] / a[0] * 100), 'net': round(a[2], 3)}
                          for t, a in agg.items() if a[0]}
            # ---- per-EPISODE stats: reconstruct seat episodes (first open ->
            # size back to flat) per symbol; net = all leg profits - ALL fees
            # incl. opens. Episode tag = reason in force at its final close. ----
            PRIOR = {'clone-mom': 57.5, 'op-cup-handle': 62.5,
                     'b-flag': 64, 'b-pennant': 55, 'b-wedge-up': 58,
                     'b-dtb': 67, 'b-inv-hs': 63, 'b-rect-up': 56,
                     'b-run-up': 50, 'war-bid': 55, 'signal-conflu': 55}
            bysym = {}
            for f in fills:
                bysym.setdefault(f.get('symbol'), []).append(f)
            ep_agg, journal = {}, []
            for s, fs in bysym.items():
                pos_sz, ep = 0.0, None
                for f in sorted(fs, key=lambda x: x.get('ts') or 0):
                    ts = f.get('ts') or 0
                    net = float(f.get('profit') or 0) - float(f.get('fee') or 0)
                    if f.get('tradeSide') == 'open':
                        if ep is None: ep = {'sym': s, 'tag': tag_at(s, ts), 'net': 0.0, 'peak': 0.0, 'dur': 0, 't0': ts, 'legs': 0}
                        ep['net'] += net; ep['legs'] += 1
                        pos_sz += float(f.get('size') or 0)
                        if pos_sz > ep['peak']: ep['peak'] = pos_sz
                    elif f.get('tradeSide') == 'close':
                        if ep is None: ep = {'sym': s, 'tag': 'untracked', 'net': 0.0, 'peak': 0.0, 'dur': 0, 't0': ts, 'legs': 0}
                        ep['net'] += net; ep['legs'] += 1
                        pos_sz -= float(f.get('size') or 0)
                        ep['dur'] = ts - ep['t0']
                        if pos_sz <= max(0.001, ep['peak'] * 0.02):
                            ep_agg.setdefault(ep['tag'], []).append(ep['net'])
                            journal.append({'sym': s, 'tag': ep['tag'], 'end': ts,
                                            'dur_s': round(ep['dur'] / 1000), 'net': round(ep['net'], 4),
                                            'legs': ep['legs']})
                            ep, pos_sz = None, 0.0
            def wilson(w, n):
                if not n: return None
                p, z = w / n, 1.96
                return round((p + z * z / 2 / n - z * (p * (1 - p) / n + z * z / 4 / n / n) ** 0.5) / (1 + z * z / n) * 100)
            for t in ep_agg:
                nets = ep_agg[t]
                wins = [n for n in nets if n > 0]; losses = [n for n in nets if n <= 0]
                gW, gL = sum(wins), abs(sum(losses))
                cum, curve = 0.0, []
                for e in [j for j in journal if j['tag'] == t]:
                    cum += e['net']; curve.append([e['end'], round(cum, 3)])
                ep_agg[t] = {'ep': len(nets), 'wr': round(len(wins) / len(nets) * 100),
                             'wlb': wilson(len(wins), len(nets)),
                             'pf': round(gW / gL, 2) if gL else (round(gW, 2) if gW else None),
                             'exp': round(sum(nets) / len(nets), 3),
                             'aw': round(sum(wins) / len(wins), 3) if wins else None,
                             'al': round(sum(losses) / len(losses), 3) if losses else None,
                             'net': round(sum(nets), 3), 'prior': PRIOR.get(t),
                             'd': (round(len(wins) / len(nets) * 100 - PRIOR[t], 1) if PRIOR.get(t) else None),
                             'curve': curve[-40:]}
            C['tags'] = ep_agg
            C['eps'] = sorted(journal, key=lambda x: -x['end'])[:60]
            C['proof_mt'] = C.get('fills_mt')
            C['proof_at'] = time.time()
        out['proof'] = C.get('proof'); out['tags'] = C.get('tags'); out['eps'] = C.get('eps')
    except Exception:
        pass

    # ---- v2: reasoning + charts ----
    import re as _re
    try:
        if time.time() - C.get('reason_at', 0) > 8:
            # MOMENTUM BOARD: the lane's own live universe (cryptobubbles feed),
            # not the dead deploy-manager log. day% = what clone-mom screens on.
            try:
                bub = json.load(open('/opt/sentinel/state/cryptobubbles.json'))
                arr = [{'sym': s, 'day': round(+b.get('day') or 0, 1), 'vol': +b.get('vol') or 0}
                       for s, b in (bub.get('bySym') or {}).items() if s.endswith('USDT')]
                arr.sort(key=lambda x: -x['vol'])
                C['cands'] = [{'sym': c['sym'], 'mom5': c['day'],
                               'note': f"day{c['day']:+}% vol${c['vol']/1e6:.0f}M"} for c in arr if c['day'] > 2][:14]
            except Exception:
                pass
            # EVENTS: operator-clone's live journal (the only engine still
            # reasoning out loud); deploy-manager has been dead since Nov 19.
            try:
                import subprocess
                if time.time() - C.get('evj_at', 0) > 30:
                    r = subprocess.run(['journalctl', '-u', 'sentinel-operator-clone',
                                        '-n', '10', '--no-pager', '-o', 'cat'],
                                       capture_output=True, text=True, timeout=4)
                    C['events'] = [l for l in r.stdout.strip().split('\n') if l][-10:]
                    C['evj_at'] = time.time()
            except Exception:
                pass
            try:
                v = json.load(open('/opt/sentinel/state/wealth-vault.json'))
                vf = '/opt/sentinel/state/wealth-vault.json'
                C['vault'] = {'bal': v.get('balanceUsd'), 'hwm': v.get('hwmUsd'),
                              'sweeps': len(v.get('sweeps') or []),
                              'stale_s': round(time.time() - os.path.getmtime(vf)),
                              'spotUsd': C.get('spotUsd')}
            except Exception:
                C['vault'] = None
            C['reason_at'] = time.time()
        out['cands'] = C.get('cands'); out['events'] = C.get('events'); out['vault'] = C.get('vault')
    except Exception:
        pass

    try:
        if out.get('total') is not None:
            hf = '/home/ubuntu/eq-hist.jsonl'
            if time.time() - C.get('hist_last', 0) > 60:
                with open(hf, 'a') as f:
                    f.write(json.dumps({'t': int(time.time()), 'v': out['total']}) + '\n')
                C['hist_last'] = time.time()
            if time.time() - C.get('hist_read', 0) > 30:
                try:
                    C['hist'] = [[int(json.loads(r)['t']), json.loads(r)['v']] for r in tail(hf, 500) if r]
                except Exception:
                    C['hist'] = []
                C['hist_read'] = time.time()
        out['hist'] = C.get('hist') or []
    except Exception:
        pass

    try:
        fills_now()
        if C.get('fills_mt') != C.get('pnl24_mt') or time.time() - C.get('pnl24_at', 0) > 300:
            fills = C.get('fills') or []
            now = time.time() * 1000
            agg = {}
            for f in fills:
                if (now - (f.get('ts') or 0)) < 86400e3 and f.get('tradeSide') == 'close':
                    s = f.get('symbol') or '?'
                    agg[s] = agg.get(s, 0) + (float(f.get('profit') or 0) - float(f.get('fee') or 0))
            C['pnl24'] = sorted(agg.items(), key=lambda x: -abs(x[1]))[:10]
            C['pnl24_mt'] = C.get('fills_mt')
            C['pnl24_at'] = time.time()
        out['pnl24'] = C.get('pnl24') or []
    except Exception:
        pass

    r = aud_rate()
    out['ts'] = int(time.time())
    out['rate'] = r
    if out.get('total') is not None: out['total_aud'] = round(out['total'] * r, 2)
    if out.get('avail') is not None: out['avail_aud'] = round(out['avail'] * r, 2)
    for p in out.get('pos', []):
        if p.get('upl') is not None: p['upl_aud'] = round(p['upl'] * r, 3)
        if p.get('margin') is not None: p['margin_aud'] = round(p['margin'] * r, 3)
    if out.get('pnl'):
        for k in ('net', 'fees'):
            if out['pnl'].get(k) is not None: out['pnl'][k + '_aud'] = round(out['pnl'][k] * r, 2)

    # merge powerhouse layers: SMC per-seat, integrity, plumbing health
    try:
        _smc = json.load(open("/opt/sentinel/state/smc-live.json"))
        if _smc.get("smc"):
            out["smc"] = _smc["smc"]
            for p in (out.get("pos") or []):
                s = _smc["smc"].get(str(p.get("sym","")).replace("USDT",""))
                if s: p["smc"] = {"score": s["score"], "notes": s["notes"][:3]}
    except Exception: pass
    try:
        _ig = json.load(open("/opt/sentinel/api/integrity.json"))
        out["integrity"] = {"ok": _ig.get("corrupt", 1) == 0, "checked": _ig.get("checked"), "corrupt": _ig.get("corrupt"), "age": int(time.time() - _ig.get("ts", 0)/1000)}
    except Exception: pass
    try:
        _pb = json.load(open("/opt/sentinel/api/plumbing.json"))
        edges = _pb.get("edges") or _pb.get("checks") or []
        okc = sum(1 for e in edges if e.get("ok") or e.get("healthy"))
        out["plumbing"] = {"ok": okc, "total": len(edges), "age": int(time.time() - _pb.get("ts", 0)/1000)}
    except Exception: pass

    line = json.dumps(out)
    print(line, flush=True)
    try:
        tmp = '/opt/sentinel/state/.status.json.tmp'
        with open(tmp, 'w') as f:
            f.write(line)
        os.replace(tmp, '/opt/sentinel/state/status.json')
    except Exception:
        pass
    time.sleep(1)
