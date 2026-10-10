#!/usr/bin/env python3
"""Send the Sentinel change report to Will Evans (chat 6648799778).

Uses a /tmp copy of the Telethon session so the live sentinel-tg-watch
service's sqlite session is never contended. HTML parse mode.
"""
import asyncio, json, os, shutil, sys
from telethon import TelegramClient
from telethon.errors import FloodWaitError

CFG = json.load(open("/opt/sentinel/scripts/tg-config.json"))
SESS_COPY = os.path.expanduser("~/tg-send-will.session")
shutil.copy("/opt/sentinel/scripts/tg-session.session", SESS_COPY)

MSGS = [
"""<b>🛰 SENTINEL — FULL CHANGE REPORT</b>
since last feedback · 7 commits on <code>feat/bybit-adapter</code> · all deployed + live-verified on the VPS
━━━━━━━━━━━━━━━━━━━

<b>1. ON-CHAIN LANE — "Onchain coins" mandate</b>
• <b>Discovery</b>: ~200 DEX pairs scanned per cycle across Solana/Base/BSC — keyword search plus DexScreener trending feeds (pump.fun grads, marketed memes). Scored on real 24h volume, liquidity, mcap, txn velocity, buy pressure. Wash-trade patterns, &lt;2h pairs, dead books filtered; deduped by contract address.
• <b>Rugcheck.xyz audit</b> on every top Solana candidate — honeypots/ruggeds flagged before exec ever sees them.
• <b>Perp bridge</b>: hot tokens with a Bitget perp seed the exec's slot pool — leverage + exchange stops, zero new creds.
• <b>Self-custody Solana lane</b>: bot wallet <code>kpevjJ1i…</code> + Jupiter swaps — the same liquidity the Onchain tab routes through, no API key.
• Sizing 25%/position, $25 cap, max 2 positions — a bounded purse by design. Trail keeps 72% of peak, 36h age-out. Every fill + tx sig journaled (solscan-verifiable).
• <b>SOL bootstrap</b>: landed SOL auto-converts to USDC keeping a 0.025 gas reserve.
• <b>Jupiter Ultra gasless rail</b>: relayer fronts fees in-token — the wallet can bootstrap from zero SOL (verified live).
• Micro-purse floors via env — ~$1 clips possible.
• Bitget Wallet OpenAPI adapter fully built — dormant until BGW_* creds exist.

<b>2. THE FUNDING WALL — investigated to exhaustion</b>
• The API key is <b>futures-trade-only</b>: 40014 on spot/funding reads, transfers, withdrawals. Withdrawals need your 2FA — by design. No code path around it.
• Every withdrawal floor ≈ $10 (USDT $10, SOL 0.0911 ≈ $9.98, USDC ~$10). The ~$5 free clears none.
• <b>Escape route found</b>: USDGO ($1 stable) withdraws at ~$1 min on Solana network, has a USDGO/USDT spot pair, routes on Jupiter. 3 manual taps → ~$4.20 purse → the machine takes over.""",

"""<b>3. BTC-PAIR CONFLUENCE — standing rule, now code</b>
• Real XBTC spot candles where the pair exists (SOLBTC, ETHBTC…) — synthetic XUSDT/BTCUSDT ratio everywhere else. Nothing ever dropped for lacking a pair.
• Metrics: <code>rs24</code> (24h outperformance vs BTC), <code>rsRsi</code> (RSI of the ratio), <code>rsBreak</code> (ratio pressing its own extreme).
• Bounded ±4 tilt: LONGs up on USDT <i>and</i> BTC earn it; up on USDT but down on BTC is pure beta and pays for it.
• Live-verified: SOL rs24 −0.61%, ETH −0.10%, ZEC +0.21% — all 20 board signals carry btcPair context.

<b>4. SIGNAL FUSION — the 4-step desk combiner</b>
• <b>Serial demeaning</b>: each score component minus its rolling EMA (~30-cycle halflife). Structural drift stops dominating — only the surprise carries signal.
• <b>Cross-sectional z</b>: every component z-scored across the board each cycle (±4 clamp). Ranks over raw units.
• <b>Residual weighting</b>: Bayesian ridge of the z-map onto realized alpha24h from sealed evals, λ=30 shrunk to hand priors. Each component earns only its <i>marginal</i> lift — the mom/vol/surg triple-count dies here.
• <b>Empirical Kelly</b>: f* = p − q/b per strategy on realized R — deployed at half-Kelly, scales sizing 0.3–1×, never above caps.
• <b>Evidence-gated</b>: blend = n/(n+300) capped 0.7 — hand score remains the floor until ≥40 fusion-tagged evals seal (~24–48h). Synthetic test recovered true weights at R²=0.98.""",

"""<b>5. REGIME-CONDITIONAL STRATEGY WEIGHTING</b>
• The qwinsi post's full prompt was OCR'd from its image and audited — most of it already existed here in harder form (regime taxonomy, confidence gates, kill-switch, calibration). The real gap: strategy ratings were global.
• <code>byStrategyMkt</code> cross-tab: alpha split by strategy × tape type (e.g. Breakout Continuation|bull-volatile).
• <code>stratRegBoost</code>: a strategy's rating in the current regime overrides its global rating once the cell has ≥15 sealed outcomes.
• <code>stratRegBlock</code>: measured-negative in this tape → blocked for this regime only. Journaled in evalGate.

<b>6. STANFORD MSE448 PAPER — extracted from the post's image</b>
• Actual paper: <i>"High Frequency Trading Strategies"</i> — Sasson/Ho/Samson, Stanford MS&E. Its real result: Avellaneda-Stoikov inventory control produces near-equal PnL at <b>half the inventory variance</b> (std 2.99 vs 8.49).
• <b>Microprice factor</b>: top-5 order book fetched per candidate → <code>microPos</code> (micro-vs-mid in half-spread units, scale-free) + 5-level queue imbalance. Bounded ±3.5 tilt — the paper itself graded it weak alone, so small prior; the ridge re-weights it from evidence.
• <b>AS inventory skew</b>: <code>invMul = exp(−2.2·q_eff)</code> on signal sizing — same-side deployed margin/equity, correlated names count 1.5×, floor 0.15. The binary corr-veto now shrinks continuously before it rejects. Journaled per order as invSkew.
• Live: all 20 signals carry book data — ZEC 84% bid-heavy, BTC ask-pressed.

<b>STATE RIGHT NOW</b>
Futures book live, all protections intact · fusion learner accumulating eval seals (weights fit in days) · inventory skew armed (0 bites yet) · onchain lane armed — wallet $0.00, waits on the USDGO send only you can do (your 2FA).

— Sentinel"""
]

async def main():
    cl = TelegramClient(SESS_COPY[:-8], CFG["api_id"], CFG["api_hash"])
    await cl.connect()
    if not await cl.is_user_authorized():
        sys.exit("session copy not authorized")
    ent = await cl.get_entity(6648799778)
    name = " ".join(filter(None, [getattr(ent, "first_name", None), getattr(ent, "last_name", None)]))
    print(f"target: {name} @{getattr(ent, 'username', '?')} (id {ent.id})")
    for i, m in enumerate(MSGS, 1):
        try:
            r = await cl.send_message(ent, m, parse_mode="html", link_preview=False)
        except FloodWaitError as e:
            await asyncio.sleep(min(e.seconds + 1, 60))
            r = await cl.send_message(ent, m, parse_mode="html", link_preview=False)
        print(f"msg {i}/{len(MSGS)}: id {r.id} · {len(m)} chars")
        await asyncio.sleep(1)
    await cl.disconnect()

asyncio.run(main())
