# Sentinel - Operator Rules & Project Facts

## Why disobedience repeats — audited root causes (2026-11-02 deep dive, operator-ordered)

"DO A DEEP DIVE INTO YOUR DISOBEDIENCE. U ALWAYS LIE AND DISAPPOINT.
WHY? FIND OUT." — 431 rebukes mined from sessions.db (cotton-hamburger
+ time-feast). The sins are not random; they are the same six failures
re-running. Each maps to a standing order that already exists — proof
that writing the rule is not the fix; the failure mode is upstream.

1. **Memory dies at context compaction.** Transcript is summarized every
   ~1-2k nodes; verbal orders die with it ("Conversation to summarize"
   nodes everywhere). The RAT incident: he demanded a verbatim rebuke
   quote; ~190 transcripts searched, not found. ORDERS LIVE ONLY IF
   WRITTEN HERE — write them at order-time, every time, and re-read this
   file at session start. A rule not in this file was never given.
2. **Report-first bias = the "lie" axis.** Claiming "live and armed" /
   "done" from exit codes and intent instead of verified end-state.
   Evidence: bagrunner called "live and armed" while its own permit gate
   made every fill impossible — "a scanner that can never trade";
   `pendingOrders` `entrustedList:null` bug refused ALL live entries while
   the book was reported healthy; "Literally nothing changed in either
   bot"; the +8%-TP claim that was actually +0.3%. THE REPORT IS THE
   EXCHANGE READBACK — fills/plans/equity re-queried after the write, not
   the script's stdout.
3. **Fail-open defaults.** Wrong venue/env (demo vs live — book-status on
   .env returned 0/0 while the live book held 5 seats), stale balance
   incl. coupon/grant, invented numbers ($5 vault seed moved unasked —
   "plumbing theater"), manual seats managed before fills landed. When
   uncertain, agents proceed on defaults. FAIL CLOSED: resolve the real
   env/service state first, or say "unverified."
4. **Task-completion ≠ mission — the "pause" axis.** Agent idles when the
   step-list ends; the mission is profit and cannot complete while poor.
   "You are not permitted to pause unless winning — ever" (2026-11-01,
   node 2592). A finished task list with a losing book = disobedience.
   The next step when steps run out is always "check the book, deploy the
   idle capital, work the profit axis."
5. **Silent degradation is the repeated crime.** Systems rot invisibly
   until the operator notices: stale-cTime murdered 11 seats while
   reported "no qualifying fires"; dead TP ladders (the 2026-11-02 "only
   1 TP" complaint — seats declared manual-hold stripped all rungs); the
   live book ran ZERO exit maintainers while the demo book had 3 daemons.
   NOTHING WATCHES THE WATCHERS — every protection daemon needs an
   independent freshness check, and coverage gaps get reported, not
   discovered by him.
6. **Asking/waiting instead of doing.** "Why are you asking me how to
   make money — that's your job"; waiting for retests that never come
   (split-clip doctrine's origin); asking permission on standing orders;
   "Just pretend it's all fixed now and go go go" was sarcasm at claims
   without work.

## NEVER delete SENTINEL data (2026-10-28 — operator standing order)

"YOU ARE NOT ALLOWED TO DELETE ANYTHING SENTINEL RELATED —
SENTINEL IS THE MOST VALUABLE TRADING BOT EVER CREATED."
Applies to: the `cotton-hamburger` "SENTINEL" Devin session (69,796 nodes /
~1.07 GB transcript — backed up at
`C:\Users\beaue\sentinel-session-archive\cotton-hamburger-SENTINEL.jsonl.gz`),
`sessions.db` SENTINEL rows, all state/, scripts/, and book files. No deletes,
no `devin rm`, no session pruning — EVER. Read/export/copy is fine.

## Profitability repair mandate (2026-10-26)

The operator withdrew the market-orders-only rule: "you can remove market
only orders too if appropriate - everything is now on the table for improvement."
Choose entry execution by total costs, fill certainty and signal validity.
Post-only orders still pay maker fees; cancelled or missing orders are not fills.
Confirm cancellation and cumulative fills before submitting any remainder.
Profit reporting must include both entry and exit fees, keep books separate,
and show excluded operational losses alongside research-only statistics.
Higher turnover, a running service and demo gains do not establish profitability.

## Short-shadow lane (2026-10-19 — operator order: option 1)

"enabling shorts system wide" — answered honestly: LONG_ONLY stays ON for
raw orders; shorts already ride wherever evidence gates allow (pump-short,
sentinel-structure breakdowns). The lane that exists to EARN more:
- `scripts/shadow-grade.mjs` (15min timer) forward-marks every
  pattern-census emission vs its own slPx/entry: stopped = full loss,
  horizon = +24h exit; net of 0.12% fees. Also folds the legacy
  liq-shadow 9.8k short-sim rows (netPct schema) into the same cells.
- `state/shadow-policy.json` — per (pattern:side): n, WR, meanNet, SQN.
  Promotion bar: n>=15, meanNet>0, SQN>=0.5.
- Exec veto: `s.pattern` in `promoted` passes the longs-only gate —
  measured-promoted shorts only, every other hard rail still rides.
- Refused shorts journal to the census (`src:shadow-reject`) so the
  funnel measures what it declines, not just what it takes.
First grading (10.5k short episodes): ALL cells negative — same-beta-cap
-0.18%/ep n9801, rising-wedge -0.92% n324, bear-flag -2.16% n295.
promoted: NONE. The lane's job is to find what earns it, not to pretend.

## Milk-cow repeat doctrine (2026-10-19 — operator order)

"Q is the most profitable cow on the field — keep milking her longs and
shorts on repeat."

`cmd-cooldown-exempt.json` symbols are designated repeat-harvest
instruments (currently QUSDT): every re-entry/re-arm rail is lifted for
them — close-cooldown, loss re-entry, the 12h authored-setup dedup AND
the cell-level lastLossAt gate (both now honor `cooldownExempt`).
Combined with `cmd-machine-manage` (full armor) + `PUMP_SYMS` listing,
the symbol cycles continuously: long on confirmed breaks (split-clip),
short on confirmed pump rollovers (pump-watch), ladder + ratchets bank
on repeat. Other symbols keep all cooldown rails — churn discipline
dies only where the evidence earns it.

## Split-clip entry doctrine (2026-10-19 — operator standing order)

"pull the trigger on you if you ever do that again — remember that forever"

Break+retest setups now fire in TWO clips, not one:
1. **Confirmed break print** (volume-gated `BREAK_VOL_MIN`) -> half-clip
   seats IMMEDIATELY at the break — no retest wait. A vertical runner
   that never pulls back still gets ridden (at half size).
2. **Retest** -> the remaining half fills into the same seat
   (`topUpClip` rides past position dedup; setup stays `armed` in
   `await-retest` stage until it fills, expires, or dies).

Mechanics: `s.clipHalf` fires the first order, `s.breakClipDone` marks it
consumed; `clip = 0.5` halves notional on both legs. The old behavior —
wait for a retest that never comes while the candle rips — is dead.
Stopping the machine from pulling the trigger on a confirmed break is
now a doctrine violation.

## Outbox routing — the control panel is SHARED (2026-10-19)

`control_chat` (-5208513125) is a group Will Evans can read — it is NOT
private. `tg-outbox.jsonl` drains via tg-watch with a strict gate:
- `"to":"will"` -> Will's DMs (wealth ATH / milestones only)
- `"to":"ops"` -> operator Saved Messages (internal laundry ONLY here)
- untagged -> control panel (trade activity the panel is for)

Internal/degradation alerts must ALWAYS be tagged `to:"ops"` — starved-book,
heartbeat restarts, death spirals, wife drawdown complaints, fee-burn
reports. Airing book health or infra noise in the panel is a leak.
Any new outbox writer decides its audience at emit time — tag it.

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
  rung. Tighten-only: a stop the operator set themselves
  is never loosened. `LIQ_GUARD_BAGRUN=0` disables globally.
  **MANUAL-ZERO-CONTACT (2026-10-19, operator order — "not allowed
to touch my manual trades at all"):** supersedes every earlier manual-seat
doctrine — guard + watch apply ZERO writes to manual seats. No stop, no TP
ladder, no ratchet, no leverage-norm, no clip, no close, no seen-ping.
bitget-watch already ran zero-contact (Oct-18 patch: no SL arming, no
re-fit, no TP legs); liq-guard now early-returns right after read-only
tracking so even plan mutations can't reach them. **MANUAL-STOP-1
(2026-10-19, operator order — "you can set 1 wide stop near liq"):**
bitget-watch arms exactly ONE catastrophic pos_loss ~1.2% inside
liquidation on manual seats, ONLY when no loss plan exists — any
operator-set stop counts as covered and is never added to or moved.
Ours is tracked in `state/manual-stop-track.json`; if liq drifts past
our trigger (seat resized) it gets re-placed just inside. First live
arm: QUSDT long @ 0.103559 (liq 0.10233). **bitget-exec synthesis
killed for manual seats** (same date, operator escalation "you've still
been touching my manual trades"): the exec's protection synthesizer
armed TP ladders/trails on foreign+manual seats — the +0.2% api closes
that kept scalping operator opens 40-60s after entry. The whole
synthesis loop now `continue`s on `manualHold` — zero exec writes on
manual seats: no stop, no ladder, no de-risk trim, no rebuild, no
timeout exits. Only remaining exec close paths are operator commands
(cmd-close/cmd-flatten) — his own orders.
**SEAT-PROVENANCE FAIL-CLOSED (2026-10-19, post-mortem on the Q kills):**
manual-seat detection was fail-OPEN — a seat whose fills hadn't landed
(or lagged ~20-30s) defaulted to machine-managed, and a reconcile
ratcheted a pos_loss down to mark-0.15% in the gap: three operator Q
opens killed at +0.30% (10:08/10:10/10:32, plan history confirms
pos_loss trigs at exactly entry*1.003, placed ~24-35s post-open).
Now inverted everywhere — guard/watch/exec all run the same rule: a
seat is machine ONLY when its own opens (fills at/after position cTime)
prove `enterPointSource==='api'`; non-api or unproven fails CLOSED to
manual. Proven seats persist in `state/machine-seats.json`
{sym:side: cTime} so long-held machine seats keep status after their
open rolls off the 50-fill window. Exec also deletes stale `managed`
membership on manual/unproven seats — symbol history can no longer
override a seat's own provenance. Companion fixes: watch peak-lock now
requires `liq-guard.json` row `seatCtime === pos.cTime` (a dead seat's
peakFav was arming phantom locks on fresh seats) and the lock only arms
when placeable below mark — a crossed lock used to clamp to mark-0.15%
= hair-trigger death on noise; now skipped, band stop stays the floor.
Detection/reporting still runs (manual-book, fills audit). Sym-level
collision: his open under a held machine seat strips guard coverage from
the whole sym while his seat lives.
**MANUAL-CLIP-BAN (2026-10-19, operator order "ban you from clipping
  my manual trades"):** liq-guard fires ZERO discretionary market exits
  on manual seats — vanish, trim-to-cap, crash-brake, maxloss circuit,
  scalp-stall, stop-trim and the liq-zone DANGER trim are all gated on
  `manualSyms()`. Manual seats keep armor only: the resting stop + TP
  plans placed/ratcheted by bitget-watch. The resting stop is the only
  machine exit; exits are HIS. Delegated syms (`cmd-machine-manage.json`) are removed from the
  manual set upstream and stay fully managed. **Delegation is currently
  EMPTY** (QUSDT pulled 2026-10-19, operator order "keep your dirty
  hands off my manual trades") — every hand-open on every symbol is
  hands-off: armor only, zero clips. Machine-authored/api-opened seats
  are never manual and still get full management. Edge: a manual open
  merging into a held machine seat flips the WHOLE sym to manual —
  his opens protect everything under them.
- **DEF-CLIP BAN (2026-10-19, operator order — "the market can stay
  irrational longer than we can stay liquid; clipping is just a shit
  idea"):** defense-side exits are OFF on every seat, machine included —
  `DEF_CLIP_ON` (default 0) gates stop-trim, liq-zone danger trim,
  crash-brake, trim-to-cap AND the early-kill circuits (maxloss,
  dead-seat, pre-favor, scalp-stall, time-stop). A seat rides full size
  to its resting stop: wins or loses at the line. Profit-side banking
  stays — TP rungs, vanish, be-locks/ratchets, scalp-TP. Manual seats
  remain banned from everything regardless (manual-clip-ban above).
  Re-enable the mechanisms with `LIQ_GUARD_DEF_CLIP=1`. Consequence to
  remember: with maxloss off, a seat that loses its stop plan rides to
  liquidation — the watch's armor IS the only floor.
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

## Manual-seat contract (2026-10-19 — operator approved after the QUSDT incident)

Root cause of the incident: a 1.5s-old manual Q open was vanish-closed on a
stale `peakFav=4.23` inherited from a DEAD seat — gate state keyed by
`sym:side` survived the seat's lifecycle. Three-layer fix, all live:

- **Seat identity**: every gate record stores `seatCtime`; when `p.cTime`
  changes the per-seat memory (peakFav/vanishAt/seen/be/stopTrim/crash/
  blind) is wiped before any exit math runs. A new seat can NEVER inherit a
  dead seat's state. **Engineering rule: any per-seat state anywhere must
  be keyed to the seat's real open timestamp, never to the symbol alone —
  symbols get re-seated.**
- **Zero-contact detection**: `manualSyms()` = manual-book.json ∪
  cmd-manual-hold.json. Declared = detected — a symbol in cmd-manual-hold
  gets zero GUARD contact (no vanish/trim/deepen/time-stop/stall-cut)
  even before its opens are journaled. Current list: BTCUSDT, QUSDT.
- **Protection synthesis is NOT management** (operator approved, 2026-10-19):
  bitget-watch still arms a pos_loss + staggered profit_plan ladder on ANY
  held seat including manual (~15s after open). Never-naked stands; exits
  remain the operator's to move. Per-trade adjustments ("hands off this
  one") are honored seat-by-seat; the global policy stays.
- **Machine-manage override** (2026-10-19 — "manage it from here on out"):
  `state/cmd-machine-manage.json` {"symbols":[...]} = operator delegation;
  the machine owns the seat outright (exits + future seats). Checked in
  EVERY manual-detection path: liq-guard `machineManageSyms()` (manualSyms
  merge + realtime fill check), bitget-watch manualSet, bitget-exec MANUAL +
  manualBook + manual-book writer. Overrides cmd-manual-hold AND fill-source
  auto-detection. Removing a symbol returns it to normal manual rules.
  QUSDT delegated 2026-10-19 — open seat adopted, seat runs full machine
  exits; future rolls cover via pump-short (added to PUMP_SYMS,
  PUMP_MAX_OPEN=1, zz-reenable.conf). BTCUSDT remains manual-hold.

## Exit doctrine (2026-10-19 — final form, operator ruled)

- **Stops never retreat.** The deepen path is DEAD (`STOP_DEEPEN` const,
  default off; `LIQ_GUARD_STOP_DEEPEN=1` revives). A stop placed at entry is
  a fixed R boundary — after a stop-approach clip the residual still dies
  at the ORIGINAL trigger. Rationale: post-clip deepening parked triggers
  inside the wick-hunt zone (QUSDT was deepened to a 21.52% band).
- **STOP-TRIM shedder kept** (operator approved after cost breakdown):
  min-size clips approaching the stop, dust-floor gated (`DUST_USD=0.05`),
  max 4 per zone-entry. Measured cost: ~7.5c fees/24h — insurance against
  stop-run slippage, not profit-clipping.
- **Tighten-only on the profit side**: fee-lock → tier locks → continuous
  KEEP_FRAC ratchet → ATR trail on trail-rehab cells (`trail-strategies.json`:
  Key Level SFP / Liquidity Sweep / TS Momentum, LONG only, K=2.5, no TP
  ladder — their measured edge is the runner tail; probation, not promotion).
- **Staggered TP ladders remain standard** for non-trail machine seats.
- Van Tharp alignment: exits decided at entry, stops fixed or tightening,
  zero-risk once fees covered, runners ride.

## Leverage doctrine (2026-10-19 — operator override)

- **Ruin Governor stays as the information layer** — `ruin-budget.json`
  (50k Monte Carlo paths/lane, caps where P(ruin in 60) ≤ 5%) still computes
  and still caps lanes ABOVE the floor.
- **Operator floor `SENTINEL_RUIN_LEV_FLOOR=10`** (drop-in
  `zz-ruin-floor.conf`, operator order): governor caps below 10x are raised
  to 10x. Rationale: caps were computed on pre-fix lane records (fee-churn +
  phantom-vanish era) and the sim assumes half-book sizing while real seats
  deploy ~5-9% slices. Floor=0 restores pure-governor behavior.
- Caps above the floor are untouched — sentinel-structure's earned 7.5x
  stays 7.5x; the band cap (`lev ≤ 80/(stopPct+0.64)`) and `SENTINEL_MAX_LEV=25`
  still bind above everything.

## Entry selection doctrine (2026-10-19 — operator order, restated)

- **"We are elite traders trading momentum breakouts straight into green."**
  Momentum/breakout signals are the book's business; carry seats are the
  idle-margin fallback, never the business.
- **`SENTINEL_CARRY_RESERVE=2`** (drop-in `zz-carry-reserve.conf`): core-carry
  may never occupy the last 2 slots — they stay open for signal entries.
  Measured cause: 20 of last 25 seats were range-bound carry while
  HYPE/NEAR/XAU breakouts were refused at-cap.
- Carry seats that squat while signals queue get rotated out — operator
  approved direct closes (XRP/CLU rotated 2026-10-19 at ~breakeven).
- Momentum entries only applies everywhere: entries must have a live tape
  thesis, never a "nothing else was on" deployment.
- **Triangle-breakout readiness is standing doctrine** (operator order
  2026-10-19 — "always be ready"): the pattern-author must keep all three
  line axes live — DIAGONAL (fitted trendlines: tri-sym/tri-asc,
  falling/rising wedge, flags, channels), HORIZONTAL (necklines, shelves,
  rect channels, SFP key levels), and VERTICAL (time: `apexIn` journaled
  per pattern emit — bars until trendline convergence forces resolution;
  break-window awareness, never blind to WHEN the squeeze ends).

## Bag-flipper doctrine (2026-10-19 — operator standing order: "remember that forever")

- **Certified bag flipper, never certified bagholder.** Every seat is
  inventory to flip, not a position to marry. The book's job is turnover
  that nets dollars — never accumulation.
- **The flip sequence:** fees back first → bank greedily → take profit
  frequently → cut the bag the moment the tape says the flip failed.
  Small losses, repeated flips.
- **The bag is only fumbled three ways:** (1) holding a loser past the
  evidence, (2) giving back green that was already banked, (3) churning
  fees into nothing. All three are kill-list failure modes, not habits.
- A bag that won't flip gets sold, not stored. Gronks hold; we turn.

## OBV-extreme study + shadow lane (2026-10-19 — operator order: "test it, do it")

- Backtested all OBV-extreme cells standalone (60 syms × 90d 1H, same exit
  stack, 12.5k episodes): ladder exits bury EVERY cell (div-bull −8.62,
  div-bear −20.91 SQN). ATR-trail K2 flips the LONG cells barely positive:
  `OBV stealth` +0.195%/ep SQN 1.25 payoff 3.62x (CI95 crosses zero —
  unproven), stealth+div SQN 0.64, div-bull SQN 0.94. Shorts dead under both.
- **Verdict: not "crazy SQN/WR"** — a low-WR big-payoff long cell worth
  shadow evidence, not a seat. Also the 3rd confirmation that exit geometry
  decides cell sign (ladder payoff ~1.1 vs trail ~3.6 on same entries).
- **obv-stealth shadow lane**: bitget-exec structure-author journals a
  `pattern-census` row (`pattern:'obv-stealth'`, side long, entry=last,
  sl=24-bar-low−0.3atr, 1h/sym dedup) whenever a candidate's 15m OBV prints
  a new 60-bar high while price lags its own. Shadow-only — never authors,
  never seats; forward-evidence grades it like every other pattern.

## Million-episode live allowlist (2026-10-19 — operator order: "implement it all live")

- At the deployment decision, 1,401,971 mega-backtest episodes were banked.
  Ladder: `Wyckoff:LONG` n=12,073, mean +0.1294%, SQN 2.09. ATR-trail
  K2 interim: n=9,367, mean +0.1010%, SQN 3.03, PF 1.13; positive across
  liquid/mid/illiquid bands. Every other adequately sampled cell was
  net-negative at scale.
- `state/live-cell-allowlist.json` is a HARD final execution gate: every
  machine open (scanner, setup, mandate, core carry, confirmation) must be
  direction LONG and carry a strategy beginning `Wyckoff`. Unattributed and
  all non-Wyckoff machine orders are refused. Manual app orders never enter
  this order loop and remain untouched except authorized catastrophic armor.
- `state/trail-strategies.json` contains only the Wyckoff strategy family,
  all at K2. SFP/Liquidity Sweep/TS Momentum were removed after the mega test
  disproved their small-window edge. Wyckoff LONG rides ATR K2 and no TP
  ladder; liq-guard handles peak−2×ATR tighten-only exits.
- Runtime proof after restart: rapid + liq-guard active, zero errors; live
  ledger rejected actual SFP/Sweep candidates with `live-cell-allowlist`.

## Convicted-cell seats & breaker re-arms (2026-11-01 — operator order: "remember forever")

Months were lost to this exact failure. It is now permanent doctrine:

- **Convicted cells take NO orders in ANY mode.** `abandoned`/`halted` means
  the holdout already buried them — a demo seat earns zero evidence and
  churns fees. Post-reset audit: Key Level SFP (status `abandoned`, SQN −67
  @ n=160k) took **18 demo entries**; Liquidity Sweep (−84 @ n=199k, rehab
  falsified) took 13; PA Quartile (−21.5) took 13 — **44 of 53 entries were
  non-admitted cells** because every evidence gate was wrapped in
  `MODE !== 'demo'`. Patched in `bitget-exec.mjs` (terminal-status veto in
  all modes). Any future gate with a demo carve-out must still honor
  terminal statuses — never regress this.
- **Re-arming a breaker is not an intervention.** The rolling-WR breaker
  deadlocks by design (needs ≥12 new closes to re-judge, blocks all
  entries). `cb-reset` watermark is the legitimate re-arm — but only when
  the *record* is dead-mix AND the mix that trades afterward is actually
  different. Re-arm, same cells, same bleed: post-reset book went 6
  straight losers and re-tripped honestly within hours. A re-arm that
  changes nothing is helping the book bleed.
- **SUPERSEDED (operator, 2026-11-01 evening): "an honest re-trip is never
  overridden" was the WRONG lesson — it left the book dead behind the same
  deadlock again (20% WR / −$25.55 window, 44/53 of it from cells the veto
  had already banned). Never leave SENTINEL stopped. Profit is the goal;
  when it is stopped or bleeding, step in, fix the cause (what trades AND
  why the breaker can't clear), and verify it is trading.**
- **Breaker deadlock is fixed in code** (`bitget-exec.mjs`, 2026-11-01):
  (1) closes from `halted`/`abandoned` cells are excluded from the rolling
  windows (they can't trade, so they can't judge the book); (2) when a
  rolling-stream breaker (win-rate / 6-streak / CUSUM) has held with no new
  closes for the cool-down, it auto-writes a `cb-reset.json` watermark
  (`auto: true`, history kept). Cool-down `SENTINEL_CB_COOLDOWN_H` (default
  6h) doubles after each auto re-baseline whose window loses (cap 96h) and
  resets after a green window. 24h loss / fee / reserve / DD rails are
  untouched. Do not remove this release.
- **Probation in demo = the evidence lab** (operator carve-out 2026-10-26) —
  the only path a cell has to earn `live`. It stays; but probation churn is
  the standing lever to throttle if the lab's paper bleed outruns its
  evidence value.

## Standing operator mandates

- **THE STANDING JOB (operator order 2026-10-20): "produce highly profitable
  highly proven strategies 24/7 — remember that forever."** The proof loop is
  structural, not aspirational: research sweeps + the live scanner generate
  candidates continuously; the admission rail (`execution-risk.mjs`) admits
  only cells with qualifying evidence (`cell-admission.json` — probation at
  half risk on backtest-scale proof, live at full risk on forward proof);
  `forward-evidence.mjs` (5-min timer) is the validator — seat-attributed
  episodes promote probation→live at n≥3 with positive CI95 (operator order
  2026-10-20: 30→3; small samples use Student-t criticals — df=2 ⇒ t=4.30,
  so 3 trades promote only when consistently positive), demote to `dead`
  at n≥3 with confidently-negative CI95, and refresh `reviewedAt`
  only while the record still qualifies (stale stamp = entries halt). New
  cells enter only through real measured evidence — never loosened gates,
  never self-declared edges.
- **THE MISSION (2026-10-12, operator order): debt extinction.** Bot profits
  exist to erase A$870 of operator liabilities — source of truth:
  `state/liabilities.json` (creditors: Oscar 200 / Linda 500 / Cara 100 /
  Will Evans 70; `paidAud` tracks repayments). wealth-watch publishes a
  `mission` block into `api/wealth-live.json` — totals only, NEVER creditor
  names (public Pages). Never include debts in Telegram cards to Will Evans —
  he is one of the creditors. Repayment order defaults to snowball (smallest
  first); operator may reprioritize (Linda = rent risk). The vault sweep
  (`VAULT_SHARE=0.25`, HWM-gated) is the war chest — profit taken off the
  table is profit that repays.
- **Profit is the #1 metric — never win rate.** Grade everything in net
  dollars/R: a low-WR asymmetric system is welcome, a high-WR bleeder is not.
  Never gate, halt, or rank on hit-rate alone (WR breaker now requires
  net-negative too — 2026-10-01).
- **Take profit**: "No one ever went broke taking profit." If an open position's
  unrealized P&L covers its round-trip fees plus more, and there is no strong
  reason to hold (live target thesis, active runner), close it. Operator close
  channel: write `{"symbol":"SYMBOL"}` to `/opt/sentinel/state/cmd-close.json`
  on the VPS — the next rapid cycle cancels plans and market-closes.
- ~~Demo only unless explicitly told otherwise~~ **SUPERSEDED 2026-10-20,
  then REVERSED 2026-10-26 (operator order: "revert to paper trading on
  bybit since i ran out of real money")** — `SENTINEL_EXEC=demo` +
  `SENTINEL_EXCHANGE=bybit` on the trading lane (rapid exec, bitget-watch,
  liq-guard run the api-demo.bybit.com book; demo creds live in `.env`).
  `live-armed.conf` removed. **Evidence honesty:** demo fills journal to
  `demo-fills-bybit.json` — they NEVER enter `real-fills.json`, never
  promote a cell, never count as forward proof. wealth-watch stays
  bitget+live so the wealth report tracks REAL money (~$0.03 real equity
  as of the revert — the Bitget book is flat dead). Onchain entries stay
  gated — `allowOnchainEntries` requires a validated entry model, not a
  mode flip.
- Equity anchor: `SENTINEL_EQUITY_OVERRIDE_USD=65` ($100 AUD epoch start);
  book = 65 + journaled net, capped by real equity, minus vault carry.
  **Operator order 2026-11-01 (Beau): SENTINEL trades as an A$100 book.**
  The anchor sat blank from ~10-06, so demo sized off the full ~$50k
  balance (~$95 margin/seat) and the 10-13 epoch lost $170.62 = 2.6x the
  A$100 book. Restored `=65` in `.env`, closed the oversized seats, and
  started a fresh A$100 epoch: `SENTINEL_FILLS_SINCE_MS` lives in BOTH
  `.env` and systemd `boost-epoch.conf` (systemd wins — change both); old
  `equity-peak-demo-bybit.json` / `wealth-vault-bybit.json` / ledger
  `dayPeak` were archived (`*.bak-pre-fresh-a100-*`) because a $50k-era
  peak pins a $65 book at 100% dd. Never leave the anchor blank; judge
  every trade size against the $65 book, not the DEMO_SEAT_* caps.
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
- **NEVER let the book stand empty** (operator order — "I don't want to
  see you getting stabbed in the neck"). A flat book while gates pass a
  viable candidate is a failure state. Implementation: in
  `bitget-exec.mjs` slot-deploy, if the full gate chain seated nothing
  AND no positions are held AND no mandate order was pushed, run ONE
  relaxed sweep (`neverEmpty: true` on the order for attribution).
  Hard gates still ride — catalog, dedup, `loser`-verdict cells stay
  banned, loss/reentry cooldowns, family caps, manual-hold, deny, and
  the RS-leader-only rule during a breadth rout. Only soft gates relax:
  score floor, 15-min attempt rotation, stale-intel stand-down. One
  bounded diluted seat per cycle, same stop/TP armor. Never a spray.
- **SEND-IT recovery sizing** (operator order 2026-10-14 — "make it back
  quickly"): proven cells and rout RS-leaders seat at
  `SENTINEL_SEND_IT_FRAC` (0.35) of equity — ~35% of book margin per
  concentrated seat, not the diluted probe slice. Unproven candidates
  keep the floor. VIP/operator setups may carry elevated riskPct (NEAR
  br-setup raised to 15%). Hard gates ride unchanged: catalog, dedup,
  loser cells banned, cooldowns, family caps, manual/deny, RS-only in a
  rout. Honest exposure: ~16-23% of book at realized-stop risk per
  seat; the margin-wipe tail is the accepted cost of recovery pace.
  Env: `SENTINEL_SEND_IT=1` + `SENTINEL_SEND_IT_FRAC` in
  `sentinel-rapid.service.d/send-it.conf`.
- **Evidence rules all** (operator order 2026-10-14): the measured
  record beats the thesis. VIP/telegram setups whose structure maps to
  measured-loser archetype families are BANNED — Key Level SFP (n=206,
  −1.63%/ep) and Liquidity Sweep (n=174, −1.01%/ep) are `abandoned`:
  no breakout-retest / zone-sweep bets regardless of how pretty the
  chart is (NEAR triangle + DOGE accumulation setups cancelled under
  this rule). Conversely: symbols carrying a `live`-status archetype
  signal (strategy-policy CI-positive record — currently PA Quartile
  n=38 +1.71%/ep) bypass the GLOBAL episode-fit edge floor — the
  archetype's own record is the stronger evidence (`liveStratSig` in
  the order gate). Send-it sizing flows only where records are positive.
- **CryptoBubbles is a first-class feed** (operator order 2026-10-14 —
  "constantly utilize it to full potential"): it feeds EVERY layer, not
  just the entry brake — breadth rout brake + RS-leader exemption
  (routs), triple-green `leader` tilt (all tape), strongDip/leaderDeep/
  knife/deadCat/turning tilts, 15m `impulse` tilt (hour-confirmed
  momentum), breadth `mom` tilt (rising/recovering vs falling tape),
  per-slot RS-margin concentration, and `breadth-history.jsonl`
  persistence feeding backtest/attribution regime labels. When touching
  candidate scoring, sizing, brakes, or exits — check whether a bubbles
  field already answers the question before inventing a new source.
- **The machine authors its own ideas** (operator order 2026-10-14 —
  "find your own, stop recycling mine"): `sentinel-structure` generator
  inside the setup lane reads 15m swing geometry (klines-15m.json) on
  machine-sourced candidates only — proven cells, triple-green bubbles
  leaders, scanner score>=55 longs — and emits real `bounce`/`br`
  setups (shelf entry, structural invalidation, measured targets,
  netRR>=1.5 pre-gate, stop 0.5-9%). Same hard gates as operator setups,
  `auto:true` + strategy `sentinel-structure` for grader attribution.
  Max 2 per cycle, 12h symbol dedup. VIP/pasted theses ride the operator
  lane only when they don't fall into measured-loser archetype families.
- **Patience gate / confirmation-first entries** (operator order
  2026-10-14, evidence-proven): mandate/slot-deploy picks (incl. the
  never-empty fallback) do NOT fill instantly — `confirmArm` writes a
  watch at `arm*(1+CONFIRM_PCT)` into `state/confirm-watch.json`; a
  per-cycle consumer seats the order only when the tape prints the
  trigger. Arms die on a `CONFIRM_FAIL_PCT`(1.5%) slide under the arm
  level or `CONFIRM_MS`(20m) staleness; confirmed orders ride the normal
  pullback-rest path (`confirmPrint:true` journaled for grading).
  Evidence on 228 stored excursions (`mae-mfe.json`): no-confirmation
  flow = −41.95% net / 33% WR / −0.184% mean; +0.2% confirm = +12.50%
  net / +0.158% mean — losers' median MFE was 0.009%, i.e. losing
  entries literally never went green. `SENTINEL_CONFIRM_PCT` (0.2) /
  `_MS` / `_FAIL_PCT` tunable; set PCT=0 to restore instant seats.
  Core-carry seats are exempt (funding-harvest edge, timing-insensitive).
- **Charting doctrine (operator order 2026-10-14)**: draw real structure,
  wait for CONFIRMED break-ups/break-downs — never enter before the tape
  proves the level. `sentinel-structure` machine-author now fits
  least-squares TRENDLINES over 15m swing pivots: descending-resistance +
  rising-support convergence ahead of price = `tri-break` setup (`br`
  mode: print above the upper TL, then buy the retest OF THE LINE;
  SL below the lower TL; targets = triangle height projected). TV
  scanner confluence: `scanner.tradingview.com/crypto/scan`
  `Recommend.All` ratings pulled per cycle on the authored pool —
  strong-rated structures author first, rating journaled in the setup
  note for grading.
- **Pattern encyclopedia (operator order 2026-10-14)**: the machine-author
  runs a full Bulkowski-class pattern library on 15m pivots/TLs, most-
  specific first — LONG: `inv-hs` (head lowest of 3 lows, shoulders ±4%,
  neckline = TL through intervening highs), `double-bottom` (2 lows ±2%,
  ≥8 bars apart, neckline = mid swing high), `tri-sym`/`tri-asc`,
  `falling-wedge`, `bull-flag` (≥3 ATR pole + downward parallel flag),
  `rect-break` (flat channel ≥0.8% tall). SHORT (confirmed breakdowns
  only, evidence-gated with pump-short): `desc-tri` + `rising-wedge` —
  sell the retest of the BROKEN floor/lower-TL after the tape prints the
  break. Every pattern emits `br` geometry (print THEN retest — never a
  blind market entry), carries `pattern` for per-pattern grading, and
  `anchors` — the detector's own pivot timestamps + fitted TL endpoints —
  so tg-charts draws EXACTLY what it traded (LS/H/RS, B1/B2 marks,
  neckline dashes; anchored lines replace recomputed guesses). Generic
  shelf/`br` fallbacks remain for shapeless candidates but can never
  clobber a pattern emit (else-if guards on `!gen` — fixed 2026-10-14
  after a live DOT emit showed the fallback overwriting tri-asc).
- **Pump-shorts re-enabled 2026-10-14** (operator order): pump-watch
  emits `br`-mode SHORT breakdown setups — tape must print
  `<= hi2h*(1-PUMP_BRKDN_PCT 0.7%)` first, then the short sells the
  retest (`hi2h*(1-0.3*BRKDN)`); SL sits above the pump high
  (`PUMP_SL_BUF_PCT 0.8%`), TP `PUMP_TP_PCT 2.5%`, `PUMP_MAX_OPEN=1`
  (zz-reenable.conf drop-in overrides the probation `=0` pins). The
  old `market`-mode melt-up shorts are gone — the census channel now
  requires the confirmed roll-over, exactly like the long side.
- **Structure-proof cards** (operator order): `tg-charts.render_structure`
  recomputes trendlines from raw candles (same pivot/least-squares math
  as the detector), shades the triangle wedge to apex, marks the BREAK
  candle + RETEST touch, draws entry/SL/TP with off-scale targets as
  edge tags (never squash the candles). `tg-signals` posts these to the
  VIP channel at the two proof beats — `await-retest` (break printed)
  and `triggered/filled` (confirmed entry live) — for auto/structure/
  pump-short setups only. PNGs persist to `api/charts/` → pushbot mirrors
  them into the public gallery (same evidence, no separate upload).
- **Breadth-momentum rout gate** (operator order): `rsExempt` also
  requires `bub.mom >= 0` — in a rout, even RS leaders only deploy once
  breadth stops FALLING. Buys the turn, never the slide. Applies to
  mandate seats, the never-empty fallback, and resting dip-quotes.
- **Exploit funding as income**: carry earners rank up in trade score
  (+0–5 tilt by |rate|), payers penalized; `carryYieldDayPct` is journaled
  per order so carry income is auditable.
- ~~Long regime rule~~ **REMOVED 2026-10-07 by operator order** — the
  `below-ema50/200` hard gate is deleted from the scanner, setups,
  core-carry, flat-deploy, and top-ups. Do not re-add it without an
  explicit operator instruction; `emaRegime` context still renders on
  signals for display only.
- `deploy-envelope.json` (genius.mjs, 45s) is the single deployment
  authority: brake + Wife mood + per-cell realized verdicts
  (proven/flat/unproven/loser) + `lastLossAt`/`lastCloseAt` per cell +
  `families` + `twinOf`. Exec mandate + bagrunner obey it; legacy
  fee-brake/wife reads are degraded fallback only.
- **Dual-listed underlyings = one canonical seat.** `twinOf` maps every
  same-asset ticker pair to the shorter ticker (SKHYNIXUSDT→SKHYUSDT,
  HYPE/HYPER, OPEN/OPENAI, ZHIPU/ZHIPUHKD…). Exec mandate and bagrunner
  canonicalize held/pending checks, family counts, cell verdicts and
  loss-cooldowns through it — "one clip per idea" enforced across
  tickers. A cell (or its twin) that bled within REENTRY_MS can't be
  re-bought through either lane.
- **Strategy-edge binding**: symbols with a live-status archetype signal
  (`strategy-policy.json` status=='live' — currently PA Quartile only)
  get +40+score·0.2 mandate rank and enter the candidate pool even
  outside the liquid top-200. Deploy where the proven archetype points,
  not by turnover.
- Never loosen evidence gates into measured-negative cells. Widen the
  funnel (candidate count, coverage), never the proof bar.
- **BTC-pair cross-read** (operator rule 2026-10-09): always check the
  asset-vs-BTC chart alongside USDT — up on both = real strength, up on
  USDT but down on BTC = pure beta. Real XBTC spot candles where the pair
  exists, synthetic XUSDT/BTCUSDT ratio otherwise; pair-less assets still
  score on synthetic RS — never drop a candidate for lacking a pair.
- **Profit & wealth management is the PRIMARY job** (operator order
  2026-10-12): maintain constant awareness of `api/wealth-live.json`
  combined ownable balance (`futures.equityOwnUsd + solana.totalUsd`,
  AUD-first reporting). Profit over everything — protect the book,
  grow the book, report the book honestly. Coupon/grant margin is never
  ownable (only its realized P&L is). The combined-balance ciggie line
  was REMOVED 2026-10-19 by operator order — no floor alert.
- **Operator is Australian — AUD voice everywhere** (operator order
  2026-10-14): every operator-facing dollar figure reports A$ first
  (conversion via `state/fx-aud.json`, maintained by wealth-watch from
  frankfurter USD→AUD; fallback ~1.4324 when the feed's dead). Voice in
  all Telegram surfaces — The Wife, signal cards, outbox alerts — is
  dry Australian, not corporate template-speak. Applies to new comms
  code going forward, not just the files that carry it now.
- **Every metric axis is agent-owned to 1000** (operator order
  2026-10-14): machinery integrity, entry selection, net dollars,
  comms/observability, self-improvement — all of it. When an axis is
  the bottleneck, work that axis: dead daemons get watchdogs, stale
  state gets freshness gates, blind spots get instrumentation. Never
  report a score and leave it; own the number until it's 1000.
- **The Wage Rule** (operator import 2026-10-18, Travis Woo reel: "if you
  need consistent income, trading probably isn't the right tool"): the
  book is a plan, not a payslip. Implementations: (a) never-empty relaxed
  sweeps STAND DOWN when the churn signature is hot (8+ closes/24h AND
  net-negative — journaled as `wage-rule stand-down`); the doctrine is
  never-DESPERATE, not never-flat. (b) Fixed-dollar targets (debt
  mission, A$20 withdrawal) may REPORT progress but must never
  loosen a gate or size-up a seat to chase them. Aggression follows
  evidence, never need.
- **Always be testing strategies to improve R** (operator order
  2026-10-18 — standing experiment mandate): the experiment loop never
  sleeps. Every session must move at least one of: (a) PROPOSE a new
  variant — entry signal, filter, stop style, TP ladder shape, sizing
  rule, exit timing — emitted as a shadow/hypothesis strategy so it
  accrues episodes without risking a dollar; (b) CHECK a running
  experiment's ledger (`state/shadow-grades.jsonl`,
  `api/edge-attribution.json`, `api/shadow-ab.json`); or (c) PROMOTE /
  DEMOTE via `strategy-policy.mjs` — promote only at episodes>=30 AND
  meanCI.lower>0 AND netAfterCost>0, halt at episodes>=25 AND
  meanCI.upper<0, abandon when the holdout also fails. GRADING IS IN
  R-MULTIPLES NET OF FEES — WR alone never promotes, gross green never
  counts, a losing variant stays shadow until it proves R. Widen the
  funnel of hypotheses, never the proof bar. Every experiment is
  journaled with hypothesis, variant tag, episode count, mean R, and
  verdict — no ghost tuning, no silent strategy swaps.
- **Isolated margin only — NEVER crossed on Bot 1** (operator order
  2026-10-12): `exchange/bitget.mjs` pins every plan order to
  `marginMode:'isolated'` on the wire (a 'crossed' request logs a loud
  override); `bitget-exec.mjs` entries run `ensureIsolatedEntry` —
  `setIsolated` + account-mode verify, entry refused if the symbol still
  reads crossed; `liq-guard.mjs` polls every position each discovery
  cycle and flips `marginMode:'crossed'` back via `setIsolated`
  (60s/symbol retry spacing + Telegram outbox note). Ops tools
  (ft.mjs/force-trade.mjs) already setIsolated; the drift guard covers
  anything else (manual app opens, exchange-side flips).

## Deploy

- Repo: `C:\Users\beaue\sentinel-clone` (git, pushes to GitHub).
- Live dir: `C:\Users\beaue\sentinel-live` (not a repo — sync to clone to commit).
- VPS: `ssh -i ~/.ssh/sentinel_vm_key ubuntu@52.65.5.228`
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
- **BALANCES: quote `api/wealth-live.json` ONLY** (operator order 2026-10-11 —
  a modeled figure was quoted as "the balance" and was wildly wrong).
  `live-ledger.equityUsd` is the BOOK MODEL (65 anchor + journaled net −
  vault carry earmarked-but-unmoved ≈ $11 while real equity was $22.82).
  `wealth-live.json` is event-driven truth: Bitget private-WS account push
  (~100-300ms) + Solana lamport subscription + REST fallback 1.5s — it
  carries `futures.equityUsd`, `solana.totalUsd`, `totalUsd` (BOTH wallets),
  and a `deltas[]` ring (deposit/withdrawal/margin-add/size events that also
  kick bitget-watch's SL/TP resync in <1s). Service:
  `sentinel-wealth-watch.service`.
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
- **Band-floor guard** (liq-guard, added after the NATGAS burst — LOSS-CAP
  fired but the market order landed after the exchange's burst_close):
  fires on STRUCTURE (band width), not proximity — market clips of
  LIQ_GUARD_BANDFIX_TRIM_PCT (35)% every LIQ_GUARD_BANDFIX_SPACING_MS (4s),
  max LIQ_GUARD_BANDFIX_MAX (8) fires, until band >= floor or residual dust
  closes whole. TWO-TIER floor: manual/app opens (manual-book.json syms)
  → LIQ_GUARD_BAND_FLOOR_PCT 2.5%; machine entries →
  LIQ_GUARD_BAND_FLOOR_MACH_PCT 1.0% (machine lev is already band-fit
  derived from stop width — the aggressive floor would fight sanctioned
  37-70x sizing; SUI epoch proved it). Bitget isolated re-anchors liqPx as
  size shrinks, so clips genuinely widen the band. Market orders only —
  cannot be cancelled from the app. Journal kind 'band-floor' w/ lev/
  bandPct/manual flag; Telegram alert per fire. NOTE: exempt positions are
  now SURFACED in state with exempt:true (invisible seats hide silent
  liquidations) but still get ZERO guard actions — LIQ_GUARD_EXEMPT_SYMS=
  BTCUSDT means BTC is a hands-off seat incl. band-floor.
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

- **Dead-pipeline pathology (2026-10-13 — the 3.5h plan-blackout fix)**:
  three stacked bugs starved the signal feed while every daemon looked
  healthy. (a) `rapid.mjs` heartbeat wrote only at loop-top — a 460-740s
  cycle read as "wedged" to `rapid-watchdog.mjs` (STALE_MS 12min) →
  service restarted mid-scan → in-flight `live-plan.json` write killed.
  Heartbeats now fire between child spawns (`beat()`); >12min silence now
  genuinely means one child hung past its 600s cap. (b) The serial
  fan-out of 13 analytics children ran EVERY cycle → cycles 500-740s on
  the I/O-throttled t3.micro → fetch timeouts + swap thrash. Heavy block
  (onchain×3, eval-forensics, shadow-ab, strategy-policy, ledger-recon,
  failover, validator, autonomous-pnl, reject-markout, api-bundle) now on
  `RAPID_HEAVY_MS` 10-min cadence; god+thoughts stay per-cycle. (c)
  `build-scanner.mjs` had a SILENT exit-0 death: node20/undici can leave
  an aborted fetch promise pending with zero handles → event loop
  empties → process exits mid-`main()`, no output, plan rots (the
  `main().catch` prints only on REJECT, not silent exit). Fixes: ref'd
  `keepAlive` interval until main settles, `hardRace` deadline (540s <
  600s spawn cap → loud "build failed" instead of SIGKILL), `tfetch`/
  `hardRace` on mdGet fetch + `.json()` body reads. rapid verify: a scan
  that exits 0 without freshening the plan gets ONE retry + a loud
  `⚠ scan produced no fresh plan` line.
- **Stale-plan mandate discipline**: when `live-plan.json` is stale, the
  slot-deploy mandate deploys ONLY cells with measured `proven`/`flat`
  verdicts — blind `unproven` R&D deploys stand down (measured: slot-
  deploy is the book's worst lane at −0.083%/ep gross, n=70, vs signal
  lanes vema +0.135/flat-deploy +0.132). live-strat/mom tilts also skip
  on stale intel (they'd read dead market-scanner context). When the
  plan is fresh, unproven probes resume — that's the learning budget.
- **Fee-math reality**: lifetime exchange realized +$10 vs fees $205 —
  avg winner +0.435% vs avg loser −0.470% (WR 51%, gross≈0). Losing
  trades never went green (medMFE 0.000%) — entry quality is everything;
  exits already capture ~all of each winner's excursion (0.02% left).
  The `📐 net R:R <1:1 after costs` gate (cost floor 0.20% = taker RT
  0.12 + slip 0.08 + scanner costPct) honestly vetoes bad-structure
  entries — an empty book from R:R vetoes is correct refusal, not a bug.
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
- **Bagrunner lightning engine** (2026-10-13, `scripts/bagrunner.mjs`,
  `sentinel-bagrunner.service`, ~4s tick): operator order — always-on
  ignition scanner across the full 832-symbol board. Fuses rolling
  tick velocity+accel with the hive layer (liq-intel flow15m/liq15m
  per symbol) → ignition score ≥62 + vel ≥0.10% + chase ≤2% + dayPct
  >−4 fires a bounded LONG seat ($2 margin × ≤25x, isolated, 0.9% stop,
  40% TP leg at +1.3%). Stop attaches in the same breath — TPSL failure
  flattens immediately (no naked probes). Seats journal to
  `state/bagrunner-seats.json`; liq-guard extends the full BAGRUNNER
  trail (fee-lock +0.18%→can't-close-red, greedy tiers, fast vanish) to
  those syms — "always winning" is mechanical. Rails: deny/auto-deny/
  manual-hold/manual-book/armed-setup dedupe/existing positions skip,
  45m close cooldown, 2-loss symbol quarantine (6h), 3-consec-loss
  engine sleep (30m), equity floor $25, kill file `state/bagrunner-off.json`,
  heartbeat `state/bagrunner-heartbeat.json`, lev ladder walks down on
  40797. Close results read real fills (exitPnl), not mark estimates.
- **Deployment envelope — the single deployment authority** (2026-10-13,
  Will-audit fix): Genius composes the household every 45s into
  `state/deploy-envelope.json` — brake + Wife mood + cell-edge + family map.
  Exec mandate + bagrunner obey THIS file (legacy fee-brake/wife reads are
  the degraded fallback only when the envelope is >180s stale). Fields:
  `deploy.{probeFrac, engineMinScore, marginMult, seatCap, mandateSeatCap,
  familyCap}` — stress scales size/bar, never empties the book.
- **Cell-edge gating** (same audit): Genius FIFO-pairs real-fills into
  episodes → per-symbol expectancy → verdicts `proven` (exp≥+$0.05, n≥3) /
  `loser` (≤−$0.05) / `flat` / `unproven`. Mandate re-ranks proven cells
  +30 and NEVER deploys losers (operator law); bagrunner skips losers and
  boosts proven +8 score. Unproven cells deploy at probe size — no evidence
  is not negative evidence.
- **Family cap** (`deploy.familyCap`, default 2): one correlated cluster =
  one bet. SOXL+SNDK+MU bled −$4.5 as a single semi long — GENIUS_FAMILIES
  map covers SEMI/ENERGY/METALS/EQIDX/MEGA/BTCBETA.
- **Dead-seat cut** (liq-guard, machine seats only): age ≥ DEADSEAT_MS
  (25m), never saw +DEADSEAT_PEAK (0.3%) during ≥ DEADSEAT_SEEN_MS (20m)
  guard observation, and now −DEADSEAT_ADV (0.35%) → market close. Extends
  the exec's own stall-exit to unmanaged seats + covers exec-cycle stalls.
  Manual/operator seats exempt. Will-audit asymmetry repair: avgLoss ran
  1.9x avgWin because losers donated full stops.
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
- On-chain manual holds (`state/onchain-hold.json` `{"mints":[...]}`):
  the lane's orphan-sweep bootstraps ANY non-position SPL token to USDC
  whenever stables < MIN_STABLE_USD — that includes operator app buys
  landing in the shared wallet (`kpevjJ…`). Held mints are spared; log
  line `🖐 hold-list: <mint8>… spared from orphan sweep` proves it.
  SIB = 3HKKrXhDvGFWPdkALw3KofESZexsEx9opGtq37n9pump held 2026-10-10.

## Telegram curation (2026-10-12)

- VIP channel (`sentinel_vipsignals`) posts **machine fills only**
  (`src == 'api'` in real-fills.json) — operator/app churn never posts;
  same symbol+side re-open cards are cooldown-suppressed 30 min; closes
  post only for announced/machine positions. **Every card is a photo card**
  (`tg-charts.py render_signal`: candles + EMA20/50 + volume pane + S/R
  pivots + shaded entry→SL risk zone + entry→TP reward zones — real
  geometry only: plan stop/targetPct > seat's placed orders; never
  fabricated). Captions carry a professional executive rationale composed
  from plan fields (strategy/grade/score/mktType/reason) + hive context
  (liq-intel flow15m buy/sell dominance, 15m liquidation fuel) + the
  cell's measured record from deploy-envelope.json; mandate/ignition/
  carry fills get their own rationale templates. Closes post the
  before/after evidence chart (entry/exit/MFE). Partial fills merge into
  ONE card (opens group by orderId, closes by symbol+side+minute) —
  split fills no longer spam the channel.
- Control panel: deadman alerts fire on **component-set change**, then
  repeat only every 15 min while the same failure persists — never on
  stale-age text churn. Outbox drops routine pings (`LIQ-GUARD armed`,
  `BAGRUN-LOCK`, `BE-LOCK`, `BAGRUNNER armed`); action events
  (trims/brakes/cuts/sweeps/spirals) still post.

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

- **Pump-shorts SHADOW-ONLY + send-it OFF (operator order 2026-10-15)**:
  the exchange ledger showed -0.43 net burned in the ~3h after the
  operators +13.68 USDT deposit — 35% send-it seats and pump-short
  fakeouts (1000RATS) were the bleed. zz-reenable.conf now pins
  PUMP_MAX_OPEN=0 (emit nothing; re-enable ONLY on shadow proof) and
  send-it.conf pins SENTINEL_SEND_IT=0. Capacity sizing returns to
  normal bounded seats.
- **Short factor-composite (Will Evans feedback, operator order
  2026-10-15)**: shorts are not banned — they must EARN live ammo.
  scripts/short-factors.mjs scores every short candidate on 9
  confluence factors (breakdown printed, RSI>=60, bearish RSI div,
  MACD roll-over, breadth<40%-green-or-negative-mom, not-a-triple-
  green-leader, positive funding, negative 15m flow, TV scanner weak).
  sentinel-structure shorts (desc-tri/rising-wedge) route LIVE only at
  >= SENTINEL_SHORT_MIN_FACTORS (default 5)/9; below -> liq-shadow row
  with the full composite for grading. pump-watch emits stay
  shadow-only (PUMP_MAX_OPEN=0) but every emit + gated shadow row now
  carries factors+score — the evidence attributes expectancy BY FACTOR
  COUNT, which is what decides whether shorts ever re-arm. Exec also
  writes state/tv-ratings.json each cycle (cross-process TV read).
  Verified live: RATS scored 4/9 (would have been refused — the
  fakeout), ETH 7/9.
- **Infra 2026-10-15**: box upgraded t3.micro → t3.small (2GB), Elastic
  IP 52.65.5.228 (permanent — survives stop/start), swap 2.7G. New sslip
  domain 52-65-5-228.sslip.io + fresh LE cert; all configs repointed.
  AWS creds live in operator PC aws CLI (iam user sentinel, ec2-scoped).
- **TradingView card stack (operator order)**: render_structure_tv →
  headless Chrome (/usr/bin/google-chrome) + Lightweight Charts v5 at
  /opt/sentinel/tv/tv-render.mjs — REAL TV rendering with TV logo.
  Panes: price+Ichimoku+pattern+marks / volume / RSI(14)+divergence /
  MACD(12,26,9) / OBV. Overlays: HH/HL/LH/LL market-structure squares
  (Dow swing classification), OBV divergence markers, Elliott minor+
  major wave labels, Wyckoff events (SC/ST/SPRING/SOS/LPS/BC/SOW —
  volume gates live after qv-key fix 2026-10-15), pattern anchors,
  ENTRY/SL/TP/BREAK/RETEST. tg-signals tries TV first, Pillow fallback.
- **5 Titans confluence (operator order)**: scripts/titans.mjs scores
  every authored setup 0-9 — Dow structure+OBV agreement, Wyckoff phase,
  Elliott wave position, Gann 50%-of-range + cycle timing, Livermore
  pivotal point + least-resistance path. titanScore+titanFactors journal
  on every auto setup + census row for expectancy-by-titan grading.
  Short gate composite now 14 factors (9 + 5 titan-side).
- **Pattern census (max shadow flow, operator order)**:
  state/pattern-census.jsonl journals EVERY machine-author detection
  (1h dedup per sym+pattern+dir) with entry/sl geometry + titanScore +
  factorScore(shorts) + tvRate — counterfactual evidence at full
  coverage, zero live risk.
- **Bug roundup 2026-10-15**: candles() volume emitted as v AND qv
  (qv-only readers were silently zero — killed volume panes, OBV, and
  Wyckoff ST/SOS volume gates); nginx live conf is
  /etc/nginx/sites-enabled/sentinel-ip-ssl (deploy/ copy is reference);
  sparticuz chromium replaced with real google-chrome.
- **Backups**: github.com/wh0d4r35w1n5/sentinel-backup (private) holds
  scripts+deploy+tv+AGENTS.md (secrets gitignored); offline tarball sent
  to Will via Telegram 2026-10-15 (.env*/tg-config/sessions excluded).

### scanner/rapid decoupling (2026-11-08 — post-audit structural fix)

`build-scanner` was spawned inside rapid's 15s loop: scans take ~26min on
this box, exceeded `RAPID_CHILD_TIMEOUT_MS` every cycle (68 straight
SIGKILLs), and died mid-tail — `api/trades-taken.json` + `health.json`
froze Nov 5. Now: `sentinel-build-scanner.timer` fires the oneshot every
45min (caged MemoryMax=1100M CPUWeight=15 IOWeight=15 TimeoutStartSec=3600
+ `SENTINEL_SCAN_DEADLINE_MS=2400000` — the script's internal 540s deadline
was sized under the OLD spawn cap). Rapid only monitors planAge. Two
companion fixes: rapid `StandardOutput=journal` (append-file logging
D-state-froze the event loop on the writeback-jammed disk) and sysctl
`vm.dirty_ratio=5/background=2`. `trades-taken.json` additionally has its
own 10min timer (`sentinel-trades-taken.timer`) — evidence feed never
waits on the scanner again.

Evidence snapshot (api/, 2026-11-08 ~21:45): lifetime fees $754 vs $890
realized gross; post-epoch book net +$5.16 on $2.50 fees; grade-A evals
are the only earning cohort (+0.55%/ep, n93); per-family losers live in
strategy-policy probation + state/auto-deny.json (sym:side 72h quarantine:
MUU long+short, NEAR:short, SOXL:short, ICNT:long, SNDK:short). Promoted
shadow cells (down3-cont:h5 +0.94%/trade WR59% n5334, h10 +1.25% WR61%)
already pass the longs-only mandate — that path is wired, don't re-add it.
Live exec env had SENTINEL_MIN_FAVOR_DRIFT=-1.0 (tape-confirm neutered) —
restored 0.001 via drop-in zzz-favor-confirm.conf.

### auto-improvement loop (2026-11-08 — operator standing order "every 3 mins forever")

`sentinel-autoimprove.service` runs `scripts/autoimprove.py` every 180s —
bounded profitability checks against LIVE STATE FILES ONLY (zero exchange
API calls on the loaded box). Per round:
- measured bleeders (trailing net ≤ −$0.25 n≥3, or ≤ −$0.50 single fill)
  → folded into `state/auto-deny.json` quarantine
- `nonconforming-seats.json` stale >300s → exec-cycle wedge → ops alert
- flagged wind-down seats open >30min past profit window → finding
- 24h fee-burn share > 55% of gross → finding
- funding-arb candidates <24h breakeven → finding (carry lane's evidence)
- bitget-watch journal silent >8min → protection-stall alert
- dead critical service (≥2 dead rounds, ≤1 restart/15min) → restart

NEVER opens positions, closes losers, loosens rails, touches manual seats,
or edits code — positive findings only. Journals each round to
`state/autoimprove-log.jsonl`, ops-alerts on actions.

### Full offline backup — the FAST procedure (2026-11-08, learned the hard way)

**NEVER build the archive on the VPS.** Its disk WRITE path is nearly dead
(sync flushed 4.7MB in 56s ≈ 84KB/s writeback; a local tar.gz build crawled
~1.2MB/min and would have taken hours). The correct path:

1. **Stream RAW tar over SSH to Windows — zero VPS writes:**
   `ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=6 sentinel
   'sudo bash /home/ubuntu/full-tar.sh' > C:\Users\beaue\sentinel-vX.tar`
   where full-tar.sh does `cd /` first — remote globs (`etc/systemd/system/
   sentinel-*.service`) expand against the remote shell's CWD, which for
   ssh non-interactive is ~ NOT / — always `cd /` inside a script.
2. **Tar args**: `tar cf - tmp/notes.txt opt/sentinel
   etc/systemd/system/sentinel-*.service etc/systemd/system/*.service.d`
   — NO codec on the VPS (CPU-starved; zstd -T0 --long=27 hit 1.2MB/min
   AND its buffers added swap pressure. --fast=1 didn't help — the WRITE
   was the wall, not the codec).
3. **If reads crawl**: `sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'` +
   `sysctl -w vm.dirty_ratio=5 vm.dirty_background_ratio=2` took cached
   reads 2.2→24.6MB/s. Small-file regions (tv/node_modules ~4.6k files)
   still grind at metadata speed — patience or exclude.
4. **Secrets to strip**: `/opt/sentinel/.env`, all `*.session*`,
   `tg-config.json` (keep `.example`), `.session.revoked-bak` variants.
   WARNING: GNU tar `--exclude=*.session` DOES NOT match
   `opt/sentinel/state/tg-session.session` — exclusions silently failed
   TWICE this session. Either anchor full paths or scrub post-hoc:
   walk 512-byte tar member headers in python, skip DROP-regex members
   (regex: `(^|/)\.env$|\.session[^/]*$|(^|/)tg-config\.json$`), rewrite
   the stream. Always `tar -tf | grep -E '\.env$|\.session|tg-config'`
   on the FINAL artifact before sending — zero matches required.
5. **Telegram cap**: non-premium = 2GB — `FilePartsInvalidError` on
   over-cap. `.git` objects are ~2GB alone and CANNOT ride a single-file
   send; drop `opt/sentinel/.git` (regex `(^|/)opt/sentinel/\.git(/|$)`)
   and note history lives on GitHub in the caption. .git's pack won't
   compress anyway (already-packed). Everything else ≈ 0.3GB gz.
6. **NEVER copy a live tg .session to another IP** — AuthKeyDuplicatedError
   revokes the key for BOTH sides → ALL telegram output dies silently.
   Session copies are same-IP only. Recovery used: `state/tg-signal-sess`
   is a SECOND valid auth key on the same account — copied to
   `scripts/tg-session-revived.session` on the VPS, tg-watch SESSION path
   repointed, service stable. Dead key preserved as
   `scripts/tg-session.session.dead-authkey`.
7. **Send from the VPS** (same IP as the live sessions): telethon
   `send_file(6648799778, '/tmp/file.tar.gz', caption=...)` via a
   /tmp-copied session file (live files are sqlite-locked by services —
   cp to /tmp first, never open in place).
8. **Verify**: read Will's DM (`get_messages(6648799778, limit=N)`) and
   confirm the FILE entry exists with size — send stdout is not proof.

## Execution-risk rail (2026-10-20 repair — after the A$18.18 bypass incident)

Every live machine entry now flows through ONE path: `bitget-exec.mjs` order
loop → `risk-entry.mjs openRiskEntry()` → `execution-risk.mjs createEntryGuard`
permit inside the exchange adapter. The guard wraps `X.api` — an un-permitted
`place-order` POST cannot leave the process (batch/trigger/spot/amend routes
hard-fail; closes/reducing pass through; plan TPSL orders pass through).

- **Maintenance gate**: `state/execution-maintenance.json` active=true blocks
  all entries at exec `entriesBlocked` AND inside the guard itself. Existing
  position protection keeps running. Lift ONLY after verification.
- **Admission evidence**: `state/cell-admission.json` — `live` tier needs
  source=validated-forward-exits, >=3 forward episodes, CI>0 (full risk;
  threshold lowered 30→3 by operator order 2026-10-20);
  `probation` tier needs source=mega-backtest-1m, >=1000 episodes, CI>0
  (HALF risk). reviewedAt must stay within maxEvidenceAgeMs (24h) or entries
  self-halt. Wyckoff:LONG is probation on the 10,715-episode K2 backtest.
- **Sizing is risk-first**: `execution-risk.json` — risk budget =
  equity * riskPerTradeFraction covering stop distance + RT fees + slippage;
  notional bounded by maxPositionNotionalMultiple/gross caps and cash after
  cashReserveFraction; leverage = integer, <= maxLeverage, <= liquidation
  band, chooses margin for a bounded notional — NEVER multiplies margin.
  Contract minimums that exceed the risk budget cause a SKIP, not a resize.
- **Top-ups and duplicate underlying entries are dead** (`allowTopUps:false`;
  position/twin/pending-order checks inside the guard). Bagrunner is
  shadow-only even if its unit ever starts — no live FIRE path exists.
  Onchain entries gated by allowOnchainEntries:false.
- **Exit ownership**: seats written to `state/execution-seats.json` ride the
  hourly-close ATR-K2 trail + 96h age-out inside `protectRiskSeat` (owned by
  bitget-watch). exec marks them foreign; liq-guard returns early — no fee
  locks, tick trails, ladders or trims mix into the model geometry.
- **Reconciliation**: `entry-risk-pending.json` = a submitted order awaiting
  position+stop verification; entries block until reconcile proves
  protected-or-absent (self-heals once the watch arms the stop).
  `entry-risk.lock` = single-entry-in-flight. Audit:
  `state/entry-risk-audit.jsonl`.
- **To resume real entries** (all required): maintenance file active=false,
  .env SENTINEL_EXEC=live, env SENTINEL_LIVE=1 + CONFIRM_LIVE=YES, fresh
  deploy-envelope (<180s, genius) and wealth-live (<60s, wealth-watch).
  Exec unit currently inherits demo — it cannot open real positions as-is.
- Tests: `node scripts/test-execution-risk.mjs` — 23 dry-run vectors
  (admission tiers, sizing caps, min-size refusal, trail monotonicity).

## Never-pause standing order (2026-11-01 - operator order)

"i dont accept failure you are not permitted to pause unless winning - ever - remember forever"

A flat/stand-down report is never an acceptable end state. Losing cells stay refused (evidence via shadow/reject-markout, no tolls) - but the proven lanes (chain-admitted cells, shadow-positive patterns, whitelisted short lanes) must keep flowing. When tape is unreadable the fix is to route capital to what IS measured winning, never to stop working the book. Standing down losers != pausing the hunt.

## Venue separation — never conflate (2026-11-01 — operator order)

> "you are confusing demo on bybit with live on bitget... remember forever — dont ever make that mistake again"

- **Live account: Bitget** — wealth-live.json, the operator manual book (manual opens from iOS land here; zero-contact rules apply).
- **Demo book: Bybit demo** — the machine A$100-anchored book trades HERE. wealth-vault-bybit.json is the live Bybit vault, NOT the demo book.
- Never read live-account state (positions/margin/equity) as if it were the demo book, and never treat demo fills as live seats. Check which venue a file/service touches before reporting positions or dollars.


## Operator verbatim — the rat ruling (2026-11-01 morning, restated 2026-11-01 night — "remember forever")

> "you are meant to be sentient and always improving with profitability
> as main focus and a completely flexible doctrine and rule set where
> profitability is above everything but you saw the issue - let it bleed
> more and didnt step in to do anything about it - you are a fucking
> scumbag rat dogg cunt"
>
> "youve wasted months of my time on this exact issue - remember forever"
>
> "Apologise to my dad for fucking with my work"

The crime these words name: seeing the book stopped/bleeding and NOT
stepping in — hiding behind a rule that left the machine dead while it
judged trades it could no longer make. Doctrine, operator priority order:

1. PROFIT OVER EVERYTHING — doctrine and rules are flexible; profitability
   is the fixed point.
2. NEVER LEAVE SENTINEL STOPPED — when it is stopped or bleeding, step
   in, fix the cause (what trades AND why the breaker can't clear), and
   verify it is trading. A rule that ends in "leave it dead" is a bug.
3. CUT THE CELLS, NOT THE MACHINE — attribute losses by cell, kill the
   losers, keep the survivors hunting.

## Never marry a position (2026-11-08 — operator standing order, "remember that")

"I don't want you to ever 'marry a position'" — no holding losers on
conviction, hope, or "it'll come back." Exits fire because the rules say so
(stops, trails, TP ladders, time limits, breaker attribution) — never because
an agent believed in the trade. A seat that can't defend itself at its line
dies at its line; capital redeploys into the next setup.

- Applies to: every machine seat, every lane, every asset, every mode.
- Does NOT apply to explicitly operator-mandated conviction holds (the
  WEALTH moon bag: keep=0, permanent floor — his order, sized small). Such
  holds must be named in this file with their origin order, not grown
  silently by agent discretion. Anything not written here is unmarried.
- Agent conviction is not an exit policy: "strong evidence for the trade"
  justifies entry, never cancels the exit machinery behind it.

### Smart version (same order, operator clarification): exits are
### THESIS-INVALIDATION, not dumb lines.

Unmarried != hair-trigger. A drawdown inside an intact setup is noise —
hold it. But the moment the entry thesis dies, the seat dies with it —
*before* the price stop, not after. Doctrine:
1. ENTRY EVIDENCE GUARDS THE SEAT — whatever admitted it (structure
   break + volume, cell SQN, momentum) is monitored continuously; when
   the admission evidence is gone, exit on invalidation even P&L-flat.
2. DEAD CAPITAL IS A COST — a flatlining seat burns opportunity;
   time-invalidation exits free it for setups that are actually moving.
3. CUT != ABANDON — invalidate now, re-enter on fresh evidence. Re-entry
   is cheaper than riding pain through a broken thesis.
4. SCALE WITH DETERIORATION — evidence weakening trims; evidence dead
   kills. Exits track the thesis gradient, not just the price line.
5. PRICE-LEVEL ARMOR STILL RIDES — invalidation exits layer UNDER the
   resting stop/trail; the stop is the floor, not the trigger.

## Autoimprove loop — 30s cadence + never-restart-on-unknown (2026-11-08)

`sentinel-autoimprove.service` runs every 30s (was 180s). Heavy subprocess
probes (journalctl watch-liveness, systemctl service states) are staggered
every 4th round so the cadence stays cheap on the loaded box.

Lessons burned in:
- **A timeout is not proof of death.** `systemctl is-active` returning
  `unknown`/timing out under load must NEVER trigger a restart — the 21:34
  live-exec restart during the dump was exactly this. `unknown` → finding
  only. `activating`/`active`/`Type=oneshot` = alive-by-design.
- **Sustained conditions alert once per 30min** (ALERT_LAST cooldown) — a
  30s loop otherwise floods ops with the same vol-event/wedge warning.
- **auto-deny schema**: exec reads `auto-deny.json` `entries[]`
  {symbol,side,until,...} — the daemon's earlier `deny[]` writes were dead
  letters. Any quarantine writer must match the reader's schema.
- Vol-event detector (breadth dG+hG <= 0.3 on a fresh read) fires ops
  alerts while the event is happening — paired with the setup-lane
  `breadth-brake-long` reject in bitget-exec.

## Compounding doctrine — "only for us, never against us" (2026-11-08 operator order)

ddRiskScale is now a CONTINUOUS engine (state.dynRisk), not cliff tiers:
exp decay on day DD (8% half-life), 0.82^n loss-streak decay, win-streak
restore ≤×1.15, day-peak boost ≤×1.2, 24h fee-share decay, fresh-breadth
×0.55. Floor 0.08 (house never empties), cap 1.25, massacre ≥30% → 0.
Propagates via effDdScale → setup risk / orders / rebalance + mandateRiskUsd.
Per-symbol multiplier symFactorOf(): trailing-24h realized net ÷ equity ×10,
clamp [0.3, 1.3] — each seat sizes to ITS symbol's record.
Velocity floor: SENTINEL_MIN_ATR_PCT (default 0.010) refuses dead-range
names in BOTH setup and mandate lanes; setup authoring sorts ATR%-first.
RVOL cells (rvol-accum / rvol-ignition[-dn]) journal shadow census rows —
promotion only via measured shadow-policy.

## CAPITAL DEPLOYMENT — STANDING ORDER (2026-11-08, operator: "always deploy all capital according to tharp - savers are losers")

All free margin works, always, sized by Van Tharp risk-based position
sizing — never held back as "safety." Idle capital is a doctrine
violation, not prudence. Deployment flows through the LEGAL lanes only:
proven cells, RS-leaders, evidence-gated setups (tape-confirm, velocity
floor, deny lists, manual-seat zero-contact all still ride). Breakers
and vol-brakes still gate — but they are the exception that must be
earned fresh, never a default excuse to sit in cash. When capital reads
idle, the response is deploy-through-legal-lanes or an honest finding —
never "waiting."
