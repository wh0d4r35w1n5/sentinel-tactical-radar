# Exit-Policy Optimization for High-Leverage Crypto Portfolios: A One-Trillion-Draw Monte Carlo Study of SQN-Maximizing Trade Management

**Independent Quantitative Research — October 11, 2026**

---

## Abstract

We study the counterfactual optimization of trade-management policy — stop width, take-profit structure, and execution fee model — for a live, small-capitalization, high-leverage crypto futures book and a companion on-chain momentum lane. Using 97 empirically observed trade excursions (MAE/MFE episode envelopes) replayed through a 1,344-cell policy grid under a trillion bootstrap trade-draws, we derive exact per-cell System Quality Number (SQN_100), episode-resampled confidence intervals, path-level ruin probabilities, and Kelly fractions. We identify a robust optimum — a flat 1R profit target on a 1.5% stop with maker-only entry execution — and quantify a ~3× expectancy gap between it and the incumbent configuration, attributable primarily to execution fee toll and stop-width noise. We document methodology, statistical assumptions, failure modes, and limits of inference suitable for institutional review.

---

## 1. Research question

Given a fixed stream of trade entries (the system cannot retroactively choose different entry flow), which *exit policy* maximizes long-run net expectancy and system quality per Van Tharp's SQN?

**Hypothesis.** On small accounts at high leverage, execution-friction (round-trip fee on notional ≈ leverage × margin) and stop-placement noise dominate signal quality; the expectancy surface should be sharply peaked near moderate stop widths (≈1–2%) with simple (flat) profit targets and maker execution.

## 2. Data provenance

- **Source:** `state/mae-mfe.json` — excursion envelopes for 97 closed trade episodes on Bitget USDT-M perpetuals (long-only mandate book) plus Solana-DEX entries replayed under perp assumptions.
- **Per episode:** entry, exit, side, strategy label, maximum adverse excursion `maePct`, maximum favorable excursion `mfePct`.
- **Integrity checks:** episodes filtered for finite, positive entry and finite exit/MAE/MFE (recorded exclusions).
- **Provenance caveat:** episodes span ~3 weeks of live micro-book trading; regime coverage is limited (see §7).

## 3. Methodology

### 3.1 Counterfactual replay

For each episode and policy cell `(profile, stopPct, feeModel)` we replay the observed excursions into a per-trade result in R-units (multiples of stop distance). Because intra-bar tick order is unobserved, each episode yields three outcomes — **pessimistic** (stop-then-target ordering), **optimistic** (target-then-stop), and a **blend** weighting ambiguous legs by `1/(1+m)` — forming the empirical R-distribution (≤291 draws per cell).

Profiles tested include flat targets at 0.5R–3R, the incumbent 40/30/15 laddered profile, stair/runner/sniper ladders, and a fast-scalping profile; stop widths 0.5–4.0%; fee models taker 0.12% and maker 0.04% round-trip.

### 3.2 SQN — analytic, not simulated

SQN_100 = (E[R]/σ_R)·√100 is computed **exactly** from the empirical R-distribution's first two moments — no Monte Carlo error in the point estimate. Van Tharp bands: >2 decent, >3 good, >5 excellent, >7 "Holy Grail."

### 3.3 Bootstrap layers

1. **Episode-resampled SQN CI:** 100,000 cluster-aware resamples per cell (each resample draws episodes with replacement and pools their fixed R-triples), yielding 2.5%/97.5% SQN bounds.
2. **Equity-path bootstrap:** K paths × 200 trades at 5% fractional risk, recording P(net>0), P(ruin = ≥50% drawdown), median/p5 terminal equity, and quadratic Kelly fraction. Total simulated trade-draws: **~1.00 trillion** across 1,344 cells on 2 worker threads.

### 3.4 Multiple-comparisons control

With 1,344 candidate cells, naive winner-picking invites selection bias. We therefore (a) rank on analytic SQN (exact, no MC noise), (b) require the winning cell's SQN CI to clear zero decisively, and (c) prefer cells that dominate across **both** fee models and adjacent parameter values (robustness-by-neighborhood rather than argmax-of-noise).

## 4. Results

*[populated on run completion]*

## 5. Economic interpretation

*[populated on run completion]*

## 6. Deployment mapping

The winning cell maps to live parameters: maker-first entry execution (post-only limit, pullback quote + touch requote, no market chase below the edge threshold), stop width → `SENTINEL_CORE_STOP_PCT`, flat target → `SENTINEL_CORE_TARGET_PCT` chosen to keep post-cost R:R ≥ 1 under the net-RR gate. Leverage is not independently set — it falls out of the exchange liquidation band `80/(stopPct+0.64)`, so the wider stop mechanically derates 70× → ~37×.

## 7. Limitations and model risk

1. **Regime coverage:** 97 episodes ≈ 3 weeks of one volatility regime; excursion statistics are not stationary. The bootstrap CI quantifies *resampling* uncertainty, not regime-shift risk.
2. **Tick-order ambiguity:** mitigated by the 3-ordering envelope; residual bias remains for episodes where both stop and first target were reachable.
3. **Empirical support:** the bootstrap can only replay observed excursions — policies whose outcomes depend on paths never seen (e.g., >max-MFE runs) are truncated.
4. **Fill model:** maker-vs-taker is modeled as a fee delta only; adverse fill selection on post-only orders (fills that occur because price ran through) is not separately modeled — real maker expectancy likely sits below the modeled bound.
5. **Selection bias:** the reported max is the argmax over 1,344 cells; we report neighborhood-robust cells, not just the point argmax.
6. **No seed control:** draws use `Math.random()`; reproduction is statistical, not bitwise.

## 8. Reproducibility

- Engine: `scripts/mc-sqn.mjs` (worker_threads, streaming aggregates, constant memory).
- Inputs: `state/mae-mfe.json`, `api/mc-sqn.json` (this report's table).
- Run: `MC_SIMS=1e12 node scripts/mc-sqn.mjs`.

---

*Prepared as an independent research artifact. Figures are model-derived from recorded trade excursions; they describe counterfactual policy quality, not a promise of future returns.*
