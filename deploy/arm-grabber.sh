#!/usr/bin/env bash
# arm-grabber.sh — retry-loop an Always Free A1.Flex instance in ap-sydney-1
# until Oracle frees host capacity, then exit. Local-only file (OCIDs, no secrets).
# Requires: oci CLI + ORACLE-LIVE session profile (oci session authenticate).
# On success: prints instance OCID + writes IP to deploy/arm-grabber.result

TEN=ocid1.tenancy.oc1..aaaaaaaacef3w3fv3fopz7gqsqle6oodya72d35m23b54525w5wpc4pvslma
AD="cGYu:AP-SYDNEY-1-AD-1"
IMG=ocid1.image.oc1.ap-sydney-1.aaaaaaaabtl4ncr2wrha5krfzl3etb66rpegvolpjgudr7nzvkkojpx33spa
SUB=ocid1.subnet.oc1.ap-sydney-1.aaaaaaaajhuxmc2lqsvd3sg5iwd5rc2oq6iouhityv3fda3622tuhkerbvfq
KEYFILE="$HOME/.ssh/sentinel_vm_key.pub"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/arm-grabber.log"
RESULT="$DIR/arm-grabber.result"

echo "$(date -u +%FT%TZ) grabber started" >> "$LOG"

for attempt in $(seq 1 2000); do
  for CFG in '{"ocpus":4,"memoryInGBs":24}' '{"ocpus":2,"memoryInGBs":12}' '{"ocpus":1,"memoryInGBs":6}'; do
    OUT=$(oci compute instance launch -c "$TEN" --profile ORACLE-LIVE --auth security_token \
      --availability-domain "$AD" --display-name "sentinel-oracle-arm" \
      --shape "VM.Standard.A1.Flex" --shape-config "$CFG" --image-id "$IMG" \
      --subnet-id "$SUB" --assign-public-ip true \
      --ssh-authorized-keys-file "$KEYFILE" 2>&1)
    INST=$(echo "$OUT" | grep -oE 'ocid1\.instance\.[^"]+' | head -1)
    if echo "$OUT" | grep -qiE "session has expired|NotAuthenticated|cannot be refreshed"; then
      echo "$(date -u +%FT%TZ) AUTH_EXPIRED — run: oci session authenticate --profile-name ORACLE-LIVE --region ap-sydney-1" >> "$LOG"
      sleep 300; continue
    fi
    if [ -n "$INST" ]; then
      echo "$(date -u +%FT%TZ) SUCCESS cfg=$CFG inst=$INST" | tee -a "$LOG"
      # wait for RUNNING + grab public IP
      for w in $(seq 1 20); do
        sleep 15
        IP=$(oci compute instance list-vnics --instance-id "$INST" --profile ORACLE-LIVE --auth security_token \
             --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
        [ -n "$IP" ] && [ "$IP" != "null" ] && break
      done
      echo "INSTANCE=$INST" > "$RESULT"
      echo "IP=$IP" >> "$RESULT"
      echo "CFG=$CFG" >> "$RESULT"
      echo "$(date -u +%FT%TZ) IP=$IP" >> "$LOG"
      echo "Grabbed! IP=$IP — migrate with: OKEY=~/.ssh/sentinel_vm_key bash deploy/migrate-to-oracle.sh $IP"
      exit 0
    fi
    echo "$(date -u +%FT%TZ) try$attempt cfg=$CFG: $(echo "$OUT" | grep -oE '"message": "[^"]+"' | head -1)" >> "$LOG"
  done
  sleep 90
done
echo "$(date -u +%FT%TZ) gave up after 2000 rounds" >> "$LOG"
