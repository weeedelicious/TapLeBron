# ASCII only: PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#
# Supervisor for the subject-matting worker (port 8092).
#
# Why this exists: start.ps1 runs uvicorn in the foreground with no log file and no
# restart. On 2026-08-21 the worker was down for hours and there was nothing to look at
# -- no log, no exit code -- because the process had died with its console.
#
# What actually killed it (confirmed from the old task's LastTaskResult):
#   3221225786 = 0xC000013A = STATUS_CONTROL_C_EXIT
# That is "the process was terminated", not a crash, not CUDA OOM, not a bad checkpoint.
# The old task ran uvicorn inside an interactive logon session, so the worker died
# whenever that session ended. It could stay up for days and then vanish when someone
# logged off, with no trace.
#
# NOTE: execution policy was NOT the cause. All scopes were Undefined and the old task
# already passed -ExecutionPolicy Bypass. The policy only blocks *manual* `& start.ps1`
# invocations, which is a red herring worth writing down so nobody chases it again.
#
# This script closes the three gaps:
#   1. every line of worker output goes to logs\worker-<date>.log
#   2. if uvicorn exits for any reason, restart it (with backoff, so a hard failure
#      like CUDA OOM does not turn into a hot loop)
#   3. the task that launches it runs as SYSTEM at startup, so there is no logon
#      session to lose -- this is the part that fixes the actual outage
#
# Run manually for debugging:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Shotflow\subject-matting-worker\run-supervised.ps1

$ErrorActionPreference = 'Continue'

$Root = 'C:\Shotflow\subject-matting-worker'
$Port = 8092
$LogDir = Join-Path $Root 'logs'
$LogRetentionDays = 14

# Restart backoff. Reset to MIN once the process has stayed up long enough to be
# considered healthy; otherwise double up to MAX so a permanent failure (bad model
# checkpoint, no GPU memory) does not spin the CPU or spam the log.
$BackoffMinSeconds = 5
$BackoffMaxSeconds = 300
$HealthyUptimeSeconds = 120

Set-Location $Root
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-LogPath {
  Join-Path $LogDir ('worker-' + (Get-Date -Format 'yyyyMMdd') + '.log')
}

function Write-Log([string]$message) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] [supervisor] ' + $message
  try { Add-Content -Path (Get-LogPath) -Value $line -Encoding UTF8 } catch { }
  Write-Output $line
}

# --- log rotation: drop anything older than the retention window -------------
try {
  $cutoff = (Get-Date).AddDays(-$LogRetentionDays)
  Get-ChildItem -Path $LogDir -Filter 'worker-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    Remove-Item -Force -ErrorAction SilentlyContinue
} catch { }

Write-Log 'supervisor starting'

# --- .env into the process environment (same contract as start.ps1) ----------
if (Test-Path (Join-Path $Root '.env')) {
  Get-Content (Join-Path $Root '.env') | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*$') { return }
    $pair = $_ -split '=', 2
    if ($pair.Length -eq 2) {
      [Environment]::SetEnvironmentVariable($pair[0].Trim(), $pair[1].Trim(), 'Process')
    }
  }
  Write-Log '.env loaded'
} else {
  Write-Log 'no .env found (continuing)'
}

if (-not $env:HF_HOME) {
  $env:HF_HOME = Join-Path $Root 'models\hf'
}
Write-Log ('HF_HOME=' + $env:HF_HOME)

# --- resolve python: prefer the shared moge venv, same as start.ps1 ----------
$SharedPython = 'C:\Shotflow\moge-worker\.venv\Scripts\python.exe'
$Python = $env:SUBJECT_MATTING_PYTHON
if ((-not $Python -or $Python -ieq 'C:\Program Files\Python311\python.exe') -and (Test-Path $SharedPython)) {
  $Python = $SharedPython
}
if (-not $Python) {
  if (-not (Test-Path (Join-Path $Root '.venv\Scripts\python.exe'))) {
    Write-Log 'no venv found and no shared python; cannot start'
    exit 1
  }
  $Python = Join-Path $Root '.venv\Scripts\python.exe'
}
if (-not (Test-Path $Python)) {
  Write-Log ('python not found at ' + $Python)
  exit 1
}
Write-Log ('python=' + $Python)

# --- free the port if something is squatting on it ---------------------------
# Usually a leftover foreground run from a debugging session. Without this the new
# uvicorn would fail to bind and the supervisor would loop forever on a port clash.
try {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    Write-Log ('port ' + $Port + ' already held by pid ' + $c.OwningProcess + '; stopping it')
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  if ($conns) { Start-Sleep -Seconds 3 }
} catch { }

# --- supervise ---------------------------------------------------------------
$backoff = $BackoffMinSeconds
while ($true) {
  $log = Get-LogPath
  Write-Log 'starting uvicorn on 0.0.0.0:8092'
  $startedAt = Get-Date

  # *>> captures stdout, stderr and every other stream into the daily log.
  & $Python -m uvicorn app:app --host 0.0.0.0 --port $Port *>> $log
  $code = $LASTEXITCODE

  $uptime = [int]((Get-Date) - $startedAt).TotalSeconds
  Write-Log ('uvicorn exited code=' + $code + ' after ' + $uptime + 's')

  if ($uptime -ge $HealthyUptimeSeconds) {
    $backoff = $BackoffMinSeconds
  } else {
    $backoff = [Math]::Min($backoff * 2, $BackoffMaxSeconds)
  }

  Write-Log ('restarting in ' + $backoff + 's')
  Start-Sleep -Seconds $backoff
}
