# push-to-vps.ps1 — deploy Sentinel to the VPS, resilient to flaky links.
# Bulk repo goes via `git clone` on the VPS (GitHub CDN — survives drops);
# only the small secret files cross by scp, inside a retry loop.
# Usage: powershell -File deploy\push-to-vps.ps1 -VpsHost 1.2.3.4 [-User ubuntu] [-Repo <git-url>]
param(
  [Parameter(Mandatory=$true)][string]$VpsHost,
  [string]$User = "ubuntu",
  [string]$Repo = "https://github.com/wh0d4r35w1n5/sentinel-tactical-radar.git",
  [int]$MaxRetries = 30
)

$ErrorActionPreference = "Stop"
$key  = "$env:USERPROFILE\.ssh\sentinel_vm_key"
$root = Split-Path -Parent $PSScriptRoot
$ssho = @('-o','StrictHostKeyChecking=accept-new','-o','ConnectTimeout=15','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=6')

function Invoke-WithRetry([string]$what, [scriptblock]$cmd) {
  for ($i=1; $i -le $MaxRetries; $i++) {
    try { & $cmd; return }
    catch { Write-Host "[push] $what failed (attempt $i/$MaxRetries): $($_.Exception.Message)"; Start-Sleep -Seconds 5 }
  }
  throw "[push] $what failed after $MaxRetries attempts"
}

Write-Host "[push] testing ssh reachability..."
Invoke-WithRetry "ssh" {
  ssh @ssho -i $key "${User}@${VpsHost}" "true" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "ssh exit $LASTEXITCODE" }
}

Write-Host "[push] preparing /opt/sentinel + git clone on VPS..."
Invoke-WithRetry "bootstrap" {
  $boot = @"
sudo apt-get update -qq &&
sudo apt-get install -y -qq git &&
sudo mkdir -p /opt/sentinel &&
sudo chown ${User}:${User} /opt/sentinel &&
if [ ! -d /opt/sentinel/.git ]; then rm -rf /opt/sentinel/* ; git clone --depth 1 '$Repo' /opt/sentinel; else cd /opt/sentinel && git pull --ff-only || true; fi
"@
  $b64b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($boot -replace "`r`n","`n")))
  ssh @ssho -i $key "${User}@${VpsHost}" "echo $b64b | base64 -d | bash" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "bootstrap exit $LASTEXITCODE" }
}

# --- secrets: stage locally, ship inside a tarball via ssh (one shot, tiny) ---
Write-Host "[push] shipping secrets (.env, tg-config, tg-session)..."
$stage = Join-Path $env:TEMP "sentinel-secrets"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path "$stage\scripts" | Out-Null
foreach ($f in @(".env","scripts\tg-config.json","scripts\tg-session.session")) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage $f) }
}
$tar = Join-Path $env:TEMP "sentinel-secrets.tgz"
tar --force-local -czf $tar -C $stage . | Out-Null
# base64 the tarball so it's text-safe through the ssh pipe
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($tar))

Invoke-WithRetry "secrets upload" {
  $b64 | ssh @ssho -i $key "${User}@${VpsHost}" "base64 -di | tar -xzf - -C /opt/sentinel && chmod 600 /opt/sentinel/.env" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "secrets upload exit $LASTEXITCODE" }
}

Write-Host "[push] provisioning services..."
Invoke-WithRetry "vps-setup" {
  ssh @ssho -i $key "${User}@${VpsHost}" "cd /opt/sentinel && sudo bash deploy/vps-setup.sh" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "vps-setup exit $LASTEXITCODE" }
}

Write-Host "[push] done - daemon is live on the VPS"
