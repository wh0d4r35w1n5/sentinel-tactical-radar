# Sentinel — Operator Rules & Project Facts

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
  `hwmUsd` must persist — fixed 2026-10-01).
- **Min leverage 20x** (`SENTINEL_MIN_LEV=20`) — operator order 2026-10-08:
  carry/mandate/top-up orders ride >=20x whenever the liquidation band
  holds it; the band cap (lev<=80/(stopPct+0.64)) still wins when it
  can't. Signal orders take max band-fit lev (>=20 for stops <=3.36%).
- **Longs only** (`SENTINEL_LONG_ONLY=1`) — operator order 2026-10-07:
  every SHORT order refused (`longs-only-mandate` / `shorts-banned`).
  BTC/ETH/majors tradable (`SENTINEL_DENY_SYMS=` empty).
- **Balanced book**: up to 5 longs + 5 shorts held concurrently
  (`SENTINEL_SIDE_CAP=5` per direction, `LIVE_TARGET_POSITIONS=10` when
  the env is editable). Capacity, not quota — only gate-passing cells
  fill slots; never force a measured-loser to balance.
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

## Deploy

- Repo: `C:\Users\beaue\sentinel-clone` (git, pushes to GitHub).
- Live dir: `C:\Users\beaue\sentinel-live` (not a repo — sync to clone to commit).
- VPS: `ssh -i ~/.ssh/sentinel_vm_key ubuntu@54.66.217.111`
- Deploy file: `scp` to `~`, then `sudo mv` into `/opt/sentinel/` (root-owned),
  `node --check`, `sudo systemctl restart sentinel-rapid`.
- Verify: `/opt/sentinel/api/god.json` (PERFECT = 22 pass),
  `live-ledger.json` (errors/actions/positionsAfter/sqnR),
  `market-scanner.json` (signals × strategy), `gate-stats.json` (veto buckets).
- **Production is LIVE on Bitget (since 2026-10-05).** The systemd units set
  `RAPID_MODE=live` / `SENTINEL_EXCHANGE=bitget` / `SENTINEL_EXEC=live`;
  `/opt/sentinel/.env` still says demo/bybit and is overridden (load-env.mjs
  never overrides existing env, and the first duplicate key in `.env` wins —
  edit values in place, never append a second line). Check `mode`/`exchange`
  in `api/live-ledger.json` before assuming demo.

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
