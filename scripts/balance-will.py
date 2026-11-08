#!/usr/bin/env python3
"""Balance pinger — event-driven. Every 60s checks futures equity; posts ONLY
when something worth knowing changed: equity move >= 0.5%, position-count
change, epoch-net move >= $0.5, or 60 minutes since the last post.
Routes: mey+vip+control-panel(untagged).

Gabe is on his own rail (operator order 2026-11-05): a fixed 5-minute
cadence, AUD only, three lines — Bot 1, Bot 2, Total.

Returns are TIME-WEIGHTED (TWR): each history row carries a nav index that
chains trading returns only. External flows (Bitget spot-bill deposit /
withdrawal rows) are subtracted from the sample before the return is
chained, so deposits/withdrawals can't print as fake gains/losses.
Internal spot<->futures shuffle is ignored — it never changes combined
equity. Bot 2 external SOL inflows are not yet flow-adjusted.
"""
import base64, hashlib, hmac, json, os, re, time, urllib.request, pathlib

ROOT = pathlib.Path("/opt/sentinel")
WAR = ROOT / "api" / "pimp-war.json"
OUTBOX = ROOT / "state" / "tg-outbox.jsonl"
RATE_URL = "https://open.er-api.com/v6/latest/USD"
MIN_EQ_MOVE_PCT = 0.005      # 0.5% equity change
MIN_NET_MOVE_USD = 0.5       # epoch-net change worth reporting
HEARTBEAT_S = 3600           # silent ceiling — one post/hour even if flat
GABE_EVERY_S = 300           # Gabe: fixed 5-minute cadence
HIST = ROOT / "state" / "balance-hist.json"    # [ts, totalUsd, nav]
FLOWS = ROOT / "state" / "balance-flows.json"  # {cum, seen[], lastTs}
ENV_FILE = ROOT / ".env"
KEEP_S = 8 * 86400           # 8d retention covers the 7d horizon
HORIZONS = (("1h", 3600), ("6h", 6 * 3600), ("12h", 12 * 3600), ("24h", 24 * 3600),
            ("3d", 3 * 86400), ("5d", 5 * 86400), ("7d", 7 * 86400))
rate, rate_at = 1.53, 0.0    # fallback AUD per USD

def env_creds():
    try:
        kv = {}
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                kv[k.strip()] = v.strip().strip('"').strip("'")
        return kv.get("BITGET_API_KEY"), kv.get("BITGET_API_SECRET"), kv.get("BITGET_API_PASSPHRASE")
    except Exception:
        return None, None, None

def bg_get(path_query):
    key, sec, pas = env_creds()
    if not key:
        return None
    ts = str(int(time.time() * 1000))
    sig = base64.b64encode(hmac.new(sec.encode(), (ts + "GET" + path_query).encode(),
                                    hashlib.sha256).digest()).decode()
    req = urllib.request.Request("https://api.bitget.com" + path_query, headers={
        "ACCESS-KEY": key, "ACCESS-SIGN": sig, "ACCESS-TIMESTAMP": ts,
        "ACCESS-PASSPHRASE": pas, "Content-Type": "application/json", "locale": "en-US"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read())
    except Exception:
        return None

def poll_flows(now_ms):
    """Net external money into the tracked pool since the last sample.
    Spot-bill deposit/withdrawal business types are the true external legs;
    internal trans_from_exchange-style legs cancel across the combined
    equity and are deliberately ignored."""
    st = {"cum": 0.0, "seen": [], "lastTs": now_ms - 3600_000}
    try:
        st.update(json.loads(FLOWS.read_text()))
    except Exception:
        pass
    start = int(st.get("lastTs") or (now_ms - 3600_000))
    seen = set(st.get("seen") or [])
    delta = 0.0
    d = bg_get(f"/api/v2/spot/account/bills?startTime={start}&endTime={now_ms}&limit=100")
    for b in ((d or {}).get("data") or []):
        bid = str(b.get("billId") or b.get("id") or "")
        bt = str(b.get("businessType") or b.get("type") or "")
        if bid in seen or not re.search(r"deposit|withdraw", bt, re.I):
            continue
        try:
            delta += float(b.get("amount") or 0)
            seen.add(bid)
        except Exception:
            pass
    st.update(cum=round(float(st.get("cum", 0)) + delta, 6),
              seen=list(seen)[-300:], lastTs=now_ms)
    try:
        FLOWS.write_text(json.dumps(st))
    except Exception:
        pass
    return delta

def hist_pct(total_usd):
    """TWR card: rows are [ts, totalUsd, nav]. nav chains trading returns
    only — external flows are stripped from each sample before the link:
        nav_t = nav_prev * (E_t - flow_t) / E_prev
    so the index is deposit-proof in both directions. Legacy 2-col rows
    carry nav=equity (their window returns degrade to raw %, still honest
    where no flows intervened)."""
    now = time.time()
    try:
        h = json.loads(HIST.read_text()) if HIST.exists() else []
    except Exception:
        h = []
    flow = poll_flows(int(now * 1000))
    prev = h[-1] if h else None
    prev_eq = float(prev[1]) if prev else total_usd
    prev_nav = (float(prev[2]) if prev and len(prev) > 2 and prev[2]
                else (prev_eq if prev else total_usd))
    nav = prev_nav * (max(total_usd - flow, 0.0) / prev_eq) if prev_eq > 0 else prev_nav
    h.append([now, total_usd, round(nav, 8)])
    h = [s for s in h if s[0] >= now - KEEP_S and len(s) >= 2 and s[1] > 0]
    try:
        HIST.write_text(json.dumps(h))
    except Exception:
        pass
    out = []
    for label, secs in HORIZONS:
        past = [s for s in h if s[0] <= now - secs + 900]
        if not past:
            continue
        base = past[-1]
        bnav = float(base[2]) if len(base) > 2 and base[2] else float(base[1])
        if bnav > 0:
            out.append(f"{label} {(nav - bnav) / bnav * 100:+.1f}%")
    return " | ".join(out)

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

        # simple rail — Gabe + Mey + Will Evans + control panel: fixed
        # cadence, AUD only
        if now - gabe_last >= GABE_EVERY_S:
            pct = hist_pct(eq + bot2)
            msg = (f"Bot 1: A${eq * aud:.2f}\n"
                   f"Bot 2: A${bot2 * aud:.2f}\n"
                   f"Total: A${(eq + bot2) * aud:.2f}{wl_note}"
                   + (f"\n{pct}" if pct else ""))
            with open(OUTBOX, "a") as f:
                for who in ("gabe", "mey", "will"):
                    f.write(json.dumps({"to": who, "text": msg}) + chr(10))
                f.write(json.dumps({"text": msg}) + chr(10))   # untagged -> control panel
            gabe_last = now

        fire = (
            last is None
            or abs(eq + bot2 - last[0]) >= max(0.25, abs(last[0]) * MIN_EQ_MOVE_PCT)
            or abs(bot2 - last[4]) >= 0.5
            or npos != last[2]
            or abs(net - last[1]) >= MIN_NET_MOVE_USD
            or now - last[3] >= HEARTBEAT_S
        )
        if fire:
            msg = (f"Sentinel: A${(eq+bot2)*aud:.2f} (US${eq+bot2:.2f}) | "
                   f"B1 A${eq*aud:.2f} · B2 A${bot2*aud:.2f} | "
                   f"free A${free*aud:.2f} | epoch net US${net:+.2f} | {npos} open")
            with open(OUTBOX, "a") as f:
                f.write(json.dumps({"text": msg}) + "\n")   # untagged -> control panel
            last = (eq + bot2, net, npos, now, bot2)
    except Exception as e:
        print(f"[balance-will] {type(e).__name__}: {e}", flush=True)
    time.sleep(60)
