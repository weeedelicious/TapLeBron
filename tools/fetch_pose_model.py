"""把姿势识别用的模型和 WASM 放进 dist/models/。

为什么用脚本而不是把文件塞进 git：模型 9MB、WASM 11.8MB，都是二进制，
进版本库既拖慢 clone 也没法 diff。用脚本拉是可重复的，谁都能一条命令复现。

产物（都由我们自己的域提供，用户浏览器不需要出外网）：
    dist/models/pose_landmarker_full.task          9.0MB   ← 从 Google 的模型 CDN 拉
    dist/models/hand_landmarker.task               7.5MB   ← 同上，勾「连手指一起推」才用
    dist/models/tasks-vision-wasm/*.js / *.wasm    ~34MB   ← 从本地 node_modules 复制

WASM 那三对文件浏览器只会按 SIMD 支持情况取其中一个（现代浏览器取 simd 版 11.8MB），
所以磁盘占 34MB、首次下载约 21MB（WASM 11.8 + 姿势模型 9），
勾了手指再多 7.5MB（WASM 两个模型共用，不重复下）。

⚠️ `vite build` 会清空 dist/，**每次本地构建后都要重跑这个脚本**才能在本地试这个功能。
   没放进 public/ 是因为 vite 会把 public/ 整个拷进 dist，那样每次构建都要多搬 34MB。
   生产上不受影响：那边是按文件推送（push.py），不会整目录同步，dist/models/ 一直在。

用法：
    python tools/fetch_pose_model.py            # 缺了才下
    python tools/fetch_pose_model.py --force    # 重新下
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'dist' / 'models'
WASM_OUT = OUT_DIR / 'tasks-vision-wasm'
WASM_SRC = ROOT / 'node_modules' / '@mediapipe' / 'tasks-vision' / 'wasm'

# 固定到 /1/ 这个版本目录而不是 /latest/：latest 会在某天静默换掉模型，
# 而关键点语义一变，poseFromLandmarks / handFromLandmarks 的下标映射就全错了。
MODELS = [
    (
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/'
        'pose_landmarker_full/float16/1/pose_landmarker_full.task',
        OUT_DIR / 'pose_landmarker_full.task',
        5 * 1024 * 1024,
    ),
    (
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/'
        'hand_landmarker/float16/1/hand_landmarker.task',
        OUT_DIR / 'hand_landmarker.task',
        3 * 1024 * 1024,
    ),
]


def human(size: int) -> str:
    return f'{size / 1048576:.1f}MB'


def fetch_one(url: str, out: Path, min_bytes: int, force: bool) -> bool:
    if out.exists() and not force:
        print(f'  已在：{out.relative_to(ROOT)}  {human(out.stat().st_size)}')
        return True

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + '.part')
    print(f'  下载 … {url.rsplit("/", 1)[-1]}')
    try:
        with urllib.request.urlopen(url, timeout=180) as response, tmp.open('wb') as handle:
            shutil.copyfileobj(response, handle)
    except Exception as error:  # noqa: BLE001 — 网络错误种类很多，一律如实报出来
        tmp.unlink(missing_ok=True)
        print(f'  下载失败：{error}')
        return False

    size = tmp.stat().st_size
    # 太小说明拉到的是错误页而不是模型
    if size < min_bytes:
        tmp.unlink(missing_ok=True)
        print(f'  拉下来只有 {human(size)}，太小了，八成是错误页而不是模型')
        return False

    tmp.replace(out)
    digest = hashlib.sha256(out.read_bytes()).hexdigest()[:16]
    print(f'  就位：{out.name}  {human(size)}  sha256:{digest}…')
    return True


def fetch_models(force: bool) -> bool:
    return all(fetch_one(url, out, min_bytes, force) for url, out, min_bytes in MODELS)


def copy_wasm(force: bool) -> bool:
    if not WASM_SRC.is_dir():
        print(f'  找不到 {WASM_SRC.relative_to(ROOT)} —— 先 npm i @mediapipe/tasks-vision')
        return False

    WASM_OUT.mkdir(parents=True, exist_ok=True)
    copied = 0
    skipped = 0
    total = 0
    for source in sorted(WASM_SRC.iterdir()):
        if source.suffix not in {'.js', '.wasm'}:
            continue
        target = WASM_OUT / source.name
        total += source.stat().st_size
        if target.exists() and not force and target.stat().st_size == source.stat().st_size:
            skipped += 1
            continue
        shutil.copy2(source, target)
        copied += 1

    if copied == 0 and skipped == 0:
        print('  wasm 目录里没有 .js / .wasm，@mediapipe/tasks-vision 的结构变了？')
        return False
    print(f'  WASM 就位：新复制 {copied} 个、已存在 {skipped} 个，合计 {human(total)}')
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description='拉取姿势 / 手部识别模型与 WASM')
    parser.add_argument('--force', action='store_true', help='已存在也重新拉 / 重新复制')
    args = parser.parse_args()

    print(f'输出目录：{OUT_DIR.relative_to(ROOT)}')
    ok = fetch_models(args.force) and copy_wasm(args.force)

    if not ok:
        print('\n没全部就位。功能会在点「分析参考图姿势」时报「模型没加载起来」。')
        return 1

    print('\n都就位了。记得把 dist/models/ 整个传到生产，并确认服务端给 .wasm 发的是 application/wasm。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
