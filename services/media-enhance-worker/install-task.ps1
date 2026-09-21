# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
# Run once as Administrator on the 4090 worker machine.

$ErrorActionPreference = 'Continue'
$TaskName = 'ShotflowMediaEnhanceWorker'
$Root = 'C:\Shotflow\media-enhance-worker'
$Supervisor = Join-Path $Root 'run-supervised.ps1'
$Port = 8093
$FirewallRule = 'Shotflow Media Enhance Worker 8093'
$ShotflowServer = '172.25.135.159'

function Fail([string]$message) {
  Write-Output ('FAILED: ' + $message)
  exit 1
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'must run in an elevated (Administrator) PowerShell' }
if (-not (Test-Path $Supervisor)) { Fail ('supervisor not found: ' + $Supervisor) }
if (-not (Test-Path (Join-Path $Root '.venv\Scripts\python.exe'))) { Fail 'worker venv is missing' }
if (-not (Test-Path (Join-Path $Root 'runtime\realsr-ncnn-vulkan.exe'))) { Fail 'RealSR runtime is missing' }
if (-not (Test-Path (Join-Path $Root '.env'))) { Fail 'worker .env is missing' }

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

try {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  if ($listeners) { Start-Sleep -Seconds 3 }
} catch { }

Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $Port -RemoteAddress $ShotflowServer -Profile Any | Out-Null

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Supervisor + '"') `
  -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$settings.ExecutionTimeLimit = 'PT0S'

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Shotflow RealSR, NVIDIA VSR and SeedVR2 media enhancement worker on port 8093' `
  -Force -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName $TaskName

$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 3
  try {
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 5 -ErrorAction Stop
    if ($health.ok) {
      Write-Output ('health: ' + ($health | ConvertTo-Json -Compress))
      $healthy = $true
      break
    }
  } catch { }
}

if (-not $healthy) { Fail 'worker did not become healthy within 180 seconds; inspect logs' }
Write-Output 'OK: worker is supervised at startup and port 8093 only accepts the Shotflow server.'
