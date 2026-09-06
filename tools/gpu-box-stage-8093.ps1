# 用新 app.py 在 8093 起一个临时实例做验证，不动 8092 上正在服务的那个。
# uvicorn 在进程启动时读 app.py，所以同一个目录、同一份文件，两个进程各跑各的代码版本。
$ErrorActionPreference = 'Stop'
$Root = 'C:\Shotflow\subject-matting-worker'
Set-Location $Root
$envVars = @{}
Get-Content "$Root\.env" | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*$') { return }
  $pair = $_ -split '=', 2
  if ($pair.Length -eq 2) { $envVars[$pair[0].Trim()] = $pair[1].Trim() }
}
$assign = ($envVars.GetEnumerator() | ForEach-Object { '$env:' + $_.Key + '=' + "'" + $_.Value + "'" }) -join '; '
$py = $envVars['SUBJECT_MATTING_PYTHON']
if (-not $py) { $py = 'C:\Shotflow\moge-worker\.venv\Scripts\python.exe' }
$inner = "$assign; Set-Location '$Root'; & '$py' -m uvicorn app:app --host 127.0.0.1 --port 8093 *> '$Root\logs\stage-8093.log'"
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-Command', $inner -WindowStyle Hidden
Start-Sleep -Seconds 6
Write-Output 'started; log tail:'
if (Test-Path "$Root\logs\stage-8093.log") { Get-Content "$Root\logs\stage-8093.log" -Tail 12 }
