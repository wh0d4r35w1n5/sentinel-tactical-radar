#!/usr/bin/env python3
import asyncio, json, os, shutil
from telethon import TelegramClient

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS = os.path.expanduser("~/tg-sendwill-r2.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS)

MSG = """Will — your second pass hit paydirt. Computed the answers now rather than promising them at sweep end.

WIN/LOSS ASYMMETRY — the realized book (268 close fills):
WR 83.6% but avgWin +$0.125 vs avgLoss -$0.985 -> payoff ratio 0.13, profit factor 0.65, net -$15.32. Machine-only: PF 0.46. Your "small wins, larger losses" observation confirmed in the harshest terms.

EXPECTED side (13,713 shadow signal grades, same window) — per pattern, net of the 0.17% fee model:
  bounce:long   payoff 6.70x  PF 3.58  (+3.59% avg win / -0.54% avg loss)
  rect-break    payoff 4.35x  PF 4.89
  tri-sym       payoff 2.13x  PF 2.06
  bull-flag     payoff 1.97x  PF 1.63
  br:long       payoff 1.17x  PF 0.27   <- refrain cell
  bear-flag:s   payoff 0.48x  PF 0.08   <- refrain cell
  tri-asc       payoff 0.41x  PF 0.05   <- refrain cell
  ALL pooled    payoff 1.38x  PF 0.65

WHERE THE EDGE DISAPPEARS — the diagnosis you asked for:
The patterns' natural geometry is positive-asymmetry (wins 3-7x losses). The realized book runs the INVERSE (losses ~8x wins). The mechanism: the exit stack banks +0.1% ladder rungs while stops only fire near -1% — it manufactures 0.09-0.13x realized payoff out of patterns whose natural geometry is 4-7x. Identification isn't the sole problem — the exit geometry flips the sign on execution. Plus the fee toll: $4.96 on an ~$11 book (~45% of book) over the ledger window.

REGIME DEPENDENCE + WHEN TO REFRAIN: the mega-run episodes now carry timestamps, so each episode can be tagged with the concurrent BTC trend/vol/breadth regime — that table comes at sweep end. The shadow asymmetry already names unconditional-refrain cells (br:long, bear-flag, tri-asc, desc-tri — all PF<0.3). The breadth-rout brake exists already; the regime table will show whether it actually protects.

The interim action this implies: the exit geometry question is now the #1 open problem — more important than entry selection. The trail-rehab lane (ATR trails instead of fixed ladders, currently on probation cells) is the live test of exactly that hypothesis."""

async def main():
    cl = TelegramClient(SESS, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    await cl.send_message(6648799778, MSG)
    print("sent")
    await cl.disconnect()

asyncio.run(main())
