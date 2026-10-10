#!/usr/bin/env python3
"""Send the business plan PDF + link to Will Evans. Session-copy pattern."""
import asyncio, json, os, shutil
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-send-pdf.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

CAPTION = (
    "📄 <b>Sentinel Tactical Radar — Business Plan</b>\n"
    "Full plan: architecture, edge machinery, honest performance (including the ugly numbers), "
    "risk register, phased model, and the ablation commitment from your review.\n\n"
    "Live link: https://54.66.217.111/api/sentinel-business-plan.pdf\n"
    "(also linked in the dashboard header)"
)

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    for attempt in range(4):
        try:
            await cl.send_file(6648799778, "/opt/sentinel/api/sentinel-business-plan.pdf",
                               caption=CAPTION, parse_mode='html')
            print("PDF sent")
            break
        except FloodWaitError as e:
            print(f"flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 2)
    await cl.disconnect()

asyncio.run(main())
