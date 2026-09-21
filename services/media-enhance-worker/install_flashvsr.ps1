$ErrorActionPreference = 'Stop'

# FlashVSR's official sparse-attention pipeline needs its own Python 3.11 / CUDA
# environment on Windows.  Keep it isolated from SeedVR2 so either engine can be
# upgraded or rolled back without breaking the other one.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $Root 'runtime\flashvsr'
$Repo = Join-Path $RuntimeRoot 'repo'
$Venv = Join-Path $RuntimeRoot '.venv'
$Python = Join-Path $Venv 'Scripts\python.exe'
$Models = Join-Path $RuntimeRoot 'models-v1.1'
$Downloads = Join-Path $RuntimeRoot 'downloads'
$Commit = 'cf910c61a60733e610e9c6e8b607f80c3a6c202b'
$RepoUrl = 'https://github.com/OpenImagingLab/FlashVSR.git'

$BlockSparseName = 'block_sparse_attn-0.0.1+cu128torch2.7cxx11abiFALSE-cp311-cp311-win_amd64.whl'
$BlockSparseUrl = 'https://github.com/lihaoyun6/Block-Sparse-Attention/releases/download/v0.0.1/block_sparse_attn-0.0.1%2Bcu128torch2.7cxx11abiFALSE-cp311-cp311-win_amd64.whl'
$BlockSparseSha256 = '027c2f691e13cb059535373b495b128b8bbda815394b7d8d478dbf264a000685'
$FlashAttnName = 'flash_attn-2.8.1+cu128torch2.7cxx11abiFALSE-cp311-cp311-win_amd64.whl'
$FlashAttnUrl = 'https://github.com/lihaoyun6/Block-Sparse-Attention/releases/download/v0.0.1/flash_attn-2.8.1%2Bcu128torch2.7cxx11abiFALSE-cp311-cp311-win_amd64.whl'
$FlashAttnSha256 = '1b9909703ec56b596f88efb5f2b85931d33232623ea91fc1ee05ec957bf841a4'

function Assert-LastExit([string]$Action) {
  if ($LASTEXITCODE -ne 0) { throw ("FlashVSR install failed while trying to " + $Action + " (exit " + $LASTEXITCODE + ")") }
}

function Get-VerifiedFile([string]$Url, [string]$Path, [string]$Sha256) {
  if (Test-Path -LiteralPath $Path) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -eq $Sha256) {
      Write-Output ("Verified: " + [IO.Path]::GetFileName($Path))
      return
    }
    Remove-Item -LiteralPath $Path -Force
  }
  $partial = $Path + '.part'
  & curl.exe -L --fail --retry 5 --retry-delay 3 --continue-at - --output $partial $Url
  Assert-LastExit ("download " + [IO.Path]::GetFileName($Path))
  $downloaded = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
  if ($downloaded -ne $Sha256) {
    throw ("SHA256 mismatch for " + [IO.Path]::GetFileName($Path))
  }
  Move-Item -LiteralPath $partial -Destination $Path -Force
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $Models, $Downloads | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) {
  & git clone $RepoUrl $Repo
  Assert-LastExit 'clone the official FlashVSR repository'
}
& git -C $Repo fetch --depth 1 origin $Commit
Assert-LastExit 'fetch the pinned FlashVSR commit'
& git -C $Repo checkout --detach $Commit
Assert-LastExit 'check out the pinned FlashVSR commit'
$ActualCommit = (& git -C $Repo rev-parse HEAD).Trim()
if ($ActualCommit -ne $Commit) { throw 'Pinned FlashVSR commit verification failed' }

if (-not (Test-Path -LiteralPath $Python)) {
  & py -3.11 -m venv $Venv
  Assert-LastExit 'create the Python 3.11 environment'
}
& $Python -m pip install --disable-pip-version-check --upgrade pip wheel 'setuptools==80.9.0'
Assert-LastExit 'upgrade pip tooling'
& $Python -m pip install --disable-pip-version-check --index-url https://download.pytorch.org/whl/cu128 torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0
Assert-LastExit 'install CUDA 12.8 PyTorch'

$FilteredRequirements = Join-Path $RuntimeRoot 'requirements-without-torch.txt'
Get-Content -LiteralPath (Join-Path $Repo 'requirements.txt') |
  Where-Object { $_ -notmatch '^torch(?:audio|vision)?==' } |
  Set-Content -Encoding UTF8 -LiteralPath $FilteredRequirements
& $Python -m pip install --disable-pip-version-check -r $FilteredRequirements
Assert-LastExit 'install FlashVSR dependencies'
# The pinned upstream downloader imports ModelScope at module import time but
# omits it from requirements.txt.  Keep the missing dependency explicit and
# pinned so an unrelated latest release cannot change the worker environment.
& $Python -m pip install --disable-pip-version-check 'modelscope==1.29.2'
Assert-LastExit 'install the pinned ModelScope dependency'
# FlashVSR's setup.py still imports pkg_resources.  Setuptools 81+ removed it,
# and build isolation would silently pull the incompatible latest release.
& $Python -m pip install --disable-pip-version-check --no-build-isolation --no-deps -e $Repo
Assert-LastExit 'install the pinned FlashVSR package'

$BlockSparsePath = Join-Path $Downloads $BlockSparseName
$FlashAttnPath = Join-Path $Downloads $FlashAttnName
Get-VerifiedFile $BlockSparseUrl $BlockSparsePath $BlockSparseSha256
Get-VerifiedFile $FlashAttnUrl $FlashAttnPath $FlashAttnSha256
& $Python -m pip install --disable-pip-version-check --force-reinstall --no-deps $BlockSparsePath $FlashAttnPath
Assert-LastExit 'install the pinned Windows sparse-attention wheels'

$Base = 'https://huggingface.co/JunhaoZhuang/FlashVSR-v1.1/resolve/main/'
$ModelFiles = @(
  @('LQ_proj_in.ckpt', 'd6d011cdaaba6a52645086caa08fa04124e746f6ca568140a24007591142bfd2'),
  @('TCDecoder.ckpt', 'e224bdcf2f52745cbf4d393ff5374c2ba09e90285d5d19062d2bf63b915b6161'),
  @('Wan2.1_VAE.pth', '38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981'),
  @('diffusion_pytorch_model_streaming_dmd.safetensors', 'bd28180edcf3446c028e32fc6b731a80bf7e4da2ab4caac3186b9499964d37be')
)
foreach ($entry in $ModelFiles) {
  $name = $entry[0]
  Get-VerifiedFile ($Base + $name + '?download=true') (Join-Path $Models $name) $entry[1]
}

& $Python -c "import torch, block_sparse_attn, flash_attn; assert torch.cuda.is_available(); print('OK: FlashVSR sparse runtime, GPU=' + torch.cuda.get_device_name(0))"
Assert-LastExit 'validate FlashVSR CUDA and sparse attention'
Write-Output ("OK: FlashVSR v1.1 commit " + $Commit + " and all hash-verified models are installed.")
