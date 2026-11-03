#!/usr/bin/env python3
"""sqn-hunt.py - walk-forward SQN search over Sentinel's graded signals.

Honest by construction:
  * one trade per fresh setup: a signal counts only if the same asset+direction
    had no signal in the previous 24h (76% of raw records are re-emissions)
  * costs: 0.2% round trip (fees + slippage), same as Sentinel's sqn-report
  * search on the IN-SAMPLE period only; every pick is then scored on the
    later OUT-OF-SAMPLE period it was never chosen on
  * luck baseline: the identical search run on shuffled outcomes shows what
    "best SQN" pure chance produces with this many combos
Usage: python3 sqn-hunt.py <sentinel-root> <out.json> [split YYYY-MM-DD]
  sentinel-root = repo clone or /opt/sentinel (reads every api/history/eval-*.json)
  split defaults to the day 55% of the fresh-setup trades fall before it
Re-run weekly: a setup earns real money only while it keeps passing on the
out-of-sample side; longs get funded again the moment they start passing.
"""
import glob, json, math, sys, time
import numpy as np

ROOT, OUT = sys.argv[1], sys.argv[2]
SPLIT_ARG = sys.argv[3] if len(sys.argv) > 3 else None
COST = 0.20
DEDUP_MS = 24 * 3600e3
MIN_N_IS, MIN_DAYS_IS = 30, 4
PERMS = 40

recs = []
for f in sorted(glob.glob(f'{ROOT}/api/history/eval-*.json')):
    recs += json.load(open(f))['records']
recs = [r for r in recs if r.get('complete') and r.get('outcomePct') is not None and r.get('stopPct')]
recs.sort(key=lambda r: r['runTs'])

# ---- one trade per fresh setup
last, eps = {}, []
for r in recs:
    k = (r['asset'], r['direction'])
    if k in last and r['runTs'] - last[k] < DEDUP_MS:
        continue
    last[k] = r['runTs']
    eps.append(r)
N = len(eps)

# ---- features
def vote(c, d):
    want, against = ('bull', 'bear') if d == 'LONG' else ('bear', 'bull')
    return 1 if c.get('dir') == want else -1 if c.get('dir') == against else 0

FKEYS = sorted({c['k'] for r in eps for c in (r.get('confl') or [])})
F = {k: np.zeros(N, dtype=np.int8) for k in FKEYS}
for i, r in enumerate(eps):
    acc = {}
    for c in r.get('confl') or []:
        acc[c['k']] = acc.get(c['k'], 0) + vote(c, r['direction'])
    for k, v in acc.items():
        F[k][i] = (v > 0) - (v < 0)

col = lambda f: np.array([f(r) for r in eps])
strategy = col(lambda r: r['strategy'])
direction = col(lambda r: r['direction'])
trend = col(lambda r: (r.get('mktType') or 'na').split('-')[0])
clsg = col(lambda r: 'crypto' if r.get('cls') == 'crypto' else 'tradfi')
score = col(lambda r: r.get('score') or 0).astype(float)
rsi = col(lambda r: r.get('rsi') if r.get('rsi') is not None else 50).astype(float)
volr = col(lambda r: r.get('volRatio') if r.get('volRatio') is not None else 1).astype(float)
rank = col(lambda r: r.get('boardRank') or 99).astype(float)
ts = col(lambda r: r['runTs']).astype(float)
day = (ts // 86400e3).astype(int)
day -= day.min()
if SPLIT_ARG:
    SPLIT = time.mktime(time.strptime(SPLIT_ARG, '%Y-%m-%d')) * 1000 - time.timezone * 1000
else:
    SPLIT = (np.quantile(ts, 0.55) // 86400e3 + 1) * 86400e3
IS, OOS = ts < SPLIT, ts >= SPLIT

def ret(f):
    return np.array([f(r) for r in eps], dtype=float)
RET = {
    'own TP/SL (R)': ret(lambda r: (r['outcomePct'] - COST) / r['stopPct']),
    'hold 1h (%)': ret(lambda r: (r['fwd1h'] - COST) if r.get('fwd1h') is not None else np.nan),
    'hold 4h (%)': ret(lambda r: (r['fwd4h'] - COST) if r.get('fwd4h') is not None else np.nan),
    'hold 24h (%)': ret(lambda r: (r['fwd24h'] - COST) if r.get('fwd24h') is not None else np.nan),
}

# ---- candidate space: base cells x at most one extra filter
STRATS = ['ANY'] + sorted({s for s in strategy[IS]})
base_dims = []
for s in STRATS:
    ms = np.ones(N, bool) if s == 'ANY' else strategy == s
    for d in ('ANY', 'LONG', 'SHORT'):
        md = ms & (np.ones(N, bool) if d == 'ANY' else direction == d)
        for t in ('ANY', 'side', 'bull', 'bear'):
            mt = md & (np.ones(N, bool) if t == 'ANY' else trend == t)
            for cg in ('ANY', 'crypto', 'tradfi'):
                mc = mt & (np.ones(N, bool) if cg == 'ANY' else clsg == cg)
                for sc in ('ANY', '>=60', '>=70', '>=80', '>=90', '<70'):
                    m = mc & (np.ones(N, bool) if sc == 'ANY' else
                              (score >= int(sc[2:])) if sc.startswith('>=') else (score < 70))
                    if (m & IS).sum() >= MIN_N_IS:
                        base_dims.append(((s, d, t, cg, sc), m))
extra = [('none', np.ones(N, bool))]
for k in FKEYS:
    if (F[k] != 0).sum() >= 50:
        extra += [(f'{k} agrees', F[k] == 1), (f'{k} disagrees', F[k] == -1)]
extra += [('RSI<35', rsi < 35), ('RSI>65', rsi > 65), ('vol>=1.5x', volr >= 1.5),
          ('vol<1x', volr < 1), ('board rank 1-3', rank <= 3)]

cands = []
for (desc, mb) in base_dims:
    for (ename, me) in extra:
        m = mb & me
        if (m & IS).sum() >= MIN_N_IS:
            cands.append((desc + (ename,), m))
M = np.array([c[1] for c in cands])          # candidates x episodes
print(f'{len(recs)} graded signals -> {N} fresh-setup trades '
      f'(in-sample {IS.sum()}, out-of-sample {OOS.sum()}); {len(cands)} combos x {len(RET)} exits '
      f'= {len(cands) * len(RET)} tested', file=sys.stderr)

ND = day.max() + 1
def stats(mask_rows, r, period):
    """vectorised per-candidate n / mean / sd / SQN100 / distinct days / day-clustered t"""
    ok = ~np.isnan(r) & period
    rr = np.where(ok, r, 0.0)
    W = mask_rows & ok
    n = W.sum(1).astype(float)
    s1 = W @ rr
    s2 = W @ (rr * rr)
    mean = np.divide(s1, n, out=np.zeros_like(s1), where=n > 0)
    var = np.divide(s2 - n * mean ** 2, n - 1, out=np.zeros_like(s1), where=n > 1)
    sd = np.sqrt(np.maximum(var, 1e-12))
    sqn = np.sqrt(np.minimum(n, 100)) * mean / sd
    D = np.zeros((N, ND)); D[np.arange(N), day] = 1
    cnt = W @ D
    days = (cnt > 0).sum(1)
    dsum = (W * rr) @ D
    dmean = np.divide(dsum, cnt, out=np.zeros_like(dsum), where=cnt > 0)
    has = cnt > 0
    dm = np.divide((dmean * has).sum(1), days, out=np.zeros(len(n)), where=days > 0)
    dvar = np.divide(((dmean - dm[:, None]) ** 2 * has).sum(1), days - 1, out=np.zeros(len(n)), where=days > 1)
    tday = np.divide(dm, np.sqrt(np.maximum(dvar, 1e-12) / np.maximum(days, 1)), out=np.zeros(len(n)), where=days > 1)
    return n, mean, sqn, days, tday

rng = np.random.default_rng(7)
results, null_max = [], {}
for ename, r in RET.items():
    n_i, mu_i, sqn_i, d_i, t_i = stats(M, r, IS)
    n_o, mu_o, sqn_o, d_o, t_o = stats(M, r, OOS)
    valid = (n_i >= MIN_N_IS) & (d_i >= MIN_DAYS_IS)
    for j in np.where(valid)[0]:
        results.append({'exit': ename, 'cell': cands[j][0], 'is': [int(n_i[j]), round(mu_i[j], 3), round(sqn_i[j], 2), int(d_i[j]), round(t_i[j], 2)],
                        'oos': [int(n_o[j]), round(mu_o[j], 3), round(sqn_o[j], 2), int(d_o[j]), round(t_o[j], 2)],
                        'key': hash(M[j].tobytes())})
    # luck baseline: same search, outcomes shuffled within the in-sample period
    mx = []
    isidx = np.where(IS & ~np.isnan(r))[0]
    for _ in range(PERMS):
        rp = r.copy(); rp[isidx] = rng.permutation(r[isidx])
        n_p, _, sqn_p, d_p, _ = stats(M, rp, IS)
        ok = (n_p >= MIN_N_IS) & (d_p >= MIN_DAYS_IS)
        mx.append(float(sqn_p[ok].max()) if ok.any() else 0.0)
    null_max[ename] = {'median': round(float(np.median(mx)), 2), 'p95': round(float(np.percentile(mx, 95)), 2)}

# collapse identical trade sets (same mask + exit), keep the shortest description
best = {}
for x in results:
    k = (x['exit'], x['key'])
    simp = sum(1 for v in x['cell'] if v not in ('ANY', 'none'))
    if k not in best or simp < best[k][0]:
        best[k] = (simp, x)
uniq = [v[1] for v in best.values()]
for x in uniq: x.pop('key', None)
uniq.sort(key=lambda x: -x['is'][2])

# strategy-level baselines (no filters), both periods
base = []
for s in STRATS:
    for d in ('LONG', 'SHORT'):
        m = (strategy == s if s != 'ANY' else np.ones(N, bool)) & (direction == d)
        if m.sum() < 10: continue
        row = {'strategy': s, 'dir': d}
        for ename in ('own TP/SL (R)', 'hold 4h (%)'):
            a = stats(m[None, :], RET[ename], IS); b = stats(m[None, :], RET[ename], OOS)
            row[ename] = {'is': [int(a[0][0]), round(a[1][0], 3), round(a[2][0], 2)], 'oos': [int(b[0][0]), round(b[1][0], 3), round(b[2][0], 2)]}
        base.append(row)

json.dump({'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'signals': len(recs), 'trades': N,
           'inSample': int(IS.sum()), 'outOfSample': int(OOS.sum()),
           'split': time.strftime('%Y-%m-%d', time.gmtime(SPLIT / 1000)), 'costPct': COST,
           'combosTested': len(cands) * len(RET), 'nullMaxSqnIS': null_max, 'baselines': base,
           'ranked': uniq}, open(OUT, 'w'), indent=1)
print('ok', file=sys.stderr)
