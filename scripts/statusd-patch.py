import re
src = open("/home/ubuntu/sentinel-status.py").read()
anchor = "    line = json.dumps(out)"

# strip any previous merge block (corrupted or not) — idempotent
src = re.sub(r"    # merge powerhouse layers.*?\n(?=    line = json\.dumps\(out\))", "", src, flags=re.S)

block = """    # merge powerhouse layers: SMC per-seat, integrity, plumbing health
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

    line = json.dumps(out)"""
assert anchor in src
src = src.replace(anchor, block, 1)
open("/home/ubuntu/sentinel-status.py", "w").write(src)
print("statusd patched")
