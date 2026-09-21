"""Run the official FlashVSR v1.1 Tiny Long pipeline on a PNG sequence.

The Shotflow worker owns decoding, audio preservation and final RV-compatible
MP4 encoding.  This helper only performs generative video restoration and
writes an exact one-based PNG sequence.  Long inputs are processed with
overlap so GPU/RAM use stays bounded and chunk boundaries keep temporal
context.
"""

from __future__ import annotations

import argparse
import gc
import re
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image


# The Windows worker may inherit the system GBK console code page.  Upstream
# prints a Unicode startup banner (including ⚡), which must never abort a GPU
# job before inference starts.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


MIN_MODEL_FRAMES = 21
MODEL_FRAME_REMAINDER = 5  # Tiny Long returns 8n-3 frames.


def _natural_key(path: Path) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def _aligned_count(count: int) -> int:
    count = max(MIN_MODEL_FRAMES, count)
    return count + ((MODEL_FRAME_REMAINDER - count) % 8)


def _padded_size(value: int) -> int:
    return ((value + 127) // 128) * 128


def _frame_tensor(path: Path, width: int, height: int, padded_width: int, padded_height: int) -> torch.Tensor:
    with Image.open(path) as opened:
        image = opened.convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
        pixels = np.asarray(image, dtype=np.uint8)
    if padded_width != width or padded_height != height:
        pixels = np.pad(
            pixels,
            ((0, padded_height - height), (0, padded_width - width), (0, 0)),
            mode="edge",
        )
    tensor = torch.from_numpy(np.ascontiguousarray(pixels)).permute(2, 0, 1)
    return tensor.to(dtype=torch.float32).div_(127.5).sub_(1).to(dtype=torch.bfloat16)


def _prepare_chunk(
    paths: list[Path],
    width: int,
    height: int,
    padded_width: int,
    padded_height: int,
) -> tuple[torch.Tensor, int]:
    output_count = _aligned_count(len(paths))
    model_paths = paths + [paths[-1]] * (output_count - len(paths) + 4)
    frames = [
        _frame_tensor(path, width, height, padded_width, padded_height)
        for path in model_paths
    ]
    video = torch.stack(frames, dim=0).permute(1, 0, 2, 3).unsqueeze(0)
    return video, output_count + 4


def _load_pipeline(repo: Path, model_dir: Path):
    sys.path.insert(0, str(repo))
    sys.path.insert(0, str(repo / "examples" / "WanVSR"))
    from diffsynth import FlashVSRTinyLongPipeline, ModelManager
    from utils.TCDecoder import build_tcdecoder
    from utils.utils import Causal_LQ4x_Proj

    dit_path = model_dir / "diffusion_pytorch_model_streaming_dmd.safetensors"
    vae_path = model_dir / "Wan2.1_VAE.pth"
    lq_path = model_dir / "LQ_proj_in.ckpt"
    decoder_path = model_dir / "TCDecoder.ckpt"
    prompt_path = repo / "examples" / "WanVSR" / "prompt_tensor" / "posi_prompt.pth"
    required = (dit_path, vae_path, lq_path, decoder_path, prompt_path)
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise FileNotFoundError("FlashVSR runtime is incomplete: " + ", ".join(missing))

    manager = ModelManager(torch_dtype=torch.bfloat16, device="cpu")
    # The upstream Tiny Long example only lists the DiT, although the pipeline
    # immediately fetches and later decodes with ``wan_video_vae``.  Load the
    # published v1.1 VAE explicitly so the pipeline never starts with vae=None.
    manager.load_models([str(dit_path), str(vae_path)])
    pipe = FlashVSRTinyLongPipeline.from_model_manager(manager, device="cuda")
    pipe.denoising_model().LQ_proj_in = Causal_LQ4x_Proj(
        in_dim=3,
        out_dim=1536,
        layer_num=1,
    ).to("cuda", dtype=torch.bfloat16)
    pipe.denoising_model().LQ_proj_in.load_state_dict(
        torch.load(lq_path, map_location="cpu"),
        strict=True,
    )
    pipe.denoising_model().LQ_proj_in.to("cuda")
    pipe.TCDecoder = build_tcdecoder(new_channels=[512, 256, 128, 128], new_latent_channels=784)
    pipe.TCDecoder.load_state_dict(torch.load(decoder_path, map_location="cpu"), strict=False)
    pipe.to("cuda")
    pipe.enable_vram_management(num_persistent_param_in_dit=None)
    context = torch.load(prompt_path, map_location="cpu")
    pipe.init_cross_kv(context_tensor=context)
    pipe.load_models_to_device(["dit", "vae"])
    return pipe


def _save_frames(
    video: torch.Tensor,
    output_dir: Path,
    source_start: int,
    discard: int,
    real_count: int,
    width: int,
    height: int,
) -> int:
    available = int(video.shape[1])
    if available < real_count:
        raise RuntimeError(f"FlashVSR returned {available} frames for a {real_count}-frame chunk")
    written = 0
    for local_index in range(discard, real_count):
        frame = video[:, local_index, :height, :width]
        pixels = (
            frame.float()
            .add_(1)
            .mul_(127.5)
            .clamp_(0, 255)
            .permute(1, 2, 0)
            .to(dtype=torch.uint8, device="cpu")
            .numpy()
        )
        output_index = source_start + local_index + 1
        Image.fromarray(pixels, mode="RGB").save(
            output_dir / f"{output_index:08d}.png",
            compress_level=1,
        )
        written += 1
    return written


def run(args: argparse.Namespace) -> None:
    repo = args.repo.resolve()
    model_dir = args.model_dir.resolve()
    input_paths = sorted(args.input_dir.resolve().glob("*.png"), key=_natural_key)
    if not input_paths:
        raise ValueError("FlashVSR input directory contains no PNG frames")
    if args.chunk_overlap >= args.chunk_frames:
        raise ValueError("FlashVSR chunk overlap must be smaller than chunk size")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if any(args.output_dir.glob("*.png")):
        raise ValueError("FlashVSR output directory must be empty")

    padded_width = _padded_size(args.output_width)
    padded_height = _padded_size(args.output_height)
    print(
        f"Loading FlashVSR v1.1 for {len(input_paths)} frames at "
        f"{args.output_width}x{args.output_height} (padded {padded_width}x{padded_height})",
        flush=True,
    )
    pipe = _load_pipeline(repo, model_dir)
    total = len(input_paths)
    start = 0
    completed = 0
    while start < total:
        end = min(total, start + args.chunk_frames)
        chunk_paths = input_paths[start:end]
        discard = 0 if start == 0 else min(args.chunk_overlap, len(chunk_paths))
        lq_video, model_frames = _prepare_chunk(
            chunk_paths,
            args.output_width,
            args.output_height,
            padded_width,
            padded_height,
        )
        restored = pipe(
            prompt="",
            negative_prompt="",
            cfg_scale=1.0,
            num_inference_steps=1,
            seed=args.seed,
            LQ_video=lq_video,
            num_frames=model_frames,
            height=padded_height,
            width=padded_width,
            is_full_block=False,
            if_buffer=True,
            topk_ratio=args.sparse_ratio * 768 * 1280 / (padded_height * padded_width),
            kv_ratio=3.0,
            local_range=args.local_range,
            color_fix=True,
        )
        completed += _save_frames(
            restored,
            args.output_dir,
            start,
            discard,
            len(chunk_paths),
            args.output_width,
            args.output_height,
        )
        progress = min(100.0, completed * 100.0 / total)
        print(f"FLASHVSR_PROGRESS={progress:.2f}%", flush=True)
        del lq_video, restored
        gc.collect()
        torch.cuda.empty_cache()
        if end >= total:
            break
        next_start = end - args.chunk_overlap
        if next_start <= start:
            raise RuntimeError("FlashVSR chunk settings do not advance the input")
        start = next_start

    outputs = list(args.output_dir.glob("*.png"))
    if len(outputs) != total:
        raise RuntimeError(f"FlashVSR wrote {len(outputs)} frames for {total} source frames")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--output-width", type=int, required=True)
    parser.add_argument("--output-height", type=int, required=True)
    parser.add_argument("--local-range", type=int, choices=(9, 11), default=11)
    parser.add_argument("--sparse-ratio", type=float, default=2.0)
    parser.add_argument("--chunk-frames", type=int, default=85)
    parser.add_argument("--chunk-overlap", type=int, default=21)
    parser.add_argument("--seed", type=int, default=42)
    parsed = parser.parse_args()
    if parsed.output_width < 2 or parsed.output_height < 2:
        parser.error("output dimensions must be at least 2x2")
    return parsed


if __name__ == "__main__":
    run(parse_args())
