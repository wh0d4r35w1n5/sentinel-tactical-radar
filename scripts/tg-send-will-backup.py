#!/usr/bin/env python3
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open('/opt/sentinel/scripts/tg-config.json'))
SESS = os.path.expanduser('~/tg-sendwill-backup.session')
shutil.copy('/opt/sentinel/scripts/tg-session.session', SESS)

FILE = '/root/sentinel-master-v1.30-full.tar.gz'
CAPTION = """Master Version V1.30 — FULL offline backup of /opt/sentinel (everything: code, configs, .env, sessions, state, history). Operator-ordered copy for safekeeping. Also committed+tagged v1.30 and pushed to private repo sentinel-master-v1.30 on GitHub (secrets excluded from GitHub — they're only in this tarball and the offline copy)."""

async def main():
    cl = TelegramClient(SESS, CFG['api_id'], CFG['api_hash'])
    await cl.connect()
    if not await cl.is_user_authorized():
        print('session not authorized'); return
    await cl.send_file(6648799778, FILE, caption=CAPTION,
                     progress_callback=lambda s, t: print(f'\rupload {s*100//t}%', end='', flush=True))
    print('\nsent')
    await cl.disconnect()

asyncio.run(main())

