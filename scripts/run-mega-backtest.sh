#!/usr/bin/env bash
# Mega backtest matrix — ~1M+ simulated episodes.
# Full USDT-futures universe (800-cap takes everything liquid) x 1yr of 1H bars.
# 3 exit-geometry sweeps: base ladder, trail K2, retest entries.
# Each output saved under api/mega-*.json; progress in api/full-backtest-progress.json.
set -u
cd /opt/sentinel/scripts
export BT_SYMS=800
export BT_BARS=8760
export SENTINEL_NO_TG=1

run() {
  local tag="$1"; shift
  echo "=== sweep ${tag} starting $(date -u +%T) ==="
  env BT_TAG="$tag" "$@" node full-backtest.mjs
  cp -f /opt/sentinel/api/full-backtest.json "/opt/sentinel/api/mega-${tag}.json"
  echo "=== sweep ${tag} done $(date -u +%T) -> api/mega-${tag}.json ==="
}

run ladder    BT_TRAIL_K=0 BT_SHORT_RETEST=0
run trail-k2  BT_TRAIL_K=2 BT_SHORT_RETEST=0
run retest    BT_TRAIL_K=0 BT_SHORT_RETEST=1

echo "=== mega matrix complete $(date -u +%T) ==="
