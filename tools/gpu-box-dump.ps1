# ASCII only: PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
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
$log = "$Root\logs\dump.log"
$proc = Start-Process -FilePath $py -ArgumentList '-m','uvicorn','app:app','--host','127.0.0.1','--port','8093' -WorkingDirectory $Root -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
$up = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try { Invoke-RestMethod -Uri 'http://127.0.0.1:8093/health' -TimeoutSec 5 | Out-Null; $up = $true; break } catch { }
}
if (-not $up) { Write-Output 'port 8093 down'; if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 15 } }
else {
  $env:VERIFY_PORT = '8093'
  & $py "$Root\gpu_box_dump_classmap.py" "$Root\logs\tc_source.png" "$Root\logs\tc_classmap.png"
}
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue
Write-Output 'done'
