# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
# Installs pinned GMFSS Fortuna and GIMM-VFI R-P runtimes beside this worker.

param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONUNBUFFERED = '1'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root)
$Downloads = Join-Path $Root 'runtime\downloads'
$GmfssRoot = Join-Path $Root 'runtime\gmfss-fortuna'
$GmfssRepo = Join-Path $GmfssRoot 'repo'
$GmfssVenv = Join-Path $GmfssRoot '.venv'
$GmfssModels = Join-Path $GmfssRepo 'train_log'
$GimmRoot = Join-Path $Root 'runtime\gimmvfi'
$GimmRepo = Join-Path $GimmRoot 'repo'
$GimmVenv = Join-Path $GimmRoot '.venv'
$GimmCkpt = Join-Path $GimmRepo 'pretrained_ckpt'
$GmfssUrl = 'https://github.com/98mxr/GMFSS_Fortuna.git'
$GimmUrl = 'https://github.com/GSeanCDAT/GIMM-VFI.git'
$TorchIndex = 'https://download.pytorch.org/whl/cu128'

function Fail([string]$Message) { throw ('Interpolation engine install failed: ' + $Message) }
function Assert-LastExit([string]$Step) { if ($LASTEXITCODE -ne 0) { Fail ($Step + ' (exit ' + $LASTEXITCODE + ')') } }

function Install-VerifiedFile([string]$Url, [string]$Destination, [string]$ExpectedSha256) {
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    $ExistingSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant()
    if ($ExistingSha -eq $ExpectedSha256) {
      Write-Output ('verified existing: ' + [IO.Path]::GetFileName($Destination))
      return
    }
    Move-Item -LiteralPath $Destination -Destination ($Destination + '.invalid') -Force
  }
  $Partial = $Destination + '.partial'
  Write-Output ('downloading: ' + [IO.Path]::GetFileName($Destination))
  & curl.exe -fL --retry 8 --retry-delay 5 --retry-all-errors --continue-at - --output $Partial $Url
  Assert-LastExit ('download ' + [IO.Path]::GetFileName($Destination))
  $ActualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $Partial).Hash.ToLowerInvariant()
  if ($ActualSha -ne $ExpectedSha256) {
    Fail ('SHA256 mismatch for ' + [IO.Path]::GetFileName($Destination) + '; expected ' + $ExpectedSha256 + ', got ' + $ActualSha)
  }
  Move-Item -LiteralPath $Partial -Destination $Destination -Force
  Write-Output ('verified: ' + [IO.Path]::GetFileName($Destination))
}

function Ensure-Repo([string]$Url, [string]$RepoPath) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RepoPath) | Out-Null
  if (Test-Path -LiteralPath (Join-Path $RepoPath '.git') -PathType Container) {
    & git.exe -C $RepoPath fetch --depth 1 origin
    Assert-LastExit ('fetch ' + $RepoPath)
    & git.exe -C $RepoPath reset --hard origin/HEAD
    Assert-LastExit ('reset ' + $RepoPath)
  } else {
    if (Test-Path -LiteralPath $RepoPath) { Fail ('path exists but is not a git checkout: ' + $RepoPath) }
    & git.exe clone --depth 1 $Url $RepoPath
    Assert-LastExit ('clone ' + $Url)
  }
  $head = (& git.exe -C $RepoPath rev-parse HEAD).Trim()
  Write-Output ('repo ' + $RepoPath + ' @ ' + $head)
  return $head
}

function Ensure-Venv([string]$VenvPath, [string]$PythonExe) {
  if (-not (Test-Path -LiteralPath (Join-Path $VenvPath 'Scripts\python.exe'))) {
    & $PythonExe -m venv $VenvPath
    Assert-LastExit ('create venv ' + $VenvPath)
  }
  $Pip = Join-Path $VenvPath 'Scripts\python.exe'
  & $Pip -m pip install --upgrade pip setuptools wheel
  Assert-LastExit ('upgrade pip in ' + $VenvPath)
  return $Pip
}

foreach ($command in @('git.exe', 'curl.exe')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { Fail ($command + ' is not available') }
}

$PythonLauncher = $null
foreach ($candidate in @('C:\Users\User\Shotflow\media-enhance-worker\runtime\seedvr2\.venv\Scripts\python.exe'.Replace('C:\Users\User\Shotflow','C:\Shotflow'), 'C:\Shotflow\media-enhance-worker\runtime\seedvr2\.venv\Scripts\python.exe')) {
  if (Test-Path -LiteralPath $candidate) { $PythonLauncher = $candidate; break }
}
if (-not $PythonLauncher) {
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) { $PythonLauncher = 'py' } else { $PythonLauncher = 'python' }
}

New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
$GmfssHead = Ensure-Repo $GmfssUrl $GmfssRepo
$GimmHead = Ensure-Repo $GimmUrl $GimmRepo
New-Item -ItemType Directory -Force -Path $GmfssModels, $GimmCkpt | Out-Null
Set-Content -LiteralPath (Join-Path $GmfssRoot 'COMMIT.txt') -Value $GmfssHead -Encoding ascii
Set-Content -LiteralPath (Join-Path $GimmRoot 'COMMIT.txt') -Value $GimmHead -Encoding ascii

Install-VerifiedFile 'https://huggingface.co/x0unmaze/gmfss/resolve/main/gmfss/flownet.pkl' (Join-Path $GmfssModels 'flownet.pkl') '31fa34960d6326f231c35db9070728419dbad78b463567601dfb6b34049789ef'
Install-VerifiedFile 'https://huggingface.co/x0unmaze/gmfss/resolve/main/gmfss/metric.pkl' (Join-Path $GmfssModels 'metric.pkl') '488d3ec1d7cfb04e84ee5a733b03086beb995cd3a51099d65e7a6e01e662fa16'
Install-VerifiedFile 'https://huggingface.co/x0unmaze/gmfss/resolve/main/gmfss/feat.pkl' (Join-Path $GmfssModels 'feat.pkl') '7442a19d7e2eda6c8f70ddb5b477cb00ae311626355a84393189d8f4d4b1f03c'
Install-VerifiedFile 'https://huggingface.co/x0unmaze/gmfss/resolve/main/gmfss/fusionnet.pkl' (Join-Path $GmfssModels 'fusionnet.pkl') '58809ca28e2594bfbef49d68d8e675a33c477cee05d18d4c75035010019c68bf'
Install-VerifiedFile 'https://huggingface.co/GSean/GIMM-VFI/resolve/main/gimmvfi_r_arb_lpips.pt' (Join-Path $GimmCkpt 'gimmvfi_r_arb_lpips.pt') 'b33e41536850594c01551978c4b63b1acd291c60d22310fbb6a4e57ac375033f'
Install-VerifiedFile 'https://huggingface.co/GSean/GIMM-VFI/resolve/main/raft-things.pth' (Join-Path $GimmCkpt 'raft-things.pth') 'fcfa4125d6418f4de95d84aec20a3c5f4e205101715a79f193243c186ac9a7e1'

if ($PythonLauncher -eq 'py') {
  $BasePython = 'py'
  $GmfssPy = Ensure-Venv $GmfssVenv $BasePython
} else {
  $GmfssPy = Ensure-Venv $GmfssVenv $PythonLauncher
}
& $GmfssPy -m pip install torch torchvision --index-url $TorchIndex
Assert-LastExit 'install GMFSS torch'
& $GmfssPy -m pip install numpy opencv-python pillow tqdm
Assert-LastExit 'install GMFSS python deps'

$GimmPy = Ensure-Venv $GimmVenv $(if ($PythonLauncher -eq 'py') { 'py' } else { $PythonLauncher })
& $GimmPy -m pip install torch torchvision --index-url $TorchIndex
Assert-LastExit 'install GIMM torch'
& $GimmPy -m pip install numpy opencv-python pillow tqdm omegaconf einops pyyaml easydict timm scipy natsort loguru huggingface-hub cupy-cuda12x
Assert-LastExit 'install GIMM python deps'

& $GmfssPy -c "import torch; assert torch.cuda.is_available(), 'GMFSS torch has no CUDA'"
Assert-LastExit 'verify GMFSS CUDA'
& $GimmPy -c "import torch, cupy; assert torch.cuda.is_available(), 'GIMM torch has no CUDA'"
Assert-LastExit 'verify GIMM CUDA'
Write-Output 'OK: GMFSS Fortuna and GIMM-VFI R-P runtimes are installed'
