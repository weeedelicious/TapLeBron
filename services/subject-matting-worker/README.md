# Shotflow Subject Matting Worker

FastAPI worker for image subject matting. Shotflow calls this service from the Node backend so PyTorch and CUDA stay outside the main web process.

Default models:

- Automatic subject mask: `ZhengPeng7/BiRefNet@e2bf8e4`
- Human part parsing (纹理清晰化用): `sayeed99/segformer_b3_clothes`

Runtime:

- Port: `8092`
- Health: `GET /health`
- Preload: `POST /v1/preload`
- Inference: `POST /v1/subject-mask`
- SAM correction: `POST /v1/subject-correction`
- Semantic parts preload: `POST /v1/semantic-parts/preload`
- Semantic parts: `POST /v1/semantic-parts`

Environment:

```env
SUBJECT_MATTING_API_TOKEN=replace-with-long-token
SUBJECT_MATTING_MODEL_ID=ZhengPeng7/BiRefNet
SUBJECT_MATTING_MODEL_REVISION=e2bf8e4
SUBJECT_MATTING_INPUT_SIZE=1024
SUBJECT_MATTING_DEVICE=cuda
SEMANTIC_PARTS_MODEL_ID=sayeed99/segformer_b3_clothes
SEMANTIC_PARTS_MODEL_REVISION=main
SEMANTIC_PARTS_INPUT_SIZE=768
HF_HOME=C:\Shotflow\subject-matting-worker\models\hf
```

## 语义分区（`/v1/semantic-parts`）

给「纹理清晰化 / 精准修复」提供全画面人体部位语义分区。**它不是 Alpha，也不是抠图**。

响应里的 `assets.classMap` 是单通道 PNG，像素值就是模型的**原始 ATR 类别 id（0..17）**。
它看起来几乎全黑 —— 那是数据不是给人看的图。映射到内部语义字典和上色都在 Node 侧做，
依据是 `src/shared/texture-clarity-semantics.json`。字典只有那一份真源，worker 不参与。

不需要新依赖：`transformers` / `torch` / `timm` / `safetensors` 本来就在
`requirements.txt` 里，`SegformerForSemanticSegmentation` 直接可用。首次调用会从
HuggingFace 下权重到 `HF_HOME`（约 190MB），之后走缓存。

### 关于权重版本

设计文档点名 SegFormer-**B4**，但 HuggingFace 上不存在 B4 的人体解析权重（B4 的
checkpoint 全是 ADE20K / Cityscapes / 裂缝 / 卫星；唯一叫 B4 的
`s3nh/SegFormer-b4-person-segmentation` 只做人/非人二分割，不是部位解析）。

真实可用的三个是 `segformer_b2_clothes` / `segformer_b3_clothes` /
`segformer-b5-finetuned-human-parsing`，它们的 `id2label` 逐项相同（ATR 18 类），
**所以换权重只改 `SEMANTIC_PARTS_MODEL_ID`，不用改代码、也不用改映射表**。
默认取 b3（MiT-B3，depths `[3,4,18,3]`）：带 ATR 标签里容量最大且被广泛验证的一档。

### 部署

worker 跑在 `172.26.166.238`（`C:\Shotflow\subject-matting-worker\`，与 moge-worker
共用 `C:\Shotflow\moge-worker\.venv`）。改完 `app.py` 需要把文件同步过去并重启该 worker；
第一次调用会触发权重下载，建议先手动打一次 `/v1/semantic-parts/preload` 把下载和显存
占用挪到请求之外。
