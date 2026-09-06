"""变异验证：三维空间自己的撤销 / 重做（2026-08-26 用户反馈「按 Z 撤销了整个节点」）。

最要紧的是 A / B / C 三条 —— 它们都对应「按键漏给画布、把节点撤掉」这个原始 bug：
  A 注册成冒泡阶段（画布的监听先跑）；
  B stopPropagation 排在分派之后（等于只有有东西可撤时才拦）；
  C 显式加上「有东西可撤才拦」的条件。
刚打开弹窗、还没操作过的时候，B 和 C 都会让节点被撤掉 —— 正是用户遇到的那一幕。

用法：python tools/_mutate_director_stage_history.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Union

ROOT = Path(__file__).resolve().parent.parent
D = ROOT / 'src' / 'canvas' / 'features' / 'director-stage'
HIST = D / 'stageHistory.ts'
MODAL = D / 'DirectorStageModal.tsx'
THREE = D / 'DirectorStageThree.tsx'

SUITE = [
    'tests/director-stage-history.test.ts',
    'tests/director-stage-render-and-reference.test.ts',
    'tests/director-stage-mannequin.test.ts',
]

Anchor = Union[str, tuple]

MUTATIONS: list[tuple[str, Path, Anchor, Anchor]] = [
    ('A. 按键监听改成冒泡阶段（画布那个先跑，节点被撤掉）',
     MODAL,
     "    window.addEventListener('keydown', onKeyDown, true)",
     "    window.addEventListener('keydown', onKeyDown)"),
    ('B. stopPropagation 挪到分派之后（栈空时就漏给画布了）',
     MODAL,
     ('        event.preventDefault()',
      '        event.stopPropagation()',
      "        if (hotkey === 'undo') doUndo()",
      '        else doRedo()'),
     ('        event.preventDefault()',
      "        if (hotkey === 'undo') doUndo()",
      '        else doRedo()',
      '        event.stopPropagation()')),
    ('C. 只在「有东西可撤」时才拦（刚打开弹窗按 Z 照样撤掉节点）',
     MODAL,
     '      if (hotkey) {',
     '      if (hotkey && (canUndoStage(historyRef.current) || canRedoStage(historyRef.current))) {'),
    ('D. 同一次拖动也新起一条（拖一下滑杆记六十条，撤销等于没有）',
     HIST,
     '  if (gesture !== null && gesture === history.gesture) {',
     '  if (false) {'),
    ('E. 新改动不清空重做栈（重做会跳到一个不相干的状态）',
     HIST,
     ('  return {',
      '    past: [...history.past, previous].slice(-STAGE_HISTORY_LIMIT),',
      '    future: [],',
      '    gesture,',
      '  }'),
     ('  return {',
      '    past: [...history.past, previous].slice(-STAGE_HISTORY_LIMIT),',
      '    future: history.future,',
      '    gesture,',
      '  }')),
    ('F. 撤销之后不清 gesture（紧接着的改动会被当成上一次拖动的后续，不入栈）',
     HIST,
     ('      future: [...history.future, current].slice(-STAGE_HISTORY_LIMIT),',
      '      // 撤销之后必须清掉标识：否则紧接着的改动会被当成「上一次拖动的后续」而不入栈',
      '      gesture: null,'),
     ('      future: [...history.future, current].slice(-STAGE_HISTORY_LIMIT),',
      '      // 撤销之后必须清掉标识：否则紧接着的改动会被当成「上一次拖动的后续」而不入栈',
      '      gesture: history.gesture,')),
    ('G. 状态没变也记一条（把滑杆拖回原值白占一步）',
     HIST,
     ('  if (sameStageState(previous, next)) return history',
      '  // 只动轨道（转视角 / 平移 / 滚轮）不入栈。current 仍会被调用方改掉，',
      '  // 所以画面会跟着镜头走，只是 Ctrl+Z 撤不回机位。',
      '  if (sameStageStateIgnoringOrbit(previous, next)) return history'),
     ('  if (false) return history',
      '  // 只动轨道（转视角 / 平移 / 滚轮）不入栈。current 仍会被调用方改掉，',
      '  // 所以画面会跟着镜头走，只是 Ctrl+Z 撤不回机位。',
      '  if (false) return history')),
    ('H. 历史没有上限（长时间编辑会一直涨）',
     HIST,
     '    past: [...history.past, previous].slice(-STAGE_HISTORY_LIMIT),',
     '    past: [...history.past, previous],'),
    ('I. 焦点在滑杆上时当成「在输入文字」→ 刚拖完滑杆按 Ctrl+Z 没反应',
     HIST,
     "  return ['email', 'number', 'password', 'search', 'tel', 'text', 'url'].includes(String(element.type ?? ''))",
     '  return true'),
    ('J. 不吞画布的裸 f / Ctrl+C / Ctrl+V（背后的画布悄悄动了）',
     HIST,
     "  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === 'f') return true",
     "  if (false) return true"),
    ('K. 滑杆的 gesture 不区分轴（拖完 bend 再拖 tilt 会被并成一条）',
     MODAL, '`joint:${jointId}:${index}`', '`joint:${jointId}`'),
    ('L. 手指滑杆不带 gesture（拖一下记几十条）',
     MODAL, '`finger:${handSide}:${name}:curl`', 'null'),
    ('M. 手势预设按连续输入合并（连点两个预设只能撤一次）',
     MODAL, 'preset.key), null)', "preset.key), 'preset')"),
    ('N. Ctrl+Shift+Z 也当成撤销（重做没法用）',
     HIST, "  return event.shiftKey ? 'redo' : 'undo'", "  return 'undo'"),
    ('O. E 不切旋转手柄（按 E 没反应）',
     HIST, "  if (key === 'e') return 'rotate'", "  if (false) return 'rotate'"),
    ('P. W 不切拖手脚（按 W 没反应）',
     HIST, "  if (key === 'w') return 'ik'", "  if (false) return 'ik'"),
    ('Q. 切工具时不清道具选中（按 W 绿色关节带着 XYZ 平移轴）',
     MODAL,
     ('        setTool(toolHotkey)',
      '        // 道具的平移 gizmo 和关节的旋转 / IK 不能同时挂在 TransformControls 上，',
      '        // 切姿势工具时把道具选中清掉，否则按 W 之后绿色关节还会带着 XYZ 平移轴。',
      '        setSelectedPropId(null)'),
     ('        setTool(toolHotkey)',
      '        // 道具的平移 gizmo 和关节的旋转 / IK 不能同时挂在 TransformControls 上，',
      '        // 切姿势工具时把道具选中清掉，否则按 W 之后绿色关节还会带着 XYZ 平移轴。',
      '        void 0')),
    ('R. 只转视角也入栈（Ctrl+Z 会把构图倒回去）',
     HIST,
     '  if (sameStageStateIgnoringOrbit(previous, next)) return history',
     '  if (false) return history'),
    ('S. 撤销姿势时轨道也跟着倒回去',
     HIST,
     ('    // 撤销姿势时把当前轨道留下来 —— 不然刚转好的构图会被一并倒回去。',
      '    // 焦距仍跟历史走：它是面板滑杆，用户要撤的。',
      '    state: withOrbitFrom(state, current),'),
     ('    // 撤销姿势时把当前轨道留下来 —— 不然刚转好的构图会被一并倒回去。',
      '    // 焦距仍跟历史走：它是面板滑杆，用户要撤的。',
      '    state,')),
    ('T. 打开时不先摆机位（对着原点）',
     THREE,
     '    camera.position.set(ix, iy, iz)',
     '    void ix; void iy; void iz'),
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
    originals = {path: read_raw(path) for path in {mutation[1] for mutation in MUTATIONS}}

    print('baseline ...', end=' ', flush=True)
    if not run_suite():
        print('RED — 基线就不绿，先修基线')
        return 1
    print('green')

    missed: list[str] = []
    skipped: list[str] = []
    try:
        for label, path, raw_old, raw_new in MUTATIONS:
            original = originals[path]
            newline = '\r\n' if '\r\n' in original else '\n'
            old = render(raw_old, newline)
            new = render(raw_new, newline)
            count = original.count(old)
            if count != 1:
                print(f'SKIP    {label}  (锚点在 {path.name} 命中 {count} 次，改脚本)')
                skipped.append(label)
                continue
            write_raw(path, original.replace(old, new))
            green = run_suite()
            write_raw(path, original)
            print(f'{"MISS" if green else "caught"}  {label}')
            if green:
                missed.append(label)
    finally:
        for path, text in originals.items():
            write_raw(path, text)

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
