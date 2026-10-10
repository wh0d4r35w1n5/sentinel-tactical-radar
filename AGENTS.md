# Sentinel — Operator Rules & Project Facts

## Operator manual-trading rules (the bagrunner code)

Written after the Oct 8 audit: 154 manual opens / 4 manual closes in a day,
−$20.35 net where **$15.31 was pure fees** — 5 of 7 symbols were
gross-positive and still printed red. These rules prevent the repeat.

**Mechanical enforcement (liq-guard, automatic):**
- Any held position whose last open fill came from the app
  (`src != 'api'`, journaled to `state/manual-book.json`) runs the
  BAGRUNNER trail: fee-lock stop at entry+0.12% once favor hits +0.18%
  (covers ~round-trip taker fees — the position physically cannot close
  red past that point), then dense greedy tiers banking ~80-85% of each
  rung, plus a fast vanish (peak +0.35%, giveback 32% → market close
  while still green). Tighten-only: a stop the operator set themselves
  is never loosened. `LIQ_GUARD_BAGRUN=0` disables globally.
- Churn meter: the exec journals `manualChurn {opens24h, fees24hUsd}` and
  Telegrams the operator at $5/$10/$20 daily fee-burn thresholds.

**Operator discipline (the human side):**
1. **Fees come back first or the trade doesn't exist.** ~0.12% price move
   covers round-trip taker fees; a +0.10% scalp is a donation. If the
   target isn't at least 3× the fee toll, don't open.
2. **One clip per idea.** Re-opening a symbol within minutes is churn —
   59 USELESS opens cost more than they could ever make. Scale in once or
   don't.
3. **Never open vault inventory** (USELESS — the vault leg owns it).
4. **If you set a stop, the machine respects it** — it only tightens.
   If you don't set one, the bagrunner profile runs defaults.
5. **The trail is the exit.** Don't market-close a winner early — the
   bagrunner lock already banked the fees; let tiers carry the runner.
   Kill losers by stop, not by hope.
6. **Momentum entries only.** Bagrunning = chasing a move that's already
   running, not bottom-fishing. If the 1m tape isn't moving your way at
   entry, the fee math never works.

## Standing operator mandates

- **Profit is the #1 metric — never win rate.** Grade everything in net
  dollars/R: a low-WR asymmetric system is welcome, a high-WR bleeder is not.
  Never gate, halt, or rank on hit-rate alone (WR breaker now requires
  net-negative too — 2026-10-01).
- **Take profit**: "No one ever went broke taking profit." If an open position's
  unrealized P&L covers its round-trip fees plus more, and there is no strong
  reason to hold (live target thesis, active runner), close it. Operator close
  channel: write `{"symbol":"SYMBOL"}` to `/opt/sentinel/state/cmd-close.json`
  on the VPS — the next rapid cycle cancels plans and market-closes.
- Demo only unless explicitly told otherwise: `SENTINEL_EXEC=demo`.
- Equity anchor: `SENTINEL_EQUITY_OVERRIDE_USD=65` ($100 AUD epoch start);
  book = 65 + journaled net, capped by real equity, minus vault carry.
- Vault: `SENTINEL_VAULT_SHARE=0.25`, HWM-gated (pays only on new NAV highs;
  `hwmUsd` must persist — fixed 2026-10-01). **Vault stays USDT** (operator
  order 2026-10-10): no auto-deploy into spot assets —
  `SENTINEL_VAULT_BUY_MIN_USD=999999999` keeps the USELESS/BTC buy path
  permanently off. Swept USDT earmarks in-ledger and moves futures->spot
  only when the API key carries transfer perms (currently 40014 — key is
  futures-trade-only; operator can move `pendingFutures` manually).
- **Min leverage 20x** (`SENTINEL_MIN_LEV=20`) — operator order 2026-10-08:
  carry/mandate/top-up orders ride >=20x whenever the liquidation band
  holds it; the band cap (lev<=80/(stopPct+0.64)) still wins when it
  can't. Signal orders take max band-fit lev (>=20 for stops <=3.36%).
- **Longs only** (`SENTINEL_LONG_ONLY=1`) — operator order 2026-10-07:
  every SHORT order refused (`longs-only-mandate` / `shorts-banned`).
  BTC/ETH/majors tradable (`SENTINEL_DENY_SYMS=` empty).
- **Capacity 10** (operator order 2026-10-10): up to 10 best trades on
  **each** wallet — `LIVE_TARGET_POSITIONS=10`, `LIVE_MAX_POSITIONS=10`,
  `SENTINEL_SIDE_CAP=10` futures-side; `ONCHAIN_MAX_POS=10`,
  `ONCHAIN_PCT=0.15`, `ONCHAIN_MIN_SCORE=55` chain-side (override.conf
  drop-in). Capacity, not quota — only gate-passing cells fill slots;
  never force a measured-loser to fill a seat.
- **Exploit funding as income**: carry earners rank up in trade score
  (+0–5 tilt by |rate|), payers penalized; `carryYieldDayPct` is journaled
  per order so carry income is auditable.
- ~~Long regime rule~~ **REMOVED 2026-10-07 by operator order** — the
  `below-ema50/200` hard gate is deleted from the scanner, setups,
  core-carry, flat-deploy, and top-ups. Do not re-add it without an
  explicit operator instruction; `emaRegime` context still renders on
  signals for display only.
- Never loosen evidence gates into measured-negative cells. Widen the
  funnel (candidate count, coverage), never the proof bar.
- **BTC-pair cross-read** (operator rule 2026-10-09): always check the
  asset-vs-BTC chart alongside USDT — up on both = real strength, up on
  USDT but down on BTC = pure beta. Real XBTC spot candles where the pair
  exists, synthetic XUSDT/BTCUSDT ratio otherwise; pair-less assets still
  score on synthetic RS — never drop a candidate for lacking a pair.

## Deploy

- Repo: `C:\Users\beaue\sentinel-clone` (git, pushes to GitHub).
- Live dir: `C:\Users\beaue\sentinel-live` (not a repo — sync to clone to commit).
- VPS: `ssh -i ~/.ssh/sentinel_vm_key ubuntu@54.66.217.111`
- Deploy file: `scp` to `~`, then `sudo mv` into `/opt/sentinel/` (root-owned),
  `node --check`, `sudo systemctl restart sentinel-rapid`.
- Pushbot (`/opt/pushbot`): Pages api mirror on `sentinel-push.timer` (5 min).
  `push.sh` self-squashes its own `.git` when >1.2GB (remote is canonical);
  heavy set (signal-archive, api/history, klines) is UNTRACKED in git —
  it rsyncs into the tree for the on-box mirror only. Repo copy:
  `scripts/pushbot-push.sh`. Disk filled to 100% on 2026-10-09 from 7.9GB
  .git — check `df -h /` on any ssh stall.
- Verify: `/opt/sentinel/api/god.json` (PERFECT = 22 pass),
  `live-ledger.json` (errors/actions/positionsAfter/sqnR),
  `market-scanner.json` (signals × strategy), `gate-stats.json` (veto buckets).
- **Production is LIVE on Bitget (since 2026-10-05).** The systemd units set
  `RAPID_MODE=live` / `SENTINEL_EXCHANGE=bitget` / `SENTINEL_EXEC=live`;
  `/opt/sentinel/.env` still says demo/bybit and is overridden (load-env.mjs
  never overrides existing env, and the first duplicate key in `.env` wins —
  edit values in place, never append a second line). Check `mode`/`exchange`
  in `api/live-ledger.json` before assuming demo.

## v1.1 master baseline (2026-10-10)

Frozen copies on VPS: `/opt/sentinel/state/v1.1-master/` (liq-guard,
bitget-watch, bitget-exec, ft.mjs, rr-config.json, env.txt — mode 600).
Full offline snapshot: `/opt/sentinel/state/sentinel-v1.1-master.tar.gz`
(code + api artifacts + state config; credentials/sessions excluded —
sent to Will Evans on Telegram). Adds since v1.0: evidence layer
(shadow race, episode clustering, edge attribution, strategy lifecycle
wired into the order gate), autonomous-P&L headline, reject markouts,
trader.dev libedge archetype matrix, on-chain lane with realtime marks
+ proven USDC round-trip, dashboard full-mesh artifact surface.

## v1.0 master baseline (2026-10-07)

Operator-declared stable config. Frozen copies on VPS:
`/opt/sentinel/state/v1.0-master/` (liq-guard, bitget-watch, bitget-exec,
ft.mjs, rr-config.json, env.txt).

- Protection stack (all positions incl. manual/foreign/cross): crash brake
  (>=0.8% adverse gap in 5s -> 50-100% close), leverage-scaled liq-zone trims
  (45% of band), stop-approach trims, margin-loss cap 0.55, naked-stop
  synthesis, software TP fallback at SCALP_TP_PCT for min-size positions.
- Crackwhore profit trail (liq-guard, every 12s, tighten-only):
  arm +0.2/0.25% (scalp/swing) -> lock entry+0.15%; tiers +0.4->0.3,
  +0.6->0.48, +0.8->0.65, +1.0->0.85, +1.3->1.1, +2.0->1.75, +3.0->2.75.
- TP ladder (bitget-watch rr-config "crackwhore 35/30/20 @0.15/0.35/0.7R
  +15"): legs at ~+0.3/+0.7/+1.5% on ~1% stops — banked in levels, never
  orbit targets. Old sniper grid (2/4/7R on 2x stopPct base = +12/24/42%)
  was the "never prints TP" defect — do not restore.
- Leverage: SENTINEL_MAX_LEV=25; lev = floor(80/(stopPct+0.64)) — derived
  from stop width, not conviction. ft.mjs supports `auto` stopPct =
  1.5x 15m ATR clamped 1.5-5%.
- Entries circuit breaker may be overridden by bounded
  state/cmd-override.json — operator-level risk call, never auto-renew.
- **Standing oil mandate** (operator order 2026-10-09):
  `SENTINEL_CORE_SYMS=CLUSDT,ETHUSDT,BTCUSDT` on sentinel-rapid —
  CL gets first claim in core-carry and rides every slot-deploy
  nomination (score-45 seed). Macro thesis: Iran war / Hormuz
  escalation, SPR restock demand, structural inflation bid. Still
  gated: dedup, cooldown, ambiguous/manual guards, catalog.

## Key mechanics

- Scanner universe is scoped to `exec-catalog.json` in constrained envs
  (demo = 45 contracts); fillable-first emission, phantoms pad leftovers.
- TA cascade: structural setups > `tsmom` (12h+48h momentum agreement) >
  generic fades (vwap/effort/eq-edge). Strategy name "TS Momentum".
- Leverage: 40940 low-liquidity caps parsed from the error message —
  retry at announced max, resize notional onto the same margin slice.
- Zero-risk ratchet stack (stop only ever moves in the trade's favor):
  fee-lock (move ≥ max(0.3%, 1.5×medMAE) → stop entry+max(0.15%,0.5×medMAE),
  calibrated from rr-backtest.json observed.medMaePct — early-EM locks are
  the documented expectancy killer, never arm inside the noise band) →
  move-lock (≥1.5% run → lock 55%) → TP-progress ratchet (≥90% to next
  level → lock ~55% of it) → moon-bag trail (all TPs banked → trail −1%).
- Risk: `MAX_RISK_PCT` is a ceiling; realized tier follows persisted
  position SQN (`priorSqnR` → `riskCapPct`, Model 17). Floor-min path
  enforces the same cap — skip rather than over-risk.
- SQN = position-level `netUsd/riskUsd`; needs n>=30 for a trustworthy
  estimate. Ledger resets are normal — demo-fills.json is the journal.
- Protection mesh (2026-10-07): three daemons — `sentinel-rapid`
  (exec: entries, ratchets, ladders), `sentinel-bitget-watch` (10s:
  band-clamped pos_loss repair + staggered TP re-arm, tighten-only SL),
  `sentinel-liq-guard` (~5s: liq-zone trims, stop-approach clips,
  margin-loss cap, naked-stop synthesis). Bitget counts CUMULATIVE
  pending plan qty vs position — TP legs must sum to ~85% of size, and
  pos_profit/full-size legs are silently invalidated on minimum-size
  positions; `LIQ_GUARD_SCALP_TP_PCT` closes those in software.
- Manual-hold (`SENTINEL_MANUAL_HOLD` + `state/cmd-manual-hold.json`):
  exec skips ALL reconcile once any stop exists; bitget-watch skips the
  TP ladder but keeps tighten-only stop repair; liq-guard adds scalp
  tiers — BE-lock (`BE_ARM_PCT` 0.6 → entry+`BE_LOCK_PCT` 0.15%),
  stall-cut (≥`SCALP_STALL_FRAC`×stop for `SCALP_STALL_MS` → early
  close), software TP. Book-wide BE-lock also covers non-scalp
  positions at `BE_ARM_SWING_PCT` 1.2 (tighten-only — composes with
  exec ratchets).

## Exchange drivers

- `SENTINEL_EXCHANGE=bitget` (default) or `bybit` — scripts/exchange/
  adapters normalize both into identical internal shapes; the executor,
  journal, stats, and catalog gate don't care which driver is active.
- Per-exchange demo state: bybit demo writes `demo-fills-bybit.json`,
  `wealth-vault-bybit.json`, `equity-peak-demo-bybit.json` — books never mix.
- Bybit demo: `api-demo.bybit.com`, keys minted in demo.bybit.com (no
  passphrase). Demo mode hard-refuses a mainnet BYBIT_API_HOST.
- Verify a new driver before any real cycle:
  `SENTINEL_EXEC=demo SENTINEL_EXCHANGE=bybit node scripts/exchange/verify-demo.mjs [--write]`
- Scanner market data routes through the venue shim (`mdGet`); live-feed and
  liq-guard public WS both have Bybit drivers. Ops tools `force-trade.mjs` /
  `force-near.mjs` now go through `makeExchange` (Bitget or Bybit).
- Live-phase addition: Bybit vault sweep routes UNIFIED->FUND — the funding
  account backs the Bybit Card, so `SENTINEL_VAULT_SHARE` sweeps become
  card-spendable. Card spends drain FUND outside the bot's view — reconcile
  the vault ledger against actual FUND balance, not just sweptIds.

## Credentials

- `/opt/sentinel/.env` contains live Bitget keys — never echo, never commit,
  treat exposed values as compromised.

## Pre-mortem — every way this system can lose money (desk rule: written before the code, kept honest)

Reviewed against the live architecture. Each row: the failure mode → what guards it.

- **Entry adverse selection** — a limit entry fills precisely because the
  move already started against it → entries are stop/plan-triggered into
  the level, RR floor re-checks at fill time, markouts grade post-exit
  drift so bad entry timing is measurable.
- **Redeploy-after-loss churn** — scanner re-entering a symbol that just
  stopped us → ENTRY_DEDUP window + auto-quarantine (`auto-deny.json`,
  4 straight grouped losers + $1 bleed = 24h deny) + account breakers.
- **Correlated same-direction stack** — five "different" longs are one
  BTC position → corr-cluster gate rejects same-side adds on correlated
  symbols; side caps bound the rest.
- **Wick/cascade faster than polling** → crash brake (0.8%/5s gap → clip),
  exchange-side stops (a VPS outage can't leave the book naked).
- **Profit round-tripping to red** → fee-lock at +0.2/0.25%, dense trail
  tiers, continuous 75%-of-peak keep, vanish-close on 40% giveback.
- **Tape turning toxic mid-position** → VPIN-lite: >=70% one-sided 1m
  volume against the side tightens keep to 85% and halves vanish patience.
- **Fee churn** — 59 closes of dust = the bleed wearing a costume →
  dust-floor clips skipped, fee-burn breaker, net-RR floors include costs.
- **Equity floor** — below MIN_TRADE_EQUITY the machine posts dust and
  donates fees → entries halt, exits never gated.
- **Edge evaporation** — slow bleed never trips magnitude breakers →
  CUSUM edge-death + half-Kelly ceiling reads the position stream.
- **The exit itself leaving money** → markout grading at 1s/10s/60s,
  self-tuning KEEP_FRAC/VANISH_FRAC (bounded, journaled).
- **Operator override decay** — manual breaker overrides used to linger
  forever → cmd-override.json is bounded and self-expiring.
- **Stale/garbage feed acting as truth** → WS marks anchored to REST,
  >5% deviation rejected, markout pending-queue dies at 10min.
