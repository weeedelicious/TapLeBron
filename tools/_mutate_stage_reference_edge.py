"""变异验证：三维空间参考图连线刷新后不许断（2026-08-26 用户反馈）。

第一条就是这个 bug 本身：把重建块整段去掉，必须让测试变红。

用法：python tools/_mutate_stage_reference_edge.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Union

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / 'src' / 'canvas' / 'store' / 'canvasStore.ts'
SUITE = [
    'tests/director-stage-reference-edge.test.ts',
    'tests/canvas-add-node-edges.test.ts',
    'tests/image-compare.test.ts',
]

Anchor = Union[str, tuple]

MUTATIONS: list[tuple[str, Anchor, Anchor]] = [
    ('A. 整段去掉 stageRef 的重建块（= 这次的 bug 本身，刷新就断线）',
     '    if ((targetNode.data.type as string) !== "director_stage") continue;',
     '    if (true) continue;'),
    ('B. 读错字段名（读 stageReference 而不是 stageRef）',
     'params.stageRef as { nodeId?: unknown } | null | undefined',
     'params.stageReference as { nodeId?: unknown } | null | undefined'),
    ('C. 不做别名解析（服务端回来的引用是 nodeKey，直接当 flow id 用就找不到）',
     ('    const sourceId = idByAlias.get(sourceAlias);',
      '    if (!sourceId || sourceId === targetNode.id) continue;',
      '    const edgeId = `e-${sourceId}-${targetNode.id}-stage-reference`;'),
     ('    const sourceId = sourceAlias;',
      '    if (!sourceId || sourceId === targetNode.id) continue;',
      '    const edgeId = `e-${sourceId}-${targetNode.id}-stage-reference`;')),
    ('D. 空引用也造边（没连参考图的节点会凭空多一根线）',
     ('    if (!sourceAlias) continue;',
      '    const sourceId = idByAlias.get(sourceAlias);',
      '    if (!sourceId || sourceId === targetNode.id) continue;',
      '    const edgeId = `e-${sourceId}-${targetNode.id}-stage-reference`;'),
     ('    const sourceId = idByAlias.get(sourceAlias) ?? sourceAlias;',
      '    if (sourceId === targetNode.id) continue;',
      '    const edgeId = `e-${sourceId}-${targetNode.id}-stage-reference`;')),
    ('E. 允许自环（引用指向自己时画一根圈回来的线）',
     ('    const sourceId = idByAlias.get(sourceAlias);',
      '    if (!sourceId || sourceId === targetNode.id) continue;',
      '    const edgeId = `e-${sourceId}-${targetNode.id}-stage-reference`;'),
     ('    const sourceId = idByAlias.get(sourceAlias);',
      '    if (!sourceId) continue;',
      '    const edgeId = `e-${sourceId}-${targetNode.id}-stage-reference`;')),
    ('F. 判重只比 edgeId、不比 source→target（同一对会被画两根）',
     ('          e.id === edgeId ||',
      '          (e.source === sourceId && e.target === targetNode.id),'),
     ('          e.id === edgeId ||',
      '          (e.source === sourceId && e.target === targetNode.id && e.targetHandle === "nope"),')),
]


def read_raw(path: Path) -> str:
    with path.open('r', encoding='utf-8', newline='') as handle:
        return handle.read()


def write_raw(path: Path, text: str) -> None:
    with path.open('w', encoding='utf-8', newline='') as handle:
        handle.write(text)


def render(anchor: Anchor, newline: str) -> str:
    return newline.join(anchor) if isinstance(anchor, tuple) else anchor


def run_suite() -> bool:
    proc = subprocess.run(['npx', 'vitest', 'run', *SUITE], cwd=ROOT, capture_output=True, text=True, shell=True)
    return proc.returncode == 0


def main() -> int:
    original = read_raw(STORE)
    newline = '\r\n' if '\r\n' in original else '\n'

    print('baseline ...', end=' ', flush=True)
    if not run_suite():
        print('RED — 基线就不绿，先修基线')
        return 1
    print('green')

    missed: list[str] = []
    skipped: list[str] = []
    try:
        for label, raw_old, raw_new in MUTATIONS:
            old = render(raw_old, newline)
            new = render(raw_new, newline)
            count = original.count(old)
            if count != 1:
                print(f'SKIP    {label}  (锚点命中 {count} 次，改脚本)')
                skipped.append(label)
                continue
            write_raw(STORE, original.replace(old, new))
            green = run_suite()
            write_raw(STORE, original)
            print(f'{"MISS" if green else "caught"}  {label}')
            if green:
                missed.append(label)
    finally:
        write_raw(STORE, original)

    print('\nrestored; verifying ...', end=' ', flush=True)
    print('green' if run_suite() else 'RED (!!)')

    if missed or skipped:
        if missed:
            print(f'\n{len(missed)} 条没被测出来：')
            for label in missed:
                print('  -', label)
        if skipped:
            print(f'\n{len(skipped)} 条锚点失效：')
            for label in skipped:
                print('  -', label)
        return 1
    print(f'\n全部 {len(MUTATIONS)} 条都被测出来了')
    return 0


if __name__ == '__main__':
    sys.exit(main())
