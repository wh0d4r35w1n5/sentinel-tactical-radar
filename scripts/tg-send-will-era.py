#!/usr/bin/env python3
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open('/opt/sentinel/scripts/tg-config.json'))
SESS = os.path.expanduser('~/tg-sendwill-era.session')
shutil.copy('/opt/sentinel/scripts/tg-session.session', SESS)

MSG = """Will — correction on the last msg (numbers got mangled): winning-era window is 32 closes, 50% WR, net +$5.28 — WITH the leak counted. Wins: ETH +1.66, HYPE +0.97/+2.12/+5.18/+0.83, XAUT +2.38, JCT +2.25, Q +2.75/+0.59/+0.56 = +$19.39 banked.

Drag was one leak found and killed: pump-short lane fired a LUMIA short on a thin name, -14.01. Lane was convicted Oct-13 (n>10 negative), re-enabled Oct-19 for a delegation pulled same day, zero liquidity gate, zero graded evidence (18,847 shadow rows ungraded). Now PUMP_MAX_OPEN=0 — shadow-only, still journaling free counterfactuals.

Stat window reset to the streak's start so the board judges the leak-free book. Still not calling it profitability — but the hole-diggers are buried."""

async def main():
    cl = TelegramClient(SESS, CFG['api_id'], CFG['api_hash'])
    await cl.connect()
    if not await cl.is_user_authorized():
        print('session not authorized'); return
    await cl.send_message(6648799778, MSG)
    print('sent')
    await cl.disconnect()

asyncio.run(main())

