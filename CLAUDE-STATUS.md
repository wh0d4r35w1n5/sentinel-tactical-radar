# SENTINEL status — 2026-11-12 ~02:30 UTC (Claude cycle 1)

## Balance (wealth-live.json, 02:28Z)
- Total **≈ A$25.3** (US$16.48; FX ~0.65 assumed, no live FX feed in state). Target A$45.
- Bot 1 futures equity US$15.64: CXMTUSDT long UPL +$1.44, NBISUSDT long UPL +$0.43. Both have stop + TP ladder resting on the exchange (verified in the bitget-watch journal).
- Bot 2 Solana US$0.12: starved, sniper/GRAD armed, no fills possible at this size.

## What the record actually says (round-trip seats, 24h, open fees included)
- 27 seats, net **−US$0.92**, fees US$0.97 (more than the whole loss), WR 70%, avgWin +$0.097, avgLoss −$0.344.
- The governor had been reading −$0.45 off 122 *fills*. It counted rung partials as separate trades and left out open fees.
- E ≈ 0.7×0.097 − 0.3×0.344 = **−$0.035/seat**. At this WR, breaking even needs avgWin ≥ ~$0.147.

## Fixes deployed + verified this cycle
1. **Consumed-rung memory in the K2 ladder** (`scripts/bitget-watch.mjs`). This was the payoff leak.
   The ladder kept no state, so every dip under rung 1 re-armed it at the same price and sold another slice. NBIS sold 0.01 @151.84 ×3 and @152.8 ×3. Winners were being sold off at rung-1 prices.
   Now a seat-bound peak (max of polled mark and profitable close fills since cTime, stored in `state/k2-peak.json`) marks rungs at or below the peak as consumed. The remaining size is renormalised over the unconsumed rungs plus the moon. If every rung is consumed, the leftover legs are pruned and the moon rides the stop.
   Verified: CXMT now has 6 rungs (4–30%) at peak +2.45%, NBIS has 2 (4%, 6.5%) at peak +2.6%. No re-patch churn for 10+ min. Stop legs are intact.
   Backup: `scripts/bitget-watch.mjs.pre-rungmem`.
2. **Governor now scores round-trip seats** (`scripts/autoimprove.py` section 9). Seats are rebuilt from running size per symbol and open fees are counted. Thresholds are in seats: bleeding = net < −1 or (≥25 seats and net < 0). It publishes `trades24` / `maxTrades24` (L1 20, L2 12) with `basis: round-trip-seats`.
   Verified: trade-throttle.json shows 27 seats, net −0.919, L2 still armed (correctly). Backup: `.pre-seatgov`.
3. **Exec freqChoke uses the seat basis** when the governor publishes it (`scripts/bitget-exec.mjs` ~4008) and falls back to the old fill count otherwise. Verified in the ledger action: "27 seats/24h >= cap 12". Backup: `.pre-seatgov`.
- crc32 integrity: ok, 68 files, 0 corrupt.
- All three files synced live → clone `scripts/`. **Not committed.**

## Pending verification
- Per-seat avgWin on seats opened after 02:20Z, compared with the $0.097 baseline. This needs new closes.
- First CXMT/NBIS rung fill at ≥4% (proves the upper ladder is reachable and pays).
- Governor release: needs net24 > $0.5 with fewer than 20 seats for 4 rounds.

## Next work queue
- Small-peak lock (`desiredSl`, BW_GIVEBACK_SMALL 0.66 from +0.35% peak) probably clips winners at about +0.25%. Measure MFE on closed seats before touching it (out-of-sample rule).
- Entry fees are taker (0.06%). Post-only maker entries would cut ~a third of the per-seat deficit.
- Losers are full −R stops (ARIA −0.55, OPENAI −0.60, ETH −0.47, AMKR −0.39). Check whether their entry cells had SQN>1 evidence.
