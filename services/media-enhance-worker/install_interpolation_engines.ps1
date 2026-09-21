param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) { $Root = $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root)
$Runtime = Join-Path $Root 'runtime'
$Downloads = Join-Path $Runtime 'downloads'
$OpenFlowRoot = Join-Path $Runtime 'openflowframes'
$OpenFlowRepo = Join-Path $OpenFlowRoot 'repo'
$OpenFlowCommit = 'f9b5087291a691dc02444b7d9dcff05033905a4d'
$OpenFlowUrl = 'https://github.com/ZeroHackz/OpenFlowFrames.git'
$Video2XRoot = Join-Path $Runtime 'video2x-6.4.0'
$Video2XZip = Join-Path $Downloads 'video2x-windows-amd64-6.4.0.zip'
$Video2XUrl = 'https://github.com/k4yt3x/video2x/releases/download/6.4.0/video2x-windows-amd64.zip'
$Video2XZipSha256 = '0337b6dcae2bad2fd13e43fbdb73ef728d2f6289f37cc3617e87ac3a1a5cf793'

function Assert-LastExit([string]$Action) {
  if ($LASTEXITCODE -ne 0) {
    throw ('Frame interpolation install failed while trying to ' + $Action + ' (exit ' + $LASTEXITCODE + ')')
  }
}

function Assert-FileHash([string]$Path, [string]$Sha256) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw ('Required file is missing: ' + $Path)
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256.ToLowerInvariant()) {
    throw ('SHA256 mismatch: ' + $Path + '; got ' + $actual)
  }
  Write-Output ('Verified: ' + $Path)
}

foreach ($command in @('git.exe', 'curl.exe')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw ($command + ' is not available')
  }
}
New-Item -ItemType Directory -Force -Path $Runtime, $Downloads, $OpenFlowRoot | Out-Null

if (Test-Path -LiteralPath (Join-Path $OpenFlowRepo '.git') -PathType Container) {
  $dirty = (& git.exe -C $OpenFlowRepo status --porcelain) -join ''
  Assert-LastExit 'inspect the OpenFlowFrames repository'
  if (-not [string]::IsNullOrWhiteSpace($dirty)) {
    throw ('Managed OpenFlowFrames repository has local changes: ' + $OpenFlowRepo)
  }
  $origin = (& git.exe -C $OpenFlowRepo remote get-url origin).Trim()
  Assert-LastExit 'inspect the OpenFlowFrames origin'
  if ($origin -ne $OpenFlowUrl) { throw ('Unexpected OpenFlowFrames origin: ' + $origin) }
} elseif (Test-Path -LiteralPath $OpenFlowRepo) {
  throw ('OpenFlowFrames path exists but is not a Git checkout: ' + $OpenFlowRepo)
} else {
  & git.exe clone --filter=blob:none --no-checkout $OpenFlowUrl $OpenFlowRepo
  Assert-LastExit 'clone OpenFlowFrames'
}
& git.exe -C $OpenFlowRepo fetch --depth 1 origin $OpenFlowCommit
Assert-LastExit 'fetch the pinned OpenFlowFrames commit'
& git.exe -C $OpenFlowRepo checkout --detach $OpenFlowCommit
Assert-LastExit 'check out the pinned OpenFlowFrames commit'
$head = (& git.exe -C $OpenFlowRepo rev-parse HEAD).Trim()
Assert-LastExit 'read the OpenFlowFrames commit'
if ($head -ne $OpenFlowCommit) { throw ('OpenFlowFrames commit mismatch: ' + $head) }

$OpenFlowRife = Join-Path $OpenFlowRepo 'packages\rife-ncnn'
Assert-FileHash (Join-Path $OpenFlowRife 'rife-ncnn-vulkan.exe') 'e9b9d5db05ce5d6c411044527c8428a4be33a7ce27a77ee8a6caf6532eb6182d'
Assert-FileHash (Join-Path $OpenFlowRife 'rife-v4.26\flownet.bin') '94d58e30b75d7c7609cfa6f3bdad524deddd14f5f75e85c36d2f827ef5c64731'
Assert-FileHash (Join-Path $OpenFlowRife 'rife-v4.26\flownet.param') '79f16c28903f93f8308f0c4c947f8c7e0c17d99a57b85473e5f298dd578d137b'

if (-not (Test-Path -LiteralPath $Video2XZip -PathType Leaf) -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Video2XZip).Hash.ToLowerInvariant() -ne $Video2XZipSha256) {
  $partial = $Video2XZip + '.partial'
  & curl.exe -fL --retry 8 --retry-delay 5 --retry-all-errors `
    --continue-at - --output $partial $Video2XUrl
  Assert-LastExit 'download Video2X 6.4.0'
  Assert-FileHash $partial $Video2XZipSha256
  Move-Item -LiteralPath $partial -Destination $Video2XZip -Force
}
Assert-FileHash $Video2XZip $Video2XZipSha256

$video2xValid = (Test-Path -LiteralPath (Join-Path $Video2XRoot 'video2x.exe') -PathType Leaf)
if ($video2xValid) {
  try {
    Assert-FileHash (Join-Path $Video2XRoot 'video2x.exe') '251bc8a40801133affccc99deb9d5c95a80e63b6fe69af27d994a7bc0a77eeed'
    Assert-FileHash (Join-Path $Video2XRoot 'models\rife\rife-v4.26\flownet.bin') '94d58e30b75d7c7609cfa6f3bdad524deddd14f5f75e85c36d2f827ef5c64731'
    Assert-FileHash (Join-Path $Video2XRoot 'models\rife\rife-v4.26\flownet.param') 'a08a2bbe1cff44baad19a3ba9cef2a7b5db47b02300386de2422e5fc9f8459f2'
  } catch {
    $video2xValid = $false
  }
}
if (-not $video2xValid) {
  $staging = Join-Path $Runtime ('video2x-staging-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Expand-Archive -LiteralPath $Video2XZip -DestinationPath $staging -Force
  if (Test-Path -LiteralPath $Video2XRoot) {
    $backup = $Video2XRoot + '.invalid-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item -LiteralPath $Video2XRoot -Destination $backup
  }
  Move-Item -LiteralPath $staging -Destination $Video2XRoot
}
Assert-FileHash (Join-Path $Video2XRoot 'video2x.exe') '251bc8a40801133affccc99deb9d5c95a80e63b6fe69af27d994a7bc0a77eeed'
Assert-FileHash (Join-Path $Video2XRoot 'models\rife\rife-v4.26\flownet.bin') '94d58e30b75d7c7609cfa6f3bdad524deddd14f5f75e85c36d2f827ef5c64731'
Assert-FileHash (Join-Path $Video2XRoot 'models\rife\rife-v4.26\flownet.param') 'a08a2bbe1cff44baad19a3ba9cef2a7b5db47b02300386de2422e5fc9f8459f2'

$savedErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$devices = (& (Join-Path $OpenFlowRife 'rife-ncnn-vulkan.exe') -l 2>&1) -join "`n"
$ErrorActionPreference = $savedErrorActionPreference
# This upstream binary intentionally returns -1 after listing devices, so its
# text output is the reliable readiness signal rather than the exit code.
if ($devices -notmatch 'NVIDIA GeForce RTX 4090') {
  throw 'OpenFlowFrames could not see the NVIDIA GeForce RTX 4090'
}
& (Join-Path $Video2XRoot 'video2x.exe') --version | Out-Null
Assert-LastExit 'load Video2X 6.4.0'
Write-Output ('OK: OpenFlowFrames ' + $OpenFlowCommit + ' and Video2X 6.4.0 are installed.')
