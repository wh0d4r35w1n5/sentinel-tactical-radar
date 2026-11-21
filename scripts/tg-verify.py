import json, asyncio
from telethon import TelegramClient, types

CFG = "/opt/sentinel/scripts/tg-config.json"
SESS = "/tmp/tg-sess-vfy"

async def main():
    cfg = json.load(open(CFG))
    c = TelegramClient(SESS, cfg["api_id"], cfg["api_hash"])
    await c.connect()
    me = await c.get_me()
    hits = []
    async for d in c.iter_dialogs(limit=200):
        e = d.entity
        if not ((isinstance(e, types.Channel) and e.megagroup) or type(e).__name__ == "Chat"):
            continue
        try:
            async for m in c.iter_messages(e, limit=15, from_user=me):
                if "sentinel_vipsignals" in (m.message or "") or "SENTINEL VIP" in (m.message or ""):
                    hits.append((d.name, m.id))
                    break
        except Exception:
            pass
    for n, i in hits:
        print("DELIVERED:", n, "msg", i)
    print("total delivered:", len(hits))
    await c.disconnect()

asyncio.run(main())
