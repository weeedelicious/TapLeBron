import argparse
import base64
import io
import json
import os
from pathlib import Path

import requests
from PIL import Image


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one authenticated MoGe-2 inference.")
    parser.add_argument("image", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8091")
    args = parser.parse_args()

    load_env(Path(__file__).with_name(".env"))
    token = os.environ.get("MOGE_API_TOKEN", "").strip()
    if not token:
        raise SystemExit("MOGE_API_TOKEN is missing")

    with args.image.open("rb") as source:
        response = requests.post(
            f"{args.url.rstrip('/')}/v1/geometry",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": (args.image.name, source, "image/png")},
            timeout=240,
        )
    response.raise_for_status()
    payload = response.json()
    if payload.get("geometryAssetVersion") != 4:
        raise SystemExit(
            f"Unexpected geometry asset version: {payload.get('geometryAssetVersion')!r}"
        )
    if payload.get("normalConvention") != "opengl-object":
        raise SystemExit(
            f"Unexpected normal convention: {payload.get('normalConvention')!r}"
        )

    assets = {}
    for name, asset in payload.get("assets", {}).items():
        raw = base64.b64decode(asset["data"])
        if name == "pointMap":
            parsed = json.loads(raw.decode("utf-8"))
            assets[name] = {
                "mimeType": asset["mimeType"],
                "bytes": len(raw),
                "sampleCount": len(parsed.get("points", [])),
            }
            continue
        with Image.open(io.BytesIO(raw)) as image:
            assets[name] = {
                "mimeType": asset["mimeType"],
                "bytes": len(raw),
                "size": list(image.size),
                "mode": image.mode,
            }

    print(
        json.dumps(
            {
                "provider": payload.get("provider"),
                "modelId": payload.get("modelId"),
                "geometryAssetVersion": payload.get("geometryAssetVersion"),
                "normalConvention": payload.get("normalConvention"),
                "sourceSize": [payload.get("sourceWidth"), payload.get("sourceHeight")],
                "inferenceSize": [payload.get("width"), payload.get("height")],
                "fovDegrees": payload.get("fov"),
                "intrinsics": payload.get("intrinsics"),
                "inferenceMs": payload.get("inferenceMs"),
                "assets": assets,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
