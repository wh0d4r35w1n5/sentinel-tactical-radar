#!/usr/bin/env python3
"""tg-login.py — two-phase sign-in (no PTY needed).
  phase 1: python scripts/tg-login.py            -> sends code to Telegram
  phase 2: python scripts/tg-login.py 12345      -> completes sign-in, lists groups
Reuses api creds from the old cleanup config; writes scripts/tg-session.session."""
import json, sys, asyncio
from pathlib import Path
from telethon import TelegramClient

try:
    cfg = json.load(open("scripts/tg-config.json"))
    PHONE = cfg.get("phone") or ""
except Exception:
    cfg = json.load(open(r"C:\Users\beaue\Documents\TelegramCleanupLocal\telegram_client_config.json"))
    PHONE = cfg["phone"]
API_ID, API_HASH = int(cfg["api_id"]), cfg["api_hash"]
HFILE = Path("state/tg-login-hash.json")

async def main():
    c = TelegramClient("scripts/tg-session", API_ID, API_HASH)
    await c.connect()
    if len(sys.argv) < 2:
        sent = await c.send_code_request(PHONE)
        HFILE.parent.mkdir(exist_ok=True)
        HFILE.write_text(json.dumps({"phone_code_hash": sent.phone_code_hash}))
        print("CODE_SENT")
    else:
        code = sys.argv[1].strip().replace("-", "")
        h = json.loads(HFILE.read_text())["phone_code_hash"]
        try:
            await c.sign_in(PHONE, code, phone_code_hash=h)
        except Exception as e:
            if "PASSWORD" in type(e).__name__.upper() or "PASSWORD" in str(e).upper():
                pw = sys.argv[2] if len(sys.argv) > 2 else None
                if not pw:
                    print("NEEDS_2FA — rerun: tg-login.py <code> <2fa-password>")
                    sys.exit(1)
                await c.sign_in(password=pw)
            else:
                raise
        me = await c.get_me()
        print("AUTHORIZED as", me.first_name)
        async for d in c.iter_dialogs():
            n = (d.name or "").lower()
            if any(k in n for k in ("vip", "signal", "crypto", "trade", "call", "alpha")):
                print("CANDIDATE:", d.id, "|", d.name)
    await c.disconnect()

asyncio.run(main())
