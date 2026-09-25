#!/usr/bin/env python3
"""tg-watch.py — VIP signal-group watcher.

Reads the user's Telegram group (via Telethon user account), parses signal
messages, and writes state/tg-confluence.json for the scanner. Signals are
CONFLUENCE ONLY — the engine still scores them itself.

Config: scripts/tg-config.json  { "api_id": int, "api_hash": str, "group": str|int }
First run needs phone + login code once; session persists in tg-session.session.
"""
import asyncio, json, os, re, sys, time
from pathlib import Path
from telethon import TelegramClient, events

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
        await handle(msg)

    @client.on(events.NewMessage(chats=group))
    async def on_new(ev):
        await handle(ev.message)

    print("[tg] live — listening for new messages")
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
