$ErrorActionPreference = 'Continue'
Write-Output '=== 8092 process ==='
$conn = Get-NetTCPConnection -LocalPort 8092 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess) -ErrorAction SilentlyContinue
  Write-Output ("PID=" + $c.OwningProcess)
  Write-Output ("CMD=" + $p.CommandLine)
  Write-Output ("START=" + $p.CreationDate)
  $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction SilentlyContinue
  Write-Output ("OWNER=" + $owner.Domain + "\" + $owner.User)
  Write-Output ("PARENT=" + $p.ParentProcessId)
  $pp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue
  Write-Output ("PARENTCMD=" + $pp.CommandLine)
}
Write-Output '=== 8091 process ==='
$conn91 = Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn91) { Write-Output ("PID=" + $c.OwningProcess) }
Write-Output '=== services matching shotflow/matting/moge ==='
Get-Service | Where-Object { $_.Name -match 'shot' -or $_.Name -match 'matting' -or $_.Name -match 'moge' } | ForEach-Object { Write-Output ($_.Name + ' ' + $_.Status + ' ' + $_.StartType) }
Write-Output '=== scheduled tasks matching shotflow/worker ==='
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'shot' -or $_.TaskName -match 'worker' -or $_.TaskName -match 'matting' -or $_.TaskName -match 'moge' } | ForEach-Object { Write-Output ($_.TaskName + ' | ' + $_.State + ' | ' + $_.TaskPath) }
Write-Output '=== worker dir ==='
Get-ChildItem 'C:\Shotflow\subject-matting-worker' -Force | ForEach-Object { Write-Output ($_.Length.ToString().PadLeft(10) + '  ' + $_.Name) }
Write-Output '=== .env keys (values hidden) ==='
if (Test-Path 'C:\Shotflow\subject-matting-worker\.env') {
  Get-Content 'C:\Shotflow\subject-matting-worker\.env' | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*$') { return }
    $k = ($_ -split '=', 2)[0].Trim()
    if ($k -match 'TOKEN|KEY|SECRET|PASSWORD') { Write-Output ($k + '= <hidden>') } else { Write-Output $_ }
  }
} else { Write-Output 'no .env' }
Write-Output '=== HF cache ==='
$hf = 'C:\Shotflow\subject-matting-worker\models\hf'
if ($env:HF_HOME) { Write-Output ('HF_HOME env=' + $env:HF_HOME) }
Write-Output ('default path exists: ' + (Test-Path $hf))
if (Test-Path $hf) { Get-ChildItem $hf -Directory -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  ' + $_.Name) } }
