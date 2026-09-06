"""Mutation check for the two prompt-area changes (2026-08-25)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOK = "src/canvas/lib/promptTokenMention.ts"
EDGES = "src/canvas/lib/referenceEdges.ts"
EDITOR = "src/canvas/components/PromptEditor.tsx"
IMG = "src/canvas/components/nodes/ImageNode.tsx"
VID = "src/canvas/components/nodes/VideoNode.tsx"

TESTS = [
    "tests/prompt-token-mention.test.ts",
    "tests/reference-edge-removal.test.ts",
    "tests/prompt-editor-token-chip.test.tsx",
]

MUTATIONS = [
    # ── 断连线 ─────────────────────────────────────────────
    (
        "A. 只断一个方向（反着连的线会留下来）",
        EDGES,
        "      !(edge.source === a && edge.target === b) &&\n      !(edge.source === b && edge.target === a),",
        "      !(edge.source === a && edge.target === b),",
    ),
    (
        "B. 空 id 时把整张图清空",
        EDGES,
        "  if (!a || !b) return edges",
        "  if (false) return edges",
    ),
    (
        "C. 图片节点又不断线了（改动前的原样）",
        IMG,
        "    setEdges(edgesWithoutLink(useCanvasStore.getState().edges, nodeId, id))",
        "",
    ),
    (
        "D. 视频节点不断线了",
        VID,
        "    setEdges(edgesWithoutLink(useCanvasStore.getState().edges, nodeId, id))",
        "",
    ),
    # ── image1 转引用 ──────────────────────────────────────
    (
        "E. 不等断词字符就转（打 image1 想打 image15 会被抢）",
        TOK,
        "  if (canExtendToken(tail)) return null",
        "",
    ),
    (
        "M. 汉字又不算断词（退回白名单那版，中文提示词一次都不转）",
        TOK,
        "  return /[0-9A-Za-z_-]/.test(char)",
        "  return !/[\\s/]/.test(char)",
    ),
    (
        "N. 失焦不再整段扫（在中间插入的 image1 永远不转）",
        EDITOR,
        "          onBlur={convertTextMentions}",
        "",
    ),
    (
        "O. 扫描不跳过 chip 内部（chip 标签里也写着「图片1」，会套娃）",
        EDITOR,
        "        if ((node.parentElement as HTMLElement | null)?.closest('[data-chip]')) continue",
        "",
    ),
    (
        "R. 扫描退回贪婪正则（两位数编号 image12 整个漏掉）",
        TOK,
        "  const re = /\d+/g",
        "  const re = /([0-9A-Za-z一-龥]+)[\s_-]{0,2}(\d{1,2})/g",
    ),
    (
        "P. 扫描结果不倒序（插入后前面几处的下标全部失效）",
        TOK,
        "    .reverse()",
        "",
    ),
    (
        "Q. 扫描不查右边界（image1a 会被当成引用）",
        TOK,
        "    if (canExtendToken(text[end])) continue // 后面粘着字母/下划线 → 不是引用（image1a）",
        "",
    ),
    (
        "F. 不查左边界（myimage1 也会被当成 image1）",
        TOK,
        "  if (!isLeftBoundary(head[start - 1])) return null",
        "",
    ),
    (
        "G. 编号对不上时退而求其次（image5 变成最后一张）",
        TOK,
        "  return candidates.find((chip) => chip.name === wanted && Boolean(chip.url)) ?? null",
        "  return candidates.find((chip) => chip.name === wanted && Boolean(chip.url)) ?? candidates[candidates.length - 1] ?? null",
    ),
    (
        "H. 不校验 chip 有地址（会插入一个坏图 chip）",
        TOK,
        "chip.name === wanted && Boolean(chip.url)",
        "chip.name === wanted",
    ),
    (
        "I. 删除长度算错，少删那个分隔符（留下残字）",
        TOK,
        "removeCount: whole.length + 1",
        "removeCount: whole.length",
    ),
    (
        "J. 分隔符不补回来（用户提示词里的 / 凭空消失）",
        EDITOR,
        "        if (opts?.appendText) {",
        "        if (false) {",
    ),
    (
        "K. 编辑器不再做 token 转换（功能整个没了）",
        EDITOR,
        "              insertChip(hit.chip, { removeBeforeCaret: hit.removeCount, appendText: hit.tail })",
        "              void hit",
    ),
    (
        "L. 忽略 removeBeforeCaret，退回找 @ 的老逻辑（原文删不掉）",
        EDITOR,
        "          const from = typeof removeCount === 'number'\n            ? Math.max(0, range.startOffset - removeCount)\n            : txt.lastIndexOf('@', range.startOffset - 1)",
        "          const from = txt.lastIndexOf('@', range.startOffset - 1)",
    ),
]


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
    if failed == 0 and "Test Files  3 passed" not in out:
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
