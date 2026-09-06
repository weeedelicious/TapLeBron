"""变异验证：Seedance 2.0 / 2.5 视频编辑收参考图。

2.5 上限 30 是 2026-08-26 实测上游报出的数字；2.0 系列上限 9 来自火山方舟
2026-09-03 更新的官方能力表。所以这里每一条变异都对应一个「配置被改回去 / 改错 /
把两代模型上限混在一起」的真实风险，必须让测试变红。

用法：python tools/_mutate_video_edit_image_ref.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RULES = ROOT / 'src' / 'shared' / 'seedance-video-rules.json'
SUITE = ['tests/video-ref-mode-mismatch.test.ts']

# 每条：(说明, 改哪个模型, 改哪个模式, 改成什么 inputs；None = 删掉这个模式的 override)
MUTATIONS: list[tuple[str, str, str, dict | None]] = [
    ('A. 视频编辑的图片上限改回 0（等于这次改动被整个撤销）',
     'Seedance_2_5', 'video-edit', {'images': {'min': 0, 'max': 0}, 'videos': {'min': 1, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
    ('B. 删掉 video-edit override（回落到共享 modes，图片又变 0）',
     'Seedance_2_5', 'video-edit', None),
    ('C. 图片上限写成 29（比上游报的 30 少一张，用户摆满会被前端误拦）',
     'Seedance_2_5', 'video-edit', {'images': {'min': 0, 'max': 29}, 'videos': {'min': 1, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
    ('D. 图片上限写成 31（超过上游上限，前端放行、上游 400）',
     'Seedance_2_5', 'video-edit', {'images': {'min': 0, 'max': 31}, 'videos': {'min': 1, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
    ('E. 顺手把参考视频放开到 10 条（视频编辑只该收 1 条源视频）',
     'Seedance_2_5', 'video-edit', {'images': {'min': 0, 'max': 30}, 'videos': {'min': 0, 'max': 10}, 'audios': {'min': 0, 'max': 1}}),
    ('F. 参考视频下限改成 0（视频编辑没源视频就没东西可编辑）',
     'Seedance_2_5', 'video-edit', {'images': {'min': 0, 'max': 30}, 'videos': {'min': 0, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
    ('G. 把两代模型差异错误合并到共享 modes（2.0 也会被放到 30 张）',
     '__shared__', 'video-edit', {'images': {'min': 0, 'max': 30}, 'videos': {'min': 1, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
    ('H. 2.0 视频编辑的图片上限改回 0（用户截图里的回归）',
     'Seedance_2_0', 'video-edit', {'images': {'min': 0, 'max': 0}, 'videos': {'min': 1, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
    ('I. 删掉 2.0 video-edit override（回落到共享上限 0）',
     'Seedance_2_0', 'video-edit', None),
    ('J. 2.0 图片上限写成 8（比官方上限少一张）',
     'Seedance_2_0', 'video-edit', {'images': {'min': 0, 'max': 8}, 'videos': {'min': 1, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
    ('K. 2.0 图片上限写成 10（前端会放过上游不收的第 10 张）',
     'Seedance_2_0', 'video-edit', {'images': {'min': 0, 'max': 10}, 'videos': {'min': 1, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
    ('L. 2.0 Fast 没跟上基础版，仍把参考图上限写成 0',
     'Seedance_2_0_Fast', 'video-edit', {'images': {'min': 0, 'max': 0}, 'videos': {'min': 1, 'max': 1}, 'audios': {'min': 0, 'max': 1}}),
]


def run_suite() -> bool:
    proc = subprocess.run(
        ['npx', 'vitest', 'run', *SUITE],
        cwd=ROOT, capture_output=True, text=True, shell=True,
    )
    return proc.returncode == 0


def apply(model: str, mode: str, inputs: dict | None, original: str) -> None:
    data = json.loads(original)
    if model == '__shared__':
        data['modes'][mode]['inputs'] = inputs
        # 同时删掉各代模型 override，模拟把模型差异误收进共享规则的回归。
        for model_key in ('Seedance_2_0', 'Seedance_2_0_Fast', 'Seedance_2_5'):
            data['models'][model_key]['modeInputs'].pop(mode, None)
    elif inputs is None:
        data['models'][model]['modeInputs'].pop(mode, None)
    else:
        data['models'][model]['modeInputs'][mode] = inputs
    RULES.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main() -> int:
    original = RULES.read_text(encoding='utf-8')

    print('baseline ...', end=' ', flush=True)
    if not run_suite():
        print('RED — 基线就不绿，先修基线')
        return 1
    print('green')

    failures: list[str] = []
    try:
        for label, model, mode, inputs in MUTATIONS:
            apply(model, mode, inputs, original)
            green = run_suite()
            print(f'{"MISS" if green else "caught"}  {label}')
            if green:
                failures.append(label)
    finally:
        RULES.write_text(original, encoding='utf-8')

    print('\nrestored; verifying ...', end=' ', flush=True)
    print('green' if run_suite() else 'RED (!!)')

    if failures:
        print(f'\n{len(failures)} 条变异没被测出来：')
        for label in failures:
            print('  -', label)
        return 1
    print(f'\n全部 {len(MUTATIONS)} 条变异都被测出来了')
    return 0


if __name__ == '__main__':
    sys.exit(main())
