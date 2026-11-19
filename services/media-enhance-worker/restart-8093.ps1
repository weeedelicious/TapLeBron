
$ErrorActionPreference = 'Stop'
$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'uvicorn app:app' -and $_.CommandLine -match '--port 8093' })
Write-Output ("MATCH " + $procs.Count)
if ($procs.Count -lt 1) { exit 1 }
foreach ($p in $procs) {
  Write-Output ("KILL {0} parent={1} {2}" -f $p.ProcessId, $p.ParentProcessId, $p.Name)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
$still = @(Get-NetTCPConnection -LocalPort 8093 -State Listen -ErrorAction SilentlyContinue)
if ($still.Count -gt 0) {
  Write-Output 'STILL_LISTEN'
  $still | ForEach-Object { Write-Output ("PID " + $_.OwningProcess) }
  exit 1
}
$outLog = 'C:\Shotflow\media-enhance-worker\start-restart.out.log'
$errLog = 'C:\Shotflow\media-enhance-worker\start-restart.err.log'
if (Test-Path -LiteralPath $outLog) { Remove-Item -LiteralPath $outLog -Force }
if (Test-Path -LiteralPath $errLog) { Remove-Item -LiteralPath $errLog -Force }
Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Shotflow\media-enhance-worker\start.ps1' -WorkingDirectory 'C:\Shotflow\media-enhance-worker' -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Write-Output 'STARTED'
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8093/health -TimeoutSec 3
    $spec = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8093/openapi.json -TimeoutSec 3
    $has = $spec.Content.Contains('/v1/ui-removal-jobs')
    Write-Output ("TRY {0} health={1} hasRoute={2}" -f $i, $health.StatusCode, $has)
    if ($health.StatusCode -eq 200 -and $has) { $ok = $true; break }
  } catch {
    Write-Output ("TRY {0} {1}" -f $i, $_.Exception.Message)
  }
}
if (-not $ok) {
  Write-Output '--- out log ---'
  if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Tail 50 }
  Write-Output '--- err log ---'
  if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Tail 50 }
  exit 2
}
$listen = @(Get-NetTCPConnection -LocalPort 8093 -State Listen -ErrorAction SilentlyContinue)
$listen | ForEach-Object { Write-Output ("LISTEN " + $_.OwningProcess) }
