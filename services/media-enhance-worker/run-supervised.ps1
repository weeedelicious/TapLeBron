# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
# Supervise the RealSR / NVIDIA VSR / SeedVR2 worker across crashes and logoff.

$ErrorActionPreference = 'Continue'
$Root = 'C:\Shotflow\media-enhance-worker'
$Port = 8093
$LogDir = Join-Path $Root 'logs'
$LogRetentionDays = 14
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

try {
  $cutoff = (Get-Date).AddDays(-$LogRetentionDays)
  Get-ChildItem -Path $LogDir -Filter 'worker-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    Remove-Item -Force -ErrorAction SilentlyContinue
} catch { }

Write-Log 'supervisor starting'

if (Test-Path (Join-Path $Root '.env')) {
  Get-Content (Join-Path $Root '.env') | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $pair = $_ -split '=', 2
    if ($pair.Length -eq 2) {
      [Environment]::SetEnvironmentVariable($pair[0].Trim(), $pair[1].Trim(), 'Process')
    }
  }
  Write-Log '.env loaded'
} else {
  Write-Log 'no .env found; worker cannot authenticate requests'
}

$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) {
  Write-Log ('python not found: ' + $Python)
  exit 1
}

try {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Write-Log ('port ' + $Port + ' held by pid ' + $listener.OwningProcess + '; stopping it')
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  if ($listeners) { Start-Sleep -Seconds 3 }
} catch { }

$backoff = $BackoffMinSeconds
while ($true) {
  $log = Get-LogPath
  Write-Log 'starting uvicorn on 0.0.0.0:8093'
  $startedAt = Get-Date
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
