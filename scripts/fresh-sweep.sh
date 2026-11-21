#!/bin/bash
cd /opt/sentinel/scripts
export BT_SYMS=800 BT_BARS=8760 SENTINEL_NO_TG=1
env BT_TAG=fresh-ladder BT_TRAIL_K=0 BT_SHORT_RETEST=0 /usr/bin/node full-backtest.mjs
env BT_TAG=fresh-trailk2 BT_TRAIL_K=2 BT_SHORT_RETEST=0 /usr/bin/node full-backtest.mjs
env BT_TAG=fresh-retest BT_TRAIL_K=0 BT_SHORT_RETEST=1 /usr/bin/node full-backtest.mjs
echo "FRESH-SWEEP-DONE $(date -u +%FT%TZ)"
