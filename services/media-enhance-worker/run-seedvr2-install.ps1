$ErrorActionPreference = 'Stop'
$statusPath = 'C:\Shotflow\media-enhance-worker\logs\seedvr2-install-status.json'
$logPath = 'C:\Shotflow\media-enhance-worker\logs\seedvr2-install-task.log'
function Write-Status([string]$Status, [string]$Message) {
  [ordered]@{ status = $Status; message = $Message; updatedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json -Compress |
    Set-Content -Encoding UTF8 -LiteralPath $statusPath
}
Write-Status 'running' 'Installing pinned SeedVR2 runtime and verified models'
Start-Transcript -Path $logPath -Append | Out-Null
try {
  & 'C:\Shotflow\media-enhance-worker\install_seedvr2.ps1' -Root 'C:\Shotflow\media-enhance-worker'
  Write-Status 'succeeded' 'SeedVR2 install completed'
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-Output ('INSTALL_FAILED: ' + $message)
  Write-Status 'failed' $message
  exit 1
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}
