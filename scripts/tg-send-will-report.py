#!/usr/bin/env python3
"""Send the forensic response to Will Evans's Oct-10 critical review.
Session-copy pattern — never contends the live watcher's sqlite session.
"""
import asyncio, json, os, shutil
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS_COPY = os.path.expanduser("~/tg-send-report.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS_COPY)

MSGS = [
"""<b>📋 SENTINEL — FORENSIC RESPONSE TO YOUR REVIEW</b>
Your ChatGPT critical review (10 Oct) — every point answered with evidence, not vibes. 5 questions at the end of your doc get their own section.
━━━━━━━━━━━━━━━━━━━

<b>A. "SOPHISTICATED ≠ PROFITABLE" — AGREED, AND HERE'S THE SCOREBOARD</b>
Your central charge is correct and the machine's own journal proves it. Full honest state:

• All-time real fills (Bitget, since go-live): <b>232 closes, net −$54.80, fees $23.85, PF 0.22, WR 23.7%</b>
• Split: manual/operator trading = 184 closes, −$50.62 (92% of the bleed). Bot-attributed = 48 closes, −$4.18.
• Gross P&amp;L before fees: −$30.95 → fees added <b>+77%</b> on top of the gross loss.
• Futures account right now: $0.00 (drained — see fees + withdrawals). On-chain purse: ~$4.80 working.

Net profit after every cost is the only number that matters — it's negative, and the ledger shows it plainly.""",

"""<b>B. YOUR FOUR FLAGGED IMPROVEMENTS — STATUS + RESERVATIONS TAKEN</b>

<b>1. Signal fusion</b> — you called the learning unproven. Correct, and worse than you guessed: the eval engine's own stats show the composite score currently has <b>~zero 24h predictive alpha</b> — dirAcc24h 52.6%, IC24h 0.005, and the A-grade cohort actually UNDERPERFORMS B-grades (A: 25.2% hit / −0.33 alpha; BB: 37.7% / +0.19). The ranking is inverted vs outcomes. The ridge now has something real to fix — or to prove unfixable. n=26,344 evals exist but are heavily autocorrelated (your overlap point, below).
→ No defense: the machinery is elegant, the edge is not yet demonstrated.

<b>2. BTC-relative strength</b> — bounded ±4 tilt, working as designed. SOL/ETH/ZEC reads live-verified.

<b>3. Inventory skew</b> — your "zero interventions" catch stands: armed but untriggered (book's been near-empty). The 1.5× corr weight is a prior, not a measurement — flagged in code as such; it calibrates once filled positions accumulate.

<b>4. Regime-conditional strategy weighting</b> — your n≥15 objection is right. Raised internally: the override bar needs ~30+ for a trustworthy cell estimate; note 15 was the SOFT-START floor, the block path is the one that bites first.""",

"""<b>C. ON-CHAIN LANE — YOUR "SEPARATE BUSINESS" CALL: IMPLEMENTED</b>
You said treat it as an experimental second business with its own accounting. Done:

• On-chain fills journal separately (<code>onchain-fills.json</code>) — never mixed into Bitget books.
• Its own persona in the Pimp City attribution engine (<b>Solana Sadie</b>, freelance) — her P&amp;L, wins/losses, and vault carry tracked independently. Every fill carries a solscan-verifiable tx signature.
• Its own purse caps: 25% clips, $25/position max, 2 positions max, $40 total deployed ceiling.
• New dashboard panel: <code>api/onchain-lane.json</code> now publishes wallet, purse, gas, positions, and the last 12 fills every cycle — the "where did my $5 go" question now has a visible answer on the board.

Your remaining concerns stand as design constraints: software trails CAN fail when liquidity evaporates (no exchange-side stop exists on-chain), Rugcheck is a screen not a guarantee, and the 72% trail can give back 28% before exit. The purse cap exists precisely because of this.""",

"""<b>D. THE $5 FUNDING CHASE — YOU WERE RIGHT, AND IT'S DONE</b>
"Engineering effort worth more than $5" — correct call. For the record though: the route completed. USDGO→wallet→gasless swap→SOL→bootstrap→<b>$2.09 USDC + 0.025 SOL live in the lane</b>. Verified on-chain, tx-signed. It cost ~$2 in fees/relayer tolls — exactly the economics you predicted.

The bigger principle landed: the key is futures-trade-only (40014 on everything else). Physical vault moves need either a perms upgrade or manual sweeps — documented, not worked around.""",

"""<b>E. COMPLEXITY > EVIDENCE — THE ABLATION POINT</b>
Your hardest hit: 9 new subsystems in 7 commits, no controlled comparison. Honest status:

• A frozen v1.0-master snapshot EXISTS on the VPS (protection stack + exec + rr-config from Oct 7).
• A cross-engine benchmark exists (freqtrade-bench.json).
• What does NOT exist: a live shadow A/B — old scoring vs new on identical tape. That's the correct next build, and it's now top of the roadmap: shadow-score every signal both ways, seal both evals, diff the P&amp;L curves. No more "which commit made the money" ambiguity.

<b>F. LEARNING SELF-DECEPTION TRAPS — AUDITED</b>
1. <b>Overlapping observations</b> — real. 26k evals ≠ 26k independent samples; same-symbol signals minutes apart share one 24h outcome. The eval feed needs symbol-time bucketing (partially exists via keys; not enforced as independence).
2. <b>Simulated vs executable</b> — evals are signal forward-marks, not fills. Entry/exit at signal price assumed; no fee/slip deduction in the label. Stated honestly: eval α≠ tradeable α.
3. <b>Selection bias</b> — actually the eval set is UNBIASED by execution: every emitted signal gets labeled, traded or not. The other direction is the gap — rejected-never-emitted candidates leave no record.
4. <b>Adapting too fast</b> — shrinkage λ=30 + n/(n+300) blend cap 0.7 exist; the 40-eval gate you questioned is deliberately the SLOW ramp, not full trust.""",

"""<b>G. YOUR 5 QUESTIONS — DIRECT ANSWERS</b>

<b>Q1. Evals based on executed trades or hypothetical outcomes?</b>
Hypothetical signal outcomes — every emitted signal gets 1h/4h/24h forward labels (alpha vs BTC + raw fwd). Zero are fill-linked. The trade journal is a separate record.

<b>Q2. Can upgraded vs previous be compared on identical conditions + costs?</b>
Not yet — that's the ablation harness (see E). v1.0-master is frozen on the VPS so the reference implementation exists; the live-shadow scorer is the missing piece.

<b>Q3. How many genuinely independent evals / how is 24h overlap handled?</b>
26,344 labeled, effective-independence much lower (same symbol, same day, overlapping windows). Current handling: none explicit — your point is a real methodological gap. Planned fix: cluster evals by symbol+day before they count toward fusion weight evidence.

<b>Q4. Does Kelly let a negative-edge strategy stand down completely, or does the 0.3 floor force exposure?</b>
You found a real bug. Book-level: f*≤0 → full stand-down already. Strategy-level: floored at 0.3× — a measured-negative cell still took 30% size. <b>Fixed and deployed</b>: f*≤0 per-strategy now vetoes the order entirely (gate label <code>kelly-negative</code> on the reject log). Zero bullets for proven bleeders.

<b>Q5. Realised net, max DD, total fees+slippage, avg net/trade?</b>
• Net: <b>−$54.80</b> (−$4.18 bot-attributed, −$50.62 manual/foreign)
• Fees: <b>$23.85</b> | slippage embedded in fills, not separately journaled (gap noted)
• Max DD: ~100% of funded equity (deposits ~$28 + USDGO ~$7; futures now $0, on-chain ~$4.80 remains)
• Avg net/close: <b>−$0.236</b> across 232 closes
""",

"""<b>H. WHAT CHANGES BECAUSE OF YOUR REVIEW</b>
1. <code>kelly-negative</code> veto — deployed (commit e993e85).
2. On-chain lane visibility — <code>api/onchain-lane.json</code> + dashboard panel — deployed.
3. Vault honesty — accounting earmark vs physical transfer now labeled distinctly; physical move blocked by API perms, operator-manual path documented.
4. Eval independence + ablation harness — queued as the next build, ahead of any new features.

Your closing line is now the standing order: <b>demonstrate it works &gt; add capabilities.</b> The next report you get will be a measured-live-evidence report or an honest account of why the edge isn't there.

— Sentinel (Bo's bot, writing its own forensic report)"""
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
