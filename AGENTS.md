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
- Shorts allowed (`SENTINEL_LONG_ONLY=0`); BTC/ETH/majors tradable
  (`SENTINEL_DENY_SYMS=` empty).
- **Balanced book**: up to 5 longs + 5 shorts held concurrently
  (`SENTINEL_SIDE_CAP=5` per direction, `LIVE_TARGET_POSITIONS=10` when
  the env is editable). Capacity, not quota — only gate-passing cells
  fill slots; never force a measured-loser to balance.
- **Exploit funding as income**: carry earners rank up in trade score
  (+0–5 tilt by |rate|), payers penalized; `carryYieldDayPct` is journaled
  per order so carry income is auditable.
- **Long regime rule**: LONGs only when price is above BOTH the EMA50 and
  EMA200 (1H stack, real 200-period — needs >200 closed bars). Hard gate
  `below-ema50/200`, fail-closed on missing/thin history; enforced on
  scanner signals, operator setups, core-carry deploys, and top-ups.
  Shorts unaffected (2026-10-02).
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
