#!/usr/bin/env python3
"""tg-signal-login.py — re-auth the vip-signals session (state/tg-signal-sess).
  phase 1: python scripts/tg-signal-login.py            -> sends code to phone
  phase 2: python scripts/tg-signal-login.py 12345 [2fa] -> completes sign-in
Fresh session file = fresh auth key — does NOT disturb scripts/tg-session."""
import json, sys, asyncio
from pathlib import Path
from telethon import TelegramClient

BASE = "/opt/sentinel"
cfg = json.load(open(BASE + "/scripts/tg-config.json"))
PHONE = cfg["phone"]
API_ID, API_HASH = int(cfg["api_id"]), cfg["api_hash"]
SESS = BASE + "/state/tg-signal-sess"
HFILE = Path(BASE + "/state/tg-signallogin-hash.json")

async def main():
    c = TelegramClient(SESS, API_ID, API_HASH)
    await c.connect()
    if len(sys.argv) < 2:
        sent = await c.send_code_request(PHONE)
        HFILE.write_text(json.dumps({"phone_code_hash": sent.phone_code_hash}))
        print("CODE_SENT — check Telegram for the login code")
    else:
        code = sys.argv[1].strip().replace("-", "")
        h = json.loads(HFILE.read_text())["phone_code_hash"]
        try:
            await c.sign_in(PHONE, code, phone_code_hash=h)
        except Exception as e:
            if "PASSWORD" in type(e).__name__.upper() or "PASSWORD" in str(e).upper():
                pw = sys.argv[2] if len(sys.argv) > 2 else None
                if not pw:
                    print("NEEDS_2FA — rerun: tg-signal-login.py <code> <2fa-password>")
                    sys.exit(1)
                await c.sign_in(password=pw)
            else:
                raise
        me = await c.get_me()
        print("AUTHORIZED as", me.first_name, "| user id", me.id)
    await c.disconnect()

asyncio.run(main())
