#!/usr/bin/env python3
"""Watch real-fills.json for new open fills; drop Will a tg-outbox line on each."""
import json, os, sys, time

FILLS = "/opt/sentinel/state/real-fills.json"
OUTBOX = "/opt/sentinel/state/tg-outbox.jsonl"
SEEN = "/opt/sentinel/state/fill-notify-seen.txt"
POS = "/opt/sentinel/state/fill-notify-pos.txt"


def load_fills():
    try:
        data = json.load(open(FILLS))
    except Exception:
        return []
    return data.get("fills", data if isinstance(data, list) else [])


def load_seen():
    if not os.path.exists(SEEN):
        return set()
    return {l.strip() for l in open(SEEN) if l.strip()}


def main():
    # Baseline: mark all current open-fill ids as seen so we only notify NEW ones.
    fills = load_fills()
    pos = 0
    if os.path.exists(POS):
        try:
            pos = int(open(POS).read().strip() or 0)
        except Exception:
            pos = 0
    if pos == 0:
        seen = load_seen()
        for f in fills:
            if f.get("tradeSide") == "open":
                tid = f.get("tradeId") or f.get("orderId")
                if tid:
                    seen.add(str(tid))
        with open(SEEN, "w") as sf:
            sf.write("\n".join(sorted(seen)) + "\n")
        pos = len(fills)
        with open(POS, "w") as pf:
            pf.write(str(pos))

    while True:
        time.sleep(15)
        try:
            fills = load_fills()
            seen = load_seen()
            new = [f for f in fills
                   if f.get("tradeSide") == "open"
                   and str(f.get("tradeId") or f.get("orderId")) not in seen]
            if not new:
                continue
            with open(SEEN, "a") as sf:
                for f in new:
                    sf.write(str(f.get("tradeId") or f.get("orderId")) + "\n")
            with open(OUTBOX, "a") as ob:
                for f in new:
                    txt = ("NEW LIVE FILL: {sym} {side} {sz} @ {px} "
                           "(notional ${no:.2f}, fee ${fee:.4f})").format(
                        sym=f.get("symbol"), side=f.get("side"),
                        sz=f.get("size"), px=f.get("price"),
                        no=f.get("notionalUsd") or 0, fee=f.get("fee") or 0)
                    for _who in ("will", "gabe", "mey"):
                        ob.write(json.dumps({"to": _who, "ts": int(time.time()),
                                         "text": txt}) + "\n")
        except Exception:
            continue


if __name__ == "__main__":
    main()
