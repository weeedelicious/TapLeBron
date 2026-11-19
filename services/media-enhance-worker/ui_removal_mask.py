from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

NO_MASK = "\u6ca1\u6709\u8bc6\u522b\u5230\u56fa\u5b9a\u754c\u9762\u6216\u5934\u9876\u540d\u7247"
TOO_MUCH = "\u8bc6\u522b\u5230\u7684\u53bb\u9664\u533a\u57df\u8fc7\u5927\uff0c\u5df2\u505c\u6b62\u4ee5\u514d\u4fee\u574f\u6b63\u5e38\u753b\u9762"
UNREADABLE = "\u65e0\u6cd5\u8bfb\u53d6\u89c6\u9891"

def _print_progress(value: float) -> None:
    print("PROGRESS " + format(max(0.0, min(1.0, value)), ".4f"), flush=True)

def _run(args: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)

def _probe(ffprobe: str, path: Path) -> dict:
    completed = _run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,nb_frames,duration", "-of", "json", str(path)])
    if completed.returncode != 0:
        raise RuntimeError(UNREADABLE)
    payload = json.loads(completed.stdout.decode("utf-8", "replace") or "{}")
    stream = (payload.get("streams") or [{}])[0]
    rate = str(stream.get("avg_frame_rate") or "0/1")
    num, den = rate.split("/") if "/" in rate else (rate, "1")
    fps = float(num) / float(den) if float(den) else 0.0
    frames = str(stream.get("nb_frames") or "0")
    return {"width": int(stream.get("width") or 0), "height": int(stream.get("height") or 0), "fps": fps if fps > 0 else 24.0, "frames": int(frames) if frames.isdigit() else 0, "duration": float(stream.get("duration") or 0)}

def _analysis_size(width: int, height: int, long_side: int = 640) -> tuple[int, int]:
    scale = 1.0 if max(width, height) <= long_side else long_side / max(width, height)
    return max(16, int(round(width * scale))), max(16, int(round(height * scale)))

def _read_gray_frames(ffmpeg: str, path: Path, aw: int, ah: int) -> list[np.ndarray]:
    completed = _run([ffmpeg, "-v", "error", "-i", str(path), "-an", "-vf", "scale=" + str(aw) + ":" + str(ah) + ":flags=area", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"])
    if completed.returncode != 0:
        raise RuntimeError(UNREADABLE)
    frame_size = aw * ah
    raw = completed.stdout
    count = len(raw) // frame_size
    if count < 2 or count > 2000:
        raise RuntimeError(UNREADABLE if count < 2 else TOO_MUCH)
    frames = []
    for index in range(count):
        start = index * frame_size
        frames.append(np.frombuffer(raw[start:start + frame_size], np.uint8).reshape(ah, aw).copy())
        if index % 20 == 0:
            _print_progress(0.05 + 0.25 * index / count)
    return frames

def _temporal_std(frames: list[np.ndarray]) -> np.ndarray:
    acc = np.zeros(frames[0].shape, np.float32)
    acc2 = np.zeros(frames[0].shape, np.float32)
    for frame in frames:
        values = frame.astype(np.float32)
        acc += values
        acc2 += values * values
    count = float(len(frames))
    variance = np.maximum(acc2 / count - (acc / count) ** 2, 0)
    return np.sqrt(variance)

def _static_hud_mask(std: np.ndarray) -> np.ndarray:
    height, width = std.shape
    if float(np.mean(std < 8.0)) > 0.72:
        return np.zeros((height, width), np.uint8)
    low = (std < 8.0).astype(np.uint8) * 255
    low = cv2.morphologyEx(low, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 5)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(low, 8)
    mask = np.zeros((height, width), np.uint8)
    for index in range(1, count):
        x, y, bw, bh, area = [int(value) for value in stats[index]]
        if area < 80:
            continue
        touches_top = y <= 3
        touches_bottom = y + bh >= height - 3
        touches_left = x <= 3
        touches_right = x + bw >= width - 3
        horizontal = (touches_top or touches_bottom) and bw >= width * 0.35 and 2 <= bh <= height * 0.24
        vertical = (touches_left or touches_right) and bh >= height * 0.18 and 2 <= bw <= width * 0.16
        if (not horizontal and not vertical) or bw * bh > 0.30 * width * height:
            continue
        mask[labels == index] = 255
    return mask

def _nameplate_boxes(gray: np.ndarray) -> list[tuple[int, int, int, int]]:
    height, width = gray.shape
    blur = cv2.boxFilter(gray, ddepth=-1, ksize=(max(21, (width // 10) | 1), max(9, (height // 20) | 1)))
    dark = ((gray < 90) & (gray.astype(np.int16) + 24 < blur.astype(np.int16))).astype(np.uint8) * 255
    opened = cv2.morphologyEx(dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(11, int(width * 0.03)), 5)))
    candidate = cv2.morphologyEx(opened, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 7)))
    count, _, stats, _ = cv2.connectedComponentsWithStats((candidate > 0).astype(np.uint8), 8)
    found = []
    for index in range(1, count):
        x, y, bw, bh, area = [int(value) for value in stats[index]]
        if bh < max(8, int(height * 0.018)) or bh > height * 0.10:
            continue
        if bw < width * 0.045 or bw > width * 0.34:
            continue
        aspect = bw / max(1, bh)
        if aspect < 1.7 or aspect > 12 or area / max(1, bw * bh) < 0.35:
            continue
        if y + bh / 2 < height * 0.04 or y + bh / 2 > height * 0.88:
            continue
        roi = gray[y:y + bh, x:x + bw]
        bright = float(np.mean(roi > 170)) if roi.size else 0.0
        if roi.size == 0 or float(roi.mean()) > 130 or not (0.03 <= bright <= 0.55):
            continue
        pad_x = int(bw * 0.18)
        pad_y = int(max(2, bh * 0.75))
        found.append((bright, max(0, x - pad_x), max(0, y - pad_y), min(width, x + bw + pad_x), min(height, y + bh + pad_y)))
    found.sort(key=lambda item: item[0], reverse=True)
    return [(item[1], item[2], item[3], item[4]) for item in found[:4]]

def _neighbor_exists(per_frame, index: int, box: tuple[int, int, int, int], width: int, height: int) -> bool:
    x0, y0, x1, y1 = box
    cx, cy, bw, bh = (x0 + x1) / 2, (y0 + y1) / 2, max(1, x1 - x0), max(1, y1 - y0)
    for other_index in range(max(0, index - 8), min(len(per_frame), index + 9)):
        if other_index == index:
            continue
        for other in per_frame[other_index]:
            ox, oy = (other[0] + other[2]) / 2, (other[1] + other[3]) / 2
            ow, oh = max(1, other[2] - other[0]), max(1, other[3] - other[1])
            close = abs(cx - ox) <= max(bw * 1.4, width * 0.08) and abs(cy - oy) <= max(bh * 1.6, height * 0.06)
            similar = abs(ow - bw) <= bw * 0.8 and abs(oh - bh) <= bh * 0.8
            if close and similar:
                return True
    return False

def build_masks(gray_frames: list[np.ndarray]) -> tuple[list[np.ndarray], dict]:
    height, width = gray_frames[0].shape
    static = _static_hud_mask(_temporal_std(gray_frames))
    per_frame = [_nameplate_boxes(frame) for frame in gray_frames]
    if len(gray_frames) >= 4:
        per_frame = [[box for box in boxes if _neighbor_exists(per_frame, index, box, width, height)] for index, boxes in enumerate(per_frame)]
    masks = []
    plate_frames = 0
    for boxes in per_frame:
        mask = static.copy()
        if boxes:
            plate_frames += 1
        for x0, y0, x1, y1 in boxes:
            cv2.rectangle(mask, (x0, y0), (max(x0, x1 - 1), max(y0, y1 - 1)), 255, thickness=-1)
        if int(mask.max()) > 0:
            mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)
        masks.append(mask)
    coverage = float(np.mean([float(np.mean(mask > 0)) for mask in masks])) if masks else 0.0
    return masks, {"coverage": coverage, "plateFrames": plate_frames, "staticPixels": int(np.count_nonzero(static)), "frames": len(masks), "analysisWidth": width, "analysisHeight": height}

def _write_mask(ffmpeg: str, masks: list[np.ndarray], width: int, height: int, fps: float, output: Path) -> None:
    proc = subprocess.Popen([ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", str(width) + "x" + str(height), "-r", format(fps, ".6f"), "-i", "pipe:0", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "0", "-preset", "ultrafast", str(output)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert proc.stdin is not None and proc.stderr is not None
    try:
        for mask in masks:
            full = mask if mask.shape == (height, width) else cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
            proc.stdin.write(np.ascontiguousarray(full, dtype=np.uint8).tobytes())
    finally:
        proc.stdin.close()
    error = proc.stderr.read().decode("utf-8", "replace")
    if proc.wait() != 0 or not output.is_file():
        raise RuntimeError(error[-800:] or "mask encode failed")

def _try_sam2(args, masks: list[np.ndarray], gray_frames: list[np.ndarray]) -> bool:
    if not args.sam2_weight or not args.sam2_root:
        return False
    root = Path(args.sam2_root)
    weight = Path(args.sam2_weight)
    if not root.is_dir() or not weight.is_file():
        return False
    sys.path.insert(0, str(root))
    frame_dir = Path(args.output).parent / (Path(args.output).stem + "-sam2-frames")
    try:
        import torch
        from sam2.build_sam import build_sam2_video_predictor
        shutil.rmtree(frame_dir, ignore_errors=True)
        frame_dir.mkdir(parents=True, exist_ok=True)
        prompts = []
        for index, frame in enumerate(gray_frames):
            boxes = _nameplate_boxes(frame)
            if not boxes:
                continue
            if prompts and index - prompts[-1][0] < 8:
                continue
            prompts.append((index, boxes[0]))
            if len(prompts) >= 6:
                break
        if not prompts:
            return False
        for index, frame in enumerate(gray_frames):
            cv2.imwrite(str(frame_dir / ("{:05d}.jpg".format(index))), frame)
        predictor = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", str(weight), device="cuda")
        with torch.inference_mode():
            state = predictor.init_state(video_path=str(frame_dir))
            for obj_id, (frame_idx, box) in enumerate(prompts, start=1):
                predictor.add_new_points_or_box(state, frame_idx=frame_idx, obj_id=obj_id, box=np.array(box, dtype=np.float32))
            for frame_idx, _obj_ids, logits in predictor.propagate_in_video(state):
                if frame_idx < 0 or frame_idx >= len(masks):
                    continue
                merged = np.zeros(masks[frame_idx].shape, np.uint8)
                for logit in logits:
                    values = logit[0].detach().float().cpu().numpy() > 0.0
                    if values.shape != merged.shape:
                        values = cv2.resize(values.astype(np.uint8), (merged.shape[1], merged.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
                    merged[values] = 255
                masks[frame_idx] = cv2.bitwise_or(masks[frame_idx], merged)
        return True
    except Exception as error:
        print("SAM2_SKIPPED " + str(error).replace("\n", " ")[-400:], flush=True)
        return False
    finally:
        shutil.rmtree(frame_dir, ignore_errors=True)

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--sam2-weight", default="")
    parser.add_argument("--sam2-root", default="")
    parser.add_argument("--min-coverage", type=float, default=0.0015)
    parser.add_argument("--max-coverage", type=float, default=0.40)
    args = parser.parse_args()
    source = Path(args.input)
    output = Path(args.output)
    meta_probe = _probe(args.ffprobe, source)
    if meta_probe["width"] < 16 or meta_probe["height"] < 16:
        raise RuntimeError(UNREADABLE)
    aw, ah = _analysis_size(meta_probe["width"], meta_probe["height"])
    gray_frames = _read_gray_frames(args.ffmpeg, source, aw, ah)
    _print_progress(0.35)
    masks, meta = build_masks(gray_frames)
    _print_progress(0.55)
    used_sam2 = _try_sam2(args, masks, gray_frames)
    meta["coverage"] = float(np.mean([float(np.mean(mask > 0)) for mask in masks]))
    meta.update({"sam2": used_sam2, "width": meta_probe["width"], "height": meta_probe["height"], "fps": meta_probe["fps"]})
    if meta["coverage"] < args.min_coverage:
        print("ERROR " + NO_MASK, flush=True)
        return 2
    if meta["coverage"] > args.max_coverage:
        print("ERROR " + TOO_MUCH, flush=True)
        return 2
    output.parent.mkdir(parents=True, exist_ok=True)
    _write_mask(args.ffmpeg, masks, meta_probe["width"], meta_probe["height"], meta_probe["fps"], output)
    output.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
    print("COVERAGE " + format(meta["coverage"], ".6f"), flush=True)
    _print_progress(1)
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("ERROR " + str(error), flush=True)
        raise SystemExit(1)
