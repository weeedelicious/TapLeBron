"""
Shotflow AI media enhancement worker.

This is deliberately not branded as NVIDIA DLSS.  DLSS consumes render-time
motion/depth buffers that a normal MP4 does not contain.  Video jobs can use
the official NVIDIA RTX Video Super Resolution effect or SeedVR2 generative
detail reconstruction.  FlashVSR v1.1 provides a second generative video
path with the official sparse-attention pipeline.  Legacy/image jobs keep
RealSR NCNN/Vulkan support.
"""

from __future__ import annotations

import hmac
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse


ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = Path(os.environ.get("MEDIA_ENHANCE_RUNTIME_DIR", ROOT / "runtime")).resolve()
WORK_DIR = Path(os.environ.get("MEDIA_ENHANCE_WORK_DIR", ROOT / "work")).resolve()
REALSR_BIN = Path(
    os.environ.get(
        "REALSR_BIN",
        RUNTIME_DIR / ("realsr-ncnn-vulkan.exe" if os.name == "nt" else "realsr-ncnn-vulkan"),
    )
).resolve()
REALSR_MODEL_DIR = Path(
    os.environ.get("REALSR_MODEL_DIR", RUNTIME_DIR / "models-DF2K")
).resolve()
SEEDVR2_ROOT = Path(
    os.environ.get("SEEDVR2_ROOT", RUNTIME_DIR / "seedvr2")
).resolve()
SEEDVR2_REPO = Path(
    os.environ.get("SEEDVR2_REPO", SEEDVR2_ROOT / "repo")
).resolve()
SEEDVR2_PYTHON = Path(
    os.environ.get(
        "SEEDVR2_PYTHON",
        SEEDVR2_ROOT
        / ".venv"
        / ("Scripts/python.exe" if os.name == "nt" else "bin/python"),
    )
).resolve()
SEEDVR2_CLI = Path(
    os.environ.get("SEEDVR2_CLI", SEEDVR2_REPO / "inference_cli.py")
).resolve()
SEEDVR2_MODEL_DIR = Path(
    os.environ.get("SEEDVR2_MODEL_DIR", SEEDVR2_ROOT / "models")
).resolve()
SEEDVR2_DIT_MODEL = os.environ.get(
    "SEEDVR2_DIT_MODEL",
    "seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors",
).strip()
SEEDVR2_VAE_MODEL = "ema_vae_fp16.safetensors"
SEEDVR2_MODEL_LABEL = "SeedVR2 7B Sharp FP8"
SEEDVR2_COMMIT = "4490bd1f482e026674543386bb2a4d176da245b9"
FLASHVSR_ROOT = Path(
    os.environ.get("FLASHVSR_ROOT", RUNTIME_DIR / "flashvsr")
).resolve()
FLASHVSR_REPO = Path(
    os.environ.get("FLASHVSR_REPO", FLASHVSR_ROOT / "repo")
).resolve()
FLASHVSR_PYTHON = Path(
    os.environ.get(
        "FLASHVSR_PYTHON",
        FLASHVSR_ROOT
        / ".venv"
        / ("Scripts/python.exe" if os.name == "nt" else "bin/python"),
    )
).resolve()
FLASHVSR_CLI = Path(
    os.environ.get("FLASHVSR_CLI", ROOT / "flashvsr_cli.py")
).resolve()
FLASHVSR_MODEL_DIR = Path(
    os.environ.get("FLASHVSR_MODEL_DIR", FLASHVSR_ROOT / "models-v1.1")
).resolve()
FLASHVSR_MODEL_LABEL = "FlashVSR v1.1 Tiny Long"
FLASHVSR_VERSION = "v1.1"
FLASHVSR_COMMIT = "cf910c61a60733e610e9c6e8b607f80c3a6c202b"
FLASHVSR_LOCAL_RANGE = max(9, min(11, int(os.environ.get("FLASHVSR_LOCAL_RANGE", "11"))))
FLASHVSR_SPARSE_RATIO = max(1.0, float(os.environ.get("FLASHVSR_SPARSE_RATIO", "2.0")))
FLASHVSR_CHUNK_FRAMES = max(21, int(os.environ.get("FLASHVSR_CHUNK_FRAMES", "85")))
FLASHVSR_CHUNK_OVERLAP = max(0, int(os.environ.get("FLASHVSR_CHUNK_OVERLAP", "21")))
OPENFLOWFRAMES_ROOT = Path(
    os.environ.get("OPENFLOWFRAMES_ROOT", RUNTIME_DIR / "openflowframes" / "repo")
).resolve()
OPENFLOWFRAMES_RIFE_DIR = Path(
    os.environ.get(
        "OPENFLOWFRAMES_RIFE_DIR",
        OPENFLOWFRAMES_ROOT / "packages" / "rife-ncnn",
    )
).resolve()
OPENFLOWFRAMES_BIN = Path(
    os.environ.get(
        "OPENFLOWFRAMES_BIN",
        OPENFLOWFRAMES_RIFE_DIR / "rife-ncnn-vulkan.exe",
    )
).resolve()
OPENFLOWFRAMES_MODEL = os.environ.get("OPENFLOWFRAMES_MODEL", "rife-v4.26").strip()
OPENFLOWFRAMES_MODEL_LABEL = "OpenFlowFrames · RIFE 4.26"
OPENFLOWFRAMES_COMMIT = "f9b5087291a691dc02444b7d9dcff05033905a4d"
VIDEO2X_ROOT = Path(os.environ.get("VIDEO2X_ROOT", RUNTIME_DIR / "video2x-6.4.0")).resolve()
VIDEO2X_BIN = Path(os.environ.get("VIDEO2X_BIN", VIDEO2X_ROOT / "video2x.exe")).resolve()
VIDEO2X_MODEL = os.environ.get("VIDEO2X_MODEL", "rife-v4.26").strip()
VIDEO2X_MODEL_LABEL = "Video2X 6.4 · RIFE 4.26"
VIDEO2X_VERSION = "6.4.0"
MAX_BATCH_BIN = Path(
    os.environ.get(
        "MAX_BATCH_BIN",
        r"C:\Program Files\Autodesk\3ds Max 2026\3dsmaxbatch.exe",
    )
).resolve()
if not MAX_BATCH_BIN.is_file():
    for _candidate in (
        Path(r"C:\Program Files\Autodesk\3ds Max 2024\3dsmaxbatch.exe"),
        Path(r"C:\Program Files\Autodesk\3ds Max 2026\3dsmaxbatch.exe"),
    ):
        if _candidate.is_file():
            MAX_BATCH_BIN = _candidate
            break
MAX_CONVERTER_TIMEOUT_SECONDS = max(
    60, int(os.environ.get("MAX_CONVERTER_TIMEOUT_SECONDS", "1800"))
)
NVIDIA_VSR_PYTHON = Path(
    os.environ.get("NVIDIA_VSR_PYTHON", SEEDVR2_PYTHON)
).resolve()
NVIDIA_VSR_CLI = Path(
    os.environ.get("NVIDIA_VSR_CLI", ROOT / "nvidia_vsr_cli.py")
).resolve()
NVIDIA_VSR_MODEL_LABEL = "NVIDIA RTX Video Super Resolution"
NVIDIA_VFX_VERSION = "0.1.0.1"
NVIDIA_VSR_QUALITY = os.environ.get("NVIDIA_VSR_QUALITY", "ULTRA").strip().upper()
NVIDIA_VSR_CUDA_DEVICE = max(0, int(os.environ.get("NVIDIA_VSR_CUDA_DEVICE", "0")))
if NVIDIA_VSR_QUALITY not in {
    "BICUBIC",
    "LOW",
    "MEDIUM",
    "HIGH",
    "ULTRA",
    "HIGHBITRATE_LOW",
    "HIGHBITRATE_MEDIUM",
    "HIGHBITRATE_HIGH",
    "HIGHBITRATE_ULTRA",
}:
    raise RuntimeError("NVIDIA_VSR_QUALITY is not a supported upscaling quality level")
FFMPEG_BIN = os.environ.get("FFMPEG_PATH", "ffmpeg")
FFPROBE_BIN = os.environ.get("FFPROBE_PATH", "ffprobe")
API_TOKEN = os.environ.get("MEDIA_ENHANCE_API_TOKEN", "").strip()
GPU_ID = int(os.environ.get("MEDIA_ENHANCE_GPU_ID", "0"))
REALSR_TILE_SIZE = int(os.environ.get("MEDIA_ENHANCE_TILE_SIZE", "512"))
if REALSR_TILE_SIZE != 0 and REALSR_TILE_SIZE < 32:
    raise RuntimeError("MEDIA_ENHANCE_TILE_SIZE must be 0 or at least 32")
MAX_UPLOAD_BYTES = int(float(os.environ.get("MEDIA_ENHANCE_MAX_UPLOAD_MB", "4096")) * 1024 * 1024)
MAX_OUTPUT_PIXELS = int(os.environ.get("MEDIA_ENHANCE_MAX_OUTPUT_PIXELS", "134217728"))
JOB_TTL_SECONDS = max(300, int(os.environ.get("MEDIA_ENHANCE_JOB_TTL_SECONDS", "21600")))
IMAGE_TTA = os.environ.get("MEDIA_ENHANCE_IMAGE_TTA", "1").strip().lower() in {"1", "true", "yes", "on"}
VIDEO_TTA = os.environ.get("MEDIA_ENHANCE_VIDEO_TTA", "0").strip().lower() in {"1", "true", "yes", "on"}
VIDEO_CRF = max(0, min(51, int(os.environ.get("MEDIA_ENHANCE_VIDEO_CRF", "12"))))
VIDEO_PRESET = os.environ.get("MEDIA_ENHANCE_VIDEO_PRESET", "slow").strip() or "slow"
SEEDVR2_BATCH_SIZE = max(1, int(os.environ.get("SEEDVR2_BATCH_SIZE", "5")))
if (SEEDVR2_BATCH_SIZE - 1) % 4 != 0:
    raise RuntimeError("SEEDVR2_BATCH_SIZE must follow 4n+1 (1, 5, 9, ...)")
SEEDVR2_CHUNK_SIZE = max(0, int(os.environ.get("SEEDVR2_CHUNK_SIZE", "45")))
SEEDVR2_TEMPORAL_OVERLAP = max(0, int(os.environ.get("SEEDVR2_TEMPORAL_OVERLAP", "4")))
SEEDVR2_PREPEND_FRAMES = max(0, int(os.environ.get("SEEDVR2_PREPEND_FRAMES", "4")))
SEEDVR2_BLOCKS_TO_SWAP = max(0, min(36, int(os.environ.get("SEEDVR2_BLOCKS_TO_SWAP", "36"))))
SEEDVR2_VAE_ENCODE_TILE = max(256, int(os.environ.get("SEEDVR2_VAE_ENCODE_TILE", "1024")))
SEEDVR2_VAE_DECODE_TILE = max(256, int(os.environ.get("SEEDVR2_VAE_DECODE_TILE", "768")))
SEEDVR2_TILE_OVERLAP = max(32, int(os.environ.get("SEEDVR2_TILE_OVERLAP", "128")))
SEEDVR2_SWAP_IO_COMPONENTS = os.environ.get(
    "SEEDVR2_SWAP_IO_COMPONENTS", "0"
).strip().lower() in {"1", "true", "yes", "on"}
WORKERS = max(1, min(2, int(os.environ.get("MEDIA_ENHANCE_CONCURRENCY", "1"))))


app = FastAPI(title="Shotflow AI Media Enhance Worker", version="4.0.0")
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.RLock()
_executor = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="media-enhance")
_creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class JobCancelled(RuntimeError):
    pass


def _configured_binary(command: str | Path) -> bool:
    value = str(command)
    return Path(value).exists() if (Path(value).is_absolute() or os.sep in value) else shutil.which(value) is not None


def _seedvr2_readiness() -> dict[str, bool]:
    return {
        "pythonReady": SEEDVR2_PYTHON.is_file(),
        "cliReady": SEEDVR2_CLI.is_file(),
        "ditModelReady": (SEEDVR2_MODEL_DIR / SEEDVR2_DIT_MODEL).is_file(),
        "vaeModelReady": (SEEDVR2_MODEL_DIR / SEEDVR2_VAE_MODEL).is_file(),
    }


def _seedvr2_ready() -> bool:
    return all(_seedvr2_readiness().values())


def _flashvsr_readiness() -> dict[str, bool]:
    required_models = (
        "diffusion_pytorch_model_streaming_dmd.safetensors",
        "LQ_proj_in.ckpt",
        "TCDecoder.ckpt",
        "Wan2.1_VAE.pth",
    )
    return {
        "pythonReady": FLASHVSR_PYTHON.is_file(),
        "repoReady": (FLASHVSR_REPO / "diffsynth" / "pipelines" / "flashvsr_tiny_long.py").is_file(),
        "cliReady": FLASHVSR_CLI.is_file(),
        "modelsReady": all((FLASHVSR_MODEL_DIR / name).is_file() for name in required_models),
        "blockSparseReady": _python_module_ready(FLASHVSR_PYTHON, "block_sparse_attn")
        if FLASHVSR_PYTHON.is_file()
        else False,
    }


def _flashvsr_ready() -> bool:
    return all(_flashvsr_readiness().values())


def _openflowframes_readiness() -> dict[str, bool]:
    model_dir = OPENFLOWFRAMES_RIFE_DIR / OPENFLOWFRAMES_MODEL
    return {
        "binaryReady": OPENFLOWFRAMES_BIN.is_file(),
        "modelParamReady": (model_dir / "flownet.param").is_file(),
        "modelBinReady": (model_dir / "flownet.bin").is_file(),
    }


def _openflowframes_ready() -> bool:
    return all(_openflowframes_readiness().values())


def _video2x_readiness() -> dict[str, bool]:
    model_dir = VIDEO2X_ROOT / "models" / "rife" / VIDEO2X_MODEL
    return {
        "binaryReady": VIDEO2X_BIN.is_file(),
        "modelParamReady": (model_dir / "flownet.param").is_file(),
        "modelBinReady": (model_dir / "flownet.bin").is_file(),
    }


def _video2x_ready() -> bool:
    return all(_video2x_readiness().values())


def _max_converter_readiness() -> dict[str, Any]:
    return {
        "binaryReady": MAX_BATCH_BIN.is_file(),
        "version": MAX_BATCH_BIN.parent.parent.name if MAX_BATCH_BIN.is_file() else "",
        "timeoutSeconds": MAX_CONVERTER_TIMEOUT_SECONDS,
    }


def _python_module_ready(python_path: Path, module_name: str) -> bool:
    environment_root = python_path.parent.parent
    if os.name == "nt":
        return (environment_root / "Lib" / "site-packages" / module_name).exists()
    lib_root = environment_root / "lib"
    return any(lib_root.glob(f"python*/site-packages/{module_name}"))


def _nvidia_vsr_readiness() -> dict[str, bool]:
    return {
        "pythonReady": NVIDIA_VSR_PYTHON.is_file(),
        "cliReady": NVIDIA_VSR_CLI.is_file(),
        "nvvfxReady": _python_module_ready(NVIDIA_VSR_PYTHON, "nvvfx"),
        "torchReady": _python_module_ready(NVIDIA_VSR_PYTHON, "torch"),
    }


def _nvidia_vsr_ready() -> bool:
    return all(_nvidia_vsr_readiness().values())


def _require_auth(authorization: str) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="MEDIA_ENHANCE_API_TOKEN is not configured")
    expected = f"Bearer {API_TOKEN}"
    if not hmac.compare_digest(authorization or "", expected):
        raise HTTPException(status_code=401, detail="invalid media enhancement service token")


def _set_job(job_id: str, **patch: Any) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(patch)
        job["updatedAtMs"] = int(time.time() * 1000)


def _job(job_id: str) -> dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="media enhancement job not found")
        return job


def _public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in job.items()
        if key
        not in {
            "process",
            "inputPath",
            "resultPath",
            "jobDir",
            "deleteWhenFinished",
            "cancelRequested",
        }
    }


def _cleanup_expired() -> None:
    cutoff = time.time() - JOB_TTL_SECONDS
    stale: list[tuple[str, Path]] = []
    with _jobs_lock:
        for job_id, job in list(_jobs.items()):
            finished_at = float(job.get("finishedAt", 0) or 0)
            if finished_at and finished_at < cutoff and job.get("status") not in {"queued", "running"}:
                stale.append((job_id, Path(job["jobDir"])))
                _jobs.pop(job_id, None)
    for _, directory in stale:
        shutil.rmtree(directory, ignore_errors=True)


def _fraction(value: Any) -> float:
    raw = str(value or "").strip()
    if not raw or raw in {"0/0", "N/A"}:
        return 0.0
    try:
        result = float(Fraction(raw))
    except (ValueError, ZeroDivisionError):
        try:
            result = float(raw)
        except ValueError:
            return 0.0
    return result if math.isfinite(result) and result > 0 else 0.0


def _timestamp(value: Any) -> float:
    """Parse a media timestamp while preserving a legitimate negative value."""
    raw = str(value or "").strip()
    if not raw or raw == "N/A":
        return 0.0
    try:
        result = float(raw)
    except ValueError:
        return 0.0
    return result if math.isfinite(result) else 0.0


def _probe(path: Path, count_frames: bool = False) -> dict[str, Any]:
    args = [
        FFPROBE_BIN,
        "-v",
        "error",
        *(["-count_frames"] if count_frames else []),
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(
        args,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_creation_flags,
        timeout=300,
    )
    payload = json.loads(completed.stdout or "{}")
    streams = payload.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    if not video:
        raise RuntimeError("media file has no readable video/image stream")
    format_info = payload.get("format") or {}
    duration = _fraction(video.get("duration")) or _fraction(format_info.get("duration"))
    fps = _fraction(video.get("avg_frame_rate")) or _fraction(video.get("r_frame_rate"))
    frame_count = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)
    return {
        "kind": "video" if duration > 0 or fps > 0 else "image",
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": fps,
        "fpsRational": str(video.get("avg_frame_rate") or video.get("r_frame_rate") or ""),
        "durationSec": duration,
        "startTimeSec": _timestamp(video.get("start_time")),
        "formatStartTimeSec": _timestamp(format_info.get("start_time")),
        "frameCount": frame_count,
        "codecName": str(video.get("codec_name") or "").lower(),
        "codecProfile": str(video.get("profile") or ""),
        "pixelFormat": str(video.get("pix_fmt") or "").lower(),
        "formatName": str(format_info.get("format_name") or "").lower(),
        "audioCodecName": str((audio or {}).get("codec_name") or "").lower(),
        "hasAudio": bool(audio),
    }


def _safe_error(text: str) -> str:
    compact = " ".join(str(text or "").replace("\x00", "").split())
    return compact[-1200:] or "media enhancement command failed"


def _fatal_command_output(line: str) -> bool:
    """Catch NCNN/Vulkan failures that the RealSR CLI may report with exit code 0."""
    normalized = str(line or "").strip().lower()
    return any(
        marker in normalized
        for marker in (
            "vkqueuesubmit failed",
            "vkallocatememory failed",
            "vkcreatecomputepipelines failed",
            "device lost",
            "out of device memory",
        )
    )


def _frame_signature(path: Path) -> dict[str, float]:
    """Return a tiny luminance signature without retaining another large frame."""
    completed = subprocess.run(
        [
            FFMPEG_BIN,
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=64:64:flags=area,format=gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_creation_flags,
        timeout=300,
    )
    pixels = completed.stdout
    if len(pixels) != 64 * 64:
        raise RuntimeError("enhanced frame content could not be inspected")
    count = len(pixels)
    mean = sum(pixels) / count
    variance = sum((value - mean) ** 2 for value in pixels) / count
    return {
        "mean": mean,
        "stddev": math.sqrt(variance),
        "range": float(max(pixels) - min(pixels)),
    }


def _signatures_indicate_collapse(
    source: dict[str, float], output: dict[str, float]
) -> bool:
    """Reject a flat/blank result only when the source contains visible information."""
    source_stddev = float(source.get("stddev") or 0)
    source_range = float(source.get("range") or 0)
    output_stddev = float(output.get("stddev") or 0)
    output_range = float(output.get("range") or 0)
    source_has_detail = source_stddev >= 4 or source_range >= 20
    contrast_collapsed = (
        source_stddev >= 4
        and output_stddev < max(1.5, source_stddev * 0.12)
        and output_range < max(10, source_range * 0.15)
    )
    mean_shifted_to_flat = (
        abs(float(source.get("mean") or 0) - float(output.get("mean") or 0)) >= 32
        and output_stddev < 1.5
        and output_range < 10
    )
    return source_has_detail and (contrast_collapsed or mean_shifted_to_flat)


def _validate_enhanced_frame(source_path: Path, output_path: Path) -> None:
    if _signatures_indicate_collapse(
        _frame_signature(source_path), _frame_signature(output_path)
    ):
        raise RuntimeError(
            "AI enhancement produced a blank/corrupted frame; check the configured Vulkan GPU"
        )


def _terminate(process: subprocess.Popen[str] | None) -> None:
    if not process or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=3)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def _run_command(
    job_id: str,
    args: list[str],
    phase: str,
    start_progress: float,
    end_progress: float,
    parser: Callable[[str], float | None] | None = None,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    allow_nonzero_when: Callable[[int, list[str]], bool] | None = None,
) -> None:
    _set_job(job_id, phase=phase, progressPercent=round(start_progress, 2))
    process = subprocess.Popen(
        [str(value) for value in args],
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=_creation_flags,
        env=env,
    )
    _set_job(job_id, process=process)
    tail: list[str] = []
    fatal_line = ""
    assert process.stdout is not None
    try:
        for line in iter(process.stdout.readline, ""):
            clean = line.strip()
            if clean:
                tail.append(clean)
                tail = tail[-24:]
                if not fatal_line and _fatal_command_output(clean):
                    fatal_line = clean
                    _terminate(process)
                    break
            with _jobs_lock:
                current = _jobs.get(job_id)
                cancelled = bool(current and current.get("cancelRequested"))
            if cancelled:
                _terminate(process)
                raise JobCancelled("media enhancement cancelled")
            if parser:
                parsed = parser(clean)
                if parsed is not None and math.isfinite(parsed):
                    fraction = max(0.0, min(1.0, parsed))
                    _set_job(
                        job_id,
                        progressPercent=round(
                            start_progress + (end_progress - start_progress) * fraction,
                            2,
                        ),
                    )
        return_code = process.wait()
    finally:
        _set_job(job_id, process=None)
    if fatal_line:
        raise RuntimeError(_safe_error(f"{phase}: {fatal_line}"))
    if return_code != 0 and not (
        allow_nonzero_when and allow_nonzero_when(return_code, tail)
    ):
        raise RuntimeError(_safe_error("\n".join(tail)))
    _set_job(job_id, progressPercent=round(end_progress, 2))


def _percent_parser(line: str) -> float | None:
    match = re.search(r"(?<!\d)(\d+(?:\.\d+)?)%", line)
    return float(match.group(1)) / 100 if match else None


def _ffmpeg_frame_parser(total_frames: int) -> Callable[[str], float | None]:
    def parse(line: str) -> float | None:
        if not line.startswith("frame="):
            return None
        try:
            return int(line.split("=", 1)[1]) / max(1, total_frames)
        except ValueError:
            return None

    return parse


def _real_sr_args(input_path: Path, output_path: Path, tta: bool) -> list[str]:
    args = [
        str(REALSR_BIN),
        "-i",
        str(input_path),
        "-o",
        str(output_path),
        "-s",
        "4",
        "-m",
        str(REALSR_MODEL_DIR),
        "-g",
        str(GPU_ID),
        "-t",
        str(REALSR_TILE_SIZE),
        "-f",
        "png",
    ]
    if tta:
        args.append("-x")
    return args


def _target_size(meta: dict[str, Any], scale: int, media_type: str) -> tuple[int, int]:
    width = int(meta.get("width") or 0)
    height = int(meta.get("height") or 0)
    if width < 1 or height < 1:
        raise RuntimeError("source dimensions could not be read")
    target_width = width * scale
    target_height = height * scale
    if media_type == "video":
        target_width -= target_width % 2
        target_height -= target_height % 2
    if target_width * target_height > MAX_OUTPUT_PIXELS:
        raise RuntimeError(
            f"requested output {target_width}x{target_height} exceeds the worker safety limit"
        )
    return target_width, target_height


def _seedvr2_environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    # Models are installed and hash-verified by install_seedvr2.ps1.  Do not let
    # a production job silently download a different revision at runtime.
    environment["HF_HUB_OFFLINE"] = "1"
    environment["TRANSFORMERS_OFFLINE"] = "1"
    return environment


def _seedvr2_args(
    input_path: Path,
    output_path: Path,
    target_width: int,
    target_height: int,
    media_type: str,
) -> list[str]:
    batch_size = SEEDVR2_BATCH_SIZE if media_type == "video" else 1
    args = [
        str(SEEDVR2_PYTHON),
        str(SEEDVR2_CLI),
        str(input_path),
        "--output",
        str(output_path),
        "--output_format",
        "png",
        "--model_dir",
        str(SEEDVR2_MODEL_DIR),
        "--dit_model",
        SEEDVR2_DIT_MODEL,
        "--resolution",
        str(min(target_width, target_height)),
        "--max_resolution",
        str(max(target_width, target_height)),
        "--batch_size",
        str(batch_size),
        "--seed",
        "42",
        "--color_correction",
        "lab",
        "--cuda_device",
        "0",
        "--dit_offload_device",
        "cpu",
        "--vae_offload_device",
        "cpu",
        "--tensor_offload_device",
        "cpu",
        "--blocks_to_swap",
        str(SEEDVR2_BLOCKS_TO_SWAP),
        "--vae_encode_tiled",
        "--vae_encode_tile_size",
        str(SEEDVR2_VAE_ENCODE_TILE),
        "--vae_encode_tile_overlap",
        str(SEEDVR2_TILE_OVERLAP),
        "--vae_decode_tiled",
        "--vae_decode_tile_size",
        str(SEEDVR2_VAE_DECODE_TILE),
        "--vae_decode_tile_overlap",
        str(SEEDVR2_TILE_OVERLAP),
        "--attention_mode",
        "sdpa",
    ]
    if SEEDVR2_SWAP_IO_COMPONENTS:
        args.append("--swap_io_components")
    if media_type == "video":
        args.extend([
            "--uniform_batch_size",
            "--chunk_size",
            str(SEEDVR2_CHUNK_SIZE),
            "--prepend_frames",
            str(SEEDVR2_PREPEND_FRAMES),
            "--temporal_overlap",
            str(SEEDVR2_TEMPORAL_OVERLAP),
            "--cache_dit",
            "--cache_vae",
        ])
    return args


def _flashvsr_environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    environment["HF_HUB_OFFLINE"] = "1"
    environment["TRANSFORMERS_OFFLINE"] = "1"
    return environment


def _flashvsr_args(
    input_dir: Path,
    output_dir: Path,
    target_width: int,
    target_height: int,
) -> list[str]:
    return [
        str(FLASHVSR_PYTHON),
        str(FLASHVSR_CLI),
        "--repo",
        str(FLASHVSR_REPO),
        "--model-dir",
        str(FLASHVSR_MODEL_DIR),
        "--input-dir",
        str(input_dir),
        "--output-dir",
        str(output_dir),
        "--output-width",
        str(target_width),
        "--output-height",
        str(target_height),
        "--local-range",
        str(FLASHVSR_LOCAL_RANGE),
        "--sparse-ratio",
        str(FLASHVSR_SPARSE_RATIO),
        "--chunk-frames",
        str(FLASHVSR_CHUNK_FRAMES),
        "--chunk-overlap",
        str(FLASHVSR_CHUNK_OVERLAP),
        "--seed",
        "42",
    ]


def _nvidia_vsr_environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    return environment


def _nvidia_vsr_args(
    input_dir: Path,
    output_dir: Path,
    target_width: int,
    target_height: int,
) -> list[str]:
    return [
        str(NVIDIA_VSR_PYTHON),
        str(NVIDIA_VSR_CLI),
        "--input-dir",
        str(input_dir),
        "--output-dir",
        str(output_dir),
        "--output-width",
        str(target_width),
        "--output-height",
        str(target_height),
        "--quality",
        NVIDIA_VSR_QUALITY,
        "--device",
        str(NVIDIA_VSR_CUDA_DEVICE),
    ]


def _enhance_image(
    job_id: str,
    input_path: Path,
    job_dir: Path,
    scale: int,
    source_meta: dict[str, Any],
) -> tuple[Path, dict[str, Any]]:
    target_width, target_height = _target_size(source_meta, scale, "image")
    ai_path = job_dir / "realsr-4x.png"
    result_path = job_dir / "enhanced.png"
    _run_command(
        job_id,
        _real_sr_args(input_path, ai_path, IMAGE_TTA),
        "ai-upscale",
        8,
        88,
        _percent_parser,
        REALSR_BIN.parent,
    )
    has_alpha = "a" in str(source_meta.get("pixelFormat") or "")
    if scale == 4 and not has_alpha:
        shutil.move(str(ai_path), str(result_path))
    else:
        if has_alpha:
            filter_graph = (
                f"[0:v]scale={target_width}:{target_height}:flags=lanczos[base];"
                f"[1:v]alphaextract,scale={target_width}:{target_height}:flags=lanczos[alpha];"
                "[base][alpha]alphamerge[out]"
            )
            args = [
                FFMPEG_BIN,
                "-y",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-i",
                str(ai_path),
                "-i",
                str(input_path),
                "-filter_complex",
                filter_graph,
                "-map",
                "[out]",
                "-frames:v",
                "1",
                str(result_path),
            ]
        else:
            args = [
                FFMPEG_BIN,
                "-y",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-i",
                str(ai_path),
                "-vf",
                f"scale={target_width}:{target_height}:flags=lanczos,setsar=1",
                "-frames:v",
                "1",
                str(result_path),
            ]
        _run_command(job_id, args, "finishing", 88, 96)
    output_meta = _probe(result_path)
    if output_meta["width"] != target_width or output_meta["height"] != target_height:
        raise RuntimeError("enhanced image dimensions do not match the requested scale")
    _validate_enhanced_frame(input_path, result_path)
    output_meta["contentFramesVerified"] = True
    return result_path, output_meta


def _enhance_video(
    job_id: str,
    input_path: Path,
    job_dir: Path,
    scale: int,
    source_meta: dict[str, Any],
    frame_engine: str = "realsr",
) -> tuple[Path, dict[str, Any], int]:
    target_width, target_height = _target_size(source_meta, scale, "video")
    frames_in = job_dir / "frames-source"
    frames_ai = job_dir / (
        "frames-nvidia-vsr" if frame_engine == "nvidia-vsr" else "frames-realsr"
    )
    frames_in.mkdir()
    frames_ai.mkdir()
    source_frames = int(source_meta.get("frameCount") or 0)
    duration = float(source_meta.get("durationSec") or 0)
    fps = float(source_meta.get("fps") or 0)
    estimate = source_frames or max(1, round(duration * fps))
    extract_args = [
        FFMPEG_BIN,
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-fps_mode",
        "passthrough",
        str(frames_in / "%08d.png"),
    ]
    _run_command(
        job_id,
        extract_args,
        "extracting-frames",
        3,
        12,
        _ffmpeg_frame_parser(estimate),
    )
    frame_count = len(list(frames_in.glob("*.png")))
    if frame_count < 1:
        raise RuntimeError("no video frames were extracted")
    if frame_engine == "nvidia-vsr":
        _run_command(
            job_id,
            _nvidia_vsr_args(frames_in, frames_ai, target_width, target_height),
            "nvidia-vsr",
            12,
            84,
            _percent_parser,
            ROOT,
            _nvidia_vsr_environment(),
        )
    else:
        _run_command(
            job_id,
            _real_sr_args(frames_in, frames_ai, VIDEO_TTA),
            "ai-upscale",
            12,
            84,
            _percent_parser,
            REALSR_BIN.parent,
        )
    enhanced_count = len(list(frames_ai.glob("*.png")))
    if enhanced_count != frame_count:
        raise RuntimeError(
            f"AI enhancement returned {enhanced_count} frames for {frame_count} source frames"
        )

    _set_job(job_id, phase="validating-ai-output", progressPercent=84)
    for frame_number in sorted({1, (frame_count + 1) // 2, frame_count}):
        _validate_enhanced_frame(
            frames_in / f"{frame_number:08d}.png",
            frames_ai / f"{frame_number:08d}.png",
        )

    # Using the decoded frame count and the video-stream duration preserves the
    # source cadence even when the container reports an imprecise decimal FPS.
    encode_fps = frame_count / duration if duration > 0 else fps
    if not math.isfinite(encode_fps) or encode_fps <= 0:
        raise RuntimeError("source video frame rate could not be read")
    result_path = job_dir / "enhanced.mp4"
    video_filter = (
        f"setpts=PTS-STARTPTS,scale={target_width}:{target_height}:flags=lanczos,setsar=1,format=yuv420p"
        if frame_engine == "realsr" and scale == 2
        else "setpts=PTS-STARTPTS,setsar=1,format=yuv420p"
    )
    encode_args = [
        FFMPEG_BIN,
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-framerate",
        f"{encode_fps:.12f}",
        "-start_number",
        "1",
        "-i",
        str(frames_ai / "%08d.png"),
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-vf",
        video_filter,
        "-frames:v",
        str(frame_count),
        "-c:v",
        "libx264",
        "-preset",
        VIDEO_PRESET,
        "-crf",
        str(VIDEO_CRF),
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "avc1",
        "-fps_mode",
        "cfr",
    ]
    if source_meta.get("hasAudio"):
        if source_meta.get("audioCodecName") == "aac":
            encode_args += ["-c:a", "copy"]
        else:
            encode_args += [
                "-c:a",
                "aac",
                "-b:a",
                "320k",
                "-af",
                "aresample=async=1:first_pts=0",
            ]
    # MP4 edit lists safely carry x264's negative decode timestamps. Using
    # `-avoid_negative_ts make_zero` shifts the presentation timeline forward
    # to hide those DTS values; with AAC priming this delayed the first video
    # frame by roughly two frames. Keep the presentation timeline at zero.
    encode_args += ["-map_metadata", "1", "-movflags", "+faststart", str(result_path)]
    _run_command(
        job_id,
        encode_args,
        "encoding-mp4",
        84,
        97,
        _ffmpeg_frame_parser(frame_count),
    )
    output_meta = _probe(result_path, count_frames=True)
    if output_meta["width"] != target_width or output_meta["height"] != target_height:
        raise RuntimeError("enhanced video dimensions do not match the requested scale")
    if output_meta["codecName"] != "h264" or output_meta["pixelFormat"] != "yuv420p":
        raise RuntimeError("enhanced video is not RV-compatible H.264/yuv420p")
    if output_meta.get("frameCount") and output_meta["frameCount"] != frame_count:
        raise RuntimeError("enhanced video frame count changed during MP4 encoding")
    if source_meta.get("hasAudio") and not output_meta.get("hasAudio"):
        raise RuntimeError("enhanced video lost its source audio track")
    if abs(float(output_meta.get("fps") or 0) - encode_fps) > max(0.02, encode_fps * 0.001):
        raise RuntimeError("enhanced video frame rate changed during MP4 encoding")
    if abs(float(output_meta.get("startTimeSec") or 0)) > 0.001:
        raise RuntimeError("enhanced video no longer starts at the first frame")
    if abs(float(output_meta.get("formatStartTimeSec") or 0)) > 0.001:
        raise RuntimeError("enhanced MP4 timeline does not start at zero")
    output_meta["contentFramesVerified"] = True

    # Decode the exact first and exact last output frames to PNG.  Seeking near
    # the end is insufficient: it can validate the penultimate frame while a
    # damaged final frame remains unnoticed.
    boundary_dir = job_dir / "boundary-check"
    boundary_dir.mkdir()
    for frame_number, file_name, progress_start, progress_end in (
        (0, "first.png", 97, 98),
        (frame_count - 1, "last.png", 98, 99),
    ):
        boundary_path = boundary_dir / file_name
        boundary_args = [
            FFMPEG_BIN,
            "-y",
            "-v",
            "error",
            "-i",
            str(result_path),
            "-map",
            "0:v:0",
            "-vf",
            f"select=eq(n\\,{frame_number})",
            "-fps_mode",
            "vfr",
            "-frames:v",
            "1",
            str(boundary_path),
        ]
        _run_command(
            job_id,
            boundary_args,
            "validating-boundaries",
            progress_start,
            progress_end,
        )
        if not boundary_path.is_file() or boundary_path.stat().st_size < 1:
            raise RuntimeError(f"output boundary frame {frame_number} could not be decoded")
    return result_path, output_meta, frame_count


def _enhance_image_generative(
    job_id: str,
    input_path: Path,
    job_dir: Path,
    scale: int,
    source_meta: dict[str, Any],
) -> tuple[Path, dict[str, Any]]:
    target_width, target_height = _target_size(source_meta, scale, "image")
    generated_path = job_dir / "seedvr2-generated.png"
    result_path = job_dir / "enhanced.png"
    _run_command(
        job_id,
        _seedvr2_args(
            input_path,
            generated_path,
            target_width,
            target_height,
            "image",
        ),
        "generative-detail",
        6,
        91,
        _percent_parser,
        SEEDVR2_REPO,
        _seedvr2_environment(),
    )
    if not generated_path.is_file() or generated_path.stat().st_size < 1:
        raise RuntimeError("SeedVR2 did not produce an enhanced image")
    generated_meta = _probe(generated_path)
    if (
        generated_meta.get("width") == target_width
        and generated_meta.get("height") == target_height
    ):
        shutil.move(str(generated_path), str(result_path))
    else:
        _run_command(
            job_id,
            [
                FFMPEG_BIN,
                "-y",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-i",
                str(generated_path),
                "-vf",
                f"scale={target_width}:{target_height}:flags=lanczos,setsar=1",
                "-frames:v",
                "1",
                str(result_path),
            ],
            "finishing",
            91,
            96,
        )
    output_meta = _probe(result_path)
    if output_meta["width"] != target_width or output_meta["height"] != target_height:
        raise RuntimeError("SeedVR2 image dimensions do not match the requested scale")
    _validate_enhanced_frame(input_path, result_path)
    output_meta["contentFramesVerified"] = True
    return result_path, output_meta


def _enhance_video_generative(
    job_id: str,
    input_path: Path,
    job_dir: Path,
    scale: int,
    source_meta: dict[str, Any],
) -> tuple[Path, dict[str, Any], int]:
    target_width, target_height = _target_size(source_meta, scale, "video")
    frames_source = job_dir / "frames-source"
    frames_generated = job_dir / "frames-seedvr2"
    frames_source.mkdir()
    frames_generated.mkdir()
    source_frames = int(source_meta.get("frameCount") or 0)
    duration = float(source_meta.get("durationSec") or 0)
    fps = float(source_meta.get("fps") or 0)
    estimate = source_frames or max(1, round(duration * fps))
    _run_command(
        job_id,
        [
            FFMPEG_BIN,
            "-y",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-i",
            str(input_path),
            "-map",
            "0:v:0",
            "-fps_mode",
            "passthrough",
            str(frames_source / "%08d.png"),
        ],
        "extracting-frames",
        2,
        8,
        _ffmpeg_frame_parser(estimate),
    )
    frame_count = len(list(frames_source.glob("*.png")))
    if frame_count < 1:
        raise RuntimeError("no video frames were extracted")

    _run_command(
        job_id,
        _seedvr2_args(
            input_path,
            frames_generated,
            target_width,
            target_height,
            "video",
        ),
        "generative-detail",
        8,
        84,
        _percent_parser,
        SEEDVR2_REPO,
        _seedvr2_environment(),
    )
    # For a video-to-PNG run the pinned CLI creates one child directory named
    # after the input video (for example frames-seedvr2/source/*.png). Search
    # recursively, then normalize the result into our strict one-based sequence
    # below. Looking only at the output root incorrectly reported zero frames
    # even after a successful SeedVR2 render.
    generated_files = sorted(frames_generated.rglob("*.png"))
    # The pinned CLI's single-GPU streaming path leaves the reversed startup
    # context in PNG output even though its help says prepend frames are
    # removed automatically.  It is always the first N frames; accept both
    # behaviours so a future upstream fix does not make us drop real content.
    if (
        SEEDVR2_PREPEND_FRAMES > 0
        and len(generated_files) == frame_count + SEEDVR2_PREPEND_FRAMES
    ):
        generated_files = generated_files[SEEDVR2_PREPEND_FRAMES:]
    if len(generated_files) != frame_count:
        raise RuntimeError(
            f"SeedVR2 returned {len(generated_files)} frames for {frame_count} source frames"
        )

    # SeedVR2 names PNG output after the source file and starts at zero.  Stage
    # every file before assigning a strict one-based sequence for FFmpeg, so a
    # name collision can never overwrite a generated frame.
    staged_files: list[Path] = []
    for index, file_path in enumerate(generated_files, start=1):
        staged = frames_generated / f".shotflow-stage-{index:08d}.png"
        file_path.replace(staged)
        staged_files.append(staged)
    for index, file_path in enumerate(staged_files, start=1):
        file_path.replace(frames_generated / f"{index:08d}.png")

    _set_job(job_id, phase="validating-ai-output", progressPercent=84)
    for frame_number in sorted({1, (frame_count + 1) // 2, frame_count}):
        _validate_enhanced_frame(
            frames_source / f"{frame_number:08d}.png",
            frames_generated / f"{frame_number:08d}.png",
        )

    encode_fps = frame_count / duration if duration > 0 else fps
    if not math.isfinite(encode_fps) or encode_fps <= 0:
        raise RuntimeError("source video frame rate could not be read")
    result_path = job_dir / "enhanced.mp4"
    encode_args = [
        FFMPEG_BIN,
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-framerate",
        f"{encode_fps:.12f}",
        "-start_number",
        "1",
        "-i",
        str(frames_generated / "%08d.png"),
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-vf",
        f"setpts=PTS-STARTPTS,scale={target_width}:{target_height}:flags=lanczos,setsar=1,format=yuv420p",
        "-frames:v",
        str(frame_count),
        "-c:v",
        "libx264",
        "-preset",
        VIDEO_PRESET,
        "-crf",
        str(VIDEO_CRF),
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "avc1",
        "-fps_mode",
        "cfr",
    ]
    if source_meta.get("hasAudio"):
        if source_meta.get("audioCodecName") == "aac":
            encode_args += ["-c:a", "copy"]
        else:
            encode_args += [
                "-c:a",
                "aac",
                "-b:a",
                "320k",
                "-af",
                "aresample=async=1:first_pts=0",
            ]
    encode_args += [
        "-map_metadata",
        "1",
        "-movflags",
        "+faststart",
        str(result_path),
    ]
    _run_command(
        job_id,
        encode_args,
        "encoding-mp4",
        84,
        97,
        _ffmpeg_frame_parser(frame_count),
    )
    output_meta = _probe(result_path, count_frames=True)
    if output_meta["width"] != target_width or output_meta["height"] != target_height:
        raise RuntimeError("SeedVR2 video dimensions do not match the requested scale")
    if output_meta["codecName"] != "h264" or output_meta["pixelFormat"] != "yuv420p":
        raise RuntimeError("enhanced video is not RV-compatible H.264/yuv420p")
    if output_meta.get("frameCount") and output_meta["frameCount"] != frame_count:
        raise RuntimeError("enhanced video frame count changed during MP4 encoding")
    if source_meta.get("hasAudio") and not output_meta.get("hasAudio"):
        raise RuntimeError("enhanced video lost its source audio track")
    if abs(float(output_meta.get("fps") or 0) - encode_fps) > max(0.02, encode_fps * 0.001):
        raise RuntimeError("enhanced video frame rate changed during MP4 encoding")
    if abs(float(output_meta.get("startTimeSec") or 0)) > 0.001:
        raise RuntimeError("enhanced video no longer starts at the first frame")
    if abs(float(output_meta.get("formatStartTimeSec") or 0)) > 0.001:
        raise RuntimeError("enhanced MP4 timeline does not start at zero")
    output_meta["contentFramesVerified"] = True

    boundary_dir = job_dir / "boundary-check"
    boundary_dir.mkdir()
    for frame_number, file_name, progress_start, progress_end in (
        (0, "first.png", 97, 98),
        (frame_count - 1, "last.png", 98, 99),
    ):
        boundary_path = boundary_dir / file_name
        _run_command(
            job_id,
            [
                FFMPEG_BIN,
                "-y",
                "-v",
                "error",
                "-i",
                str(result_path),
                "-map",
                "0:v:0",
                "-vf",
                f"select=eq(n\\,{frame_number})",
                "-fps_mode",
                "vfr",
                "-frames:v",
                "1",
                str(boundary_path),
            ],
            "validating-boundaries",
            progress_start,
            progress_end,
        )
        if not boundary_path.is_file() or boundary_path.stat().st_size < 1:
            raise RuntimeError(f"output boundary frame {frame_number} could not be decoded")
    return result_path, output_meta, frame_count


def _enhance_video_flashvsr(
    job_id: str,
    input_path: Path,
    job_dir: Path,
    scale: int,
    source_meta: dict[str, Any],
) -> tuple[Path, dict[str, Any], int]:
    target_width, target_height = _target_size(source_meta, scale, "video")
    frames_source = job_dir / "frames-source"
    frames_generated = job_dir / "frames-flashvsr"
    frames_source.mkdir()
    frames_generated.mkdir()
    source_frames = int(source_meta.get("frameCount") or 0)
    duration = float(source_meta.get("durationSec") or 0)
    fps = float(source_meta.get("fps") or 0)
    estimate = source_frames or max(1, round(duration * fps))
    _run_command(
        job_id,
        [
            FFMPEG_BIN,
            "-y",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-i",
            str(input_path),
            "-map",
            "0:v:0",
            "-fps_mode",
            "passthrough",
            str(frames_source / "%08d.png"),
        ],
        "extracting-frames",
        2,
        8,
        _ffmpeg_frame_parser(estimate),
    )
    frame_count = len(list(frames_source.glob("*.png")))
    if frame_count < 1:
        raise RuntimeError("no video frames were extracted")

    _run_command(
        job_id,
        _flashvsr_args(
            frames_source,
            frames_generated,
            target_width,
            target_height,
        ),
        "flashvsr-detail",
        8,
        84,
        _percent_parser,
        FLASHVSR_REPO / "examples" / "WanVSR",
        _flashvsr_environment(),
    )
    generated_count = len(list(frames_generated.glob("*.png")))
    if generated_count != frame_count:
        raise RuntimeError(
            f"FlashVSR returned {generated_count} frames for {frame_count} source frames"
        )

    _set_job(job_id, phase="validating-ai-output", progressPercent=84)
    for frame_number in sorted({1, (frame_count + 1) // 2, frame_count}):
        _validate_enhanced_frame(
            frames_source / f"{frame_number:08d}.png",
            frames_generated / f"{frame_number:08d}.png",
        )

    encode_fps = frame_count / duration if duration > 0 else fps
    if not math.isfinite(encode_fps) or encode_fps <= 0:
        raise RuntimeError("source video frame rate could not be read")
    result_path = job_dir / "enhanced.mp4"
    encode_args = [
        FFMPEG_BIN,
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-framerate",
        f"{encode_fps:.12f}",
        "-start_number",
        "1",
        "-i",
        str(frames_generated / "%08d.png"),
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-vf",
        "setpts=PTS-STARTPTS,setsar=1,format=yuv420p",
        "-frames:v",
        str(frame_count),
        "-c:v",
        "libx264",
        "-preset",
        VIDEO_PRESET,
        "-crf",
        str(VIDEO_CRF),
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "avc1",
        "-fps_mode",
        "cfr",
    ]
    if source_meta.get("hasAudio"):
        if source_meta.get("audioCodecName") == "aac":
            encode_args += ["-c:a", "copy"]
        else:
            encode_args += [
                "-c:a",
                "aac",
                "-b:a",
                "320k",
                "-af",
                "aresample=async=1:first_pts=0",
            ]
    encode_args += ["-map_metadata", "1", "-movflags", "+faststart", str(result_path)]
    _run_command(
        job_id,
        encode_args,
        "encoding-mp4",
        84,
        97,
        _ffmpeg_frame_parser(frame_count),
    )
    output_meta = _probe(result_path, count_frames=True)
    if output_meta["width"] != target_width or output_meta["height"] != target_height:
        raise RuntimeError("FlashVSR video dimensions do not match the requested scale")
    if output_meta["codecName"] != "h264" or output_meta["pixelFormat"] != "yuv420p":
        raise RuntimeError("enhanced video is not RV-compatible H.264/yuv420p")
    if output_meta.get("frameCount") and output_meta["frameCount"] != frame_count:
        raise RuntimeError("enhanced video frame count changed during MP4 encoding")
    if source_meta.get("hasAudio") and not output_meta.get("hasAudio"):
        raise RuntimeError("enhanced video lost its source audio track")
    if abs(float(output_meta.get("fps") or 0) - encode_fps) > max(0.02, encode_fps * 0.001):
        raise RuntimeError("enhanced video frame rate changed during MP4 encoding")
    if abs(float(output_meta.get("startTimeSec") or 0)) > 0.001:
        raise RuntimeError("enhanced video no longer starts at the first frame")
    if abs(float(output_meta.get("formatStartTimeSec") or 0)) > 0.001:
        raise RuntimeError("enhanced MP4 timeline does not start at zero")
    output_meta["contentFramesVerified"] = True

    boundary_dir = job_dir / "boundary-check"
    boundary_dir.mkdir()
    for frame_number, file_name, progress_start, progress_end in (
        (0, "first.png", 97, 98),
        (frame_count - 1, "last.png", 98, 99),
    ):
        boundary_path = boundary_dir / file_name
        _run_command(
            job_id,
            [
                FFMPEG_BIN,
                "-y",
                "-v",
                "error",
                "-i",
                str(result_path),
                "-map",
                "0:v:0",
                "-vf",
                f"select=eq(n\\,{frame_number})",
                "-fps_mode",
                "vfr",
                "-frames:v",
                "1",
                str(boundary_path),
            ],
            "validating-boundaries",
            progress_start,
            progress_end,
        )
        if not boundary_path.is_file() or boundary_path.stat().st_size < 1:
            raise RuntimeError(f"output boundary frame {frame_number} could not be decoded")
    return result_path, output_meta, frame_count


def _interpolation_engine_info(engine: str) -> tuple[str, str]:
    if engine == "openflowframes":
        return "openflowframes", OPENFLOWFRAMES_MODEL_LABEL
    if engine == "video2x":
        return "video2x", VIDEO2X_MODEL_LABEL
    raise RuntimeError("unsupported interpolation engine")


def _encode_interpolated_frames(
    job_id: str,
    frames_dir: Path,
    input_path: Path,
    result_path: Path,
    source_meta: dict[str, Any],
    target_fps: int,
    target_frames: int,
) -> dict[str, Any]:
    args = [
        FFMPEG_BIN,
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-framerate",
        str(target_fps),
        "-start_number",
        "1",
        "-i",
        str(frames_dir / "%08d.png"),
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-vf",
        "setpts=PTS-STARTPTS,pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1,format=yuv420p",
        "-frames:v",
        str(target_frames),
        "-c:v",
        "libx264",
        "-preset",
        VIDEO_PRESET,
        "-crf",
        str(VIDEO_CRF),
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "avc1",
        "-fps_mode",
        "cfr",
    ]
    if source_meta.get("hasAudio"):
        if source_meta.get("audioCodecName") == "aac":
            args += ["-c:a", "copy"]
        else:
            args += [
                "-c:a",
                "aac",
                "-b:a",
                "320k",
                "-af",
                "aresample=async=1:first_pts=0",
            ]
    args += ["-map_metadata", "1", "-movflags", "+faststart", str(result_path)]
    _run_command(
        job_id,
        args,
        "encoding-mp4",
        84,
        97,
        _ffmpeg_frame_parser(target_frames),
    )
    return _probe(result_path, count_frames=True)


def _verify_interpolated_video(
    job_id: str,
    result_path: Path,
    source_meta: dict[str, Any],
    output_meta: dict[str, Any],
    target_fps: int,
    target_frames: int,
    job_dir: Path,
) -> None:
    expected_width = int(source_meta.get("width") or 0)
    expected_height = int(source_meta.get("height") or 0)
    expected_width += expected_width % 2
    expected_height += expected_height % 2
    if output_meta.get("width") != expected_width or output_meta.get("height") != expected_height:
        raise RuntimeError("interpolated video dimensions changed")
    if output_meta.get("codecName") != "h264" or output_meta.get("pixelFormat") != "yuv420p":
        raise RuntimeError("interpolated video is not RV-compatible H.264/yuv420p")
    if output_meta.get("codecProfile") and "high" not in str(output_meta["codecProfile"]).lower():
        raise RuntimeError("interpolated video is not H.264 High Profile")
    if output_meta.get("frameCount") and output_meta.get("frameCount") != target_frames:
        raise RuntimeError("interpolated video frame count is not exact")
    if abs(float(output_meta.get("fps") or 0) - target_fps) > max(0.02, target_fps * 0.001):
        raise RuntimeError(f"interpolated video is not {target_fps}fps")
    if source_meta.get("hasAudio") and not output_meta.get("hasAudio"):
        raise RuntimeError("interpolated video lost its source audio track")
    if abs(float(output_meta.get("formatStartTimeSec") or 0)) > 0.001:
        raise RuntimeError("interpolated MP4 timeline does not start at zero")

    boundary_dir = job_dir / "boundary-check"
    boundary_dir.mkdir()
    for frame_number, file_name, progress_start, progress_end in (
        (0, "first.png", 97, 98),
        (target_frames - 1, "last.png", 98, 99),
    ):
        boundary_path = boundary_dir / file_name
        _run_command(
            job_id,
            [
                FFMPEG_BIN,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(result_path),
                "-vf",
                f"select=eq(n\\,{frame_number})",
                "-frames:v",
                "1",
                str(boundary_path),
            ],
            "validating-boundary-frames",
            progress_start,
            progress_end,
        )
        if not boundary_path.is_file() or boundary_path.stat().st_size < 1:
            raise RuntimeError(f"output boundary frame {frame_number} could not be decoded")


def _interpolate_video_gpu(
    job_id: str,
    input_path: Path,
    job_dir: Path,
    engine: str,
    target_fps: int,
    source_meta: dict[str, Any],
) -> tuple[Path, dict[str, Any], int]:
    source_fps = float(source_meta.get("fps") or 0)
    source_frames_hint = int(source_meta.get("frameCount") or 0)
    duration = float(source_meta.get("durationSec") or 0)
    if source_fps <= 0 or duration <= 0:
        raise RuntimeError("source video FPS or duration could not be read")
    if target_fps <= source_fps + 0.01:
        raise RuntimeError("target FPS must be higher than source FPS")

    frames_source = job_dir / "frames-source"
    frames_output = job_dir / "frames-interpolated"
    frames_source.mkdir()
    frames_output.mkdir()
    estimate = source_frames_hint or max(1, round(duration * source_fps))
    _run_command(
        job_id,
        [
            FFMPEG_BIN,
            "-y",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-i",
            str(input_path),
            "-map",
            "0:v:0",
            "-fps_mode",
            "passthrough",
            "-pix_fmt",
            "rgb24",
            str(frames_source / "%08d.png"),
        ],
        "extracting-frames",
        3,
        14,
        _ffmpeg_frame_parser(estimate),
    )
    source_frames = len(list(frames_source.glob("*.png")))
    if source_frames < 2:
        raise RuntimeError("source video has too few frames to interpolate")
    target_frames = max(2, round(source_frames * target_fps / source_fps))

    if engine == "openflowframes":
        _run_command(
            job_id,
            [
                str(OPENFLOWFRAMES_BIN),
                "-i",
                str(frames_source),
                "-o",
                str(frames_output),
                "-n",
                str(target_frames),
                "-m",
                str(OPENFLOWFRAMES_RIFE_DIR / OPENFLOWFRAMES_MODEL),
                "-g",
                str(GPU_ID),
                "-f",
                "%08d.png",
            ],
            "rife-interpolation",
            14,
            82,
            _percent_parser,
            OPENFLOWFRAMES_RIFE_DIR,
        )
    elif engine == "video2x":
        # Video2X 6.4 flushes too few tail frames on some short/B-frame inputs.
        # Three cloned guard frames keep the real final frame inside the 2x
        # result; the guards are removed again when the exact target cadence is
        # exported below.
        padded_path = job_dir / "video2x-padded.mkv"
        _run_command(
            job_id,
            [
                FFMPEG_BIN,
                "-y",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-i",
                str(input_path),
                "-map",
                "0:v:0",
                "-vf",
                "setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=3,pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-an",
                "-fps_mode",
                "passthrough",
                "-c:v",
                "ffv1",
                "-pix_fmt",
                "yuv420p",
                str(padded_path),
            ],
            "preparing-video2x",
            14,
            22,
            _ffmpeg_frame_parser(source_frames + 3),
        )
        intermediate_path = job_dir / "video2x-rife.mkv"
        multiplier = max(2, math.ceil(target_fps / source_fps))
        _run_command(
            job_id,
            [
                str(VIDEO2X_BIN),
                "-i",
                str(padded_path),
                "-o",
                str(intermediate_path),
                "-m",
                str(multiplier),
                "-p",
                "rife",
                "--rife-model",
                VIDEO2X_MODEL,
                "-d",
                str(GPU_ID),
                "-c",
                "ffv1",
                "--pix-fmt",
                "yuv420p",
                "--no-copy-streams",
                "--no-progress",
                "--log-level",
                "info",
            ],
            "video2x-rife-interpolation",
            22,
            72,
            _percent_parser,
            VIDEO2X_ROOT,
            # Video2X 6.4 on Windows can finish the whole file, print its
            # success summary, and then access-violate while tearing down the
            # Vulkan runtime (0xC0000005).  Accept only that post-success shape;
            # the following FFmpeg retime and strict output verifier still
            # reject a missing, truncated, or malformed intermediate file.
            allow_nonzero_when=lambda _code, tail: (
                intermediate_path.is_file()
                and intermediate_path.stat().st_size > 0
                and any("Video processed successfully" in line for line in tail)
                and any("Output written to:" in line for line in tail)
            ),
        )
        _run_command(
            job_id,
            [
                FFMPEG_BIN,
                "-y",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-i",
                str(intermediate_path),
                "-vf",
                f"setpts=PTS-STARTPTS,fps=fps={target_fps}:start_time=0:round=near",
                "-frames:v",
                str(target_frames),
                "-fps_mode",
                "passthrough",
                str(frames_output / "%08d.png"),
            ],
            "retiming-to-target-fps",
            72,
            82,
            _ffmpeg_frame_parser(target_frames),
        )
    else:
        raise RuntimeError("unsupported interpolation engine")

    output_count = len(list(frames_output.glob("*.png")))
    if output_count != target_frames:
        raise RuntimeError(
            f"interpolation returned {output_count} frames; expected {target_frames}"
        )
    # Preserve the exact decoded source endpoints. This also protects against
    # upstream RIFE/decoder edge bugs while keeping all interior frames AI-made.
    shutil.copyfile(frames_source / "00000001.png", frames_output / "00000001.png")
    shutil.copyfile(
        frames_source / f"{source_frames:08d}.png",
        frames_output / f"{target_frames:08d}.png",
    )

    result_path = job_dir / "interpolated.mp4"
    output_meta = _encode_interpolated_frames(
        job_id,
        frames_output,
        input_path,
        result_path,
        source_meta,
        target_fps,
        target_frames,
    )
    _verify_interpolated_video(
        job_id,
        result_path,
        source_meta,
        output_meta,
        target_fps,
        target_frames,
        job_dir,
    )
    output_meta["contentFramesVerified"] = True
    return result_path, output_meta, target_frames


def _execute_interpolation_job(job_id: str) -> None:
    job = _job(job_id)
    job_dir = Path(job["jobDir"])
    input_path = Path(job["inputPath"])
    engine = str(job.get("interpolationEngine") or "")
    target_fps = int(job.get("targetFps") or 0)
    provider, model = _interpolation_engine_info(engine)
    try:
        with _jobs_lock:
            if _jobs.get(job_id, {}).get("cancelRequested"):
                raise JobCancelled("video frame interpolation cancelled")
        _set_job(job_id, status="running", phase="probing", progressPercent=1)
        source_meta = _probe(input_path, count_frames=True)
        result_path, output_meta, frame_count = _interpolate_video_gpu(
            job_id, input_path, job_dir, engine, target_fps, source_meta
        )
        _set_job(
            job_id,
            status="succeeded",
            phase="completed",
            progressPercent=100,
            resultPath=str(result_path),
            resultFileName=f"interpolated-{target_fps}fps.mp4",
            resultMimeType="video/mp4",
            resultByteSize=result_path.stat().st_size,
            metadata={
                "engine": provider,
                "model": model,
                "sourceFps": source_meta.get("fps"),
                "fps": output_meta.get("fps"),
                "targetFps": target_fps,
                "durationSec": output_meta.get("durationSec"),
                "frameCount": frame_count,
                "width": output_meta.get("width"),
                "height": output_meta.get("height"),
                "codecName": output_meta.get("codecName"),
                "codecProfile": output_meta.get("codecProfile"),
                "pixelFormat": output_meta.get("pixelFormat"),
                "audioCodecName": output_meta.get("audioCodecName"),
                "formatName": output_meta.get("formatName"),
                "qualityMode": "quality",
                "crf": VIDEO_CRF,
                "preset": VIDEO_PRESET,
                "rvCompatible": True,
                "boundaryFramesVerified": True,
                "contentFramesVerified": True,
                "openFlowFramesCommit": OPENFLOWFRAMES_COMMIT
                if engine == "openflowframes"
                else None,
                "video2xVersion": VIDEO2X_VERSION if engine == "video2x" else None,
            },
            finishedAt=time.time(),
        )
    except JobCancelled:
        _set_job(
            job_id,
            status="cancelled",
            phase="cancelled",
            progressPercent=0,
            error="视频补帧已取消",
            finishedAt=time.time(),
        )
    except Exception as error:
        _set_job(
            job_id,
            status="failed",
            phase="failed",
            progressPercent=0,
            error=_safe_error(str(error)),
            finishedAt=time.time(),
        )
    finally:
        with _jobs_lock:
            current = _jobs.get(job_id)
            delete_when_finished = bool(current and current.get("deleteWhenFinished"))
        if delete_when_finished:
            with _jobs_lock:
                _jobs.pop(job_id, None)
            shutil.rmtree(job_dir, ignore_errors=True)


def _execute_max_import_job(job_id: str) -> None:
    """Convert a native 3ds Max scene to FBX on the Windows worker.

    A browser cannot parse Autodesk's private .max format.  3dsmaxbatch's
    -sceneFile option loads the scene before running the export script; this is
    important because calling loadMaxFile from an embedded script is rejected
    by MaxScript Security Tools.
    """
    job = _job(job_id)
    job_dir = Path(job["jobDir"])
    input_path = Path(job["inputPath"])
    output_path = job_dir / "converted.fbx"
    script_path = job_dir / "export.ms"
    try:
        if not MAX_BATCH_BIN.is_file():
            raise RuntimeError("3dsmaxbatch.exe is not installed on the media worker")
        output_literal = str(output_path).replace('"', "")
        script_path.write_text(
            f'exportFile @"{output_literal}" #noPrompt selectedOnly:false\n'
            'print "SHOTFLOW_MAX_EXPORT_OK"\n',
            encoding="ascii",
        )
        _set_job(job_id, status="running", phase="loading-max-scene", progressPercent=5)
        completed = subprocess.run(
            [
                str(MAX_BATCH_BIN),
                str(script_path),
                "-sceneFile",
                str(input_path),
                # Scheduled-task sessions can inherit 3ds Max's Safe Scene
                # mode even when the UI reports Secure Mode OFF.  In that
                # mode the external export script is rejected before it can
                # run.  The worker owns this generated script and the input
                # is an explicit upload, so disable Safe Scene for this
                # isolated batch conversion.
                "-safescene",
                "off",
                "-v",
                "2",
            ],
            cwd=str(job_dir),
            capture_output=True,
            timeout=MAX_CONVERTER_TIMEOUT_SECONDS,
            creationflags=_creation_flags,
        )
        log_path = job_dir / "3dsmaxbatch.log"
        log_path.write_bytes((completed.stdout or b"") + b"\n" + (completed.stderr or b""))
        output_ready = output_path.is_file() and output_path.stat().st_size >= 1024
        # Some .max scenes contain an embedded startup snippet that attempts
        # to call setINISetting.  3dsmaxbatch blocks that snippet under Safe
        # Scene mode and returns its unsigned Windows exit code, but it still
        # completes the requested FBX export.  Accept that narrow, verifiable
        # case; any other non-zero exit remains a hard conversion failure.
        log_text = (completed.stdout or b"") + b"\n" + (completed.stderr or b"")
        blocked_scene_script = b"Security Exception" in log_text and b"setINISetting" in log_text
        if not output_ready or (completed.returncode != 0 and not (blocked_scene_script and output_ready)):
            raise RuntimeError(
                f"3ds Max 转换失败（exit={completed.returncode}），请检查 3dsmaxbatch 日志"
            )
        _set_job(
            job_id,
            status="succeeded",
            phase="completed",
            progressPercent=100,
            resultPath=str(output_path),
            resultFileName="converted.fbx",
            resultMimeType="application/octet-stream",
            resultByteSize=output_path.stat().st_size,
            metadata={
                "sourceFormat": "max",
                "targetFormat": "fbx",
                "converter": str(MAX_BATCH_BIN),
                "converterVersion": MAX_BATCH_BIN.parent.parent.name,
                "safeSceneBlockedEmbeddedScript": blocked_scene_script,
            },
            finishedAt=time.time(),
        )
    except subprocess.TimeoutExpired:
        _set_job(job_id, status="failed", phase="failed", progressPercent=0,
                 error="3ds Max 转换超时", finishedAt=time.time())
    except Exception as error:
        _set_job(job_id, status="failed", phase="failed", progressPercent=0,
                 error=_safe_error(str(error)), finishedAt=time.time())
    finally:
        with _jobs_lock:
            current = _jobs.get(job_id)
            delete_when_finished = bool(current and current.get("deleteWhenFinished"))
        if delete_when_finished:
            with _jobs_lock:
                _jobs.pop(job_id, None)
            shutil.rmtree(job_dir, ignore_errors=True)


def _execute_job(job_id: str) -> None:
    job = _job(job_id)
    job_dir = Path(job["jobDir"])
    input_path = Path(job["inputPath"])
    media_type = str(job["mediaType"])
    scale = int(job["scale"])
    enhance_mode = str(job.get("enhanceMode") or "faithful")
    generative = enhance_mode == "generative"
    nvidia_vsr = enhance_mode == "nvidia-vsr"
    flash_vsr = enhance_mode == "flashvsr"
    try:
        with _jobs_lock:
            if _jobs.get(job_id, {}).get("cancelRequested"):
                raise JobCancelled("media enhancement cancelled")
        _set_job(job_id, status="running", phase="probing", progressPercent=1)
        source_meta = _probe(input_path, count_frames=media_type == "video")
        if media_type == "video":
            if not source_meta.get("fps") or not source_meta.get("durationSec"):
                raise RuntimeError("source video FPS or duration could not be read")
            if generative:
                result_path, output_meta, frame_count = _enhance_video_generative(
                    job_id, input_path, job_dir, scale, source_meta
                )
            elif flash_vsr:
                result_path, output_meta, frame_count = _enhance_video_flashvsr(
                    job_id, input_path, job_dir, scale, source_meta
                )
            else:
                result_path, output_meta, frame_count = _enhance_video(
                    job_id,
                    input_path,
                    job_dir,
                    scale,
                    source_meta,
                    "nvidia-vsr" if nvidia_vsr else "realsr",
                )
            mime_type = "video/mp4"
            file_name = f"enhanced-{scale}x.mp4"
        else:
            enhance_image = _enhance_image_generative if generative else _enhance_image
            result_path, output_meta = enhance_image(
                job_id, input_path, job_dir, scale, source_meta
            )
            frame_count = 1
            mime_type = "image/png"
            file_name = f"enhanced-{scale}x.png"
        metadata = {
            "enhanceMode": enhance_mode,
            "engine": (
                "seedvr2"
                if generative
                else "flashvsr" if flash_vsr else "nvidia-vfx" if nvidia_vsr else "realsr-ncnn-vulkan"
            ),
            "model": (
                SEEDVR2_MODEL_LABEL
                if generative
                else FLASHVSR_MODEL_LABEL if flash_vsr else NVIDIA_VSR_MODEL_LABEL if nvidia_vsr else "RealSR DF2K"
            ),
            "generativeDetails": generative or flash_vsr,
            "scale": scale,
            "qualityMode": "quality",
            "sourceWidth": source_meta.get("width"),
            "sourceHeight": source_meta.get("height"),
            "width": output_meta.get("width"),
            "height": output_meta.get("height"),
            "sourceFps": source_meta.get("fps") if media_type == "video" else None,
            "fps": output_meta.get("fps") if media_type == "video" else None,
            "durationSec": output_meta.get("durationSec") if media_type == "video" else None,
            "frameCount": frame_count,
            "codecName": output_meta.get("codecName"),
            "codecProfile": output_meta.get("codecProfile"),
            "pixelFormat": output_meta.get("pixelFormat"),
            "audioCodecName": output_meta.get("audioCodecName"),
            "formatName": output_meta.get("formatName"),
            "rvCompatible": media_type == "video",
            "boundaryFramesVerified": media_type == "video",
            "contentFramesVerified": bool(output_meta.get("contentFramesVerified")),
            "imageTta": IMAGE_TTA if media_type == "image" else None,
            "videoTta": VIDEO_TTA
            if media_type == "video" and not generative and not nvidia_vsr and not flash_vsr
            else None,
            "crf": VIDEO_CRF if media_type == "video" else None,
            "preset": VIDEO_PRESET if media_type == "video" else None,
            "colorCorrection": "lab" if generative else "adain" if flash_vsr else None,
            "batchSize": (SEEDVR2_BATCH_SIZE if media_type == "video" else 1)
            if generative
            else None,
            "uniformBatchSize": bool(generative and media_type == "video"),
            "temporalOverlap": SEEDVR2_TEMPORAL_OVERLAP
            if generative and media_type == "video"
            else None,
            "prependFrames": SEEDVR2_PREPEND_FRAMES
            if generative and media_type == "video"
            else None,
            "seedvr2Commit": SEEDVR2_COMMIT if generative else None,
            "flashVsrVersion": FLASHVSR_VERSION if flash_vsr else None,
            "flashVsrCommit": FLASHVSR_COMMIT if flash_vsr else None,
            "flashVsrPipeline": "tiny-long" if flash_vsr else None,
            "flashVsrLocalRange": FLASHVSR_LOCAL_RANGE if flash_vsr else None,
            "flashVsrSparseRatio": FLASHVSR_SPARSE_RATIO if flash_vsr else None,
            "flashVsrChunkFrames": FLASHVSR_CHUNK_FRAMES if flash_vsr else None,
            "flashVsrChunkOverlap": FLASHVSR_CHUNK_OVERLAP if flash_vsr else None,
            "nvidiaVfxVersion": NVIDIA_VFX_VERSION if nvidia_vsr else None,
            "nvidiaVsrQuality": NVIDIA_VSR_QUALITY if nvidia_vsr else None,
        }
        _set_job(
            job_id,
            status="succeeded",
            phase="completed",
            progressPercent=100,
            resultPath=str(result_path),
            resultFileName=file_name,
            resultMimeType=mime_type,
            resultByteSize=result_path.stat().st_size,
            metadata=metadata,
            finishedAt=time.time(),
        )
    except JobCancelled:
        _set_job(
            job_id,
            status="cancelled",
            phase="cancelled",
            progressPercent=0,
            error="AI 高清增强已取消",
            finishedAt=time.time(),
        )
    except Exception as error:
        _set_job(
            job_id,
            status="failed",
            phase="failed",
            progressPercent=0,
            error=_safe_error(str(error)),
            finishedAt=time.time(),
        )
    finally:
        with _jobs_lock:
            current = _jobs.get(job_id)
            delete_when_finished = bool(current and current.get("deleteWhenFinished"))
        if delete_when_finished:
            with _jobs_lock:
                _jobs.pop(job_id, None)
            shutil.rmtree(job_dir, ignore_errors=True)


@app.get("/health")
def health() -> dict[str, Any]:
    _cleanup_expired()
    binary_ready = REALSR_BIN.is_file()
    model_ready = (REALSR_MODEL_DIR / "x4.param").is_file() and (
        REALSR_MODEL_DIR / "x4.bin"
    ).is_file()
    ffmpeg_ready = _configured_binary(FFMPEG_BIN)
    ffprobe_ready = _configured_binary(FFPROBE_BIN)
    seedvr2_readiness = _seedvr2_readiness()
    seedvr2_ready = all(seedvr2_readiness.values())
    nvidia_vsr_readiness = _nvidia_vsr_readiness()
    nvidia_vsr_ready = all(nvidia_vsr_readiness.values())
    flashvsr_readiness = _flashvsr_readiness()
    flashvsr_ready = all(flashvsr_readiness.values())
    openflowframes_readiness = _openflowframes_readiness()
    openflowframes_ready = all(openflowframes_readiness.values())
    video2x_readiness = _video2x_readiness()
    video2x_ready = all(video2x_readiness.values())
    max_converter = _max_converter_readiness()
    with _jobs_lock:
        running = sum(job.get("status") == "running" for job in _jobs.values())
        queued = sum(job.get("status") == "queued" for job in _jobs.values())
    return {
        "ok": bool(binary_ready and model_ready and ffmpeg_ready and ffprobe_ready and API_TOKEN),
        "engine": "realsr-ncnn-vulkan",
        "model": "RealSR DF2K",
        "availableModes": [
            "faithful",
            *(["nvidia-vsr"] if nvidia_vsr_ready else []),
            *(["generative"] if seedvr2_ready else []),
            *(["flashvsr"] if flashvsr_ready else []),
        ],
        "binaryReady": binary_ready,
        "modelReady": model_ready,
        "ffmpegReady": ffmpeg_ready,
        "ffprobeReady": ffprobe_ready,
        "tokenConfigured": bool(API_TOKEN),
        "seedvr2Ready": seedvr2_ready,
        "seedvr2Model": SEEDVR2_MODEL_LABEL,
        "seedvr2Commit": SEEDVR2_COMMIT,
        "seedvr2": seedvr2_readiness,
        "nvidiaVsrReady": nvidia_vsr_ready,
        "nvidiaVsrModel": NVIDIA_VSR_MODEL_LABEL,
        "nvidiaVfxVersion": NVIDIA_VFX_VERSION,
        "nvidiaVsrQuality": NVIDIA_VSR_QUALITY,
        "nvidiaVsr": nvidia_vsr_readiness,
        "nvidiaVsrCudaDevice": NVIDIA_VSR_CUDA_DEVICE,
        "flashVsrReady": flashvsr_ready,
        "flashVsrModel": FLASHVSR_MODEL_LABEL,
        "flashVsrVersion": FLASHVSR_VERSION,
        "flashVsrCommit": FLASHVSR_COMMIT,
        "flashVsr": flashvsr_readiness,
        "availableInterpolationEngines": [
            *(['openflowframes'] if openflowframes_ready else []),
            *(['video2x'] if video2x_ready else []),
        ],
        "openFlowFramesReady": openflowframes_ready,
        "openFlowFramesModel": OPENFLOWFRAMES_MODEL_LABEL,
        "openFlowFramesCommit": OPENFLOWFRAMES_COMMIT,
        "openFlowFrames": openflowframes_readiness,
        "video2xReady": video2x_ready,
        "video2xModel": VIDEO2X_MODEL_LABEL,
        "video2xVersion": VIDEO2X_VERSION,
        "video2x": video2x_readiness,
        "maxImportReady": bool(max_converter["binaryReady"]),
        "maxConverter": max_converter,
        "gpuId": GPU_ID,
        "tileSize": REALSR_TILE_SIZE,
        "runningJobs": running,
        "queuedJobs": queued,
        "concurrency": WORKERS,
    }


@app.post("/v1/3d-import-jobs", status_code=202)
async def create_3d_import_job(
    file: UploadFile = File(...),
    source_format: str = Form(...),
    target_format: str = Form(default="fbx"),
    authorization: str = Header(default=""),
) -> dict[str, Any]:
    _require_auth(authorization)
    _cleanup_expired()
    if source_format.strip().lower() != "max" or target_format.strip().lower() != "fbx":
        raise HTTPException(status_code=400, detail="only .max to FBX conversion is supported")
    if not MAX_BATCH_BIN.is_file():
        raise HTTPException(status_code=503, detail="3dsmaxbatch.exe is not installed")
    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    input_path = job_dir / "source.max"
    total = 0
    try:
        with input_path.open("wb") as target:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="3ds Max file exceeds worker upload limit")
                target.write(chunk)
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
    if total < 1:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="uploaded 3ds Max file is empty")
    now_ms = int(time.time() * 1000)
    record = {
        "jobId": job_id,
        "jobKind": "3d-import",
        "status": "queued",
        "phase": "queued",
        "progressPercent": 0,
        "sourceFormat": "max",
        "targetFormat": "fbx",
        "provider": "autodesk-3dsmaxbatch",
        "model": MAX_BATCH_BIN.parent.parent.name,
        "inputByteSize": total,
        "createdAtMs": now_ms,
        "updatedAtMs": now_ms,
        "inputPath": str(input_path),
        "jobDir": str(job_dir),
        "resultPath": "",
        "process": None,
        "cancelRequested": False,
        "deleteWhenFinished": False,
    }
    with _jobs_lock:
        _jobs[job_id] = record
    _executor.submit(_execute_max_import_job, job_id)
    return _public_job(record)


@app.post("/v1/jobs", status_code=202)
async def create_job(
    file: UploadFile = File(...),
    media_type: str = Form(...),
    scale: int = Form(...),
    enhance_mode: str = Form(default="faithful"),
    authorization: str = Header(default=""),
) -> dict[str, Any]:
    _require_auth(authorization)
    _cleanup_expired()
    normalized_type = media_type.strip().lower()
    normalized_mode = enhance_mode.strip().lower()
    if normalized_type not in {"image", "video"}:
        raise HTTPException(status_code=400, detail="media_type must be image or video")
    if scale not in {2, 4}:
        raise HTTPException(status_code=400, detail="scale must be 2 or 4")
    if normalized_mode not in {"faithful", "generative", "nvidia-vsr", "flashvsr"}:
        raise HTTPException(
            status_code=400,
            detail="enhance_mode must be faithful, generative, nvidia-vsr, or flashvsr",
        )
    if normalized_mode in {"nvidia-vsr", "flashvsr"} and normalized_type != "video":
        raise HTTPException(
            status_code=400,
            detail=f"{normalized_mode} is available for video only",
        )
    if not _configured_binary(FFMPEG_BIN) or not _configured_binary(FFPROBE_BIN):
        raise HTTPException(status_code=503, detail="FFmpeg or FFprobe is not installed")
    if normalized_mode == "faithful" and (
        not REALSR_BIN.is_file() or not REALSR_MODEL_DIR.is_dir()
    ):
        raise HTTPException(status_code=503, detail="RealSR binary or model is not installed")
    if normalized_mode == "generative" and not _seedvr2_ready():
        raise HTTPException(
            status_code=503,
            detail="SeedVR2 runtime or hash-verified model is not installed",
        )
    if normalized_mode == "nvidia-vsr" and not _nvidia_vsr_ready():
        raise HTTPException(
            status_code=503,
            detail="NVIDIA Video Effects SDK runtime is not installed",
        )
    if normalized_mode == "flashvsr" and not _flashvsr_ready():
        raise HTTPException(
            status_code=503,
            detail="FlashVSR v1.1 runtime or hash-verified model is not installed",
        )

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    suffix = Path(file.filename or "").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        suffix = ".mp4" if normalized_type == "video" else ".png"
    input_path = job_dir / f"source{suffix}"
    total = 0
    try:
        with input_path.open("wb") as target:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="media file exceeds worker upload limit")
                target.write(chunk)
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
    if total < 1:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="uploaded media file is empty")

    now_ms = int(time.time() * 1000)
    record = {
        "jobId": job_id,
        "status": "queued",
        "phase": "queued",
        "progressPercent": 0,
        "mediaType": normalized_type,
        "enhanceMode": normalized_mode,
        "provider": (
            "seedvr2"
            if normalized_mode == "generative"
            else "flashvsr" if normalized_mode == "flashvsr" else "nvidia-vfx" if normalized_mode == "nvidia-vsr" else "realsr-ncnn-vulkan"
        ),
        "model": (
            SEEDVR2_MODEL_LABEL
            if normalized_mode == "generative"
            else FLASHVSR_MODEL_LABEL if normalized_mode == "flashvsr" else NVIDIA_VSR_MODEL_LABEL if normalized_mode == "nvidia-vsr" else "RealSR DF2K"
        ),
        "scale": scale,
        "inputByteSize": total,
        "createdAtMs": now_ms,
        "updatedAtMs": now_ms,
        "inputPath": str(input_path),
        "jobDir": str(job_dir),
        "resultPath": "",
        "process": None,
        "cancelRequested": False,
        "deleteWhenFinished": False,
    }
    with _jobs_lock:
        _jobs[job_id] = record
    _executor.submit(_execute_job, job_id)
    return _public_job(record)


@app.post("/v1/interpolation-jobs", status_code=202)
async def create_interpolation_job(
    file: UploadFile = File(...),
    target_fps: int = Form(...),
    interpolation_engine: str = Form(...),
    authorization: str = Header(default=""),
) -> dict[str, Any]:
    _require_auth(authorization)
    _cleanup_expired()
    engine = interpolation_engine.strip().lower()
    if engine not in {"openflowframes", "video2x"}:
        raise HTTPException(
            status_code=400,
            detail="interpolation_engine must be openflowframes or video2x",
        )
    if target_fps not in {30, 60, 120}:
        raise HTTPException(status_code=400, detail="target_fps must be 30, 60, or 120")
    if not _configured_binary(FFMPEG_BIN) or not _configured_binary(FFPROBE_BIN):
        raise HTTPException(status_code=503, detail="FFmpeg or FFprobe is not installed")
    if engine == "openflowframes" and not _openflowframes_ready():
        raise HTTPException(
            status_code=503,
            detail="OpenFlowFrames RIFE 4.26 runtime is not installed",
        )
    if engine == "video2x" and not _video2x_ready():
        raise HTTPException(
            status_code=503,
            detail="Video2X 6.4 RIFE 4.26 runtime is not installed",
        )

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    suffix = Path(file.filename or "").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        suffix = ".mp4"
    input_path = job_dir / f"source{suffix}"
    total = 0
    try:
        with input_path.open("wb") as target:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="video file exceeds worker upload limit",
                    )
                target.write(chunk)
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
    if total < 1:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="uploaded video file is empty")

    provider, model = _interpolation_engine_info(engine)
    now_ms = int(time.time() * 1000)
    record = {
        "jobId": job_id,
        "jobKind": "frame-interpolation",
        "status": "queued",
        "phase": "queued",
        "progressPercent": 0,
        "mediaType": "video",
        "interpolationEngine": engine,
        "provider": provider,
        "model": model,
        "targetFps": target_fps,
        "inputByteSize": total,
        "createdAtMs": now_ms,
        "updatedAtMs": now_ms,
        "inputPath": str(input_path),
        "jobDir": str(job_dir),
        "resultPath": "",
        "process": None,
        "cancelRequested": False,
        "deleteWhenFinished": False,
    }
    with _jobs_lock:
        _jobs[job_id] = record
    _executor.submit(_execute_interpolation_job, job_id)
    return _public_job(record)


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str, authorization: str = Header(default="")) -> dict[str, Any]:
    _require_auth(authorization)
    _cleanup_expired()
    return _public_job(_job(job_id))


@app.get("/v1/jobs/{job_id}/result")
def get_result(job_id: str, authorization: str = Header(default="")) -> FileResponse:
    _require_auth(authorization)
    record = _job(job_id)
    if record.get("status") != "succeeded":
        raise HTTPException(status_code=409, detail="media enhancement result is not ready")
    result_path = Path(str(record.get("resultPath") or ""))
    if not result_path.is_file():
        raise HTTPException(status_code=410, detail="media enhancement result expired")
    return FileResponse(
        result_path,
        media_type=str(record.get("resultMimeType") or "application/octet-stream"),
        filename=str(record.get("resultFileName") or result_path.name),
    )


@app.delete("/v1/jobs/{job_id}")
def delete_job(job_id: str, authorization: str = Header(default="")) -> dict[str, Any]:
    _require_auth(authorization)
    record = _job(job_id)
    process = record.get("process")
    running = record.get("status") in {"queued", "running"}
    if running:
        _set_job(job_id, cancelRequested=True, deleteWhenFinished=True)
        _terminate(process)
        return {"jobId": job_id, "status": "cancelling"}
    with _jobs_lock:
        _jobs.pop(job_id, None)
    shutil.rmtree(Path(record["jobDir"]), ignore_errors=True)
    return {"jobId": job_id, "status": "deleted"}
