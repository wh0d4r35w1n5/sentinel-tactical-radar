#!/usr/bin/env python3
"""Shadow admission sidecar v3 — read-only would-be verdicts.
v3 fixes (Issue #2, comment 6873734422):
 1. Ambiguous completions are REJECTED from judge evidence entirely
    (matchCount>1 -> skipped, counted, reported — never scored to m[0]).
 2. CHRONOLOGICAL replay: approvals and seat-completions interleaved in
    time order; each verdict is computed against judge state built ONLY
    from completions resolved before that approval — no final-state leak.
 3. Reads lastFillSyncOk (P3a schema). The live executor now writes it
    (deployed 2026-11-14, verified stamping) — verdicts unmask when the
    heartbeat is fresh, fail closed to UNVERIFIABLE-SYNC when stale.
 4. Crash consistency: on start, OUT is parsed for already-scored oids;
    a crash after emit but before wm-write cannot double-score (dedupe by
    oid, not just watermark position).
Writes ONLY /tmp/shadow-verdicts.jsonl + /tmp/shadow-wm3.json.
"""
import json, time
from collections import defaultdict, deque

ROOT = "/opt/sentinel"
OUT  = "/tmp/shadow-verdicts.jsonl"
WM   = "/tmp/shadow-wm3.json"
WINDOW, MINN, SYNC_STALE_S = 15, 20, 900

def rj(p):
    try: return json.load(open(p))
    except Exception: return None

def approvals_and_subs(lines=None):
    ap, sub_by_oid = {}, {}
    try:
        for ln in (lines if lines is not None else open(ROOT + "/state/entry-risk-audit.jsonl")):
            try: r = json.loads(ln)
            except Exception: continue
            if r.get("event") == "approved": ap[r.get("clientOid")] = r
            elif r.get("event") == "submitted" and r.get("clientOid") in ap and r.get("orderId"):
                oid = str(r["orderId"])
                sub_by_oid[oid] = None if oid in sub_by_oid else r   # collision -> poisoned, never guessed
    except Exception: pass
    return ap, sub_by_oid

def completions(sub_by_oid, ap, fills=None):
    """Round trips attributed by EXACT order-identity chain:
    open-fill.orderId -> submitted.orderId -> approval.clientOid.
    Mixed/missing clientOids -> UNSCORABLE (counted), never guessed.
    Returns (completions, rejectedFills) — rejected fills counted by reason:
      dup_fill_identity    - tradeId/fillId seen before (replay-safe dedupe)
      missing_fill_identity- no tradeId/fillId: cannot be deduped, could
                             double-count on replay -> taints, never scored
      bad_side             - side/posSide not exactly sell|buy
      bad_tradeSide        - tradeSide not exactly open|close
    TAINT LIFETIME: a malformed fill could have touched any seat open on
    that symbol at that instant -> both buckets tainted. The taint clears
    when that bucket's seat completes (goes flat): a later seat cannot
    contain the bad row, so future evidence stays scorable. The tainted
    seat itself is always unscorable."""
    fills = fills if fills is not None else (rj(ROOT + "/state/real-fills.json") or {}).get("fills") or []
    op, done, tainted, seenFills = {}, [], set(), set()
    rej = defaultdict(int)
    integrity_fail = False   # a row we can't even place on a symbol -> global failure
    usable = []
    for f in fills:
        sym = f.get("symbol")
        if not sym:
            # cannot prove which seat this touched ANYWHERE -> fail closed
            # at the whole-digest level, never silently dropped.
            rej["missing_symbol"] += 1; integrity_fail = True; continue
        ts_raw = f.get("ts")
        if not isinstance(ts_raw, (int, float)) or isinstance(ts_raw, bool) or ts_raw <= 0:
            # has a symbol but no placeable time -> taint that symbol's seats
            _taint = ((sym, "long"), (sym, "short"))
            for k in _taint: tainted.add(k)
            rej["bad_ts"] += 1; continue
        usable.append(f)
    def _side(f):
        # journal side = position side. Fail CLOSED: anything not
        # explicitly sell/buy returns None -> fill rejected, never guessed.
        s = str(f.get("side") or f.get("posSide") or "").lower()
        return {"sell": "short", "buy": "long"}.get(s)
    def _reject(sym, why):
        rej[why] += 1
        for k in ((sym, "long"), (sym, "short")):
            tainted.add(k)
    for f in sorted(usable, key=lambda x: x["ts"]):
        sym = f["symbol"]
        fid = f.get("tradeId") or f.get("fillId")
        if fid is None:
            _reject(sym, "missing_fill_identity"); continue
        if fid in seenFills:
            rej["dup_fill_identity"] += 1; continue      # duplicate fill row -> skip once, counted
        seenFills.add(fid)
        sd = _side(f); ts_ = f.get("tradeSide")
        if sd is None:
            _reject(sym, "bad_side"); continue
        if ts_ not in ("open", "close"):
            _reject(sym, "bad_tradeSide"); continue
        key = (sym, sd)
        sz = float(f.get("size") or 0); fee = abs(float(f.get("fee") or 0))
        c = op.get(key)
        if ts_ == "open":
            if not c: c = op[key] = {"sym": sym, "t0": f["ts"], "sz": 0.0, "osz": 0.0, "net": 0.0, "oids": set(), "oidMissing": 0}
            c["sz"] += sz; c["osz"] += sz; c["net"] -= fee
            if f.get("orderId"): c["oids"].add(str(f["orderId"]))
            else: c["oidMissing"] += 1
        elif c:
            c["sz"] -= sz; c["net"] += float(f.get("profit") or 0) - fee
            if c["sz"] < c["osz"] * 0.001:
                c["tEnd"] = f["ts"]; c["tainted"] = key in tainted
                done.append(c); op.pop(key)
                tainted.discard(key)                     # taint dies with the seat it could have touched
    out = []
    for c in done:
        # strict: EVERY open orderId must resolve to the SAME clientOid.
        # An unresolved open could be another cells order -> unscorable,
        # never guessed. (7/366 open fills have no submitted match.)
        if (c.get("tainted") or c["oidMissing"] or not c["oids"]
            or any(o not in sub_by_oid or sub_by_oid[o] is None for o in c["oids"])):
            out.append((c["tEnd"], None, None, 0))      # UNSCORABLE: unknown/collided origin
            continue
        coids = {str(sub_by_oid[o].get("clientOid")) for o in c["oids"]}
        if len(coids) != 1:
            out.append((c["tEnd"], None, None, 0))      # UNSCORABLE: mixed cells
            continue
        a = ap.get(next(iter(coids)))
        if a and (a.get("riskUsd") or 0) > 0 and a.get("cell"):
            out.append((c["tEnd"], a["cell"], c["net"] / a["riskUsd"], 1))
        else:
            out.append((c["tEnd"], None, None, 0))
    return sorted(out), dict(rej), integrity_fail

def scored_oids():
    """Parse OUT for scored oids; repair a torn trailing line so a crash
    mid-write can never double-score (the torn record rescans cleanly).
    Returns (done, pending): an oid whose ONLY verdict was
    UNVERIFIABLE-SYNC is not final — it must be re-judged once the fill
    heartbeat is fresh again (2026-11-14: a stale run used to consume the
    approval permanently)."""
    seen, pending = set(), set(); nl = chr(10).encode()
    try:
        data = open(OUT, "rb").read()
        if data and not data.endswith(nl):
            tail = data.rsplit(nl, 1)[-1]
            try: json.loads(tail)
            except Exception:
                open(OUT, "r+b").truncate(len(data) - len(tail))
                data = data[:len(data) - len(tail)]
        for ln in data.decode("utf-8", "replace").splitlines():
            try: r = json.loads(ln)
            except Exception: continue
            oid = r.get("oid")
            if not oid: continue
            if r.get("newVerdict") in ("UNVERIFIABLE-SYNC", "UNVERIFIABLE-ATTRIBUTION"):
                pending.add(oid)
            else:
                seen.add(oid); pending.discard(oid)   # a real verdict settles it
    except FileNotFoundError: pass
    except Exception: pass
    return seen, pending

def emit(rec):
    with open(OUT, "a") as f: f.write(json.dumps(rec) + "\n")

def main(audit_lines=None, fills=None, out=OUT, wm=WM, ledger=None):
    global OUT, WM
    OUT, WM = out, wm
    ap, sub_by_oid = approvals_and_subs(audit_lines)
    comps, rejected, integrity_fail = completions(sub_by_oid, ap, fills)
    done_oids, pending_oids = scored_oids()
    lfs = ((ledger if ledger is not None else rj(ROOT + "/api/live-ledger.json")) or {}).get("lastFillSyncOk")
    fs_age = None if not lfs else (time.time() * 1000 - lfs) / 1000
    # stale-run verdicts are provisional: when sync is fresh, re-judge them
    # (they never earned a real verdict); while sync is still stale they
    # stay done so the log isn't flooded with repeats.
    if fs_age is not None and fs_age <= SYNC_STALE_S and not integrity_fail:
        done_oids = done_oids - pending_oids
    else:
        done_oids = done_oids | pending_oids

    events = [("a", a.get("ts", 0), oid, a) for oid, a in ap.items()]
    events += [("c", t, None, (cell, R, mc)) for t, cell, R, mc in comps]
    # equal-ts policy: APPROVALS before completions. At a timestamp tie we
    # cannot prove the completion's R was written before the approval was
    # judged - treating it as available risks look-ahead (over-refusal).
    # Approvals-first can only under-refuse, never over-refuse; any cell it
    # misses at the tie is caught by the next approval in that cell.
    events.sort(key=lambda e: (e[1], 1 if e[0] == 'c' else 0))

    roll = defaultdict(lambda: deque(maxlen=WINDOW))
    lifeN, blocked = defaultdict(int), defaultdict(bool)
    amb = scored = 0; new_wm = (rj(WM) or {}).get("ts", 0)

    for kind, ts, oid, payload in events:
        if kind == "c":
            cell, R, mc = payload
            if cell is None:
                amb += 1                                    # EVERY unscorable completion counted
                continue
            roll[cell].append(R); lifeN[cell] += 1
            if lifeN[cell] >= MINN and len(roll[cell]) >= WINDOW:
                neg = sum(roll[cell]) < 0                  # rolling re-admission built in
                blocked[cell] = ts if neg and not blocked[cell] else (ts if neg else False)
            continue
        if oid in done_oids: continue                      # fix 4: crash dedupe by oid
        a = payload; cell = a.get("cell")                  # fix 2: verdict vs state-so-far
        if blocked[cell]:
            cv = "REFUSE-ROLLING" if ts - blocked[cell] < 3600e3 else "ALREADY-BLOCKED"
        else:
            cv = "ADMIT"
        if fs_age is None or fs_age > SYNC_STALE_S:
            verdict = "UNVERIFIABLE-SYNC"
        elif integrity_fail:
            # a fill row exists we cannot place on ANY seat -> the whole
            # attribution basis is suspect; never emit a live-usable verdict.
            verdict = "UNVERIFIABLE-ATTRIBUTION"
        else:
            verdict = cv
        emit({"ts": ts, "oid": oid, "cell": cell, "sym": a.get("symbol"),
              "oldVerdict": "APPROVED", "newVerdict": verdict, "cellVerdict": cv,
              "priorRoll%d" % WINDOW: round(sum(roll[cell]), 3) if roll[cell] else None,
              "lifeN": lifeN[cell], "fillsSyncAgeS": fs_age})
        scored += 1; new_wm = max(new_wm, ts)

    emit({"digest": True, "at": int(time.time() * 1000), "scored": scored,
          "chronoReplay": True, "unscorableCompletions": amb,
          "rejectedFills": rejected,
          "attributionIntegrityFail": integrity_fail,
          "blockedCells": sorted(c for c in blocked if blocked[c]), "fsAgeS": fs_age})
    json.dump({"ts": new_wm}, open(WM, "w"))
    print("shadow v3: %d scored (chrono), wm=%s, unscorable=%d, blocked=%s" %
          (scored, new_wm, amb, sorted(c for c in blocked if blocked[c])))

if __name__ == "__main__":
    import os, sys
    try:
        fd = os.open("/tmp/shadow-verdicts.lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        sys.exit("shadow: lock held - concurrent run refused")
    try:
        main()
    finally:
        os.close(fd); os.unlink("/tmp/shadow-verdicts.lock")
