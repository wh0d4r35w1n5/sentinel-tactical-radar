#!/usr/bin/env python3
"""
VIP signal listener -> api/ext-alpha.json

Listens to a Telegram channel via the official client API (Telethon) and writes
DERIVED signal metadata only (asset, direction, timestamp). Raw message text is
never written to disk or committed — the feed informs the engine, it is not
republished.

One-time setup:
  1. pip install telethon requests
  2. Create an app at https://my.telegram.org -> get api_id + api_hash
  3. Copy scripts/tg-config.example.json to scripts/tg-config.json and fill it in
     (or set env TG_API_ID / TG_API_HASH / TG_CHANNEL)
  4. Run once interactively — enter your phone + OTP. Session persists in
     scripts/tg.session (gitignored).

Config keys:
  channel   : channel username or invite, e.g. "cryptopasta_vip_bot"
  publish   : if true, git-commit+push api/ext-alpha.json every PUSH_EVERY s
              so the deployed engine sees it (default false = local only)
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "api" / "ext-alpha.json"
CFG_PATH = Path(__file__).resolve().parent / "tg-config.json"
SESSION = str(Path(__file__).resolve().parent / "tg.session")
PUSH_EVERY = 900  # seconds
MAX_SIGNALS = 500
SIGNAL_TTL_S = 6 * 3600  # engine only counts signals younger than this

WORD_DIR = [
    (re.compile(r"\b(long|buy|bought|calls?|bullish|accumulat\w+)\b", re.I), "long"),
    (re.compile(r"\b(short|sell|puts?|bearish|dump\w*)\b", re.I), "short"),
]
# $BTC, BTC/USDT, BTCUSDT, "BTC perp", bare uppercase tickers
TOKEN = re.compile(r"\$?([A-Z][A-Z0-9]{1,9})(?:\s*/\s*USDT|USDT\b|\s+perp\b)?")
STOPWORDS = {
    "VIP", "FREE", "SIGNAL", "SIGNALS", "LONG", "SHORT", "BUY", "SELL", "ENTRY",
    "TARGET", "TARGETS", "TP", "SL", "STOP", "STOPLOSS", "LEVERAGE", "USDT",
    "USD", "FUTURES", "SPOT", "SCALP", "SWING", "UPDATE", "RESULT",
    "PROFIT", "LOSS", "BREAKOUT", "PUMP", "DUMP", "ALERT", "SETUP", "TRADE",
    "NOW", "NEW", "HOT", "MARKET", "LIMIT", "DCA", "ATH", "ATL", "ROI", "PNL",
}
NOISE_TOKENS = {"BTC", "ETH"}  # still tracked but need an explicit direction word


def load_cfg():
    cfg = {}
    if CFG_PATH.exists():
        cfg = json.loads(CFG_PATH.read_text())
    return {
        "api_id": int(os.environ.get("TG_API_ID") or cfg.get("api_id") or 0),
        "api_hash": os.environ.get("TG_API_HASH") or cfg.get("api_hash") or "",
        "channel": os.environ.get("TG_CHANNEL") or cfg.get("channel") or "cryptopasta_vip_bot",
        "publish": bool(cfg.get("publish", False)),
    }


def bitget_symbols():
    """Live Bitget spot USDT symbol set -> accurate ticker extraction."""
    try:
        import requests

        r = requests.get(
            "https://api.bitget.com/api/v2/spot/public/symbols", timeout=10
        )
        out = set()
        for s in r.json().get("data", []):
            base = s.get("symbol", "").replace("USDT", "")
            if base:
                out.add(base)
        return out
    except Exception:
        return set()


SYMBOLS = bitget_symbols()
print(f"[tg] {len(SYMBOLS)} bitget symbols loaded", flush=True)


def parse(text):
    """Return [{asset, dir}] — derived fields only, no raw text stored."""
    found = {}
    direction = None
    for rx, d in WORD_DIR:
        if rx.search(text):
            direction = d
            break
    for m in TOKEN.finditer(text):
        tok = m.group(1)
        if tok in STOPWORDS or tok not in SYMBOLS:
            continue
        if tok in NOISE_TOKENS and not direction:
            continue
        found[tok] = direction
    return [{"asset": a, "dir": d} for a, d in found.items()]


def read_out():
    try:
        return json.loads(OUT.read_text())
    except Exception:
        return {"signals": []}


def write_out(items):
    data = {"updatedAt": int(time.time() * 1000), "signals": items[-MAX_SIGNALS:]}
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    return data


def maybe_push(cfg):
    if not cfg["publish"]:
        return
    try:
        subprocess.run(["git", "add", "-f", "api/ext-alpha.json"], cwd=ROOT, check=True)
        diff = subprocess.run(
            ["git", "diff", "--cached", "--quiet", "--", "api/ext-alpha.json"],
            cwd=ROOT,
        )
        if diff.returncode != 0:
            subprocess.run(
                ["git", "commit", "-m", "ext-alpha: vip desk signals [feed]"],
                cwd=ROOT,
                check=True,
            )
            subprocess.run(["git", "push"], cwd=ROOT, check=True)
            print("[tg] pushed ext-alpha update", flush=True)
    except Exception as e:
        print(f"[tg] push skipped: {e}", flush=True)


def record(items, parsed, msg_id):
    ts = int(time.time() * 1000)
    changed = False
    for p in parsed:
        key = p["asset"]
        if p["dir"]:
            # newest signal for the asset wins; keep a rolling count
            items[:] = [i for i in items if i["asset"] != key]
            items.append({"asset": key, "dir": p["dir"], "ts": ts, "m": msg_id})
        else:
            ex = next((i for i in items if i["asset"] == key), None)
            if ex:
                ex["ts"] = ts
                ex["m"] = msg_id
            else:
                items.append({"asset": key, "dir": None, "ts": ts, "m": msg_id})
        changed = True
    return changed


def main():
    cfg = load_cfg()
    if not cfg["api_id"] or not cfg["api_hash"]:
        sys.exit(
            "missing api_id/api_hash — see header: create app at my.telegram.org, "
            "fill scripts/tg-config.json or TG_API_ID/TG_API_HASH"
        )
    from telethon import TelegramClient, events

    client = TelegramClient(SESSION, cfg["api_id"], cfg["api_hash"])
    client.start()  # first run: phone + OTP prompt; then session persists

    state = read_out()
    items = state.get("signals", [])
    last_push = 0

    @client.on(events.NewMessage(chats=cfg["channel"]))
    async def handler(ev):
        nonlocal last_push
        parsed = parse(ev.raw_text or "")
        if parsed:
            record(items, parsed, ev.id)
            write_out(items)
            print(f"[tg] signal: {parsed}", flush=True)
        if time.time() - last_push > PUSH_EVERY:
            last_push = time.time()
            maybe_push(cfg)

    async def backfill():
        ent = await client.get_entity(cfg["channel"])
        n = 0
        async for msg in client.iter_messages(ent, limit=50):
            if msg.raw_text:
                n += len(parse(msg.raw_text))
                record(items, parse(msg.raw_text), msg.id)
        write_out(items)
        print(f"[tg] backfilled {n} token hits from last 50 msgs", flush=True)

    client.loop.run_until_complete(backfill())
    print(f"[tg] listening on {cfg['channel']} — writing api/ext-alpha.json", flush=True)
    client.run_until_disconnected()


if __name__ == "__main__":
    main()
