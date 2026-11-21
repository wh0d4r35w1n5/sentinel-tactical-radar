#!/usr/bin/env python3
"""Send the SQN judgement table as an inline image to Will Evans."""
import asyncio, json, os, shutil
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-send-sqnimg.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

CAPTION = "How to judge SQN \u2014 the complete rubric: formula, Van Tharp's canonical bands, the 10 trust-checks, and our real cells scored under it. All net of fees."

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    for attempt in range(4):
        try:
            await cl.send_file(6648799778, "/opt/sentinel/state/sqn-table-visual.png",
                               caption=CAPTION)
            print("image sent")
            break
        except FloodWaitError as e:
            print(f"flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 2)
    await cl.disconnect()

asyncio.run(main())
