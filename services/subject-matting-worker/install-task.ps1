# ASCII only: PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#
# One-shot installer: make the subject-matting worker (8092) survive crashes and reboots.
#
# Background (2026-08-21 outage). The old task's own record gave the cause away:
#   LastTaskResult = 3221225786 = 0xC000013A = STATUS_CONTROL_C_EXIT
# The worker process was *terminated*, not crashed. It ran inside an interactive logon
# session, so it died whenever that session ended -- fine for days, then gone after a
# logoff, leaving no log because start.ps1 writes none.
#
# Red herring, recorded so nobody chases it twice: execution policy was NOT involved.
# All scopes read Undefined and the old task already passed -ExecutionPolicy Bypass.
# The policy only blocks manual `& start.ps1` invocations from an ordinary shell.
#
# What this installer changes:
#   - trigger is AtStartup and it runs as SYSTEM (LogonType ServiceAccount), so there is
#     no logon session to lose -- this is the fix for the actual outage
#   - runs run-supervised.ps1, which logs to logs\worker-<date>.log and restarts uvicorn
#     with backoff if it ever exits
#   - keeps -ExecutionPolicy Bypass on the action (the old task had it too; harmless and
#     required for a SYSTEM-launched script)
#   - no execution time limit, and task-level restart as a second net under the
#     supervisor's own restart loop
#
# It deliberately does NOT touch:
#   - the machine-wide execution policy (that is a shared GPU box; that call belongs to
#     the owner and IT, not to this script)
#   - the moge worker on 8091 (currently healthy; leave it alone)
#
# Run as Administrator:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Shotflow\subject-matting-worker\install-task.ps1

$ErrorActionPreference = 'Continue'

$TaskName = 'ShotflowSubjectMattingWorker'
$Root = 'C:\Shotflow\subject-matting-worker'
$Supervisor = Join-Path $Root 'run-supervised.ps1'
$Port = 8092

function Fail([string]$message) {
  Write-Output ('FAILED: ' + $message)
  exit 1
}

# --- preflight ---------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'must run in an elevated (Administrator) PowerShell' }
if (-not (Test-Path $Supervisor)) { Fail ('supervisor script not found at ' + $Supervisor) }

Write-Output '=== execution policy (this is what broke startup) ==='
Get-ExecutionPolicy -List | Format-Table -AutoSize | Out-String | Write-Output

Write-Output '=== existing task state (before) ==='
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  $existing | Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Output
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($info) {
    Write-Output ('  LastRunTime=' + $info.LastRunTime + '  LastTaskResult=' + $info.LastTaskResult)
  }
  Write-Output ('  old action: ' + (($existing.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' ; '))
} else {
  Write-Output '  (task does not exist yet)'
}

# --- stop whatever is running now, including a foreground debug run ----------
Write-Output '=== releasing port 8092 ==='
try {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conns) {
    foreach ($c in $conns) {
      Write-Output ('  stopping pid ' + $c.OwningProcess)
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
  } else {
    Write-Output '  nothing listening'
  }
} catch { Write-Output ('  ' + $_.Exception.Message) }

if ($existing) {
  Write-Output '=== unregistering old task ==='
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

# --- register ----------------------------------------------------------------
Write-Output '=== registering task ==='
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Supervisor + '"') `
  -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM avoids storing any password. GPU compute does not need an interactive session.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
# ExecutionTimeLimit must be zero, otherwise the task scheduler kills a long-running
# worker after the default 3 days.
$settings.ExecutionTimeLimit = 'PT0S'

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Shotflow subject-matting / semantic-parts worker on port 8092 (supervised, auto-restart, logs to logs\worker-<date>.log)' `
    -Force -ErrorAction Stop | Out-Null
  Write-Output '  registered'
} catch {
  Fail ('Register-ScheduledTask: ' + $_.Exception.Message)
}

# --- start and verify --------------------------------------------------------
Write-Output '=== starting ==='
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

$up = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 5 -ErrorAction Stop
    Write-Output ('health after ' + (($i + 1) * 3) + 's: ' + ($r | ConvertTo-Json -Compress))
    $up = $true
    break
  } catch { }
}

Write-Output '=== result ==='
if ($up) {
  Write-Output 'OK: worker is listening on 8092 and answering /health'
  Write-Output ('logs: ' + (Join-Path $Root 'logs'))
  Write-Output 'reboot behaviour: task trigger is AtStartup, running as SYSTEM'
  Write-Output 'crash behaviour: supervisor restarts uvicorn with backoff; task restarts the supervisor'
} else {
  Write-Output 'PROBLEM: no /health response within 180s.'
  Write-Output ('Read the tail of ' + (Join-Path $Root 'logs') + ' to see why uvicorn is exiting.')
  $latest = Get-ChildItem (Join-Path $Root 'logs') -Filter 'worker-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) {
    Write-Output ('--- tail of ' + $latest.Name + ' ---')
    Get-Content $latest.FullName -Tail 40 | Write-Output
  }
}

Write-Output '=== task state (after) ==='
Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
  Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Output
