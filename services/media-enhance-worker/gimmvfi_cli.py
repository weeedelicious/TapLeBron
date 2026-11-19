"""Interpolate a PNG sequence with GIMM-VFI R-P."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")



class InputPadder:
    def __init__(self, dims, divis_by=32):
        self.ht, self.wd = int(dims[-2]), int(dims[-1])
        pad_ht = (((self.ht // divis_by) + 1) * divis_by - self.ht) % divis_by
        pad_wd = (((self.wd // divis_by) + 1) * divis_by - self.wd) % divis_by
        self._pad = [pad_wd // 2, pad_wd - pad_wd // 2, pad_ht // 2, pad_ht - pad_ht // 2]

    def pad(self, *inputs):
        import torch.nn.functional as F
        return [F.pad(x, self._pad, mode="replicate") for x in inputs]

    def unpad(self, x):
        ht, wd = x.shape[-2:]
        c = [self._pad[2], ht - self._pad[3], self._pad[0], wd - self._pad[1]]
        return x[..., c[0]:c[1], c[2]:c[3]]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--multi", type=int, default=2)
    parser.add_argument("--ds-factor", type=float, default=1.0)
    parser.add_argument("--config", default="configs/gimmvfi/gimmvfi_r_arb.yaml")
    parser.add_argument("--checkpoint", default="pretrained_ckpt/gimmvfi_r_arb_lpips.pt")
    parser.add_argument("--gpu", type=int, default=0)
    return parser.parse_args()


def _frame_paths(folder: Path) -> list[Path]:
    paths = sorted(
        [path for path in folder.iterdir() if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}],
        key=lambda path: path.name,
    )
    if len(paths) < 2:
        raise RuntimeError(f"GIMM-VFI needs at least 2 frames in {folder}")
    return paths


def _load_image(path: Path, device: torch.device) -> torch.Tensor:
    image = Image.open(path).convert("RGB")
    array = np.array(image)
    tensor = torch.from_numpy(array.copy()).permute(2, 0, 1).float() / 255.0
    return tensor.unsqueeze(0).to(device, non_blocking=True)


def _to_bgr(tensor: torch.Tensor) -> np.ndarray:
    rgb = (tensor.squeeze().detach().clamp(0, 1).cpu().numpy().transpose(1, 2, 0) * 255.0).astype(np.uint8)
    return rgb[:, :, ::-1].copy()


def main() -> int:
    args = _parse_args()
    if args.multi < 2:
        raise RuntimeError("--multi must be >= 2")
    ds_factor = float(args.ds_factor)
    if not (0 < ds_factor <= 1.0):
        raise RuntimeError("--ds-factor must be in (0, 1]")

    repo = Path(args.repo).resolve()
    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(repo)
    sys.path.insert(0, str(repo / "src"))

    if not torch.cuda.is_available():
        raise RuntimeError("GIMM-VFI requires CUDA, but no GPU is visible")
    torch.cuda.set_device(max(0, args.gpu))
    device = torch.device("cuda")
    print(f"GIMM-VFI using {torch.cuda.get_device_name(device)}", flush=True)

    from omegaconf import OmegaConf
    import torch.nn.functional as F
    from models import create_model
    from models.generalizable_INR.configs import GIMMVFIConfig

    torch.manual_seed(0)
    torch.cuda.manual_seed_all(0)
    raw = OmegaConf.load(args.config)
    arch = GIMMVFIConfig.create(raw.arch)
    model, _ = create_model(arch)
    model = model.to(device)
    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    state = ckpt["state_dict"] if isinstance(ckpt, dict) and "state_dict" in ckpt else ckpt
    model.load_state_dict(state, strict=True)
    model.eval()
    print("Loaded GIMM-VFI R-P", flush=True)

    paths = _frame_paths(input_dir)
    written = 0
    total_out = (len(paths) - 1) * args.multi + 1

    def write_frame(image_bgr: np.ndarray) -> None:
        nonlocal written
        written += 1
        out_path = output_dir / f"{written:08d}.png"
        if not cv2.imwrite(str(out_path), image_bgr):
            raise RuntimeError(f"failed to write {out_path}")
        print(f"progress {100.0 * written / total_out:.1f}%", flush=True)

    first = _load_image(paths[0], device)
    write_frame(_to_bgr(first))

    for index, path in enumerate(paths[1:], start=1):
        I0 = first if index == 1 else I2
        I2 = _load_image(path, device)
        padder = InputPadder(I0.shape, 32)
        padded0, padded2 = padder.pad(I0, I2)
        xs = torch.cat((padded0.unsqueeze(2), padded2.unsqueeze(2)), dim=2)
        s_shape = xs.shape[-2:]
        coord_inputs = [
            (
                model.sample_coord_input(
                    xs.shape[0],
                    s_shape,
                    [i / args.multi],
                    device=xs.device,
                    upsample_ratio=ds_factor,
                ),
                None,
            )
            for i in range(1, args.multi)
        ]
        timesteps = [
            (i / args.multi) * torch.ones(xs.shape[0], device=xs.device, dtype=torch.float)
            for i in range(1, args.multi)
        ]
        with torch.no_grad():
            outputs = model(xs, coord_inputs, t=timesteps, ds_factor=ds_factor)
            mids = [padder.unpad(frame) for frame in outputs["imgt_pred"]]
        for mid in mids:
            write_frame(_to_bgr(mid))
        write_frame(_to_bgr(I2))
        first = I2
        if index % 4 == 0:
            torch.cuda.empty_cache()

    if written != total_out:
        raise RuntimeError(f"GIMM-VFI wrote {written} frames; expected {total_out}")
    print(f"GIMM-VFI wrote {written} frames", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"GIMM-VFI interpolation failed: {error}", file=sys.stderr, flush=True)
        raise
