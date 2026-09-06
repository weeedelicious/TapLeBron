"""Mutation check for the Cindy access change (2026-08-24).

Reverts each fix to its pre-change form, runs the two new test files, and asserts
the suite actually goes red. Restores every file no matter what happens.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MUTATIONS = [
    (
        "A. isUserAllowed 退回旧的「只认名单」（空名单 = 谁都进不来）",
        "server/services/CindyAssistantService.js",
        "  return restrictTo.length === 0 || restrictTo.includes(id);",
        "  return restrictTo.includes(id);",
    ),
    (
        "B. allowedCindyModes 不再按名单挡高级模式",
        "server/services/CindyAssistantService.js",
        "  if (id !== null && advancedIds.includes(id)) return [...CINDY_MODE_ORDER];\n"
        "  return CINDY_MODE_ORDER.filter((mode) => !ADVANCED_CINDY_MODES.includes(mode));",
        "  return [...CINDY_MODE_ORDER];",
    ),
    (
        "C. resolveCindyMode 直接信客户端传来的 mode",
        "server/services/CindyAssistantService.js",
        "  return allowedCindyModes(user).includes(requested) ? requested : 'default';",
        "  return requested;",
    ),
    (
        "D. normalizeCindyMode 退回 String() 强转（['master'] 会被当成 'master'）",
        "server/services/CindyAssistantService.js",
        "  return typeof mode === 'string' && CINDY_MODES.has(mode) ? mode : 'default';",
        "  return CINDY_MODES.has(String(mode || '')) ? String(mode) : 'default';",
    ),
    (
        "E. 选择器不按可用模式过滤",
        "src/canvas/components/CindyModeSelector.tsx",
        "  const modes = MODES.filter((m) => availableModes.includes(m.value))\n"
        "  if (modes.length <= 1) return null",
        "  const modes = MODES",
    ),
    (
        "F. cindyModesFromStatus 缺字段时按最小权限兜底（老后端下会让人少东西）",
        "src/canvas/lib/cindyAssistant.ts",
        "  if (modes === undefined || modes === null) return [...CINDY_MODE_ORDER]",
        "  if (modes === undefined || modes === null) return ['default']",
    ),
    (
        "G. setCindyModes 不把越权的当前模式拽回默认",
        "src/canvas/store/canvasStore.ts",
        "      cindyMode: modes.includes(state.cindyMode) ? state.cindyMode : \"default\",",
        "      cindyMode: state.cindyMode,",
    ),
]

TESTS = ["tests/cindy-assistant-access.test.ts", "tests/cindy-mode-selector.test.tsx"]


def run_tests():
    proc = subprocess.run(
        ["npx", "vitest", "run", *TESTS],
        cwd=ROOT, capture_output=True, text=True, shell=True, timeout=600,
    )
    out = proc.stdout + proc.stderr
    failed = 0
    for line in out.splitlines():
        stripped = line.strip()
        if stripped.startswith("Tests ") and "failed" in stripped:
            # e.g. "Tests  3 failed | 29 passed (32)"
            failed = int(stripped.split("failed")[0].split()[-1])
    return failed, out


def main():
    baseline_failed, out = run_tests()
    if baseline_failed != 0:
        print("baseline is not green, aborting")
        print(out[-2000:])
        return 1
    print("baseline: green\n")

    results = []
    for name, rel_path, current, mutated in MUTATIONS:
        path = ROOT / rel_path
        original = path.read_text(encoding="utf-8")
        if current not in original:
            results.append((name, None, "锚点没找到 —— 代码和脚本不同步"))
            print(f"[SKIP] {name}\n       锚点没找到")
            continue
        path.write_text(original.replace(current, mutated, 1), encoding="utf-8")
        try:
            failed, _ = run_tests()
        finally:
            path.write_text(original, encoding="utf-8")
        verdict = "红" if failed > 0 else "!! 仍然全绿 —— 这处改动没有被测试覆盖"
        results.append((name, failed, verdict))
        print(f"[{'OK ' if failed else 'BAD'}] {name}\n       {failed} 条变红")

    print("\n=== summary ===")
    uncovered = [r for r in results if not r[1]]
    for name, failed, verdict in results:
        print(f"{failed if failed is not None else '-':>3}  {name}")
    if uncovered:
        print(f"\n{len(uncovered)} 处改动没有被测试覆盖")
        return 1
    print("\n每一处改动都有测试兜着")
    return 0


if __name__ == "__main__":
    sys.exit(main())
