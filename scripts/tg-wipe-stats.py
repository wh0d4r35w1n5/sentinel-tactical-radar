#!/usr/bin/env python3
"""Wipe pre-epoch stat messages from Saved Messages + owned channels.
Keeps: pinned messages, the VIP ACCESS/donation post, anything post-epoch.
Usage: tg-wipe-stats.py"""
import asyncio, json, re, shutil, sys, os, datetime

EPOCH_MS = 1791395052872  # stats reset boundary (~17:44 UTC 07-Oct-2026)
EPOCH = datetime.datetime.fromtimestamp(EPOCH_MS / 1000, tz=datetime.timezone.utc)

ROOT = "/opt/sentinel"
SRC_SESSION = ROOT + "/scripts/tg-session.session"
WORK_SESSION = "/tmp/tg-wipe-session.session"

# bot/console stat markers — only match machine output, never personal notes
BOT_PAT = re.compile(
    r"(⚠️|🧠|✂️|📊|💥|🩹|👁|🟢|🔴|✅|❌|BREAKER|QUANT LAYER|TRIM|LIQ-GUARD|NAKED-FIX|circuit-breaker|"
    r"realized|CUSUM|Kelly|edge-death|AUTO-QUARANTINE|STOP-TRIM|OVERRIDE|entries gated|win.rate|UPL|equity \$)",
    re.I)
KEEP_PAT = re.compile(r"(VIP ACCESS|💳|deposit|send exactly|receive address|TXID|welcome)", re.I)

cfg = json.loads(open(ROOT + "/scripts/tg-config.json").read())
api_id = int(cfg["api_id"])
api_hash = cfg["api_hash"]

from telethon import TelegramClient
from telethon.tl.types import Channel

async def main():
    shutil.copy(SRC_SESSION, WORK_SESSION)
    # drop stale journal/locks for the copy
    for ext in ("-journal", "-wal", "-shm"):
        try: os.remove(WORK_SESSION + ext)
        except OSError: pass
    client = TelegramClient(WORK_SESSION[:-8], api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        print("SESSION NOT AUTHORIZED"); return
    me = await client.get_me()
    print("account:", me.username or me.id)

    deleted = {"saved": 0, "channels": {}}
    kept = []

    # ---- Saved Messages: delete pre-epoch bot/stat lines only ----
    ids = []
    async for m in client.iter_messages("me", limit=None):
        if m.date and m.date >= EPOCH:
            continue
        txt = m.text or ""
        if BOT_PAT.search(txt):
            ids.append(m.id)
        elif txt:
            kept.append(txt[:60])
    if ids:
        await client.delete_messages("me", ids)
    deleted["saved"] = len(ids)

    # ---- owned channels: wipe pre-epoch except pinned/donation ----
    async for d in client.iter_dialogs():
        ent = d.entity
        if not isinstance(ent, Channel):
            continue
        is_admin = bool(getattr(ent, "creator", False) or getattr(ent, "admin_rights", None))
        if not is_admin:
            continue
        name = getattr(ent, "title", "?") or getattr(ent, "username", "?")
        dels = []
        async for m in client.iter_messages(ent, limit=400):
            if m.date and m.date >= EPOCH:
                continue
            txt = m.text or ""
            if getattr(m, "pinned", False) or KEEP_PAT.search(txt):
                kept.append(f"{name}: {txt[:60]}")
                continue
            dels.append(m.id)
        if dels:
            try:
                await client.delete_messages(ent, dels)
            except Exception as e:
                print(f"{name}: delete failed {e}")
        deleted["channels"][name] = len(dels)
        print(f"channel {name}: deleted {len(dels)} pre-epoch msgs")

    print(json.dumps({"deleted": deleted, "kept_sample": kept[:10]}, indent=1))
    await client.disconnect()

asyncio.run(main())
