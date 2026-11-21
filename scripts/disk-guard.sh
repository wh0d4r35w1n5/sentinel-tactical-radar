#!/bin/bash
# sentinel disk guard — hourly prune so the box never hits 100% again.
# Policy: sentinel data is COMPRESSED, never deleted. Only regenerable
# artifacts (old charts, history, tmp) and OS logs get removed/truncated.

# 1) journald + syslog family — kill the runaway-log failure mode
journalctl --vacuum-size=50M >/dev/null 2>&1
find /var/log -type f -size +80M 2>/dev/null | while read -r f; do
  tail -c 10M "$f" > "$f.tailkeep" 2>/dev/null && cat "$f.tailkeep" > "$f" 2>/dev/null && rm -f "$f.tailkeep"
done

# 2) cold sentinel data — gzip, never delete. >10MB and untouched >2 days.
#    (mtime+2 protects any file a live service still appends to)
find /opt/sentinel/state /opt/sentinel/api -type f \( -name '*.jsonl' -o -name '*.json' \) -size +10M -mtime +2 -exec gzip -f {} \; 2>/dev/null

# 3) regenerable artifacts — bounded retention
find /opt/sentinel/api/charts -type f -mtime +7 -delete 2>/dev/null
find /opt/sentinel/api/history -type f -mtime +7 -delete 2>/dev/null
find /opt/sentinel/state/signal-archive -type f -mtime +14 -delete 2>/dev/null
find /tmp -type f -mtime +2 -delete 2>/dev/null

# 4) report
df -h / | tail -1
