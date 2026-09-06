# ASCII only (PowerShell 5.1 + BOM-less UTF-8 = mangled strings).
$Root = 'C:\Shotflow\subject-matting-worker'
$junk = @(
  "$Root\logs\tc-test.png",
  "$Root\logs\stage-8093.log",
  "$Root\logs\stage-8093.log.err",
  "$Root\gpu-box-probe.ps1",
  "$Root\gpu-box-stage-8093.ps1",
  "$Root\gpu-box-run-verify.ps1",
  "$Root\gpu_box_verify_semantic.py"
)
foreach ($f in $junk) {
  if (Test-Path $f) { Remove-Item $f -Force; Write-Output ("removed " + $f) }
}
Write-Output '--- worker dir now ---'
Get-ChildItem $Root -Force | ForEach-Object { Write-Output ($_.Name) }
Write-Output '--- live worker on 8092 (should still be the old in-memory code) ---'
try { Invoke-RestMethod -Uri 'http://127.0.0.1:8092/health' -TimeoutSec 8 | ConvertTo-Json -Compress } catch { Write-Output ('8092 ERROR ' + $_.Exception.Message) }
