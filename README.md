# Sentinel Tactical Radar — GitHub Pages mirror

Live: **https://wh0d4r35w1n5.github.io/sentinel-tactical-radar/**

- `/` — landing dashboard: pulse chart, breadth stats, ticker tape, ranked
  signals with sparklines, signal track record (vanilla JS, no build).
- `/radar/` — the mirrored full terminal.

Static mirror of the Sentinel Tactical Radar Next.js build, served by GitHub
Pages with a self-contained data layer (no Netlify dependency for market data).

## How it works

- The app shell is a mirrored Next.js static export under `_next/` with asset
  paths rewritten to this repo's base path (`/sentinel-tactical-radar/`).
- `.nojekyll` keeps GitHub Pages serving the `_next/` directory.
- The frontend's `/api/*` calls were patched to `api/*.json` static snapshots.

## Data pipeline (`.github/workflows/refresh-api.yml`)

Runs every 10 minutes + on demand:

| File | Source |
|---|---|
| `api/market-scanner.json` | **Built natively** by `scripts/build-scanner.mjs` from Bitget public spot data (symbols + all tickers + 1h klines for top pairs). Universe = online USDT pairs, excluding the RWA tokenized-stock zone (`areaSymbol`) and fiat/stable bases, ≥ $250k 24h volume. Signals score momentum (RSI-14, 24h change), volume surge, and spread tightness. |
| `api/market-snapshot.json` | **Built natively** by `scripts/build-snapshot.mjs`: live Jupiter quotes (`lite-api.jup.ag`), Solana RPC slot, Bitget SOLUSDT stats. |
| `api/pulse-history.json` | Rolling breadth index (~24h of points) accumulated each run. |
| `api/coin-detail.json` | Per-coin metrics + 48h sparkline closes for kline-enriched pairs. |
| `api/signal-ledger.json` | Signal track record — open entries marked live, settled as won/stopped/expired with P&L. |
| `api/bitget-symbols.json` | The Bitget-listed coin universe used for filtering. |
| `api/funding.json` | Bitget USDT-FUTURES funding rates → delta-neutral arb math (direction, breakeven hours, annualized carry). |
| `api/sentiment.json` | Derivatives + social intelligence: per-asset open interest, funding trend, crowding state (Bitget public futures, keyless). CoinGlass liquidations/long-short and LunarCrush galaxy/sentiment join when keys exist — see below. |
| `api/{config,hud-status,trades,bot-state,recovered-notes}.json` | Pulled from the upstream Netlify backend; last-good kept on failure. |

### Optional intelligence feeds (keys → richer signals)

The scanner auto-activates two key-gated feeds; without keys they honestly
report `no-key` and are skipped:

| Feed | Key source | Adds |
|---|---|---|
| CoinGlass | `COINGLASS_API_KEY` env or `scripts/api-keys.json` `{"coinglass":"..."}` (open-api-v4, free hobbyist tier) | 24h liquidations, global long/short account ratio |
| LunarCrush | `LUNARCRUSH_API_KEY` env or `scripts/api-keys.json` `{"lunarcrush":"..."}` (api4 Bearer) | Galaxy Score, AltRank, sentiment, social volume per asset |

`scripts/api-keys.json` is gitignored. For CI, add both as GitHub repo
secrets named identically — the workflow passes env through.

In-browser, Jupiter quote/swap requests go straight to `lite-api.jup.ag`
(CORS-enabled). POST mutations (save config, toggle bot, record trade) are
server-only features and intentionally fail on static hosting.
