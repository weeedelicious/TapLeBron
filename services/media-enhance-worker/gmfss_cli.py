"""Interpolate a PNG sequence with GMFSS Fortuna."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as F

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--multi", type=int, default=2)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--gpu", type=int, default=0)
    return parser.parse_args()


def _frame_paths(folder: Path) -> list[Path]:
    paths = sorted(
        [path for path in folder.iterdir() if path.suffix.lower() == ".png"],
        key=lambda path: path.name,
    )
    if len(paths) < 2:
        raise RuntimeError(f"GMFSS needs at least 2 PNG frames in {folder}")
    return paths


def _to_tensor(frame_bgr: np.ndarray, device: torch.device, height: int, width: int) -> torch.Tensor:
    rgb = frame_bgr[:, :, ::-1].copy()
    tensor = torch.from_numpy(np.transpose(rgb, (2, 0, 1))).to(device).unsqueeze(0).float() / 255.0
    return F.interpolate(tensor, (height, width), mode="bilinear", align_corners=False)


def _from_tensor(tensor: torch.Tensor, height: int, width: int) -> np.ndarray:
    resized = F.interpolate(tensor, (height, width), mode="bilinear", align_corners=False)
    rgb = (resized[0] * 255.0).byte().cpu().numpy().transpose(1, 2, 0)
    return rgb[:, :, ::-1].copy()


def main() -> int:
    args = _parse_args()
    if args.multi < 2:
        raise RuntimeError("--multi must be >= 2")
    if args.scale not in {0.25, 0.5, 1.0, 2.0, 4.0}:
        raise RuntimeError("--scale must be 0.25, 0.5, 1.0, 2.0 or 4.0")

    repo = Path(args.repo).resolve()
    model_dir = Path(args.model_dir).resolve()
    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    os.chdir(repo)
    sys.path.insert(0, str(repo))

    if not torch.cuda.is_available():
        raise RuntimeError("GMFSS requires CUDA, but no GPU is visible")
    torch.cuda.set_device(max(0, args.gpu))
    device = torch.device("cuda")
    print(f"GMFSS using {torch.cuda.get_device_name(device)}", flush=True)
    torch.set_grad_enabled(False)
    if device.type == "cuda":
        torch.backends.cudnn.enabled = True
        torch.backends.cudnn.benchmark = True

    from model.GMFSS_infer_b import Model

    model = Model()
    model.load_model(str(model_dir), -1)
    model.eval()
    model.device()
    print("Loaded GMFSS Fortuna", flush=True)

    paths = _frame_paths(input_dir)
    first = cv2.imread(str(paths[0]), cv2.IMREAD_COLOR)
    if first is None:
        raise RuntimeError(f"failed to read {paths[0]}")
    src_h, src_w = first.shape[:2]
    block = max(64, int(64 / args.scale))
    pad_h = ((src_h - 1) // block + 1) * block
    pad_w = ((src_w - 1) // block + 1) * block

    written = 0
    total_out = (len(paths) - 1) * args.multi + 1

    def write_frame(image_bgr: np.ndarray) -> None:
        nonlocal written
        written += 1
        out_path = output_dir / f"{written:08d}.png"
        if not cv2.imwrite(str(out_path), image_bgr):
            raise RuntimeError(f"failed to write {out_path}")
        print(f"progress {100.0 * written / total_out:.1f}%", flush=True)

    last = first
    last_tensor = _to_tensor(last, device, pad_h, pad_w)
    write_frame(last)
    intermediates = args.multi - 1

    for index, path in enumerate(paths[1:], start=1):
        current = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if current is None:
            raise RuntimeError(f"failed to read {path}")
        current_tensor = _to_tensor(current, device, pad_h, pad_w)
        reused = model.reuse(last_tensor, current_tensor, args.scale)
        for step in range(intermediates):
            timestep = (step + 1) / args.multi
            mid = model.inference(last_tensor, current_tensor, reused, timestep)
            write_frame(_from_tensor(mid, src_h, src_w))
        write_frame(current)
        last = current
        last_tensor = current_tensor
        del reused, current_tensor
        if device.type == "cuda" and index % 8 == 0:
            torch.cuda.empty_cache()

    if written != total_out:
        raise RuntimeError(f"GMFSS wrote {written} frames; expected {total_out}")
    print(f"GMFSS wrote {written} frames", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"GMFSS interpolation failed: {error}", file=sys.stderr, flush=True)
        raise
