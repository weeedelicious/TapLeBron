import base64
import io
import logging
import os
import time
from typing import Any

import numpy as np
import torch
from fastapi import BackgroundTasks, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image
from torchvision import transforms
from transformers import AutoModelForImageSegmentation, SegformerForSemanticSegmentation, SegformerImageProcessor

from cuda_recovery import CudaHealthState, is_fatal_cuda_error, terminate_process_after_response


MODEL_ID = os.getenv("SUBJECT_MATTING_MODEL_ID", "ZhengPeng7/BiRefNet")
MODEL_REVISION = os.getenv("SUBJECT_MATTING_MODEL_REVISION", "e2bf8e4")
API_TOKEN = os.getenv("SUBJECT_MATTING_API_TOKEN", "")
DEVICE = os.getenv("SUBJECT_MATTING_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
INPUT_SIZE = int(os.getenv("SUBJECT_MATTING_INPUT_SIZE", "1024"))
MASK_LOW_CUT = float(os.getenv("SUBJECT_MATTING_MASK_LOW_CUT", "0.08"))
MASK_HIGH_CUT = float(os.getenv("SUBJECT_MATTING_MASK_HIGH_CUT", "0.92"))
SAM_MODEL_CFG = os.getenv("SUBJECT_MATTING_SAM_MODEL_CFG", "configs/sam2.1/sam2.1_hiera_l.yaml")
SAM_CHECKPOINT = os.getenv("SUBJECT_MATTING_SAM_CHECKPOINT", "models/sam2.1_hiera_large.pt")

# 纹理清晰化（精准修复）的人体部位语义分区。
#
# 设计文档点名 SegFormer-B4，但 HuggingFace 上没有 B4 的人体解析权重（B4 的 checkpoint
# 全是 ADE20K / Cityscapes / 裂缝 / 卫星）。真实可用的是 b2 / b3 / b5 三个 clothes-parsing
# 权重，它们的 id2label 逐项相同（ATR 18 类），所以换权重只改这个环境变量、不用改代码。
# 默认 b3：MiT-B3（depths [3,4,18,3]）是带 ATR 标签里容量最大且被广泛验证的一档。
#
# 这个端点**只吐模型原始的 ATR 类别 ID 图**，不做内部语义映射、不上色。映射与配色由 Node
# 侧按 src/shared/texture-clarity-semantics.json 处理 —— 字典只留一份真源，也满足设计文档
# 「模型原始标签不能直接泄漏到业务层」：业务层拿到的是内部 id，ATR 只活在这里和那张映射表里。
SEMANTIC_PARTS_MODEL_ID = os.getenv("SEMANTIC_PARTS_MODEL_ID", "sayeed99/segformer_b3_clothes")
SEMANTIC_PARTS_MODEL_REVISION = os.getenv("SEMANTIC_PARTS_MODEL_REVISION", "main")
# 长边缩到这个尺寸再推理，保持比例。ATR 权重多在 512 上训练，这里给到 768 换一点发丝细节；
# 不用 processor 默认的 512x512 方形缩放 —— 那会把画面拉变形，人像比例一歪，发际线和肩线都偏。
SEMANTIC_PARTS_INPUT_SIZE = int(os.getenv("SEMANTIC_PARTS_INPUT_SIZE", "768"))

app = FastAPI(title="Shotflow Subject Matting Worker", version="1.1.0")
logger = logging.getLogger("shotflow.subject-matting")
model = None
sam_predictor = None
semantic_parts_model = None
semantic_parts_processor = None
cuda_health_state = CudaHealthState()
preprocess = transforms.Compose(
    [
        transforms.Resize((INPUT_SIZE, INPUT_SIZE)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ]
)


def require_auth(authorization: str | None) -> None:
    if not API_TOKEN:
        return
    expected = f"Bearer {API_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Invalid subject matting token")


def fatal_cuda_response(exc: BaseException, background_tasks: BackgroundTasks) -> JSONResponse | None:
    if not is_fatal_cuda_error(exc):
        return None
    cuda_health_state.mark_fatal(exc)
    logger.exception("Fatal CUDA context failure; worker will restart after this response")
    background_tasks.add_task(terminate_process_after_response)
    return JSONResponse(
        status_code=503,
        content={
            "code": "CUDA_WORKER_RESTARTING",
            "detail": "GPU worker became unhealthy and is restarting; retry shortly",
        },
    )


def load_model() -> Any:
    global model
    if model is not None:
        return model
    torch.set_float32_matmul_precision("high")
    loaded = AutoModelForImageSegmentation.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        trust_remote_code=True,
    )
    loaded.to(DEVICE)
    loaded.eval()
    model = loaded
    return model


def load_sam_predictor() -> Any:
    global sam_predictor
    if sam_predictor is not None:
        return sam_predictor
    try:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
    except Exception as exc:  # pragma: no cover - import failure should surface in API response
        raise RuntimeError(f"SAM 2.1 dependency is unavailable: {exc}") from exc
    if not os.path.exists(SAM_CHECKPOINT):
        raise RuntimeError(f"SAM 2.1 checkpoint not found: {SAM_CHECKPOINT}")
    sam_model = build_sam2(SAM_MODEL_CFG, SAM_CHECKPOINT, device=DEVICE)
    sam_model.eval()
    sam_predictor = SAM2ImagePredictor(sam_model)
    return sam_predictor


def load_semantic_parts_model() -> Any:
    global semantic_parts_model, semantic_parts_processor
    if semantic_parts_model is not None:
        return semantic_parts_model, semantic_parts_processor
    processor = SegformerImageProcessor.from_pretrained(
        SEMANTIC_PARTS_MODEL_ID,
        revision=SEMANTIC_PARTS_MODEL_REVISION,
    )
    loaded = SegformerForSemanticSegmentation.from_pretrained(
        SEMANTIC_PARTS_MODEL_ID,
        revision=SEMANTIC_PARTS_MODEL_REVISION,
    )
    loaded.to(DEVICE)
    loaded.eval()
    semantic_parts_model = loaded
    semantic_parts_processor = processor
    return semantic_parts_model, semantic_parts_processor


def semantic_parts_input_size(width: int, height: int) -> tuple[int, int]:
    """长边缩到 SEMANTIC_PARTS_INPUT_SIZE 并对齐到 32 的倍数，保持比例。

    对齐 32 是因为 SegFormer 下采样 4 级；不对齐时最后一级特征图尺寸会被截断，
    upsample 回原尺寸会带来半像素级的整体偏移，反映在发际线和衣领上是一条毛边。
    """
    longest = max(1, max(width, height))
    scale = float(SEMANTIC_PARTS_INPUT_SIZE) / float(longest)
    target_w = max(32, int(round(width * scale / 32.0)) * 32)
    target_h = max(32, int(round(height * scale / 32.0)) * 32)
    return target_w, target_h


def output_to_tensor(output: Any) -> torch.Tensor:
    if isinstance(output, dict):
        for key in ("pred", "preds", "logits", "out"):
            value = output.get(key)
            if value is not None:
                output = value
                break
    if isinstance(output, (tuple, list)):
        output = output[-1]
    if not isinstance(output, torch.Tensor):
        raise RuntimeError("BiRefNet returned an unsupported output format")
    return output


def image_to_base64_png(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def build_preview(source: Image.Image, mask: Image.Image) -> Image.Image:
    rgba = source.convert("RGBA")
    rgba.putalpha(mask)
    return rgba


def image_to_mask_buffer(mask: Image.Image) -> bytes:
    buffer = io.BytesIO()
    mask.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def postprocess_probability_mask(mask_tensor: torch.Tensor) -> np.ndarray:
    probabilities = mask_tensor.numpy().astype(np.float32)
    low = max(0.0, min(0.98, MASK_LOW_CUT))
    high = max(low + 0.01, min(1.0, MASK_HIGH_CUT))
    probabilities = np.clip((probabilities - low) / (high - low), 0.0, 1.0)
    probabilities = probabilities * probabilities * (3.0 - 2.0 * probabilities)
    return np.clip(probabilities * 255.0, 0, 255).astype(np.uint8)


def predict_sam_mask(source: Image.Image, intent: str, prompt_type: str, point: dict[str, float] | None, box: dict[str, float] | None) -> Image.Image:
    predictor = load_sam_predictor()
    image = source.convert("RGB")
    image_np = np.asarray(image)
    predictor.set_image(image_np)

    if prompt_type == "point":
      if not point:
        raise HTTPException(status_code=400, detail="Point prompt is required")
      width, height = image.size
      x = max(0.0, min(float(point["x"]) * width, width - 1.0))
      y = max(0.0, min(float(point["y"]) * height, height - 1.0))
      coords = np.array([[x, y]], dtype=np.float32)
      labels = np.array([1 if intent == "keep" else 0], dtype=np.int32)
      masks, scores, _ = predictor.predict(
          point_coords=coords,
          point_labels=labels,
          multimask_output=False,
      )
    elif prompt_type == "box":
      if not box:
        raise HTTPException(status_code=400, detail="Box prompt is required")
      width, height = image.size
      x0 = max(0.0, min(float(box["x"]) * width, width))
      y0 = max(0.0, min(float(box["y"]) * height, height))
      x1 = max(x0 + 1.0, min((float(box["x"]) + float(box["width"])) * width, width))
      y1 = max(y0 + 1.0, min((float(box["y"]) + float(box["height"])) * height, height))
      masks, scores, _ = predictor.predict(
          box=np.array([x0, y0, x1, y1], dtype=np.float32),
          multimask_output=False,
      )
    else:
      raise HTTPException(status_code=400, detail="Unsupported SAM prompt type")

    if masks is None or len(masks) == 0:
      raise RuntimeError("SAM returned no masks")
    mask_array = np.asarray(masks[0]).astype(np.uint8) * 255
    if mask_array.ndim != 2:
      raise RuntimeError("SAM returned an invalid mask shape")
    return Image.fromarray(mask_array, mode="L").resize(image.size, Image.Resampling.BICUBIC)


@app.get("/health")
def health(background_tasks: BackgroundTasks) -> JSONResponse:
    cuda_healthy, cuda_error = cuda_health_state.probe(torch, DEVICE)
    if not cuda_healthy:
        logger.error("CUDA health probe failed: %s", cuda_error)
        background_tasks.add_task(terminate_process_after_response)
    return JSONResponse(status_code=200 if cuda_healthy else 503, content={
        "ok": cuda_healthy,
        "modelId": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "device": DEVICE,
        "cudaAvailable": torch.cuda.is_available(),
        "cudaHealthy": cuda_healthy,
        "cudaError": None if cuda_healthy else "CUDA probe failed; worker is restarting",
        "modelLoaded": model is not None,
        "samLoaded": sam_predictor is not None,
        "semanticPartsModelId": SEMANTIC_PARTS_MODEL_ID,
        "semanticPartsModelRevision": SEMANTIC_PARTS_MODEL_REVISION,
        "semanticPartsLoaded": semantic_parts_model is not None,
        "semanticPartsLabelSet": "ATR-18",
    })


@app.post("/v1/preload")
def preload(background_tasks: BackgroundTasks, authorization: str | None = Header(default=None)) -> Any:
    require_auth(authorization)
    started = time.time()
    try:
        load_model()
    except Exception as exc:
        response = fatal_cuda_response(exc, background_tasks)
        if response is not None:
            return response
        raise
    return {
        "ok": True,
        "modelId": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "device": DEVICE,
        "loadSec": round(time.time() - started, 3),
    }


@app.post("/v1/subject-mask")
async def subject_mask(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    require_auth(authorization)
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty image")

    started = time.time()
    try:
      source = Image.open(io.BytesIO(payload)).convert("RGB")
    except Exception as exc:
      raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    width, height = source.size
    try:
        tensor = preprocess(source).unsqueeze(0).to(DEVICE)
        with torch.inference_mode():
            output = output_to_tensor(load_model()(tensor))
            mask_tensor = output.sigmoid().detach().float().cpu()[0].squeeze()
    except Exception as exc:
        response = fatal_cuda_response(exc, background_tasks)
        if response is not None:
            return response
        raise
    mask_array = postprocess_probability_mask(mask_tensor)
    mask = Image.fromarray(mask_array, mode="L").resize((width, height), Image.Resampling.BICUBIC)
    preview = build_preview(source, mask)
    coverage = float((np.array(mask) > 16).sum()) / float(max(1, width * height))

    return JSONResponse(
        {
            "modelId": MODEL_ID,
            "modelRevision": MODEL_REVISION,
            "width": width,
            "height": height,
            "maskCoverage": coverage,
            "elapsedSec": round(time.time() - started, 3),
            "assets": {
                "mask": {
                    "mimeType": "image/png",
                    "data": image_to_base64_png(mask),
                },
                "preview": {
                    "mimeType": "image/png",
                    "data": image_to_base64_png(preview),
                },
            },
        }
    )


@app.post("/v1/subject-correction")
async def subject_correction(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    intent: str = Form(...),
    promptType: str = Form(...),
    taskVersion: int = Form(0),
    pointX: float | None = Form(default=None),
    pointY: float | None = Form(default=None),
    boxX: float | None = Form(default=None),
    boxY: float | None = Form(default=None),
    boxWidth: float | None = Form(default=None),
    boxHeight: float | None = Form(default=None),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    require_auth(authorization)
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty image")

    started = time.time()
    try:
        source = Image.open(io.BytesIO(payload)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    prompt_type = str(promptType).strip().lower()
    if prompt_type not in {"point", "box"}:
        raise HTTPException(status_code=400, detail="Invalid SAM correction prompt type")

    try:
        if prompt_type == "point":
            if pointX is None or pointY is None:
                raise HTTPException(status_code=400, detail="Point prompt is required")
            mask = predict_sam_mask(source, str(intent).strip().lower(), prompt_type, {"x": pointX, "y": pointY}, None)
        else:
            if boxX is None or boxY is None or boxWidth is None or boxHeight is None:
                raise HTTPException(status_code=400, detail="Box prompt is required")
            mask = predict_sam_mask(
                source,
                str(intent).strip().lower(),
                prompt_type,
                None,
                {"x": boxX, "y": boxY, "width": boxWidth, "height": boxHeight},
            )
    except HTTPException:
        raise
    except Exception as exc:
        response = fatal_cuda_response(exc, background_tasks)
        if response is not None:
            return response
        raise

    coverage = float((np.array(mask) > 16).sum()) / float(max(1, source.size[0] * source.size[1]))

    return JSONResponse(
        {
            "modelId": "facebook/sam2.1-hiera-large",
            "modelRevision": "2.1",
            "width": source.size[0],
            "height": source.size[1],
            "maskCoverage": coverage,
            "taskVersion": int(taskVersion or 0),
            "elapsedSec": round(time.time() - started, 3),
            "assets": {
                "mask": {
                    "mimeType": "image/png",
                    "data": image_to_base64_png(mask),
                },
            },
        }
    )


@app.post("/v1/semantic-parts/preload")
def preload_semantic_parts(background_tasks: BackgroundTasks, authorization: str | None = Header(default=None)) -> Any:
    require_auth(authorization)
    started = time.time()
    try:
        load_semantic_parts_model()
    except Exception as exc:
        response = fatal_cuda_response(exc, background_tasks)
        if response is not None:
            return response
        raise
    return {
        "ok": True,
        "modelId": SEMANTIC_PARTS_MODEL_ID,
        "modelRevision": SEMANTIC_PARTS_MODEL_REVISION,
        "device": DEVICE,
        "loadSec": round(time.time() - started, 3),
    }


@app.post("/v1/semantic-parts")
async def semantic_parts(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """人体部位语义分区。返回全画面的**原始 ATR 类别 ID 图**，不是 Alpha、不上色。

    classMap 是单通道 PNG，像素值就是 ATR 类别 id（0..17）。PNG 无损，取回去按原值读即可。
    看起来是一张几乎全黑的图 —— 它是数据不是给人看的，配色由 Node 按内部语义字典生成。
    """
    require_auth(authorization)
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty image")

    started = time.time()
    try:
        source = Image.open(io.BytesIO(payload)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    width, height = source.size
    target_w, target_h = semantic_parts_input_size(width, height)
    resized = source.resize((target_w, target_h), Image.Resampling.BICUBIC)

    parts_model, processor = load_semantic_parts_model()
    # do_resize=False：缩放已经在上面按比例做完了，再让 processor 拉成方形会把人像比例弄歪。
    inputs = processor(images=resized, do_resize=False, return_tensors="pt")
    pixel_values = inputs["pixel_values"].to(DEVICE)

    with torch.inference_mode():
        logits = parts_model(pixel_values=pixel_values).logits
        # 先把 logits 插值回原始尺寸再 argmax，而不是先 argmax 再放大类别图：
        # 后者会在边界上产生锯齿块，羽化之后仍然看得出台阶。
        logits = torch.nn.functional.interpolate(
            logits.float(),
            size=(height, width),
            mode="bilinear",
            align_corners=False,
        )
        class_map = logits.argmax(dim=1)[0].to(torch.uint8).cpu().numpy()

    label_count = int(getattr(parts_model.config, "num_labels", 0) or 0)
    counts: dict[str, int] = {}
    unique, unique_counts = np.unique(class_map, return_counts=True)
    for class_id, count in zip(unique.tolist(), unique_counts.tolist()):
        counts[str(int(class_id))] = int(count)

    class_image = Image.fromarray(class_map, mode="L")

    return JSONResponse(
        {
            "modelId": SEMANTIC_PARTS_MODEL_ID,
            "modelRevision": SEMANTIC_PARTS_MODEL_REVISION,
            "labelSet": "ATR-18",
            "labelCount": label_count,
            "width": width,
            "height": height,
            "inferenceWidth": target_w,
            "inferenceHeight": target_h,
            "classPixelCounts": counts,
            "elapsedSec": round(time.time() - started, 3),
            "assets": {
                "classMap": {
                    "mimeType": "image/png",
                    "data": image_to_base64_png(class_image),
                },
            },
        }
    )
