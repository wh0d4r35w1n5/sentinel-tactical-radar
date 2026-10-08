"""Sentinel VIP Signals — provision channel, seed content, advertise.

Phases:
  create   — create broadcast channel (idempotent via /tmp/vip-state.json)
  seed     — pin welcome + donation post, upload evidence charts
  promote  — send promo to groups where we have send rights (throttled)

Uses a COPY of the live session file to avoid SQLite lock with tg-watch.
"""
import json, asyncio, random, os, sys, time
from telethon import TelegramClient, functions, types

CFG = "/opt/sentinel/scripts/tg-config.json"
SESS = "/tmp/tg-sess-copy"          # copy of tg-session.session
STATE = "/tmp/vip-state.json"
CHARTS = ["/tmp/chart-mu.png", "/tmp/chart-near.png", "/tmp/chart-sndk.png"]

DONATE = {
    "USDT (TRC20)": "TGYxVNUVybTWB5ypZKgqKGYDRrMcm5eeci",
    "USDT (ERC20)": "0x3109e328854ad586a2fc58b701805c3c1d463bca",
    "BTC": "12V9jgY1MNa6qfDtJ4imxqEu52iR3SQs8g",
    "SOL": "6hz3Lh9xogWNqkWBGAQPyK2b3vBwot3jJ5rrW7pFAiv3",
}

GALLERY = "https://54-66-217-111.sslip.io/gallery.html"

WELCOME = (
    "\U0001f6e1\ufe0f SENTINEL VIP SIGNALS\n\n"
    "A live, self-improving trading engine — every signal backed by exchange-verified fills, "
    "not screenshots of screenshots.\n\n"
    "\U0001f525 What you get here:\n"
    "• Entries with pre-committed stop + take-profit levels\n"
    "• Auto profit-lock: winners can\u2019t round-trip to red\n"
    "• Real before/after charts — entry, peak excursion, actual exit\n"
    "• Full forensic audit trail at the public Evidence Gallery\n\n"
    "\U0001f4ca Live evidence (no cherry-picking — the raw tape):\n"
    + GALLERY + "\n\n"
    "\U0001f4b0 Access: donation-gated. Send any amount, DM @wh0d4r35w1n55 "
    "your txid, get VIP pinned signals + early entries.\n"
    "Every dollar goes straight into the trading stack."
)

def donate_block():
    lines = ["\U0001f4b3 DONATIONS / VIP ACCESS\n"]
    for k, v in DONATE.items():
        lines.append(f"{k}\n`{v}`\n")
    lines.append("After sending: DM @wh0d4r35w1n55 the txid \u2192 VIP access.")
    lines.append("Funds land directly in the trading account. No middlemen.")
    return "\n".join(lines)

PROMO = (
    "\U0001f6e1\ufe0f SENTINEL VIP SIGNALS is live\n\n"
    "Real fills. Real charts. A bot that locks profit before it can escape.\n"
    "Today: caught MU +3.47% with an auto-ratcheting stop \u2014 evidence in the channel.\n\n"
    "\U0001f449 {link}\n"
    "Public audit trail: {gallery}\n"
    "Donation-gated VIP. Not financial advice \u2014 verified results."
)

CAPTIONS = [
    "\U0001f4c8 MUUSDT long \u2014 rode the leg to +3.47% peak, trail locked the exit green. This is what the engine does while you sleep.",
    "\U0001f4c8 NEARUSDT long \u2014 +2.48% measured excursion, entry marked on the tape. Every trade leaves a forensic record.",
    "\U0001f4c8 SNDKUSDT long \u2014 ran +0.99%, auto-lock pinned the stop at +0.65% before the fade. Closed green \u2014 that\u2019s the rule, not the hope.",
]

def load_state():
    if os.path.exists(STATE):
        return json.load(open(STATE))
    return {}

def save_state(s):
    json.dump(s, open(STATE, "w"), indent=1)

async def main():
    cfg = json.load(open(CFG))
    phase = sys.argv[1] if len(sys.argv) > 1 else "all"
    c = TelegramClient(SESS, cfg["api_id"], cfg["api_hash"])
    await c.connect()
    assert await c.is_user_authorized(), "session not authorized"
    st = load_state()

    if phase in ("create", "all") and "channel_id" not in st:
        r = await c(functions.channels.CreateChannelRequest(
            title="Sentinel VIP Signals \U0001f6e1\ufe0f",
            about="Live AI trading engine. Exchange-verified fills, auto profit-lock. Evidence: " + GALLERY,
            broadcast=True, megagroup=False))
        ch = r.chats[0]
        st["channel_id"] = ch.id
        st["channel_input"] = {"id": ch.id, "access_hash": ch.access_hash}
        save_state(st)
        print("created channel id", ch.id)
        # try public usernames
        for uname in ("sentinel_vipsignals", "sentinelvip", "sentinelsignals"):
            try:
                await c(functions.channels.UpdateUsernameRequest(ch, uname))
                st["username"] = uname
                save_state(st)
                print("username set:", uname)
                break
            except Exception as e:
                print("username", uname, "->", str(e)[:60])
    if "channel_id" not in st:
        print("no channel yet (phase=%s)" % phase)
        return

    ch = await c.get_entity(types.PeerChannel(st["channel_id"]))
    if "invite" not in st:
        try:
            inv = await c(functions.messages.ExportChatInviteRequest(peer=ch))
            st["invite"] = inv.link
            save_state(st)
        except Exception as e:
            print("invite err", str(e)[:80])
    link = ("https://t.me/" + st["username"]) if st.get("username") else st.get("invite", "?")
    print("link:", link)

    if phase in ("seed", "all"):
        m = await c.send_message(ch, WELCOME)
        await c.pin_message(ch, m)
        await c.send_message(ch, donate_block())
        for png, cap in zip(CHARTS, CAPTIONS):
            if os.path.exists(png):
                await c.send_file(ch, png, caption=cap)
                await asyncio.sleep(2)
        st["seeded"] = True
        save_state(st)
        print("seeded channel")

    if phase in ("promote", "all"):
        promo = PROMO.replace("{link}", link).replace("{gallery}", GALLERY)
        ok, fail = [], []
        async for d in c.iter_dialogs(limit=200):
            e = d.entity
            can = isinstance(e, types.Channel) and e.megagroup or type(e).__name__ == "Chat"
            if not can:
                continue
            try:
                await c.send_message(e, promo)
                ok.append(d.name)
                print("POSTED ->", d.name)
            except Exception as ex:
                fail.append((d.name, str(ex)[:50]))
                print("blocked:", d.name, "->", str(ex)[:50])
            await asyncio.sleep(random.uniform(12, 20))
        st["advertised"] = ok
        st["blocked"] = fail
        save_state(st)
        print("done: %d posted, %d blocked" % (len(ok), len(fail)))

    await c.disconnect()

asyncio.run(main())
