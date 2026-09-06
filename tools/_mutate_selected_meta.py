"""Mutation check for the selected-only resolution line (2026-08-25)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = "src/canvas/components/nodes/NodeShell.tsx"
IMG = "src/canvas/components/nodes/ImageNode.tsx"
VID = "src/canvas/components/nodes/VideoNode.tsx"

MUTATIONS = [
    (
        "A. 不选中也渲染（用户的核心要求：不选中就不该有）",
        SHELL,
        "{showDefaultHeader && selected && selectedMeta && (",
        "{showDefaultHeader && selectedMeta && (",
    ),
    (
        # height 和 top 用的是同一组常量算出来的。写死一个不一样的高度，底边就不再落在标题行上沿
        "B. height 与 top 用的常量脱钩（底边不再贴住标题行）",
        SHELL,
        "            height: SELECTED_META_HEIGHT_PX,",
        "            height: 20,",
    ),
    (
        "B2. 文字在行内顶对齐（离标题行浮开一段，看着就不算紧贴了）",
        SHELL,
        "            alignItems: 'flex-end',",
        "            alignItems: 'flex-start',",
    ),
    (
        "C. 跟标题行之间留了缝（不再紧贴）",
        SHELL,
        "            top: -(HEADER_OFFSET_SCREEN_PX + SELECTED_META_HEIGHT_PX) / safeZoom,",
        "            top: -(HEADER_OFFSET_SCREEN_PX + SELECTED_META_HEIGHT_PX + 6) / safeZoom,",
    ),
    (
        "D. 透明度不是 50%",
        SHELL,
        "            opacity: 0.5,",
        "            opacity: 1,",
    ),
    (
        "E. 忘了 pointer-events:none（会挡住框选和拉连线）",
        SHELL,
        "            pointerEvents: 'none',",
        "",
    ),
    (
        "F. 左边缘对到图标而不是名字",
        SHELL,
        "            paddingLeft: HEADER_NAME_LEFT_PX,",
        "            paddingLeft: 0,",
    ),
    (
        "G. 缩放变换跟标题行不一致（缩放画布时脱开）",
        SHELL,
        "            transform: `scale(${inverseZoom})`,\n            transformOrigin: 'top left',\n          }}\n        >\n          {selectedMeta}",
        "            transform: `scale(${inverseZoom * 1.2})`,\n            transformOrigin: 'top left',\n          }}\n        >\n          {selectedMeta}",
    ),
    (
        "H. 图片节点又把分辨率挂回常显的 headerMeta",
        IMG,
        "      selectedMeta={resolutionMeta}",
        "      headerMeta={resolutionMeta}",
    ),
    (
        "I. 视频节点又把分辨率挂回常显的 headerMeta",
        VID,
        "selectedMeta={resolutionMeta}",
        "headerMeta={resolutionMeta}",
    ),
]

TEST = "tests/node-selected-resolution.test.tsx"


def run():
    proc = subprocess.run(
        ["npx", "vitest", "run", TEST],
        cwd=ROOT, capture_output=True, text=True, shell=True, timeout=600,
    )
    out = proc.stdout + proc.stderr
    failed = 0
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("Tests ") and "failed" in s:
            failed = int(s.split("failed")[0].split()[-1])
    if failed == 0 and "Test Files  1 passed" not in out:
        failed = -1
    return failed


def main():
    if run() != 0:
        print("baseline not green, aborting")
        return 1
    print("baseline: green\n")

    results = []
    for name, rel, current, mutated in MUTATIONS:
        path = ROOT / rel
        original = path.read_text(encoding="utf-8")
        if current not in original:
            print(f"[SKIP] {name}\n       anchor not found")
            results.append((name, None))
            continue
        path.write_text(original.replace(current, mutated, 1), encoding="utf-8")
        try:
            failed = run()
        finally:
            path.write_text(original, encoding="utf-8")
        results.append((name, failed))
        shown = "crash/red" if failed == -1 else f"{failed} 条变红"
        print(f"[{'OK ' if failed else 'BAD'}] {name}\n       {shown}")

    print("\n=== summary ===")
    uncovered = [r for r in results if not r[1]]
    if uncovered:
        print(f"{len(uncovered)} 处没被覆盖:")
        for name, _ in uncovered:
            print(f"  - {name}")
        return 1
    print("每一处都有测试兜着")
    return 0


if __name__ == "__main__":
    sys.exit(main())
