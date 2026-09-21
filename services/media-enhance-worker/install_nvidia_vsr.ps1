$ErrorActionPreference = 'Stop'

# NVIDIA distributes the Video Effects SDK Python binding as a proprietary
# wheel through its package index. Keep it in the existing CUDA/PyTorch venv so
# frame transfer stays on the GPU and the lightweight FastAPI venv stays small.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root 'runtime\seedvr2\.venv\Scripts\python.exe'
$Version = '0.1.0.1'

if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  throw 'SeedVR2 CUDA Python is missing; install SeedVR2 before NVIDIA VSR.'
}

& $Python -m pip install --disable-pip-version-check ("nvidia-vfx==" + $Version)
if ($LASTEXITCODE -ne 0) {
  throw ("nvidia-vfx installation failed with exit code " + $LASTEXITCODE)
}

& $Python -c "import torch; from nvvfx import VideoSuperRes; assert torch.cuda.is_available(); print('OK: nvidia-vfx $Version, GPU=' + torch.cuda.get_device_name(0) + ', quality=' + VideoSuperRes.QualityLevel.ULTRA.name)"
if ($LASTEXITCODE -ne 0) {
  throw 'nvidia-vfx import or CUDA validation failed'
}
