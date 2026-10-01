# Sentinel — Operator Rules & Project Facts

## Standing operator mandates

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
- Never loosen evidence gates into measured-negative cells. Widen the
  funnel (candidate count, coverage), never the proof bar.

## Deploy

- Repo: `C:\Users\beaue\sentinel-clone` (git, pushes to GitHub).
- Live dir: `C:\Users\beaue\sentinel-live` (not a repo — sync to clone to commit).
- VPS: `ssh -i ~/.ssh/sentinel_vm_key ubuntu@168.138.102.53`
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
- Risk: `MAX_RISK_PCT` is a ceiling; realized tier follows persisted
  position SQN (`priorSqnR` → `riskCapPct`, Model 17). Floor-min path
  enforces the same cap — skip rather than over-risk.
- SQN = position-level `netUsd/riskUsd`; needs n>=30 for a trustworthy
  estimate. Ledger resets are normal — demo-fills.json is the journal.

## Credentials

- `/opt/sentinel/.env` contains live Bitget keys — never echo, never commit,
  treat exposed values as compromised.
