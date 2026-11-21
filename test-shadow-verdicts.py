#!/usr/bin/env python3
"""Reproducible tests for shadow-verdicts attribution — raw-row fixtures.
Run: python3 test-shadow-verdicts.py  (exits nonzero on any failure)"""
import sys, importlib.util
spec = importlib.util.spec_from_file_location("sv", __file__.replace("test-shadow-verdicts.py", "shadow-verdicts.py"))
sv = importlib.util.module_from_spec(spec); spec.loader.exec_module(sv)

F = lambda **kw: dict({"symbol": "XUSDT", "size": 1, "fee": 0.001, "profit": 0, "tradeSide": "open", "ts": 1000, "orderId": "o1", "side": "buy"}, **kw)
AP = {"c1": {"clientOid": "c1", "cell": "Cell:A", "riskUsd": 1.0, "ts": 1}}
SUB = lambda oid="o1", coid="c1": {"event": "submitted", "clientOid": coid, "orderId": oid, "symbol": "XUSDT", "ts": 5}
sub_by = {"o1": SUB()}

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  PASS", name)
    else: failed += 1; print("  FAIL", name)

print("== attribution fixtures ==")
F = lambda **kw: dict({"symbol": "XUSDT", "size": 1, "fee": 0.001, "profit": 0, "tradeSide": "open", "ts": 1000, "orderId": "o1", "side": "buy", "tradeId": "t1"}, **kw)
C = lambda *a: sv.completions(*a)[0]      # completions list only
R = lambda *a: sv.completions(*a)[1]      # rejected-fill reason counts

# 1. long seat: open-buy + close-buy -> scored (side = position side)
c = C(sub_by, AP, [F(ts=1000, orderId="o1"), F(ts=2000, orderId="o9", tradeSide="close", profit=0.5, tradeId="t2")])
check("open-buy/close-buy -> long seat scored", len(c) == 1 and c[0][1] == "Cell:A" and abs(c[0][2] - 0.499) < 0.01)

# 2. short seat: open-sell + close-sell
c = C(sub_by, AP, [F(ts=1000, orderId="o1", side="sell"), F(ts=2000, orderId="o9", tradeSide="close", side="sell", profit=0.3, tradeId="t2")])
check("open-sell/close-sell -> short seat scored", len(c) == 1 and c[0][1] == "Cell:A")

# 3. hedge: simultaneous long + short on same symbol don't conflate
c = C(sub_by, AP, [F(ts=1000, orderId="o1"), F(ts=1001, orderId="o1", side="sell", tradeId="t1b"),
                   F(ts=2000, orderId="o9", tradeSide="close", profit=0.2, tradeId="t2"),
                   F(ts=2001, orderId="o9", tradeSide="close", side="sell", profit=-0.1, tradeId="t3")])
check("hedge sym-long+short -> two seats", len(c) == 2)

# 4. missing orderId on an open fill -> unscorable
c = C(sub_by, AP, [F(ts=1000, orderId=None), F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2")])
check("missing open orderId -> unscorable", len(c) == 1 and c[0][1] is None)

# 5. unknown orderId (not in submitted) -> unscorable
c = C(sub_by, AP, [F(ts=1000, orderId="zzz"), F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2")])
check("unknown open orderId -> unscorable", len(c) == 1 and c[0][1] is None)

# 6. malformed side -> fill rejected, no seat
c = C(sub_by, AP, [F(ts=1000, orderId="o1", side="???"), F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2")])
check("malformed side -> fill rejected", len(c) == 0)

# 7. mixed origin: seat built from two different clientOids -> unscorable
sb2 = {"o1": SUB(), "o2": SUB("o2", "c2")}
ap2 = dict(AP, **{"c2": {"clientOid": "c2", "cell": "Cell:B", "riskUsd": 1.0, "ts": 1}})
c = C(sb2, ap2, [F(ts=1000, orderId="o1"), F(ts=1100, orderId="o2", tradeId="t1b"), F(ts=2000, orderId="o9", tradeSide="close", size=2, tradeId="t2")])
check("mixed-origin seat -> unscorable", len(c) == 1 and c[0][1] is None)

# 8. duplicate submitted orderId -> poisoned -> unscorable
sb3 = {"o1": SUB(), }
sb3["o1"] = None if "o1" in sb3 else sb3["o1"]
c = C(sb3, AP, [F(ts=1000, orderId="o1"), F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2")])
check("collided orderId -> unscorable", len(c) == 1 and c[0][1] is None)

# 9. partial fills aggregate into one seat
c = C(sub_by, AP, [F(ts=1000, orderId="o1", size=0.5), F(ts=1100, orderId="o1", size=0.5, tradeId="t1b"),
                   F(ts=2000, orderId="o9", tradeSide="close", size=0.5, profit=0.1, tradeId="t2"),
                   F(ts=2100, orderId="o9", tradeSide="close", size=0.5, profit=0.1, tradeId="t3")])
check("partials -> one seat", len(c) == 1 and c[0][1] == "Cell:A")

# 10. still-open seat -> no completion
c = C(sub_by, AP, [F(ts=1000, orderId="o1")])
check("open seat -> no completion", len(c) == 0)


print("== v4.2 edge fixtures ==")
import json as _json
lines = [_json.dumps({"event":"approved","clientOid":"c1","cell":"Cell:A","riskUsd":1.0,"ts":1}),
         _json.dumps(SUB("o1","c1")),
         _json.dumps(SUB("o1","c1"))]
ap_r, sb_r = sv.approvals_and_subs(lines)
c = C(sb_r, ap_r, [F(ts=1000, orderId="o1"), F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2")])
check("parser-level collided orderId -> unscorable", len(c)==1 and c[0][1] is None)
c = C(sub_by, AP, [F(ts=1000, orderId="o1", tradeId="t1"), F(ts=1000, orderId="o1", tradeId="t1"),
                   F(ts=2000, orderId="o9", tradeSide="close", tradeId="t9", size=1)])
check("dupe tradeId -> single fill counted", len(c)==1 and c[0][1]=="Cell:A")
c = C(sub_by, AP, [F(ts=1000, orderId="o1"), F(ts=1500, orderId="oX", side="???", tradeId="tX"),
                   F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2")])
check("unknown-side fill taints seat -> unscorable", len(c)==1 and c[0][1] is None)
c = C(sub_by, AP, [F(ts=1000, orderId="o1"), F(ts=2000, orderId="o9", tradeSide="amend", profit=-5, tradeId="t2")])
check("unknown tradeSide -> not treated as close", len(c)==0 or c[0][1] is None)
c = C(sub_by, AP, [F(ts=1000, orderId=None), F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2"),
                   F(ts=3000, orderId="o1", symbol="YUSDT", tradeId="t3"), F(ts=4000, orderId="o9", tradeSide="close", symbol="YUSDT", tradeId="t4")])
n_unsc = sum(1 for x in c if x[1] is None)
check("e2e unscorable count == completions None count", n_unsc == 1)


print("== v4.3 acceptance fixtures ==")
# item 1: rejected fills counted by reason
c, rej, _if = sv.completions(sub_by, AP, [F(ts=1000, orderId="o1", side="???", tradeId="tA"),
                                     F(ts=1001, orderId="o2", tradeSide="amend", tradeId="tB"),
                                     F(ts=1002, orderId="o3", tradeId=None, fillId=None),
                                     F(ts=1003, orderId="o4", tradeId="tA"),
                                     F(ts=2000, orderId="o9", tradeSide="close", tradeId="t9")])
check("rejected counts by reason", rej.get("bad_side")==1 and rej.get("bad_tradeSide")==1
      and rej.get("missing_fill_identity")==1 and rej.get("dup_fill_identity")==1)

# item 2: missing identity fails closed -> taints (not silently scored)
c = C(sub_by, AP, [F(ts=1000, orderId="o1", tradeId=None, fillId=None),
                   F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2")])
check("no-identity fill -> taint -> unscorable/no seat", len(c)==0 or c[0][1] is None)

# item 3: same orderId under TWO different clientOids through the real parser
ap2v = dict(AP, **{"c2": {"clientOid":"c2","cell":"Cell:B","riskUsd":1.0,"ts":1}})
lines = [_json.dumps({"event":"approved","clientOid":"c1","cell":"Cell:A","riskUsd":1.0,"ts":1}),
         _json.dumps({"event":"approved","clientOid":"c2","cell":"Cell:B","riskUsd":1.0,"ts":1}),
         _json.dumps(SUB("o1","c1")),
         _json.dumps(SUB("o1","c2"))]
ap_r2, sb_r2 = sv.approvals_and_subs(lines)
c = C(sb_r2, ap_r2, [F(ts=1000, orderId="o1"), F(ts=2000, orderId="o9", tradeSide="close", tradeId="t2")])
check("cross-clientOid orderId collision -> unscorable", len(c)==1 and c[0][1] is None)

# item 5: taint lifetime — dies with the seat it could have touched
fills5 = [F(ts=1000, orderId="o1", tradeId="tA"),                       # seat1 opens long
          F(ts=1100, orderId="oX", side="???", tradeId="tBad"),       # malformed mid-seat -> taint
          F(ts=2000, orderId="o9", tradeSide="close", tradeId="tB"),  # seat1 completes -> unscorable, taint dies
          F(ts=3000, orderId="o1", tradeId="tC"),                     # seat2 opens clean
          F(ts=4000, orderId="o9", tradeSide="close", profit=0.4, tradeId="tD")]
c = C(sub_by, AP, fills5)
check("taint expires at seat flat: seat2 scores", len(c)==2 and c[0][1] is None and c[1][1]=="Cell:A")

# item 4: REAL end-to-end digest — run main() with injected fixtures,
# assert the emitted digest line's own accounting fields.
import tempfile, os as _os, time as _time
od = tempfile.mkdtemp()
out_p, wm_p = _os.path.join(od, "out.jsonl"), _os.path.join(od, "wm.json")
audit = [_json.dumps({"event":"approved","clientOid":"c1","cell":"Cell:A","riskUsd":1.0,"ts":1}),
         _json.dumps(SUB("o1","c1"))]
fills_e2e = [F(ts=1000, orderId="o1", tradeId="tA"),
             F(ts=1100, orderId="oX", side="???", tradeId="tBad"),
             F(ts=2000, orderId="o9", tradeSide="close", tradeId="tB")]
sv.main(audit_lines=audit, fills=fills_e2e, out=out_p, wm=wm_p,
        ledger={"lastFillSyncOk": int(_time.time()*1000)})
dig = [_json.loads(l) for l in open(out_p) if '"digest"' in l][-1]
check("E2E digest.unscorableCompletions == 1", dig.get("unscorableCompletions") == 1)
check("E2E digest.rejectedFills.bad_side == 1", (dig.get("rejectedFills") or {}).get("bad_side") == 1)
check("E2E digest.scored counts emitted verdicts", dig.get("scored") == 1)


# ---- v4.4 malformed-row accounting (ChatGPT blocker 4) ----

# a fill with NO symbol can't be placed on any seat -> global integrity
# failure in the digest; a fill with symbol but unplaceable ts is counted
# and taints BOTH sides of that symbol.
_c, _rej, _if = sv.completions({"s1": ["a1"]}, AP, [
    F(ts=2000, orderId="o1", side="close", tradeId="t1", pnl=1.0),
    {"ts": 3000, "orderId": "o2", "side": "close", "tradeId": "t2", "pnl": -5.0},
])
check("missing-symbol row -> integrity fail + counted", _if is True and _rej["missing_symbol"] == 1)

_ap = {"cX": dict(AP["c1"], clientOid="cX", cell="X:LONG", symbol="TST")}
for _bad in (None, 0, "soon", {"t": 1}):
    _, _rej2, _if2 = sv.completions({"sX": ["cX"]}, _ap,
        [F(ts=_bad, orderId="o9", side="close", tradeId="tb", pnl=-1.0, symbol="TST")])
    check("bad-ts row counted (ts=%r), local not global" % _bad,
          _if2 is False and _rej2["bad_ts"] == 1)

# bad-ts row taints the symbol: a following good close on that symbol is
# unscorable instead of scoring cleanly.
_ap3 = {"cY": dict(AP["c1"], clientOid="cY", cell="Y:LONG", symbol="ZZZ")}
_c3, _r3, _i3 = sv.completions({"sY": ["cY"]}, _ap3, [
    F(ts=1000, orderId="oA", side="buy", tradeSide="open", tradeId="tA", symbol="ZZZ"),
    {"ts": None, "orderId": "oX", "side": "buy", "tradeSide": "close", "tradeId": "tx", "symbol": "ZZZ"},
    F(ts=3000, orderId="oA", side="buy", tradeSide="close", tradeId="tA2", profit=1.0, symbol="ZZZ"),
])
check("bad-ts on symbol taints seat -> unscorable",
      len(_c3) == 1 and _c3[0][1] is None and _r3["bad_ts"] == 1)

# E2E through the real digest path.
_dg2 = {}
_orig = sv.emit
sv.emit = lambda rec: _dg2.update(rec) if rec.get("digest") else None
try:
    sv.main(audit_lines=["L"], fills=[
        F(ts=2000, orderId="o1", side="close", tradeId="t1", pnl=1.0),
        {"ts": 3000, "orderId": "oX", "side": "close", "tradeId": "tx"},
        F(ts=None, orderId="oY", side="close", tradeId="ty", symbol="AAA"),
    ], out="/tmp/svtest44.out", wm="/tmp/svtest44.wm")
finally:
    sv.emit = _orig
check("E2E digest.attributionIntegrityFail on missing-symbol row", _dg2.get("attributionIntegrityFail") is True)
check("E2E digest.rejectedFills.missing_symbol == 1", (_dg2.get("rejectedFills") or {}).get("missing_symbol") == 1)
check("E2E digest.rejectedFills.bad_ts == 1", (_dg2.get("rejectedFills") or {}).get("bad_ts") == 1)


# ---- v4.5 stale-sync replay (ChatGPT new finding 3) ----

# Run once with a STALE heartbeat -> the approval gets UNVERIFIABLE-SYNC.
# Run again with a FRESH heartbeat -> the same oid MUST get a real verdict
# (not skipped as done, not double-counted as a new approval).
import os
_out5, _wm5 = "/tmp/svtest45.out", "/tmp/svtest45.wm"
for _p in (_out5, _wm5):
    try: os.remove(_p)
    except OSError: pass
_audit5 = [
    _json.dumps({"event": "approved", "clientOid": "c9", "cell": "CellZ", "riskUsd": 1.0, "symbol": "ZUSDT", "ts": 10}),
    _json.dumps({"event": "submitted", "clientOid": "c9", "orderId": "o9", "symbol": "ZUSDT", "ts": 20}),
]
_stale = {"lastFillSyncOk": int(__import__("time").time() * 1000) - 7200e3}
_recs1 = []
_orig2 = sv.emit
sv.emit = lambda rec: _recs1.append(rec)
try:
    sv.main(audit_lines=_audit5, fills=[], out=_out5, wm=_wm5, ledger=_stale)
finally:
    sv.emit = _orig2
_v1 = [r for r in _recs1 if r.get("oid") == "c9"]
check("stale sync run -> UNVERIFIABLE-SYNC verdict emitted",
      len(_v1) == 1 and _v1[0].get("newVerdict") == "UNVERIFIABLE-SYNC")
# the verdict row must have been WRITTEN to OUT for scored_oids to see it
_orig_emit = sv.emit
try:
    for r in _recs1:
        if r.get("oid"): _orig_emit(r)
finally:
    pass
_fresh = {"lastFillSyncOk": int(__import__("time").time() * 1000)}
_recs2 = []
sv.emit = lambda rec: _recs2.append(rec)
try:
    sv.main(audit_lines=_audit5, fills=[], out=_out5, wm=_wm5, ledger=_fresh)
finally:
    sv.emit = _orig_emit
_v2 = [r for r in _recs2 if r.get("oid") == "c9"]
check("fresh sync re-run -> oid re-judged with real verdict (not consumed)",
      len(_v2) == 1 and _v2[0].get("newVerdict") != "UNVERIFIABLE-SYNC")

# while sync stays stale, a second run must NOT re-emit the pending verdict
_recs3 = []
sv.emit = lambda rec: _recs3.append(rec)
try:
    for r in _recs2:
        if r.get("oid"): _orig_emit(r)   # persist the fresh verdict first
    _stale2 = {"lastFillSyncOk": int(__import__("time").time() * 1000) - 7200e3}
    sv.main(audit_lines=_audit5, fills=[], out=_out5, wm=_wm5, ledger=_stale2)
finally:
    sv.emit = _orig_emit
_v3 = [r for r in _recs3 if r.get("oid") == "c9"]
check("settled verdict stays settled under stale sync",
      len(_v3) == 0)


# ---- v4.6 integrity-fail gates verdicts (ChatGPT review 6875119736) ----

# a missing-symbol row poisons the whole basis: approvals emit
# UNVERIFIABLE-ATTRIBUTION, never ADMIT -- even with fresh sync.
_recs6 = []
_orig3 = sv.emit
sv.emit = lambda rec: _recs6.append(rec)
try:
    sv.main(audit_lines=_audit5, fills=[
        {"ts": 3000, "orderId": "oX", "side": "buy", "tradeSide": "close", "tradeId": "tx"},
    ], out="/tmp/svtest46.out", wm="/tmp/svtest46.wm", ledger=_fresh)
finally:
    sv.emit = _orig3
_v6 = [r for r in _recs6 if r.get("oid") == "c9"]
check("integrity fail -> UNVERIFIABLE-ATTRIBUTION not ADMIT",
      len(_v6) == 1 and _v6[0].get("newVerdict") == "UNVERIFIABLE-ATTRIBUTION")

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
