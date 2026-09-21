"""Apply NVIDIA Video Effects SDK VideoSuperRes to a PNG frame sequence.

This process intentionally exits with ``os._exit``.  NVIDIA VFX 0.1.0.1 on
the production Windows 4090 completes inference correctly but can block while
destroying the effect.  Each Shotflow job owns one subprocess, so bypassing
interpreter teardown after all PNG files are flushed is safe and keeps task
cancellation/recovery deterministic.
"""

from __future__ import annotations

import argparse
import os
import sys
import traceback
from pathlib import Path


def _finish(exit_code: int) -> None:
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(exit_code)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--output-width", type=int, required=True)
    parser.add_argument("--output-height", type=int, required=True)
    parser.add_argument("--quality", default="ULTRA")
    parser.add_argument("--device", type=int, default=0)
    args = parser.parse_args()

    if args.output_width < 2 or args.output_height < 2:
        raise ValueError("NVIDIA VSR output dimensions must be at least 2x2")
    frames = sorted(args.input_dir.glob("*.png"))
    if not frames:
        raise ValueError("NVIDIA VSR input directory contains no PNG frames")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    import numpy as np
    import torch
    from PIL import Image
    from nvvfx import VideoSuperRes

    quality_name = args.quality.strip().upper()
    try:
        quality = getattr(VideoSuperRes.QualityLevel, quality_name)
    except AttributeError as error:
        raise ValueError(f"unsupported NVIDIA VSR quality: {quality_name}") from error

    torch.cuda.set_device(args.device)
    effect = VideoSuperRes(quality=quality, device=args.device)
    effect.output_width = args.output_width
    effect.output_height = args.output_height
    print(f"loading NVIDIA VSR {quality_name}", flush=True)
    effect.load()
    print("NVIDIA VSR loaded", flush=True)

    total = len(frames)
    with torch.inference_mode():
        for index, source_path in enumerate(frames, start=1):
            with Image.open(source_path) as source_image:
                rgb = np.asarray(source_image.convert("RGB"), dtype=np.float32) / 255.0
            source = (
                torch.from_numpy(rgb)
                .permute(2, 0, 1)
                .contiguous()
                .to(device=f"cuda:{args.device}", dtype=torch.float32)
            )
            result = effect.run(source)
            enhanced = torch.from_dlpack(result.image).clone()
            output = (
                enhanced.clamp_(0, 1)
                .mul_(255)
                .round_()
                .to(torch.uint8)
                .permute(1, 2, 0)
                .contiguous()
                .cpu()
                .numpy()
            )
            if output.shape[:2] != (args.output_height, args.output_width):
                raise RuntimeError(
                    "NVIDIA VSR returned "
                    f"{output.shape[1]}x{output.shape[0]}, expected "
                    f"{args.output_width}x{args.output_height}"
                )
            Image.fromarray(output, mode="RGB").save(
                args.output_dir / f"{index:08d}.png",
                format="PNG",
                compress_level=1,
            )
            del source, enhanced, output, result
            print(f"frame {index}/{total} {index * 100 / total:.2f}%", flush=True)
    # Exit while ``effect`` is still a live local. Returning from this function
    # would run its destructor first, which reaches the same blocking close path.
    _finish(0)


if __name__ == "__main__":
    try:
        main()
        _finish(1)  # main() must terminate through _finish(0)
    except BaseException:  # noqa: BLE001 - subprocess must surface native SDK errors
        traceback.print_exc()
        _finish(1)
