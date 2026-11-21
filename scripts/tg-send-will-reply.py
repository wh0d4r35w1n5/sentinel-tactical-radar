#!/usr/bin/env python3
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-sendwill-reply.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

MSG = """Will — your ChatGPT pass caught three real holes and one fair jab. Answers, with what's done about each:

1) Liquidity stratification: implemented mid-run. The mega-run now journals every episode {symbol, cell, timestamp, net%} plus a universe manifest with each coin's 24h quote volume — so post-hoc I can cut liquid / moderately liquid / illiquid terciles exactly as you asked. The cliff is steep, by the way: rank 400 of 800 is already down to $229k/day volume vs BTC's $2.4B. If the edge only exists in coins nobody can actually fill, the banded report will show that too — published either way.

2) SFP contradiction: fair catch, needs clarifying — the ENTRY is banned (strategy-policy marks it abandoned after 88 forward episodes). What deployed was the exit-geometry map (per-cell trail widths), which is dormant: it fires only on seats that exist, and no SFP seat can open. Exit settings and entry admission are separate axes; the config only matters if SFP ever re-qualifies on forward evidence.

3) Untouched validation: agreed — and it works in our favour. The run covers a full year, and ~9 months of that was never touched by any optimization (all prior tuning used only the last ~90 days). I'll report each cell split [untouched first ~9mo] vs [tuned last ~90d] — the untouched stretch is the honest out-of-sample number. The live shadow ledger keeps grading forward regardless.

4) Discovery vs validation: agreed. This run validates the handful of existing cells across the full book — no new strategies. The two under closest pressure are the ones you flagged: bounce:long (forward n=413, SQN 5.31) and Wyckoff-retest. If they don't survive 800 syms x 12 months, that answer gets printed.

5) The 700/1000 was a subjective judgement dressed as a number — conceded. The defensible artifacts are the CI95s and whether untouched-window results hold. Same for pRuin=0: conditional on the resampled distribution, blind to the gap-through-stop tail. Not a real-world zero.

And the cut-off line at the bottom of your last screenshot is the one that matters most — no SQN counts if the book doesn't retain profits. Live realized equity stays the final court; sims are just evidence about where to look.

Run restarted with the journaling patch ~12:31 UTC; first sweep's band-stratified numbers when it lands."""

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    await cl.send_message(6648799778, MSG)
    print("sent")
    await cl.disconnect()

asyncio.run(main())
