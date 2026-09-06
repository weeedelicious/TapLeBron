"""Mutation check for the two reported errors (2026-08-26).

1. Seedance 2.5 视频编辑 + 参考图 → 「最多支持 0 个图片参考」
2. Nano Banana Pro → 原样吐出 litellm 的 429 英文栈
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS = "src/canvas/lib/videoRules.ts"
JS = "server/videoRules.js"
NODE = "src/canvas/components/nodes/VideoNode.tsx"
ROUTES = "server/canvasRoutes.js"

MUTATIONS = [
    # ── ① 参考素材和模式不匹配的说法 ────────────────────────────────────────
    (
        "A. 前端又变回「最多支持 0 个」",
        TS,
        "  if (rule.max === 0) {\n    const alternatives = modesAcceptingRef(model, kind)\n    const hint = alternatives.length ? `，可以改用「${alternatives.join(' / ')}」模式` : ''\n    return `${modeRule.label}不支持${label}参考${hint}`\n  }",
        "",
    ),
    (
        "B. 前端不再推荐可用的模式（用户不知道该去哪）",
        TS,
        "    const hint = alternatives.length ? `，可以改用「${alternatives.join(' / ')}」模式` : ''",
        "    const hint = ''",
    ),
    (
        "C. 推荐模式时不看该模式收不收这类素材（推荐到一个同样不支持的模式）",
        TS,
        "    .filter((mode) => getVideoRefRule(model, mode, kind).max > 0)",
        "",
    ),
    (
        "D. 服务端又变回「最多支持 0 个」（两边说法不一致）",
        JS,
        "  if (rule.max === 0) {\n    const alternatives = modesAcceptingRef(model, kind);\n    const hint = alternatives.length ? `，可以改用「${alternatives.join(' / ')}」模式` : '';\n    return `${modeLabel}不支持${label}参考${hint}`;\n  }",
        "",
    ),
    (
        "E. 校验链路不再走新措辞（只有那个小函数改了，实际报错没变）",
        TS,
        "    const message = videoRefCountError(input.model, mode, kind, count)\n    if (message) return message",
        "    const rule = modeRule.inputs[kind]\n    if (count > rule.max) return `${modeRule.label}最多支持 ${rule.max} 个参考`\n    void videoRefCountError",
    ),
    # ── ② 参考视频说明要跟着模型走 ──────────────────────────────────────────
    (
        "F. 参考视频说明又写死成 2.0 的数字",
        NODE,
        "          {referenceVideoNote}",
        "          参考视频：mp4 / mov，单个 2-15s，最多 3 个，总时长 ≤ 15s",
    ),
    (
        "G. 条数只看模型上限、不看模式上限（视频编辑只收 1 条却报 10 条）",
        TS,
        "  const maxCount = Math.max(0, Math.min(reference.maxCount ?? 0, modeMax))",
        "  const maxCount = Math.max(0, reference.maxCount ?? 0)",
    ),
    (
        "H. 时长写死不读规则",
        TS,
        "    `单个 ${reference.minDurationSec}-${reference.maxDurationSec}s`,",
        "    '单个 2-15s',",
    ),
    (
        "I. 节点上不再提示参考素材和模式不匹配（回到「点了才知道」）",
        NODE,
        "      {refKindWarning && (",
        "      {false && refKindWarning && (",
    ),
    (
        "J. 用不上的参考缩略图不再置灰",
        NODE,
        "                ...(unusableRefKinds.images ? { filter: 'grayscale(1)', opacity: 0.42 } : {}),",
        "",
    ),
    # ── ③ 上游限流 ─────────────────────────────────────────────────────────
    (
        "K. 限流只看 HTTP 状态码（网关把 429 包在别的状态码里就漏了）",
        ROUTES,
        "  const text = rawProviderErrorText(error);\n  return /RateLimitError|RESOURCE_EXHAUSTED|rate limit|too many requests|resource has been exhausted|check quota/i.test(text);",
        "  return false;",
    ),
    (
        "L. 判定限流时读的是映射后的中文（自己把自己的判据擦掉）",
        ROUTES,
        "  const text = rawProviderErrorText(error);",
        "  const text = String(errorMessageFrom(error) || '');",
    ),
    (
        "M. 限流不算可重试（第一次就直接失败）",
        ROUTES,
        "  if (isRateLimitedProviderError(error)) return true;\n  if ([408, 425, 500, 502, 503, 504].includes(status)) return true;",
        "  if ([408, 425, 500, 502, 503, 504].includes(status)) return true;",
    ),
    (
        "N. 限流用普通短退避（0.9 秒重试配额错误纯属白等）",
        ROUTES,
        "  if (isRateLimitedProviderError(error)) return Math.min(12_000, 2_000 * 2 ** (step - 1));",
        "",
    ),
    (
        "O. 退避没有上限（用户干等一分钟）",
        ROUTES,
        "  if (isRateLimitedProviderError(error)) return Math.min(12_000, 2_000 * 2 ** (step - 1));",
        "  if (isRateLimitedProviderError(error)) return 2_000 * 2 ** (step - 1);",
    ),
    (
        "P. 次数是脏值时退避变成 0 / NaN（等于原地猛冲）",
        ROUTES,
        "  const step = Math.max(1, Number(attempt) || 1);",
        "  const step = Number(attempt);",
    ),
    (
        "Q. errorMessageFrom 不映射限流（用户又看到 litellm 英文栈）",
        ROUTES,
        "  if (/RateLimitError|RESOURCE_EXHAUSTED|resource has been exhausted|too many requests|rate limit/i.test(rawMessage)) {\n    return '上游模型在限流（配额用尽 429），稍等一会儿再点生成；着急的话先换一个模型。';\n  }",
        "",
    ),
    (
        "R. 映射写在被覆盖的那个重复定义里（等于没写 —— 这就是第一版踩的坑）",
        ROUTES,
        "  const rawMessage = `${payloadMessage} ${error?.message || ''}`;\n  if (/RateLimitError",
        "  const rawMessage = '';\n  if (/RateLimitError",
    ),
    (
        "S. 限流文案不带模型名、也不说该怎么办",
        ROUTES,
        "  return `${label} 触发了上游限流（配额用尽 429），${tried}稍等一会儿再点生成；着急的话先换一个模型。`;",
        "  return '限流';",
    ),
    (
        "T. 图片链路重试用尽后仍抛原始错误（英文栈照旧露出来）",
        ROUTES,
        "        if (isRateLimitedProviderError(error)) {\n          throw new Error(rateLimitedProviderMessage(model, attempts));\n        }",
        "",
    ),
    (
        "U. 把所有上游报错都糊成限流（别的错也看不出原因了）",
        ROUTES,
        "  if (/RateLimitError|RESOURCE_EXHAUSTED|resource has been exhausted|too many requests|rate limit/i.test(rawMessage)) {",
        "  if (true) {",
    ),
]

TESTS = [
    "tests/video-ref-mode-mismatch.test.ts",
    "tests/provider-rate-limit-error.test.ts",
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
