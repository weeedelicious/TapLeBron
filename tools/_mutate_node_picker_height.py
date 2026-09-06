"""变异验证：右键「添加节点」必须看得见每一项。

2026-08-26 的事故复盘：三维空间是第 9 项，子菜单 max-height 写死 420px 只装 6 项半，
用户翻了一遍说「没有啊」。这里每一条变异都对应「高度又和项数脱节」的一种走法。

用法：python tools/_mutate_node_picker_height.py
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAYOUT = ROOT / 'src' / 'canvas' / 'lib' / 'nodePickerLayout.ts'
CANVAS = ROOT / 'src' / 'canvas' / 'components' / 'Canvas.tsx'
CSS = ROOT / 'src' / 'canvas' / 'styles.css'
SUITE = ['tests/node-picker-fits-all-items.test.ts', 'tests/director-stage-node.test.tsx']

# (说明, 文件, 原文, 替换成)
MUTATIONS: list[tuple[str, Path, str, str]] = [
    ('A. CSS 里把写死的 420px 上限加回来（原样重现今天这个 bug）',
     CSS,
     '/* 同上：max-height 由 lib/nodePickerLayout.ts 算好内联下发，这里只留视口兜底。 */\n.canvas-context-flyout {\n  position: absolute;\n  top: -8px;\n  left: calc(100% + 6px);\n  z-index: 1;\n  width: 302px;\n  max-height: calc(100vh - 24px);',
     '.canvas-context-flyout {\n  position: absolute;\n  top: -8px;\n  left: calc(100% + 6px);\n  z-index: 1;\n  width: 302px;\n  max-height: min(420px, calc(100vh - 24px));'),

    ('B. 整页选择器把 390px 上限加回来',
     CSS,
     '  max-height: calc(100vh - 24px);\n  overflow: auto;\n  padding: 10px;\n}',
     '  max-height: min(390px, calc(100vh - 24px));\n  overflow: auto;\n  padding: 10px;\n}'),

    ('C. 子菜单不再内联下发 maxHeight（CSS 兜底=满视口，看着没事，但定位判断会脱节）',
     CANVAS,
     '<div className="canvas-context-flyout" style={{ maxHeight: pickerHeight }}>',
     '<div className="canvas-context-flyout">'),

    ('D. 整页选择器不再内联下发 maxHeight',
     CANVAS,
     "style={{ left: pos.left, top: pos.top, maxHeight: pickerHeight }}",
     "style={{ left: pos.left, top: pos.top }}"),

    ('E. 往上长的阈值改回写死的 420',
     CANVAS,
     'shouldFlyoutOpenUpward(pos.top, pickerHeight, window.innerHeight)',
     'pos.top + 420 > window.innerHeight'),

    ('F. 整页选择器定位改回写死的 390',
     CANVAS,
     'getMenuPosition(menu.screenX, menu.screenY, 310, pickerHeight)',
     'getMenuPosition(menu.screenX, menu.screenY, 310, 390)'),

    ('G. 高度改成按写死的 6 项算（正好是今天能看见的项数）',
     CANVAS,
     'nodePickerMaxHeight(CANVAS_NODE_ITEMS.length, window.innerHeight)',
     'nodePickerMaxHeight(6, window.innerHeight)'),

    ('H. 行高常量写小（58 → 40，算出来的高度装不下真实行高）',
     LAYOUT,
     'export const NODE_PICKER_ITEM_HEIGHT = 58',
     'export const NODE_PICKER_ITEM_HEIGHT = 40'),

    ('I. 间隙取小的那个（触屏 media query 下会再次被截断）',
     LAYOUT,
     'export const NODE_PICKER_ITEM_GAP = 8',
     'export const NODE_PICKER_ITEM_GAP = 5'),

    ('J. 算高度时漏掉间隙累加（项数越多误差越大）',
     LAYOUT,
     'return chrome + count * NODE_PICKER_ITEM_HEIGHT + (count - 1) * NODE_PICKER_ITEM_GAP',
     'return chrome + count * NODE_PICKER_ITEM_HEIGHT'),

    ('K. maxHeight 反过来取 max（视口矮时会撑出屏幕）',
     LAYOUT,
     'return Math.min(nodePickerContentHeight(itemCount), room)',
     'return Math.max(nodePickerContentHeight(itemCount), room)'),

    ('L. shouldFlyoutOpenUpward 永远返回 false（贴底边就掉出视口）',
     LAYOUT,
     'return top - 8 + height > viewport',
     'return false'),
]


def run_suite() -> bool:
    proc = subprocess.run(
        ['npx', 'vitest', 'run', *SUITE],
        cwd=ROOT, capture_output=True, text=True, shell=True,
    )
    return proc.returncode == 0


def main() -> int:
    originals = {path: path.read_text(encoding='utf-8') for path in {LAYOUT, CANVAS, CSS}}

    print('baseline ...', end=' ', flush=True)
    if not run_suite():
        print('RED — 基线就不绿，先修基线')
        return 1
    print('green')

    failures: list[str] = []
    skipped: list[str] = []
    try:
        for label, path, old, new in MUTATIONS:
            source = originals[path]
            if source.count(old) != 1:
                print(f'SKIP    {label}  (锚点命中 {source.count(old)} 次，改脚本)')
                skipped.append(label)
                continue
            path.write_text(source.replace(old, new), encoding='utf-8')
            green = run_suite()
            path.write_text(source, encoding='utf-8')
            print(f'{"MISS" if green else "caught"}  {label}')
            if green:
                failures.append(label)
    finally:
        for path, source in originals.items():
            path.write_text(source, encoding='utf-8')

    print('\nrestored; verifying ...', end=' ', flush=True)
    print('green' if run_suite() else 'RED (!!)')

    if failures or skipped:
        if failures:
            print(f'\n{len(failures)} 条变异没被测出来：')
            for label in failures:
                print('  -', label)
        if skipped:
            print(f'\n{len(skipped)} 条锚点失效（脚本要跟着代码改）：')
            for label in skipped:
                print('  -', label)
        return 1
    print(f'\n全部 {len(MUTATIONS)} 条变异都被测出来了')
    return 0


if __name__ == '__main__':
    sys.exit(main())
