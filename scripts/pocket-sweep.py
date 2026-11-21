#!/usr/bin/env python3
# pocket-sweep — continuous admission sync. Re-mines the mega-episode database
# every cycle: pockets with positive mean net at n>=200 stay/are admitted as
# probation cells; pockets that decayed are marked dead (records kept, orders
# stop). Runs on a 5-min timer — the admitted surface tracks the evidence.
import json, math, os
from collections import defaultdict

STATE = "/opt/sentinel/state"
BASE_CELLS = {"Wyckoff:LONG", "Exhaustion Short:SHORT"}
now_iso = __import__('datetime').datetime.utcnow().isoformat(timespec='seconds') + "Z"

# cheap mode: skip the 40s re-aggregation when episode inputs haven't changed
SRC = ["/opt/sentinel/api/mega-episodes-%s.jsonl" % f for f in ("ladder", "retest", "trail-k2")]
SIG = os.path.join(STATE, "pocket-sweep.sig")
sig = "|".join("%d:%d" % (os.stat(p).st_mtime_ns, os.path.getsize(p)) for p in SRC if os.path.exists(p))
if os.path.exists(SIG) and open(SIG).read() == sig:
    print("pocket-sweep: inputs unchanged — skip")
    raise SystemExit(0)
open(SIG, "w").write(sig)

agg = defaultdict(lambda: [0, 0.0, 0.0])
for f in ["ladder", "retest", "trail-k2"]:
    try:
        src = open("/opt/sentinel/api/mega-episodes-%s.jsonl" % f)
    except Exception:
        continue
    for line in src:
        try:
            e = json.loads(line)
        except Exception:
            continue
        k = (e["s"], e["c"]); a = agg[k]; a[0] += 1; a[1] += e["n"]; a[2] += e["n"] * e["n"]

positive = {}
for (s, c), (n, sm, sq) in agg.items():
    if n < 200:
        continue
    m = sm / n
    sd = math.sqrt(max(0.0, sq / n - m * m))
    sqn = (m / sd * math.sqrt(min(n, 100))) if (n >= 30 and sd > 1e-9 * max(1, abs(m))) else 0  # sqn-guard
    if m <= 0:
        continue
    cell = "%s:%sUSDT" % (c, s)
    lo = m - 1.96 * sd / math.sqrt(n)
    hi = m + 1.96 * sd / math.sqrt(n)
    positive[cell] = {"episodes": n, "netAfterCost": round(m, 4), "sqn": round(sqn, 2), "ci": [round(lo, 4), round(hi, 4)]}

alp = os.path.join(STATE, "live-cell-allowlist.json")
a = json.load(open(alp))
keep = set(a.get("cells", [])) | BASE_CELLS
# drop stale pocket entries not currently positive, keep everything else
keep = {c for c in keep if c in BASE_CELLS or c in positive or ":" not in c or len(c.split(":")) < 3}
keep |= set(positive.keys())
a["cells"] = sorted(keep)
a["at"] = now_iso
json.dump(a, open(alp, "w"), indent=1)

adp = os.path.join(STATE, "cell-admission.json")
ad = json.load(open(adp))
changed = 0
for cell, st in positive.items():
    cur = ad["cells"].get(cell)
    if cur and cur.get("status") in ("live", "probation"):
        cur.update({k: st[k] for k in ("episodes", "netAfterCost", "sqn", "ci")})
        if cur.get("status") == "probation":
            cur["reviewedAt"] = now_iso
    elif not cur or cur.get("status") == "dead":
        ad["cells"][cell] = {"status": "probation", "exitModel": "mega-aggregate",
            "source": "mega-backtest-1m", "reviewedAt": now_iso,
            "note": "pocket-sweep admission — positive mean at n>=200 mega-backtest episodes",
            "forward": {"episodes": 0, "netUsd": 0, "meanPct": None, "ci95": None, "asOf": now_iso}, **st}
        changed += 1
# decayed pockets -> dead (record kept)
for name, c in ad["cells"].items():
    if name in BASE_CELLS or len(name.split(":")) < 3:
        continue
    if name not in positive and c.get("status") == "probation":
        c["status"] = "dead"; c["deadAt"] = now_iso
json.dump(ad, open(adp, "w"), indent=1)
print("pocket-sweep: %d positive pockets, %d new, %d cells total" % (len(positive), changed, len(ad["cells"])))
