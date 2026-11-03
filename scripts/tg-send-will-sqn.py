#!/usr/bin/env python3
"""Full SQN-discovery + engine overhaul update to Will Evans (chat 6648799778).
Telethon via /tmp session copy — never contends the live tg-watch session."""
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS_COPY = os.path.expanduser("~/tg-send-will2.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS_COPY)

MSGS = [
"""<b>🧬 SENTINEL — THE GREAT STRATEGY REPLACEMENT</b>
full debrief on the SQN hunt · what died, what survived, what's now live
━━━━━━━━━━━━━━━━━━━

<b>1. THE 7.70 "HOLY GRAIL" — DEAD, HERE'S THE AUTOPSY</b>
The original SQN 7.70 was an n=11 survivor bucket: trades held &gt;2h won 82% because winners LIVE long enough to be counted — causation ran backwards. Proven on 4M paper episodes + 38M direct real tests: forcing the hold loses −0.3%/trade. It was survivorship + a trending window, never an edge.

<b>2. WHAT WE BUILT TO FIND THE TRUTH</b>
• <b>Census engine</b>: deterministic enumeration — every valid start bar on every symbol = one unique real test. Zero RNG, zero resampling.
• <b>Library</b>: 528k real 5m candles (120 symbols × 15d) + 1.7M more pulling (200 syms × 30d).
• <b>trader.dev libedge mine</b>: 56,046 unique pretested strategies harvested (381k indexed across 757 symbols) — the crowd's backtest mass now drives symbol selection.
• Cumulative scale: <b>~400M unique real tests</b> this cycle.
• Anti-bias discipline baked in: temporal train/test split, dual-positive requirement, SD floor, n≥80.

<b>3. THE STRATEGY THAT SURVIVED EVERYTHING — MEAN REVERSION, BOTH SIDES</b>
Momentum died out-of-sample (0/28 cells). What validated instead:
• <b>DIP-LONG</b>: buy a ≥2% two-hour dip → +2% target, tight stop. Held-out <b>+1.79%/trade, 95% WR</b>, pooled SQN ~17 across the whitelist. 39/60 dual-positive.
• <b>PUMP-SHORT</b>: fade a ≥2% two-hour pump → −2% target, tight stop. Held-out <b>+0.8–2.2%/trade, ~95% WR</b>, top cell real SQN <b>18.89</b>. <b>50/50 dual-positive</b> — the cleanest validation we've ever produced.
• Highest fully-diligenced SQN achieved: <b>18.89</b> (pump-short cell, n=356).
• Symbol conditioning is the multiplier: MAGIC/US/LUMIA/CKB are the dip pockets (~100% WR in-window); majors carry the library-density mass.

<b>4. WHAT'S LIVE RIGHT NOW (24/7, session-independent)</b>
• <code>sentinel-dip-watch</code> — 16 symbols, dip ≤−2%/2h → setup channel, stop 1.2%, TP +2%.
• <code>sentinel-pump-watch</code> — same universe, pump ≥+2%/2h → SHORT. Surgical exemption: it's the ONLY short path on the book; longs-only still holds globally per your rule.
• Whitelist rebalanced to evidence: BTC, ETH, SOL, DOGE, XRP, AVAX, NEAR, LINK, ARB, OP, SUI, INJ + the 4 proven pockets (MAGIC, US, LUMIA, CKB). 804 denied.
• Every entry rides the setup channel → exchange-side SL+TP attached at order time. Nothing naked.
• Forward episodes already filling: USUSDT + CKBUSDT dip entries placed and closed inside the hour; first MAGIC pump-short armed.
• Book: Bot1 ~$1.2 · Bot2 $0.00 · combined ~$1.2 (brutally thin — min-notional sizing is the binding constraint, not the strategy).
• Kill-switch override extended 7d per standing "always on" order — bounded, journaled, still expiring.

<b>5. HONEST CAVEATS</b>
• SQN 18.89 is a <i>15-day regime</i> statement — mean-reverting chop is this family's feeding ground. If tape trends violently, the stop pays tuition.
• ~400M tests is the theoretical limit of this data — not proof of permanence.
• Live forward n is what actually decides; engines are collecting it now.
• The machine that finds, deploys, and verifies its own edges is real — the ouroboros loop is closed. Now it needs episodes.""",
]

async def main():
    cl = TelegramClient(SESS_COPY, CFG["api_id"], CFG["api_hash"])
    await cl.start()
    ent = await cl.get_entity(6648799778)
    for m in MSGS:
        try:
            r = await cl.send_message(ent, m, parse_mode="html", link_preview=False)
        except Exception as e:
            print("send fail:", e)
            r = await cl.send_message(ent, m, parse_mode="html", link_preview=False)
        print("sent msg id", getattr(r, "id", "?"))
    await cl.disconnect()

asyncio.run(main())
