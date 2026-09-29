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
import asyncio, inspect, json, os, re, subprocess, sys, time
from pathlib import Path
from telethon import TelegramClient, events, Button
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
        return (f"<b>🛰️ SENTINEL COMMAND</b>\n"
                f"─────────────────────\n"
                f"Mode: <code>{(ll or {}).get('mode','?')}</code> · {halt}\n"
                f"Equity: <b>${fmtp(eq)}</b> · DD {(ll or {}).get('ddPct','—')}% · 24h {(ll or {}).get('dd24Pct','—')}%\n"
                f"Positions: <b>{len((ll or {}).get('positions') or [])}</b> open · margin free ${fmtp((ll or {}).get('marginFreeUsd'))}\n"
                f"🏦 Vault: <b>${fmtp((ll or {}).get('vaultUsd'))}</b> locked · ⚖️ edge {(ll or {}).get('edgeLive','—')}\n"
                f"Scanner: {ago(time.mktime(time.strptime(sc['refreshedAt'][:19],'%Y-%m-%dT%H:%M:%S'))*1000 if sc and sc.get('refreshedAt') else 0)} ago · {len((sc or {}).get('signals',[]))} signals · {(sc or {}).get('pairsScanned','?')} pairs\n"
                f"Ledger: {(ll or {}).get('realFillCount',0)} real fills · cycle {round(((ll or {}).get('cycleMs') or 0)/1000,1)}s\n"
                f"─────────────────────\n<i>/help for the full command card</i>")

    def c_pos():
        ll = api("live-ledger") or {}
        pos = ll.get("positions") or []
        if not pos:
            return "📭 <b>No open positions</b>"
        out = ["<b>📊 OPEN POSITIONS</b>", "─────────────────────"]
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
        return (f"<b>🏦 EQUITY &amp; RISK RAILS</b>\n─────────────────────\n"
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
        out = ["<b>📡 SIGNAL BOARD — top</b>", "─────────────────────"]
        for s in sigs:
            mtf = (s.get("ta") or {}).get("mtf") or {}
            out.append(f"<b>{s.get('asset','?')}</b> {s.get('direction','?')} · <code>{s.get('score','?')}</code> · {s.get('grade','?')} · tgt {s.get('targetPct','?')}%"
                       + (f"\n   <i>{esc(mtf.get('stack',''))}</i>" if mtf.get("stack") else ""))
        return "\n".join(out)

    def c_radar():
        v, b = api("volcore") or {}, api("breakouts") or {}
        out = ["<b>🌊 ORDER-FLOW RADAR</b>", "─────────────────────"]
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
            lines = [f"<b>🧮 MTF — {esc(arg.upper())}</b>", "─────────────────────", f"<b>{esc(r.get('stack','?'))}</b>"]
            for tf in m.get("frames", []):
                c = (r.get("cells") or {}).get(tf)
                if c: lines.append(f"{tf:>4}: {'▲' if c.get('dir')=='bull' else '▼' if c.get('dir')=='bear' else '·'} {c.get('trend','?')} · RSI {round(c.get('rsi') or 0)} · MACD {c.get('macd','?')}")
            return "\n".join(lines)
        st = [a for a, r in rows.items() if r.get("kind") == "stacked"]
        pb = [a for a, r in rows.items() if r.get("kind") == "pullback"]
        return (f"<b>🧮 MTF MATRIX</b>\n─────────────────────\n"
                f"Stacked: <b>{len(st)}</b> · Pullback: <b>{len(pb)}</b> · Mixed: {len(rows)-len(st)-len(pb)}\n"
                f"Stacked: {', '.join(f'{a}({rows[a].get('dir','?')})' for a in st[:8]) or '—'}\n"
                f"Pullback: {', '.join(pb[:8]) or '—'}\n<i>/mtf BTC for per-asset detail</i>")

    def c_soc():
        s = api("social") or {}
        mk, assets = s.get("market") or {}, s.get("assets") or {}
        fg = mk.get("fg") or {}
        top = sorted(assets.items(), key=lambda kv: -(kv[1].get("heat") or 0))[:8]
        return (f"<b>📣 SOCIAL RADAR</b>\n─────────────────────\n"
                f"Fear &amp; Greed: <b>{fg.get('v','—')} {esc(fg.get('c',''))}</b>\n"
                f"Trending: {', '.join(x.get('sym','') for x in (mk.get('trending') or [])[:6]) or '—'}\n─────────────────────\n"
                + "\n".join(f"{a}: score {v.get('score','—')} · heat {v.get('heat','—')}"
                          + (f" · trend#{v['trending']}" if v.get("trending") else "") for a, v in top)
                or "quiet")

    def c_ein():
        e = api("einstein") or {}
        f = (e.get("findings") or [])[:6]
        if not f: return "🧠 <b>Einstein:</b> lab warming — needs graded confl snapshots"
        return "<b>🧬 EINSTEIN LAB</b>\n─────────────────────\n" + "\n".join(
            f"• <code>{x.get('key','?')}</code> {esc(x.get('txt',''))[:110]}" for x in f)

    def c_j():
        ev = api("signal-eval") or {}
        rec = (ev.get("records") or [])[-8:]
        done = [r for r in rec if r.get("outcome")]
        wins = sum(1 for r in done if (r.get("outcomePct") or 0) > 0)
        out = [f"<b>📜 TRADE JOURNAL</b>\n─────────────────────\n{len(done)} graded · {wins}W/{len(done)-wins}L shown"]
        for r in reversed(rec[-6:]):
            oc = r.get("outcome") or "open"
            p = r.get("outcomePct")
            out.append(f"{r.get('asset','?')} {r.get('direction','?')} — {oc} {f'{p:+.1f}%' if isinstance(p,(int,float)) else ''}")
        return "\n".join(out)

    def c_pulse():
        sc = api("market-scanner") or {}
        p, ov = sc.get("pulse") or {}, sc.get("overview") or {}
        return (f"<b>💓 MARKET PULSE</b>\n─────────────────────\n"
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
        return ("<b>🛰️ SENTINEL COMMAND CENTRE</b>\n─────────────────────\n"
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
                "<b>Deep Intel</b>\n"
                "/fills — real fills w/ net P&amp;L\n"
                "/vault — wealth vault sweeps + balance\n"
                "/quant — CUSUM edge-death · Kelly · breakers\n"
                "/regime — market type + per-regime expectancy\n"
                "/sqn — strategy SQN leaderboard\n"
                "/gates — 24h reject histogram\n"
                "/god — overseer audit findings\n"
                "/plan — live order plan + rejects\n"
                "/corr — correlation clusters\n"
                "/ta SYM — full engine read (wyckoff·elliott·harmonics·sakata)\n"
                "<b>Control</b>\n"
                "/close SYM — close one position (CONFIRM-gated)\n"
                "/hold SYM · /unhold SYM · /holds — hands-off list\n"
                "/deny SYM · /allow SYM · /denied — entry blacklist\n"
                "/risk [0–8] — size multiplier override\n"
                "/hud — live self-editing status tile\n"
                "<b>Setup Builder</b> — operator entries, VEMA-style\n"
                "/setup SYM long|short market|bounce|br … — CONFIRM-gated\n"
                "/setups — live setup board · /unsetup S-xxxx — cancel\n"
                "<b>Nav</b>\n"
                "/links — dashboard URLs\n"
                "/ping — liveness\n"
                "<i>or just send a raw emoji: 📊 💰 📡 🌡 🧠 📐 ⚖️ ⏸ ▶️ 🚨</i>")

    def c_links():
        return (f"<b>🗺 SURFACES</b>\n─────────────────────\n"
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
        return ("<b>🎯 PRICE WATCHES</b>\n─────────────────────\n"
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

    # ================= EXTENDED OS SURFACE =================
    # intel + control — every artifact the engine publishes, plus the
    # command files the executor consumes next cycle.

    def spark(vals, width=16):
        BARS = "▁▂▃▄▅▆▇█"
        vs = [float(v) for v in vals if isinstance(v, (int, float))][-width:]
        if len(vs) < 2:
            return "—"
        lo, hi = min(vs), max(vs)
        rg = hi - lo or 1
        return "".join(BARS[min(7, int((v - lo) / rg * 7.999))] for v in vs)

    def fills_file():
        ll = api("live-ledger") or {}
        return statef("demo-fills" if ll.get("mode") == "demo" else "real-fills") or {}

    def c_fills():
        fs = (fills_file().get("fills") or [])[-8:]
        if not fs:
            return "📒 <b>No fills yet this epoch</b>"
        out = ["<b>📒 REAL FILLS</b>", "─────────────────────"]
        for f in reversed(fs):
            p = (f.get("profit") or 0) - (f.get("fee") or 0)
            ts = f.get("ts", 0)
            out.append(f"{'🟢' if p > 0 else '🔴' if p < 0 else '⚪'} <b>{f.get('symbol','?')}</b> {f.get('tradeSide','?')} "
                       f"{f.get('side','?')} {f.get('size','?')} @ {fmtp(f.get('price'))} · <b>${p:+.2f}</b> · {ago(ts)} ago")
        return "\n".join(out)

    def c_vault():
        v = statef("wealth-vault") or {}
        ll = api("live-ledger") or {}
        sw = (v.get("sweeps") or [])[-5:]
        out = ["<b>🏦 WEALTH VAULT</b>", "─────────────────────",
               f"Locked: <b>${fmtp(v.get('balanceUsd'))}</b> — untouchable, 50% of every profitable close",
               f"Sweeps: <b>{len(v.get('sweptIds') or {})}</b> fills taxed"]
        for s in reversed(sw):
            out.append(f"• {s.get('symbol','?')} +${s.get('amountUsd',0):.2f} · {ago(s.get('ts',0))} ago")
        if ll.get("vaultUsd") is not None:
            out.append(f"<i>ledger sees ${fmtp(ll['vaultUsd'])}</i>")
        return "\n".join(out)

    def c_quant():
        ll = api("live-ledger") or {}
        cb = ll.get("circuitBreakers") or {}
        ed, ky = cb.get("edgeDeath") or {}, cb.get("kelly")
        out = ["<b>🧠 QUANT LAYER</b>", "─────────────────────"]
        out.append(f"Edge: <b>{ll.get('edgeLive','—')}</b> ({esc(ll.get('edgeSrc','?'))})")
        if ed:
            armed = "🔴 TRIPPED" if ed.get("S", 0) > ed.get("h", 1e9) else "🟢 armed"
            out.append(f"CUSUM edge-death: {armed} S={round(ed.get('S',0),2)}/h={round(ed.get('h',0),1)} · n={ed.get('n',0)} · mean ${round(ed.get('meanUsd',0),2)}/close")
        else:
            out.append("CUSUM edge-death: dormant")
        out.append(f"Kelly ceiling: {('f*=' + str(round(ky.get('fStar',0),3)) + ' → cap $' + str(round(ky.get('halfKellyRiskUsd',0),2)) + ' · n=' + str(ky.get('n',0))) if ky else 'dormant (n<15)'}")
        out.append(f"Breakers: <b>{'⚠️ ' + esc(str(cb.get('tripped'))) if cb.get('tripped') else 'clear'}</b>")
        out.append(f"24h: net ${round(cb.get('net24Usd',0),2)} · fees ${round(cb.get('fees24Usd',0),2)} · WR20 {cb.get('winRate20','—')}%")
        try:
            meta = statef("meta-label") or {}
            if meta.get("signals"): out.append(f"Meta-label: {meta.get('signals')} graded signals in model")
        except Exception:
            pass
        return "\n".join(out)

    def c_regime():
        sc = api("market-scanner") or {}
        ov = sc.get("overview") or {}
        lp = api("live-plan") or {}
        rs = (api("live-ledger") or {}).get("realizedStats") or {}
        out = ["<b>🌡 REGIME</b>", "─────────────────────",
               f"Type: <b>{esc(lp.get('mktType') or ov.get('mktType') or sc.get('regime','—'))}</b>",
               f"Market SQN: <b>{lp.get('marketSQN', ov.get('marketSQN','—'))}</b> · ATR {ov.get('atrPct','—')}%"]
        bmt = rs.get("byMktType") or {}
        if bmt:
            out.append("— expectancy by regime —")
            for k, v in list(bmt.items())[:5]:
                out.append(f"  {esc(k)}: {v.get('n',0)} closes · net ${round(v.get('netUsd',0),2)} · WR {v.get('winRatePct','—')}%")
        return "\n".join(out)

    def c_sqn():
        r = api("sqn-report") or {}
        per = r.get("perStrategy") or []
        if not per:
            return "📐 <b>SQN report empty</b> — needs graded closes"
        out = ["<b>📐 SQN LEADERBOARD</b>", "─────────────────────", "<i>E·√n/σ per strategy, shrunk</i>"]
        for s in sorted(per, key=lambda x: -(x.get("shrunkSqn") or -9))[:8]:
            em = "🟢" if (s.get("shrunkSqn") or 0) > 0 else "🔴"
            out.append(f"{em} {esc(s.get('strategy','?'))}: sqn100 {s.get('shrunkSqn','—')} · E {s.get('E','—')}R · n{s.get('n',0)} · hit {s.get('hit','—')}%")
        ch = r.get("chain") or {}
        if ch.get("members"):
            out.append(f"── chain: {' + '.join(ch['members'])} · sqn {ch.get('shrunkSqn','—')}")
        return "\n".join(out)

    def c_gates():
        g = api("gate-stats") or {}
        t = g.get("totals24h") or g.get("totals") or {}
        if not t:
            return "🚧 <b>No gate stats</b>"
        top = sorted(t.items(), key=lambda kv: -kv[1])[:10]
        mx = max(v for _, v in top) or 1
        out = ["<b>🚧 REJECT GATES — 24h</b>", "─────────────────────"]
        for k, v in top:
            bar = "█" * max(1, int(v / mx * 10))
            out.append(f"<code>{k:<20}</code> {bar} {v}")
        return "\n".join(out)

    def c_god():
        g = api("god") or {}
        checks = g.get("checks") or []
        if not checks and not g.get("verdict"):
            return "🌩 <b>GOD report unreadable</b>"
        verdict = g.get("verdict", "—")
        em = {"CLEAN": "🟢", "BROKEN": "🔴", "WARN": "🟡"}.get(verdict, "⚪")
        out = ["<b>🌩 GOD AUDIT</b>", "─────────────────────",
               f"{em} verdict <b>{esc(str(verdict))}</b> · {g.get('pass',0)} pass · {g.get('warn',0)} warn · {g.get('fail',0)} fail",
               f"<i>{ago(int(time.mktime(time.strptime((g.get('at') or '')[:19], '%Y-%m-%dT%H:%M:%S'))*1000) if g.get('at') else 0)} ago</i>"]
        for c in checks:
            if c.get("status") in ("FAIL", "WARN"):
                out.append(f"{'🔴' if c.get('status')=='FAIL' else '🟡'} {esc(c.get('name','?'))} — {esc(str(c.get('detail',''))[:80])}")
        if not any(c.get("status") in ("FAIL", "WARN") for c in checks):
            out.append("all clear ✓")
        return "\n".join(out)

    def c_plan():
        lp = api("live-plan") or {}
        ll = api("live-ledger") or {}
        od = lp.get("orders") or []
        rj = (ll.get("rejects") or [])[:8]
        out = ["<b>🗺 LIVE PLAN</b>", "─────────────────────",
               f"{len(od)} orders · mkt {esc(lp.get('mktType','—'))}"]
        for o in od[:6]:
            out.append(f"• {o.get('symbol','?')} {o.get('direction','?')} · lev {o.get('leverage','?')}x · stop {o.get('stopPct','?')}% · conv {o.get('conv','—')}")
        if rj:
            out.append("— top rejects —")
            for r in rj[:5]:
                out.append(f"✕ {r.get('symbol','?')} {r.get('direction','?')}: <i>{esc(', '.join(r.get('gates') or []))}</i>")
        return "\n".join(out)

    def c_corr():
        c = api("correlation") or {}
        pairs = c.get("pairs") or c.get("matrix") or {}
        ll = api("live-ledger") or {}
        held = [p.get("symbol") for p in (ll.get("positions") or [])]
        out = ["<b>🧬 CORRELATION</b>", "─────────────────────",
               f"mean board corr: {c.get('meanBoardCorr','—')}"]
        for s in held[:6]:
            row = pairs.get(s) or {}
            hot = sorted(row.items(), key=lambda kv: -abs(kv[1]))[:3]
            if hot:
                out.append(f"{s}: " + ", ".join(f"{k} {round(v,2)}" for k, v in hot))
        return "\n".join(out)

    def c_ta(arg):
        sym = (arg or "").strip().upper()
        if not sym:
            return "usage: <code>/ta SOL</code> — full engine read on an asset"
        if not sym.endswith("USDT"):
            sym += "USDT"
        base = sym[:-4]
        sc = api("market-scanner") or {}
        sig = next((s for s in (sc.get("signals") or []) if s.get("asset") in (sym, base)), None)
        ta = (sig or {}).get("ta") or {}
        m = (api("mtf") or {}).get("rows") or {}
        row = m.get(base) or m.get(sym) or {}
        if not sig and not row:
            return f"🔍 <b>{esc(sym)}</b> — not on the board, no MTF row"
        out = [f"<b>🔬 {esc(sym)} TA DEEP-READ</b>", "─────────────────────"]
        if sig:
            out.append(f"signal: {sig.get('direction','?')} · score {sig.get('score','?')} · {sig.get('strategy','?')} · tgt {sig.get('targetPct','?')}%")
        if row.get("stack"):
            out.append(f"MTF: {esc(row.get('stack',''))}")
        if ta.get("bias"):
            out.append(f"engine bias: <b>{esc(str(ta['bias']))}</b> · confluence {ta.get('confluence','—')}")
        wk = ta.get("wyckoff") or {}
        if wk.get("phase") or wk.get("events"):
            evs = wk.get("events") or []
            out.append(f"Wyckoff: {esc(str(wk.get('phase','—')))} · {esc(str(evs[-1])) if evs else '—'}")
        ew = ta.get("ewProj") or ta.get("elliott")
        if ew:
            out.append(f"Elliott: {esc(str(ew.get('txt') or ew.get('dir') or ew) if isinstance(ew, dict) else str(ew))[:90]}")
        hm = ta.get("harmPrz")
        if hm:
            out.append(f"Harmonics PRZ: {esc(str(hm.get('consensus') or hm.get('dir') or hm) if isinstance(hm, dict) else str(hm))[:90]}")
        sk = ta.get("sakata") or {}
        if sk.get("methods") or sk.get("dir"):
            out.append(f"Sakata: {esc(', '.join(sk.get('methods') or [])[:70] or str(sk.get('dir','')))}")
        cd, clv = ta.get("candleDir"), ta.get("candleClv")
        if cd:
            out.append(f"Candles: {esc(str(cd))} · CLV {clv}")
        if ta.get("fibClusters"):
            out.append(f"Fib clusters: {esc(str(ta['fibClusters']))[:60]}")
        if ta.get("goldenPocket"):
            out.append(f"Golden pocket: {esc(str(ta['goldenPocket']))[:60]}")
        if ta.get("fvgNearest"):
            out.append(f"FVG: {esc(str(ta['fvgNearest']))[:60]}")
        if ta.get("liquidity"):
            out.append(f"Liquidity: {esc(str(ta['liquidity']))[:70]}")
        if len(out) <= 3:
            out.append("engine quiet — no active structures")
        return "\n".join(out)

    # ---- control surface ----
    def _list_cmd(fname):
        c = statef(fname) or {}
        return c.get("symbols") if isinstance(c.get("symbols"), list) else []

    def _list_save(fname, syms):
        wstate(fname, {"symbols": syms, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    def c_hold(arg):
        a = (arg or "").strip().upper()
        if not a:
            return "usage: <code>/hold SOL</code> — engine won't manage/exits-skip a held symbol"
        if not a.endswith("USDT"):
            a += "USDT"
        syms = _list_cmd("cmd-manual-hold")
        if a not in syms:
            syms.append(a)
        _list_save("cmd-manual-hold", syms)
        return f"✋ <b>{a} HELD</b> — hands-off next cycle (protection still armed)"

    def c_unhold(arg):
        a = (arg or "").strip().upper()
        if not a:
            return "usage: <code>/unhold SOL</code>"
        if not a.endswith("USDT"):
            a += "USDT"
        syms = [s for s in _list_cmd("cmd-manual-hold") if s != a]
        _list_save("cmd-manual-hold", syms)
        return f"🤲 <b>{a} RELEASED</b> — engine manages it again"

    def c_holds():
        env = os.environ.get("SENTINEL_MANUAL_HOLD", "")
        envl = [s for s in env.split(",") if s]
        cmdl = _list_cmd("cmd-manual-hold")
        return ("<b>✋ MANUAL HOLDS</b>\n─────────────────────\n"
                f"env: {', '.join(envl) or '—'}\ntg:  {', '.join(cmdl) or '—'}")

    def c_deny(arg):
        a = (arg or "").strip().upper()
        if not a:
            return "usage: <code>/deny ETH</code> — refuse every entry on it"
        if not a.endswith("USDT"):
            a += "USDT"
        syms = _list_cmd("cmd-deny")
        if a not in syms:
            syms.append(a)
        _list_save("cmd-deny", syms)
        return f"🚫 <b>{a} DENIED</b> — entries refused next cycle"

    def c_allow(arg):
        a = (arg or "").strip().upper()
        if not a:
            return "usage: <code>/allow ETH</code>"
        if not a.endswith("USDT"):
            a += "USDT"
        syms = [s for s in _list_cmd("cmd-deny") if s != a]
        _list_save("cmd-deny", syms)
        return f"✅ <b>{a} ALLOWED</b> — deny flag cleared (env denies unchanged)"

    def c_denied():
        envl = [s for s in os.environ.get("SENTINEL_DENY_SYMS", "").split(",") if s]
        return ("<b>🚫 DENY LIST</b>\n─────────────────────\n"
                f"env: {', '.join(envl) or '—'}\ntg:  {', '.join(_list_cmd('cmd-deny')) or '—'}")

    def c_risk(arg):
        a = (arg or "").strip()
        if not a:
            cur = statef("cmd-risk") or {}
            envv = os.environ.get("SENTINEL_RISK_MUL", "1")
            return (f"<b>🎚 RISK MULTIPLIER</b>\n─────────────────────\n"
                    f"env: ×{envv} · tg override: {('×' + str(cur.get('mul'))) if cur.get('mul') is not None else '—'}\n"
                    f"<i>/risk 0.5 halves every new entry's size · /risk off clears</i>")
        if a.lower() in ("off", "clear", "reset"):
            _list_save("cmd-risk", {"mul": None})
            return "🎚 override cleared — env risk multiplier back in force"
        try:
            v = float(a)
        except ValueError:
            return "usage: <code>/risk 0.5</code> (0–8, clamped)"
        v = min(max(v, 0.0), 8.0)
        _list_save("cmd-risk", {"mul": v})
        return f"🎚 <b>RISK ×{v}</b> — applies to next entry sizing"

    def c_close(arg, chat_key):
        a = (arg or "").strip().upper()
        if a.startswith("CONFIRM "):
            target = a.split(None, 1)[1]
            if not target.endswith("USDT"):
                target += "USDT"
            if PENDING.pop(chat_key, None) != f"close:{target}":
                return f"no close armed for {target} — send /close {target} first."
            wstate("cmd-close", {"symbol": target, "by": "telegram", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            return f"🎯 <b>CLOSING {target}</b> — executor market-closes it next cycle."
        if not a:
            return "usage: <code>/close SOL</code>"
        if not a.endswith("USDT"):
            a += "USDT"
        PENDING[chat_key] = f"close:{a}"
        return (f"⚠️ close <b>{a}</b> at market?\nReply <code>/close CONFIRM {a}</code> within 60s.")

    def c_hud(arg):
        st = statef("tg-hud") or {}
        on = not st.get("on")
        st["on"] = on
        wstate("tg-hud", st)
        return ("🖥 <b>LIVE HUD ON</b> — pinned tile edits itself every ~45s" if on
                else "🖥 HUD off — tile frozen")

    # ---- operator setup builder (VEMA-style) -------------------------------
    # /setup arms an operator-defined entry into state/cmd-setups.json — the
    # executor evaluates triggers each cycle and routes fills through every
    # safety rail. Modes: market (next-cycle fill), bounce (fill when price
    # trades at entry), br (break through `break` px then fill on retest of
    # entry). Risk-% sizes the position so a stop-out loses ~that much of
    # equity. CONFIRM-gated: the risk card is shown before anything arms.
    def c_setup(arg, chat_key):
        a = (arg or "").strip()
        if a.upper() == "CONFIRM":
            spec = PENDING.pop(chat_key, None)
            if not isinstance(spec, dict) or "setup" not in spec:
                return "no setup armed — send /setup first."
            f = statef("cmd-setups") or {}
            setups = f.get("setups") if isinstance(f.get("setups"), list) else []
            s = spec["setup"]
            s["status"] = "armed"
            s["by"] = "telegram"
            setups.append(s)
            wstate("cmd-setups", {"setups": setups})
            return (f"🛠 <b>SETUP ARMED</b> — <code>{s['id']}</code> {s['symbol']} "
                    f"{s['direction']} {s['mode']}\nexecutor evaluates it next cycle · "
                    f"/setups to track · /unsetup {s['id']} to cancel")
        if not a:
            return ("<b>🛠 SETUP BUILDER</b> — operator-defined entries\n"
                    "─────────────────────\n"
                    "<code>/setup SYM long|short [market|bounce|br] [entry] [break P]\n"
                    "  sl P [tp P pct]… [risk %] [ttl min] [strat name] [note …]</code>\n\n"
                    "<b>market</b> — fill at mark next cycle\n"
                    "<b>bounce</b> — fill only when price trades AT entry (limit-style)\n"
                    "<b>br</b> — break through <code>break</code> px, fill on retest of entry\n\n"
                    "e.g. <code>/setup SOL long br 90.5 92 sl 88 tp 95 50 tp 99 50 risk 1 note range break</code>\n"
                    "tp pct sums ≤100 — the rest rides the stop as the moon bag.\n"
                    "CONFIRM-gated: full risk card shown before it arms.")
        raw = a.split()
        note = ""
        for i, t in enumerate(raw):
            if t.lower() == "note":
                note = " ".join(raw[i + 1:]).strip()
                raw = raw[:i]
                break
        if len(raw) < 2:
            return "usage: /setup SYM long|short [mode] … — see /setup"
        sym = raw[0].upper()
        if not sym.endswith("USDT"):
            sym += "USDT"
        d = raw[1].lower()
        direction = "LONG" if d in ("long", "l", "buy") else "SHORT" if d in ("short", "s", "sell") else None
        if not direction:
            return f"❌ direction '{esc(raw[1])}' — use long|short"
        rest = raw[2:]
        mode = "market"
        if rest and rest[0].lower() in ("market", "mkt", "m", "bounce", "b", "limit",
                                        "br", "b&r", "break", "breakretest", "sniper"):
            mt = rest.pop(0).lower()
            mode = ("br" if mt in ("br", "b&r", "break", "breakretest", "sniper")
                    else "bounce" if mt in ("bounce", "b", "limit") else "market")
        entry = brk = sl = risk = ttl = strat = None
        tps, posnum, i, err = [], [], 0, None
        while i < len(rest):
            t = rest[i].lower()
            def num(j):
                try:
                    return float(rest[j])
                except (ValueError, IndexError):
                    return None
            if t == "entry" and num(i + 1) is not None:
                entry = num(i + 1); i += 2
            elif t == "break" and num(i + 1) is not None:
                brk = num(i + 1); i += 2
            elif t == "sl" and num(i + 1) is not None:
                sl = num(i + 1); i += 2
            elif t == "tp" and num(i + 1) is not None:
                px = num(i + 1); i += 2
                pct = num(i)
                if pct is not None:
                    i += 1
                tps.append([px, pct])
            elif t == "risk" and num(i + 1) is not None:
                risk = num(i + 1); i += 2
            elif t == "ttl" and num(i + 1) is not None:
                ttl = num(i + 1); i += 2
            elif t in ("strat", "strategy") and i + 1 < len(rest):
                strat = rest[i + 1]; i += 2
            elif t in ("be", "nobe"):
                i += 1  # exchange-side ratchet already locks BE after TP1
            else:
                v = num(i)
                if v is None:
                    err = f"unknown token '{rest[i]}'"; break
                posnum.append(v); i += 1
        if err:
            return f"❌ {esc(err)} — see /setup"
        if entry is None and posnum:
            entry = posnum.pop(0)
        if mode == "br" and brk is None and posnum:
            brk = posnum.pop(0)
        sgn = 1 if direction == "LONG" else -1
        if mode in ("bounce", "br") and not (entry and entry > 0):
            return "❌ bounce/br need an entry px — positional or <code>entry P</code>"
        if mode == "br" and not (brk and brk > 0):
            return "❌ br needs a break level — positional or <code>break P</code>"
        if sl is None or sl <= 0:
            return "❌ sl required — <code>sl P</code>"
        if not tps:
            return "❌ at least one <code>tp P pct</code> required"
        # live mark for side-checks + the card when no entry was typed
        ref = entry if entry else last_price(sym)
        if ref:
            if sgn > 0 and sl >= ref:
                return f"❌ long SL {sl} must be BELOW entry {ref}"
            if sgn < 0 and sl <= ref:
                return f"❌ short SL {sl} must be ABOVE entry {ref}"
            if mode == "br":
                if sgn > 0 and brk <= ref:
                    return "❌ long break level must be ABOVE entry"
                if sgn < 0 and brk >= ref:
                    return "❌ short break level must be BELOW entry"
            bad = [px for px, _ in tps if (sgn > 0 and px <= ref) or (sgn < 0 and px >= ref)]
            if bad:
                return f"❌ TP(s) {', '.join(str(x) for x in bad)} must be {'above' if sgn > 0 else 'below'} entry {fmtp(ref)}"
        allocated = sum(p or 0 for _, p in tps)
        if allocated > 100.01:
            return f"❌ tp allocations {allocated:g}% > 100%"
        # tps typed without pct split the unallocated remainder evenly
        unalloc = max(0.0, 100.0 - allocated)
        nofrac = [t for t in tps if t[1] is None]
        for t in nofrac:
            t[1] = round(unalloc / len(nofrac), 2)
        risk = risk if risk else 1.0
        if not (0.05 <= risk <= 10):
            return "❌ risk 0.05–10% of equity"
        ttl = min(max(ttl or 720, 5), 10080)
        ll = api("live-ledger") or {}
        eq = float(ll.get("equityUsd") or 0)
        risk_usd = eq * risk / 100
        sid = "S-" + format(int(time.time() * 1000), "x")[-4:] + format(int(time.time_ns() % 0xffff), "04x")
        spec = {"id": sid, "symbol": sym, "direction": direction, "mode": mode,
                "entryPx": entry, "breakPx": brk, "slPx": sl,
                "tps": [{"px": px, "pct": p} for px, p in tps],
                "riskPct": risk, "ttlMin": ttl, "be": True,
                "note": note or None, "strategy": strat or "vema-setup",
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        card = ["<b>🛠 SETUP PREVIEW</b>", "─────────────────────",
                f"<b>{sym}</b> {direction} · <code>{mode}</code>"
                + (f" @ {fmtp(entry)}" if entry else f" @ mark ~{fmtp(ref)}")]
        if mode == "br":
            card.append(f"break {fmtp(brk)} → retest {fmtp(entry)}")
        if ref:
            stop_pct = abs(ref - sl) / ref * 100
            wsum = sum(p for _, p in tps) or 1
            wtgt = sum(abs(px - ref) / ref * 100 * p for px, p in tps) / wsum
            netrr = max(0.0, (wtgt - 0.20) / (stop_pct + 0.20))
            notional = risk_usd / max(0.0005, stop_pct / 100 + 0.0012) if eq else 0
            lev = min(40, max(1, int(80 / (stop_pct + 0.64))))
            card.append(f"SL {fmtp(sl)} (−{stop_pct:.2f}%)")
            for j, (px, p) in enumerate(tps, 1):
                card.append(f"TP{j} {fmtp(px)} · {p:g}% · {'+' if (px - ref) * sgn > 0 else ''}{(px - ref) / ref * 100:.2f}%")
            moon = 100 - sum(p for _, p in tps)
            if moon > 0.5:
                card.append(f"🌙 {moon:.0f}% rides the stop as moon bag")
            card.append("─────────────────────")
            card.append(f"risk {risk:g}% ≈ <b>${risk_usd:.2f}</b> · notional ≈ ${notional:.2f} @ ~{lev}x (margin ${notional / lev:.2f})")
            card.append(f"net R:R ≈ <b>{netrr:.2f}:1</b> · floor 1:1")
            if netrr < 1:
                card.append("⚠️ executor will REJECT — netRR below floor")
        PENDING[chat_key] = {"setup": spec}
        card.append(f"\nReply <code>/setup CONFIRM</code> within 60s to arm <code>{sid}</code>")
        return "\n".join(card)

    def c_setups():
        arr = (api("setups") or {}).get("setups") or (statef("cmd-setups") or {}).get("setups") or []
        if not arr:
            return "🛠 <b>No setups</b> — /setup SYM long|short mode … to arm one"
        ic = {"armed": "🟡", "await-retest": "🟠", "triggered": "🔵", "filled": "🟢",
              "cancelled": "⚫", "expired": "⌛", "failed": "🔴", "rejected": "⛔", "missed": "💨"}
        out = ["<b>🛠 SETUP BOARD</b>", "─────────────────────"]
        for s in arr[-12:]:
            st = (s.get("stage") if s.get("mode") == "br" and s.get("stage") else s.get("status")) or "armed"
            line = f"{ic.get(st, '•')} <b>{s.get('symbol', '?')}</b> {s.get('direction', '?')[:1]}·{s.get('mode', '?')}"
            if s.get("entryPx"):
                line += f" @{fmtp(s['entryPx'])}"
            line += f" · SL {fmtp(s.get('slPx'))}"
            if s.get("lastPx"):
                line += f" · mk {fmtp(s['lastPx'])}"
            if s.get("status") == "filled":
                line += f" → <b>filled</b> {fmtp(s.get('fillPx'))}"
            if s.get("reason"):
                line += f" · <i>{esc(str(s['reason'])[:42])}</i>"
            elif s.get("blockedBy"):
                line += f" · <i>{esc(str(s['blockedBy']))}</i>"
            out.append(line)
        out.append("<i>/unsetup S-xxxx cancels · /setup arms a new one</i>")
        return "\n".join(out)

    def c_unsetup(arg):
        a = (arg or "").strip().upper()
        if not a:
            return "usage: <code>/unsetup S-1a2b</code> — /setups to list"
        f = statef("cmd-setups") or {}
        setups = f.get("setups") if isinstance(f.get("setups"), list) else []
        hit = next((s for s in setups if str(s.get("id", "")).upper() == a), None)
        if not hit:
            return f"no setup <code>{esc(a)}</code> — /setups to list"
        if hit.get("status") in ("filled", "cancelled", "expired", "failed", "rejected", "missed"):
            return f"{a} already terminal ({hit.get('status')})"
        hit["status"] = "cancelled"
        wstate("cmd-setups", f)
        return f"⚫ <b>{a} CANCELLED</b> — executor ignores it next cycle"

    def c_hook():
        # webhook console — the shared secret is operator-only; this chat IS
        # the operator channel (Saved Messages), so replying here is safe.
        f = statef("tv-hook") or {}
        secret = f.get("secret") or ""
        if not secret:
            return ("🔗 <b>TradingView hook not armed</b>\n"
                    "state/tv-hook.json needs <code>{\"secret\":\"…\"}</code> on the box")
        url = "https://168-138-102-53.sslip.io/tv-hook"
        tpl = ('{"key":"%s","symbol":"{{ticker}}","direction":"long",'
               '"mode":"market","sl":{{close}}*0.97,"tps":[{{close}}*1.03,'
               '{{close}}*1.06],"risk":0.5,"id":"{{timenow}}"}') % secret
        return ("🔗 <b>TRADINGVIEW HOOK</b>\n─────────────────────\n"
                f"URL: <code>{url}</code>\n"
                f"secret: <code>{esc(secret)}</code>\n\n"
                "Alert body template:\n<code>" + esc(tpl) + "</code>\n\n"
                "<i>mode: market | bounce | br · tp[] splits position "
                "evenly · optional: entry, rr, risk%, ttlMin, note</i>")

    # emoji as first-class commands — the OS listens for raw emoji too
    EMOJI_CMDS = {
        "📊": "status", "💰": "vault", "📈": "eq", "📉": "pos",
        "📡": "sig", "🌡": "regime", "🧠": "quant", "📐": "sqn",
        "⚖️": "j", "⚖": "j", "📜": "j", "🌊": "radar", "🧮": "mtf",
        "📣": "soc", "🧬": "ein", "💓": "pulse", "💗": "pulse",
        "🚧": "gates", "🌩": "god", "🗺": "plan", "🗺️": "plan",
        "📒": "fills", "🔬": "mtf", "⏸": "pause", "▶️": "resume",
        "▶": "resume", "🖥": "hud", "🖥️": "hud", "🆘": "help",
        "🏓": "ping", "🩺": "status",
    }

    CMDS = {"status": c_status, "pos": c_pos, "positions": c_pos, "eq": c_eq, "equity": c_eq,
            "sig": c_sig, "signals": c_sig, "radar": c_radar, "mtf": c_mtf, "soc": c_soc,
            "social": c_soc, "ein": c_ein, "einstein": c_ein, "j": c_j, "journal": c_j,
            "pulse": c_pulse, "pause": c_pause, "resume": c_resume, "links": c_links,
            "help": c_help, "menu": c_help, "start": c_help, "watch": c_watch,
            "watches": c_watches, "unwatch": c_unwatch, "ping": lambda a: "🏓 sentinel live — " + time.strftime("%H:%M:%SZ", time.gmtime()),
            "fills": c_fills, "vault": c_vault, "wealth": c_vault, "quant": c_quant,
            "regime": c_regime, "sqn": c_sqn, "gates": c_gates, "god": c_god,
            "plan": c_plan, "corr": c_corr, "ta": c_ta,
            "hold": c_hold, "unhold": c_unhold, "holds": c_holds,
            "deny": c_deny, "allow": c_allow, "denied": c_denied,
            "risk": c_risk, "hud": c_hud,
            "setups": c_setups, "builder": c_setups,
            "unsetup": c_unsetup, "cancelsetup": c_unsetup, "setupcancel": c_unsetup,
            "hook": c_hook, "webhook": c_hook, "tv": c_hook}

    def run_cmd(fn, arg):
        # handlers are mixed-arity — intel commands ignore args, control
        # commands take them. Dispatch on signature so both work.
        try:
            return fn(arg) if len(inspect.signature(fn).parameters) else fn()
        except (ValueError, TypeError):
            return fn(arg)

    @client.on(events.NewMessage(outgoing=True))
    async def on_cmd(ev):
        m = ev.message
        try:
            if not m or not m.raw_text or not m.out:
                return
            if getattr(m.peer_id, "user_id", None) != me.id:
                return  # only Saved Messages (self) — spoof-proof by construction
            txt = m.raw_text.strip()
            # raw-emoji command channel — "📊" alone fires /status, etc.
            # len-gate is load-bearing: our own alerts start with emoji too —
            # a long message beginning "🌩" must NOT re-dispatch as /god.
            if not txt.startswith("/"):
                em = txt.strip()
                if len(em) > 2:
                    return
                hit = EMOJI_CMDS.get(em) or EMOJI_CMDS.get(em[:1])
                if not hit:
                    return
                reply = run_cmd(CMDS[hit], "") if hit in CMDS else None
                if reply is None:
                    return
                await say(reply)
                print(f"[tg-c2] emoji {em!r} -> /{hit}", flush=True)
                return
            parts = txt.split(None, 1)
            cmd = parts[0].lstrip("/").lower().split("@")[0]
            arg = parts[1] if len(parts) > 1 else ""
            if cmd == "flatten":
                reply = c_flatten(arg, "me")
            elif cmd == "close":
                reply = c_close(arg, "me")
            elif cmd == "setup":
                reply = c_setup(arg, "me")
            elif cmd == "menu":
                await say(c_help())
                await send_menu()
                return
            elif cmd in CMDS:
                reply = run_cmd(CMDS[cmd], arg)
            else:
                reply = f"unknown command <code>{esc(cmd)}</code> — /help"
            await say(reply)
            print(f"[tg-c2] /{cmd} answered", flush=True)
        except Exception as e:
            print(f"[tg-c2] handler error: {type(e).__name__}: {e}", flush=True)

    # ---- inline keyboard deck ---------------------------------------------
    MENU_BUTTONS = [
        [Button.inline("📊 Status", b"cmd:status"), Button.inline("📈 Equity", b"cmd:eq"), Button.inline("📉 Positions", b"cmd:pos")],
        [Button.inline("📡 Signals", b"cmd:sig"), Button.inline("🌡 Regime", b"cmd:regime"), Button.inline("🧠 Quant", b"cmd:quant")],
        [Button.inline("📐 SQN", b"cmd:sqn"), Button.inline("📒 Fills", b"cmd:fills"), Button.inline("🏦 Vault", b"cmd:vault")],
        [Button.inline("🗺 Plan", b"cmd:plan"), Button.inline("🚧 Gates", b"cmd:gates"), Button.inline("🌩 GOD", b"cmd:god")],
        [Button.inline(chr(0x1F6E0)+" Setups", b"cmd:setups"), Button.inline(chr(0x1F517)+" Hook", b"cmd:hook"), Button.inline(chr(0x1F493)+" Pulse", b"cmd:pulse")],
        [Button.inline(chr(0x1F5A5)+" HUD", b"cmd:hud"), Button.inline(chr(0x23F8)+" Pause", b"cmd:pause"), Button.inline(chr(0x1F198)+" Help", b"cmd:help")],
    ]

    async def send_menu():
        await client.send_message(me, "🎛 <b>SENTINEL CONSOLE</b> — tap a tile, or send a raw emoji", buttons=MENU_BUTTONS, parse_mode="html")

    @client.on(events.CallbackQuery)
    async def on_cb(ev):
        if getattr(ev.query, "user_id", None) != me.id:
            return
        data = (ev.data or b"").decode("utf-8", "ignore")
        if not data.startswith("cmd:"):
            return
        try:
            await ev.answer()
        except Exception:
            pass
        cmd = data[4:]
        if cmd in CMDS:
            await say(run_cmd(CMDS[cmd], ""))

    # ---- live HUD — one pinned tile that edits itself ----------------------
    def hud_text():
        ll = api("live-ledger") or {}
        eq_usd = ll.get("equityUsd")
        st = ll.get("stats") or {}
        ps = ll.get("positions") or []
        rs = ll.get("realizedStats") or {}
        upl = sum(float(p.get("upl") or 0) for p in ps)
        cb = ll.get("circuitBreakers") or {}
        pv = [(r.get("v") if isinstance(r, dict) else r) for r in ((api("pulse-history") or {}).get("runs") or [])][-20:]
        alert = "🚨 HALTED" if (statef("cmd-halt") or {}).get("halted") else ("⚠️ " + esc(str(cb.get("tripped"))[:30]) if cb.get("tripped") else "✅ armed")
        vv = statef("wealth-vault") or {}
        return ("<b>🛰 SENTINEL LIVE HUD</b>\n"
                f"💵 ${fmtp(eq_usd)} · upl <b>${upl:+.2f}</b> · 🏦 ${fmtp(ll.get('vaultUsd') or vv.get('balanceUsd'))}\n"
                f"<code>{spark(pv)}</code>\n"
                f"📉 {len(ps)} open · edge <b>{ll.get('edgeLive','—')}</b> · {esc(str(ll.get('mktType','—')))}\n"
                f"WR {rs.get('winRatePct','—')}% · PF {rs.get('profitFactor','—')} · net ${fmtp(rs.get('netUsd'))}\n"
                f"{alert} · {time.strftime('%H:%M:%SZ', time.gmtime())}")

    async def hud_loop():
        while True:
            await asyncio.sleep(45)
            try:
                st = statef("tg-hud") or {}
                if not st.get("on"):
                    continue
                if st.get("msgId"):
                    try:
                        await client.edit_message(me, st["msgId"], hud_text(), parse_mode="html")
                        continue
                    except Exception:
                        st["msgId"] = None
                m = await client.send_message(me, hud_text(), parse_mode="html")
                try:
                    await client.pin_message("me", m.id, notify=False)
                except Exception:
                    pass
                st["msgId"] = m.id
                wstate("tg-hud", st)
            except Exception:
                pass

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
        prev_trip, prev_vault, prev_god = "", None, None
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
                # quant + vault + audit watches — breakers, edge-death, sweeps, GOD
                cbx = ll.get("circuitBreakers") or {}
                trip = str(cbx.get("tripped") or "")
                if trip != prev_trip:
                    if trip:
                        await say(f"⚠️ <b>BREAKER TRIPPED</b> — {esc(trip[:120])}\n<i>entries gated — /quant for detail</i>")
                    elif prev_trip:
                        await say("✅ <b>BREAKERS CLEAR</b> — risk rails re-armed")
                prev_trip = trip
                ed = cbx.get("edgeDeath") or {}
                if ed.get("S", 0) > (ed.get("h") or 1e9) and f"edge:{ed.get('n')}" not in alerted:
                    alerted.add(f"edge:{ed.get('n')}")
                    await say(f"🧠 <b>EDGE DEATH — CUSUM FIRED</b>\nS={round(ed.get('S',0),2)} crossed h={round(ed.get('h',0),1)} at n={ed.get('n')}\n"
                              "<i>the tape stopped paying — risk pinned to floor</i>")
                try:
                    vs = len(((statef("wealth-vault") or {}).get("sweptIds") or {}))
                    if prev_vault is not None and vs > prev_vault:
                        await say(f"🏦 <b>VAULT SWEEP</b> — {vs - prev_vault} fill(s) taxed 50% → vault <b>${fmtp((statef('wealth-vault') or {}).get('balanceUsd'))}</b> locked")
                    prev_vault = vs
                except Exception:
                    pass
                # setup board transitions — a triggered/failed/filled setup
                # pings so the operator never has to poll /setups
                try:
                    for s in (api("setups") or {}).get("setups", []):
                        sid = s.get("id")
                        if not sid:
                            continue
                        stt = s.get("status") or "armed"
                        stg = s.get("stage") or ""
                        k = f"setup:{sid}:{stt}:{stg}"
                        if k in alerted:
                            continue
                        alerted.add(k)
                        if stt in ("triggered", "filled", "failed", "rejected", "expired", "missed", "cancelled") or stg == "await-retest":
                            em = {"triggered": "🔵", "filled": "🟢", "failed": "🔴", "rejected": "⛔",
                                  "expired": "⌛", "missed": "💨", "cancelled": "⚫"}.get(stt, "🟠")
                            lbl = "RETEST HIT — awaiting entry touch" if stg == "await-retest" and stt == "armed" else str(stt).upper()
                            extra = f" · <i>{esc(str(s.get('reason'))[:60])}</i>" if s.get("reason") else ""
                            await say(f"{em} <b>SETUP {lbl}</b> — {s.get('symbol')} {s.get('direction')} {s.get('mode')} <code>{sid}</code>{extra}")
                except Exception:
                    pass
                god = api("god") or {}
                gok = god.get("verdict")
                if gok in ("BROKEN", "WARN") and prev_god not in ("BROKEN", "WARN"):
                    bad = [str(c.get("name", "?")) for c in (god.get("checks") or [])
                           if c.get("status") == "FAIL"][:3]
                    await say(f"🌩 <b>GOD {esc(gok)}</b> — " + esc(", ".join(bad) or "audit findings") + "\n<i>/god for the report</i>")
                prev_god = gok
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
                        fills = (statef("demo-fills" if (ll2 or {}).get("mode") == "demo" else "real-fills") or {}).get("fills", [])
                        bf = [f for f in fills if f.get("src") == "api" and (f.get("ts") or 0) >= day0]
                        mf = [f for f in fills if f.get("src") not in (None, "api") and (f.get("ts") or 0) >= day0]
                        bpnl = round(sum((f.get("profit") or 0) - (f.get("fee") or 0) for f in bf), 2)
                        mpnl = round(sum((f.get("profit") or 0) - (f.get("fee") or 0) for f in mf), 2)
                        topg = sorted(((api("gate-stats") or {}).get("totals24h") or {}).items(), key=lambda kv: -kv[1])[:4]
                        tops = " \u00b7 ".join(f"{k}\u00d7{v}" for k, v in topg) or "none"
                        posl = ", ".join(f"{p.get('symbol')} {p.get('side')} upl {round(p.get('upl') or 0, 2)}" for p in (ll2.get("positions") or [])) or "flat"
                        # benchmark line — sentinel vs the freqtrade dry-run
                        # engine on the same tape, side by side every day
                        bench = api("freqtrade-bench") or {}
                        bs = bench.get("stats") or bench
                        ntr = bs.get("trades") or bs.get("closed") or 0
                        bline = ""
                        if ntr:
                            bline = (f"\nbench(ft): {ntr} trades · win {bs.get('winRatePct','?')}% · "
                                     f"PF {bs.get('profitFactor','?')} · net ${bs.get('netUsd','?')}")
                        else:
                            bline = f"\nbench(ft): {bs.get('openTrades', bs.get('open','0'))} open · 0 closed yet"
                        dep = ll2.get('depositsUsd') or (ll2.get('risk') or {}).get('depositsUsd') or 0
                        depl = f" · deposits ${dep}" if dep else ""
                        await say(
                            "\U0001F4CB <b>DAILY DIGEST</b> " + today + "\n"
                            f"equity ${ll2.get('equityUsd','?')} \u00b7 dd {ll2.get('ddPct','?')}%{depl}\n"
                            f"today — bot {len(bf)} fills ({bpnl:+.2f}) \u00b7 manual {len(mf)} ({mpnl:+.2f})\n"
                            f"open: {esc(posl)}\n"
                            f"top reject gates 24h: {esc(tops)}{bline}"
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
    asyncio.create_task(hud_loop())
    await say("<b>🛰️ SENTINEL C2 ONLINE</b>\n"
              "Command surface live — <code>/menu</code> for the console deck, <code>/help</code> for the card\n"
              "🎛 inline keyboard · 😀 raw-emoji commands · 🖥 live HUD\n"
              "Alerts armed: signals · positions · halts · breakers · edge-death · vault · GOD · deadman · watches")
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
