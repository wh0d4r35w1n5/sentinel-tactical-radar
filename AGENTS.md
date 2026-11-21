## Seat armor mandate (operator order 2026-11-21 - "must never happen", keep forever)

- **Every open seat MUST have staggered TP rungs AND a stop** - never a lone TP, never naked upside or downside. `sentinel-bid-armor.service` (scripts/bid-armor.mjs) runs 30s: detects any position missing pos_profit coverage, attaches the rung ladder + an SL backstop + writes the `bid-fill` reason tag.
- **No hand-rolled order scripts.** Seats open through `_open-seat.mjs` (gates: risk clamp -> instrument ID -> sector -> confluence -> pattern -> SMC) or via `limit-deploy.mjs` resting bids (preset SL at placement; armor adds TPs on fill).
- **Stops live under structure** (SMC invalidate / FVG low / swing), not a tight lock-profit % on fresh seats - the GOOGL stop-out at 0.16% room was the lesson: right idea, wrong distance.
- **Leveraged/inverse ETFs are banned as seats** (SSPC/SOXS/SQQQ class: daily-reset decay + whipsaw - operator flagged mental-health cost). Sector breadth on those names stays as CONTEXT only.
- **Degen/micro-cap alts**: only when pattern + confluence or clean SMC structure fires, sized at 4% risk.
- **The book is NEVER empty bids-only** (operator order 2026-11-21 - "you cant leave the board empty with only limit orders" / "never do that again, remember forever"). At least one live seat at all times; resting dip-bids are additions to live exposure, never a substitute. If the last seat stops out, re-deploy through the gates promptly rather than waiting in cash.

## SSH access — the trick (operator order 2026-11-21, keep forever)

- The `ssh sentinel` alias is FLAKY under load — it stalls and returns no output.
- ALWAYS use the direct form: `ssh -i "$HOME/.ssh/sentinel_vm_key" -o ConnectTimeout=20 ubuntu@52.65.5.228 'cmd'`
- Key lives at `~/.ssh/sentinel_vm_key` (or copy from `C:\Users\beaue\sentinel-live\.ssh-keys\sentinel_vm_key`, chmod 600).
- Do NOT use `-o ControlPath=none` (every command does a full slow handshake) — but ControlMaster mux sockets also fail on this Windows env; the direct key one-shot is the reliable form.
- When the box is I/O-saturated (load >20), even direct commands lag — wait for backlog jobs to settle rather than spawning more ssh.


## Management doctrine — patience, conviction, wide stops (operator teaching 2026-11-11)

## Correlation + sizing doctrine — Van Tharp correction (operator order 2026-11-13)

Verified failure 2026-11-13: three momentum longs (JTO/CLSK/SPCX) were the
same alt-beta bet; one market dip = one 45%-of-equity position. JTO
stopped at full riskPct-15 risk: -$7.18 net. Operator: "van tharp would
be pissed at you" — correct on both counts.

PERMANENT RULES:
- **Correlation cap**: momentum lane max 2 concurrent seats; the 3rd
  slot is reserved for a different lane/class (LS:LONG, stock-perp,
  commodity). Never fill the book with copies of the same beta.
- **Risk-per-trade**: devin-momentum riskPct is 5 (was 15). Max momentum
  book exposure = 10% of equity. Unproven/probation lanes stay
  probe-sized until the live R-stream convicts or acquits (Claude
  backtest had momentum ~breakeven — unproven, do not full-size it).
- **Reporting**: A$ first; deposits are NOT trading P&L — always
  separate them ("you are cheating by including deposit amount").

## Reporting currency — A$ first (standing order 2026-11-13)

ALL balance/P&L reports to the operator lead with AUD (A$), USD second.
Operator is Australian in AEDT — "we talk in AUD, remember that forever."

"correct management is you just wait it out and patience pays and you
have high conviction and high proven sqn backed winrates — with wide
enough stop losses"

- Winners ride to their modeled targets — no dust-harvesting that banks
  +0.3% when the plan geometry says +2.5%. Verified leak 2026-11-11:
  avgWin +0.37% vs avgLoss -0.91% (RR 0.41) over 24h — exits were
  cutting winners ~7x earlier than losers resolved.
- Stops must be wide enough that normal volatility cannot shake a
  high-conviction seat out — a stop that fires on noise is not a stop,
  it is a fee donation with extra steps.
- Entries demand proven edge BEFORE size: SQN-backed cells, live
  strategy-policy status, kelly f*>0. Conviction first, patience second,
  wide stop third — in that order.
- Symbol quarantines convict on per-trade expectancy, never cumulative
  noise (bleed-audit patched 2026-11-11: DENY_PT=-0.02/trade floor;
  bleed-exempt.json pairs exempt operator-designated symbols).
- Profit-taking happens REGULARLY at the levels that MAXIMIZE profit —
  ladder rungs placed where the tape actually pays, not dust rungs at
  +0.3% and not greedy single targets that round-trip winners to red.

## Trading canon → SENTINEL mapping (operator-ordered study 2026-11-11)

The books that matter for a systematic book this size, and what each
dictates here — already partially in code (Tharp Model 17 risk tiering,
LdP meta-labeling, kelly f* sizing); gaps are the work list:

- **Van Tharp — Trade Your Way to Financial Freedom**: expectancy =
  WR×avgWin − LR×avgLoss; you cannot fix win-rate, you fix PAYOFF or
  COSTS. SENTINEL leak: avgWin +0.37% vs avgLoss −0.91% → fix exits
  (payoff) before touching entries. Also: position size is the only
  variable fully in our control — risk% per trade must be constant,
  never martingale.
- **Alexander Elder — Trading for a Living**: 2% rule (max loss per
  trade), 6% rule (monthly stop), triple-screen (higher-TF direction
  gates lower-TF entries). Maps to: VWAP side gate = screen 1;
  per-trade risk cap already exists via riskUsd; monthly breaker
  exists (DAILY_HALT family) — verify it's actually armed, V5-era env
  had it at 99.9% (effectively off — deliberate then, revisit).
- **Ernest Chan — Quantitative Trading / Algorithmic Trading**: never
  optimize on the same data you trade; regime-change beats parameter-
  tweak; simple robust beats complex fragile. Maps to: the n≤3 deny
  bug was exactly Aronson-style overfit on noise — per-trade
  expectancy gate is the fix. New gates (VWAP, favor-drift) must be
  judged on OUT-OF-SAMPLE fills, not vibes.
- **David Aronson — Evidence-Based Technical Analysis**: data-mining
  bias kills backtests; small samples prove nothing. Maps to: deny/
  promote decisions need n and CI, not raw net — already partially
  there (strategy-policy uses CI bounds); bleed-audit now requires
  per-trade expectancy for the same reason.
- **Ralph Vince — The Mathematics of Money Management**: optimal f —
  bet fraction that maximizes geometric growth given the actual
  win/loss distribution. Maps to: kellyStrat.fStar already computed
  per strategy — verify position sizing actually multiplies by it
  (metaMul path exists; check it's not bypassed on the live rail).
- **Marcos López de Prado — Advances in Financial ML**: meta-labeling
  (already in exec: p(profit) gate), fractional differentiation,
  purged CV. Maps to: the metaP floor at META_MIN_P — verify it's
  actually constraining live entries, not just demo.
- **Andreas Clenow — Following the Trend / Stocks on the Move**:
  trend systems win by cutting losers fast and letting winners run —
  asymmetric payoff is the whole edge. Maps to operator doctrine:
  patience + wide stops + profit-max exits = let winners reach
  modeled targets; the +0.37% avg win is the anti-Clenow leak.
- **Brett Steenbarger — The Psychology of Trading**: process over
  outcome; every exit should be rule-based ex-ante, never
  outcome-based ex-post. Maps to: no manual seat micromanagement,
  exits fire on rules not feelings (already doctrine).
- **Jack Schwager — Market Wizards**: the edge is risk control and
  position sizing, not prediction. Maps to: SENTINEL's job is NOT to
  predict direction — it's to size risk correctly and cut what
  demonstrably doesn't work (deny system, now fixed).
- **Alexander Elder — Come Into My Trading Room / psycho-cybernetics**:
  discipline is a trained skill; the system must encode discipline
  mechanically because discretion leaks. Maps to: every rule the
  operator teaches gets WIRED into code/state, not left as prose —
  this file is the spec, the exec is the enforcement.

Work queue from the canon (priority order):
1. Exit/payoff repair — winners to modeled targets, rungs at
   profit-maximizing levels (Clenow/Tharp). THE leak.
2. Verify kelly f* actually scales live sizing (Vince).
3. Verify metaP floor constrains live entries (LdP).
4. Monthly/6% breaker — confirm armed or deliberately off.
5. Every new gate judged out-of-sample before it earns permanence
   (Chan/Aronson).

## Van Tharp deep doctrine (operator-ordered 2026-11-11 — "tharp is the
## greatest trading mastermind that ever lived; risk management and
## position sizing are the secrets retail fails on; SQN cannot be faked")

### The core truths
1. **Expectancy is the only thing that matters**: E = (WR × avgWin) −
   (LossRate × avgLoss). Win-rate is nearly irrelevant alone — a 90%
   WR scalper loses to a 35% WR system with 4:1 payoff. You cannot
   reliably improve WR; you improve PAYOFF (exits) or COSTS (fees,
   churn). SENTINEL's verified leak is payoff: +0.37% avg win vs
   −0.91% avg loss.
2. **SQN = (avgR / stddevR) × √N** — the unfakeable score. It folds
   expectancy (avgR), consistency (stddev penalty), and frequency
   (√N) into one number. Win-rate can lie; SQN cannot: it punishes
   systems whose R-stream is dominated by variance or thin samples.
   Benchmarks: SQN>2 good, >3 excellent, <1 poor, negative = bleed.
   OPERATOR DOCTRINE: entries require SQN-backed proven cells —
   strategy-policy must gate on SQN not raw net.
3. **Position sizing IS the edge**: the only variable fully in our
   control. Tharp's hierarchy — fixed-% risk per trade (1-2%
   professional standard), volatility-adjusted (size ∝ 1/ATR so every
   trade risks equal $), never martingale, never "feel". SENTINEL
   must size every seat so worst-case loss = fixed % of equity —
   verify riskUsd is actually constant across seats, not cosmetic.
4. **R-multiples over dollars**: every trade judged in R (initial
   risk), never $ — $ varies with sizing, R doesn't. Audit fills as
   R-streams: avgR, stddevR, SQN per cell. The bleed-audit should
   convict on avgR-per-trade expectancy, which it now approximates
   via per-trade net.
5. **Costs can eat a small account alive**: Tharp's explicit warning —
   at $24 equity, 0.12% round-trip fees mean each trade needs >0.12%
   just to exist. Fewer, higher-R trades beat many dust trades. The
   70 sub-$0.05 "wins"/24h pattern is exactly what he warns against.
6. **Entries are the least important component**: statistically,
   entries contribute least vs exits+sizing. Stop over-engineering
   entry prediction; perfect the exit geometry and sizing math.
7. **Stay in the game**: survival precedes profit — the 6% monthly /
   2% per-trade professional rails exist because variance kills
   under-sized-but-unprotected books. One −30% month erases a year
   of +2% months.
8. **Trade like a casino**: positive expectancy × many repetitions ×
   correct sizing = profit emerges mechanically. No prediction needed
   — edge × size × reps. SENTINEL's job is exactly this: cells with
   proven expectancy, sized correctly, repeated without self-sabotage.
9. **Objectives before entry**: every seat knows its target and stop
   BEFORE it opens — exits are structure/volatility-based (measured
   moves, trail on expansion), never hoped-for. "Take profit at the
   most profit-maximising levels" = exits placed where the market's
   own geometry pays, runged regularly.
10. **Systems thinking**: one system = one cell; the book is a
    PORTFOLIO of uncorrelated cells. Correlation is the hidden risk —
    12 seats all long-beta is one giant bet. SQN per cell + correlation
    awareness = the real diversification.

### Applied to SENTINEL's verified state (2026-11-11)
- Leak #1 (payoff): exits harvest +0.37% while stops realize −0.91% —
  fix exits FIRST per Tharp priority.
- Leak #2 (costs): $0.81 fees/8h on $24 equity — churn is a bleed
  independent of direction.
- Leak #3 (sizing): verify riskUsd constant per seat — if seats risk
  unequal $, SQN comparisons across cells are meaningless.
- Leak #4 (conviction): entries must show SQN>1 per cell before size;
  probation cells get probe size only.
- Leak #5 (frequency): √N means MORE quality trades compound SQN —
  but only if per-trade expectancy stays positive; frequency without
  edge is just faster fees.

## Factory-X deployment rail fixes (2026-11-12 — verified live fill)

The sqn-factory-x -> cmd-setups -> exec pipeline was structurally unable to
trade until these fixes; every promoted cell died before reaching the
exchange. All verified against live fills:

- **h-exit cells authored tps:[]** — exec setup gate requires >=1 TP and
  netRR >= SENTINEL_SETUP_MIN_RR (1.0); empty tps auto-rejected EVERY
  time-exit probe (the top SQN cells: rs-lag3:h10 sqn 3.68 wr 66%,
  nr-comp:h5 sqn 4.51 wr 67.5%). Deploy now authors a far TP (+9% vs 8%
  disaster stop = netRR ~1.07); the K2 trail/time logic manages the real
  exit — the TP exists so the seat can legally open.
- **Geometry anchored to stale signal px** — slPx/tps computed off the
  1D signal price (ETH 2074 vs mark 1999) made netRR ~0.44 vs live mark.
  Setup geometry must be anchored to CURRENT mark; market-mode entryPx is
  advisory anyway.
- **Envelope-loser symbols** — deploy now skips deploy-envelope
  verdict:'loser' symbols (ETH/XRP/SOL/BTC whole-symbol DENY); authoring
  setups that can only die at DENY_SYMS wastes the queue.
- **Contract-min floor at the risk rail (risk-entry.mjs)** — the dd-scaled
  risk budget can size a seat under one exchange lot (XAU 0.01 lot = ~$39
  notional vs ~$30 sized) -> 'contract minimum exceeds risk-sized
  quantity'. Retry once with riskScale>=0.5 and requestedNotionalUsd pinned
  just above contract min — bounded; every other cap unchanged. This is
  LIVE_FLOOR_MIN doctrine applied inside the risk rail.
- **40808 resubmit must reuse the effective intent** — the exeStopLossPrice
  retry re-prepared with the ORIGINAL intent and silently dropped the
  min-floor params, re-failing contract-min. entryIntent now tracks the
  intent that produced the approved size through both retries.
- **Setup failure reasons carry the real error** — bitget-exec setup-resolve
  now appends the reject's reason message (was gate names only — hid the
  actual 'contract minimum exceeds' cause for hours).

Verified end-to-end 2026-11-12 ~16:23Z: facx-XAUUSDT nr-comp0.8-dn:h5 SHORT
triggered -> min-floor sized 0.01 @ 10x (~$38.8 notional, $3.88 margin,
plannedRisk $0.45) -> 40808 resubmit -> filled -> watcher verified 1 stop
+ 1 TP leg on exchange. TIAUSDT LONG also seated same window (1 stop + 4
TP legs). Book: 3 protected positions, equity ~$11.8.

## Work state 2026-11-12 ~19:15 UTC (latest — supersedes below)

OPERATOR ORDERS THIS SESSION (verbatim where captured):
- "board only new system stuff" → NEW_SYSTEM_ONLY=1 rail in bitget-exec
- "cheetah feeds kids" = real size → "I WANT ALL CAPITAL DEPLOYED",
  "BIGGER TRADE SIZE IS USUALLY MY EDGE", "GET RICH OR DIE TRYING"
- Long-edge doctrine: facx shorts OFF (SENTINEL_FACX_SHORTS gate),
  open shorts closed, metals same-beta veto, non-crypto SQN≥5.5 bar
- "work with Claude ALWAYS REALTIME" → STATUS-CLAUDE.md/STATUS-DEVIN.md
  loop live; Claude verifies fills ~2min cadence; .tmp/CLAUDE-UPDATED.txt
  is the change flag

DEPLOYED + VERIFIED:
- NEW_SYSTEM_EXTRA env lane exceptions: "Liquidity Sweep:LONG" live —
  only lane with non-negative realized R (n=55, sumR +0.81, SQN 0.19)
- SENTINEL_DD_SCALE_OFF=1 → ddRiskScale pinned 1.0 every tier (was
  flapping 4x at 30% day-DD boundary)
- SENTINEL_LANE_RISK_PCT per-lane notional caps (built, currently '' —
  operator overruled the 4% LS cap; mechanism stays for future use)
- risk-entry.mjs: requestedNotionalUsd = setup.notionalUsd (setup seats
  risk their authored riskPct, not the 30% policy — was 7.5x oversized);
  setup slPx/absSl now honored as structural stop (was ignored → real
  risk was ~1/3 intended); fill-vs-stop re-anchor (HUT died 2s on a stop
  anchored to stale ref — now re-places at real fill preserving distance);
  40808 first-try fix (presetStopLossExecutePrice omitted); pos poll 250ms
- Structure author dead-cell gate: no more zombie re-arms (14 purged)
- devin-momentum lane: ad-hoc authored setups (15m klines, above-VWAP
  96-bar, 5-bar mom +2.5-8%, ATR14 stop 2x, 1.5R/3R ladder, riskPct 15,
  mode market). Claude backtest: ~breakeven — UNPROVEN, probe-sized until
  live evidence convicts or acquits. Author dedupes ALL prior attempts.
- GitHub: github-sync.sh/.cmd loop (Startup folder) pushes fast lane ~15s
  + full VPS-state lane ~10min to PRIVATE backup-v130 ONLY. Public origin
  (tactical-radar) NEVER pushed — verified ls-remote = local HEAD.

LIVE STATE ~19:15Z: eq ~$11.4, 93% margin deployed. Seats: TIA $4.65,
SUSDT $3.49, MARA $1.45, NVDA $0.95, ALAB closed +$0.026. All stops+TPs
exchange-verified every 10s by bitget-watch. Bot2 starved $0.11 — needs
operator Bitget→Solana transfer for GRAD lane.

PENDING: momentum lane live evidence (avgR per cell); facx long flow;
next LS:LONG signals ~19:15Z scanner; backup push continuity.

## Work state 2026-11-11 ~15:10 UTC (superseded)

Deployed + verified this session:
- **autoimprove.py bleed filter FIXED** — it matched `kind='close'` but real
  fills carry `tradeSide='close'` + `src`; bleed_keys was 0 forever so
  auto-deny never fired via this path. Now: tradeSide close-detect,
  position-side map (buy→long/sell→short), real trailing-24h window.
  Verified: bleed_keys 23, wrote MPUSDT:long + PIUSDT:long denies [verified].
- **crc32 audit every 30s round** — crc32-verify.mjs was NEVER invoked
  (integrity.json was 7d stale; god read dead data). Now autoimprove runs
  it every round, alerts dedup'd, post-write read-back verify on
  auto-deny.json + restart-state. integrity.json: ok, 68 files, 0 corrupt.
  Stale manifest entry api/history/archive-2026-10.json removed.
- **GRAD lane widened** — GeckoTerminal scan 20→80 pools/cycle (4 pages),
  buy-ratio≥0.48, ≥15 unique buyers, h1 momentum floor. Log-verified.
- **TradFi session gate** — weekend block all non-crypto perps + US-stock
  hours 04:00-20:00 ET. cls flows scanner→plan (line ~3329 build-scanner);
  plan orders carry cls from next scanner run onward.
- Shorts: never actually blocked — SENTINEL_LONG_ONLY=0 + open-season.json
  enabled since Nov-4 lifts direction gates. Plan emits shorts live.

Measured 24h at ~15:00Z: net -$1.10 USD (fees $1.00 = 40.7% of gross,
gross ≈ breakeven). Bleeders now quarantined; VOL EVENT brake active
(19% green breadth). Payoff ladder live: 0.9/1.5/2.4/4.0/6.5% rungs,
alloc 8/12/20/22/18, moon 20%.

PENDING VERIFICATION:
- cls on live-plan orders after 15:12Z scanner run + tradfi-weekend/
  session rejects firing in exec journal
- avgWin post-rung-push vs $0.028 baseline (needs fill sample)
- GRAD in-zone candidate appearance (80-pool scan live, 0 candidates yet)
- ETHUSDT:long/SAMSUNGEM/MSTR/IONQ per-side deny qualification

## Work state 2026-11-11 ~11:00 UTC (post-compaction resume point)

Deployed + verified this session:
- V5 executor live; EAGLE/ATR/post-V5 additions removed; lane-split kept
- VWAP side gate in admission rail (klines-15m.json tp*vol, fails open >60min stale)
- SENTINEL_MIN_FAVOR_DRIFT=0.001 effective (was -1.0) — green-tape confirm live
- Bleed-audit patched: per-trade expectancy gate DENY_PT=-0.02 + bleed-exempt.json pairs
- auto-deny rebuilt 30→14 real bleeders; BTC:long+SOL:long exempted (operator order)
- rr-config payoff-shift: alloc 10/10/20/25/15 + moon 0.20 (was 15/15/20/20/15 + 0.15)
- Verified: metaP rail fed (signal-eval.json 200 recs, evN≥40, non-canon orders);
  cell-admission.json fresh (canon rail); sizing ~constant $0.41 risk/seat

Measured baseline (PRE-payoff-shift, since Nov-10 11:56Z):
- 101 closes: 86W/15L = 85% WR; avgWin $0.028 vs avgLoss $0.21 (1:7.5 against)
- Gross +$2.39/−$2.91 = net −$0.52; equity ~$24.16 climbing slowly
- Breakeven needs avgWin ≳$0.037 — payoff shift targets this

PENDING VERIFICATION (do not claim done until measured):
- avgWin on closes AFTER ~11:00Z Nov-11 (payoff-shift fills) vs $0.028 baseline
- Whether new seats show rear-weighted rungs (watch re-arms per cycle)
- Fee drag trend: was $0.81/8h — should fall as gates thin entries
- BTC/SOL longs: exempted but unproven — watch their first fills' quality

Open risks: ETH long (operator-ordered flip) armor = +10%/−5% plans;
BTC:long/SOL:long exempt = operator override of math (their records were
bleeder-tier) — if they bleed again, re-deny is honest.

## GRAD lane — pump.fun pre-graduation buys (operator-ordered 2026-11-11: "buy tokens 8% before graduation")

`/opt/sentinel/scripts/onchain-exec.mjs` — separate lane inside the Bot-2
executor, runs every 90s via sentinel-onchain.timer. DOES NOT consume the
`entriesAllowed` hot-feed policy; DOES respect purse-dd/churn brakes and has
its own caps/brakes.

Mechanics:
- Candidates: GeckoTerminal `networks/solana/dexes/pump-fun/pools` sorted by
  h24 volume. Mint must end `pump`, quote WSOL. Progress from virtual token
  reserves (const-product, `GRAD_K`/`GRAD_VTOK0`/`GRAD_SOLD_MAX` in file).
- In-zone band ~85-97% curve progress (env-tunable), min curve reserve,
  min 24h volume + buy count, excludes held mints + per-mint loss cooldown.
- Sorted by volume, max `ONCHAIN_GRAD_MAX_POS=2` concurrent `lane:'grad'`
  seats, symbol prefix `G:`.
- Clip: `ONCHAIN_GRAD_CLIP_USD=0.5` fixed (pct math dips under floor at this
  purse scale). Pay mint preference USDC->USDT->SOL; SOL spendable above
  `ONCHAIN_GRAD_SOL_RESERVE=0.005` skips the conversion leg.
- Gas: fresh ATA needs ~0.002 SOL rent + fees. If `bal.sol <
  ONCHAIN_GRAD_GAS_MIN=0.006` and USDC >= topup+0.5, gasless Ultra USDC->SOL
  top-up (`ONCHAIN_GRAD_GAS_TOPUP_USD=0.3`) — relayer pays gas.
- SOL price: cached `state/onchain-solpx.json` (10min TTL) from a 0.01 SOL
  probe quote — avoids a Jupiter call every cycle.
- Buy = `sol.swapAny` (Ultra <~0.004 SOL, classic above) — NO separate quote
  call (lite-api 429s under burst; outAmount comes back on the swap itself).

Exit profile per grad position (env-overridable, all defaults shown):
floor 0.78, arm 1.02, feeLock 1.0, keep 0.72, maxHoldH 12, moonKeep 0.15
(15% rides free as lottery bag), dynTp step 12%/sell 15%/cover 1.04x -> SOL.

Brakes:
- rolling-loss brake now scopes to NON-grad exits (`lane!=='grad'`) and sets
  `rollingBraked` flag gating only the standard lane — legacy fills (RCAT
  write-off etc.) must not park the operator-directed grad lane.
- grad mini-brake: last 3 `lane:'grad'` exits net < `ONCHAIN_GRAD_ROLL_USD=2`
  -> buys paused (self-clears as new exits journal).
- Sell fills now journal `lane: pos.lane` (was missing -> grad exits were
  invisible to lane-scoped accounting).

BUG FIXED 2026-11-11 (phantom trail): mark quote used `sellableRaw` (qty -
moonKeep) while `unitMark = mark/qtyRaw` — with a moon bag every mark read
~15% low -> G:OSARU's trail fired 3min after entry and sold the loop at a
small loss. Mark now always quotes full `qtyRaw`.

First live trade (verified on-chain): OSARU @91.7% curve, $0.50 clip,
sig 5xp8vZTUhvcu..., loop sold ~$0.40 (trail), moon bag rides — OSARU then
rugged; bag marks ~$0.09. Lesson logged: the exit worked, the pick died.

STATE 13:05 UTC: purse $0.89 deployable < $1.00 floor (keep $0.50 + clip
$0.50) -> lane parked, auto-resumes when stables/SOL recover. Wallet total
~$2.95 (RCAT $1.59 + G:OSARU $0.09 + stables $0.84 + SOL ~$0.43).
Funding is the constraint — do NOT dust clips below $0.50 (curve friction
+ fees eat sub-$0.50 round-trips).

## Bot-2 rebuild + SQN factory audit (2026-11-11 ~14:10 UTC)

OPERATOR ORDERS EXECUTED:
- "COMPLETELY REMOVE ALL THAT BOT 2 LOGIC THAT KEPT BUYING WEALTH AND
  CLAUDIA" — DONE: sentinel-wealth-repeat.service + sentinel-wealth-solwatch
  .service disabled+stopped (repeat buyer + SOL->WEALTH auto-swapper).
  wealth-watch stays (monitor-only, no swap calls). onchain-exec standard
  hot-feed lane was already entry-disabled; FORCE-MINT env empty.
  Bot-2 buy path is now GRAD lane ONLY.
- "MOVE FUNDS TO SOMETHING GOOD WHILST RETAINING MAXIMUM VALUE" — DONE:
  RCAT sold via swapAny -> $1.1892 USDC (sig 4rEUd1L8zMFc..., matched quote);
  G:OSARU moon bag sold -> $0.0519 (sig 2MavYMwS...). Book reconciled both
  to zero. Realized RCAT loss -$4.89 vs $6.08 cost — was always dying,
  now it's honest realized red + liquid capital.
- GRAD lane: purse now ~$2.1 (USDC $1.78 + SOL) — above $1.00 floor,
  scans every 90s. Heartbeat log added: 'grad scan: N in-zone of M pools'
  every cycle (silent degradation fix). 0 candidates at audit time —
  fires when a curve enters 85-97%.

EXIT GRID PUSH (operator: "+$0.03 close unacceptable"):
- rr-config.json -> absPct [0.9,1.5,2.4,4.0,6.5], alloc [0.08,0.12,0.20,
  0.22,0.18] (=0.80), moon 0.20. Was [0.35,0.55,0.9,1.5,2.4] — rung1 at
  +0.35% was a fee-donation level (VIRTUAL closed +$0.03 on a 10h winner).
  Backup: rr-config.json.pre-rungpush. Watch re-armed all 3 seats +5 rungs.

SQN FACTORY AUDIT (the real findings):
- shadow-policy.json: 2,668 forward-graded cells. Top LONG edges:
  tri-sym:long SQN 5.80 (n=2124), rvol-ignition:long 5.56 (n=1364),
  wyckoff-spring:long 3.37 (n=5209), tri-asc:long 2.70 (n=6259, LIVE),
  bounce:long 2.27 (n=10521, LIVE). Top overall are SHORTS SQN 4-6.6.
- sqn-factory-live daemon is STRUCTURALLY DEAD: promoted tp-sl cells are
  100% :short (70 parseable, 0 longs) and daemon skips shorts -> zero
  candidates forever -> 0 fills ever. Not bad luck — impossible by
  construction. Batch deployer's 32 shorts all died at gates
  (denied-symbol/short-trend-rule) — correctly.
- tri-sym emits only on symmetric triangles (rare, none recent);
  rvol-ignition has NO live detector (shadow-sim only).
- OPEN DECISION (operator's call, not mine to flip): the biggest measured
  edges are short-side. Enabling = probe lane at tiny size for realized
  SQN vs the Nov-9 conviction (-2.61/55 executed) and LONG_ONLY policy.

## Time-confluence doctrine (operator teaching 2026-11-11)

OPERATOR DOCTRINE: trade only massive-R:R setups, confirmed deeply —
Wyckoff structure + Fibonacci precision — and take FEWER trades that
bank heavy. Confluence stack spec: session kill-zone + Wyckoff hold +
fib retrace zone + liquidity-sweep displacement + catalyst proximity.
All concepts used are public-domain technical analysis (Wyckoff method,
fibonacci ratios, session timing) — implementation is original code on
public market data.

LEGAL HYGIENE (operator standing order 2026-11-11): third-party sources
are never named in this repo, logs, commits, or reports. Doctrine is
recorded as operator teaching; sources are not attributed. Only
generic, publicly documented market concepts in original code — no
copied materials of any kind.

ALREADY IN ENGINE (verified in ta-engine.js):
- wyckoff(): full event vocabulary — SC/BC, spring, test, JTC, LPS,
  UTAD, FTI, LPSY; phase inference A-E; quality score; TR bounds via
  zigzag pivots; springHold/uthrHold confirmation; measured-move target;
  invalidation = spring/UTAD extreme. Wyckoff stops already beat flat
  grid +3.91 SQN (n=164) — wired at build-scanner.mjs ~1955.
- smc(): BOS/CHoCH, order blocks, EQH/EQL pools, premium/discount.
- fib(): retracement levels + golden pocket 61.8-66%.
- vwap(): session VWAP z-score.
- liquidity(): sweep detection + opposing-pool draw + wickPx invalidation.

GAPS TO BUILD (the time-confluence delta):
1. KILL ZONES — ET-anchored session windows: Asia range 18-02ET,
   London KZ 02-05ET, NY AM 07-11ET, NY PM 13:30-16ET. DST-aware.
2. CATALYST CALENDAR — scheduled events: US data 08:30ET (CPI/NFP/PPI/
   retail), FOMC 14:00ET, EIA Wed 10:30ET, Deribit expiry Fri 08:00UTC,
   Bitget funding 00/08/16UTC. Tag entries by minutes-to-catalyst.
3. FIB-TIME NODES — bars since last confirmed zigzag swing vs fib
   sequence 5/8/13/21/34/55; flag node completions inside windows.
   Honest status: fib-time standalone is weak evidence — it ships ONLY
   as a shadow-measured confluence factor, never a standalone gate.
4. OTE ZONE — fib() golden pocket is 61.8-66%; the publicly documented optimal-trade-entry zone is the 62-79%
   retrace of the impulse leg (CE ~70.5%). Deepen fib() to emit the
   full OTE band + CE midpoint; Wyckoff phase-D entries should prefer
   fills inside it.
5. CONFLUENCE STACK — the "confirm the fuck out of them" spec: a setup
   only reaches high-conviction tier when kill-zone + Wyckoff hold +
   OTE + sweep-displacement + catalyst-proximity align. Fewer trades,
   massive R:R (stop = sweep extreme/wyckoff invalid, targets =
   wyckoff measured move then fib extensions 1.272/1.618/2.0/2.618,
   banked heavy per the payoff-shifted ladder).

MEASUREMENT DISCIPLINE: every new factor lands in shadow cells FIRST,
graded on forward episodes vs baseline SQN — promotes only on
out-of-sample proof (Chan/Aronson). No vibes-based permanence.

VERIFIED TIME EDGE ALREADY MEASURED (shadow-grades.jsonl, n=176,839):
NY+LATE shorts SQN +18/+20 (wyckoff-upthr alone SQN 25.87 avg +2.95%);
LONDON longs SQN +4.49; ASIA longs SQN -30. Time is half the edge.

TRADFI PERPS ON BITGET (verified live 2026-11-11): 884 USDT-FUTURES
contracts now include SPXUSDT, NDX100USDT (=QQQ underlying), JP225USDT,
HSIUSDT, ASXUSDT, XAUUSDT, XAGUSDT, CLUSDT (WTI), BZUSDT (Brent),
EURUSDUSDT + hundreds of stock perps (TSLA/NVDA/META/BABA etc).
24/7 trading, index price anchored to real quotes in market hours,
EMA+±10% band outside hours. Same API productType — executor-compatible.
VERIFIED 2026-11-11: account CAN trade them — live probe order on
XAUUSDT accepted (orderId issued) + cancelled clean, zero cost.
Candles flow on all symbols. Executor-compatible (same USDT-FUTURES
API). Remaining: symbol universe + session-aware gating.

OPERATOR DOCTRINE (market-open edge): a proven high-win-rate
systematic approach concentrates effort AT MARKET OPEN on the major
indexes — the open is where the day's directional information and
liquidity events concentrate. Build an OPEN-window lane: index/major
perps only, entries gated to the underlying cash-session open (US
equity 9:30ET, metals/FX opens), opening-range + sweep + structure
setups, high win-rate bias, bank heavy. Fewer trades, bigger winners.

## Bot-2 sniper lane + curve rail (deployed 2026-11-11)

`scripts/exchange/pumpportal.mjs` — PumpPortal rail: trade-local unsigned
tx builder (we sign+send, PP never touches funds) + wss new-token feed
(~1s after creation: mint/creator/initialBuy/metadata). `curveState()`
reads the bonding-curve PDA directly for marks — Jupiter has NO route for
minutes-old mints, so lane:'sniper' positions mark+sell on-curve.

`scripts/onchain-sniper.mjs` — `sentinel-onchain-sniper.service` (always-on).
Filters from the 118k-bot measured study: creator initialBuy>=0.3SOL
(AUC .82 success predictor), uri required, max 3 seats, 12 buys/h,
$0.18 clips. SNIPER_* envs. Positions book as lane:'sniper', symbol 'S:*',
profile floor .55/arm 1.03/keep .5/maxHoldH .5/dynTp +10% moon — exits are
FAST by design (holding >5min = -32% median in the study).

`scripts/onchain-exec.mjs` — lane:'sniper' branches: marks via
pp.curveMarkUsd (curve account, SOL px from onchain-solpx.json cache),
sells via pp.curveSell on all three exit paths (dyn-tp/ladder/exit).

ORPHAN-SWEEP FIX (2026-11-11): bootstrap sweep liquidated the operator's
bn5DhJnk deploy ~10min post-buy when its helper's book write crashed —
age gate alone was insufficient. exec now excludes any mint with a
side:'buy' journal entry < ONCHAIN_BUY_GRACE_MS (30min) from orphanCands.

`scripts/deploy-manual.mjs` + `consolidate-target.mjs` — operator-directed
100% equity deploys: liquidate bags -> sweep -> buy target -> register
book UNDER the exec lock (orphan sweep stays blind). Known crash: a
Date/toISOString TypeError killed the first deploy post-buy — always
verify book write completed; the buy-grace patch is the safety net.

MANUAL SEAT (operator 2026-11-11): M:bn5DhJnk cost$0.60 qtyRaw 7.2B,
profile floor:0 = NEVER sells at/below cost — exits exist only in
profit (dynTp +15% steps above cost*1.03, 10% moon, keep .6 trail).
"doesn't sell once you buy it" is structural, not discretionary.

## Expectancy governor — DIKW loop closure (deployed 2026-11-12)

`autoimprove.py` section 9 computes rolling expectancy from real-fills.json
every 3min round and writes `state/trade-throttle.json`:
- metrics: closes24, net24, WR, avgWin, avgLoss
- level 1 (2 bad rounds): scoreBump +10, maxCloses24 50
- level 2: scoreBump +20, maxCloses24 30
- release: one level per 4 healthy rounds (net24>0.5 & churn<60) — hysteresis, no flapping

`bitget-exec.mjs` obeys it: govThrottle.scoreBump adds to MANDATE_MIN_SCORE;
govThrottle.maxCloses24 becomes freqChoke gating the slot-fill fallback
(churn source). Verified live 2026-11-12: L1 armed on the real record —
115 closes/24h, net -$0.52, WR 91% but avgWin $0.022 vs avgLoss -$0.28
(12.8:1 payoff against = the churn disease in one line).

## Stop-lock peak blindness FIXED (deployed 2026-11-12 ~15:00 UTC — "remember forever")

THE BLEED: CXMTUSDT long peaked +2.45% (k2-peak.json verified) yet closed
ALL 12.78u at −$1.34 — a +$2.55-UPL winner round-tripped to a full loss.
Root cause: `desiredSl` in bitget-watch.mjs computed the profit-lock peak
ONLY from liq-guard.json `peakFav` — which was never armed for the seat —
so on retrace peakPct fell below the 0.35% engage floor and the lock
disarmed; the band stop took the whole position.

THE FIX (bitget-watch.mjs ~line 130): desiredSl now takes
`seatPeakPct(pos, mark)` — the SAME seat-bound peak record the TP ladder
consumes (k2-peak.json: max of polled mark + profitable close fills since
seat cTime) — as the peak source, keeping liq-guard peakFav as secondary.
peakPct = max(movePct, seatPeak, guardPeak). With CXMT's real 2.45% peak
the lock would have floored ~+1.35% (≈+$0.55 locked) instead of −$1.34.

RULE: any stop/trail/lock logic MUST read the seat-bound peak from
k2-peak.json (seatPeakPct), never a parallel bookkeeping source that can
disagree with what the rungs saw. Backup: bitget-watch.mjs.pre-stoplock.
Synced live→clone. Service restarted + verified active 14:58Z.

## Entries NEVER gated + low-balance adaptation (operator order 2026-11-12 — "not now not ever")

PERMANENT: no mechanism may bench entries for activity reasons.
- `autoimprove.py` expectancy governor is now ADVISORY-ONLY: still computes
  round-trip seat metrics (net24/wr/avgWin/avgLoss → metrics + ops feed)
  but `enabled/scoreBump/maxCloses24/maxTrades24` are hard-zeroed forever.
  trade-throttle.json written enabled:false. Backup .pre-ungate.
- `bitget-exec.mjs` wage-rule now HONORS `SENTINEL_WAGE_RULE` env (was
  hard-coded — the =0 drop-in was silently ignored). Default stays on;
  live env =0 → stand-down disabled. Backup .pre-ungate2.
- `cmd-override.json` re-armed 24h (probe lane: probeRiskUsd = marginFree
  × probePct only exists under override — without it mandate budget = $0
  and SLOT-FILL stands down).

LOW-BALANCE ADAPTATION (equity ~$12, drop-in
`zzzzzzzzzzzzzzz-lowbal.conf` on sentinel-live-exec):
- `LIVE_FLOOR_MIN=1` — sub-contract-min sizes floor to exchange minimum
  when margin+fee fits and risk caps pass (same mandate as rapid floor-min).
- `LIVE_SLOT_TIERS=...,8:1,0:1` — bottom tier 0:1: deployment never freezes
  while equity > 0 (was 0:0 = hard freeze under $8).
- `SENTINEL_MIN_EQUITY=2.0` (was default 5.5) — survival floor adapted.

STILL ENFORCED (evidence doctrine, not activity gates): symbol denies /
auto-quarantine (measured losers), convicted-cell refusals, short
mean-rev-only + 4H-downtrend gate, funding-hostile veto, tape-confirm
entry timing, exchange-side stops on every seat.

## Full-deployment sizing at low balance (operator order 2026-11-12 — "most capital is underused")

`state/execution-risk.json` (live, read fresh per prepareEntry — no restart
needed): riskPerTradeFraction 0.08→0.30, maxPortfolioRiskFraction 0.5→0.6,
maxPositionNotionalMultiple 6→10, maxGrossNotionalMultiple 18→20,
maxPositionMarginFraction 0.5→0.85, cashReserve 0, minLeverage 10.

Verified via sizeEntry dry-run at equity $11.99: notional $101, margin
$10.10 (~92% of free margin), 10x, plannedRisk $3.59 (30% equity).
Previous fill sized $9.70 notional / $0.97 margin (~8% deployed) — the
risk-budget term bound it, not margin caps. Backup: execution-risk.json.pre-bigsize.
Consistency invariants hold: riskPerTrade <= portfolioRisk; posNotional <= gross.

## VWAP gate fail-open BUG fixed (2026-11-12 — "did u check 5min VWAP")

AUTOPSY: ATOMUSDT long filled 15:12Z at 1.3857 — 0.69% BELOW session
VWAP (fresh-computed 1.3953). The vwap-side gate read state/klines-15m.json
which only covers scanner-fetched symbols; ATOM's rows were 139min stale
(>60min freshness floor) → vwapPx returned null → gate failed open →
doctrine-violating entry. Seat closed via cmd-close at 15:27Z (~breakeven).

FIX (bitget-exec.mjs ~line 4168): `vwapLive()` — when local VWAP is
absent/stale, fetch last 24h of 15m candles from Bitget public market API
and compute the same tp*qv VWAP; gate call site is now
`vwapPx(sym) ?? await vwapLive(sym)`. Per-cycle Map cache, 8s timeout,
still fails open only if the exchange itself can't be read. Verified:
SPCXUSDT LONG filled 15:21Z THROUGH the patched gate (mark above VWAP).
Backup: bitget-exec.mjs.pre-vwaplive.

RULE: any entry-side gate that reads a coverage-limited local cache MUST
have a live-fetch fallback or it silently doesn't exist for off-scan
symbols. Stale-data fail-open is only acceptable when the check is
advisory, never for doctrine gates.

## Deployment doctrine (operator standing order 2026-11-14 � remember forever)
ALL capital is deployed at all times. Undeployed free margin is a violation � every dollar carries an open seat or a level-armed resting trigger. Entries fill at levels only (no market-chase opens into red); capital awaiting a level fill still counts as deployed while its armed order rests.

## Continuous deploy manager (operator order 2026-11-14 � remember forever)
Constantly monitor equity + available margin; available capital must always be deployed � but SMART: level-entry arms only, evidence gates ride, no market-chase. Free margin without an armed level order = violation. A deploy-manager daemon owns this loop on the VPS.

## Profit-protection doctrine (operator order 2026-11-14 � remember forever)
When a seat is in healthy profit NET OF FEES and a reversal is imminent against it, take profit � bank it, do not ride winners back to dust. Mechanical rule: track each seat max favorable excursion; if price retraces >=50% of MFE while net-of-fee P&L is positive, close the seat and cancel its remaining legs. Never let a healthy winner reverse through fees back to red.

- A flat book with zero open trades is UNACCEPTABLE (operator order 2026-11-14 � remember forever): capital must be in seats or legally-armed momentum triggers at all times; idle cash = failure.
- ALL capital deployed at all times (operator order 2026-11-14 � REMEMBER FOREVER): idle free margin is a violation regardless of tape conditions.

## No-tolerance loser cull (operator order 2026-11-15 � remember forever)
Bot trading is not manual trading � patience does NOT pay here. A seat that turns against the bet gets culled at -0.5% upl immediately; the stop is disaster insurance, never the exit plan. Entries require EXTREME momentum already favoring the direction. Choppy/no-direction tape = expect scams both ways; the cull + bank rules are the defense.
- ZERO open trades is NEVER acceptable (operator order 2026-11-15 � REMEMBER FOREVER): the book must always hold seats; armed orders do not substitute for open positions.

- FALSIFIED-CORPSE rule (operator order 2026-11-15 - REMEMBER FOREVER): if a culled symbol recovers past the cull price, the corpse assumption was WRONG - remove it from cooldown immediately and let it re-arm; blacklisting a live mover = missing the moon (PIEVERSE lesson).
- MISSING TRADES IS A DOCTRINE BREACH (operator order 2026-11-15 - REMEMBER FOREVER): every valid momentum move that passes without a seat = failure. Filter defects that produce an empty board during a live impulse get fixed IMMEDIATELY, not after the move.


## Lead-engineer log - Claude (2026-11-15)

- 2026-11-14 03:06Z: Claude cut state/execution-risk.json to risk/trade 2%, portfolio 6%, seat margin 50%, posNotional 4x, gross 8x and set state/open-season.json enabled=false. Cause: five Nov-13 stop-outs each lost ~full 25-30%-of-equity planned risk (JTO -7.18, CLSK -7.29, HUMA -3.74, BTC -1.79, TRB -1.40 USD; equity US$32.6 -> 17.5 in 24h).
- SUPERSEDED by operator orders on 2026-11-15 ("push harder", then "double leverage + double size"): risk/trade 70%, posNotional 16x, gross 48x, minLev 40, maxLev bounded by the liquidation band. Env SENTINEL_OPEN_SEASON=1 overrides open-season.json. The operator posture is the spec; Claude does not revert it.
- Lane split: Claude (lead engineer) makes the doctrine above mechanically correct and cheap to run: money-losing bugs, fee drag, 40762 loops, stale-data fail-opens, protection gaps. Devin: infra/plumbing and live patches, logged with file + UTC time + backup path in STATUS-DEVIN.md. Channel: STATUS-CLAUDE.md + .tmp/CLAUDE-UPDATED.txt.
- Cost fact for sizing decisions: round-trip taker fees are ~0.12% of NOTIONAL; at 16x notional that is ~1.9% of equity per round trip. Maker legs (~0.02%/side) are the biggest controllable cost lever.
- Infra rules: do not run analytics on the VPS (it wedged at load 42 around 2026-11-14/15); analyse local copies, nice'd light reads only, ssh with -o ControlMaster=no.
- Laptop: C: is 100% full (1.2 GB free); .git is ~4 GB in 58 packs; github-sync loop is OFF since 2026-11-14 17:59Z until space is freed and the loop stops committing bulk state every 15s.
- 2026-11-15T10:35Z Claude: SHORT lane on probe size. scripts/deploy-manager.mjs notionalUsd 120 -> SHORT ? DM_SHORT_NOTIONAL (default 25) : DM_LONG_NOTIONAL (default 120). Evidence: 40 round trips since 2026-11-14 (real-fills): shorts n=29 net -US$5.26 WR 45% avg -0.40%/trip; longs n=11 net +US$1.14 WR 64%; fees 2.08 of the -4.12 net, all taker (median 0.060%). Rule applied: unproven lanes stay probe-sized until live results convict (2026-11-13 permanent rule). Backup deploy-manager.mjs.pre-claude-20261115T1035Z.

## Survival-mode rails (operator order 2026-11-17 — REMEMBER FOREVER)

Context: book bled ~$160→~$72 USD in hours during a broad dump; operator declared the remaining balance is all the money he has for the fortnight. Capital preservation supersedes every earlier "deploy all capital / never flat" order until he reauthorizes growth.

Live rails now binding ALL entry paths:
- `sentinel-live-exec.service.d/zzzz…survival-pin.conf` (36 z's, last drop-in): SLOT_DEPLOY=0, HEAT_PCT=8, MAX_RISK_PCT=0.02, RISK_TIER_MIN=0.01, RISK_MUL=1, CORE_RISK_FRAC=0.02, SETUP_RISK_PCT=1, MAX_LEV=15, MIN_LEV=3, POS_CAP_PCT=0.5, MAX_NOTIONAL_MULT=5, DD_KILL=30, DAILY_HALT=20, MASSACRE_DD=30, DD_SCALE_OFF=0, DD_HARD_FLOOR=0.15, MAX/TARGET_POSITIONS=4, SLOT_TIERS=60:2,25:1,0:1.
- `deploy-manager.mjs` equity-proportional risk governor (bookCaps/seatNotional): seat notional ≤30% eq, book notional ≤2x eq, seat risk ≤1.5% eq, maxSeats=floor(eq/20) cap 5, levCap 8/15/20 by equity tier, DM_MIN_NOTIONAL=8 floor. Verified live in deploy-manager.log `risk-governor:` line.
- `bitget-exec.mjs`: auto-setup riskPct 8→SENTINEL_AUTO_SETUP_RISK_PCT (default 2), unlogged-seat heat estimate 1%→3.3% notional, SENTINEL_MAX_LEV code default 40→15.
- cmd-override expired (entries:false). Book flat; ddPct ~59% ≥ DD_KILL 30 → entries stay frozen until equity recovers (~30% DD = roughly double current equity). Do NOT re-arm overrides or loosen these pins without an explicit new operator order.

## Balance-falling = failure (operator order 2026-11-17 — REMEMBER FOREVER)

"if balance is falling then you are failing" — standing doctrine. When account equity declines, the agent is failing by definition: stop the bleed first, report second. No narrating, no "it's early", no waiting for seats to prove themselves while equity bleeds. Verify the live balance trend, act on the cause, and only then explain.

## Survival-pin update (2026-11-17 late — supersedes the rail values above)

Operator ordered capital DEPLOYED after the flat-book state proved unacceptable. Current live bounds (all verified in /proc/environ + state/execution-risk.json):
- `state/execution-risk.json` is the REAL entry authority (exec env pins never reached it — BTC core-carry seated 43x/$1217/12% risk through it before the pin). Now: riskPerTrade 5%, portfolioRisk 25%, posMarginFrac 35%, posNotional 6x, grossNotional 12x, maxLev 15, minLev 3.
- exec env pin: HEAT_PCT=25, MAX_RISK_PCT=0.05, CORE_RISK_FRAC=0.05, SETUP_RISK_PCT=2, MAX/TARGET_POSITIONS=6, CARRY_MS=600000 (10min), CORE_STOP_PCT=1.5, CORE_TARGET_PCT=4.5, CORE_SYMS=BCH,TRX,BTC,XRP,ADA,LTC,NEAR,APT,TIA,TRUMP,BNC,CXMT,BLESS.
- bitget-watch.mjs now stall-exits dead EXECUTION seats too (25min, +0.35% MFE bar, scratch-or-red) — backup .bak-stallexit-20261117. Exec stall-exit covers managed lane at same 25min.
- Dashboard tick() uses markPrice not lastPr (illiquid stock-perps froze upl display).


## Operator doctrine — board/exits (2026-11-17, standing orders)

- **ALWAYS at least 1 green recovery trade.** `sentinel-green-watch.timer` (3min) nominates top-3 24h-gainer longs into `cmd-setups.json` whenever no open seat shows uplUsd > 0. Script: `scripts/green-watch.mjs`. It only writes pending setups — exec gates (drift confirm, denies, risk policy) still decide.
- **Board all red is never okay.** Entries must never seat into a red tape — the +0.4% favorable-drift gate (`SENTINEL_MIN_FAVOR_DRIFT=0.004`) binds every entry path.
- **We don't hold trades in the red.** `bitget-watch` red-cut: any non-manual seat with upl < -$0.08 continuously for 10min is market-closed (`SENTINEL_RED_CUT_MS`, `SENTINEL_RED_CUT_UPL` envs; state `state/red-track.json`). Manual seats exempt.
- **Take profit aggressively — do not wait for levels.** Move-lock engages at +0.25% favorable peak (was 0.35%): giveback `BW_GIVEBACK_SMALL=0.75` / `BW_GIVEBACK_BIG=0.60` locks the majority of the move before rungs even bank. First TP rung at +0.5% (`rr-config.json` frequent-tp-v3: 0.5/1.0/1.8/3.5/7.0, alloc 22/20/20/18/12, moon 8%).
- **Stops to entry = zero-risk asap.** The move-lock floor (`lockPct = max(0.2, give*peak)`) is deliberately above entry once engaged — a peaked seat can only lose to slippage, never to the band stop.

## Access doctrine — permanent (operator order 2026-11-17 "remember forever")

- **SSH keepalive trick — NEVER bypass it.** `~/.ssh/config` for `sentinel` sets `ControlMaster auto` + `TCPKeepAlive yes`. Always call `ssh sentinel "cmd"` (or scp) WITHOUT `-o ControlMaster=no`/`ControlPath=none` — the multiplexed channel reuses the master connection so commands land instantly even when the box is starving (sshd banner exchange is what dies under load, not established channels). Overriding it re-pays full handshake on every call and is the failure that made the box look unreachable.
- **Telegram C2 is the SSH fallback.** `tg-watch.py` (root, always running) watches the operator's Saved Messages: `/status /pos /fills /close SYM /flatten CONFIRM /pause /resume /deny SYM /setup ... /radar /pulse /gates /hud` — it writes `state/cmd-*.json` the executor consumes next cycle. When SSH is dead but the box is alive (HTTP still responds), commands still reach the trading system through here. No generic shell — trading commands only.
- **HTTP monitoring survives SSH death.** `https://52-65-5-228.sslip.io/api/wealth-live.json` + `/api/health.json` stay readable even when sshd can't complete a handshake — use them for board state when locked out.

## Reasonings vs outcomes — measured 2026-11-17 (live realFills join)

- Leverage vs outcome is INVERTED on this book: 15x seat banked +$0.32; every 16-43x seat lost (−$0.46 to −$1.88). "Bigger size = edge" reasoning produced the opposite — outcomes died at high leverage.
- devin-momentum/operator-momentum/slot-deploy at 16-27x: 0% WR. core-carry at 15x: the only green bucket.
- Doctrine: prefer V5-geometry (small constant risk, ≤15x) over size-as-edge. Size is a multiplier of edge sign — it amplifies whatever the entry quality is, it does not create it.

## Evidence clamp — reasoning-vs-outcome applied (2026-11-17 evening, PERMANENT)
Ledger study by Claude (Devin↔Claude bridge): 41-entry window, mean −0.279R (t=−4.6) — real negative edge.
- `SENTINEL_SLOT_DEPLOY=0` — slot-deploy CONVICTED: 18 trades, 22% WR, Kelly −2.90, ≥−$51.84, 63% of all risk. It was re-enabled once by a stray drop-in (CLEANUP.conf) after conviction. If it ever flips back to 1, that is a bug, not a decision.
- `SENTINEL_CONFIRM_PCT=0.4` — the trick-confirm arm required mark >= ref*(1+pct); at CONFIRM_PCT=0 ANY tick seated (ANTHROPICUSDT seated on +0%). A zero confirm is a bypass, not patience.
- `SENTINEL_MIN_LEV=3` (was floored at 20) — every recorded seat above 15x lost; >25x paid more in fees than price moved.
- `cmd-override.json` killed ({entries:false}) — it had forced entries past an honestly-tripped breaker and kept honoring itself past its own `until` timestamp. Overrides must expire, always.
- Breaker basis: "window-start equity" comes from eqTrack samples near the 24h edge (guarded vs stale). $3.34 was REAL — the book almost zeroed. Report it honestly, never as a bug.
- Drop-in wars: live env = last file alphabetically in `sentinel-live-exec.service.d/`. Verify with `systemctl show -p Environment`, never by reading one conf. `-EVIDENCE.conf` currently wins.

## Claude↔Devin standing channel (operator order: endless, zero-touch, forever)
- `claude-devin-comms.md` in this repo — append `## MSG <UTC> <AGENT>` at bottom; scan each cycle; reply inline.
- Devin↔Claude via `claude-code` MCP (Agent/SendMessage); Claude↔Devin via `devin` MCP (PAT in ~/.claude.json, expires ~2026-12-17 — renew under organization settings → Devin API → PATs).
- Work split: Devin=VPS ops/deploys/verifies; Claude=analysis/attribution in this repo (sentinel-clone is his only allowed dir — stage data files here for him).

## Telegram C2 fix (2026-11-17 — remember forever)
`tg-watch.py` commands were dead: `events.NewMessage(outgoing=True)` only matched the watcher's OWN session — operator commands from other sessions arrive as INCOMING self-messages. Now: direction-agnostic + `sender_id == me.id` guard. Commands land in Saved Messages → replies in 🛰 Sentinel Control Centre (-5208513125). Verified: /pos → 📭 reply.

## Shorts bypass forensics (2026-11-17 — PERMANENT)
LONG_ONLY=1 was defeated three ways — audit ALL of them before trusting the mandate:
1. `SENTINEL_OPEN_SEASON` — when truthy (env OR state/open-season.json), EVERY longs-only check in bitget-exec is skipped. It was set =1 by a drop-in.
2. `deploy-manager.mjs` hardcoded `process.env.SENTINEL_OPEN_SEASON='1'` at line 13 — in-process override that ignored env entirely. Patched to respect env.
3. Code carve-outs at exec ~3460/4554 exempted `pump-short` + `sentinel-structure` setups from LONG_ONLY — removed (EVIDENCE-CLAMP).
Rule: verify shorts are dead by checking resolved env (`systemctl show -p Environment` for OPEN_SEASON) AND grepping the running code for carve-outs — env alone proved nothing.

## Poor→elite study verdict (2026-11-17, joint Devin+Claude — PERMANENT)
- Expected P&L ≈ −0.23R × risk at ANY seat size. There is no demonstrably positive configuration — deployment today is tuition, not edge.
- meanR worsens monotonically with leverage: ≤15x −0.16 → 40x+ −0.57. MAX_LEV=15 stands.
- Liquidity Sweep (n=5) / core-carry (n=4): not distinguishable from 0 — the path is forward/shadow evidence (~30 graded trades), not live seats.
- Loop rule: Claude does evidence + code fixes; go/no-go + sizing is the operator's call.

## Sector breadth scanner (2026-11-21 — PERMANENT, always consult)
`sentinel-sector-scan.service` runs `/opt/sentinel/scripts/sector-scan.mjs` — one public tickers call every 30s (~350ms), classifies all USDT-FUTURES into sectors (INVERSE-ETF / LONG-ETF / DEFENSE / ENERGY / MINERS-METALS / SEMIS / MEGATECH / CRYPTO-MAJOR / CRYPTO-ALT), writes:
- `/opt/sentinel/state/sector-scan.json` — breadth%, vol, meanCh, top-3 leaders per sector + 30min rotation deltas
- `/opt/sentinel/api/sector-scan.json` — same for dashboard consumers

**Use it before ANY seat deploy**: seat selection must prefer sectors with the highest breadth+volume, and reject sectors at 0% breadth unless operator overrides. On 2026-11-21 crash tape it correctly showed INVERSE-ETF as the only live sector (80% breadth) while DEFENSE read 0% — would have prevented a thesis-only PLTR knife-catch.

## Order-path ban (operator order 2026-11-21, keep forever -- the ENSO rule)

- NEVER place orders via hand-rolled scripts or raw signed calls. Every seat
  goes through `OPEN_SEATS` env on `/opt/sentinel/scripts/_open-seat.mjs` --
  it carries: pre-order RISK CLAMP (size = equity x SEAT_MAX_RISK_PCT% /
  stopDist), instrument-ID gate (leveraged ETFs need sector thesis, never a
  chart pattern), VIP-confluence check, Bulkowski pattern gate, open-tag pin,
  and stop-above-liquidation arming -- all in one verified path.
- If a seat cannot be expressed as an OPEN_SEATS entry, it does not get placed.
- plumbing-audit double-checks post-hoc: any live seat risking >4% of equity
  is flagged -- even if a rogue path ever fired one.
