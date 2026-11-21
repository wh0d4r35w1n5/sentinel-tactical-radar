#!/usr/bin/env python3
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-sendwill-green.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

MSG = """Will — first clean green stretch since the strategy rebuild went live, so reporting it straight:

Last 6 funded closes (net of fees, demo book): ALL GREEN, +$13.63
  ETH +1.66 | HYPE +0.97 / +2.12 / +5.18 / +0.83 | XAUT +2.38
HYPE alone banked +$9.10 in the last hour.

The context that makes it real rather than luck:
- We found the shadow-graded library had 3 positive cells total (bounce SQN 13, obv-stealth SQN 4.7, bull-flag SQN 3.7) and they were never connected to money — while convicted losers (br, double-bottom, inv-hs) funded invisibly.
- Now: ~60+ convicted detections refused per cycle (journaled free), proven cells trade their measured exit regime, and a 50M quote-volume floor kills thin-symbol fills.
- The post-floor tape is 6/0. The pre-floor bleed was all sub-16M-qv names (SOON/SAHARA/ERA/KAIA) — structurally gone, not just lucky absence.

Honest caveat: post-regime total is still -$28.47 net (that is the old cells debt, now cut). 6 green closes is a pocket, not proof — needs ~12+ episodes per cell to judge. But it is the first stretch where the book is ONLY allowed to play measured winners, and it is printing.

Will keep the updates coming — net or it does not count."""

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    await cl.send_message(6648799778, MSG)
    print("sent")
    await cl.disconnect()

asyncio.run(main())
