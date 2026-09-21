param(
  [string]$RuntimeDir = (Join-Path $PSScriptRoot 'runtime'),
  [string]$Python = 'python',
  [string]$Ffmpeg = 'ffmpeg',
  [string]$Ffprobe = 'ffprobe',
  [int]$GpuId = 0,
  [int]$TileSize = 512,
  [int]$Port = 18094,
  [ValidateSet('faithful', 'generative', 'nvidia-vsr', 'flashvsr')]
  [string]$EnhanceMode = 'faithful',
  [string]$NvidiaVsrPython = ''
)

$ErrorActionPreference = 'Stop'

function Require-Command([string]$Command, [string]$Label) {
  $resolved = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $resolved) { throw "$Label is not available: $Command" }
  return $resolved.Source
}

function Read-Fps([string]$Value) {
  if ($Value -match '^([0-9.]+)\/([0-9.]+)$') {
    $denominator = [double]$Matches[2]
    if ($denominator -gt 0) { return [double]$Matches[1] / $denominator }
  }
  return [double]$Value
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$workerDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$runtimePath = (Resolve-Path -LiteralPath $RuntimeDir).Path
$realSr = Join-Path $runtimePath 'realsr-ncnn-vulkan.exe'
$modelParam = Join-Path $runtimePath 'models-DF2K\x4.param'
$modelBin = Join-Path $runtimePath 'models-DF2K\x4.bin'
Assert-True (Test-Path -LiteralPath $realSr -PathType Leaf) 'RealSR binary is missing'
Assert-True (Test-Path -LiteralPath $modelParam -PathType Leaf) 'RealSR model param is missing'
Assert-True (Test-Path -LiteralPath $modelBin -PathType Leaf) 'RealSR model bin is missing'

$pythonExe = Require-Command $Python 'Python'
$ffmpegExe = Require-Command $Ffmpeg 'FFmpeg'
$ffprobeExe = Require-Command $Ffprobe 'FFprobe'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('shotflow-media-enhance-smoke-' + [guid]::NewGuid().ToString('N'))
$workDir = Join-Path $tempRoot 'work'
$sourcePath = Join-Path $tempRoot 'source-24fps.mp4'
$resultPath = Join-Path $tempRoot 'enhanced-2x.mp4'
$stdoutPath = Join-Path $tempRoot 'worker.stdout.log'
$stderrPath = Join-Path $tempRoot 'worker.stderr.log'
$token = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$baseUrl = "http://127.0.0.1:$Port"
$workerProcess = $null
$client = $null
$jobId = ''
$savedEnvironment = @{}

try {
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null
  $portBusy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($portBusy) { throw "Port $Port is already in use" }

  foreach ($name in @(
    'MEDIA_ENHANCE_RUNTIME_DIR',
    'MEDIA_ENHANCE_WORK_DIR',
    'MEDIA_ENHANCE_API_TOKEN',
    'MEDIA_ENHANCE_GPU_ID',
    'MEDIA_ENHANCE_TILE_SIZE',
    'FFMPEG_PATH',
    'FFPROBE_PATH',
    'MEDIA_ENHANCE_IMAGE_TTA',
    'MEDIA_ENHANCE_VIDEO_TTA',
    'MEDIA_ENHANCE_VIDEO_CRF',
    'MEDIA_ENHANCE_VIDEO_PRESET',
    'NVIDIA_VSR_PYTHON',
    'NVIDIA_VSR_CUDA_DEVICE',
    'NVIDIA_VSR_QUALITY'
  )) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $env:MEDIA_ENHANCE_RUNTIME_DIR = $runtimePath
  $env:MEDIA_ENHANCE_WORK_DIR = $workDir
  $env:MEDIA_ENHANCE_API_TOKEN = $token
  $env:MEDIA_ENHANCE_GPU_ID = [string]$GpuId
  $env:MEDIA_ENHANCE_TILE_SIZE = [string]$TileSize
  $env:FFMPEG_PATH = $ffmpegExe
  $env:FFPROBE_PATH = $ffprobeExe
  $env:MEDIA_ENHANCE_IMAGE_TTA = '1'
  $env:MEDIA_ENHANCE_VIDEO_TTA = '0'
  $env:MEDIA_ENHANCE_VIDEO_CRF = '12'
  $env:MEDIA_ENHANCE_VIDEO_PRESET = 'slow'
  if ($NvidiaVsrPython) { $env:NVIDIA_VSR_PYTHON = $NvidiaVsrPython }
  $env:NVIDIA_VSR_CUDA_DEVICE = '0'
  $env:NVIDIA_VSR_QUALITY = 'ULTRA'

  $workerProcess = Start-Process -FilePath $pythonExe `
    -ArgumentList @('-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', [string]$Port) `
    -WorkingDirectory $workerDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromMinutes(5)
  $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)

  $healthy = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($workerProcess.HasExited) { break }
    try {
      $healthText = $client.GetStringAsync("$baseUrl/health").GetAwaiter().GetResult()
      $health = $healthText | ConvertFrom-Json
      if ($health.ok -and $health.binaryReady -and $health.modelReady) {
        Assert-True ([int]$health.gpuId -eq $GpuId) 'Temporary worker did not use the requested Vulkan GPU'
        Assert-True ([int]$health.tileSize -eq $TileSize) 'Temporary worker did not use the requested RealSR tile size'
        if ($EnhanceMode -eq 'nvidia-vsr') {
          Assert-True ($health.nvidiaVsrReady -eq $true) 'Temporary worker did not detect NVIDIA VSR'
        }
        if ($EnhanceMode -eq 'flashvsr') {
          Assert-True ($health.flashVsrReady -eq $true) 'Temporary worker did not detect FlashVSR'
        }
        $healthy = $true
        break
      }
    } catch { }
  }
  if (-not $healthy) {
    $workerError = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { '' }
    throw "Temporary worker did not become healthy. $workerError"
  }

  $sourceFrameCount = if ($EnhanceMode -eq 'flashvsr') { 21 } else { 12 }
  & $ffmpegExe -y -v error `
    -f lavfi -i 'testsrc2=size=64x36:rate=24' `
    -f lavfi -i 'sine=frequency=1000:sample_rate=48000' `
    -frames:v $sourceFrameCount -c:v libx264 -profile:v high -pix_fmt yuv420p `
    -c:a aac -b:a 128k -shortest -movflags +faststart $sourcePath
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the smoke-test source video' }

  $sourceStream = [IO.File]::OpenRead($sourcePath)
  $multipart = [System.Net.Http.MultipartFormDataContent]::new()
  try {
    $fileContent = [System.Net.Http.StreamContent]::new($sourceStream)
    $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('video/mp4')
    $multipart.Add($fileContent, 'file', 'source-24fps.mp4')
    $multipart.Add([System.Net.Http.StringContent]::new('video'), 'media_type')
    $multipart.Add([System.Net.Http.StringContent]::new('2'), 'scale')
    $multipart.Add([System.Net.Http.StringContent]::new($EnhanceMode), 'enhance_mode')
    $createResponse = $client.PostAsync("$baseUrl/v1/jobs", $multipart).GetAwaiter().GetResult()
    $createText = $createResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $createResponse.IsSuccessStatusCode) { throw "Worker rejected smoke job: $createText" }
    $jobId = [string](($createText | ConvertFrom-Json).jobId)
  } finally {
    $multipart.Dispose()
    $sourceStream.Dispose()
  }
  Assert-True (-not [string]::IsNullOrWhiteSpace($jobId)) 'Worker did not return a job ID'

  $completed = $null
  $deadline = [DateTime]::UtcNow.AddMinutes(5)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $statusText = $client.GetStringAsync("$baseUrl/v1/jobs/$jobId").GetAwaiter().GetResult()
    $status = $statusText | ConvertFrom-Json
    if ($status.status -eq 'succeeded') { $completed = $status; break }
    if ($status.status -eq 'failed') { throw "Worker smoke job failed: $($status.error)" }
    if ($status.status -eq 'cancelled') { throw 'Worker smoke job was cancelled' }
  }
  Assert-True ($null -ne $completed) 'Worker smoke job timed out'

  $resultBytes = $client.GetByteArrayAsync("$baseUrl/v1/jobs/$jobId/result").GetAwaiter().GetResult()
  [IO.File]::WriteAllBytes($resultPath, $resultBytes)
  Assert-True ((Get-Item -LiteralPath $resultPath).Length -gt 0) 'Worker returned an empty result'

  $probeText = (& $ffprobeExe -v error -count_frames `
    -show_entries 'stream=index,codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate,nb_read_frames,start_time:format=format_name,duration,start_time' `
    -of json $resultPath) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'FFprobe could not inspect the enhanced result' }
  $probe = $probeText | ConvertFrom-Json
  $video = @($probe.streams | Where-Object codec_type -eq 'video')[0]
  $audio = @($probe.streams | Where-Object codec_type -eq 'audio')[0]
  $fps = Read-Fps ([string]$video.avg_frame_rate)

  Assert-True ($video.width -eq 128 -and $video.height -eq 72) 'Enhanced video is not exactly 2x'
  Assert-True ($video.codec_name -eq 'h264') 'Enhanced video codec is not H.264'
  Assert-True ($video.profile -match 'High') 'Enhanced video profile is not H.264 High'
  Assert-True ($video.pix_fmt -eq 'yuv420p') 'Enhanced video pixel format is not yuv420p'
  Assert-True ([math]::Abs($fps - 24) -lt 0.02) 'Enhanced video did not preserve 24fps'
  Assert-True ([int]$video.nb_read_frames -eq $sourceFrameCount) "Enhanced video did not preserve all $sourceFrameCount frames"
  Assert-True ([math]::Abs([double]$video.start_time) -lt 0.001) 'Enhanced video does not start at frame zero'
  Assert-True ([math]::Abs([double]$probe.format.start_time) -lt 0.001) 'Enhanced MP4 timeline does not start at zero'
  Assert-True ($audio.codec_name -eq 'aac') 'Enhanced video did not preserve an AAC audio track'
  Assert-True ($completed.metadata.boundaryFramesVerified -eq $true) 'Worker did not report exact boundary-frame verification'
  Assert-True ($completed.metadata.contentFramesVerified -eq $true) 'Worker did not report enhanced-content verification'
  if ($EnhanceMode -eq 'nvidia-vsr') {
    Assert-True ($completed.metadata.engine -eq 'nvidia-vfx') 'Worker did not report NVIDIA VFX engine'
    Assert-True ($completed.metadata.nvidiaVfxVersion -eq '0.1.0.1') 'Worker reported an unexpected NVIDIA VFX version'
    Assert-True ($completed.metadata.nvidiaVsrQuality -eq 'ULTRA') 'Worker did not use NVIDIA VSR ULTRA quality'
  }
  if ($EnhanceMode -eq 'flashvsr') {
    Assert-True ($completed.metadata.engine -eq 'flashvsr') 'Worker did not report FlashVSR engine'
    Assert-True ($completed.metadata.model -eq 'FlashVSR v1.1 Tiny Long') 'Worker reported an unexpected FlashVSR model'
    Assert-True ($completed.metadata.flashVsrVersion -eq 'v1.1') 'Worker reported an unexpected FlashVSR version'
    Assert-True ($completed.metadata.flashVsrPipeline -eq 'tiny-long') 'Worker reported an unexpected FlashVSR pipeline'
  }

  foreach ($frame in @(0, ($sourceFrameCount - 1))) {
    $framePath = Join-Path $tempRoot "boundary-$frame.png"
    & $ffmpegExe -y -v error -i $resultPath -map '0:v:0' `
      -vf "select=eq(n\,$frame)" -fps_mode vfr -frames:v 1 $framePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $framePath) -or (Get-Item -LiteralPath $framePath).Length -lt 1) {
      throw "Could not decode exact output frame $frame"
    }
  }

  [pscustomobject]@{
    ok = $true
    width = [int]$video.width
    height = [int]$video.height
    fps = $fps
    frameCount = [int]$video.nb_read_frames
    codec = [string]$video.codec_name
    profile = [string]$video.profile
    pixelFormat = [string]$video.pix_fmt
    audioCodec = [string]$audio.codec_name
    boundaryFramesVerified = [bool]$completed.metadata.boundaryFramesVerified
    contentFramesVerified = [bool]$completed.metadata.contentFramesVerified
    enhanceMode = [string]$completed.metadata.enhanceMode
    engine = [string]$completed.metadata.engine
    model = [string]$completed.metadata.model
    nvidiaVfxVersion = [string]$completed.metadata.nvidiaVfxVersion
    nvidiaVsrQuality = [string]$completed.metadata.nvidiaVsrQuality
    flashVsrVersion = [string]$completed.metadata.flashVsrVersion
    flashVsrPipeline = [string]$completed.metadata.flashVsrPipeline
  } | ConvertTo-Json -Compress
} finally {
  if ($client -and $jobId) {
    try { $client.DeleteAsync("$baseUrl/v1/jobs/$jobId").GetAwaiter().GetResult().Dispose() } catch { }
  }
  if ($client) { $client.Dispose() }
  if ($workerProcess -and -not $workerProcess.HasExited) {
    Stop-Process -Id $workerProcess.Id -Force -ErrorAction SilentlyContinue
    $workerProcess.WaitForExit(5000) | Out-Null
  }
  foreach ($entry in $savedEnvironment.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
  if (Test-Path -LiteralPath $tempRoot) {
    $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
    $expectedPrefix = [IO.Path]::GetFullPath((Join-Path $tempBase 'shotflow-media-enhance-smoke-'))
    if ($resolvedTemp.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
  }
}
