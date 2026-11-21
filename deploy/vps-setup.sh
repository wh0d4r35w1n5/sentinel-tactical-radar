#!/usr/bin/env bash
# vps-setup.sh — one-shot provisioning for the Sentinel daemon host.
# Run ON the VPS as root (or via sudo bash) after the bundle is copied to /opt/sentinel.
set -euo pipefail

cd /opt/sentinel

# --- system deps -----------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs npm python3 python3-pip python3-venv git curl

# telethon for the watcher (venv to keep system python clean)
python3 -m venv /opt/sentinel/.venv
/opt/sentinel/.venv/bin/pip install -q telethon
# point the service at the venv python
sed -i 's|/usr/bin/python3|/opt/sentinel/.venv/bin/python3|' deploy/sentinel-tg-watch.service

# --- systemd ---------------------------------------------------------------
install -m644 deploy/sentinel-rapid.service deploy/sentinel-tg-watch.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sentinel-rapid sentinel-tg-watch
systemctl --no-pager --full status sentinel-rapid sentinel-tg-watch | grep -E "Loaded|Active" || true

echo "---"
echo "[vps] sentinel deployed. logs:"
echo "  tail -f /var/log/sentinel-rapid.log   # scan+exec loop"
echo "  tail -f /var/log/sentinel-tg.log      # VIP watcher"
echo "  systemctl restart sentinel-rapid      # bounce"
