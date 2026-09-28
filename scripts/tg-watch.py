#!/usr/bin/env python3
"""tg-watch.py — VIP signal-group watcher + Telegram command & control centre.

Reads the user's Telegram group (via Telethon user account), parses signal
messages, and writes state/tg-confluence.json for the scanner. Signals are
CONFLUENCE ONLY — the engine still scores them itself.

C2 layer: the operator messages their own Saved Messages with /commands —
those land as outgoing events from this account (unreachable by anyone
else, zero bot-token needed). Answers are sent back to Saved Messages.
Control commands write state/cmd-*.json files the executor consumes.

Config: scripts/tg-config.json  { "api_id": int, "api_hash": str, "group": str|int }
First run needs phone + login code once; session persists in tg-session.session.
"""
import asyncio, json, os, re, subprocess, sys, time
from pathlib import Path
from telethon import TelegramClient, events
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
CFG_PATH = ROOT / "scripts" / "tg-config.json"
OUT_PATH = ROOT / "state" / "tg-confluence.json"
SESSION = str(ROOT / "scripts" / "tg-session")
MAX_AGE_S = 24 * 3600  # keep signals a day; scanner decides freshness

# ---- signal parsing -------------------------------------------------------
# covers common VIP formats:
#   "BTC/USDT LONG", "BTCUSDT buy", "$ETH short", "LONG #SOL @ 180"
#   entry/tp/sl lines: "Entry: 1.234", "TP1: 1.5", "SL: 1.1"
SYM_RE = re.compile(r"(?:\$|#)?([A-Z]{2,12})\s*(?:[/\-_ ]?\s*(?:USDT|USDC|PERP|USD))?", re.I)
SIDE_RE = {
    "long": re.compile(r"\b(long|buy|bull(?:ish)?)\b", re.I),
    "short": re.compile(r"\b(short|sell|bear(?:ish)?)\b", re.I),
}
ENTRY_KW = re.compile(r"\b(?:entry|enter|buy\s*at|entry\s*zone|entry\s*between|range)\b", re.I)
TP_KW = re.compile(r"\b(?:tps?|targets?|take\s*profit)\b", re.I)
SL_KW = re.compile(r"\b(?:sl|stop(?:loss|\s*loss)?)\b", re.I)
# numbers NOT preceded by a word char (skips TP2/X50) and NOT followed by
# ")" (skips "1)" enumeration ordinals) — catches real prices only
NUM_RE = re.compile(r"(?<![\w.])([0-9]*\.?[0-9]+)(?!\s*[\)%])")
TAGGED_RE = re.compile(r"(?:\$|#)([A-Z]{2,15}?)(?:\s*/\s*(?:USDT|USDC|PERP|USD))?(?![A-Za-z])", re.I)
PAIR_RE = re.compile(r"\b([A-Z]{2,12})\s*/\s*(?:USDT|USDC|PERP|USD)\b", re.I)
# words that look like symbols but aren't tradable assets
STOPWORDS = {
    "LONG", "SHORT", "BUY", "SELL", "ENTRY", "TP", "SL", "TARGET", "VIP", "SIGNAL",
    "NEW", "UPDATE", "ALERT", "SETUP", "TRADE", "STOP", "PROFIT", "LEVERAGE", "LEV",
    "RISK", "SPOT", "FUTURES", "PERP", "THE", "AND", "FOR", "ALL", "NOW", "UTC", "CMP",
    "PRICE", "ACTION", "STRATEGY", "COIN", "DIRECTION", "MARKET", "ANALYSIS", "ZONE",
}


def nums_after(kw_rx, text, span=140):
    m = kw_rx.search(text)
    return NUM_RE.findall(text[m.end():m.end() + span]) if m else []


def parse_signal(text: str, ts_ms: int):
    """Extract (asset, side, entry, tps, sl) from a message, or None."""
    side = next((s for s, rx in SIDE_RE.items() if rx.search(text)), None)
    if not side:
        return None
    asset = None
    # prefer $/#-tagged or BASE/QUOTE pair tokens — they disambiguate real
    # symbols from look-alike words like "Price"/"Coin"
    for tok in TAGGED_RE.findall(text) + PAIR_RE.findall(text):
        t = tok.upper()
        if t not in STOPWORDS:
            asset = t
            break
    if not asset:
        for m in SYM_RE.finditer(text):
            tok = m.group(1).upper()
            if 2 <= len(tok) <= 12 and tok not in STOPWORDS:
                asset = tok
                break
    if not asset:
        return None
    asset = re.sub(r"(?:USDT|USDC|PERP|USD)$", "", asset)  # BTCUSDT -> BTC
    en = nums_after(ENTRY_KW, text)
    entry = en[0] if en else None
    tps = nums_after(TP_KW, text)[:6]
    sn = nums_after(SL_KW, text)
    sl = sn[0] if sn else None
    return {
        "asset": asset, "side": side, "ts": ts_ms,
        "entry": entry, "tps": tps, "sl": sl,
        "raw": re.sub(r"\s+", " ", text).strip()[:160],
    }


def load_state():
    try:
        return json.loads(OUT_PATH.read_text())
    except Exception:
        return {"signals": []}


def save_state(state):
    OUT_PATH.parent.mkdir(exist_ok=True)
    state["updatedAt"] = int(time.time() * 1000)
    cutoff = int(time.time() * 1000) - MAX_AGE_S * 1000
    state["signals"] = [s for s in state["signals"] if s["ts"] >= cutoff][-200:]
    tmp = OUT_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.replace(OUT_PATH)


def add_signal(sig):
    state = load_state()
    # dedupe: same asset+side within 10min is the same signal
    for s in state["signals"]:
        if s["asset"] == sig["asset"] and s["side"] == sig["side"] and abs(s["ts"] - sig["ts"]) < 600_000:
            s.update({k: v for k, v in sig.items() if v not in (None, [], "")})
            save_state(state)
            return
    state["signals"].append(sig)
    save_state(state)


async def main():
    cfg = json.loads(CFG_PATH.read_text())
    client = TelegramClient(SESSION, cfg["api_id"], cfg["api_hash"])
    await client.start()  # first run: interactive phone+code

    wanted = str(cfg["group"]).lower()
    chats = []
    async for d in client.iter_dialogs():
        chats.append(d)
        if str(d.id) == wanted or wanted in (d.name or "").lower():
            group = d.entity
            break
    else:
        names = "\n".join(f"  {d.id}  {d.name}" for d in chats[:40])
        sys.exit(f"[tg] group '{cfg['group']}' not found. Recent dialogs:\n{names}")
    print(f"[tg] watching: {getattr(group, 'title', cfg['group'])} (id {group.id})")

    async def handle(msg):
        if not msg or not getattr(msg, "raw_text", None):
            return
        sig = parse_signal(msg.raw_text, int(msg.date.timestamp() * 1000))
        if sig:
            add_signal(sig)
            print(f"[tg] SIGNAL {sig['asset']} {sig['side'].upper()} "
                  f"entry={sig['entry']} tps={sig['tps']} sl={sig['sl']}")

    # backfill last day so restarts don't lose recent signals
    async for msg in client.iter_messages(group, limit=80):
        if msg.date.timestamp() * 1000 < int(time.time() * 1000) - MAX_AGE_S * 1000:
            break
        try:
            await handle(msg)
        except Exception as e:
            print(f"[tg] backfill message skipped: {type(e).__name__}: {e}", flush=True)

    @client.on(events.NewMessage(chats=group))
    async def on_new(ev):
        # a parsing/persist failure must not kill the listener — Telethon
        # propagates handler exceptions into the event loop
        try:
            await handle(ev.message)
        except Exception as e:
            print(f"[tg] handler error (ignored): {type(e).__name__}: {e}", flush=True)

    print("[tg] live — listening for new messages")

    # ================= COMMAND & CONTROL CENTRE =================
    # Private channel: Saved Messages. Messages the operator sends to
    # themselves arrive as OUTGOING events from this account — nobody else
    # can inject a command, no bot token required.
    me = await client.get_me()
    API_DIR = ROOT / "api"
    STATE_DIR = ROOT / "state"
    LINKS = "https://168-138-102-53.sslip.io"

    def api(name):
        try:
            return json.loads((API_DIR / f"{name}.json").read_text())
        except Exception:
            return None

    def statef(name):
        try:
            return json.loads((STATE_DIR / f"{name}.json").read_text())
        except Exception:
            return None

    def wstate(name, obj):
        try:
            STATE_DIR.mkdir(exist_ok=True)
            (STATE_DIR / f"{name}.json").write_text(json.dumps(obj))
        except Exception:
            pass

    def esc(s):
        return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def fmtp(x):
        if x is None: return "—"
        x = float(x)
        return f"{x:,.1f}" if x >= 100 else f"{x:,.3f}" if x >= 1 else f"{x:.4g}"

    def ago(ms):
        try:
            s = max(0, (time.time() * 1000 - ms) / 1000)
            return f"{int(s)}s" if s < 90 else f"{int(s/60)}m" if s < 5400 else f"{int(s/3600)}h"
        except Exception:
            return "?"

    def say(text):
        return client.send_message("me", text, parse_mode="html", link_preview=False)

    # ---- command handlers -------------------------------------------------
    def c_status():
        ll, sc, hp = api("live-ledger"), api("market-scanner"), api("health")
        hl = statef("cmd-halt") or {}
        halt = "⛔ OPERATOR HALT" if hl.get("halted") else "🟢 armed"
        eq = (ll or {}).get("equityUsd")
        return (f"<b>◈ SENTINEL COMMAND</b>\n"
                f"─────────────────────\n"
                f"Mode: <code>{(ll or {}).get('mode','?')}</code> · {halt}\n"
                f"Equity: <b>${fmtp(eq)}</b> · DD {(ll or {}).get('ddPct','—')}% · 24h {(ll or {}).get('dd24Pct','—')}%\n"
                f"Positions: <b>{len((ll or {}).get('positions') or [])}</b> open · margin free ${fmtp((ll or {}).get('marginFreeUsd'))}\n"
                f"Scanner: {ago(time.mktime(time.strptime(sc['refreshedAt'][:19],'%Y-%m-%dT%H:%M:%S'))*1000 if sc and sc.get('refreshedAt') else 0)} ago · {len((sc or {}).get('signals',[]))} signals · {(sc or {}).get('pairsScanned','?')} pairs\n"
                f"Ledger: {(ll or {}).get('realFillCount',0)} real fills · cycle {round(((ll or {}).get('cycleMs') or 0)/1000,1)}s\n"
                f"─────────────────────\n<i>/help for the full command card</i>")

    def c_pos():
        ll = api("live-ledger") or {}
        pos = ll.get("positions") or []
        if not pos:
            return "📭 <b>No open positions</b>"
        out = ["<b>◈ OPEN POSITIONS</b>", "─────────────────────"]
        for p in pos:
            mk = p.get("entry", 0) + (p.get("upl") or 0) / max(p.get("size") or 1e-9, 1e-9)
            liqd = abs(mk - (p.get("liq") or mk)) / mk * 100 if mk else 0
            arrow = "▲" if (p.get("upl") or 0) >= 0 else "▼"
            out.append(f"{arrow} <b>{p.get('symbol','?')}</b> {p.get('side','?').upper()} ×{p.get('size','?')}"
                       f" · {p.get('lev','?')}x {p.get('marginMode','')}\n"
                       f"   entry {fmtp(p.get('entry'))} → mark {fmtp(mk)}\n"
                       f"   upl <b>${(p.get('upl') or 0):+.3f}</b> · liq {fmtp(p.get('liq'))} ({liqd:.1f}% away)")
        return "\n".join(out)

    def c_eq():
        ll = api("live-ledger") or {}
        pk = statef(f"equity-peak-{ll.get('mode','live')}") or {}
        r = ll.get("risk") or {}
        return (f"<b>◈ EQUITY &amp; RISK RAILS</b>\n─────────────────────\n"
                f"Equity: <b>${fmtp(ll.get('equityUsd'))}</b> (peak ${fmtp(pk.get('peak'))})\n"
                f"Drawdown: {ll.get('ddPct','—')}% all-time · {ll.get('dd24Pct','—')}% rolling-24h\n"
                f"Free margin: ${fmtp(ll.get('marginFreeUsd'))}\n"
                f"Profile: <code>{r.get('riskProfile','?')}</code> ×{r.get('riskMultiplier','?')} · "
                f"kill at {r.get('killSwitchPct','?')}% DD · daily halt {r.get('dailyHaltPct','?')}%\n"
                f"Realized: {ll.get('realizedStats','—')}\n"
                f"<i>Rails are mechanical — they fire regardless of conviction.</i>")

    def c_sig():
        sc = api("market-scanner") or {}
        sigs = (sc.get("signals") or [])[:6]
        if not sigs:
            return "📡 <b>No signals on the board</b>"
        out = ["<b>◈ SIGNAL BOARD — top</b>", "─────────────────────"]
        for s in sigs:
            mtf = (s.get("ta") or {}).get("mtf") or {}
            out.append(f"<b>{s.get('asset','?')}</b> {s.get('direction','?')} · <code>{s.get('score','?')}</code> · {s.get('grade','?')} · tgt {s.get('targetPct','?')}%"
                       + (f"\n   <i>{esc(mtf.get('stack',''))}</i>" if mtf.get("stack") else ""))
        return "\n".join(out)

    def c_radar():
        v, b = api("volcore") or {}, api("breakouts") or {}
        out = ["<b>◈ ORDER-FLOW RADAR</b>", "─────────────────────"]
        ev = (v.get("events") or [])[:5]
        out += [f"• {e.get('kind','?')} {e.get('asset','?')} — {e.get('spikeX','?')}× vol" for e in ev] or ["• prints quiet"]
        be = [e for e in (b.get("events") or []) if e.get("state") in ("RETEST", "BREAKOUT")][:5]
        out += ["", "<b>Breakouts</b>"] + [f"• {e.get('state','?')} {e.get('asset','?')} {e.get('dir','')} @ {fmtp(e.get('level'))}" for e in be] or ["• none live"]
        return "\n".join(out)

    def c_mtf(arg):
        m = api("mtf") or {}
        rows = m.get("rows") or {}
        if arg:
            r = rows.get(arg.upper())
            if not r: return f"no MTF data for {esc(arg.upper())}"
            lines = [f"<b>◈ MTF — {esc(arg.upper())}</b>", "─────────────────────", f"<b>{esc(r.get('stack','?'))}</b>"]
            for tf in m.get("frames", []):
                c = (r.get("cells") or {}).get(tf)
                if c: lines.append(f"{tf:>4}: {'▲' if c.get('dir')=='bull' else '▼' if c.get('dir')=='bear' else '·'} {c.get('trend','?')} · RSI {round(c.get('rsi') or 0)} · MACD {c.get('macd','?')}")
            return "\n".join(lines)
        st = [a for a, r in rows.items() if r.get("kind") == "stacked"]
        pb = [a for a, r in rows.items() if r.get("kind") == "pullback"]
        return (f"<b>◈ MTF MATRIX</b>\n─────────────────────\n"
                f"Stacked: <b>{len(st)}</b> · Pullback: <b>{len(pb)}</b> · Mixed: {len(rows)-len(st)-len(pb)}\n"
                f"Stacked: {', '.join(f'{a}({rows[a].get('dir','?')})' for a in st[:8]) or '—'}\n"
                f"Pullback: {', '.join(pb[:8]) or '—'}\n<i>/mtf BTC for per-asset detail</i>")

    def c_soc():
        s = api("social") or {}
        mk, assets = s.get("market") or {}, s.get("assets") or {}
        fg = mk.get("fg") or {}
        top = sorted(assets.items(), key=lambda kv: -(kv[1].get("heat") or 0))[:8]
        return (f"<b>◈ SOCIAL RADAR</b>\n─────────────────────\n"
                f"Fear &amp; Greed: <b>{fg.get('v','—')} {esc(fg.get('c',''))}</b>\n"
                f"Trending: {', '.join(x.get('sym','') for x in (mk.get('trending') or [])[:6]) or '—'}\n─────────────────────\n"
                + "\n".join(f"{a}: score {v.get('score','—')} · heat {v.get('heat','—')}"
                          + (f" · trend#{v['trending']}" if v.get("trending") else "") for a, v in top)
                or "quiet")

    def c_ein():
        e = api("einstein") or {}
        f = (e.get("findings") or [])[:6]
        if not f: return "🧠 <b>Einstein:</b> lab warming — needs graded confl snapshots"
        return "<b>◈ EINSTEIN LAB</b>\n─────────────────────\n" + "\n".join(
            f"• <code>{x.get('key','?')}</code> {esc(x.get('txt',''))[:110]}" for x in f)

    def c_j():
        ev = api("signal-eval") or {}
        rec = (ev.get("records") or [])[-8:]
        done = [r for r in rec if r.get("outcome")]
        wins = sum(1 for r in done if (r.get("outcomePct") or 0) > 0)
        out = [f"<b>◈ TRADE JOURNAL</b>\n─────────────────────\n{len(done)} graded · {wins}W/{len(done)-wins}L shown"]
        for r in reversed(rec[-6:]):
            oc = r.get("outcome") or "open"
            p = r.get("outcomePct")
            out.append(f"{r.get('asset','?')} {r.get('direction','?')} — {oc} {f'{p:+.1f}%' if isinstance(p,(int,float)) else ''}")
        return "\n".join(out)

    def c_pulse():
        sc = api("market-scanner") or {}
        p, ov = sc.get("pulse") or {}, sc.get("overview") or {}
        return (f"<b>◈ MARKET PULSE</b>\n─────────────────────\n"
                f"▲ {ov.get('advancing','—')} / ▼ {ov.get('declining','—')} · breadth {p.get('breadthPct','—')}%\n"
                f"median Δ24h {p.get('medianDelta','—')}% · regime {esc(sc.get('regime','—'))}\n"
                f"boards: {len(sc.get('signals',[]))} signals · median score {sc.get('medianScore','—')}")

    def c_pause(arg):
        wstate("cmd-halt", {"halted": True, "reason": arg or "operator pause", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        return "⛔ <b>ENTRIES HALTED</b> — existing positions still managed. /resume to re-arm."

    def c_resume():
        wstate("cmd-halt", {"halted": False, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        return "🟢 <b>RE-ARMED</b> — entry gates live on next cycle."

    PENDING = {}
    def c_flatten(arg, chat_key):
        if arg.strip().upper() != "CONFIRM":
            PENDING[chat_key] = "flatten"
            return ("⚠️ <b>PANIC FLATTEN</b> — closes EVERY open position at market, "
                    "manual and engine alike. Irreversible.\nReply <code>/flatten CONFIRM</code> within 60s to execute.")
        if PENDING.pop(chat_key, None) != "flatten":
            return "no flatten armed — send /flatten first."
        wstate("cmd-flatten", {"flatten": True, "by": "telegram", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        return "🚨 <b>FLATTEN EXECUTING</b> — executor closes all positions next cycle."

    def c_help():
        return ("<b>◈ SENTINEL COMMAND CENTRE</b>\n─────────────────────\n"
                "<b>Intel</b>\n"
                "/status — godhead: equity, halt state, cycle health\n"
                "/pos — open positions: entry→mark, upl, liq distance\n"
                "/eq — equity curve + risk rails\n"
                "/sig — top signals + MTF stack\n"
                "/radar — volume prints + breakouts\n"
                "/mtf [ASSET] — timeframe matrix\n"
                "/soc — social radar + Fear&amp;Greed\n"
                "/ein — Einstein lab findings\n"
                "/j — journal recent + record\n"
                "/pulse — breadth / regime\n"
                "<b>Control</b>\n"
                "/pause [reason] — halt new entries\n"
                "/resume — re-arm entry gates\n"
                "/flatten — panic close ALL (CONFIRM-gated)\n"
                "/watch SYM above|below PX [note] — price trigger ping\n"
                "/watches — armed triggers · /unwatch SYM|ALL\n"
                "<b>Nav</b>\n"
                "/links — dashboard URLs\n"
                "/ping — liveness")

    def c_links():
        return (f"<b>◈ SURFACES</b>\n─────────────────────\n"
                f"🌐 <a href='{LINKS}'>Command deck</a>\n"
                f"🖼 <a href='{LINKS}/gallery.html'>Evidence gallery</a>\n"
                f"📄 <a href='https://wh0d4r35w1n5.github.io/sentinel-tactical-radar/'>GitHub Pages mirror</a>")

    def c_watch(arg):
        m = re.match(r"([A-Za-z0-9]+)\s+(above|below)\s+([0-9.]+)\s*(.*)", (arg or "").strip(), re.I)
        if not m:
            return "usage: <code>/watch CRO above 0.06966 reason…</code>"
        sym = m.group(1).upper()
        if not sym.endswith("USDT"):
            sym += "USDT"
        wl = statef("watchlist")
        if not isinstance(wl, list):
            wl = []
        wl.append({"sym": sym, "dir": m.group(2).lower(), "px": float(m.group(3)),
                   "note": m.group(4).strip(), "setAt": int(time.time() * 1000)})
        wstate("watchlist", wl)
        return (f"🎯 watch armed — <b>{sym}</b> {'▲' if m.group(2).lower()=='above' else '▼'} <b>{m.group(3)}</b>"
                + (f"\n<i>{esc(m.group(4).strip())}</i>" if m.group(4).strip() else ""))

    def c_watches(arg):
        wl = statef("watchlist")
        if not isinstance(wl, list) or not wl:
            return "🎯 <b>No watches armed</b> — <code>/watch SYM above|below PX</code>"
        return ("<b>◈ PRICE WATCHES</b>\n─────────────────────\n"
                + "\n".join(f"{w['sym']} {'▲' if w['dir']=='above' else '▼'} <b>{w['px']}</b>"
                           + (f" — {esc(w.get('note',''))[:60]}" if w.get("note") else "") for w in wl))

    def c_unwatch(arg):
        a = (arg or "").strip().upper()
        wl = statef("watchlist")
        if not isinstance(wl, list):
            wl = []
        if a == "ALL":
            wstate("watchlist", [])
            return f"🗑 cleared {len(wl)} watches"
        if not a.endswith("USDT"):
            a += "USDT"
        keep = [w for w in wl if w["sym"] != a]
        wstate("watchlist", keep)
        return f"🗑 removed {len(wl) - len(keep)} watch(es) on {a}"

    CMDS = {"status": c_status, "pos": c_pos, "positions": c_pos, "eq": c_eq, "equity": c_eq,
            "sig": c_sig, "signals": c_sig, "radar": c_radar, "mtf": c_mtf, "soc": c_soc,
            "social": c_soc, "ein": c_ein, "einstein": c_ein, "j": c_j, "journal": c_j,
            "pulse": c_pulse, "pause": c_pause, "resume": c_resume, "links": c_links,
            "help": c_help, "menu": c_help, "start": c_help, "watch": c_watch,
            "watches": c_watches, "unwatch": c_unwatch, "ping": lambda a: "🏓 sentinel live — " + time.strftime("%H:%M:%SZ", time.gmtime())}

    @client.on(events.NewMessage(outgoing=True))
    async def on_cmd(ev):
        m = ev.message
        try:
            if not m or not m.raw_text or not m.out:
                return
            if getattr(m.peer_id, "user_id", None) != me.id:
                return  # only Saved Messages (self) — spoof-proof by construction
            txt = m.raw_text.strip()
            if not txt.startswith("/"):
                return
            parts = txt.split(None, 1)
            cmd = parts[0].lstrip("/").lower().split("@")[0]
            arg = parts[1] if len(parts) > 1 else ""
            if cmd == "flatten":
                reply = c_flatten(arg, "me")
            elif cmd in CMDS:
                reply = CMDS[cmd](arg)
            else:
                reply = f"unknown command <code>{esc(cmd)}</code> — /help"
            await say(reply)
            print(f"[tg-c2] /{cmd} answered", flush=True)
        except Exception as e:
            print(f"[tg-c2] handler error: {type(e).__name__}: {e}", flush=True)

    def last_price(sym):
        try:
            u = ("https://api.bitget.com/api/v2/mix/market/ticker?symbol="
                 + sym + "&productType=USDT-FUTURES")
            with urllib.request.urlopen(u, timeout=10) as r:
                return float(json.loads(r.read())["data"][0]["lastPr"])
        except Exception:
            return None

    # ---- proactive alert loop — pushes intel to Saved Messages ------------
    async def alert_loop():
        alerted_path = STATE_DIR / "tg-alerted.json"
        try:
            alerted = set(json.loads(alerted_path.read_text()))
        except Exception:
            alerted = set()
        prev_pos, prev_halt, prev_dead = None, None, ""
        while True:
            try:
                scan = api("market-scanner") or {}
                for s in scan.get("signals", [])[-10:]:
                    k = f"sig:{s.get('asset')}:{s.get('direction')}:{s.get('emittedAt', s.get('updatedAt',''))[:13]}"
                    if k not in alerted and s.get("key"):
                        alerted.add(k)
                        mtf = ((s.get("ta") or {}).get("mtf") or {}).get("stack", "")
                        await say(f"⚡ <b>NEW SIGNAL</b> — <code>{s.get('asset')}</code> {s.get('direction')} · "
                                  f"score {s.get('score','?')} · {s.get('grade','?')}\n"
                                  f"tgt {s.get('targetPct','?')}%"
                                  + (f" · {esc(mtf)}" if mtf else ""))
                ll = api("live-ledger") or {}
                pos = {(p.get("symbol"), p.get("side")) for p in (ll.get("positions") or [])}
                if prev_pos is not None and pos != prev_pos:
                    for sym, side in pos - prev_pos:
                        p = next((x for x in ll["positions"] if x.get("symbol") == sym), {})
                        await say(f"📍 <b>OPENED</b> {sym} {side.upper()} ×{p.get('size','?')} @ {fmtp(p.get('entry'))} · {p.get('lev','?')}x")
                    for sym, side in prev_pos - pos:
                        await say(f"📕 <b>CLOSED</b> {sym} {side.upper()}")
                prev_pos = pos
                hl = (statef("cmd-halt") or {}).get("halted", False)
                if prev_halt is not None and hl != prev_halt:
                    await say("⛔ <b>ENTRIES HALTED</b> by operator" if hl else "🟢 <b>ENTRIES RE-ARMED</b>")
                prev_halt = hl
                # deadman — service heartbeat + ledger freshness. Catches the
                # failures nothing else reports: dead executor, dead guard,
                # stalled ledger. (A dead VPS can't self-report — external
                # watchdogs cover total box loss.)
                dead = []
                for svc in ("sentinel-rapid.service", "sentinel-liq-guard.service"):
                    try:
                        if subprocess.run(["systemctl", "is-active", "--quiet", svc]).returncode != 0:
                            dead.append(svc.replace("sentinel-", "").replace(".service", ""))
                    except Exception:
                        pass
                try:
                    led_age = (time.time() - os.path.getmtime(ROOT / "api" / "live-ledger.json")) / 60
                    if led_age > 3:
                        dead.append(f"ledger stale {led_age:.0f}m")
                except Exception:
                    pass
                dk = "|".join(dead)
                if dk != prev_dead:
                    prev_dead = dk
                    if dk:
                        await say("\U0001F6A8 <b>DEADMAN</b> — " + esc(dk))
                    else:
                        await say("\U0001FAC0 <b>DEADMAN CLEAR</b> — services + ledger alive")
                # outbox — other services (liq-guard etc.) drop JSONL lines
                # here; we deliver them to Saved Messages
                op = STATE_DIR / "tg-outbox.jsonl"
                try:
                    if op.exists():
                        for l in op.read_text().splitlines():
                            try:
                                t = json.loads(l).get("text")
                                if t:
                                    await say(t)
                            except Exception:
                                pass
                        op.unlink()
                except Exception as e:
                    print(f"[tg-c2] outbox: {type(e).__name__}: {e}", flush=True)

                # daily digest — one situational report per UTC day
                today = time.strftime("%Y-%m-%d")
                if time.strftime("%H:%M") >= "00:05" and statef("digest-last") != today:
                    wstate("digest-last", today)
                    try:
                        ll2 = api("live-ledger") or {}
                        day0 = int(time.mktime(time.strptime(today, "%Y-%m-%d")) * 1000)
                        fills = (statef("real-fills") or {}).get("fills", [])
                        bf = [f for f in fills if f.get("src") == "api" and (f.get("ts") or 0) >= day0]
                        mf = [f for f in fills if f.get("src") not in (None, "api") and (f.get("ts") or 0) >= day0]
                        bpnl = round(sum((f.get("profit") or 0) - (f.get("fee") or 0) for f in bf), 2)
                        mpnl = round(sum((f.get("profit") or 0) - (f.get("fee") or 0) for f in mf), 2)
                        topg = sorted(((api("gate-stats") or {}).get("totals24h") or {}).items(), key=lambda kv: -kv[1])[:4]
                        tops = " \u00b7 ".join(f"{k}\u00d7{v}" for k, v in topg) or "none"
                        posl = ", ".join(f"{p.get('symbol')} {p.get('side')} upl {round(p.get('upl') or 0, 2)}" for p in (ll2.get("positions") or [])) or "flat"
                        await say(
                            "\U0001F4CB <b>DAILY DIGEST</b> " + today + "\n"
                            f"equity ${ll2.get('equityUsd','?')} \u00b7 dd {ll2.get('ddPct','?')}%\n"
                            f"today — bot {len(bf)} fills ({bpnl:+.2f}) \u00b7 manual {len(mf)} ({mpnl:+.2f})\n"
                            f"open: {esc(posl)}\n"
                            f"top reject gates 24h: {esc(tops)}"
                        )
                    except Exception as e:
                        print(f"[tg-c2] digest: {type(e).__name__}: {e}", flush=True)

                # price watches — consume-on-hit triggers from state/watchlist.json
                wl = statef("watchlist")
                if isinstance(wl, list):
                    for w in list(wl):
                        try:
                            px = await asyncio.get_event_loop().run_in_executor(None, last_price, w["sym"])
                            if px is None:
                                continue
                            hit = (w["dir"] == "above" and px >= w["px"]) or \
                                  (w["dir"] == "below" and px <= w["px"])
                            if hit:
                                wl.remove(w)
                                wstate("watchlist", wl)
                                ar = "▲" if w["dir"] == "above" else "▼"
                                await say(f"🎯 <b>WATCH HIT</b> — <code>{esc(w['sym'])}</code> {ar} <b>{w['px']}</b> (now {fmtp(px)})"
                                          + (f"\n<i>{esc(w.get('note',''))}</i>" if w.get("note") else ""))
                        except Exception as e:
                            print(f"[tg-c2] watch {w.get('sym')}: {type(e).__name__}: {e}", flush=True)
                alerted_path.parent.mkdir(exist_ok=True)
                alerted_path.write_text(json.dumps(list(alerted)[-400:]))
            except Exception as e:
                print(f"[tg-c2] alert loop: {type(e).__name__}: {e}", flush=True)
            await asyncio.sleep(30)

    asyncio.create_task(alert_loop())
    await say("<b>◈ SENTINEL C2 ONLINE</b>\nCommand surface live — /help for the card\nAlerts armed: signals · positions · halts")
    await client.run_until_disconnected()


if __name__ == "__main__":
    while True:
        try:
            asyncio.run(main())
            break
        except (ConnectionError, OSError, asyncio.TimeoutError) as e:
            print(f"[tg] connection lost ({type(e).__name__}: {e}) — reconnecting in 20s", flush=True)
            time.sleep(20)
        except KeyboardInterrupt:
            break
