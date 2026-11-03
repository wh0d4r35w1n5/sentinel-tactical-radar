"""Sentinel VIP signal feed — posts real fills to the VIP channel.

Polls state/real-fills.json for new open/close fills and posts formatted
signals. Own session copy + own systemd unit — never touches tg-watch.

Dedup state: /opt/sentinel/state/vip-signals.json
"""
import json, asyncio, time, os, re, importlib.util
from telethon import TelegramClient, types
from telethon.errors import FloodWaitError

BASE = "/opt/sentinel"
CFG = BASE + "/scripts/tg-config.json"
SESS = BASE + "/state/tg-signal-sess"          # dedicated session copy
STATE = BASE + "/state/vip-signals.json"
VIP = BASE + "/state/vip-state.json"           # channel id + username
POLL = 15
MAX_AGE_MS = 20 * 60 * 1000      # fills older than this at processing time are skipped — no backfill floods
MAX_BATCH = 12                   # per-cycle post cap; the cursor advances regardless

# chart renderer — every signal posts with a pre-trade TA chart
_spec = importlib.util.spec_from_file_location("tg_charts", BASE + "/scripts/tg-charts.py")
TGC = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(TGC)

def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def fmtp(x):
    x = float(x)
    if x >= 1000: return f"{x:,.1f}"
    if x >= 10: return f"{x:,.2f}"
    return f"{x:,.4f}"

def load_json(p, d=None):
    try:
        return json.load(open(p))
    except Exception:
        return d


def _scan_row(sym, ctx):
    """Market-scanner signal row for this symbol (asset 'NEAR' <- 'NEARUSDT')."""
    base = str(sym or "").replace("USDT", "").replace("USD", "").upper()
    for s in (ctx["scan"].get("signals") or []):
        if str(s.get("asset") or "").upper() == base or str(s.get("symbol") or "").upper() == str(sym).upper():
            return s
    return None

def _rating_txt(sym, ctx):
    """Dashboard rating detail — composite grade, fusion drivers, family edge,
    regime/tape metrics. Facts only; omitted entirely when the symbol isn't on
    the scanner board."""
    s = _scan_row(sym, ctx)
    if not s:
        return ""
    L = []
    head = []
    if s.get("grade"): head.append(f"Grade {s['grade']}")
    if s.get("score") is not None: head.append(f"score {s['score']}/100")
    if s.get("fusedScore") is not None: head.append(f"fused {s['fusedScore']}")
    if s.get("fusedZ") is not None: head.append(f"Z {s['fusedZ']:+.2f}")
    if head: L.append("📊 " + " · ".join(head))
    tape = []
    if s.get("rsi") is not None: tape.append(f"RSI {round(s['rsi'])}")
    if s.get("momScore") is not None: tape.append(f"mom {s['momScore']}")
    if s.get("volRatio") is not None: tape.append(f"vol {s['volRatio']:.1f}x")
    if s.get("rangePct") is not None: tape.append(f"range pos {round(s['rangePct'])}%")
    if s.get("spreadPct") is not None: tape.append(f"spread {s['spreadPct']:.2f}%")
    if tape: L.append("📈 " + " · ".join(tape))
    reg = []
    if s.get("mktType"): reg.append(s["mktType"])
    bp = s.get("btcPair") or {}
    if bp.get("rs24") is not None: reg.append(f"BTC-RS {bp['rs24']:+.1f}%")
    if s.get("corrBtc") is not None: reg.append(f"corr {s['corrBtc']:.2f}")
    if s.get("betaBtc") is not None: reg.append(f"beta {s['betaBtc']:.1f}")
    if reg: L.append("🌐 " + " · ".join(reg))
    fus = s.get("fusion") or {}
    if fus:
        top = sorted(fus.items(), key=lambda kv: -(kv[1] or 0))[:4]
        L.append("⚡ " + " · ".join(f"{k}{v:+.2f}" for k, v in top if isinstance(v, (int, float))))
    le = s.get("libedge") or {}
    fe = le.get("famEdge") or {}
    if fe.get("n"):
        L.append("🧬 edge fam: Sharpe %.1f · PF %.1f · WR %.0f%% · DD %.0f%% (n=%d, %s)"
                 % (fe.get("medSharpe") or 0, fe.get("medPf") or 0, fe.get("medWr") or 0,
                    fe.get("medDd") or 0, fe["n"], le.get("domArch") or "?"))
    hm = s.get("harmonic") or {}
    if hm.get("type"):
        L.append("🎵 %s %s q%s @ %s" % (hm["type"], hm.get("dir") or "", hm.get("quality") or "?", fmtp(hm.get("dPrice") or 0)))
    rk = []
    if s.get("targetPct") is not None: rk.append(f"target {s['targetPct']}%")
    if s.get("netTargetPct") is not None: rk.append(f"net {s['netTargetPct']}%")
    if s.get("riskPct") is not None: rk.append(f"risk {s['riskPct']}%")
    if rk: L.append("🎯 " + " · ".join(rk))
    dr = s.get("drivers") or []
    if dr: L.append("💠 " + dr[0][:110])
    return "\n".join(L)

def find_plan(symbol, direction, plans):
    best = None
    for o in plans or []:
        if o.get("symbol") == symbol and (o.get("direction") or "").upper() == direction.upper():
            if best is None or (o.get("score") or 0) > (best.get("score") or 0):
                best = o
    return best

# ---------- executive rationale ----------
# Every VIP card carries the reason in professional language: strategy,
# regime, tape context (hive flow/liquidations/breadth), the cell's
# measured record, funding posture. Facts only — nothing fabricated.
# v2 (operator complaint: descriptions "repetitive and meaningless"):
# composition varies per card — a lead clause drawn by lane + a hash of
# the symbol, evidence clauses assembled from whichever facts exist, and
# the canned filler ("capital allocated to a high-liquidity contract")
# retired. Two cards for different names read differently now.
REASON_TXT = {
    "liq-sweep": "liquidity-sweep reversal", "tsmom": "cross-horizon momentum agreement",
    "vema": "volatility-expansion breakout", "vwap": "VWAP reversion",
    "sfp": "swing-failure pattern", "effort": "effort-versus-result divergence",
    "eq-edge": "equilibrium edge", "breakout": "range breakout",
    "pullback": "trend pullback", "range": "range rotation",
}

def load_ctx():
    return {
        "env": load_json(BASE + "/state/deploy-envelope.json", {}) or {},
        "intel": load_json(BASE + "/api/liq-intel.json", {}) or {},
        "seats": load_json(BASE + "/state/bagrunner-seats.json", {}) or {},
        "fund": load_json(BASE + "/api/funding.json", {}) or {},
        "bub": load_json(BASE + "/state/cryptobubbles.json", {}) or {},
        "fx": load_json(BASE + "/state/fx-aud.json", {}) or {},
        "scan": load_json(BASE + "/api/market-scanner.json", {}) or {},
    }

def _h(sym, n):
    return abs(hash(sym)) % n

def fmtA(usd, ctx):
    r = (ctx["fx"].get("rate") or 0) or 1.4324
    return f"A${usd * r:.2f}"

def _cell_txt(cell, sym, ctx):
    if not cell or not cell.get("verdict"):
        return ""
    v, n, net = cell["verdict"], cell.get("n", "?"), cell.get("net", 0)
    if v == "proven":
        return [
            f" Cell's proven — {n} episodes banked {fmtA(net, ctx)} all up.",
            f" This cell pays: {n} episodes, {fmtA(net, ctx)} net. It gets the seat.",
            f" Measured-positive cell — {n} episodes for {fmtA(net, ctx)} net.",
        ][_h(sym + "pc", 3)]
    if v == "loser":
        return f" Record here is red over {n} episodes — seat runs small or not at all."
    if v == "flat":
        return f" Flat over {n} episodes — earns its keep or it's cut."
    return " Unmeasured cell — this episode starts the record."

def _bub_txt(sym, ctx):
    b = ((ctx["bub"].get("bySym") or {}).get(sym)) or {}
    if not b:
        return ""
    wk, dy, hr = b.get("week"), b.get("day"), b.get("hour")
    if wk is None or dy is None:
        return ""
    if hr is not None and hr > 0 and dy > 0 and wk > 0:
        return f" Refusing the tape — {sym.replace('USDT','')} green on hour/day/week ({hr:+.1f}/{dy:+.1f}/{wk:+.0f}%) while the rest of the market's on its arse."
    if wk >= 8 and dy <= 0:
        return f" Weekly leader ({wk:+.0f}%) off {dy:+.1f}% today — dip inside strength, not a dying name."
    if wk <= -8 and dy <= -4:
        return f" Structurally weak ({wk:+.0f}% week, {dy:+.1f}% day) — knife-shaped chart, caught carefully."
    if dy >= 8 and wk <= -15:
        return f" Bounce inside a dead trend ({dy:+.1f}% day, {wk:+.0f}% week) — dead-cat shape, sized like one."
    return f" Backdrop: {dy:+.1f}% day / {wk:+.0f}% week."

def _breadth_txt(ctx):
    br = (ctx["bub"].get("breadth") or {})
    n = br.get("n") or 0
    if n < 100:
        return ""
    dg = round(100 * (br.get("dayGreen") or 0))
    hg = round(100 * (br.get("hourGreen") or 0))
    if dg <= 30 and hg <= 30:
        return f" Tape's in a rout — {dg}% green day / {hg}% green hour across {n} names."
    if dg >= 65:
        return f" Broad tape's risk-on — {dg}% of {n} names green today."
    return ""

def _fund_txt(sym, ctx):
    f = (ctx["fund"].get("rates") or ctx["fund"].get("funding") or {})
    r = f.get(sym)
    try:
        r = float(r)
    except Exception:
        return ""
    if r >= 0.0005:
        return " Funding pays longs to hold — carry tips in."
    if r <= -0.0005:
        return " Funding's negative — longs get paid to sit, handy."
    return ""

def _flow_txt(isym, side):
    fl = isym.get("flow15m") or {}
    fb = (fl.get("buy") or 0) + (fl.get("sell") or 0)
    if fb <= 1e6:
        return ""
    buyPct = round(100 * (fl.get("buy") or 0) / fb)
    who = "buy" if buyPct >= 50 else "sell"
    return f" 15m tape runs {buyPct}% {who}-side."

def _liq_txt(isym, side):
    sh = ((isym.get("liq15m") or {}).get("short") or 0)
    if side == "LONG" and sh >= 30000:
        return f" ${sh/1e3:.0f}K of shorts cleared over 15m — overhead supply is gone."
    lo = ((isym.get("liq15m") or {}).get("long") or 0)
    if side == "SHORT" and lo >= 30000:
        return f" ${lo/1e3:.0f}K of longs flushed over 15m — fuel for the move."
    return ""

def build_reason(f, plan, side, ctx):
    sym = f.get("symbol")
    cell = (ctx["env"].get("cells") or {}).get(sym) or {}
    cellTxt = _cell_txt(cell, sym, ctx)
    isym = (ctx["intel"].get("symbols") or {}).get(sym) or {}
    flowTxt = _flow_txt(isym, side)
    liqTxt = _liq_txt(isym, side)
    bubTxt = _bub_txt(sym, ctx)
    brTxt = _breadth_txt(ctx)
    fundTxt = _fund_txt(sym, ctx)
    strat = (plan or {}).get("strategy") or ""
    seat = (ctx["seats"].get("seats") or {}).get(sym)

    if strat == "slot-deploy" or (plan or {}).get("mandate"):
        leads = [
            "Deployment mandate seat", "Mandate deployment", "Coverage seat",
            "Standing mandate order",
        ]  # lane names stay professional; the colour lives in the detail
        why = " — probe-scaled"
        b = ((ctx["bub"].get("bySym") or {}).get(sym)) or {}
        if b.get("hour", -1) > 0 and b.get("day", -1) > 0 and b.get("week", -1) > 0:
            why = " — the relative-strength lane: green on every frame while the tape's on its arse"
        elif (cell or {}).get("verdict") == "proven":
            why = " — capital concentrates on the cells that actually pay"
        stop = f"; risk bounded at a {plan.get('stopPct','—')}% stop" if plan.get("stopPct") else ""
        return (f"{leads[_h(sym, len(leads))]}{why}{stop}. Staged targets bank it in rungs.").replace("  ", " ") + bubTxt + brTxt + cellTxt + fundTxt

    if seat and not plan:
        leads = ["Momentum ignition", "Impulse entry", "Tape ignition"]
        return (f"{leads[_h(sym + 's', len(leads))]} — rolling-tape impulse score {seat.get('score','?')} "
                f"under the fee-lock trail: fees recover first, profit ratchets, seat vanishes on the turn."
                + flowTxt + liqTxt + bubTxt + cellTxt)

    if plan:
        head = f"{strat or 'Directional'} setup"
        meta = []
        if plan.get("grade"): meta.append(f"grade {plan['grade']}")
        if plan.get("score"): meta.append(f"confluence {plan['score']}/100")
        if meta: head += " — " + ", ".join(meta)
        reg = f" in a {plan['mktType']} regime" if plan.get("mktType") else ""
        trig = f" Trigger: {REASON_TXT.get(plan['reason'], plan['reason'])}." if plan.get("reason") else ""
        risk = ""
        if plan.get("stopPct"):
            tgt = plan.get("targetPct")
            risk = f" Risk bounded at {plan['stopPct']}% with staged targets{(' to ' + str(tgt) + '%') if tgt else ''}."
        return head + reg + "." + trig + bubTxt + flowTxt + liqTxt + brTxt + cellTxt + fundTxt + risk
    return "Systematic entry under the standing mandate — bounded risk, defined stop, staged targets." + bubTxt + flowTxt + cellTxt

def sig_levels(f, plan, side, ctx):
    """Real SL/TP geometry for card + chart: plan fields > seat's placed orders > none (never fabricated)."""
    sym, px = f.get("symbol"), f.get("price") or 0
    if plan and plan.get("stopPct") and px:
        sl = px * (1 - plan["stopPct"] / 100) if side == "LONG" else px * (1 + plan["stopPct"] / 100)
        tps = []
        if plan.get("targetPct"):
            tps.append(px * (1 + plan["targetPct"] / 100) if side == "LONG" else px * (1 - plan["targetPct"] / 100))
        seat = (ctx["seats"].get("seats") or {}).get(sym) or {}
        return sl, [t for t in tps or ([seat.get("tpPx")] if seat.get("tpPx") else []) if t]
    seat = (ctx["seats"].get("seats") or {}).get(sym) or {}
    if seat.get("stopPx") or seat.get("tpPx"):
        return seat.get("stopPx"), [seat.get("tpPx")] if seat.get("tpPx") else []
    return None, []

def sig_text(f, plan, ctx):
    side = "LONG" if f.get("side") == "buy" else "SHORT"
    em = "🟢" if side == "LONG" else "🔴"
    src = "OPERATOR" if f.get("src") == "web" else "SIGNAL"
    sl, tps = sig_levels(f, plan, side, ctx)
    lines = [
        f"{em} <b>{side} {f['symbol']}</b>  ·  {src}",
        f"Entry <b>{fmtp(f['price'])}</b>",
    ]
    if sl or tps:
        lv = []
        if sl: lv.append(f"SL <code>{fmtp(sl)}</code>")
        for i, tp in enumerate(tps):
            lv.append(f"TP{i+1} <code>{fmtp(tp)}</code>")
        lines.append("  ·  ".join(lv))
    if plan:
        meta = " · ".join(x for x in [
            plan.get("strategy"), f"grade {plan.get('grade')}" if plan.get("grade") else None,
            f"score {plan.get('score')}" if plan.get("score") else None,
            f"{plan.get('leverage')}x" if plan.get("leverage") else None] if x)
        if meta:
            lines.append(f"<i>{meta}</i>")
    rating = _rating_txt(f.get("symbol"), ctx)
    if rating:
        lines.append(rating)
    reason = build_reason(f, plan, side, ctx)
    if reason:
        lines.append("")
        lines.append(reason)
    lines.append("")
    lines.append(f"<i>{time.strftime('%H:%M UTC', time.gmtime(f['ts'] / 1000))} · evidence gallery: 52-65-5-228.sslip.io/gallery.html</i>")
    return "\n".join(lines)[:1020]

def close_text(f, pos_entry):
    side = "LONG" if f.get("side") == "sell" else "SHORT"
    pnl = (f.get("profit") or 0) - (f.get("fee") or 0)
    em = "✅" if pnl > 0 else "🔻"
    ret = ""
    if pos_entry:
        pct = (f["price"] - pos_entry) / pos_entry * 100 * (1 if side == "LONG" else -1)
        ret = f" ({pct:+.2f}%)"
    return (f"{em} <b>{side} {f['symbol']} — CLOSED</b>\n"
            f"Exit <b>{fmtp(f['price'])}</b> · net <b>${pnl:+.2f}</b>{ret}")

def fid(f):
    return f"{f.get('symbol')}:{f.get('side')}:{f.get('tradeSide')}:{f.get('ts')}:{f.get('size')}"

async def send(ch, text, png=None, tries=3):
    for i in range(tries):
        try:
            await c_send(ch, text, png)
            return True
        except FloodWaitError as e:
            await asyncio.sleep(min(e.seconds + 1, 120))
        except Exception as e:
            print("[vip-signals] send err:", str(e)[:80], flush=True)
            await asyncio.sleep(2 + i * 4)
    return False

def mfe_of(sym, side, entry_ts, exit_ts, gran="5m"):
    """peak excursion between entry and exit — from the candle series itself"""
    try:
        cs = TGC.candles(sym, gran, 200)
        w = [c for c in cs if entry_ts and c["t"] >= entry_ts - 60000 and c["t"] <= exit_ts + 60000]
        if not w: return None
        return max(c["h"] for c in w) if side == "long" else min(c["l"] for c in w)
    except Exception:
        return None

c_send = None  # bound in main once the client exists

async def main():
    cfg = load_json(CFG)
    vip = load_json(VIP, {})
    ch_id = vip.get("channel_id")
    assert ch_id, "vip-state.json missing channel_id"
    st = load_json(STATE, {"seen": 0, "entries": {}, "ids": []})
    st.setdefault("entries", {})   # older state files lack the key — []["entries"] throws
    st.setdefault("ids", [])
    # first run: don't backfill the whole journal into the channel — start now
    if not st.get("seen"):
        st["seen"] = int(time.time() * 1000)
        json.dump(st, open(STATE, "w"))
    seen_ts = st.get("seen", 0)
    seen_ids = set(st.get("ids") or [])
    ids_list = list(st.get("ids") or [])  # ordered — set() can't slice newest
    now_ms = lambda: int(time.time() * 1000)

    c = TelegramClient(SESS, cfg["api_id"], cfg["api_hash"])
    await c.connect()
    assert await c.is_user_authorized()
    global c_send
    async def _send(ch, text, png=None):
        if png:
            await c.send_file(ch, png, caption=text, parse_mode="html")
        else:
            await c.send_message(ch, text, parse_mode="html", link_preview=False)
    c_send = _send
    ch = await c.get_entity(types.PeerChannel(ch_id))
    print("[vip-signals] posting to", vip.get("username") or ch_id, flush=True)

    backoff = POLL
    while True:
        try:
            fills = (load_json(BASE + "/state/real-fills.json", {}) or {}).get("fills", [])
            plans = (load_json(BASE + "/api/live-plan.json", {}) or {}).get("orders", [])
            ctx = load_ctx()
            t_now = now_ms()
            new = [f for f in fills
                   if (f.get("ts") or 0) > seen_ts
                   and f.get("tradeSide") in ("open", "close")
                   and fid(f) not in seen_ids]
            # merge partial fills into ONE card: opens group by orderId,
            # closes group by symbol+side+minute — a split position used to
            # post 3 cards for one trade.
            merged, groups = [], {}
            for f in sorted(new, key=lambda x: x.get("ts", 0)):
                if f.get("tradeSide") == "open":
                    k = ("o", f.get("orderId") or fid(f))
                else:
                    k = ("c", f.get("symbol"), f.get("side"), (f.get("ts") or 0) // 60000)
                g = groups.get(k)
                if g is None:
                    f["_ids"] = [fid(f)]
                    groups[k] = f
                    merged.append(f)
                    continue
                tot = (g.get("size") or 0) + (f.get("size") or 0)
                if tot > 0:
                    g["price"] = ((g.get("price") or 0) * (g["size"] or 0) + (f.get("price") or 0) * (f.get("size") or 0)) / tot
                g["size"] = tot
                g["fee"] = (g.get("fee") or 0) + (f.get("fee") or 0)
                g["profit"] = (g.get("profit") or 0) + (f.get("profit") or 0)
                g["ts"] = f.get("ts", g.get("ts"))
                g["_ids"].append(fid(f))
            for f in merged[:MAX_BATCH]:
                seen_ts = f.get("ts", seen_ts)
                for _i in f["_ids"]:
                    seen_ids.add(_i); ids_list.append(_i)
                if t_now - (f.get("ts") or 0) > MAX_AGE_MS:
                    print(f"[vip-signals] skip stale {f.get('symbol')} fill ({int((t_now - f.get('ts', 0)) / 60000)}m old)", flush=True)
                    continue
                png = None
                try:
                    if f["tradeSide"] == "open":
                        side = "LONG" if f.get("side") == "buy" else "SHORT"
                        plan = find_plan(f["symbol"], side, plans)
                        cap = sig_text(f, plan, ctx)
                        sl, tps = sig_levels(f, plan, side, ctx)
                        png = f"/tmp/vip-{f['symbol']}-{int(f['ts'] / 1000)}.png"
                        try:
                            TGC.render_signal(f["symbol"], side.lower(), f["price"], sl, tps, png,
                                              title=f"{side} {f['symbol']}",
                                              stats=(f"{plan.get('strategy','')} · score {plan.get('score')}" if plan else "mandate / ignition"))
                        except Exception as ce:
                            print("[vip-signals] chart err:", str(ce)[:90], "— retry 15m", flush=True)
                            try:
                                TGC.render_signal(f["symbol"], side.lower(), f["price"], sl, tps, png, gran="15m",
                                                  title=f"{side} {f['symbol']}")
                            except Exception as ce2:
                                print("[vip-signals] chart retry failed:", str(ce2)[:90], flush=True)
                                png = None
                        if await send(ch, cap, png):
                            st["entries"][f["symbol"] + ":" + side] = {"px": f["price"], "ts": f["ts"]}
                    else:
                        side = "LONG" if f.get("side") == "sell" else "SHORT"
                        ent = st["entries"].pop(f["symbol"] + ":" + side, None)
                        epx = ent["px"] if isinstance(ent, dict) else ent
                        ets = ent.get("ts") if isinstance(ent, dict) else None
                        cap = close_text(f, epx)
                        png = f"/tmp/vip-close-{f['symbol']}-{int(f['ts'] / 1000)}.png"
                        try:
                            mfe = mfe_of(f["symbol"], side.lower(), ets, f["ts"]) if epx else None
                            pnl = (f.get("profit") or 0) - (f.get("fee") or 0)
                            TGC.render(f["symbol"], side.lower(), epx or f["price"], f["price"], mfe,
                                       f"CLOSED {side} {f['symbol']}",
                                       f"net ${pnl:+.2f}", png)
                        except Exception as ce:
                            print("[vip-signals] close chart err:", str(ce)[:90], flush=True)
                            png = None
                        await send(ch, cap, png)
                except Exception as e:
                    print("[vip-signals] post err:", str(e)[:80], flush=True)
                if png and os.path.exists(png):
                    try: os.remove(png)
                    except Exception: pass
                await asyncio.sleep(1.5)
            if new:
                st["seen"] = seen_ts
                st["ids"] = ids_list[-300:]
                st["entries"] = dict(list(st["entries"].items())[-50:])
                json.dump(st, open(STATE, "w"))

            # daily desk brief — the fund ritual, automated: equity, open
            # book, 24h realized, breaker state. Once per UTC day ~00:10.
            today = time.strftime("%Y-%m-%d")
            if time.strftime("%H:%M") >= "00:10" and st.get("brief") != today:
                st["brief"] = today
                json.dump(st, open(STATE, "w"))
                try:
                    ll = load_json(BASE + "/api/live-ledger.json", {}) or {}
                    cb = ll.get("circuitBreakers") or {}
                    mk = load_json(BASE + "/api/markouts.json", {}) or {}
                    d60s = [r["d60"] for r in mk.get("rows", []) if r.get("d60") is not None]
                    med = sorted(d60s)[len(d60s) // 2] if d60s else None
                    pos = ll.get("positions") or []
                    posl = "  \n".join(
                        f"  • {p['symbol']} {p['side'].upper()} {p.get('lev','?')}x · upl ${(p.get('upl') or 0):+.2f} · liq {fmtp(p.get('liq') or 0)}"
                        for p in pos) or "  flat"
                    msg = (
                        f"🌅 <b>DESK BRIEF — {today}</b>\n\n"
                        f"Equity <b>${ll.get('equityUsd','?')}</b> · 24h realized <b>${(cb.get('net24Usd') or 0):+.2f}</b> · fees ${(cb.get('fees24Usd') or 0):.2f}\n"
                        f"WR(last20) {cb.get('winRate20','?')}% · breaker: <i>{'🔴 ' + str(cb.get('tripped'))[:80] if cb.get('tripped') else '🟢 clear'}</i>\n"
                        f"Open book:\n{posl}\n"
                        + (f"Exit quality: med 60s post-exit drift {med:+.2f}% over {len(d60s)} fills\n" if med is not None else "")
                        + "\n<i>Every fill auditable: 52-65-5-228.sslip.io/gallery.html</i>"
                    )
                    await send(ch, msg)
                except Exception as e:
                    print("[vip-signals] brief err:", str(e)[:80], flush=True)
            # ---- structure cards (operator order 2026-10-14: real charts
            # in the signals channel — triangle geometry with the break +
            # retest drawn, posted at the two proof beats). PNGs land in
            # api/charts/ so the gallery carries identical evidence.
            try:
                sf = load_json(BASE + "/state/cmd-setups.json", {}) or {}
                scur = st.setdefault("setupCards", {})
                posted = 0
                for s in (sf.get("setups") or [])[-40:]:
                    if posted >= 2:
                        break
                    sid = s.get("id") or "?"
                    sym = s.get("symbol"); stt = s.get("status"); stg = s.get("stage")
                    if not sym or not sid:
                        continue
                    key2 = sid + ":" + str(stt) + ":" + str(stg or "")
                    if scur.get(sid) == key2:
                        continue
                    # structure lanes only — geometry-backed setups earn cards
                    if not (s.get("auto") or (s.get("strategy") or "") in
                            ("sentinel-structure", "pump-short")):
                        scur[sid] = key2
                        continue
                    lbl = None
                    if stt == "armed" and stg == "await-retest":
                        lbl = "BREAK PRINTED — awaiting retest"
                    elif stt in ("triggered", "filled"):
                        lbl = "CONFIRMED — entry live"
                    if not lbl:
                        scur.setdefault(sid, key2)
                        continue
                    scur[sid] = key2
                    posted += 1
                    side = (s.get("direction") or "LONG")
                    ent, slpx = s.get("entryPx"), s.get("slPx")
                    tpsx = [t.get("px") for t in (s.get("tps") or []) if t.get("px")]
                    png = "%s/api/charts/%s-%s.png" % (
                        BASE, re.sub(r"[^A-Za-z0-9_-]", "_", sid)[:34], (stg or stt))
                    try:
                        _st = "entry %s · SL %s · TPs %s" % (
                            fmtp(ent or 0), fmtp(slpx or 0),
                            " / ".join(fmtp(t) for t in tpsx) or "—")
                        if not TGC.render_structure_tv(
                                sym, side.lower(), ent, slpx, tpsx, png,
                                gran="15m", break_px=s.get("breakPx"),
                                stage=lbl, anchors=s.get("anchors"),
                                pattern=s.get("pattern"),
                                title="%s %s — %s" % (sym, side, lbl),
                                stats=_st):
                            TGC.render_structure(
                                sym, side.lower(), ent, slpx, tpsx, png,
                                gran="15m", break_px=s.get("breakPx"),
                                stage=lbl, anchors=s.get("anchors"),
                                title="%s %s — %s" % (sym, side, lbl),
                                stats=_st)
                        cap = ("<b>%s</b> — <b>%s %s</b>\n"
                               "entry <code>%s</code> · SL <code>%s</code> · TPs %s\n"
                               "<i>%s</i>" % (
                                   lbl, sym, side,
                                   fmtp(ent or 0), fmtp(slpx or 0),
                                   " / ".join(fmtp(t) for t in tpsx) or "—",
                                   esc(str(s.get("note") or ""))[:180]))
                        await send(ch, cap, png)
                    except Exception as ce:
                        print("[vip-signals] structure card err:", str(ce)[:90], flush=True)
                st["setupCards"] = dict(list(scur.items())[-300:])
                if posted:
                    json.dump(st, open(STATE, "w"))
            except Exception as e:
                print("[vip-signals] setup watcher err:", str(e)[:90], flush=True)
            backoff = POLL
        except Exception as e:
            print("[vip-signals] loop err:", str(e)[:100], flush=True)
            backoff = min(backoff * 2, 300)
        await asyncio.sleep(backoff)

if __name__ == "__main__":
    asyncio.run(main())
