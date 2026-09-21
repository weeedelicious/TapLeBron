param(
  [string]$InstallDir = (Join-Path $PSScriptRoot 'runtime')
)

$ErrorActionPreference = 'Stop'
$releaseUrl = 'https://github.com/nihui/realsr-ncnn-vulkan/releases/download/20220728/realsr-ncnn-vulkan-20220728-windows.zip'
$expectedSha256 = 'DB77CA8247642E2B694F1CE0FED3D91F557B75464FF343F5168465FE414223B3'
$stageDir = Join-Path ([IO.Path]::GetTempPath()) ('shotflow-realsr-install-' + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $stageDir 'realsr.zip'
$unpackDir = Join-Path $stageDir 'unpacked'

try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  & curl.exe -L --fail --retry 3 --output $zipPath $releaseUrl
  if ($LASTEXITCODE -ne 0) {
    throw "RealSR download failed with exit code $LASTEXITCODE"
  }

  $actualSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
  if ($actualSha256 -ne $expectedSha256) {
    throw "RealSR archive hash mismatch. Expected $expectedSha256, got $actualSha256"
  }

  Expand-Archive -LiteralPath $zipPath -DestinationPath $unpackDir
  $sourceDir = Get-ChildItem -LiteralPath $unpackDir -Directory | Select-Object -First 1
  if (-not $sourceDir) {
    throw 'RealSR archive has no package directory'
  }
  $required = @(
    'realsr-ncnn-vulkan.exe',
    'models-DF2K\x4.param',
    'models-DF2K\x4.bin',
    'LICENSE'
  )
  foreach ($relativePath in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir.FullName $relativePath))) {
      throw "RealSR archive is missing $relativePath"
    }
  }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $sourceDir.FullName '*') -Destination $InstallDir -Recurse -Force
  Write-Output "RealSR installed to $((Resolve-Path -LiteralPath $InstallDir).Path)"
  Write-Output "Archive SHA256: $actualSha256"
} finally {
  if (Test-Path -LiteralPath $stageDir) {
    $resolvedStage = (Resolve-Path -LiteralPath $stageDir).Path
    $resolvedTemp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
    if ($resolvedStage.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
  }
}
