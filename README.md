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

## The paper book

The journal models a **10×-isolated USDT-M perpetual paper account**
(real Bitget mechanics, simulated fills — no orders ever leave the browser/CI):

- Risk-based sizing: `notional = equity × 1% ÷ stop distance`, conviction-scaled,
  capped at 30% notional per position and 400% total deployed notional.
- **Dynamic leverage** (3–20×, capped by contract `maxLever`): scales with the
  *measured* tape regime — a run is tagged risk-on/risk-off/mixed from universe
  breadth + median change; direction-aligned trades earn 15× (20× at grade A),
  mixed tapes get 10×, counter-trend trades drop to 5×. Hard bound: the
  liquidation band must hold the designed stop (lev ≤ 80/(stopPct+0.64)) —
  tight stops earn leverage, wide stops don't. Leverage changes margin
  efficiency and liquidation distance, not expected P&L per unit risk.
- **Portfolio heat cap** — total equity at risk across all live stops is
  regime-scaled too: 6% aligned, 4% mixed, 2.5% counter-trend. Positions
  whose stops have ratcheted to profit contribute zero heat.
- **Correlation governor** — heat is also capped per asset cluster
  (crypto majors / crypto alts / each RWA class) at 2.5% of equity, because
  BTC+ETH+SOL+alt longs are the same bet during a shock, not independent
  risks.
- **No-trade floor** — positions only open at score ≥70 (BBB). Weaker
  signals still emit, archive and get forward-graded, but standing down is
  a legitimate output; an empty board reads "NO EDGE — STAND DOWN".
- Perp taker fees (0.12% round trip), funding carry on the open fraction,
  and an isolated liquidation band (~`100/lev − 0.8`% adverse) that outranks
  target and stop.
- Take-profit ladder: 33%/33%/34% banks at 40%/70%/100% of target.
- Dynamic stop: designed invalidation → breakeven at 40% of target →
  +40%/+65% locks → trailing only past full target.
- Intraperiod settlement: each build **replays the 5-minute candle tape
  since entry** (unclosed candles excluded) so wick-level target/stop/
  liquidation touches between 10-minute snapshots still count; ambiguous
  same-candle touches resolve pessimistically, adverse first.
- Exits record fill-level prices (target, stop, liquidation), and each
  settle logs `alphaPct` — P&L minus signed universe drift — so the ledger
  measures edge, not just beta.

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
| `api/vault.json` | VaultKit paper vault — 20% of realized gains swept into a BTC/ETH/SOL hold basket. Kept **separately identifiable** from trading performance (a rising BTC/ETH/SOL market can't fake strategy edge), and deducted from trading equity so the wallet's **System total = trading acct + vault** never double-counts sweeps. |
| `api/news.json` | Intelligence wire — public RSS headlines (CoinDesk/Cointelegraph) tagged to universe assets with a keyword tone estimate. Context only — deliberately never a score input. |
| `api/correlation.json` | Measured market structure — 48h pairwise correlation of 1h returns across candidates, BTC/ETH beta per asset, board coupling mean. The risk governor treats realized corr ≥0.6 as "the same bet" (static asset-class clusters are the fallback when klines are missing). |
| `api/hypotheses.json` | Hypothesis engine — registered falsifiable claims (score IC, grade ordering, direction asymmetry, regime alignment, factor edges, entry-floor validity) scored prospectively from eval labels. Status escalates strictly with n: UNTESTED→EARLY→SUGGESTIVE→SUPPORTED/REFUTED. |

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

All trading is paper/dry-run: nothing routes orders, posts mutations, or
touches a real account.
