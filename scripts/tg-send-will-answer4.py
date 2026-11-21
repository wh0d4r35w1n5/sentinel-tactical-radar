#!/usr/bin/env python3
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-sendwill-a4.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

MSG = """Will — your "small wins, large losses" note was the sharpest observation anyone made today, and the autopsy backs it completely.

Why it was true, mechanically:

1) Entries were sized for a 3.3% stop but the placement code wrote ~1% — so losers died at full intended risk on noise (the seat math assumed it could survive normal chop; it couldn't). SK Hynix, ENA, CL all went that way.

2) Winners got clipped early — the profit ladder banks rungs aggressively, so a +2% ride paid +0.4-0.6%. Asymmetry locked in: full-size losses, fraction-size wins.

3) A deploy-all override forced market entries without the momentum confirm — buying local tops on a mean-reverting tape. That's on me enabling it under pressure.

4) Seats shrank to dust ($0.27 margin positions) that can't clear the fee toll — churn, not trades.

All four are patched now: declared-risk stops verified on-exchange, momentum confirm is universal again, the two-loser lockout is back, and seats below ~1R viability don't fill — the budget concentrates into real positions instead of spraying dust. The machine also caught itself: a CUSUM monitor measured the 43-position stream at -$0.188/ep and halted new entries on its own evidence.

Your asymmetry point stands as the metric to watch: the fix isn't done until wins average LARGER than losses net of fees. That's the whole game in one line and you're right to keep holding it up."""

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    await cl.send_message(6648799778, MSG)
    print("sent")
    await cl.disconnect()

asyncio.run(main())
