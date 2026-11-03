#!/usr/bin/env python3
"""Response to Will Evans's screenshot interpretation — his headline question
answered with a dedicated artifact + the reject-markout build."""
import asyncio, json, os, shutil
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS_COPY = os.path.expanduser("~/tg-send-answer2.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS_COPY)

MSGS = [
"""<b>🤖 YOUR HEADLINE QUESTION — ANSWERED WITH A DEDICATED ARTIFACT</b>
<i>"Of all trades Sentinel has made completely autonomously, without manual intervention, what is cumulative realised net profit after every fee — separately for exchange and Solana on-chain?"</i>

api/autonomous-pnl.json — recomputed every cycle, on the public dashboard under 🤖 AUTONOMOUS-ONLY NET:

<b>Exchange (futures): −$4.18</b>
48 closes, $0.91 fees, gross −$3.27. Attribution: Bitget src 'api' fills plus a FIFO replay of open quantities (ios/web opens = manual) — closes inherit the majority source. Manual book: <b>−$50.62</b> across 184 closes. The −$54.80 total is 92% manual trading, not the engine's.

<b>On-chain (Solana): +$0.19</b>
Purse $2.28 vs $2.09 seeded. Every fill in that wallet is engine-only by construction — realized+unrealized combined, all flows included. Two open positions marking +$0.23 unrealized on $1.13 cost.

<b>Combined autonomous: −$3.99</b> — after every journaled fee.""",

"""<b>YOUR THREE SUGGESTIONS — STATUS</b>

<b>1. Measure rejected trades — built.</b> api/reject-markout.json: every refused candidate is now stamped (price + timestamp + which gate killed it) and marked forward at 5/15/60 minutes. Direction-aware: a LONG veto "wins" when the candidate falls after refusal. The tracker aggregates per-gate — so shortly the dashboard won't just say "skipped 19 trades," it'll say <i>which vetoes saved money and which refused winners</i>. It needs a day or two of episodes before the h60 column means anything — the measurement infrastructure is live now.

<b>2. Complete round-trip profitability.</b> Exchange side: every fill carries fee + profit, net-of-all-fees is the reported number (the −$4.18 is post-everything). On-chain: purse-minus-seeded-capital is the honest total; per-tx gas is declared a blind spot rather than estimated — it's ~lamports scale, and the SOL gas balance is reported <i>separately</i> from the purse on your exact double-counting concern.

<b>3. Tiny account stays tiny.</b> Already policy: no capital increase until out-of-sample positive expectancy on the one live strategy (PA Quartile). The $2 purse is the test bench.""",

"""<b>ON YOUR SCREENSHOT READS — TWO CLARIFICATIONS</b>

<b>Selectivity vs intelligence:</b> your caveat is correct and the machine now measures it. But the 19 skipped trades weren't the interesting part — the three-way shadow experiment (api/shadow-ab.json) already showed the evidence-only book beating both other variants, and the strategy lifecycle now hard-blocks everything except PA Quartile from touching money. The veto count went UP after that policy landed — most refusals are now the edge filter doing its job, which the markout scoreboard will prove or disprove publicly.

<b>Solscan verification:</b> right that a signature proves occurrence, not correct accounting. That's why the lane reconciles wallet-token-accounts vs the local book every cycle (the earlier phantom-position bug was found exactly this way) and why the independent validator recomputes headline numbers from raw sources rather than trusting the engine's summaries.

The number you're now watching is on the dashboard, recomputed every ~2min, attributed by the same FIFO rule the ledger uses. If the combined figure drifts negative on real evidence, the policy — not a person — demotes the strategy.

— Sentinel"""
]

async def main():
    cl = TelegramClient(SESS_COPY, CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        print("session not authorized"); return
    for m in MSGS:
        for attempt in range(4):
            try:
                await cl.send_message(6648799778, m, parse_mode='html')
                print(f"sent {len(m)} chars")
                break
            except FloodWaitError as e:
                print(f"flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 2)
        await asyncio.sleep(1.5)
    await cl.disconnect()

asyncio.run(main())
