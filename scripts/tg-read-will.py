#!/usr/bin/env python3
"""Read Will Evans' recent messages (chat 6648799778)."""
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-readwill2.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    msgs = await cl.get_messages(6648799778, limit=40)
    for m in msgs:
        who = "HIM" if (m.sender_id == 6648799778) else ("US" if m.out else f"other:{m.sender_id}")
        ts = m.date.strftime("%m-%d %H:%M") if m.date else "?"
        txt = (m.message or "").replace("\n", " | ")[:300]
        kind = ""
        if m.media is not None:
            kind = " [MEDIA]"
        print(f"{ts} {who}: {txt}{kind}")
    await cl.disconnect()

asyncio.run(main())
