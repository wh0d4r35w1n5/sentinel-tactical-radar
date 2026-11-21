# Fills .env credentials from clipboard — values never echo to console.
# Usage: copy a value in Bitget, run this script, pick which field it fills.
$envFile = Join-Path $PSScriptRoot '..\.env'
$fields = @('BITGET_API_KEY', 'BITGET_API_SECRET', 'BITGET_PASSPHRASE')
foreach ($f in $fields) {
  $cur = (Get-Content $envFile | Where-Object { $_ -match "^$f=" }) -replace "^$f=", ''
  if ($cur) { Write-Host "$f already set ($($cur.Length) chars) — skipping"; continue }
  Write-Host "Copy the value for $f to clipboard, then press Enter..."
  [void](Read-Host)
  $v = (Get-Clipboard).Trim()
  if (-not $v) { Write-Host "  clipboard empty — skipped"; continue }
  (Get-Content $envFile) -replace "^$f=.*", "$f=$v" | Set-Content $envFile
  Write-Host "  $f set ($($v.Length) chars)"
}
Write-Host "Done. .env is git-ignored — verify with: git check-ignore .env"
