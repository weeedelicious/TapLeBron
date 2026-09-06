"""Mutation check for「参考图/参考视频跟着设为主图走」(2026-08-25)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = "src/canvas/lib/primaryOutput.ts"
CHIPS = "src/canvas/lib/promptChips.ts"
IMG = "src/canvas/components/nodes/ImageNode.tsx"
VID = "src/canvas/components/nodes/VideoNode.tsx"
TXT = "src/canvas/components/nodes/TextNode.tsx"

MUTATIONS = [
    (
        "A. 又变回取 url[0]（完全忽略主图 —— 用户报的原始 bug）",
        LIB,
        "  if (urls.includes(primary)) return primary\n  return urls[0] ?? ''",
        "  return urls[0] ?? ''",
    ),
    (
        "B. 主图悬空（指向已删产物）也照用，不退回第一张",
        LIB,
        "if (urls.includes(primary)) return primary",
        "if (primary) return primary",
    ),
    (
        "C. url[] 里的空白项不过滤（空白地址会被当成产物交给下游）",
        LIB,
        "    (url): url is string => typeof url === 'string' && url.trim().length > 0,",
        "    (url): url is string => typeof url === 'string',",
    ),
    (
        "D. liveRefUrl 用 ?? 而不是 ||（上游还没产物时不退回快照）",
        LIB,
        "  return primaryOutputUrl(data) || (typeof fallbackUrl === 'string' ? fallbackUrl : '')",
        "  return (primaryOutputUrl(data) as string | undefined) ?? (typeof fallbackUrl === 'string' ? fallbackUrl : '')",
    ),
    (
        "E. 药丸只换 data-url，不换小预览的 src（指向新图、显示旧图）",
        CHIPS,
        "    if (media instanceof HTMLImageElement || media instanceof HTMLVideoElement) {\n      media.setAttribute('src', nextUrl)\n    }",
        "",
    ),
    (
        "F. 药丸只认外层 <img>，不认视频那层里的 <video>",
        CHIPS,
        "    const media = preview instanceof HTMLImageElement\n      ? preview\n      : preview?.querySelector<HTMLElement>('img, video') ?? null",
        "    const media = preview instanceof HTMLImageElement ? preview : null",
    ),
    (
        "G. 没变化也重新序列化 HTML（编辑器会反复重建 DOM、顶掉光标）",
        CHIPS,
        "  return changed ? template.innerHTML : html",
        "  return template.innerHTML",
    ),
    (
        "H. params 层没变化也返回新对象（调用方的 !== 判断失效、每次生成都白写一次）",
        CHIPS,
        "  if (!changed && promptHtml === params.promptHtml) return params\n  return { ...params, promptChips, promptHtml }",
        "  return { ...params, promptChips, promptHtml }",
    ),
    (
        "I. 药丸不按 nodeId 对齐，谁都换（把无关引用的地址也改掉）",
        CHIPS,
        "    const nextUrl = nodeId ? live[nodeId] : ''",
        "    const nextUrl = Object.values(live)[0] ?? ''",
    ),
    (
        "J. 视频节点解析参考素材时又用 url[0]",
        VID,
        "      const liveUrl = liveRefUrl(srcNode?.data as CanvasNodeData, ref.url)\n      return { ...ref, url: liveUrl, orderName: `图片${i + 1}`, previewKind: 'image' }",
        "      const liveUrl = (srcNode?.data as CanvasNodeData)?.url?.[0] ?? ref.url\n      return { ...ref, url: liveUrl, orderName: `图片${i + 1}`, previewKind: 'image' }",
    ),
    (
        "K. 文字节点解析参考素材时又用 url[0]",
        TXT,
        "      const liveUrl = liveRefUrl(srcNode?.data, ref.url)",
        "      const liveUrl = srcNode?.data.url?.[0] ?? ref.url",
    ),
    (
        "L. 图片节点把原始 params.promptHtml 交回编辑器（@引用不跟着换）",
        IMG,
        "              htmlSnapshot={promptHtmlSnapshot}",
        "              htmlSnapshot={params.promptHtml}",
    ),
    (
        "M. 视频节点把原始 params.promptHtml 交回编辑器",
        VID,
        "            htmlSnapshot={promptHtmlSnapshot}",
        "            htmlSnapshot={params.promptHtml}",
    ),
    (
        "N. 图片节点提交生成前不刷新药丸地址（旧图会跟着一起发出去）",
        IMG,
        "    const requestParams = refreshPromptChipUrlsInParams({",
        "    const requestParams = ({",
    ),
    (
        "O. 视频节点提交生成前不刷新药丸地址",
        VID,
        "      const freshParams = refreshPromptChipUrlsInParams({",
        "      const freshParams = ({",
    ),
]

TESTS = ["tests/reference-follows-main-asset.test.ts", "tests/image-compare.test.ts"]


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
    if failed == 0 and "Test Files  2 passed" not in out:
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
