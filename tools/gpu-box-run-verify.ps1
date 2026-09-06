# ASCII only on purpose: PowerShell 5.1 reads BOM-less UTF-8 as ANSI, and Chinese
# comments get mangled into broken string literals. Keep every remote .ps1 ASCII.
$ErrorActionPreference = 'Continue'
$Root = 'C:\Shotflow\subject-matting-worker'
Set-Location $Root
$envVars = @{}
Get-Content "$Root\.env" | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*$') { return }
  $pair = $_ -split '=', 2
  if ($pair.Length -eq 2) { $envVars[$pair[0].Trim()] = $pair[1].Trim() }
}
foreach ($k in $envVars.Keys) { [Environment]::SetEnvironmentVariable($k, $envVars[$k], 'Process') }
$py = $envVars['SUBJECT_MATTING_PYTHON']
if (-not $py) { $py = 'C:\Shotflow\moge-worker\.venv\Scripts\python.exe' }

$log = "$Root\logs\stage-8093.log"
Remove-Item $log -ErrorAction SilentlyContinue
Remove-Item "$log.err" -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $py -ArgumentList '-m','uvicorn','app:app','--host','127.0.0.1','--port','8093' -WorkingDirectory $Root -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
Write-Output ("staged pid=" + $proc.Id)

$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8093/health' -TimeoutSec 5
    Write-Output ('health: ' + ($r | ConvertTo-Json -Compress))
    $up = $true
    break
  } catch { }
}
if (-not $up) {
  Write-Output 'port 8093 did not come up. log:'
  if (Test-Path $log) { Get-Content $log -Tail 20 }
  if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 20 }
} else {
  $env:VERIFY_PORT = '8093'
  & $py "$Root\gpu_box_verify_semantic.py" "$Root\logs\tc-test.png"
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Write-Output ('=== stopped staged pid=' + $proc.Id)
