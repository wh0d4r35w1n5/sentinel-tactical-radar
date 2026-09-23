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
| `api/{config,hud-status,trades,bot-state,recovered-notes}.json` | Pulled from the upstream Netlify backend; last-good kept on failure. |

In-browser, Jupiter quote/swap requests go straight to `lite-api.jup.ag`
(CORS-enabled). POST mutations (save config, toggle bot, record trade) are
server-only features and intentionally fail on static hosting.
