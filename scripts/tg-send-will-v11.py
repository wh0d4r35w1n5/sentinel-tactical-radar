#!/usr/bin/env python3
"""Send the V1.1 master backup archive to Will Evans. Session-copy pattern."""
import asyncio, json, os, shutil
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-send-v11.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

CAPTION = (
    "📦 <b>Sentinel Tactical Radar — Master Version V1.1 (full backup)</b>\n"
    "Complete offline snapshot: all engine scripts, every api artifact (evidence layer, ledger recon, "
    "shadow race, autonomous P&amp;L, libedge matrix, on-chain lane), state config, dashboard source, "
    "AGENTS.md rules. Credentials and sessions excluded by construction.\n\n"
    "Frozen restore set also stored root-protected on the box at /opt/sentinel/state/v1.1-master/ "
    "(exec, watch, liq-guard, ft, rr-config, env).\n\n"
    "Since V1.0: trader.dev 390k-strategy library integrated as per-symbol archetype evidence matrix, "
    "autonomous-P&amp;L headline, reject markout scoreboard, strategy lifecycle wired into the order gate, "
    "on-chain lane realtime marks + round-trip proven (sell → USDC → Bitget deposit confirmed on-chain)."
)

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    for attempt in range(4):
        try:
            await cl.send_file(6648799778, "/opt/sentinel/state/sentinel-v1.1-master.tar.gz",
                               caption=CAPTION, parse_mode='html')
            print("archive sent")
            break
        except FloodWaitError as e:
            print(f"flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 2)
    await cl.disconnect()

asyncio.run(main())
