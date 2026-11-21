#!/bin/bash
# SENTINEL realtime GitHub backup — operator order 2026-11-12:
# "I WANT IT READ EVERY 10 MILLISECONDS" -> fastest feasible: continuous
# loop, code lane ~15s, full-data lane ~10min, push only on change.
# Private remote: backup-v130 (sentinel-master-v1.30). Public origin
# (dashboard) is NEVER touched by this script.
cd /c/Users/beaue/sentinel-clone || exit 1
REMOTE=backup-v130
BRANCH=feat/bybit-adapter
LOG=/c/Users/beaue/sentinel-clone/.tmp/github-sync.log
mkdir -p /c/Users/beaue/sentinel-clone/.tmp
GIT_PUSH="git -c http.postBuffer=1048576000 -c http.version=HTTP/1.1 push $REMOTE $BRANCH"

sync_dirs() {  # $1 = 'fast' | 'full'
  if [ "$1" = full ]; then
    ssh -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=15 sentinel "nice -n 19 tar czf - --exclude='__pycache__' --exclude='*.pyc' --exclude='.env*' -C /opt/sentinel scripts deploy bench docs data api state 2>/dev/null" | tar xzf - 2>/dev/null
  else
    ssh -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=15 sentinel "nice -n 19 tar czf - --exclude='__pycache__' --exclude='*.pyc' --exclude='.env*' --exclude='*.jsonl' --exclude='klines-*.json' --exclude='history' --exclude='reset-archive-*' --exclude='*.tar.gz' --exclude='mega-episodes*' -C /opt/sentinel scripts deploy bench docs data api state 2>/dev/null" | tar xzf - 2>/dev/null
  fi
}

stage_all() {
  git add -u >/dev/null 2>&1
  git add api data deploy bench docs scripts version >/dev/null 2>&1
  git add STATUS-DEVIN.md STATUS-CLAUDE.md STATUS-GROK.md TEAM.md CLAUDE-HANDOFF.md CLAUDE-STATUS.md AGENTS.md >/dev/null 2>&1
  # state/ is gitignored — force-add crown-jewel top-level JSONs only
  # (strategy DB, policies, ledgers). Skip giant klines + episode dumps.
  for f in state/*.json; do
    case "$f" in
      *klines*|*mega*|*archive*) ;;
      *) git add -f "$f" >/dev/null 2>&1 ;;
    esac
  done
}

commit_push() {  # $1 = tag
  if git diff --cached --quiet 2>/dev/null; then return 0; fi
  local msg="live-sync-$1 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for try in 1 2 3; do
    git commit -qm "$msg" >/dev/null 2>&1 && break
    sleep 3  # index.lock contention with manual commits
  done
  if $GIT_PUSH >/dev/null 2>&1; then echo "[$(date -u +%H:%M:%SZ)] $msg pushed" >> "$LOG"; else echo "[$(date -u +%H:%M:%SZ)] $msg PUSH FAILED (committed locally)" >> "$LOG"; fi
}

i=0
while true; do
  free_kb=$(df -k /c 2>/dev/null | awk 'NR==2{print $4}')
  if [ -n "$free_kb" ] && [ "$free_kb" -lt 500000 ]; then echo "[$(date -u +%H:%M:%SZ)] SKIP cycle: C: free $((free_kb/1024))MB < 500MB guard" >> "$LOG"; sleep 60; continue; fi
  sync_dirs fast
  stage_all
  commit_push fast
  i=$((i+1))
  if [ $((i % 40)) -eq 0 ]; then   # ~10min at 15s cadence
    sync_dirs full
    stage_all
    commit_push full
  fi
  sleep 15
done
