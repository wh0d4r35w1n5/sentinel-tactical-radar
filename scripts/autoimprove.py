#!/usr/bin/env python3
"""Sentinel auto-improvement loop — every 180s, run a bounded battery of
profitability checks against LIVE state files only (zero exchange API calls —
this box is loaded; keep the loop featherweight).

Applies only POSITIVE, bounded fixes:
  - measured bleeder -> ensure auto-deny quarantine covers sym:side
  - seat missing protection plans -> ops alert (re-arm is watch's job)
  - stale nonconforming flag file -> ops alert (exec cycle wedged)
  - funding arb below breakeven horizon -> ops candidate alert
  - fee burn share > threshold -> ops alert
  - dead critical service -> restart (>=2 dead rounds, <=1 restart/15min)
  - flagged wind-down seats still open past profit window -> ops alert

NEVER: opens positions, closes losers, loosens rails, touches manual seats,
edits code. Everything journaled to state/autoimprove-log.jsonl.
"""
import json, os, re, subprocess, time, glob

ROOT = "/opt/sentinel"
ST = ROOT + "/state"
API = ROOT + "/api"
LOG = ST + "/autoimprove-log.jsonl"
REST_ST = ST + "/autoimprove-restarts.json"
OUTBOX = ST + "/tg-outbox.jsonl"
SLEEP_S = int(os.environ.get("AUTOIMPROVE_INTERVAL_S", "30"))  # operator: much faster than 3min — file checks are featherweight; heavy probes staggered below
ROUNDS = 0  # staggered-probe counter: subprocess checks (journalctl/systemctl) run every 4th round
DENY_NET_LOSS = -0.25     # trailing-24h per sym:side net threshold
DENY_NET_BIG = -0.50      # single-fill blowout threshold
FEE_BURN_MAX = 0.55       # fees >55% of gross = finding
FUND_BREAKEVEN_H = 24.0   # funding arb candidates under this horizon
STALE_FLAG_S = 300        # nonconforming-seats.json older than this = wedge
SERVICES = [
    "sentinel-live-exec.service",
    "sentinel-bitget-watch-live.service",
    "sentinel-tg-watch.service",
    "sentinel-balance-will.service",
    "sentinel-onchain.service",
    "sentinel-rapid.service",
]

def load(p, d=None):
    try:
        return json.load(open(p))
    except Exception:
        return d

def age_s(path):
    try:
        return time.time() - os.path.getmtime(path)
    except Exception:
        return None

ALERT_LAST = {}  # kind -> last emit ts; sustained conditions alert once per cooldown
ALERT_COOLDOWN_S = 1800

def emit_ops(text, kind=None):
    if kind:
        now = time.time()
        if now - ALERT_LAST.get(kind, 0) < ALERT_COOLDOWN_S:
            return
        ALERT_LAST[kind] = now
    try:
        with open(OUTBOX, "a") as f:
            f.write(json.dumps({"to": "ops", "text": text[:600], "ts": int(time.time())}) + "\n")
    except Exception:
        pass

def svc_state(name):
    try:
        r = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True, timeout=10)
        return r.stdout.strip()
    except Exception:
        return "unknown"

def svc_type(name):
    try:
        r = subprocess.run(["systemctl", "show", name, "-p", "Type", "--value"], capture_output=True, text=True, timeout=10)
        return r.stdout.strip()
    except Exception:
        return ""

def restart_svc(name):
    try:
        subprocess.run(["systemctl", "restart", name], timeout=30)
        return True
    except Exception:
        return False

def round_loop():
    findings, actions, metrics = [], [], {}
    now = time.time()

    # --- 1. measured bleeders -> auto-deny coverage ---
    fills = (load(ST + "/real-fills.json", {}) or {}).get("fills") or []
    closep = {}
    for f in fills:
        if f.get("kind") not in ("close", "partial_close", "sys", "tp-sell", "reduce"):
            continue
        p = f.get("profit")
        if p is None:
            continue
        k = f"{f.get('symbol')}:{f.get('side')}"
        a = closep.setdefault(k, [0.0, 0])
        a[0] += +p; a[1] += 1
    deny = load(ST + "/auto-deny.json", {}) or {}
    # exec reads ad.entries[] — {"symbol","side","until","netUsd","n","at"} —
    # a `deny` list here was a dead letter the order gate never saw.
    deny_list = deny.get("entries") or []
    have = {(d.get("symbol"), d.get("side")) for d in deny_list if isinstance(d, dict)}
    wrote = 0
    for k, (net, n) in closep.items():
        sym, _, side = str(k).partition(":")
        if (sym, side) in have:
            continue
        if (n >= 3 and net <= DENY_NET_LOSS) or net <= DENY_NET_BIG:
            deny_list.append({"symbol": sym, "side": side or "both", "until": int((now + 72 * 3600) * 1000), "netUsd": round(net, 4), "n": n, "at": int(now * 1000), "src": "autoimprove"})
            wrote += 1
    if wrote:
        deny["entries"] = deny_list[-200:]
        try:
            json.dump(deny, open(ST + "/auto-deny.json", "w"))
            actions.append(f"auto-deny += {wrote} measured bleeder(s)")
        except Exception:
            pass
    metrics["bleed_keys"] = len(closep)

    # --- 2. protection liveness: armed plans live on-exchange (not a file).
    # Watch journal emits protection lines per cycle — liveness = coverage.
    ledger = load(API + "/live-ledger.json", {}) or {}
    metrics["seats"] = len(ledger.get("positions", []))
    if ROUNDS % 4 == 0:  # journalctl is subprocess-heavy — every 4th round
        try:
            r = subprocess.run(
                ["journalctl", "-u", "sentinel-bitget-watch-live.service", "--since", "-8min", "--no-pager", "-n", "200"],
                capture_output=True, text=True, timeout=25)
            prot_lines = len(re.findall(r"stop|tp|plan|armed|protect", r.stdout, re.I))
            if prot_lines == 0:
                findings.append("bitget-watch journal silent 8min — protection may be stalled")
                emit_ops("⚠ autoimprove: bitget-watch silent 8min", kind="watch-silent")
        except Exception:
            pass

    # --- 3. stale wind-down flag file (exec cycle wedge detector) ---
    ncf_age = age_s(ST + "/nonconforming-seats.json")
    if ncf_age is not None and ncf_age > STALE_FLAG_S:
        findings.append(f"nonconforming-seats.json stale {int(ncf_age)}s — exec cycle may be wedged")
        emit_ops(f"⚠ autoimprove: exec flag file stale {int(ncf_age)}s", kind="exec-wedge")
    metrics["ncf_age_s"] = ncf_age

    # --- 4. flagged seats still open past profit window ---
    ncf = load(ST + "/nonconforming-seats.json", {}) or {}
    stale_flags = [k for k, v in ncf.items() if (now - (v.get("at", 0) / 1000 if v.get("at", 0) > 1e12 else v.get("at", 0))) > 1800 and k in {f"{p.get('symbol')}:{p.get('side')}" for p in ledger.get("positions", [])}]
    if stale_flags:
        findings.append(f"wind-down seats open >30min without close: {stale_flags}")
    metrics["stale_flags"] = len(stale_flags)

    # --- 5. fee burn share ---
    bills24 = [b for b in fills if (now - (b.get("ts", 0) / 1000 if b.get("ts", 0) > 1e12 else b.get("ts", 0))) < 86400]
    fees = sum(+b.get("fee", 0) or 0 for b in bills24)
    gross = sum(+b.get("profit", 0) or 0 for b in bills24 if (b.get("profit") or 0) > 0)
    if gross > 0.5:
        share = abs(fees) / gross
        metrics["fee_share_24h"] = round(share, 3)
        if share > FEE_BURN_MAX:
            findings.append(f"fee burn {share * 100:.0f}% of gross (24h)")

    # --- 5b. vol-event detector — breadth collapse = dump regime ---
    try:
        with open(ST + "/breadth-history.jsonl") as f:
            bh = json.loads(f.readlines()[-1])
        if (now - (bh.get("ts", 0) / 1000 if bh.get("ts", 0) > 1e12 else bh.get("ts", 0))) < 1800:
            dG, hG = bh.get("dG"), bh.get("hG")
            metrics["breadth_day_green"] = dG
            metrics["breadth_hour_green"] = hG
            if dG is not None and hG is not None and dG <= 0.3 and hG <= 0.3:
                findings.append(f"VOL EVENT — breadth collapsed ({dG * 100:.0f}% green day / {hG * 100:.0f}% green hour): setup-longs braked, mandate stood down")
                emit_ops(f"🌊 vol event: breadth {dG * 100:.0f}%d/{hG * 100:.0f}%h — entries braked", kind="vol-event")
    except Exception:
        pass

    # --- 6. funding arb candidates ---
    fj = load(API + "/funding.json", {}) or {}
    best = (fj.get("best") or [])[:3]
    cands = [b for b in best if isinstance(b, dict) and b.get("breakevenH") and b["breakevenH"] < FUND_BREAKEVEN_H]
    if cands:
        findings.append("funding candidates <24h breakeven: " + ", ".join(f"{b.get('asset')} {b.get('arb')} be={b.get('breakevenH')}h" for b in cands))

    # --- 6b. watcher freshness — nothing watches the watchers ---
    # wealth-live freshness (the money feed), fills journal lag (attribution
    # blindness while seats are open), plan staleness (mandate intel).
    try:
        w = load(API + "/wealth-live.json", {}) or {}
        w_ts = w.get("ts")
        if w_ts:
            w_age = now - __import__("datetime").datetime.fromisoformat(str(w_ts).replace("Z", "+00:00")).timestamp()
            metrics["wealth_age_s"] = round(w_age, 1)
            if w_age > 90:
                findings.append(f"wealth-live stale {int(w_age)}s — balance feed dead")
                emit_ops(f"⚠ autoimprove: wealth-live stale {int(w_age)}s", kind="wealth-stale")
    except Exception:
        pass
    fills_newest = max((+f.get("ts", 0) or 0 for f in fills), default=0) / 1000
    # fills-sync liveness: newest-fill age reads "lag" on quiet tape (file
    # only rewrites when fills land). The exec stamps lastFillSync every
    # cycle regardless — ITS age is the real attribution-blindness probe.
    lfs = ledger.get("lastFillSync") or 0
    fills_lag = (now - lfs / 1000) if lfs else (now - fills_newest)
    metrics["fills_sync_age_s"] = round(fills_lag, 1) if fills_lag else None
    if metrics["seats"] > 0 and fills_lag and fills_lag > 900:
        findings.append(f"fills sync stale {int(fills_lag)}s with seats open — attribution blind")
    plan_age = age_s(API + "/live-plan.json")
    if plan_age is not None and plan_age > 1500:
        findings.append(f"live-plan stale {int(plan_age / 60)}min — scanner tail pending")
    metrics["plan_age_s"] = plan_age

    # --- 7. dead critical services -> bounded restart (every 4th round —
    # systemctl calls are the heaviest probe; staggered on the 30s cadence) ---
    rest = load(REST_ST, {}) or {}
    if ROUNDS % 4 == 0:
        for svc in SERVICES:
            st = svc_state(svc)
            # oneshot units are inactive between timer fires BY DESIGN —
            # counting that as dead and restarting mid-pass kills work
            # (this restart-churn SIGKILLed a running build-scanner and
            # restarted live-exec mid-vol-event 2026-11-08). 'activating' is
            # a live transition state; 'unknown' is an is-active TIMEOUT under
            # load — a timeout is not proof of death, never restart on it.
            if st in ("active", "activating", "unknown") or svc_type(svc) == "oneshot":
                if st == "unknown":
                    findings.append(f"service {svc} state probe timed out (load) — not restarting")
                rest.pop(svc, None)
                continue
            rec = rest.setdefault(svc, {"dead": 0, "lastRestart": 0})
            rec["dead"] += 1
            if rec["dead"] >= 2 and (now - rec["lastRestart"]) > 900:
                ok = restart_svc(svc)
                rec["lastRestart"] = now
                actions.append(f"restart {svc}: {'ok' if ok else 'failed'}")
                emit_ops(f"🔧 autoimprove: restarted dead service {svc}", kind=f"restart-{svc}")
            else:
                findings.append(f"service {svc} state={st} (dead rounds={rec['dead']})")
    try:
        json.dump(rest, open(REST_ST, "w"))
    except Exception:
        pass

    row = {"ts": int(now), "findings": findings, "actions": actions, "metrics": metrics}
    try:
        with open(LOG, "a") as f:
            f.write(json.dumps(row) + "\n")
        # keep log bounded
        lines = open(LOG).readlines()
        if len(lines) > 4000:
            open(LOG, "w").writelines(lines[-3000:])
    except Exception:
        pass
    if findings or actions:
        print(json.dumps(row), flush=True)

def main():
    global ROUNDS
    while True:
        try:
            round_loop()
            ROUNDS += 1
        except Exception as e:
            print("round error:", repr(e)[:200], flush=True)
        time.sleep(SLEEP_S)

if __name__ == "__main__":
    main()
