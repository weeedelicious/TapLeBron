"""Mutation check for「大图右键出浏览器菜单」(2026-08-25)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIEWER = "src/canvas/components/ImagePreview.tsx"
LIB = "src/canvas/lib/canvasContextMenu.ts"
CANVAS = "src/canvas/components/Canvas.tsx"

MUTATIONS = [
    (
        "A. 查看器不接右键（回到出 bug 前：右键冒到节点上、被 openNodeMenu 吃掉）",
        VIEWER,
        "      onContextMenu={handleContextMenu}\n",
        "",
    ),
    (
        "B. 查看器顺手 preventDefault（浏览器菜单还是出不来 —— 最容易写错的一种）",
        VIEWER,
        "  const handleContextMenu = useCallback((event: React.MouseEvent) => {\n    event.stopPropagation()\n  }, [])",
        "  const handleContextMenu = useCallback((event: React.MouseEvent) => {\n    event.stopPropagation()\n    event.preventDefault()\n  }, [])",
    ),
    (
        "C. 查看器只 preventDefault 不 stopPropagation（两件事都做反）",
        VIEWER,
        "  const handleContextMenu = useCallback((event: React.MouseEvent) => {\n    event.stopPropagation()\n  }, [])",
        "  const handleContextMenu = useCallback((event: React.MouseEvent) => {\n    event.preventDefault()\n  }, [])",
    ),
    (
        "D. 画布判据反了（浮层算画布、画布不算）",
        LIB,
        "  return Boolean((target as Element).closest(CANVAS_ROOT_SELECTOR))",
        "  return !(target as Element).closest(CANVAS_ROOT_SELECTOR)",
    ),
    (
        "E. 画布判据一律放行（等于没这道防线）",
        LIB,
        "  return Boolean((target as Element).closest(CANVAS_ROOT_SELECTOR))",
        "  return true",
    ),
    (
        "F. 判据认错选择器（.react-flow__node —— 画布空白处的右键就废了）",
        LIB,
        "const CANVAS_ROOT_SELECTOR = '.react-flow'",
        "const CANVAS_ROOT_SELECTOR = '.react-flow__node'",
    ),
    (
        "G. 非元素 target 不做保护（window / 文本节点会抛）",
        LIB,
        "  if (!target || typeof (target as Element).closest !== 'function') return false",
        "",
    ),
    (
        "H. 节点右键那边不查判据（抠像/白板/灯光等浮层里的右键又被吃掉）",
        CANVAS,
        "    if (!isCanvasContextMenuTarget(event.target)) return\n    event.preventDefault()\n    event.stopPropagation()\n    const rect = canvasRef.current?.getBoundingClientRect()\n    if (!rect) return\n    const { viewport: vp } = useCanvasStore.getState()\n    const flowX = (event.clientX - rect.left - vp.x) / vp.zoom\n    const flowY = (event.clientY - rect.top - vp.y) / vp.zoom\n    setConnMenu(null)\n    setCanvasMenu(null)",
        "    event.preventDefault()\n    event.stopPropagation()\n    const rect = canvasRef.current?.getBoundingClientRect()\n    if (!rect) return\n    const { viewport: vp } = useCanvasStore.getState()\n    const flowX = (event.clientX - rect.left - vp.x) / vp.zoom\n    const flowY = (event.clientY - rect.top - vp.y) / vp.zoom\n    setConnMenu(null)\n    setCanvasMenu(null)",
    ),
]

TESTS = ["tests/viewer-native-context-menu.test.tsx"]


def run():
    proc = subprocess.run(
        ["npx", "vitest", "run", *TESTS],
        cwd=ROOT, capture_output=True, text=True, shell=True, timeout=900,
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
