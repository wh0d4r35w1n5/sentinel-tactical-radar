#!/usr/bin/env python3
"""Sentinel TradingView webhook receiver — VEMA-style alert intake.

Listens on 127.0.0.1:8790 (localhost only — nginx TLS-terminates and
proxies /tv-hook here). Validates a shared secret, timestamp freshness,
and alert-ID idempotency, then normalizes the alert into the operator
setup schema and appends it to state/cmd-setups.json — the SAME queue
the /setup telegram command writes, so webhook setups ride every
executor safety rail identically.

TradingView alert message template (paste into the alert body):
  {"key":"<SECRET>","symbol":"{{ticker}}","direction":"long",
   "mode":"br","entry":{{close}},"break":{{high}},"sl":90.0,
   "tps":[[95,50],[99,50]],"risk":1,"ttl":720,"note":"{{strategy.order.comment}}",
   "id":"{{strategy.order.id}}-{{time}}","ts":{{timenow}}}

Fields:
  key        shared secret — REQUIRED, must equal state/tv-hook.json.secret
  symbol     e.g. SOLUSDT / SOLUSDT.P (suffix normalized)
  direction  long|short|buy|sell  (or "side")
  mode       market|bounce|br    (default market)
  entry      entry px (bounce/br; market ignores)
  break      break level px (br only) — key "brk" also accepted
  sl         stop-loss px — REQUIRED
  tps        [[px,pct],…] — pct optional (splits remainder), sum <=100
  risk       % of equity risked on stop-out (default 1, clamp 0.05–10)
  ttl        minutes the setup stays armed (default 720, clamp 5–10080)
  note       free text → journal
  strategy   attribution label (default "tv-webhook")
  id         idempotency key — REQUIRED (a replayed alert can't refire)
  ts         alert epoch ms/sec — must be within ±10min (replay guard)
"""
import json
import os
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state"
SETUPS = STATE / "cmd-setups.json"
SECRET_FILE = STATE / "tv-hook.json"
MAX_BODY = 8192
TS_TOLERANCE_MS = 10 * 60 * 1000
MAX_LIVE_SETUPS = 20          # armed/triggered in flight — beyond this, refuse
WRITE_LOCK = threading.Lock()

TERMINAL = ("filled", "cancelled", "expired", "failed", "rejected", "missed")


def _secret():
    try:
        return json.loads(SECRET_FILE.read_text()).get("secret") or ""
    except Exception:
        return ""


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _sid():
    return "TV-" + format(int(time.time() * 1000), "x")[-5:] + format(int(time.time_ns() % 0xffff), "04x")


def _num(x):
    try:
        v = float(x)
        return v if v == v else None  # NaN check
    except (TypeError, ValueError):
        return None


def normalize(body):
    """Dict -> validated setup spec, or raises ValueError(reason)."""
    if not isinstance(body, dict):
        raise ValueError("payload must be a JSON object")
    if not body.get("key") or body.get("key") != _secret():
        raise PermissionError("bad webhook key")
    aid = str(body.get("id") or "").strip()
    if not aid:
        raise ValueError("id required — idempotent alert key")
    ts = _num(body.get("ts"))
    if ts is not None:
        if ts < 1e11:  # epoch seconds → ms (ms now ≈1.7e12; s ≈1.7e9)
            ts *= 1000
        if abs(time.time() * 1000 - ts) > TS_TOLERANCE_MS:
            raise ValueError("stale alert (ts outside ±10min)")
    sym = str(body.get("symbol") or body.get("ticker") or "").upper().strip()
    sym = sym.replace(".P", "").replace("PERP", "")
    if not sym.endswith("USDT"):
        sym += "USDT"
    if not (3 <= len(sym) <= 24):
        raise ValueError(f"bad symbol '{sym}'")
    d = str(body.get("direction") or body.get("side") or "").lower()
    direction = "LONG" if d in ("long", "l", "buy") else "SHORT" if d in ("short", "s", "sell") else None
    if not direction:
        raise ValueError("direction must be long|short")
    mode = str(body.get("mode") or "market").lower()
    if mode not in ("market", "bounce", "br"):
        mode = "market"
    entry = _num(body.get("entry") or body.get("entryPx"))
    brk = _num(body.get("break") or body.get("breakPx") or body.get("brk"))
    sl = _num(body.get("sl") or body.get("stop") or body.get("slPx"))
    if sl is None or sl <= 0:
        raise ValueError("sl required and >0")
    if mode in ("bounce", "br") and not (entry and entry > 0):
        raise ValueError(f"{mode} requires entry>0")
    if mode == "br" and not (brk and brk > 0):
        raise ValueError("br requires break>0")
    tps = []
    for t in (body.get("tps") or body.get("tp") or []):
        if isinstance(t, (list, tuple)) and len(t) >= 1:
            px, pct = _num(t[0]), _num(t[1]) if len(t) > 1 else None
        elif isinstance(t, dict):
            px, pct = _num(t.get("px") or t.get("price")), _num(t.get("pct"))
        else:
            px, pct = _num(t), None
        if px and px > 0:
            tps.append([px, pct])
    if not tps:
        raise ValueError("at least one tp required")
    allocated = sum(p or 0 for _, p in tps)
    if allocated > 100.01:
        raise ValueError("tp pct sum >100")
    unalloc = max(0.0, 100.0 - allocated)
    nofrac = [t for t in tps if t[1] is None]
    for t in nofrac:
        t[1] = round(unalloc / len(nofrac), 2)
    # side sanity vs declared reference (executor re-validates vs live mark)
    ref = entry
    sgn = 1 if direction == "LONG" else -1
    if ref:
        if sgn > 0 and sl >= ref:
            raise ValueError("long sl must be below entry")
        if sgn < 0 and sl <= ref:
            raise ValueError("short sl must be above entry")
        if mode == "br":
            if sgn > 0 and brk <= ref:
                raise ValueError("long break must be above entry")
            if sgn < 0 and brk >= ref:
                raise ValueError("short break must be below entry")
        for px, _ in tps:
            if sgn > 0 and px <= ref:
                raise ValueError(f"tp {px} must be above entry")
            if sgn < 0 and px >= ref:
                raise ValueError(f"tp {px} must be below entry")
    risk = _num(body.get("risk"))
    risk = min(max(risk if risk else 1.0, 0.05), 10.0)
    ttl = _num(body.get("ttl"))
    ttl = min(max(ttl if ttl else 720, 5), 10080)
    return {
        "id": str(body.get("setupId") or _sid()),
        "alertId": aid[:80],
        "symbol": sym, "direction": direction, "mode": mode,
        "entryPx": entry, "breakPx": brk, "slPx": sl,
        "tps": [{"px": px, "pct": p} for px, p in tps],
        "riskPct": risk, "ttlMin": ttl, "be": True,
        "note": str(body.get("note") or "")[:240] or None,
        "strategy": str(body.get("strategy") or "tv-webhook")[:60],
        "status": "armed", "by": "tradingview",
        "createdAt": _now_iso(),
    }


def append_setup(spec):
    """Load-modify-save with idempotency: same alertId or id = replay."""
    with WRITE_LOCK:
        try:
            data = json.loads(SETUPS.read_text())
        except Exception:
            data = {}
        setups = data.get("setups") if isinstance(data.get("setups"), list) else []
        for s in setups:
            if s.get("id") == spec["id"] or (spec.get("alertId") and s.get("alertId") == spec["alertId"]):
                raise FileExistsError(f"duplicate alert {spec['alertId']}")
        live = [s for s in setups if s.get("status") not in TERMINAL]
        if len(live) >= MAX_LIVE_SETUPS:
            raise OverflowError(f">{MAX_LIVE_SETUPS} live setups — refused")
        setups.append(spec)
        data["setups"] = setups[-50:]
        tmp = SETUPS.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        os.replace(tmp, SETUPS)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # systemd journal captures real logs; keep stdout quiet

    def _reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        # permissive CORS — auth is the shared secret in the body, not the
        # origin; lets the Pages-hosted dashboard POST cross-origin to the box
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._reply(200, {"ok": True, "svc": "sentinel-tv-hook", "ts": _now_iso()})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if not (0 < n <= MAX_BODY):
            return self._reply(413 if n > MAX_BODY else 400, {"ok": False, "err": "bad length"})
        try:
            body = json.loads(self.rfile.read(n))
        except Exception:
            return self._reply(400, {"ok": False, "err": "invalid JSON"})
        try:
            spec = normalize(body)
        except PermissionError as e:
            return self._reply(403, {"ok": False, "err": str(e)})
        except ValueError as e:
            return self._reply(422, {"ok": False, "err": str(e)})
        try:
            append_setup(spec)
        except FileExistsError as e:
            return self._reply(200, {"ok": True, "dedup": True, "err": str(e)})
        except OverflowError as e:
            return self._reply(429, {"ok": False, "err": str(e)})
        except Exception as e:
            return self._reply(500, {"ok": False, "err": f"persist: {e}"})
        print(f"[tv-hook] armed {spec['id']} {spec['symbol']} {spec['direction']} {spec['mode']} alert={spec['alertId']}", flush=True)
        self._reply(200, {"ok": True, "id": spec["id"], "symbol": spec["symbol"], "mode": spec["mode"]})


if __name__ == "__main__":
    if not _secret():
        print("[tv-hook] WARNING: state/tv-hook.json has no 'secret' — every POST will 403", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", 8790), H)
    print("[tv-hook] listening on 127.0.0.1:8790", flush=True)
    srv.serve_forever()
