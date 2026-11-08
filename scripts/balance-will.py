#!/usr/bin/env python3
"""Balance pinger — event-driven. Every 60s checks futures equity; posts ONLY
when something worth knowing changed: equity move >= 0.5%, position-count
change, epoch-net move >= $0.5, or 60 minutes since the last post.
Routes: mey+vip+control-panel(untagged).

Gabe is on his own rail (operator order 2026-11-05): a fixed 5-minute
cadence, AUD only, three lines — Bot 1, Bot 2, Total."""
import json, time, urllib.request, pathlib

ROOT = pathlib.Path("/opt/sentinel")
WAR = ROOT / "api" / "pimp-war.json"
OUTBOX = ROOT / "state" / "tg-outbox.jsonl"
RATE_URL = "https://open.er-api.com/v6/latest/USD"
MIN_EQ_MOVE_PCT = 0.005      # 0.5% equity change
MIN_NET_MOVE_USD = 0.5       # epoch-net change worth reporting
HEARTBEAT_S = 3600           # silent ceiling — one post/hour even if flat
GABE_EVERY_S = 300           # Gabe: fixed 5-minute cadence
rate, rate_at = 1.53, 0.0    # fallback AUD per USD

def get_rate():
    global rate, rate_at
    if time.time() - rate_at < 600:
        return rate
    try:
        with urllib.request.urlopen(RATE_URL, timeout=8) as r:
            d = json.loads(r.read())
        v = float(d["rates"]["AUD"])
        if 1.0 < v < 3.0:
            rate, rate_at = v, time.time()
    except Exception:
        pass
    return rate

last = None       # (eq, net, npos, sent_ts)
gabe_last = 0.0
while True:
    try:
        d = json.loads(WAR.read_text())
        fut = d["wallets"]["futures"]
        onc = d["wallets"].get("onchain") or {}
        eq, free = float(fut["equityUsd"]), float(fut["marginFreeUsd"])
        bot2 = float(onc.get("purseUsd") or 0)
        # Bot1/Bot2 headline figures come from wealth-live.json — exchange
        # equity + REAL wallet balances (spot account + Solana), not the
        # lane's modeled purseUsd. pimp-war futures-only read ~$12 light
        # on Bot 1 and a modeled figure on Bot 2 (fake-scare 2026-11-07).
        wl_note = ""
        try:
            wlf = ROOT / "api" / "wealth-live.json"
            w_age = time.time() - wlf.stat().st_mtime
            w = json.loads(wlf.read_text())
            bot1_usd = float(w["futures"]["equityOwnUsd"]) + float((w.get("spot") or {}).get("totalUsd") or 0)
            bot2_usd = float((w.get("solana") or {}).get("totalUsd") or 0)
            if bot1_usd > 0: eq = bot1_usd
            if bot2_usd > 0: bot2 = bot2_usd
            if w_age > 600:
                wl_note = f"\n⚠ feed {w_age/60:.0f}m stale — verify"
        except Exception:
            wl_note = "\n⚠ wealth-live unread — legacy figures"
        net = float(fut.get("epochNetUsd", 0))
        npos = len(fut.get("positions") or [])
        now = time.time()
        aud = get_rate()

        # simple rail — Gabe + Mey + Will Evans: fixed cadence, AUD only
        if now - gabe_last >= GABE_EVERY_S:
            msg = (f"Bot 1: A${eq * aud:.2f}\n"
                   f"Bot 2: A${bot2 * aud:.2f}\n"
                   f"Total: A${(eq + bot2) * aud:.2f}{wl_note}")
            with open(OUTBOX, "a") as f:
                for who in ("gabe", "mey", "will"):
                    f.write(json.dumps({"to": who, "text": msg}) + chr(10))
            gabe_last = now

        fire = (
            last is None
            or abs(eq - last[0]) >= max(0.25, abs(last[0]) * MIN_EQ_MOVE_PCT)
            or npos != last[2]
            or abs(net - last[1]) >= MIN_NET_MOVE_USD
            or now - last[3] >= HEARTBEAT_S
        )
        if fire:
            msg = (f"Sentinel: A${eq*aud:.2f} (US${eq:.2f}) | "
                   f"free A${free*aud:.2f} | epoch net US${net:+.2f} | {npos} open")
            with open(OUTBOX, "a") as f:
                f.write(json.dumps({"to": "vip", "text": msg}) + "\n")
                f.write(json.dumps({"text": msg}) + "\n")
            last = (eq, net, npos, now)
    except Exception as e:
        print(f"[balance-will] {type(e).__name__}: {e}", flush=True)
    time.sleep(60)
