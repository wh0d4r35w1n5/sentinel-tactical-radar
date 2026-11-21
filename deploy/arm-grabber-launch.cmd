@echo off
powershell -NoProfile -Command "if (-not (Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" ^| Where-Object { $_.CommandLine -like '*arm-grabber.sh*' })) { Start-Process -FilePath 'C:\Program Files\Git\bin\bash.exe' -ArgumentList 'D:/projects/sentinel-tactical-radar/deploy/arm-grabber.sh' -WorkingDirectory 'D:\projects\sentinel-tactical-radar' -WindowStyle Hidden }"
