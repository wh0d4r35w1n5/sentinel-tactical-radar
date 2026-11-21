#!/bin/bash
# exec-watchdog: restart sentinel-live-exec when live-ledger refresh stalls
LEDGER=/opt/sentinel/api/live-ledger.json
NOW=$(date +%s%3N)
AT=$(python3 -c "import json,datetime;d=json.load(open(\"$LEDGER\"));ra=d.get(\"refreshedAt\");print(int(datetime.datetime.fromisoformat(ra.replace(\"Z\",\"+00:00\")).timestamp()*1000)) if ra else print(0)" 2>/dev/null || echo 0)
AGE=$((NOW - AT))
# grace: a service younger than 180s may still be in init (state load,
# ws connect, first cycle). restarting it just re-zeros the clock and the
# ledger stays stale -> death-spiral. let it finish booting.
SVC_USEC=$(systemctl show -p ActiveEnterTimestampUSec --value sentinel-live-exec 2>/dev/null || echo 0)
NOW_USEC=$(( $(date +%s) * 1000000 ))
SVC_AGE_S=$(( (NOW_USEC - ${SVC_USEC:-0}) / 1000000 ))
if [ "$AGE" -gt 240000 ] && [ "$SVC_AGE_S" -gt 1000 ]; then
  systemctl restart sentinel-live-exec
  logger -t exec-watchdog "live-ledger ${AGE}ms stale, svc ${SVC_AGE_S}s old — restarted sentinel-live-exec"
elif [ "$AGE" -gt 240000 ]; then
  logger -t exec-watchdog "live-ledger ${AGE}ms stale but svc only ${SVC_AGE_S}s old — grace, no restart"
fi
