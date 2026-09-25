@echo off
rem Sentinel rapid daemon launcher - HKCU Run key target (every logon)
rem VPS owns the Telegram session; local runs scanner only.
cd /d D:\projects\sentinel-tactical-radar
set SENTINEL_NO_TG=1
title SENTINEL-RAPID
:loop
node scripts\rapid.mjs
echo [rapid] exited %errorlevel% - respawning in 10s
timeout /t 10 /nobreak >nul
goto loop
