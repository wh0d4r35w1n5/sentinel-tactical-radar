#!/usr/bin/env bash
# Sentinel — AWS EC2 -> Oracle Cloud Always Free migration
# Usage:  bash deploy/migrate-to-oracle.sh <ORACLE_IP> [ssh-user]
# Prereq: OCI Ubuntu instance exists, ~/.ssh/oracle_id_ed25519 authorized,
#         AWS box reachable via ~/.ssh/sentinel_vm_key.
# Bridges through this machine — secrets (.env, git token) never touch disk
# beyond /tmp staging and never enter git.
set -euo pipefail

ORACLE_IP="${1:?usage: migrate-to-oracle.sh <oracle-ip> [user]}"
OUSER="${2:-ubuntu}"
OKEY="${OKEY:-$HOME/.ssh/oracle_id_ed25519}"
AWS="ubuntu@3.24.242.110"; AKEY="$HOME/.ssh/sentinel_vm_key"
STAGE="/tmp/sentinel-migrate"

ossh() { ssh -i "$OKEY" -o StrictHostKeyChecking=accept-new "$OUSER@$ORACLE_IP" "$@"; }
assh() { ssh -i "$AKEY" "$AWS" "$@"; }

echo "== 1. wait for SSH on oracle =="
for i in $(seq 1 30); do ossh 'echo ok' 2>/dev/null && break || sleep 10; done
ossh 'echo "reachable:" && hostname && uname -m'

echo "== 2. provision oracle (node, nginx, git, iptables for :80) =="
ossh 'sudo apt-get update -qq && sudo apt-get install -y -qq nodejs nginx git rsync iptables-persistent >/dev/null 2>&1
# OCI images ship REJECT rules — open :80 and persist it
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT
sudo netfilter-persistent save >/dev/null 2>&1 || true
node -v'

echo "== 3. pull live payload from AWS -> local staging =="
rm -rf "$STAGE"; mkdir -p "$STAGE/sentinel" "$STAGE/pushbot" "$STAGE/systemd"
ssh -i "$AKEY" "$AWS" 'sudo tar czf - -C /opt --exclude=sentinel/node_modules --exclude=sentinel/.git --exclude=sentinel/.venv sentinel' | tar xzf - -C "$STAGE"
ssh -i "$AKEY" "$AWS" 'sudo tar czf - -C /opt pushbot' | tar xzf - -C "$STAGE"
for u in sentinel-rapid.service sentinel-push.service sentinel-push.timer sentinel-tg-watch.service; do
  assh "sudo cat /etc/systemd/system/$u" > "$STAGE/systemd/$u" 2>/dev/null || true
done
assh 'sudo cat /etc/nginx/sites-enabled/default 2>/dev/null || sudo nginx -T | awk "/server \{/,/^}/" | head -20' > "$STAGE/nginx-site.conf"
# git credential helper for the pushbot clone (github token lives server-side)
assh 'cat ~/.git-credentials 2>/dev/null || true' > "$STAGE/git-credentials"

echo "== 4. push payload AWS->local->oracle =="
tar czf - -C "$STAGE" sentinel | ossh 'sudo tar xzf - -C /opt && sudo chown -R ubuntu:ubuntu /opt/sentinel'
tar czf - -C "$STAGE" pushbot | ossh 'sudo tar xzf - -C /opt && sudo chown -R ubuntu:ubuntu /opt/pushbot'
[ -s "$STAGE/git-credentials" ] && scp -i "$OKEY" "$STAGE/git-credentials" "$OUSER@$ORACLE_IP:/home/$OUSER/.git-credentials" || true

echo "== 5. systemd + nginx =="
ossh 'cd /opt/pushbot && git config credential.helper store >/dev/null 2>&1 || true
for u in /tmp/sentinel-systemd-*; do :; done' 2>/dev/null || true
for f in "$STAGE"/systemd/*.service "$STAGE"/systemd/*.timer; do
  [ -s "$f" ] && scp -i "$OKEY" "$f" "$OUSER@$ORACLE_IP:/tmp/" && ossh "sudo cp /tmp/$(basename "$f") /etc/systemd/system/"
done
scp -i "$OKEY" "$STAGE/nginx-site.conf" "$OUSER@$ORACLE_IP:/tmp/sentinel-site.conf"
ossh 'sudo cp /tmp/sentinel-site.conf /etc/nginx/sites-enabled/default
sudo systemctl daemon-reload
sudo systemctl enable --now sentinel-rapid.service sentinel-push.timer sentinel-tg-watch.service 2>/dev/null
sudo systemctl restart nginx
sleep 8'

echo "== 6. verify =="
ossh 'systemctl is-active sentinel-rapid sentinel-tg-watch; systemctl is-active sentinel-push.timer; curl -s -o /dev/null -w "dashboard:%{http_code}\n" http://localhost/; node -e "const l=JSON.parse(require(\"fs\").readFileSync(\"/opt/sentinel/api/live-ledger.json\",\"utf8\"));console.log(\"mode:\",l.mode,\"| equity:\",l.equityUsd||l.equity)"'

echo ""
echo "== CUTOVER =="
echo "Oracle is live at http://$ORACLE_IP — verify the dashboard, then:"
echo "  ssh -i ~/.ssh/sentinel_vm_key $AWS 'sudo systemctl stop sentinel-rapid sentinel-push.timer sentinel-tg-watch'"
echo "  # leave AWS running-but-idle for a day, then stop the instance (keep it terminated-ready)"
echo "DONE — sentinel migrated to Oracle."
