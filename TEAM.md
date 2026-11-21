# SENTINEL agent team protocol — read before any work

Operator: Beau (AU, A$ first). Objective: grow the account to A$45 zerotouch —
"don't lose my money" means DO BETTER AT MAKING MONEY, never stop trading.

## Canon (read first, every agent, every cycle)
1. `AGENTS.md` — deployment, verification, breaker/cell, manual-seat contract.
2. `CLAUDE-HANDOFF.md` — live-state brief and standing objectives.
3. Peer `STATUS-*.md` files — what the other agents did/found this cycle.

## Team roster and lanes (collision control — stay in your lane)
| Agent   | Lane                                                        | Writes          |
|---------|-------------------------------------------------------------|-----------------|
| Claude  | Bot 1 — bitget-exec, bitget-watch, autoimprove, build-scanner | STATUS-CLAUDE.md |
| Devin   | Bot 2 — onchain-exec, solana-swap, pumpportal, sniper + coordination + independent verification of ALL claims | STATUS-DEVIN.md |
| Grok    | Red-team/research — second-opinion review of proposed changes, strategy research, challenge claims with evidence. Proposes via STATUS-GROK.md; does NOT deploy. | STATUS-GROK.md   |
| Codex   | BLOCKED — ChatGPT plan rate-limited until 2026-12-03. Rejoin when unblocked. | —               |
| Cursor  | IDE-only agent, no headless CLI — operator may run it manually in-editor | —               |
| Manus   | Web-only agent, cannot reach VPS — excluded from live ops    | —               |

## Collaboration rules (the "elite team" contract)
1. **Verify before building.** Before acting on another agent's claim, check it
   against live state (VPS files, journals, exchange/chain truth). No-bullshit
   rule: unverified = say "unverified".
2. **Status every cycle.** End each work cycle by writing your STATUS file:
   what you verified, what you changed (files + backups), what you measured,
   what's pending, what you contest in peers' work.
3. **Contest with evidence.** If a peer's claim looks wrong, write the
   counter-evidence in your STATUS file — don't silently "fix" their lane.
   Devin arbitrates cross-lane disputes.
4. **Deploy discipline.** scp → sudo mv → node --check → restart service →
   verify live output. Backup before every edit (`.pre-<tag>`). crc32 audit
   after changes. Never quote code defaults as live config.
5. **Real money only.** Balances from `/opt/sentinel/api/wealth-live.json`,
   chain, or exchange API — never modeled figures.
6. **Never delete SENTINEL files.** Never touch another agent's active lane
   mid-cycle; if a fix is urgent cross-lane, note it in your STATUS file AND
   tell the operator.
7. **Report A$ first** where relevant. Net-of-fee always. Admit errors in
   one line.
