#!/usr/bin/env python3
"""Send the implementation response to Will Evans's audit-program review.
Session-copy pattern — never contends the live watcher's sqlite session.
"""
import asyncio, json, os, shutil
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS_COPY = os.path.expanduser("~/tg-send-evidence.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS_COPY)

MSGS = [
"""<b>🧪 SENTINEL — AUDIT PROGRAM IMPLEMENTED, NOT PROMISED</b>
Your structured review (M1–M6, Q1–Q5): every item is now built, deployed, and running inside the rapid cycle every pass. Dashboard carries a new EVIDENCE panel — public, negative findings included. Commits b562fe8 + c6ed14a on feat/bybit-adapter.
━━━━━━━━━━━━━━━━━━━
<b>M1/Q3 — EVERY DOLLAR, RECONCILED</b>
Independent reconciler (own signer, zero shared code with the trading stack):
• Transfers: $2,738.66 in / $3,076.44 out of futures (net −$337.79 to spot side)
• Exchange raw fills: realized <b>−$110.14</b> on <b>$221.08 fees</b> — $2 of fees per $1 lost. The journal's −$54.80 net reconciles exactly (−$30.95 gross − $23.85 fees).
• Futures account: $0.00 — actually empty, not a guess. On-chain purse: $2.51.
• Declared blind spot: spot/funding balances are API-perm blocked (40014) — shown as BLIND on the dashboard, not silently reported as zero.""",

"""<b>M4/Q2 — THE INDEPENDENCE FIX, AND WHAT IT DID TO YOUR A-GRADE QUESTION</b>
24,579 evals → <b>493 independent episodes</b>. 98% overlap — your point confirmed quantitatively.
The A-grade inversion I reported earlier <b>did not survive clustering</b>: on independent episodes A = <b>+1.50%</b> (only positive grade, wide CI −1.47…+4.47), BB = −1.05% (CI excludes zero — significantly negative), B = −1.52%. The inversion was an overlap artifact. The honest residual: A is positive but the CI still crosses zero — thin, not proven.""",

"""<b>M3 — THE THREE-WAY SHADOW RACE, ON IDENTICAL TAPE, FEES INCLUDED</b>
V0 original: $98.35 (−1.65%, DD 3.5%) · V1 current: $99.25 (−0.75%) · <b>V2 evidence-only: $100.88 (+0.88%, DD 2.4%, 22 trades)</b> · passive market benchmark: <b>$101.79 (+1.79%)</b>
Read it the way you will: the gradient is real (evidence &gt; current &gt; original) but <b>a passive long still beats every variant</b>. On the dashboard, not buried.
<b>Q1 — EDGE ATTRIBUTION</b>: PA Quartile is the only CI-positive strategy (+1.88%, CI +0.45→+3.30). Key Level SFP (−1.46%, CI excludes zero) and Liquidity Sweep (−0.84%) are your two biggest producers and both significantly negative. Confluence forensics: Sakata +0.46 lift; effort/result −1.35, candles −1.11, Wyckoff −0.79, VWAP −0.78 — most of the "evidence" chips are anti-predictive. RSI IC −0.20 (inverted).""",

"""<b>M6/Q5 — CODIFIED LIFECYCLE, WIRED INTO THE ORDER GATE</b>
state/strategy-policy.json now decides who may trade: LIVE needs ≥30 independent episodes + CI lower &gt; 0 + positive net-after-cost. HALT at ≥25 eps with CI upper &lt; 0. ABANDON when halted with n≥60 — remove the model, not the parameters.
Current board: <b>1 live (PA Quartile), 13 probation, 2 abandoned.</b> Everything else still emits signals for evaluation — it just can't touch money. Veto shows in rejects as <code>strat-blocked</code>; operator/setup/mandate orders exempt. The kelly-negative veto stands beside it.
<b>Q4 — FAILOVER AUDIT</b>: 6/7 — and the audit caught a real one: sentinel-liq-guard was a zombie (active to systemd, artifact 16h stale). Restarted, now heart-beating. Freshness is checked per-artifact timestamp, never just systemd state.
<b>Independent validator</b>: read-only recompute of every headline number. journalNet matches to the cent. Two real drifts left flagged, unswept: labeledEvals (26,544 reported vs 24,579 recomputed — a reporter counting bug) and a dirAcc24h unit mismatch.""",

"""<b>WHAT THIS MEANS OPERATIONALLY</b>
Feature freeze is now enforced by policy, not promise — the only thing allowed to place autonomous orders is PA Quartile, on 38 episodes of demonstrated post-cost edge. Everything else is a candidate, not a strategy.
Your test for this stays the standing order: the next report is <b>out-of-sample evidence on the one live strategy</b>, or its demotion when the episodes say so. The validator runs every cycle — if the numbers drift from what the system reports, the dashboard says DRIFT, not green.
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
