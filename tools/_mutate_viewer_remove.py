"""Mutation check for the viewer thumbnail delete button (2026-08-24).

Each mutation is a mistake a person could plausibly make here. Restores files always.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIEW = "src/canvas/components/ImagePreview.tsx"

MUTATIONS = [
    (
        "A. 删的时候用当前 index 而不是被点的那一格",
        VIEW,
        "                  onClick={() => removeItemAt(i)}>×</button>",
        "                  onClick={() => removeItemAt(index)}>×</button>",
    ),
    (
        "B. 删当前之前的那张时忘了把 index 减一（画面会跳）",
        VIEW,
        "    if (targetIndex < index) {\n      setIndex(value => Math.max(0, value - 1))\n    } else if (targetIndex === index) {",
        "    if (targetIndex === index) {",
    ),
    (
        "C. 删当前这张、且它已是最后一张时不退格（下标越界）",
        VIEW,
        "      setIndex(value => (value >= list.length - 1 ? Math.max(0, value - 1) : value))",
        "      setIndex(value => value)",
    ),
    (
        "D. 没传 onRemoveItem 也画出删除按钮（污染其它调用点）",
        VIEW,
        "              {onRemoveItem && (",
        "              {true && (",
    ),
    (
        # 把闭合的 </button> 挪到删除按钮后面 —— 等于把「×」塞回缩略图 button 里
        "E. 「×」嵌回缩略图 button 内部（非法 HTML）",
        VIEW,
        "              </button>\n              {/* 不需要 stopPropagation",
        "              {/* 不需要 stopPropagation",
    ),
    (
        "E2. 去掉 cell 外壳，删除按钮直接当轨道的子节点（定位参照丢失）",
        VIEW,
        '            <div key={`${item.url}-${i}`} className="shotflow-image-viewer-thumb-cell">',
        '            <div key={`${item.url}-${i}`}>',
    ),
    (
        "F. 删当前这张时不清缩放（下一张带着上一张的放大倍数出现）",
        VIEW,
        "      setIndex(value => (value >= list.length - 1 ? Math.max(0, value - 1) : value))\n      reset()",
        "      setIndex(value => (value >= list.length - 1 ? Math.max(0, value - 1) : value))",
    ),
    (
        "G. 删别的那张时也把缩放清掉（无端打断正在看细节的用户）",
        VIEW,
        "    if (targetIndex < index) {\n      setIndex(value => Math.max(0, value - 1))",
        "    if (targetIndex < index) {\n      setIndex(value => Math.max(0, value - 1))\n      reset()",
    ),
]

TEST = "tests/image-viewer-remove-item.test.tsx"


def run_tests():
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
    # a crash (no summary line) still counts as red
    if failed == 0 and "Test Files  1 passed" not in out:
        failed = -1
    return failed, out


def main():
    baseline, out = run_tests()
    if baseline != 0:
        print("baseline not green, aborting")
        print(out[-1500:])
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
            failed, _ = run_tests()
        finally:
            path.write_text(original, encoding="utf-8")
        results.append((name, failed))
        label = "OK " if failed != 0 else "BAD"
        shown = "crash/red" if failed == -1 else f"{failed} 条变红"
        print(f"[{label}] {name}\n       {shown}")

    print("\n=== summary ===")
    uncovered = [r for r in results if not r[1]]
    if uncovered:
        print(f"{len(uncovered)} 处没被测试覆盖:")
        for name, _ in uncovered:
            print(f"  - {name}")
        return 1
    print("每一处都有测试兜着")
    return 0


if __name__ == "__main__":
    sys.exit(main())
