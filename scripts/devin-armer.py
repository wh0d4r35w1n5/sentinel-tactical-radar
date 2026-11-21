#!/usr/bin/env python3
# devin-armer - keeps market-mode sentinel-structure LONG seats armed on 24h
# movers trading near their high, above session VWAP, with positive 5-bar
# momentum (operator order 2026-11-18: fill the seats, never sit flat).
# The executor stays the authority: every seat still passes longs-only, the
# allowlist, probe-cell evidence (half risk), geometry, net-RR, heat cap and
# LOSS_HALT, and gets an exchange-side SL + TP ladder on fill.
# cmd-setups.json has several read-modify-write authors, so each new seat is
# re-inserted until the executor resolves it (lost-update guard).
import json, os, time, urllib.request

P = '/opt/sentinel/state/cmd-setups.json'
CAT = '/opt/sentinel/api/exec-catalog.json'
WEALTH = '/opt/sentinel/api/wealth-live.json'
MAX_NEW = int(os.environ.get('ARMER_MAX_NEW', '3'))
MAX_OPEN = int(os.environ.get('ARMER_MAX_OPEN', '4'))
INTERVAL = int(os.environ.get('ARMER_INTERVAL_S', '60'))
COOLDOWN_MS = int(os.environ.get('ARMER_COOLDOWN_MIN', '20')) * 60000
API = 'https://api.bitget.com/api/v2/mix/market'


def get(url):
    return json.load(urllib.request.urlopen(url, timeout=20))


def load(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save(d):
    tmp = P + '.tmp-armer'
    with open(tmp, 'w') as f:
        json.dump(d, f)
    os.replace(tmp, P)


def cycle():
    w = load(WEALTH, {}) or {}
    held = {str(p.get('k', '')).split(':')[0] for p in w.get('futures', {}).get('positions', [])}
    room = min(MAX_NEW, MAX_OPEN - len(held))
    if room <= 0:
        return f'full ({len(held)} open)'
    d = load(P)
    if not d or 'setups' not in d:
        return 'cmd-setups unreadable'
    now = int(time.time() * 1000)
    busy = set(held)
    for x in d['setups']:
        reason = str(x.get('reason') or '')
        ca = x.get('createdAt') if isinstance(x.get('createdAt'), (int, float)) else 0
        if x.get('status') in ('armed', 'pending', 'triggered') or now - ca < COOLDOWN_MS \
                or reason.startswith(('denied-symbol', 'measured-bleed', 'contract minimum')):
            busy.add(x.get('symbol'))
    cat = load(CAT, {}) or {}
    syms = cat.get('symbols', cat)
    routable = set(syms.keys()) if isinstance(syms, dict) else set(syms or [])
    cands = []
    for t in get(f'{API}/tickers?productType=USDT-FUTURES')['data']:
        try:
            last, hi = float(t['lastPr']), float(t['high24h'])
            vol, ch = float(t['quoteVolume']), float(t['change24h']) * 100
        except Exception:
            continue
        s = t['symbol']
        if vol > 3e6 and ch > 2 and last >= hi * 0.97 and s.isascii() and s not in busy \
                and (not routable or s in routable):
            cands.append((ch, s, last))
    cands.sort(reverse=True)
    mine, notes = [], []
    for ch, s, px in cands[:12]:
        if len(mine) >= room:
            break
        rows = get(f'{API}/candles?symbol={s}&productType=USDT-FUTURES&granularity=15m&limit=100')['data']
        k = sorted(([float(v) for v in r[:6]] for r in rows), key=lambda r: r[0])
        if len(k) < 30:
            continue
        trs = [max(k[i][2] - k[i][3], abs(k[i][2] - k[i - 1][4]), abs(k[i][3] - k[i - 1][4]))
               for i in range(len(k) - 14, len(k))]
        atr = sum(trs) / len(trs)
        vw = sum((r[2] + r[3] + r[4]) / 3 * r[5] for r in k[-96:]) / max(1e-12, sum(r[5] for r in k[-96:]))
        mom5 = (k[-1][4] / k[-6][4] - 1) * 100
        if not (px > vw * 1.002 and mom5 > 0):
            continue
        dist = min(max(3 * atr, px * 0.015), px * 0.06)
        mine.append({'id': f'armer-{s}-{now}', 'symbol': s, 'direction': 'LONG', 'mode': 'market',
                     'entryPx': px, 'slPx': round(px - dist, 10), 'lastPx': px,
                     'tps': [{'px': round(px + 1.5 * dist, 10), 'pct': 55},
                             {'px': round(px + 3 * dist, 10), 'pct': 45}],
                     'riskPct': 10, 'ttlMin': 30, 'strategy': 'sentinel-structure', 'createdAt': now,
                     'note': f'devin-armer: 24h {ch:+.1f}% near high, VWAP {px / vw - 1:+.2%}, '
                             f'mom5 {mom5:+.2f}%, stop {dist / px:.2%} (3xATR15m)',
                     'blockedBy': None, 'status': 'armed', 'auto': True})
        notes.append(f'{s} 24h{ch:+.1f}% vwap{px / vw - 1:+.1%} mom5{mom5:+.1f}% stop{dist / px:.1%}')
    if not mine:
        return f'no qualifier ({len(cands)} near-high movers free, {len(held)} open)'
    resolved, end = {}, time.time() + 45
    while time.time() < end and len(resolved) < len(mine):
        cur = load(P)
        if cur and 'setups' in cur:
            ids = {x.get('id'): x for x in cur['setups']}
            for m in mine:
                x = ids.get(m['id'])
                if x is not None and x.get('status') != 'armed':
                    why = str(x.get('reason') or '')[:70]
                    resolved[m['id']] = f"{m['symbol']}:{x.get('status')}{' ' + why if why else ''}"
            missing = [m for m in mine if m['id'] not in ids and m['id'] not in resolved]
            if missing:
                cur['setups'].extend(dict(m) for m in missing)
                save(cur)
        time.sleep(3)
    return 'armed ' + '; '.join(notes) + ' -> ' + (', '.join(resolved.values()) or 'pending')


while True:
    t0 = time.time()
    try:
        print(time.strftime('%H:%M:%S'), cycle(), flush=True)
    except Exception as e:
        print(time.strftime('%H:%M:%S'), 'error', type(e).__name__, str(e)[:160], flush=True)
    time.sleep(max(5, INTERVAL - (time.time() - t0)))
