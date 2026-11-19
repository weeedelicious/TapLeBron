# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vendor = Join-Path $Root 'vendor'
New-Item -ItemType Directory -Force -Path $Vendor | Out-Null

function Ensure-Repo([string]$Url, [string]$Dest) {
  if (Test-Path (Join-Path $Dest 'run.py')) {
    Write-Host "repo ready $Dest"
    return
  }
  git clone --depth 1 $Url $Dest
}

function Ensure-Venv([string]$Dest, [string]$Requirements) {
  $Python = Join-Path $Dest '.venv\Scripts\python.exe'
  if (-not (Test-Path $Python)) {
    py -3.11 -m venv (Join-Path $Dest '.venv')
  }
  & $Python -m pip install --upgrade pip
  & $Python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
  if (Test-Path $Requirements) {
    & $Python -m pip install -r $Requirements
    & $Python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
  }
  & $Python -m pip install imageio imageio-ffmpeg
}

function Download-File([string]$Url, [string]$Dest) {
  if ((Test-Path $Dest) -and ((Get-Item $Dest).Length -gt 1000000)) {
    Write-Host "weight ready $Dest"
    return
  }
  $tmp = $Dest + '.partial'
  curl.exe -L --fail --retry 5 --retry-all-errors -o $tmp $Url
  Move-Item -Force $tmp $Dest
}

Ensure-Repo 'https://github.com/DepthAnything/Video-Depth-Anything.git' (Join-Path $Vendor 'Video-Depth-Anything')
Ensure-Repo 'https://github.com/Tencent/DepthCrafter.git' (Join-Path $Vendor 'DepthCrafter')
Ensure-Venv (Join-Path $Vendor 'Video-Depth-Anything') (Join-Path $Vendor 'Video-Depth-Anything\requirements.txt')
Ensure-Venv (Join-Path $Vendor 'DepthCrafter') (Join-Path $Vendor 'DepthCrafter\requirements.txt')

$Vda = Join-Path $Vendor 'Video-Depth-Anything'
$Dc = Join-Path $Vendor 'DepthCrafter'
$Ckpt = Join-Path $Vda 'checkpoints'
New-Item -ItemType Directory -Force -Path $Ckpt | Out-Null
Download-File 'https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/video_depth_anything_vits.pth' (Join-Path $Ckpt 'video_depth_anything_vits.pth')
Download-File 'https://huggingface.co/depth-anything/Video-Depth-Anything-Base/resolve/main/video_depth_anything_vitb.pth' (Join-Path $Ckpt 'video_depth_anything_vitb.pth')
Download-File 'https://huggingface.co/depth-anything/Video-Depth-Anything-Large/resolve/main/video_depth_anything_vitl.pth' (Join-Path $Ckpt 'video_depth_anything_vitl.pth')

$DcPython = Join-Path $Dc '.venv\Scripts\python.exe'
& $DcPython -m pip install huggingface_hub
& $DcPython -c "from huggingface_hub import snapshot_download; snapshot_download('tencent/DepthCrafter'); snapshot_download('stabilityai/stable-video-diffusion-img2vid-xt')"

Write-Host 'VIDEO_DEPTH_INSTALL_OK'
Write-Host ('VIDEO_DEPTH_ANYTHING_ROOT=' + $Vda)
Write-Host ('VIDEO_DEPTH_ANYTHING_PYTHON=' + (Join-Path $Vda '.venv\Scripts\python.exe'))
Write-Host ('DEPTHCRAFTER_ROOT=' + $Dc)
Write-Host ('DEPTHCRAFTER_PYTHON=' + $DcPython)
