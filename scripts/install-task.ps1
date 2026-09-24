$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "D:\projects\sentinel-tactical-radar\run-rapid.cmd"'
$t = New-ScheduledTaskTrigger -AtLogOn
$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'SentinelRapid' -Action $a -Trigger $t -Settings $s -Force | Select-Object TaskName, State
