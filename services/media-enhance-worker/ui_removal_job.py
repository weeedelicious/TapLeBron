from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

MAX_DURATION_SEC = 30.0
MIN_DIFFU_FRAMES = 22
TOO_LONG = "\u53bb\u9664 UI \u76ee\u524d\u53ea\u5904\u7406 30 \u79d2\u4ee5\u5185\u7684\u89c6\u9891"
TOO_SHORT = "\u753b\u8d28\u4f18\u5148\u65b9\u6848\u81f3\u5c11\u9700\u8981 22 \u5e27"
NO_RESULT = "\u53bb\u9664 UI \u6ca1\u6709\u751f\u6210\u7ed3\u679c\u89c6\u9891"
BAD_VIDEO = "\u89c6\u9891\u6ca1\u6709\u6709\u6548\u753b\u9762"
MISSING_WEIGHT = "ProPainter \u6743\u91cd\u7f3a\u5931"
CANCELLED = "\u53bb\u9664 UI \u5df2\u53d6\u6d88"


def _progress_parser(line: str):
    text = str(line or "").strip()
    if text.startswith("PROGRESS "):
        try:
            return max(0.0, min(1.0, float(text.split()[1])))
        except (IndexError, ValueError):
            return None
    return None


def _child_env(worker) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    env["CUDA_VISIBLE_DEVICES"] = str(getattr(worker, "GPU_ID", 0))
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["DIFFUSERS_OFFLINE"] = "1"
    return env


def _process_size(width: int, height: int) -> tuple[int, int]:
    scale = 1.0
    long_side = max(width, height)
    if long_side > 960:
        scale = 960.0 / long_side
    short_side = min(width, height) * scale
    if short_side < 256:
        scale *= 256.0 / max(1.0, short_side)
    out_w = max(256, int(round(width * scale / 8.0)) * 8)
    out_h = max(256, int(round(height * scale / 8.0)) * 8)
    return out_w, out_h


def _ensure_propainter_weights(worker) -> None:
    dest_dir = worker.UI_REMOVAL_ROOT / "ProPainter" / "weights"
    source_dir = worker.UI_REMOVAL_ROOT / "DiffuEraser" / "weights" / "propainter"
    dest_dir.mkdir(parents=True, exist_ok=True)
    for name in ("raft-things.pth", "recurrent_flow_completion.pth"):
        dest = dest_dir / name
        source = source_dir / name
        if dest.is_file() and dest.stat().st_size > 1000000:
            continue
        if not source.is_file():
            raise RuntimeError(MISSING_WEIGHT + ": " + name)
        shutil.copyfile(source, dest)


def _sam2_ready(worker) -> bool:
    root = worker.UI_REMOVAL_ROOT / "sam2"
    if not root.is_dir() or not worker.SAM2_WEIGHT.is_file():
        return False
    env = _child_env(worker)
    env["PYTHONPATH"] = str(root)
    try:
        completed = subprocess.run(
            [str(worker.PROPAINTER_PYTHON), "-c", "import sam2"],
            cwd=str(root), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=40, creationflags=getattr(worker, "_creation_flags", 0), check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def _newest(root: Path, name: str) -> Path | None:
    matches = [item for item in root.rglob(name) if item.is_file() and item.stat().st_size > 1024]
    if not matches:
        return None
    return max(matches, key=lambda item: item.stat().st_mtime)


def _composite_graph(width: int, height: int, source_frames: int, inpaint_frames: int, fps: float) -> str:
    prefix = "[1:v]scale={0}:{1}:flags=lanczos,setsar=1".format(width, height)
    if source_frames > 0 and inpaint_frames > 0 and inpaint_frames + 1 < source_frames:
        pad = (source_frames - inpaint_frames) / max(fps, 1.0)
        prefix += ",tpad=stop_mode=clone:stop_duration={:.3f}".format(pad)
    prefix += ",format=rgba[inp]"
    return ";".join([
        prefix,
        "[2:v]scale={0}:{1}:flags=neighbor,format=gray[ma]".format(width, height),
        "[inp][ma]alphamerge[ov]",
        "[0:v]setsar=1[base]",
        "[base][ov]overlay=shortest=1[v]",
    ])


def execute_ui_removal_job(job_id: str) -> None:
    import app as worker
    job = worker._job(job_id)
    job_dir = Path(job["jobDir"])
    input_path = Path(job["inputPath"])
    method = str(job.get("uiRemovalMethod") or "").strip().lower()
    try:
        if method not in {"propainter", "diffueraser"}:
            raise RuntimeError("method must be propainter or diffueraser")
        if not worker._configured_binary(worker.FFMPEG_BIN) or not worker._configured_binary(worker.FFPROBE_BIN):
            raise RuntimeError("FFmpeg or FFprobe is not installed")
        worker._set_job(job_id, status="running", phase="probing", progressPercent=2)
        if not input_path.is_file() or input_path.stat().st_size < 1:
            raise RuntimeError(BAD_VIDEO)
        source = worker._probe(input_path)
        duration = float(source.get("durationSec") or 0)
        width = int(source.get("width") or 0)
        height = int(source.get("height") or 0)
        if width < 16 or height < 16 or duration <= 0:
            raise RuntimeError(BAD_VIDEO)
        if duration > MAX_DURATION_SEC + 0.05:
            raise RuntimeError(TOO_LONG)
        frames = int(source.get("frameCount") or 0)
        if frames <= 0:
            source = worker._probe(input_path, count_frames=True)
            frames = int(source.get("frameCount") or 0)
        if method == "diffueraser" and frames < MIN_DIFFU_FRAMES:
            raise RuntimeError(TOO_SHORT)
        _ensure_propainter_weights(worker)
        proc_w, proc_h = _process_size(width, height)
        mask_path = job_dir / "mask.mp4"
        work_path = job_dir / "work.mp4"
        mask_work = job_dir / "mask-work.mp4"
        out_dir = job_dir / "model-out"
        final_path = job_dir / "ui-removed.mp4"
        out_dir.mkdir(parents=True, exist_ok=True)
        mask_cmd = [
            str(worker.PROPAINTER_PYTHON), str(worker.ROOT / "ui_removal_mask.py"),
            "--input", str(input_path), "--output", str(mask_path),
            "--ffmpeg", str(worker.FFMPEG_BIN), "--ffprobe", str(worker.FFPROBE_BIN),
        ]
        if _sam2_ready(worker):
            mask_cmd += ["--sam2-weight", str(worker.SAM2_WEIGHT), "--sam2-root", str(worker.UI_REMOVAL_ROOT / "sam2")]
        worker._run_command(job_id, mask_cmd, phase="masking", start_progress=8, end_progress=36, parser=_progress_parser, env=_child_env(worker))
        meta_path = mask_path.with_suffix(".json")
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
        rate = "{:.6f}".format(float(source.get("fps") or 24))
        worker._run_command(job_id, [str(worker.FFMPEG_BIN), "-y", "-i", str(input_path), "-an", "-vf", "scale={0}:{1}:flags=lanczos,setsar=1".format(proc_w, proc_h), "-r", rate, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", "-preset", "veryfast", str(work_path)], phase="scaling", start_progress=38, end_progress=44, parser=worker._ffmpeg_frame_parser(max(1, frames)))
        worker._run_command(job_id, [str(worker.FFMPEG_BIN), "-y", "-i", str(mask_path), "-an", "-vf", "scale={0}:{1}:flags=neighbor,setsar=1,format=gray".format(proc_w, proc_h), "-r", rate, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "0", "-preset", "ultrafast", str(mask_work)], phase="scaling-mask", start_progress=44, end_progress=47, parser=worker._ffmpeg_frame_parser(max(1, frames)))
        mask_dir = job_dir / "mask-frames"
        if mask_dir.exists():
            shutil.rmtree(mask_dir)
        mask_dir.mkdir()
        worker._run_command(job_id, [str(worker.FFMPEG_BIN), "-y", "-i", str(mask_work), "-start_number", "0", str(mask_dir / "%05d.png")], phase="scaling-mask", start_progress=47, end_progress=48, parser=worker._ffmpeg_frame_parser(max(1, frames)))
        env = _child_env(worker)
        if method == "propainter":
            repo = worker.UI_REMOVAL_ROOT / "ProPainter"
            worker._run_command(job_id, [str(worker.PROPAINTER_PYTHON), str(repo / "inference_propainter.py"), "-i", str(work_path), "-m", str(mask_dir), "-o", str(out_dir), "--width", str(proc_w), "--height", str(proc_h), "--fp16", "--mask_dilation", "4", "--subvideo_length", "40", "--neighbor_length", "8", "--ref_stride", "10", "--raft_iter", "12"], phase="inpainting", start_progress=48, end_progress=88, parser=_progress_parser, cwd=repo, env=env)
            inpaint = _newest(out_dir, "inpaint_out.mp4")
        else:
            repo = worker.UI_REMOVAL_ROOT / "DiffuEraser"
            weights = repo / "weights"
            seconds = max(1, int(math.ceil(duration - 1e-3)))
            worker._run_command(job_id, [str(worker.DIFFU_PYTHON), str(repo / "run_diffueraser.py"), "--input_video", str(work_path), "--input_mask", str(mask_work), "--video_length", str(seconds), "--mask_dilation_iter", "4", "--max_img_size", "960", "--save_path", str(out_dir), "--ref_stride", "10", "--neighbor_length", "8", "--subvideo_length", "40", "--base_model_path", str(weights / "stable-diffusion-v1-5"), "--vae_path", str(weights / "sd-vae-ft-mse"), "--diffueraser_path", str(weights / "diffuEraser"), "--propainter_model_dir", str(weights / "propainter")], phase="inpainting", start_progress=48, end_progress=88, parser=_progress_parser, cwd=repo, env=env)
            inpaint = _newest(out_dir, "diffueraser_result.mp4")
        if inpaint is None:
            raise RuntimeError(NO_RESULT)
        in_meta = worker._probe(inpaint)
        graph = _composite_graph(width, height, frames, int(in_meta.get("frameCount") or 0), float(source.get("fps") or 24))
        compose = [str(worker.FFMPEG_BIN), "-y", "-i", str(input_path), "-i", str(inpaint), "-i", str(mask_path), "-filter_complex", graph, "-map", "[v]"]
        if source.get("hasAudio"):
            compose += ["-map", "0:a", "-c:a", "aac", "-b:a", "192k"]
        compose += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(worker.VIDEO_CRF), "-preset", "medium", "-movflags", "+faststart", "-t", "{:.3f}".format(duration), str(final_path)]
        worker._run_command(job_id, compose, phase="compositing", start_progress=90, end_progress=98, parser=worker._ffmpeg_frame_parser(max(1, frames)))
        if not final_path.is_file() or final_path.stat().st_size < 1024:
            raise RuntimeError(NO_RESULT)
        output = worker._probe(final_path)
        worker._set_job(job_id, status="succeeded", phase="completed", progressPercent=100, resultPath=str(final_path), resultFileName="ui-removed.mp4", resultMimeType="video/mp4", resultByteSize=final_path.stat().st_size, metadata={"method": method, "maskCoverage": meta.get("coverage"), "sam2": bool(meta.get("sam2")), "plateFrames": meta.get("plateFrames"), "processWidth": proc_w, "processHeight": proc_h, "width": output.get("width"), "height": output.get("height"), "fps": output.get("fps"), "durationSec": output.get("durationSec"), "frameCount": output.get("frameCount"), "hasAudio": output.get("hasAudio")}, finishedAt=__import__("time").time())
    except worker.JobCancelled:
        worker._set_job(job_id, status="cancelled", phase="cancelled", progressPercent=0, error=CANCELLED, finishedAt=__import__("time").time())
    except Exception as error:
        worker._set_job(job_id, status="failed", phase="failed", progressPercent=0, error=worker._safe_error(str(error)), finishedAt=__import__("time").time())


def _preview_size(width: int, height: int) -> tuple[int, int]:
    long_side = max(width, height)
    scale = 960.0 / long_side if long_side > 960 else 1.0
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def _preview_filter(width: int, height: int, fps: float, duration: float) -> str:
    preview_w, preview_h = _preview_size(width, height)
    rate = "{:.3f}".format(max(fps, 1.0))
    length = "{:.3f}".format(max(duration, 0.1))
    return ";".join([
        "[0:v]scale={0}:{1}:flags=lanczos,setsar=1[base]".format(preview_w, preview_h),
        "[1:v]scale={0}:{1}:flags=neighbor,format=gray[mask]".format(preview_w, preview_h),
        "color=c=0xff3344:s={0}x{1}:r={2}:d={3},format=rgba[red]".format(preview_w, preview_h, rate, length),
        "[red][mask]alphamerge,colorchannelmixer=aa=0.62[overlay]",
        "[base][overlay]overlay=shortest=1[v]",
    ])


def render_mask_preview(input_path: Path, output_path: Path) -> dict:
    import app as worker
    if not input_path.is_file() or input_path.stat().st_size < 1:
        raise RuntimeError(BAD_VIDEO)
    if not worker._configured_binary(worker.FFMPEG_BIN) or not worker._configured_binary(worker.FFPROBE_BIN):
        raise RuntimeError("FFmpeg or FFprobe is not installed")
    source = worker._probe(input_path)
    duration = float(source.get("durationSec") or 0)
    width = int(source.get("width") or 0)
    height = int(source.get("height") or 0)
    if width < 16 or height < 16 or duration <= 0:
        raise RuntimeError(BAD_VIDEO)
    if duration > MAX_DURATION_SEC + 0.05:
        raise RuntimeError(TOO_LONG)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    mask_path = output_path.parent / "mask.mp4"
    command = [
        str(worker.PROPAINTER_PYTHON),
        str(worker.ROOT / "ui_removal_mask.py"),
        "--input", str(input_path),
        "--output", str(mask_path),
        "--ffmpeg", str(worker.FFMPEG_BIN),
        "--ffprobe", str(worker.FFPROBE_BIN),
    ]
    if _sam2_ready(worker):
        command += ["--sam2-weight", str(worker.SAM2_WEIGHT), "--sam2-root", str(worker.UI_REMOVAL_ROOT / "sam2")]
    env = _child_env(worker)
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=env, creationflags=getattr(worker, "_creation_flags", 0), check=False)
    if completed.returncode != 0 or not mask_path.is_file():
        raise RuntimeError(worker._safe_error(completed.stdout or "mask preview failed"))
    meta_path = mask_path.with_suffix(".json")
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
    graph = _preview_filter(width, height, float(source.get("fps") or 24), duration)
    encoded = subprocess.run([
        str(worker.FFMPEG_BIN), "-y", "-i", str(input_path), "-i", str(mask_path),
        "-filter_complex", graph, "-map", "[v]", "-an",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "veryfast", "-movflags", "+faststart",
        str(output_path),
    ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=getattr(worker, "_creation_flags", 0), check=False)
    if encoded.returncode != 0 or not output_path.is_file() or output_path.stat().st_size < 1024:
        raise RuntimeError(worker._safe_error(encoded.stdout or "preview encode failed"))
    meta["previewWidth"], meta["previewHeight"] = _preview_size(width, height)
    return meta
