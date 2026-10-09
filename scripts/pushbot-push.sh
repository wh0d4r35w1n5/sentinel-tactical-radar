#!/usr/bin/env bash
# pushbot-push.sh - artifact pusher for the VPS pushbot clone (/opt/pushbot).
# Run by sentinel-push.service (User=ubuntu) from sentinel-push.timer every 5 min.
#
# Payload discipline (2026-10-09 rework): the dashboard consumes only the small
# api/state json set — signal-archive.json, api/history/* and state/klines-*.json
# have ZERO web consumers and were adding ~200MB/day of blobs (ENOSPC 2026-10-02,
# git OOM 2026-10-06, disk-full deploy corruption + sshd timeouts 2026-10-09).
# They are now UNTRACKED in the repo (f28953b) but still rsync'd into the tree —
# the on-box mirror keeps them, git history doesn't.
#
# Self-squash: if .git exceeds SQUASH_MB the clone rebuilds shallow IN PLACE —
# remote is canonical, local history is disposable. Working tree + untracked
# files (this script) survive. Fails-open discipline: a push problem must
# never touch the trading daemons.
set -u
cd /opt/pushbot || exit 0
export GIT_TERMINAL_PROMPT=0
G="git -c gc.auto=0 -c pack.threads=1 -c pack.windowMemory=32m -c pack.deltaCacheSize=16m -c core.bigFileThreshold=16m"
SQUASH_MB=${PUSHBOT_SQUASH_MB:-1200}

$G fetch origin main -q 2>/dev/null || exit 0
$G reset --hard origin/main -q 2>/dev/null || $G pull --rebase -X ours -q 2>/dev/null || true

if [ "$(du -sm .git 2>/dev/null | cut -f1)" -ge "$SQUASH_MB" ]; then
  rm -rf .git
  git init -q
  git remote add origin https://github.com/wh0d4r35w1n5/sentinel-tactical-radar
  git config credential.helper store   # ~/.git-credentials holds the PAT
  git fetch --depth 1 -q origin main
  git reset --hard -q FETCH_HEAD
  git checkout -qb main FETCH_HEAD 2>/dev/null || git checkout -qb main
  git branch --set-upstream-to=origin/main main 2>/dev/null || true
fi

# full mirror into the tree (on-box archive); git only tracks the light set
rsync -a /opt/sentinel/api/ api/
for f in checksums.json demo-fills.json einstein.json equity-peak-demo.json factor-ic.json mae-mfe.json mae-track.json scan-cursor.json social-cache.json wealth-vault.json klines-15m.json klines-1D.json klines-1h.json klines-4H.json; do
  [ -f /opt/sentinel/state/$f ] && cp /opt/sentinel/state/$f state/$f
done

$G add -f -- 'api' 'state' ':(exclude)api/signal-archive.json' ':(exclude)api/history' ':(exclude)state/klines-*.json' 2>/dev/null
$G commit -qm "vps: $(date -u +%FT%TZ)" 2>/dev/null || exit 0
$G push -q origin HEAD:main 2>/dev/null || true

# weekly repack - bounded memory, never fatal, never before a push
if [ ! -e .git/gc-stamp ] || [ -z "$(find .git/gc-stamp -mmin -10080 2>/dev/null)" ]; then
  $G reflog expire --expire=now --all 2>/dev/null || true
  $G gc --prune=now -q 2>/dev/null || true
  touch .git/gc-stamp 2>/dev/null || true
fi
exit 0
