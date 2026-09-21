# Shotflow AI 高清增强 Worker

这个服务给 Shotflow 图片/视频节点提供离线 2x / 4x 增强。它不是 NVIDIA DLSS：普通 JPG/MP4 没有 DLSS 所需的深度、运动矢量和渲染缓冲。视频节点提供三种模式，图片节点继续使用原有两种模式：

- **NVIDIA RTX 视频超分（视频）**：官方 Video Effects SDK VideoSuperRes，执行超分、去噪和去压缩瑕疵，不生成不存在的细节。
- **生成式细节**：SeedVR2 7B Sharp FP8，按连续视频帧重建皮肤、发丝、材质与自然光影；会轻微重绘像素。
- **FlashVSR 电影级细节（视频）**：官方 v1.1 Tiny Long 一步扩散管线和完整 Block-Sparse Attention，强化皮肤、发丝、布料和材质细节；4× 是官方推荐档。
- **忠实放大（图片及旧任务）**：RealSR NCNN/Vulkan，只恢复已有纹理，不重画内容。
- **OpenFlowFrames 补帧**：固定 OpenFlowFrames commit，使用 RIFE 4.26 直接生成精确目标总帧数；24fps→30fps 不先升到 48fps 再丢帧。
- **Video2X 补帧**：固定 Video2X 6.4.0，使用 RIFE 4.26 先生成无损高帧率中间视频，再按时间轴精确输出 30fps。

## 引擎与输出合同

- 忠实引擎：[nihui/realsr-ncnn-vulkan](https://github.com/nihui/realsr-ncnn-vulkan)（MIT）
- 固定 Release：`20220728`
- Windows ZIP SHA256：`DB77CA8247642E2B694F1CE0FED3D91F557B75464FF343F5168465FE414223B3`
- NVIDIA 引擎：`nvidia-vfx==0.1.0.1`（NVIDIA 专有许可），质量档 `ULTRA`
- 生成式引擎：[numz/ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler)（Apache-2.0）
- FlashVSR 引擎：[OpenImagingLab/FlashVSR](https://github.com/OpenImagingLab/FlashVSR) v1.1（Apache-2.0），锁定 commit `cf910c61a60733e610e9c6e8b607f80c3a6c202b`
- OpenFlowFrames：[ZeroHackz/OpenFlowFrames](https://github.com/ZeroHackz/OpenFlowFrames)（GPL-3.0），锁定 commit `f9b5087291a691dc02444b7d9dcff05033905a4d`
- Video2X：[k4yt3x/video2x](https://github.com/k4yt3x/video2x)（AGPL-3.0），锁定正式版 `6.4.0`
- 固定 Commit：`4490bd1f482e026674543386bb2a4d176da245b9`
- 生成式模型：`seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors`，SHA256 `0d2c5b8be0fda94351149c5115da26aef4f4932a7a2a928c6f184dda9186e0be`
- VAE：`ema_vae_fp16.safetensors`，SHA256 `20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1`
- 图片：PNG；2x/4x；透明图保留 Alpha；默认开启 TTA
- 视频：AI 阶段先输出无损 PNG 帧，再统一编码；帧数、帧率、时长和音轨保持不变
- 视频交付：H.264 High、yuv420p、MP4、CRF 12、preset slow、faststart，兼容 RV
- 交付前会核对尺寸、帧数、帧率、音轨，并实际解码第一帧和最后一帧

2x 不是让模型直接输出 2x：RealSR 先做 4x 推理，再用 Lanczos 回采样到精确 2x，细节质量优先。

## Windows 4090 安装

```powershell
cd services\media-enhance-worker
.\install_realsr.ps1
.\install_seedvr2.ps1
.\install_nvidia_vsr.ps1
.\install_flashvsr.ps1
.\install_interpolation_engines.ps1
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

设置一个长随机令牌后启动：

```powershell
$env:MEDIA_ENHANCE_API_TOKEN = 'replace-with-a-long-random-token'
# 先用 realsr-ncnn-vulkan -h 核对 Vulkan 设备编号。
# 当前 Shotflow 4090 机器的 0 是 Intel 核显，1 才是 RTX 4090。
$env:MEDIA_ENHANCE_GPU_ID = '1'
$env:MEDIA_ENHANCE_TILE_SIZE = '512'
$env:MEDIA_ENHANCE_IMAGE_TTA = '1'
$env:MEDIA_ENHANCE_VIDEO_TTA = '0'
$env:MEDIA_ENHANCE_VIDEO_CRF = '12'
$env:MEDIA_ENHANCE_VIDEO_PRESET = 'slow'
$env:NVIDIA_VSR_QUALITY = 'ULTRA'
$env:NVIDIA_VSR_CUDA_DEVICE = '0'
$env:SEEDVR2_BATCH_SIZE = '5'
$env:SEEDVR2_CHUNK_SIZE = '45'
$env:SEEDVR2_TEMPORAL_OVERLAP = '4'
$env:SEEDVR2_PREPEND_FRAMES = '4'
$env:SEEDVR2_BLOCKS_TO_SWAP = '36'
.\.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8093
```

生产环境把目录放到 `C:\Shotflow\media-enhance-worker`，将令牌等参数写入该目录的
`.env`（不要提交），然后用管理员 PowerShell 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Shotflow\media-enhance-worker\install-task.ps1
```

安装脚本会注册 `ShotflowMediaEnhanceWorker` 开机任务（SYSTEM）、用监督脚本自动拉起
崩溃进程，并建立只允许 Shotflow 服务器 `172.25.135.159` 访问 8093 的防火墙规则。

## 健康检查

```powershell
curl.exe -H "Authorization: Bearer $env:MEDIA_ENHANCE_API_TOKEN" http://127.0.0.1:8093/health
```

`ok` 必须为 `true`，并且 `binaryReady`、`modelReady`、`ffmpegReady`、`ffprobeReady`、`tokenConfigured` 都应为 `true`。视频工具上线前还必须看到 `nvidiaVsrReady`、`seedvr2Ready`、`flashVsrReady`、`openFlowFramesReady`、`video2xReady` 为 `true`。

## 端到端冒烟测试

部署前后都可以在独立临时端口跑一次真实视频任务；脚本会生成一段 24fps、12 帧、带 AAC
音轨的小视频，执行 2x 增强，并核对尺寸、帧率、帧数、音轨、RV 编码及精确首尾帧解码。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\smoke-test.ps1 `
  -RuntimeDir .\runtime `
  -Python .\.venv\Scripts\python.exe `
  -Ffmpeg C:\Users\User\rife-web\ffmpeg.exe `
  -Ffprobe C:\Users\User\rife-web\ffprobe.exe `
  -GpuId 1 `
  -TileSize 512
```

成功时输出一行 `{"ok":true,...}`；临时 Worker、素材和结果会在测试结束后自动清理。

## 可调环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MEDIA_ENHANCE_RUNTIME_DIR` | `./runtime` | RealSR 与模型目录 |
| `MEDIA_ENHANCE_WORK_DIR` | `./work` | 临时任务目录 |
| `MEDIA_ENHANCE_MAX_UPLOAD_MB` | `4096` | 单文件上限 |
| `MEDIA_ENHANCE_MAX_OUTPUT_PIXELS` | `134217728` | 输出总像素上限 |
| `MEDIA_ENHANCE_JOB_TTL_SECONDS` | `21600` | 已完成任务保留时间 |
| `MEDIA_ENHANCE_CONCURRENCY` | `1` | GPU 并发；生产建议保持 1 |
| `MEDIA_ENHANCE_GPU_ID` | `0` | Vulkan 设备编号；必须先用 `realsr-ncnn-vulkan -h` 核对，不要假定 0 是 NVIDIA |
| `MEDIA_ENHANCE_TILE_SIZE` | `512` | RealSR 分块尺寸；512 已在当前 RTX 4090 机器验证 |
| `MEDIA_ENHANCE_IMAGE_TTA` | `1` | 图片 TTA，质量更高但约慢 8 倍 |
| `MEDIA_ENHANCE_VIDEO_TTA` | `0` | 视频 TTA，默认关闭避免极慢 |
| `MEDIA_ENHANCE_VIDEO_CRF` | `12` | H.264 质量参数 |
| `MEDIA_ENHANCE_VIDEO_PRESET` | `slow` | H.264 编码 preset |
| `NVIDIA_VSR_PYTHON` | SeedVR2 venv Python | 安装了 CUDA PyTorch 与 `nvidia-vfx` 的 Python |
| `NVIDIA_VSR_QUALITY` | `ULTRA` | NVIDIA VideoSuperRes 画质档 |
| `NVIDIA_VSR_CUDA_DEVICE` | `0` | CUDA 设备编号；与 RealSR 的 Vulkan 编号不是同一套编号 |
| `SEEDVR2_ROOT` | `./runtime/seedvr2` | 固定代码、独立 venv 和模型根目录 |
| `SEEDVR2_BATCH_SIZE` | `5` | 连续帧批量，必须满足 4n+1 |
| `SEEDVR2_CHUNK_SIZE` | `45` | 长视频流式处理块大小 |
| `SEEDVR2_TEMPORAL_OVERLAP` | `4` | 批次/分块时间重叠，减少接缝 |
| `SEEDVR2_PREPEND_FRAMES` | `4` | 反向前置帧，降低首帧异常 |
| `SEEDVR2_BLOCKS_TO_SWAP` | `36` | 7B 模型 CPU BlockSwap 数量，适配 24GB 4090 |
| `SEEDVR2_VAE_ENCODE_TILE` | `1024` | VAE 编码瓦片尺寸 |
| `SEEDVR2_VAE_DECODE_TILE` | `768` | VAE 解码瓦片尺寸 |
| `SEEDVR2_TILE_OVERLAP` | `128` | VAE 瓦片重叠 |

## API

- `GET /health`
- `POST /v1/jobs`：multipart，字段 `file`、`scale`（2/4）、`media_type`（image/video）、`enhance_mode`（faithful/generative/nvidia-vsr/flashvsr；省略时为 faithful；nvidia-vsr/flashvsr 仅视频）
- `POST /v1/interpolation-jobs`：multipart，字段 `file`、`target_fps`（30/60/120）、`interpolation_engine`（openflowframes/video2x）
- `GET /v1/jobs/{jobId}`
- `GET /v1/jobs/{jobId}/result`
- `DELETE /v1/jobs/{jobId}`

除健康检查外的示例也建议始终带 `Authorization: Bearer ...`；服务对所有接口都执行同一令牌校验。
