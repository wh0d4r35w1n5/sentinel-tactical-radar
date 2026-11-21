#!/usr/bin/env python3
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open('/opt/sentinel/scripts/tg-config.json'))
SESS = os.path.expanduser('~/tg-sendwill-sniper.session')
shutil.copy('/opt/sentinel/scripts/tg-session-revived.session', SESS)

MSG = '''Will — the sniper idea isn't dumb, it's literally the same edge every launch trader on Solana runs. Every pump.fun token is born on a bonding curve at the same starting price, and the curve only moves UP as buys hit it. The crowd finds new tokens through website listings and Dexscreener — those lag on-chain creation by minutes. We detect the mint the second it's created on the blockchain, before any listing exists, and buy the bottom of the curve. Then we sell into the launch pump the crowd creates when they finally show up. It's buying before the audience arrives. The rugs cost us /usr/bin/bash.18 each; the ones that catch a bid pay for ten of them. Asymmetric bets, mechanical edge — that's the whole game.'''

async def main():
    cl = TelegramClient(SESS, CFG['api_id'], CFG['api_hash'])
    await cl.connect()
    if not await cl.is_user_authorized():
        print('session not authorized'); return
    await cl.send_message(6648799778, MSG)
    print('sent')
    await cl.disconnect()

asyncio.run(main())
