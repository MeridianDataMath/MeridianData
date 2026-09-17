<#
.SYNOPSIS
    Registers (or updates) the Windows Scheduled Task that publishes the Meridian Predict snapshot
    from this PC every N minutes (see Update-PredictSnapshot.ps1 for why it cannot run on GitHub).

.PARAMETER IntervalMinutes   Default 30. Each run takes 2-3 minutes of paced API calls.
.PARAMETER Uninstall         Remove the task instead.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\Install-SnapshotTask.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\Install-SnapshotTask.ps1 -Uninstall

.NOTES
    Runs as the current user, only while logged on (the cached GitHub credential lives in the user profile).
#>
param([ValidateRange(5, 720)][int]$IntervalMinutes = 30, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$TaskName = 'MeridianData-Predict-Snapshot'
if ($Uninstall) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "[OK] $TaskName removed"; exit 0 }
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $ScriptDir 'Update-PredictSnapshot.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$psArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script
$action = New-ScheduledTaskAction -Execute $psExe -Argument $psArgs -WorkingDirectory (Split-Path -Parent $ScriptDir)
$startAt = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration ([TimeSpan]::FromDays(3650))
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -Description ('Builds the Meridian Predict snapshot from this PC every {0} min and force-pushes it to the "snapshots" branch of the MeridianData repo (GitHub runners are blocked by the Predict API).' -f $IntervalMinutes) | Out-Null
Write-Host ("[OK] {0} every {1} min, first run {2:HH:mm}. Log: logs\snapshot.log" -f $TaskName, $IntervalMinutes, $startAt)
