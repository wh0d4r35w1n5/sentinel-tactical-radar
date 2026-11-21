#!/bin/bash
# Watches real-fills.json for new open fills; drops Will a tg message on each.
FILLS=/opt/sentinel/state/real-fills.json
OUTBOX=/opt/sentinel/state/tg-outbox.jsonl
SEEN=/opt/sentinel/state/fill-notify-seen.txt
touch ""
while true; do
  python3 - "" "" "" <<'PYEOF
import json, sys, time, os
fills_path, seen_path, outbox = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(open(fills_path))
    fills = data.get("fills", data if isinstance(data, list) else [])
except Exception:
    sys.exit(0)
seen = set()
if os.path.exists(seen_path):
    seen = set(l.strip() for l in open(seen_path) if l.strip())
new = []
for f in fills:
    if f.get("tradeSide") != "open":
        continue
    tid = f.get("tradeId") or f.get("orderId")
    if not tid or tid in seen:
        continue
    seen.add(tid); new.append(f)
if new:
    with open(seen_path, "a") as sf:
        for f in new:
            sf.write(str(f.get("tradeId") or f.get("orderId")) + "\n")
    with open(outbox, "a") as ob:
        for f in new:
            txt = ("NEW LIVE FILL: {sym} {side} {sz} @ {px} "
                   "(notional , fee , ts {ts})").format(
                sym=f.get("symbol"), side=f.get("side"), sz=f.get("size"),
                px=f.get("price"), no=f.get("notionalUsd") or 0,
                fee=f.get("fee") or 0, ts=f.get("ts"))
            ob.write(json.dumps({"to":"will","ts":int(time.time()),"text":txt})+"\n")
    print("notified", len(new))
PYEOF
  sleep 15
done
EOF
chmod +x /opt/sentinel/scripts/fill-notify-will.sh
