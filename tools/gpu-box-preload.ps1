# ASCII only.
$Root = 'C:\Shotflow\subject-matting-worker'
$envVars = @{}
Get-Content "$Root\.env" | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*$') { return }
  $pair = $_ -split '=', 2
  if ($pair.Length -eq 2) { $envVars[$pair[0].Trim()] = $pair[1].Trim() }
}
$tok = $envVars['SUBJECT_MATTING_API_TOKEN']
$h = @{}
if ($tok) { $h['Authorization'] = 'Bearer ' + $tok }
try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8092/v1/semantic-parts/preload' -Method Post -Headers $h -TimeoutSec 900
  Write-Output ('semantic preload: ' + ($r | ConvertTo-Json -Compress))
} catch { Write-Output ('semantic preload FAILED: ' + $_.Exception.Message) }
try {
  $r2 = Invoke-RestMethod -Uri 'http://127.0.0.1:8092/v1/preload' -Method Post -Headers $h -TimeoutSec 900
  Write-Output ('matting preload: ' + ($r2 | ConvertTo-Json -Compress))
} catch { Write-Output ('matting preload FAILED: ' + $_.Exception.Message) }
Invoke-RestMethod -Uri 'http://127.0.0.1:8092/health' -TimeoutSec 10 | ConvertTo-Json -Compress
