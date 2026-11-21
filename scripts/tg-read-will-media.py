#!/usr/bin/env python3
"""Download Will Evans' recent media messages (chat 6648799778)."""
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-readwill3.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)
os.makedirs("/tmp/will-media", exist_ok=True)

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    msgs = await cl.get_messages(6648799778, limit=15)
    n = 0
    for m in msgs:
        if m.sender_id == 6648799778 and m.media is not None:
            ts = m.date.strftime("%m-%d_%H%M")
            path = await cl.download_media(m, f"/tmp/will-media/{ts}_{m.id}")
            if path:
                n += 1
                print(f"{ts} id={m.id} -> {path}")
    if n == 0:
        print("no downloadable media in last 15 msgs")
    await cl.disconnect()

asyncio.run(main())
