# Sentinel Tactical Radar — GitHub Pages mirror

Live: **https://wh0d4r35w1n5.github.io/sentinel-tactical-radar/**

- `/` — landing dashboard: pulse chart, breadth stats, ticker tape, ranked
  signals with sparklines, transparent trade journal with Before/After
  charts (vanilla JS, no build).
- `/radar/` — the mirrored full terminal.

Vanilla-JS static app served by GitHub Pages with a self-contained data
layer — `live-feed.js` shims `/api/*` calls to static `api/*.json` snapshots
and a live Bitget futures websocket overlay.

## How it works

- Everything runs client-side; the only backend is the refresh workflow that
  regenerates `api/*.json` every ~10 minutes.
- `.nojekyll` keeps GitHub Pages serving all assets.
- `live-feed.js` subscribes `wss://ws.bitget.com/v2/ws/public`
  (`USDT-FUTURES` tickers) for tick-level repaints between snapshots.

## The live book

The VPS executor (`scripts/bitget-exec.mjs` under `sentinel-rapid`) trades the
**real Bitget USDT-M account** — the exchange's own fills and plan records are
the only trade journal (`api/live-ledger.json` + `state/real-fills.json`):

- **Margin-based sizing** — free margin is split across the target slot count
  (4 target / 10 max positions); there is no notional cap.
- **Max leverage bounded by the liquidation band** — the contract's `maxLever`
  is used, but hard-capped so the designed stop sits inside the band
  (`lev ≤ 80/(stopPct + 0.64)`): tight stops earn leverage, wide stops don't.
- **Exactly one TP + one SL per position**, full size, exchange-side
  (`pos_profit`/`pos_loss` plans) — protection survives a bot or network
  outage. No trailing stops, no TP ladders.
- **Risk rails** — real-equity drawdown kill at 8%, rolling-24h loss halt at
  6%, per-position protection repair, and margin rebalancing toward equal
  slots. All published in `live-ledger.json` under `risk`.
- **No-trade floor** — positions only open at score ≥70 (BBB). Weaker
  signals still emit, archive and get forward-graded, but standing down is
  a legitimate output; an empty board reads "NO EDGE — STAND DOWN".
- **Correlation governor** — cluster-level heat caps treat BTC+ETH+SOL+alt
  longs as the same bet during a shock, not independent risks.
- The retired simulation model (taker fees, funding carry, liquidation
  band, intraperiod settlement replay) still exists in `signal-eval`
  forward-grading — it grades *predictions*, it does not book fake fills.

### Sentinel v1.0 — versioning, learning gate, honest stats

- **Frozen ruleset.** Signals, entries and stats carry an engine version
  (`v1.1` — regime-scaled leverage + cluster governor + entry floor;
  `v1.0` was static-10x; pre-versioning entries show `v0.x`). Rule changes bump the
  version so results are only ever compared within a ruleset — no blending
  of different engines' track records, and legacy bot records stay separate
  experiments entirely.
- **Self-learning gate.** The strategy-weight adapter (`stratAdj`) is
  dormant until ≥100 closed signals overall and ≥20 per strategy —
  small-sample "learning" is curve-fitting to noise. The dashboard shows
  gate status; weights sit at 0 until the sample justifies them.
- **Two records, strictly separated.** `signal-archive.json` +
  `api/history/archive-YYYY-MM.json` are the immutable prospective record —
  every emitted board, traded or not. `signal-ledger.json` is the mutable
  position book where P&L is measured. The ledger reports
  `stats.signalsArchived`/`archiveRuns` so the record's depth is visible.
- **Full stats.** Win rate, profit factor, max drawdown, avg winner/loser,
  per-trade Sharpe/SQN/R, by-direction/strategy/grade/version breakdowns,
  and alpha vs market — all net of modeled fees and funding, computed from
  settled records only, and null where the sample can't support the number.

## Data pipeline (`.github/workflows/refresh-api.yml`)

Runs every 10 minutes + on demand:

| File | Source |
|---|---|
| `api/market-scanner.json` | **Built natively** by `scripts/build-scanner.mjs` from Bitget public futures data (USDT-M contracts + tickers + closed 1h/5m klines for top candidates). Universe = every tradable USDT-M perpetual — crypto plus RWA stock/index/metal/FX perps — excluding fiat-stable bases, ≥ $250k 24h volume. Signals score direction-aware momentum (Wilder RSI-14, signed 24h change ranked within the candidate pool), volume surge, spread tightness, and bounded TA/derivatives/news confluence. |
| `api/pulse-history.json` | Rolling breadth index (~24h of points) accumulated each run. |
| `api/coin-detail.json` | Per-coin metrics + 48h sparkline closes for kline-enriched pairs. |
| `api/signal-ledger.json` | Signal track record — open entries marked live, settled as won/stopped/breakeven/trailed/reversed/expired/liquidated with P&L and alpha. Entries carry engine version, board rank, spread, slippage estimate, universe size and pool depth at signal time. |
| `api/signal-archive.json` | **Append-only prospective record** — every run appends the full emitted board (all signals, traded or not) with parameters and universe context. |
| `api/history/archive-YYYY-MM.json` | **Permanent record** — every emitted run is also written to its monthly archive file. The hot `signal-archive.json` may trim old runs; these monthly files are the unbounded, never-rewritten evidence set. |
| `api/signal-eval.json` + `api/history/eval-YYYY-MM.json` | **Forward-outcome labels for every emitted signal** — +1h/+4h/+24h direction-adjusted returns, TP-before-SL inside 24h (5m replay, adverse-first), and alpha vs a BTC/ETH/SOL median over the identical window. Complete records seal into monthly eval files. This measures predictive power on the *whole board*, ~10× faster than the traded ledger. |
| `api/bitget-symbols.json` | The Bitget-listed contract universe used for filtering. |
| `api/funding.json` | Bitget USDT-FUTURES funding rates → delta-neutral arb math (direction, breakeven hours, annualized carry). |
| `api/sentiment.json` | Derivatives + social intelligence: per-asset open interest, funding trend, crowding state (Bitget public futures, keyless). CoinGlass liquidations/long-short and LunarCrush galaxy/sentiment join when keys exist — see below. |
| `api/prices.json` | Majors (BTC/ETH/SOL) marks for the header chips. |
| `api/health.json` | Pipeline health: last build timestamp, pair count, kline coverage. |

| `api/news.json` | Intelligence wire — public RSS headlines (CoinDesk/Cointelegraph) tagged to universe assets with a keyword tone estimate. Context only — deliberately never a score input. |
| `api/correlation.json` | Measured market structure — 48h pairwise correlation of 1h returns across candidates, BTC/ETH beta per asset, board coupling mean. The risk governor treats realized corr ≥0.6 as "the same bet" (static asset-class clusters are the fallback when klines are missing). |
| `api/hypotheses.json` | Hypothesis engine — registered falsifiable claims (score IC, grade ordering, direction asymmetry, regime alignment, factor edges, entry-floor validity) scored prospectively from eval labels. Status escalates strictly with n: UNTESTED→EARLY→SUGGESTIVE→SUPPORTED/REFUTED. |
| `api/benchmark.json` | **Boring-benchmark comparison** — BTC buy & hold, an equal-weight BTC/ETH/SOL basket, and a mechanical "top-3 board score held 1h" baseline chained from the same eval labels, all on the same clock as the ledger. The honest question: does the intelligence add value beyond doing something trivial? |
| `PITCH.md` | The short downloadable pitch — "Don't trust the signal. Verify it." |

The dashboard also carries an **Evidence / Validation panel** — prospective
results for the *current frozen ruleset only* (v0.x excluded): signals
observed, closed trades, +1h/+4h/+24h directional accuracy, TP-before-SL,
median alpha vs the market basket, and per-version PF/SQN — with an explicit
evidence status (`INSUFFICIENT SAMPLE` below 30 closed trades, so the system
can't claim an edge the data hasn't earned).

### Optional intelligence feeds (keys → richer signals)

The scanner auto-activates key-gated feeds; without keys they honestly
report `no-key` and are skipped:

| Feed | Key source | Adds |
|---|---|---|
| CoinGlass | `COINGLASS_API_KEY` env or `scripts/api-keys.json` `{"coinglass":"..."}` (open-api-v4, free hobbyist tier) | 24h liquidations, global long/short account ratio |
| LunarCrush | `LUNARCRUSH_API_KEY` env or `scripts/api-keys.json` `{"lunarcrush":"..."}` (api4 Bearer) | Galaxy Score, AltRank, sentiment, social volume per asset |
| CryptoPanic | `CRYPTOPANIC_API_KEY` env or `scripts/api-keys.json` `{"cryptopanic":"..."}` — optional `cryptopanicPlan` (default `growth`) | Bullshit-filtered news context: vote-weighted sentiment per asset, hype-word spam discounted to ~zero, FUD clusters penalize longs. News is context, never a trigger — hard-capped at ±2 score. |
| CoinGecko | **keyless** — always live | Market-cap quality: rank, float-unlocked % (dilution risk), ATH distance, vol/mcap turnover |
| CoinMarketCap | `CMC_API_KEY` env or `scripts/api-keys.json` `{"cmc":"..."}` (Basic tier free) | CMC rank + 24h volume change — cross-verification overlay on CoinGecko |
| CoinMarketCal | `COINMARKETCAL_CLIENT_ID` + `COINMARKETCAL_CLIENT_SECRET` env or `api-keys.json` `coinmarketcalId`/`coinmarketcalSecret` | Scheduled events ≤7d: token **unlocks flagged as supply-dump risk** (longs penalized −3), listings/upgrades as catalysts — flags, never triggers |

`scripts/api-keys.json` is gitignored. For CI, add them as GitHub repo
secrets named identically — the workflow passes env through.

Live execution runs on the VPS (`SENTINEL_EXEC=live`, `CONFIRM_LIVE=YES`)
with the exchange's isolated-margin TP/SL plans attached to every position —
orders route to the real Bitget account; nothing simulated is booked or
displayed.
