# ASCII only: PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
# Restart the subject-matting worker so the new /v1/semantic-parts endpoint goes live.
$ErrorActionPreference = 'Continue'
$conn = Get-NetTCPConnection -LocalPort 8092 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) {
  Write-Output ("stopping pid " + $c.OwningProcess)
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
Write-Output 'starting scheduled task ShotflowSubjectMattingWorker'
Start-ScheduledTask -TaskName 'ShotflowSubjectMattingWorker' -ErrorAction SilentlyContinue
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8092/health' -TimeoutSec 5
    Write-Output ('health: ' + ($r | ConvertTo-Json -Compress))
    $up = $true
    break
  } catch { }
}
if (-not $up) { Write-Output 'WORKER DID NOT COME BACK on 8092' }
