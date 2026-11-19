from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any


OCIO_CONFIG = "studio-config-v2.2.0_aces-v1.3_ocio-v2.4"
OCIO_OUTPUT_SPACE = "Gamma 2.4 Encoded Rec.709"
LUT_SIZE = 33

INPUT_PROFILE_SPACES = {
    "rec709": "Camera Rec.709",
    "arri-logc3": "ARRI LogC3 (EI800)",
    "arri-logc4": "ARRI LogC4",
    "sony-slog3": "S-Log3 S-Gamut3.Cine",
    "panasonic-vlog": "V-Log V-Gamut",
    "canon-log2": "CanonLog2 CinemaGamut D55",
    "canon-log3": "CanonLog3 CinemaGamut D55",
    "red-log3g10": "Log3G10 REDWideGamutRGB",
}

LOOK_PRESETS: dict[str, dict[str, Any]] = {
    "motion-picture": {"contrast": 1.06, "saturation": 0.96, "temperature": 2.0, "channels": (1.012, 1.0, 0.988), "offsets": (-0.004, 0.0, 0.004)},
    "daylight-50d": {"contrast": 1.10, "saturation": 1.06, "temperature": 5.0, "channels": (1.018, 1.004, 0.982), "offsets": (-0.006, 0.0, 0.006)},
    "tungsten-200t": {"contrast": 1.07, "saturation": 0.98, "temperature": -3.0, "channels": (0.994, 1.002, 1.012), "offsets": (0.004, 0.0, -0.003)},
    "daylight-250d": {"contrast": 1.08, "saturation": 1.02, "temperature": 4.0, "channels": (1.014, 1.002, 0.986), "offsets": (-0.004, 0.0, 0.004)},
    "tungsten-500t": {"contrast": 1.04, "saturation": 0.92, "temperature": -2.0, "channels": (0.998, 1.0, 1.010), "offsets": (0.008, 0.002, -0.004)},
    "kodak-portra-400": {"contrast": 0.96, "saturation": 0.94, "temperature": 5.0, "channels": (1.020, 1.004, 0.980), "offsets": (0.012, 0.008, 0.002)},
    "kodak-ektachrome-100d": {"contrast": 1.12, "saturation": 1.12, "temperature": -1.0, "channels": (0.998, 1.006, 1.020), "offsets": (-0.006, 0.0, 0.008)},
    "kodak-2383-print": {"contrast": 1.16, "saturation": 0.98, "temperature": 3.0, "channels": (1.018, 1.002, 0.986), "offsets": (-0.012, -0.006, -0.002)},
    "fuji-eterna-250d": {"contrast": 0.98, "saturation": 0.90, "temperature": 1.0, "channels": (0.994, 1.010, 1.012), "offsets": (0.004, 0.008, 0.010)},
    "fuji-eterna-500t": {"contrast": 0.96, "saturation": 0.86, "temperature": -3.0, "channels": (0.988, 1.010, 1.020), "offsets": (0.008, 0.010, 0.014)},
    "fuji-velvia-50": {"contrast": 1.13, "saturation": 1.28, "temperature": 1.0, "channels": (1.010, 1.012, 1.004), "offsets": (-0.006, -0.004, -0.006)},
    "low-contrast": {"contrast": 0.88, "saturation": 0.90, "temperature": 1.0, "channels": (1.0, 1.0, 1.0), "offsets": (0.025, 0.025, 0.025)},
    "black-and-white": {"contrast": 1.08, "saturation": 0.0, "temperature": 0.0, "channels": (1.0, 1.0, 1.0), "offsets": (0.0, 0.0, 0.0)},
}


def ocio_ready() -> bool:
    try:
        import PyOpenColorIO as ocio
        return str(ocio.__version__).startswith("2.")
    except Exception:
        return False


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def _grade_rgb(rgb: list[float], params: dict[str, Any]) -> list[float]:
    preset = LOOK_PRESETS[params["look"]]
    values = [float(channel) for channel in rgb]
    exposure_scale = math.pow(2.0, float(params["exposure"]))
    values = [value * exposure_scale for value in values]
    warmth = (float(params["temperature"]) + float(preset["temperature"])) / 100.0
    tint = float(params["tint"]) / 100.0
    values[0] += warmth * 0.075
    values[2] -= warmth * 0.075
    values[1] += tint * 0.055
    values[0] -= tint * 0.018
    values[2] -= tint * 0.018
    channels = preset["channels"]
    offsets = preset["offsets"]
    values = [values[index] * channels[index] + offsets[index] for index in range(3)]
    contrast = float(params["contrast"]) * float(preset["contrast"])
    pivot = 0.45
    values = [(value - pivot) * contrast + pivot for value in values]
    lift = float(params["lift"])
    gamma = max(0.05, float(params["gamma"]))
    gain = float(params["gain"])
    values = [math.pow(max(0.0, value + lift * (1.0 - value)), 1.0 / gamma) * gain for value in values]
    saturation = float(params["saturation"]) * float(preset["saturation"])
    luma = 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]
    values = [luma + saturation * (value - luma) for value in values]
    return [_clamp(value) for value in values]


def _write_ocio_lut(path: Path, params: dict[str, Any]) -> None:
    import PyOpenColorIO as ocio
    config = ocio.Config.CreateFromBuiltinConfig(OCIO_CONFIG)
    source_space = INPUT_PROFILE_SPACES[params["inputProfile"]]
    processor = config.getProcessor(source_space, OCIO_OUTPUT_SPACE).getDefaultCPUProcessor()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="ascii", newline="\n") as target:
        target.write('TITLE "Shotflow OpenColorIO Film Grade"\n')
        target.write("LUT_3D_SIZE " + str(LUT_SIZE) + "\n")
        target.write("DOMAIN_MIN 0.0 0.0 0.0\n")
        target.write("DOMAIN_MAX 1.0 1.0 1.0\n")
        divisor = float(LUT_SIZE - 1)
        for blue_index in range(LUT_SIZE):
            blue = blue_index / divisor
            for green_index in range(LUT_SIZE):
                green = green_index / divisor
                for red_index in range(LUT_SIZE):
                    color = [red_index / divisor, green, blue]
                    processor.applyRGB(color)
                    graded = _grade_rgb(color, params)
                    target.write("{:.8f} {:.8f} {:.8f}\n".format(*graded))


def _ffmpeg_filter_path(path: Path) -> str:
    value = str(path.resolve()).replace("\\", "/")
    return value.replace(":", "\\:").replace("'", "\\'")


def execute_color_grade_job(job_id: str) -> None:
    import app as worker
    job = worker._job(job_id)
    job_dir = Path(job["jobDir"])
    input_path = Path(job["inputPath"])
    params = dict(job.get("colorGrade") or {})
    try:
        if not ocio_ready():
            raise RuntimeError("OpenColorIO 2 is not installed")
        if params.get("inputProfile") not in INPUT_PROFILE_SPACES:
            raise RuntimeError("input camera profile is not supported")
        if params.get("look") not in LOOK_PRESETS:
            raise RuntimeError("film look is not supported")
        if not worker._configured_binary(worker.FFMPEG_BIN) or not worker._configured_binary(worker.FFPROBE_BIN):
            raise RuntimeError("FFmpeg or FFprobe is not installed")
        worker._set_job(job_id, status="running", phase="probing", progressPercent=2)
        source = worker._probe(input_path, count_frames=True)
        width = int(source.get("width") or 0)
        height = int(source.get("height") or 0)
        fps = float(source.get("fps") or 0)
        duration = float(source.get("durationSec") or 0)
        frames = int(source.get("frameCount") or 0)
        if width < 16 or height < 16 or fps <= 0 or duration <= 0:
            raise RuntimeError("video has no readable picture stream")
        if frames < 1:
            frames = max(1, int(round(fps * duration)))
        worker._set_job(job_id, phase="building-color-transform", progressPercent=5)
        lut_path = job_dir / "shotflow-color-grade.cube"
        _write_ocio_lut(lut_path, params)
        output_path = job_dir / "color-graded.mp4"
        lut_filter = "format=gbrpf32le,lut3d=file='" + _ffmpeg_filter_path(lut_path) + "':interp=tetrahedral,format=yuv420p"
        grain = _clamp(float(params.get("grain") or 0.0))
        if grain > 0.001:
            strength = max(1, min(24, int(round(grain * 18.0))))
            lut_filter += ",noise=alls=" + str(strength) + ":allf=t+u"
        command = [
            str(worker.FFMPEG_BIN), "-y", "-i", str(input_path), "-map", "0:v:0", "-map", "0:a?",
            "-vf", lut_filter, "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-crf", str(worker.VIDEO_CRF), "-preset", "slow", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-colorspace", "bt709",
        ]
        if source.get("hasAudio"):
            if str(source.get("audioCodecName") or "").lower() == "aac":
                command += ["-c:a", "copy"]
            else:
                command += ["-c:a", "aac", "-b:a", "192k"]
        command += ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(output_path)]
        worker._run_command(job_id, command, phase="color-grading", start_progress=10, end_progress=94, parser=worker._ffmpeg_frame_parser(frames))
        if not output_path.is_file() or output_path.stat().st_size < 1024:
            raise RuntimeError("color grading did not create a valid video")
        worker._set_job(job_id, phase="validating", progressPercent=96)
        output = worker._probe(output_path, count_frames=True)
        if int(output.get("width") or 0) != width or int(output.get("height") or 0) != height:
            raise RuntimeError("color graded video dimensions changed")
        output_frames = int(output.get("frameCount") or 0)
        if output_frames and abs(output_frames - frames) > 1:
            raise RuntimeError("color graded video frame count changed")
        if abs(float(output.get("fps") or 0) - fps) > max(0.02, fps * 0.001):
            raise RuntimeError("color graded video frame rate changed")
        if source.get("hasAudio") and not output.get("hasAudio"):
            raise RuntimeError("color graded video lost its audio track")
        worker._validate_enhanced_frame(input_path, output_path)
        import PyOpenColorIO as ocio
        metadata = {
            "engine": "OpenColorIO", "ocioVersion": ocio.__version__, "ocioConfig": OCIO_CONFIG,
            "inputProfile": params["inputProfile"], "look": params["look"], "width": output.get("width"),
            "height": output.get("height"), "fps": output.get("fps"), "durationSec": output.get("durationSec"),
            "frameCount": output.get("frameCount"), "hasAudio": output.get("hasAudio"),
            "codecName": output.get("codecName"), "pixelFormat": output.get("pixelFormat"),
        }
        worker._set_job(job_id, status="succeeded", phase="completed", progressPercent=100, resultPath=str(output_path), resultFileName="color-graded.mp4", resultMimeType="video/mp4", resultByteSize=output_path.stat().st_size, metadata=metadata, finishedAt=time.time())
    except worker.JobCancelled:
        worker._set_job(job_id, status="cancelled", phase="cancelled", progressPercent=0, error="影视校色已取消", finishedAt=time.time())
    except Exception as error:
        worker._set_job(job_id, status="failed", phase="failed", progressPercent=0, error=worker._safe_error(str(error)), finishedAt=time.time())
