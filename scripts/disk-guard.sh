#!/bin/bash
# sentinel disk guard — daily prune so the box never hits 100% again
journalctl --vacuum-size=100M >/dev/null 2>&1
find /opt/sentinel/state -name "*.jsonl" -size +50M -exec truncate -s 20M {} \;
find /opt/sentinel/api/history -type f -mtime +7 -delete 2>/dev/null
find /opt/sentinel/state/signal-archive -type f -mtime +14 -delete 2>/dev/null
find /tmp -name "chart-*.png" -mtime +1 -delete 2>/dev/null
df -h / | tail -1
