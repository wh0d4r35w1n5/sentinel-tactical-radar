@echo off
rem Sentinel rapid daemon launcher — HKCU Run key target (every logon)
rem Respawns the daemon if node ever exits; rapid.mjs itself keeps
rem tg-watch.py alive while it runs.
cd /d D:\projects\sentinel-tactical-radar
title SENTINEL-RAPID
:loop
node scripts\rapid.mjs
echo [rapid] exited %errorlevel% — respawning in 10s
timeout /t 10 /nobreak >nul
goto loop
