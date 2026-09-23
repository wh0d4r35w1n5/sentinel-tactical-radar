# VIP desk feed — Telegram -> api/ext-alpha.json
# First run: fill scripts/tg-config.json (api_id/api_hash from my.telegram.org)
# then run this and enter phone + OTP once. Session persists after that.
Set-Location $PSScriptRoot
python scripts\tg-signals.py
