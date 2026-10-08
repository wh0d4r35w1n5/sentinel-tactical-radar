"""One-off: rewrite the VIP channel's pinned welcome + donation posts to
the $50 access model."""
import json, asyncio
from telethon import TelegramClient, types

CFG = "/opt/sentinel/scripts/tg-config.json"
SESS = "/tmp/tg-sess-copy"
VIP = "/tmp/vip-state.json"

WELCOME = (
    "🛡️ <b>SENTINEL VIP SIGNALS</b>\n\n"
    "A live self-improving trading engine. Every signal here is a real fill "
    "with exchange-verified entry, stop and exit — not a screenshot.\n\n"
    "📡 <b>What runs on this desk</b>\n"
    "• Signals with pre-committed SL / TP geometry\n"
    "• Auto profit-lock — green trades can't round-trip to red\n"
    "• Crash brake + scaled trims on every position\n"
    "• Full forensic audit: <a href='https://54-66-217-111.sslip.io/gallery.html'>live evidence gallery</a>\n\n"
    "💎 <b>VIP access — $50 USDT</b> (or equivalent in BTC / ETH / SOL)\n"
    "Pay → DM @wh0d4r35w1n55 your txid → confirmed on-chain → access.\n"
    "Funds go straight into the trading stack."
)

DONATE = (
    "💳 <b>VIP ACCESS — $50 USDT or equivalent</b>\n\n"
    "USDT (TRC20)\n<code>TGYxVNUVybTWB5ypZKgqKGYDRrMcm5eeci</code>\n\n"
    "USDT (ERC20)\n<code>0x3109e328854ad586a2fc58b701805c3c1d463bca</code>\n\n"
    "BTC\n<code>12V9jgY1MNa6qfDtJ4imxqEu52iR3SQs8g</code>\n\n"
    "SOL\n<code>6hz3Lh9xogWNqkWBGAQPyK2b3vBwot3jJ5rrW7pFAiv3</code>\n\n"
    "Send $50 worth of any asset above, then DM @wh0d4r35w1n55 the txid.\n"
    "<i>Verified on-chain — no screenshots needed. Not financial advice.</i>"
)

async def main():
    cfg = json.load(open(CFG))
    vip = json.load(open(VIP))
    c = TelegramClient(SESS, cfg["api_id"], cfg["api_hash"])
    await c.connect()
    assert await c.is_user_authorized()
    ch = await c.get_entity(types.PeerChannel(vip["channel_id"]))
    edited = {"welcome": False, "donate": False}
    async for m in c.iter_messages(ch, limit=30):
        body = m.message or ""
        if not edited["welcome"] and "SENTINEL VIP SIGNALS" in body:
            await c.edit_message(ch, m.id, WELCOME, parse_mode="html", link_preview=False)
            edited["welcome"] = True
            print("edited welcome", m.id)
        elif not edited["donate"] and ("DONATION" in body or "TGYx" in body):
            await c.edit_message(ch, m.id, DONATE, parse_mode="html", link_preview=False)
            edited["donate"] = True
            print("edited donate", m.id)
    print("done", edited)
    await c.disconnect()

asyncio.run(main())
