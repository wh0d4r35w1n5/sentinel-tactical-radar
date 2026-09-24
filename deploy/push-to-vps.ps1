# push-to-vps.ps1 — bundle the repo + secrets + session to the VPS and run setup.
# Usage: powershell -File deploy\push-to-vps.ps1 -Host 1.2.3.4 [-User ubuntu]
param(
  [Parameter(Mandatory=$true)][string]$VpsHost,
  [string]$User = "ubuntu"
)

$ErrorActionPreference = "Stop"
$key = "$env:USERPROFILE\.ssh\oracle_id_ed25519"
$root = Split-Path -Parent $PSScriptRoot   # repo root (deploy/ is inside it)
$tmp = Join-Path $env:TEMP "sentinel-bundle"

Write-Host "[push] staging bundle..."
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
robocopy $root $tmp /MIR /XD .git node_modules __pycache__ state /XF *.tmp | Out-Null
# include secrets that live outside git
foreach ($f in @(".env", "scripts\tg-config.json", "scripts\tg-session.session")) {
  $src = Join-Path $root $f
  if (Test-Path $src) {
    $dst = Join-Path $tmp $f
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $src $dst
  }
}

Write-Host "[push] shipping to ${User}@${VpsHost} ..."
ssh -i $key "${User}@${VpsHost}" "sudo mkdir -p /opt/sentinel && sudo chown ${User}:${User} /opt/sentinel"
scp -i $key -r "$tmp\*" "${User}@${VpsHost}:/opt/sentinel/"

Write-Host "[push] provisioning..."
ssh -i $key "${User}@${VpsHost}" "cd /opt/sentinel && sudo bash deploy/vps-setup.sh"
Write-Host "[push] done — daemon is live on the VPS"
