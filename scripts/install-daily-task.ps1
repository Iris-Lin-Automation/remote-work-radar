$ProjectDir = Split-Path -Parent $PSScriptRoot
$TaskName = "RemoteWorkRadarDaily"
$NodeCommand = "npm"
$Arguments = "run scan"

$Action = New-ScheduledTaskAction -Execute $NodeCommand -Argument $Arguments -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -Daily -At 9:00AM
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Fetch remote async job opportunities and generate a daily report." -Force

Write-Host "Installed task: $TaskName"
Write-Host "Project: $ProjectDir"
Write-Host "Daily run: 09:00"
