import json, asyncio
from telethon import TelegramClient

cfg = json.load(open("/opt/sentinel/scripts/tg-config.json"))

async def main():
    c = TelegramClient("/opt/sentinel/scripts/tg-session", cfg["api_id"], cfg["api_hash"])
    await c.connect()
    if not await c.is_user_authorized():
        print("SESSION NOT AUTHORIZED")
        return
    me = await c.get_me()
    print("AUTH as", me.first_name, me.username or "", me.phone or "")
    async for d in c.iter_dialogs(limit=60):
        e = d.entity
        t = type(e).__name__
        if t not in ("Chat", "Channel", "User"):
            continue
        admin = getattr(e, "admin_rights", None) is not None or getattr(e, "creator", False)
        kind = t
        if t == "Channel":
            kind = "CHAN-mega" if getattr(e, "megagroup", False) else "CHAN-bcast"
        print("%-16d %-10s %-42s admin=%s unrd=%s" % (d.id, kind, (d.name or "?")[:40], admin, d.unread_count))
    await c.disconnect()

asyncio.run(main())
