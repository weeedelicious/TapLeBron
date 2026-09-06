import asyncio
import base64
import io
import json
import math
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image

from moge.model.v2 import MoGeModel


MODEL_ID = "moge-2-vitb-normal"
MODEL_PATH = Path(
    os.environ.get(
        "MOGE_MODEL_PATH",
        r"C:\Shotflow\moge-worker\models\moge-2-vitb-normal\model.pt",
    )
)
API_TOKEN = os.environ.get("MOGE_API_TOKEN", "").strip()
MAX_UPLOAD_BYTES = int(os.environ.get("MOGE_MAX_UPLOAD_BYTES", str(30 * 1024 * 1024)))
MAX_SIDE = int(os.environ.get("MOGE_MAX_SIDE", "1280"))
RESOLUTION_LEVEL = int(os.environ.get("MOGE_RESOLUTION_LEVEL", "9"))
CONCURRENCY = max(1, int(os.environ.get("MOGE_CONCURRENCY", "1")))

model = None
model_loaded_at = None
model_lock = asyncio.Semaphore(CONCURRENCY)


def encode_image(image: Image.Image, image_format: str, **save_options) -> str:
    output = io.BytesIO()
    image.save(output, format=image_format, **save_options)
    return base64.b64encode(output.getvalue()).decode("ascii")


def resize_for_inference(image: Image.Image) -> Image.Image:
    width, height = image.size
    scale = min(1.0, MAX_SIDE / max(width, height))
    if scale >= 1:
        return image
    target = (
        max(2, round(width * scale)),
        max(2, round(height * scale)),
    )
    return image.resize(target, Image.Resampling.LANCZOS)


def normalize_depth(depth: np.ndarray, mask: np.ndarray) -> np.ndarray:
    valid = mask & np.isfinite(depth) & (depth > 0)
    if not np.any(valid):
        return np.zeros(depth.shape, dtype=np.uint16)
    near, far = np.percentile(depth[valid], [1.0, 99.0])
    if not np.isfinite(near) or not np.isfinite(far) or far <= near:
        near = float(np.min(depth[valid]))
        far = float(np.max(depth[valid]))
    span = max(1e-6, far - near)
    # Near surfaces are brighter so the map can be used directly as relief.
    normalized = 1.0 - np.clip((depth - near) / span, 0.0, 1.0)
    normalized[~valid] = 0.0
    return np.round(normalized * 65535.0).astype(np.uint16)


def build_diffuse_approximation(rgb: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    luminance = lab[:, :, 0].astype(np.float32)
    sigma = max(7.0, min(rgb.shape[:2]) / 18.0)
    illumination = cv2.GaussianBlur(luminance, (0, 0), sigmaX=sigma, sigmaY=sigma)
    target = float(np.median(illumination))
    corrected = np.clip(luminance - (illumination - target) * 0.58, 0, 255)
    lab[:, :, 0] = corrected.astype(np.uint8)
    diffuse = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    return cv2.bilateralFilter(diffuse, 5, 18, 18)


def sample_point_map(points: np.ndarray, mask: np.ndarray) -> dict:
    height, width = mask.shape
    step = max(8, round(max(width, height) / 80))
    samples = []
    for y in range(0, height, step):
        for x in range(0, width, step):
            if not mask[y, x]:
                continue
            point = points[y, x]
            if not np.all(np.isfinite(point)):
                continue
            samples.append(
                [
                    round(float(point[0]), 6),
                    round(float(-point[1]), 6),
                    round(float(-point[2]), 6),
                ]
            )
    return {
        "version": 2,
        "coordinateSystem": "OpenGL",
        "width": width,
        "height": height,
        "sampleStep": step,
        "points": samples,
    }


def infer_geometry(image_bytes: bytes) -> dict:
    started_at = time.time()
    with Image.open(io.BytesIO(image_bytes)) as source:
        source = source.convert("RGB")
        source_width, source_height = source.size
        image = resize_for_inference(source)

    rgb = np.asarray(image, dtype=np.uint8)
    tensor = (
        torch.from_numpy(rgb.copy())
        .to(device="cuda", dtype=torch.float32)
        .permute(2, 0, 1)
        / 255.0
    )

    with torch.inference_mode():
        output = model.infer(
            tensor,
            resolution_level=RESOLUTION_LEVEL,
            use_fp16=True,
            apply_mask=True,
        )

    points = output["points"].detach().float().cpu().numpy()
    depth = output["depth"].detach().float().cpu().numpy()
    mask = output["mask"].detach().bool().cpu().numpy()
    normal = output["normal"].detach().float().cpu().numpy()
    intrinsics = output["intrinsics"].detach().float().cpu().numpy()

    depth_u16 = normalize_depth(depth, mask)
    # MoGe returns camera-space normals with +Y down and +Z away from the
    # camera. The Light Stage plane uses Three.js/OpenGL object space, where
    # +Y is up and its visible front faces +Z. Store the converted normal map
    # so the same asset works in deterministic local rendering and Three.js.
    normal_gl = normal.copy()
    normal_gl[..., 1] *= -1.0
    normal_gl[..., 2] *= -1.0
    normal_rgb = np.clip((normal_gl * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    normal_rgb[~mask] = np.array([127, 127, 255], dtype=np.uint8)
    mask_u8 = mask.astype(np.uint8) * 255
    diffuse = build_diffuse_approximation(rgb)

    fx = float(intrinsics[0, 0])
    fov_x = math.degrees(2.0 * math.atan(0.5 / max(1e-6, fx)))
    point_map = sample_point_map(points, mask)
    width, height = image.size

    depth_image = Image.fromarray(depth_u16, mode="I;16")
    response = {
        "version": 3,
        "provider": MODEL_ID,
        "modelId": MODEL_ID,
        "modelPath": MODEL_PATH.name,
        "geometryAssetVersion": 4,
        "normalConvention": "opengl-object",
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "width": width,
        "height": height,
        "fov": round(fov_x, 5),
        "intrinsics": [round(float(value), 8) for value in intrinsics.reshape(-1)],
        "generatedAtMs": int(time.time() * 1000),
        "inferenceMs": round((time.time() - started_at) * 1000),
        "assets": {
            "diffuse": {
                "mimeType": "image/png",
                "data": encode_image(Image.fromarray(diffuse, mode="RGB"), "PNG", compress_level=8),
            },
            "normal": {
                "mimeType": "image/png",
                "data": encode_image(Image.fromarray(normal_rgb, mode="RGB"), "PNG", compress_level=8),
            },
            "depth": {
                "mimeType": "image/png",
                "bitDepth": 16,
                "data": encode_image(depth_image, "PNG", compress_level=9),
            },
            "mask": {
                "mimeType": "image/png",
                "data": encode_image(Image.fromarray(mask_u8, mode="L"), "PNG", compress_level=9),
            },
            "preview": {
                "mimeType": "image/webp",
                "data": encode_image(image, "WEBP", quality=90, method=4),
            },
            "pointMap": {
                "mimeType": "application/json",
                "data": base64.b64encode(
                    json.dumps(point_map, separators=(",", ":")).encode("utf-8")
                ).decode("ascii"),
            },
        },
    }
    del tensor, output
    torch.cuda.empty_cache()
    return response


def require_token(authorization: str | None) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="MOGE_API_TOKEN is not configured")
    if authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid service token")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global model, model_loaded_at
    if not MODEL_PATH.exists():
        raise RuntimeError(f"MoGe-2 checkpoint not found: {MODEL_PATH}")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available")
    model = MoGeModel.from_pretrained(MODEL_PATH).to("cuda").eval()
    model_loaded_at = int(time.time() * 1000)
    yield
    model = None
    torch.cuda.empty_cache()


app = FastAPI(
    title="Shotflow MoGe-2 Geometry Worker",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health(authorization: str | None = Header(default=None)):
    require_token(authorization)
    return {
        "ok": model is not None,
        "modelId": MODEL_ID,
        "loadedAtMs": model_loaded_at,
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "cuda": torch.version.cuda,
        "maxSide": MAX_SIDE,
        "resolutionLevel": RESOLUTION_LEVEL,
        "concurrency": CONCURRENCY,
    }


@app.post("/v1/geometry")
async def geometry(
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
):
    require_token(authorization)
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Only image inputs are supported")
    image_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds worker upload limit")
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image is empty")
    try:
        async with model_lock:
            return await asyncio.to_thread(infer_geometry, image_bytes)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"MoGe-2 inference failed: {exc}") from exc
