#!/usr/bin/env python3
"""Send the SQN + backtest week-findings PDF to Will Evans (chat 6648799778).
Session-copy pattern — same as tg-send-will-v11.py."""
import asyncio, json, os, shutil
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-send-sqn2.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

CAPTION = (
    "\U0001F4CA <b>Sentinel — SQN &amp; Backtest week findings</b>\n"
    "7,996 signals \u00B7 90d \u00D7 25 syms \u00B7 net of fees.\n\n"
    "\u2022 Retest-entry = biggest lever: Wyckoff SQN 3.91\u2192<b>5.87</b> (+855%); the only positive short cells exist ONLY on retest entries.\n"
    "\u2022 Unconditional shorts: ~10,500 shadow eps, all net-negative \u2014 promotion stays empty.\n"
    "\u2022 Exits are per-cell: trails rescue momentum (+1.27 SQN), strangle Wyckoff (\u21921.54).\n"
    "\u2022 Honesty: SFP +381% sim but abandoned on 88 fwd eps; PA Quartile \u221225% sim but the only LIVE cell (73% hit).\n"
    "\u2022 Monte Carlo: chain score&lt;85 \u2192 SQN100 4.66, terminal 1.38x, pRuin 0. LiqSweep:SHORT admitted to the chain gate.\n"
    "\u2022 Best forward cell: bounce:long n=413, +0.84%/ep, SQN 5.31."
)

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    for attempt in range(4):
        try:
            await cl.send_file(6648799778, "/opt/sentinel/state/sqn-backtest-findings.pdf",
                               caption=CAPTION, parse_mode='html')
            print("pdf sent")
            break
        except FloodWaitError as e:
            print(f"flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 2)
    await cl.disconnect()

asyncio.run(main())
