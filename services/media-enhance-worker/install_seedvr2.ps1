# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
# Installs a pinned SeedVR2 CLI and hash-verified models beside this worker.

param(
  [string]$Root = '',
  [string]$PythonLauncher = 'py'
)

$ErrorActionPreference = 'Stop'
# The pinned CLI prints Unicode status symbols during module import. Windows
# scheduled tasks otherwise inherit a GBK console and Python exits before the
# real --help self-check with UnicodeEncodeError.
$env:PYTHONUTF8 = '1'
$env:PYTHONUNBUFFERED = '1'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root)
$SeedRoot = Join-Path $Root 'runtime\seedvr2'
$Repo = Join-Path $SeedRoot 'repo'
$Venv = Join-Path $SeedRoot '.venv'
$Models = Join-Path $SeedRoot 'models'
$Commit = '4490bd1f482e026674543386bb2a4d176da245b9'
$RepoUrl = 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git'
$DitName = 'seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors'
$DitSha256 = '0d2c5b8be0fda94351149c5115da26aef4f4932a7a2a928c6f184dda9186e0be'
$VaeName = 'ema_vae_fp16.safetensors'
$VaeSha256 = '20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1'
$DitUrl = 'https://huggingface.co/AInVFX/SeedVR2_comfyUI/resolve/main/' + $DitName + '?download=true'
$VaeUrl = 'https://huggingface.co/numz/SeedVR2_comfyUI/resolve/main/' + $VaeName + '?download=true'

function Fail([string]$Message) {
  throw ('SeedVR2 install failed: ' + $Message)
}

function Assert-LastExit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { Fail ($Step + ' (exit ' + $LASTEXITCODE + ')') }
}

function Install-VerifiedFile(
  [string]$Url,
  [string]$Destination,
  [string]$ExpectedSha256
) {
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    $ExistingSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant()
    if ($ExistingSha -eq $ExpectedSha256) {
      Write-Output ('verified existing model: ' + [IO.Path]::GetFileName($Destination))
      return
    }
    $Invalid = $Destination + '.invalid-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item -LiteralPath $Destination -Destination $Invalid
    Write-Output ('moved invalid model aside: ' + [IO.Path]::GetFileName($Invalid))
  }

  $Partial = $Destination + '.partial'
  Write-Output ('downloading: ' + [IO.Path]::GetFileName($Destination))
  & curl.exe -fL --retry 8 --retry-delay 5 --retry-all-errors `
    --continue-at - --output $Partial $Url
  Assert-LastExit ('download ' + [IO.Path]::GetFileName($Destination))
  $ActualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $Partial).Hash.ToLowerInvariant()
  if ($ActualSha -ne $ExpectedSha256) {
    Fail ('SHA256 mismatch for ' + [IO.Path]::GetFileName($Destination) +
      '; expected ' + $ExpectedSha256 + ', got ' + $ActualSha)
  }
  Move-Item -LiteralPath $Partial -Destination $Destination -Force
  Write-Output ('verified downloaded model: ' + [IO.Path]::GetFileName($Destination))
}

foreach ($Command in @('git.exe', 'curl.exe')) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    Fail ($Command + ' is not available')
  }
}
New-Item -ItemType Directory -Force -Path $SeedRoot, $Models | Out-Null

if (Test-Path -LiteralPath (Join-Path $Repo '.git') -PathType Container) {
  $Dirty = (& git.exe -C $Repo status --porcelain) -join ''
  Assert-LastExit 'inspect repository'
  if (-not [string]::IsNullOrWhiteSpace($Dirty)) {
    Fail ('managed repository has local changes: ' + $Repo)
  }
  $Origin = (& git.exe -C $Repo remote get-url origin).Trim()
  Assert-LastExit 'inspect repository origin'
  if ($Origin -ne $RepoUrl) { Fail ('unexpected repository origin: ' + $Origin) }
} elseif (Test-Path -LiteralPath $Repo) {
  Fail ('repository path exists but is not a Git checkout: ' + $Repo)
} else {
  & git.exe clone --filter=blob:none --no-checkout $RepoUrl $Repo
  Assert-LastExit 'clone repository'
}

& git.exe -C $Repo fetch --depth 1 origin $Commit
Assert-LastExit 'fetch pinned commit'
& git.exe -C $Repo checkout --detach $Commit
Assert-LastExit 'checkout pinned commit'
$Head = (& git.exe -C $Repo rev-parse HEAD).Trim()
Assert-LastExit 'read checked-out commit'
if ($Head -ne $Commit) { Fail ('repository is not at pinned commit: ' + $Head) }

if (-not (Test-Path -LiteralPath (Join-Path $Venv 'Scripts\python.exe') -PathType Leaf)) {
  & $PythonLauncher -3.12 -m venv $Venv
  Assert-LastExit 'create Python 3.12 virtual environment'
}
$Python = Join-Path $Venv 'Scripts\python.exe'
& $Python -m pip install --upgrade 'pip==25.2' 'setuptools==80.9.0' 'wheel==0.45.1'
Assert-LastExit 'install Python packaging tools'
& $Python -m pip install --index-url 'https://download.pytorch.org/whl/cu128' `
  'torch==2.9.1+cu128' 'torchvision==0.24.1+cu128'
Assert-LastExit 'install pinned CUDA PyTorch'
& $Python -m pip install -r (Join-Path $Repo 'requirements.txt')
Assert-LastExit 'install SeedVR2 dependencies'

Install-VerifiedFile $DitUrl (Join-Path $Models $DitName) $DitSha256
Install-VerifiedFile $VaeUrl (Join-Path $Models $VaeName) $VaeSha256

$Manifest = [ordered]@{
  repository = $RepoUrl
  commit = $Commit
  ditModel = $DitName
  ditSha256 = $DitSha256
  vaeModel = $VaeName
  vaeSha256 = $VaeSha256
  torch = '2.9.1+cu128'
  torchvision = '0.24.1+cu128'
}
$Manifest | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $SeedRoot 'install-manifest.json')

& $Python (Join-Path $Repo 'inference_cli.py') --help | Out-Null
Assert-LastExit 'load SeedVR2 CLI'
Write-Output ('OK: SeedVR2 ' + $Commit + ' and both models are installed and verified.')
