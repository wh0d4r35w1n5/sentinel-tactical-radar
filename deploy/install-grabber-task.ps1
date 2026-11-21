$me = "$env:USERDOMAIN\$env:USERNAME"
$act = New-ScheduledTaskAction -Execute 'D:\projects\sentinel-tactical-radar\deploy\arm-grabber-launch.cmd'
$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $me
Register-ScheduledTask -TaskName 'SentinelArmGrabber' -Action $act -Trigger @($t1,$t2) -User $me -Force | Select-Object -ExpandProperty TaskName
Get-ScheduledTask -TaskName 'SentinelArmGrabber' | Select-Object TaskName,State
