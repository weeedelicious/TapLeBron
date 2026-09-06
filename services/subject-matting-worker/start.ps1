$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (Test-Path "$Root\.env") {
  Get-Content "$Root\.env" | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*$') { return }
    $pair = $_ -split '=', 2
    if ($pair.Length -eq 2) {
      [Environment]::SetEnvironmentVariable($pair[0].Trim(), $pair[1].Trim(), "Process")
    }
  }
}

if (-not $env:HF_HOME) {
  $env:HF_HOME = Join-Path $Root "models\hf"
}

$SharedPython = "C:\Shotflow\moge-worker\.venv\Scripts\python.exe"
$Python = $env:SUBJECT_MATTING_PYTHON
if ((-not $Python -or $Python -ieq "C:\Program Files\Python311\python.exe") -and (Test-Path $SharedPython)) {
  $Python = $SharedPython
}
if (-not $Python) {
  if (-not (Test-Path "$Root\.venv\Scripts\python.exe")) {
    & "C:\Program Files\Python311\python.exe" -m venv "$Root\.venv"
  }
  $Python = "$Root\.venv\Scripts\python.exe"
}

& $Python -m uvicorn app:app --host 0.0.0.0 --port 8092
