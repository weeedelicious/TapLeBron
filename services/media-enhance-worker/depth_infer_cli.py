from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np


def progress(fraction: float) -> None:
    print(f'PROGRESS {max(0.0, min(1.0, fraction)):.4f}', flush=True)


def write_grayscale_mp4(frames: np.ndarray, output_path: Path, fps: float) -> None:
    import imageio.v2 as imageio

    output_path.parent.mkdir(parents=True, exist_ok=True)
    rate = float(fps) if fps and fps > 0 else 24.0
    writer = imageio.get_writer(
        str(output_path),
        fps=rate,
        codec='libx264',
        macro_block_size=1,
        ffmpeg_params=['-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'pc'],
    )
    try:
        for frame in frames:
            gray = np.asarray(frame)
            if gray.ndim == 3:
                gray = gray[..., 0]
            gray = np.clip(gray, 0, 255).astype(np.uint8)
            writer.append_data(np.repeat(gray[..., None], 3, axis=2))
    finally:
        writer.close()


def normalize_depth(depth: np.ndarray, near: str) -> np.ndarray:

    values = np.asarray(depth, dtype=np.float32)

    finite = np.isfinite(values)

    if not finite.any():

        raise RuntimeError('depth model returned an empty map')

    flat = values[finite]

    stride = max(1, int(flat.size // 2000000))

    sample = flat[::stride]

    low = float(np.percentile(sample, 3))

    high = float(np.percentile(sample, 97))

    if high - low < 1e-6:

        low = float(sample.min())

        high = float(sample.max())

    if high - low < 1e-6:

        gray = np.zeros(values.shape, dtype=np.uint8)

    else:

        scaled = np.clip((values - low) / (high - low), 0, 1)

        gray = np.clip(scaled * 255, 0, 255).astype(np.uint8)

    if near == 'dark':

        gray = 255 - gray

    return gray


def run_video_depth_anything(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    if not (repo / 'run.py').is_file():
        raise RuntimeError('Video Depth Anything repo is not installed')
    checkpoint = repo / 'checkpoints' / f'video_depth_anything_{args.encoder}.pth'
    if not checkpoint.is_file():
        raise RuntimeError(f'Video Depth Anything checkpoint is missing: {checkpoint.name}')
    os.chdir(repo)
    sys.path.insert(0, str(repo))
    import torch
    from utils.dc_utils import read_video_frames
    from video_depth_anything.video_depth import VideoDepthAnything

    progress(0.08)
    configs = {
        'vits': {'encoder': 'vits', 'features': 64, 'out_channels': [48, 96, 192, 384]},
        'vitb': {'encoder': 'vitb', 'features': 128, 'out_channels': [96, 192, 384, 768]},
        'vitl': {'encoder': 'vitl', 'features': 256, 'out_channels': [256, 512, 1024, 1024]},
    }
    device = 'cuda' if torch.cuda.is_available() and not args.cpu else 'cpu'
    model = VideoDepthAnything(**configs[args.encoder], metric=False)
    model.load_state_dict(torch.load(checkpoint, map_location='cpu'), strict=True)
    model = model.to(device).eval()
    progress(0.22)
    frames, fps = read_video_frames(args.input, -1, -1, int(args.max_res))
    progress(0.32)
    depths, fps = model.infer_video_depth(
        frames,
        fps,
        input_size=int(args.input_size),
        device=device,
        fp32=bool(args.fp32 or device == 'cpu'),
    )
    progress(0.86)
    gray = normalize_depth(np.asarray(depths), args.near)
    write_grayscale_mp4(gray, Path(args.output), float(fps))
    progress(1)


def run_depthcrafter(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    if not (repo / 'run.py').is_file():
        raise RuntimeError('DepthCrafter repo is not installed')
    os.chdir(repo)
    sys.path.insert(0, str(repo))
    import torch
    from depthcrafter.inference import DepthCrafterInference
    from depthcrafter.utils import read_video_frames

    progress(0.08)
    pipe = DepthCrafterInference(
        unet_path=args.unet,
        pre_train_path=args.pretrain,
        cpu_offload='model' if not args.cpu else 'sequential',
        device='cpu' if args.cpu else 'cuda',
    )
    progress(0.28)
    frames, fps = read_video_frames(
        args.input,
        process_length=-1,
        target_fps=-1,
        max_res=int(args.max_res),
        dataset='open',
    )
    progress(0.36)
    with torch.inference_mode():
        result = pipe.pipe(
            frames,
            height=frames.shape[1],
            width=frames.shape[2],
            output_type='np',
            guidance_scale=float(args.guidance),
            num_inference_steps=int(args.steps),
            window_size=int(args.window_size),
            overlap=int(args.overlap),
            track_time=False,
        ).frames[0]
    progress(0.88)
    depth = np.asarray(result, dtype=np.float32)
    if depth.ndim == 4:
        depth = depth.sum(-1) / depth.shape[-1]
    low = float(np.min(depth))
    high = float(np.max(depth))
    if high - low < 1e-6:
        normalized = np.zeros_like(depth)
    else:
        normalized = (depth - low) / (high - low)
    gray = normalize_depth(normalized, args.near)
    write_grayscale_mp4(gray, Path(args.output), float(fps))
    pipe.clear_cache()
    progress(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Render a grayscale depth video')
    parser.add_argument('--provider', required=True, choices=['video-depth-anything', 'depthcrafter'])
    parser.add_argument('--repo', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--encoder', default='vitl')
    parser.add_argument('--max-res', type=int, default=1280)
    parser.add_argument('--input-size', type=int, default=518)
    parser.add_argument('--near', choices=['bright', 'dark'], default='bright')
    parser.add_argument('--unet', default='tencent/DepthCrafter')
    parser.add_argument('--pretrain', default='stabilityai/stable-video-diffusion-img2vid-xt')
    parser.add_argument('--steps', type=int, default=5)
    parser.add_argument('--guidance', type=float, default=1.0)
    parser.add_argument('--window-size', type=int, default=110)
    parser.add_argument('--overlap', type=int, default=25)
    parser.add_argument('--fp32', action='store_true')
    parser.add_argument('--cpu', action='store_true')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    progress(0.02)
    if args.provider == 'video-depth-anything':
        run_video_depth_anything(args)
    else:
        run_depthcrafter(args)
    if not Path(args.output).is_file() or Path(args.output).stat().st_size < 1:
        raise RuntimeError('depth video was not written')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
