#!/usr/bin/env bash
# pushbot-push.sh — artifact pusher for the VPS pushbot clone (/opt/pushbot).
# Installed on the VPS as /opt/pushbot/push.sh; sentinel-push.service runs it
# as User=ubuntu every 60s from sentinel-push.timer.
#
# Housekeeping: every cycle commits a fresh ~90MB api/ snapshot set and
# `reset --hard` refills the object store — unattended, /opt/pushbot/.git grew
# to 4.2GB and the disk hit ENOSPC on 2026-10-02, killing the executor.
# A stamp-gated daily reflog-expire + gc keeps .git bounded. Housekeeping runs
# AFTER the push and fails open: maintenance must never block or fail a push.
set -u
cd /opt/pushbot || exit 0

git fetch origin main -q 2>/dev/null || exit 0
git reset --hard origin/main -q 2>/dev/null || git pull --rebase -X ours -q 2>/dev/null || true
rsync -a /opt/sentinel/api/ api/
for f in checksums.json demo-fills.json einstein.json equity-peak-demo.json factor-ic.json klines-15m.json klines-1D.json klines-1h.json klines-4H.json mae-mfe.json mae-track.json scan-cursor.json social-cache.json wealth-vault.json; do
  [ -f /opt/sentinel/state/$f ] && cp /opt/sentinel/state/$f state/$f
done
git add -f api state 2>/dev/null
git commit -qm "vps: $(date -u +%FT%TZ)" 2>/dev/null || exit 0
git push -q origin HEAD:main 2>/dev/null || true

# daily housekeeping — at most once per 24h, never fatal, never before a push
if [ ! -e .git/gc-stamp ] || [ -z "$(find .git/gc-stamp -mmin -1440 2>/dev/null)" ]; then
  git reflog expire --expire=now --all 2>/dev/null || true
  git gc --prune=now -q 2>/dev/null || true
  touch .git/gc-stamp 2>/dev/null || true
fi
