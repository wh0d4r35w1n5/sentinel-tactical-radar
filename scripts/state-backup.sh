#!/bin/bash
# state-backup.sh — daily snapshot of /opt/sentinel/state into api/history/,
# which the existing sentinel-push timer commits to the repo within minutes.
# The trade journal (real-fills), entriesLog, guard gates and watchlists
# survive a box death this way. Round-archive dirs excluded (regenerable).
set -e
cd /opt/sentinel
mkdir -p api/history
F="api/history/state-$(date -u +%F).tar.gz"
tar czf "$F" state \
  --exclude='state/round-archive-*' \
  --exclude='state/*.session' 2>/dev/null || true
# keep 10 snapshots max — git history keeps the rest forever anyway
ls -1t api/history/state-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
echo "state-backup: wrote $F ($(du -h "$F" | cut -f1))"
