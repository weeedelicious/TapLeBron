#!/usr/bin/env python3
"""Shotflow 前端发布对账。

为什么需要它：生产曾长期靠"在上一个编译产物上手工打补丁"发布，新 bundle 从旧 bundle
派生。一旦某次取错基线，之前的修复会被静默丢掉——2026-08-12 的图片节点伪黑边修复就是
这样丢的，直到用户第二次报同一个 bug 才发现。

这个脚本把"发布后功能不许变少"变成机械检查：

  baseline          读线上当前产物，把每个功能标记的实际出现次数记成基线
  check             拿候选产物和基线比，任何标记变少就拒绝
  verify-deployed   构建一次，和线上产物比内容哈希，证明"线上 == 当前源码"

标记用的是**用户可见文案和 CSS 类名**，不是变量名——压缩会重命名变量，但不会改这些。
基线是"量出来的"而不是"断言出来的"：候选标记里线上本来就没有的（count=0），不参与判定。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HOST = "xindong-server"
REMOTE_ROOT = "/data/wyx_root/tapflow-workbench"
LOCAL_ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = LOCAL_ROOT / "tools" / "release-baseline.json"
RELEASE_INDEX = "public/releases/matting-rectangle-live-preview-20260811/index.html"

SSH = shutil.which("ssh")

# 每条 = (功能, 在产物里能稳定找到的标记)
JS_MARKERS = [
    ("永久历史台账", "/history-assets"),
    ("图片全屏查看器", "shotflow-image-viewer"),
    ("项目下拉自绘列表", "shotflow-assigned-project-picker"),
    ("画布缩放控件", "canvas-detail-zoom"),
    ("日志一次性弹窗", "shotflow.activity-log.seen.v1"),
    ("图片节点伪黑边修复", "shotflow-image-node-main-media"),
    ("局部重绘硬遮罩", "shotflow-repaint-mask-hard"),
    ("局部重绘契约", "hard-mask-v0.0.1"),
    ("局部重绘入口", "局部重绘"),
    ("快速抠图", "subject-matting"),
    ("灯光重塑", "light-stage"),
    ("全景/HDR", "panorama"),
    ("视频合成节点", "video_merge"),
    ("氛围迁移", "appearanceTransfer"),
    ("画布节点批量保存", "/nodes/batch"),
    # 保存协议本身也要对账：2026-08-14 那次发布把自动保存从整表 batch 换成了逐节点
    # upsert/delete-v2，因为两个端点字符串在新旧产物里都存在，对账没报警。
    ("节点级保存协议", "/nodes/upsert"),
    ("节点级删除协议", "/nodes/delete-v2"),
    ("节点删除意图声明", "user_delete"),
    ("节点事件增量同步", "/node-events"),
    ("生成任务恢复", "/tasks/recoverable"),
    ("插件令牌", "/plugin-tokens"),
    ("资产库", "/favorites"),
    ("共享空间", "/shared-assets"),
]

CSS_MARKERS = [
    # 注意：CSS 压缩会去掉属性选择器的引号，标记必须写成压缩后的形态
    ("画布三主题", "shotflow-theme=warm"),
    ("节点选中呼吸", "shotflow-node-selected-breathe"),
    ("历史面板", "canvas-history-panel"),
    ("图片查看器放大镜", "shotflow-image-viewer-loupe"),
    ("小地图左对齐", "react-flow__minimap"),
]

# 入口 HTML 必须保留的东西（独占会话脚本一旦掉了，多页面互相覆盖就会回来）
INDEX_REQUIRED = ["canvas-exclusive-session"]


class Fail(Exception):
    pass


def remote(command: str, timeout: int = 300) -> bytes:
    if not SSH:
        raise Fail("本机找不到 ssh 客户端")
    result = subprocess.run(
        [SSH, "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST, command],
        capture_output=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise Fail(f"远端命令失败: {result.stderr.decode('utf-8', 'replace')[:300]}")
    return result.stdout


def parse_entry(html: str, source: str) -> tuple[str, str, str]:
    """解析发布入口引用的 JS / CSS / 独占会话脚本文件名。"""
    js = re.search(r'src="/assets/([^"?]+\.js)', html)
    css = re.search(r'href="/assets/([^"?]+\.css)', html)
    # 会话脚本不在 /assets 下：它是 public/ 里的 classic script，必须在 module bundle
    # 之前同步执行才能拦住 fetch / XHR / EventSource。
    session = re.search(r'src="/(canvas-exclusive-session[^"?]*\.js)', html)
    if not js or not css:
        raise Fail(f"无法从{source}解析出 JS / CSS 文件名")
    if not session:
        raise Fail(f"{source}没有引用独占会话脚本")
    for required in INDEX_REQUIRED:
        if required not in html:
            raise Fail(f"{source}缺少必需脚本: {required}")
    return js.group(1), css.group(1), session.group(1)


def deployed_entry() -> tuple[str, str, str]:
    """从线上发布入口里解析当前实际加载的 JS / CSS / 会话脚本文件名。"""
    html = remote(f"cat {REMOTE_ROOT}/{RELEASE_INDEX}").decode("utf-8", "replace")
    return parse_entry(html, "线上发布入口")


def local_entry() -> tuple[str, str, str]:
    path = LOCAL_ROOT / RELEASE_INDEX
    if not path.is_file():
        raise Fail(f"本地找不到发布入口 {RELEASE_INDEX}")
    return parse_entry(path.read_text(encoding="utf-8"), "本地发布入口")


def count_markers(text: str, markers: list[tuple[str, str]]) -> dict[str, int]:
    return {needle: text.count(needle) for _, needle in markers}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cmd_baseline() -> int:
    js_name, css_name, session_name = deployed_entry()
    js = remote(f"cat {REMOTE_ROOT}/dist/assets/{js_name}")
    css = remote(f"cat {REMOTE_ROOT}/dist/assets/{css_name}")
    session = remote(f"cat {REMOTE_ROOT}/public/{session_name}")
    baseline = {
        "deployedJs": js_name,
        "deployedCss": css_name,
        "deployedSessionScript": session_name,
        "sessionSha256": sha256(session),
        "sessionBytes": len(session),
        "jsSha256": sha256(js),
        "cssSha256": sha256(css),
        "jsBytes": len(js),
        "cssBytes": len(css),
        "jsMarkers": count_markers(js.decode("utf-8", "replace"), JS_MARKERS),
        "cssMarkers": count_markers(css.decode("utf-8", "replace"), CSS_MARKERS),
    }
    BASELINE_PATH.write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"线上 JS   {js_name}  {len(js)}B  {baseline['jsSha256'][:16]}")
    print(f"线上 CSS  {css_name}  {len(css)}B  {baseline['cssSha256'][:16]}")
    print(f"线上 会话  {session_name}  {len(session)}B  {baseline['sessionSha256'][:16]}")
    print("\n功能标记基线（count=0 表示线上当前没有这个功能，不参与后续判定）:")
    for label, needle in JS_MARKERS:
        count = baseline["jsMarkers"][needle]
        note = "   ← 线上缺失" if count == 0 else ""
        print(f"  JS   {label:<22} {count:>4}{note}")
    for label, needle in CSS_MARKERS:
        count = baseline["cssMarkers"][needle]
        note = "   ← 线上缺失" if count == 0 else ""
        print(f"  CSS  {label:<22} {count:>4}{note}")
    print(f"\n基线已写入 {BASELINE_PATH.relative_to(LOCAL_ROOT)}")
    return 0


def load_baseline() -> dict:
    if not BASELINE_PATH.is_file():
        raise Fail("还没有基线，先跑一次 `python tools/release_check.py baseline`")
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def cmd_check(js_path: Path, css_path: Path) -> int:
    baseline = load_baseline()
    # 发布入口引用的会话脚本必须真的存在：一旦 index.html 改了文件名而文件没跟上，
    # 页面会静默失去整个独占会话保护（脚本 404，令牌不再注入）。
    _, _, session_name = local_entry()
    if not (LOCAL_ROOT / "public" / session_name).is_file():
        raise Fail(f"发布入口引用了不存在的会话脚本: public/{session_name}")
    js = js_path.read_bytes().decode("utf-8", "replace")
    css = css_path.read_bytes().decode("utf-8", "replace")

    regressions: list[str] = []
    gains: list[str] = []
    for label, needle in JS_MARKERS:
        was = baseline["jsMarkers"].get(needle, 0)
        now = js.count(needle)
        if was > 0 and now == 0:
            regressions.append(f"JS   {label}（线上有 {was}，候选 0）")
        elif was == 0 and now > 0:
            gains.append(f"JS   {label}（线上没有，候选 {now}）")
    for label, needle in CSS_MARKERS:
        was = baseline["cssMarkers"].get(needle, 0)
        now = css.count(needle)
        if was > 0 and now == 0:
            regressions.append(f"CSS  {label}（线上有 {was}，候选 0）")
        elif was == 0 and now > 0:
            gains.append(f"CSS  {label}（线上没有，候选 {now}）")

    print(f"候选 JS   {js_path.name}  {len(js_path.read_bytes())}B")
    print(f"候选 CSS  {css_path.name}  {len(css_path.read_bytes())}B")
    if gains:
        print("\n新增/恢复的功能:")
        for item in gains:
            print(f"  + {item}")
    if regressions:
        print("\n功能回退（拒绝发布）:")
        for item in regressions:
            print(f"  - {item}")
        return 1
    print("\n对账通过：没有任何功能标记变少")
    return 0


def build() -> tuple[Path, Path]:
    # 构建到独立目录：vite 每次构建会清空输出目录，直接写 dist/ 会把本次发布用的
    # 不可变副本一起删掉。
    out = LOCAL_ROOT / "tmp-release-build"
    result = subprocess.run(
        ["npx", "vite", "build", "--outDir", out.name, "--emptyOutDir"],
        cwd=LOCAL_ROOT,
        capture_output=True,
        shell=(sys.platform == "win32"),
        timeout=1800,
    )
    if result.returncode != 0:
        raise Fail("构建失败:\n" + result.stderr.decode("utf-8", "replace")[-1500:])
    assets = out / "assets"
    js = sorted(assets.glob("index-*.js"))
    css = sorted(assets.glob("index-*.css"))
    if not js or not css:
        raise Fail(f"构建产物里找不到 index-*.js / index-*.css（{assets}）")
    return js[-1], css[-1]


def cmd_build_check() -> int:
    js_path, css_path = build()
    print(f"构建完成: {js_path.name} / {css_path.name}\n")
    return cmd_check(js_path, css_path)


def verify_session_script(session_name: str) -> tuple[list[tuple[str, str, str, str, str]], list[str]]:
    """会话脚本是整页里唯一不进 bundle 的线上文件，此前完全没被对账覆盖。

    这里查三件事：内容与本地一致；dist/ 下没有影子副本（express 先挂 dist 再挂
    public，dist 里的同名文件会静默顶掉 public）；public/ 里没有内容不同的其它副本
    （曾经同时存在 3 个版本，缓存到旧 index.html 的页面会加载到旧行为）。
    """
    local_path = LOCAL_ROOT / "public" / session_name
    if not local_path.is_file():
        raise Fail(f"本地缺少发布入口引用的会话脚本: public/{session_name}")
    remote_session = remote(f"cat {REMOTE_ROOT}/public/{session_name}")
    remote_hash = sha256(remote_session)
    # 本地可能是 CRLF，上传时 push.py 会转成 LF，比哈希前要对齐。
    local_hash = sha256(local_path.read_bytes().replace(b"\r\n", b"\n"))
    rows = [("会话脚本", f"public/{session_name}", local_hash, f"public/{session_name}", remote_hash)]

    problems: list[str] = []
    shadow = remote(
        f"test -e {REMOTE_ROOT}/dist/{session_name} && echo shadow || echo clean"
    ).decode("utf-8", "replace").strip()
    if shadow == "shadow":
        problems.append(
            f"dist/{session_name} 存在影子副本，会顶掉 public/ 下的正本（express 先挂 dist）"
        )
    listing = remote(
        f"cd {REMOTE_ROOT}/public && for f in canvas-exclusive-session*.js; do "
        "printf '%s %s\\n' \"$(sha256sum \"$f\" | cut -d' ' -f1)\" \"$f\"; done"
    ).decode("utf-8", "replace")
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        digest, name = parts
        if digest != remote_hash:
            problems.append(f"public/{name} 与当前引用的会话脚本内容不同（旧版本残留）")
    return rows, problems


def cmd_verify_deployed() -> int:
    """构建一次，和线上实际加载的产物比内容哈希，证明线上就是这份源码。"""
    js_path, css_path = build()
    js_name, css_name, session_name = deployed_entry()
    remote_js = remote(f"cat {REMOTE_ROOT}/dist/assets/{js_name}")
    remote_css = remote(f"cat {REMOTE_ROOT}/dist/assets/{css_name}")
    session_rows, session_problems = verify_session_script(session_name)

    rows = [
        ("JS", js_path.name, sha256(js_path.read_bytes()), js_name, sha256(remote_js)),
        ("CSS", css_path.name, sha256(css_path.read_bytes()), css_name, sha256(remote_css)),
        *session_rows,
    ]
    ok = not session_problems
    for problem in session_problems:
        print(f"会话脚本问题: {problem}")
    for kind, local_name, local_hash, remote_name, remote_hash in rows:
        same = local_hash == remote_hash
        ok = ok and same
        print(f"{kind:<4} 本地构建 {local_name}  {local_hash[:16]}")
        print(f"{kind:<4} 线上     {remote_name}  {remote_hash[:16]}  {'一致' if same else '不一致'}")
    if ok:
        print("\n线上产物 == 当前源码的构建结果")
        return 0
    if session_problems:
        print("\n上面的会话脚本问题必须先处理：旧副本还在被公网服务，缓存到旧入口的页面会加载到旧行为")
    else:
        print("\n线上产物与当前源码构建结果不一致：线上存在游离改动，或源码有未发布的改动")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Shotflow 前端发布对账")
    parser.add_argument(
        "command",
        nargs="?",
        default="build-check",
        help="baseline | check | build-check(默认) | verify-deployed",
    )
    parser.add_argument("paths", nargs="*", help="check 时的 <js> <css> 路径")
    args = parser.parse_args()

    try:
        if args.command == "baseline":
            return cmd_baseline()
        if args.command == "check":
            if len(args.paths) != 2:
                raise Fail("用法: release_check.py check <js> <css>")
            return cmd_check(Path(args.paths[0]), Path(args.paths[1]))
        if args.command == "build-check":
            return cmd_build_check()
        if args.command == "verify-deployed":
            return cmd_verify_deployed()
        raise Fail(f"未知命令: {args.command}")
    except Fail as error:
        print(f"\n失败: {error}", file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired:
        print("\n失败: 命令超时", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
