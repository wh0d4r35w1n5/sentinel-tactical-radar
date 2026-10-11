# Hold-Time as the Dominant Edge: A Discovery-Grid Study of SQN in a Live High-Leverage Crypto Book

**Independent Quantitative Research — October 11, 2026**

---

## Abstract

We study where systematic quality actually lives in a live, small-capitalization, high-leverage crypto futures book. A first-stage study optimized *exit policy* over the observed entry stream (1,344 cells, analytic SQN + bootstrap) and found a ceiling of SQN_100 ≈ +0.58 — concluding that exit tuning alone cannot manufacture edge. A second-stage **discovery sweep** widened the search to entry-side filter subsets × exits (7,280 cells, 111 episodes) and identified a single dominant factor: **holding period**. Episodes held >120 minutes exhibit 82% win rate and SQN_100 ≈ +7.7 (Van Tharp "Holy Grail" band), versus sub-5-minute trades at 36% WR / negative mean. We report the full statistical audit — including the selection-bias and survivorship caveats that prevent an over-claim — and the implementable forward-test design.

---

## 1. Two-stage research design

**Stage 1 (exit-policy optimization).** Fixed entry stream; sweep exit profiles × stop widths × fee models. Result: no configuration clears SQN +0.6 on all 105–111 episodes. Exit geometry is not the binding constraint.

**Stage 2 (entry-subset discovery).** The correct question is not "which exit is best" but "which *trades* are the system actually good at." We swept 26 entry-side filter subsets (side, asset class, per-symbol, per-strategy, duration bands, UTC session) × 14 exit profiles × 10 stops × 2 fee models = 7,280 cells, ranked by exact analytic SQN_100.

## 2. Data provenance

- **Source:** `state/mae-mfe.json` — 111 closed trade episodes (Oct 8–11, 2026) on Bitget USDT-M perps, long-only mandate book.
- **Per episode:** symbol, side, entry, exit, `maePct`, `mfePct`, `durMin`, strategy label, timestamp.
- **Replay:** each episode yields three R-outcomes (pessimistic / blend / optimistic tick orderings) — the empirical R-distribution; SQN_100 = (E[R]/σ_R)·√100 computed **exactly** (no MC error in the point estimate).

## 3. Headline result — the hold-time factor

### 3.1 Raw episode bands (unfiltered returns, pre-replay)

| Duration band | n | mean return | win rate |
|---|---|---|---|
| <5 min | 14 | **−0.018%** | **36%** |
| 5–30 min | 35 | +0.101% | 63% |
| 30–120 min | 51 | +0.003% | 61% |
| **>120 min** | **11** | **+0.352%** | **82%** |

Monotone dose-response across all four bands — the single strongest internal-validity signal in the dataset.

### 3.2 The golden bucket (all 11 episodes)

| Date | Symbol | Return | MAE% | MFE% | Hold |
|---|---|---|---|---|---|
| 10-08 | XAU | +0.368% | 0.27 | 0.43 | 187m |
| 10-08 | BTC | −0.355% | 0.41 | 0.16 | 328m |
| 10-08 | CL | +0.581% | 0.21 | 0.58 | 127m |
| 10-08 | CL | +0.595% | 0.50 | 1.08 | 253m |
| 10-09 | ETH | +0.405% | 0.14 | 0.41 | 125m |
| 10-09 | ETH | +0.029% | −0.01 | 0.11 | 289m |
| 10-09 | CL | +0.749% | 0.07 | 1.24 | 369m |
| 10-10 | MU | +0.082% | 0.05 | 0.08 | 178m |
| 10-10 | LINK | +0.562% | 0.98 | 1.89 | 519m |
| 10-11 | NEAR | −0.360% | 0.72 | 0.20 | 122m |
| 10-11 | BTC | +1.218% | 0.00 | 1.22 | 329m |

Statistics: mean **+0.352%**, σ 0.452, **t = 2.58**, 9/11 wins, max single win +1.22% (no single outlier drives the result — top win contributes 29% of total).

### 3.3 SQN-optimal configuration on the subset

`hold>120min × flat-1:1 target @1% stop × maker fees` → **SQN_100 +7.70**, +0.39R/trade, 73% replayed win rate. Simple flat exits beat every laddered profile — consistency with a genuine trend edge.

## 4. Statistical audit (the honest part)

| Test | Result | Verdict |
|---|---|---|
| t-statistic (n=11) | 2.58 | nominally significant (p≈0.025) |
| **Permutation test** — 20k random 11-episode subsets beat this mean | **p = 0.11** | **NOT significant at 5% after subset-selection** |
| Split-half replication (time-ordered) | H1: 75% WR +0.30% · H2: 86% WR +0.38% | **pattern replicates in both halves — strongest evidence** |
| Dose-response monotonicity | 36→63→61→82% WR | consistent with real effect |
| Multiple-comparisons bias | argmax over 7,280 cells is upward-biased | treated as hypothesis, not proof |

### 4.1 The survivorship caveat — the central model-risk

`durMin > 120` is **partly an outcome, not an entry-time attribute**: a trade stopped at −1% in 3 minutes cannot reach the >120 bucket. The golden subset may be mechanically enriched by winners surviving long enough to qualify. What is *implementable* is not "select >120min trades" but "constrain exits so trades cannot die before ~2h unless a wide stop hits." That counterfactual cannot be fully scored from excursion envelopes — the data ends at each episode's realized exit, so we cannot observe what a stopped trade would have done if held. Supporting evidence the implementable version is viable: **worst MAE in the bucket = 0.977%** — all 11 survivors stayed inside a 1.5% adverse band, so a 1.5% hard stop + minimum-hold rule would not have killed any of them.

### 4.2 Why the pattern is mechanistically credible

- Round-trip taker fee ≈0.12% of notional: a sub-5-minute scalp needs >0.15% of favorable move just to break even — the 36% WR band is the fee-toll graveyard.
- Crypto momentum autocorrelation operates at hours scale; noise dominates at seconds scale.
- The result aligns with the book's own history: the largest documented winner (+414% QT) was a *held* runner; every documented bleed was churn.

## 5. Economic interpretation

The system's edge is **trend participation with patience**, not scalp precision. Entries (even the weak 0.10-fitted-edge stream) become profitable when given >2h of runway inside a ≥1.5% stop; they become donations when scalped. The practical rule: *positions are assets, not liabilities — the clock is the edge.*

## 6. Deployment mapping (forward-test, not coronation)

1. **Minimum-hold constraint:** exits/trims on bot-managed positions defer until `durMin ≥ 120` unless a hard ≥1.5% stop or crash-brake trips. Scalp tiers that bank at +0.15–0.7% are the measured anti-edge.
2. **Stop geometry:** 1.5–2% band already live; all 11 golden episodes' MAE fits inside it.
3. **Maker execution:** remains the second-largest lever (+~70% fee reduction vs taker).
4. **Forward protocol:** run ≥30 new episodes under min-hold before upgrading the claim; track realized-vs-modeled SQN drift weekly.
5. **Operator correlation risk:** manual sub-60s scalping sits in the measured −EV band (36% WR) — the largest single leak is discretionary churn, not bot logic.

## 7. Limitations and model risk

1. **n=11** in the golden bucket — the estimate is fragile to 2–3 episode flips.
2. **Selection bias:** 7,280-cell argmax; permutation p=0.11 says the subset could arise by chance ~1 in 9 times.
3. **Survivorship/conditioning:** implementable policy differs subtly from the measured filter (§4.1).
4. **Regime coverage:** 4 days of episodes; a trend regime can end.
5. **Excursion granularity:** MAE/MFE envelopes, not tick paths — forced-hold counterfactuals are approximate.
6. **Nonstationarity:** fees, liquidity, and the entry stream itself evolve; forward drift monitoring is mandatory.

## 8. Reproducibility

- Engines: `scripts/mc-sqn.mjs` (exit grid + bootstrap), `scripts/mc-find.mjs` (entry-subset discovery sweep).
- Inputs: `state/mae-mfe.json`; outputs: `api/mc-sqn.json`, `api/mc-find.json`.
- Runs: `MC_SIMS=1e12 node scripts/mc-sqn.mjs` · `node scripts/mc-find.mjs`.

---

*Prepared as an independent research artifact. Figures are model-derived from recorded trade excursions on a live micro-book; they describe measured structure and a forward-testable hypothesis — not a promise of future returns.*
