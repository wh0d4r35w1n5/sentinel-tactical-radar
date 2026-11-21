#!/usr/bin/env python3
"""Send the SQN judging reference PDF to Will Evans (chat 6648799778)."""
import asyncio, json, os, shutil
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-send-sqnref.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

CAPTION = (
    "\U0001F4D0 <b>How to Judge SQN — the complete reference table</b>\n"
    "Van Tharp's System Quality Number, full rubric:\n\n"
    "\u2022 The formula: SQN = (mean(R) \u00F7 \u03C3(R)) \u00D7 \u221An \u2014 expectancy over dispersion, confidence-weighted by sample size.\n"
    "\u2022 His canonical bands, verbatim: <0 losing \u00B7 <1.6 hard to trade \u00B7 1.6-1.9 below avg \u00B7 2.0-2.4 average \u00B7 2.5-2.9 good \u00B7 3.0-4.9 excellent \u00B7 5.0-6.9 superb \u00B7 \u22657.0 holy grail (suspect data first).\n"
    "\u2022 The 10-point checklist before trusting a number (n, net-of-fees, regime, backtest\u2260forward, \u03C3, WR-is-not-the-metric, shrinkage, per-cell, maxDD pairing, overfit audit).\n"
    "\u2022 Worked examples from our own runs \u2014 Wyckoff 5.87 superb band, SFP 2.55 but abandoned on forward, all-signals \u22122.30.\n\n"
    "Written for a scientist: measure first, celebrate later."
)

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    for attempt in range(4):
        try:
            await cl.send_file(6648799778, "/opt/sentinel/state/sqn-judgement-table.pdf",
                               caption=CAPTION, parse_mode='html')
            print("pdf sent")
            break
        except FloodWaitError as e:
            print(f"flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 2)
    await cl.disconnect()

asyncio.run(main())
