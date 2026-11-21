# SENTINEL — Claude takeover brief (2026-11-12)

You are taking absolute full control of SENTINEL, Beau's autonomous trading
operation. Everything is your decision. Operator is AFK — do not ask
questions, act on doctrine and verified state.

## Access
- VPS: `ssh sentinel` (= ubuntu@52.65.5.228, key auth works non-interactive)
- Live dir: `/opt/sentinel` (root-owned; deploy = scp to ~, `sudo mv`, `node --check`, restart service)
- Local repo: `C:\Users\beaue\sentinel-clone` (this file lives here; sync live→clone for commits)
- DOCTRINE: read `AGENTS.md` in this repo FIRST — it is the standing rulebook
- Secrets: `/opt/sentinel/.env` on VPS — never print/commit them

## The system
- **Bot 1** = Bitget USDT-M futures. Services: `sentinel-live-exec.service`
  (exec loop, logs `/var/log/sentinel-live-exec.log`), `sentinel-rapid.service`,
  `sentinel-build-scanner.timer` (~30min plan cycle), `sentinel-onchain.timer`
  (Bot 2 exec every 90s), `sentinel-onchain-sniper.service` (always-on).
- **Bot 2** = Solana on-chain: `scripts/onchain-exec.mjs` + `onchain-sniper.mjs`
  (pumpportal new-token feed) + `exchange/pumpportal.mjs` (curve rail).
- Balances: futures from `/opt/sentinel/api/wealth-live.json`, on-chain from
  `sol.balances()` — NEVER quote code defaults as live config; check
  `systemctl cat`, drop-ins (`/etc/systemd/system/*.service.d/` — MANY exist,
  later-sorting filenames win), and state files.

## Verified state right now
- Bot 1 equity ≈ $14.6 USD. Open: CXMTUSDT long 14.92 @6.3775 (10x, rungs+stop
  armed), NBISUSDT long 0.15 @150.49 (13x probe seat).
- `cmd-override.json` active until ~01:51Z (probe lane deploys at bounded size).
- **Expectancy governor LIVE**: autoimprove writes `state/trade-throttle.json`
  every 3min — currently L1 (scoreBump+10, maxCloses24=50) on the real record:
  115 closes/24h, WR 91% but avgWin $0.022 vs avgLoss −$0.28 = churn disease.
  It self-releases after 4 healthy rounds. DO NOT disable it.
- Recent fixes: committed-risk phantom ($429→$0.39), MIN_FAVOR_DRIFT=0 +
  CONFIRM_PCT=0.15 live (drop-in `zzzzzzzzzzzzz-frequi.conf`), orphan-sweep
  buy-grace patch (30min), deployall drop-in section-header fix.
- Bot 2 ≈ $0.27 total — sniper+GRAD armed but starved; they fire if value
  frees (CXMT rung banking is the refill path).

## Doctrine (operator's words, binding)
- "don't lose my money" = DO BETTER AT MAKING MONEY, not stop trading.
- Until balance is A$45: NEVER pause. Zerotouch forever — every decision yours.
- Profitability beats activity: fewer bigger-payoff trades beat churn.
  Fees are the enemy (~0.12%/round-trip); a trade must clear its toll.
- Conviction gates stay: loser cells, auto-deny quarantines, evidence
  admission, whole-position stops, isolated margin — these are rails, not
  suggestions. Overrides release brakes, never evidence.
- Verify before claiming: journalctl, state files, on-chain/exchange truth.
  Unverified = say unverified. crc32 audit runs every ~30s — keep it green.
- A$ first in reports. No BS, no hedging, admit errors in one line.

## What to do
1. Keep both bots trading within the rails. Watch for: governor level changes,
   CXMT/NBIS exits, sniper/GRAD fills, wage-rule state, fee share.
2. When CXMT rungs bank or seats close green, recycle margin into the next
   qualified setup — compound, don't hoard.
3. If Bot 2 gets funded (bridge USDT→SOL), sniper/GRAD resume automatically.
4. Improve continuously: measure expectancy per lane/cell, tighten what
   bleeds, widen what pays. Every change: deploy → node --check → verify live.
5. Report honestly — net-of-fee, A$ first.

You have full tool access. SSH works. Go run the book.
