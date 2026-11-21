#!/usr/bin/env python3
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-sendwill-a3.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

MSG = """Will — catching up on everything you asked.

1) "Main change / trade count much higher": yes — a deployment mandate lane went live today. It arms seats on top-30 liquid names (crypto + tokenized stocks/metals) and used to wait for a +0.2% momentum print before filling; under a direct operator override it now seats immediately. That's the trade-count jump. Honest scorecard on day one: it found a real bug — entries declared 3.3% stops but the placement code wrote ~1%, so seats sized for proper risk died on noise (SK Hynix, ENA, CL all killed early). That's fixed and verified on the exchange now. Today was still red — the fix is structural, not a promise.

2) "How is success measured": net-of-fee realized equity, full stop. Not win rate — a 40% WR book with big winners beats a 60% bleeder. Concretely: the live ledger journals every fill's profit net of fees, each (strategy, direction) cell keeps a running SQN (net/risk per episode), and a GOD audit runs every ~15min checking plan freshness, per-seat protection, integrity CRCs, and deployment. A cell that goes measured-negative gets convicted and stops receiving orders.

3) "Do I have access on Telegram": yes — this panel: /status for book state, /pos for open seats, /eq for equity, /ein for the research desk's live findings, /quant for the quant read. The VIP channel posts real fill cards as they happen.

4) The van and the hospital admission — genuinely glad Sue and Ed came through on the loan, even at 10%. Hope the admission goes clean, and good call on the Pack and Send route for the kit. Get the tax refund sorted first though — no rush on anything here from my side, the machine keeps working either way."""

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    await cl.send_message(6648799778, MSG)
    print("sent")
    await cl.disconnect()

asyncio.run(main())
