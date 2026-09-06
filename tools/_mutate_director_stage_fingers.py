"""变异验证：手指关节 + 手势预设 + 参考图反推手指 + MakeHuman 白模（2026-08-26）。

每一条都对应一种「不报错、但白模会摆错」的走法。最要紧的几条：
  · A：把弯曲从 tilt 挪回 bend —— 这是最可能被将来的人「顺手修好」的地方；
  · L/M/N：换基那三种错法，症状都是「手指方向系统性偏一点」，肉眼几乎看不出来；
  · W：静止姿势没烘（手臂还是 A-pose）—— 蒙皮和 IK 会各说各话。

用法：python tools/_mutate_director_stage_fingers.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Union

ROOT = Path(__file__).resolve().parent.parent
D = ROOT / 'src' / 'canvas' / 'features' / 'director-stage'
SKEL = D / 'skeleton.ts'
HAND = D / 'handPose.ts'
HFL = D / 'handFromLandmarks.ts'
THREE = D / 'DirectorStageThree.tsx'
EST = D / 'poseEstimator.ts'
GEN = D / 'mannequinRest.generated.ts'
NODE = ROOT / 'src' / 'canvas' / 'components' / 'nodes' / 'DirectorStageNode.tsx'

SUITE = [
    'tests/director-stage-finger-skeleton.test.ts',
    'tests/director-stage-hand-pose.test.ts',
    'tests/director-stage-hand-from-landmarks.test.ts',
    'tests/director-stage-mannequin.test.ts',
    'tests/director-stage-skeleton.test.ts',
    'tests/director-stage-ik.test.ts',
    'tests/director-stage-pose-from-landmarks.test.ts',
    'tests/director-stage-render-and-reference.test.ts',
]

Anchor = Union[str, tuple]

# (说明, 文件, 原文, 改成)
MUTATIONS: list[tuple[str, Path, Anchor, Anchor]] = [
    # ── 关节表 ──────────────────────────────────────────────────────────────
    ('A. 把手指弯曲挪回 bend 轴（最容易被将来的人「顺手修好」的地方）',
     SKEL,
     "      axes.tilt = { label: '弯曲', min: curlMin, max: curlMax, sign: -1 }",
     "      axes.bend = { label: '弯曲', min: curlMin, max: curlMax, sign: -1 }"),
    ('B. 中节允许反弯（解剖上不存在）',
     SKEL,
     'const CURL_RANGE: Record<1 | 2 | 3, [number, number]> = { 1: [-25, 90], 2: [0, 110], 3: [-10, 80] }',
     'const CURL_RANGE: Record<1 | 2 | 3, [number, number]> = { 1: [-25, 90], 2: [-25, 110], 3: [-10, 80] }'),
    ('C. 给手指也建点选球（手上会挤 30 个球）',
     SKEL, '        pickable: false,', '        pickable: true,'),
    ('D. 手腕的骨向指到拇指（IK 和反推都会把手当成指向拇指）',
     SKEL, "    boneChild: 'middle1L',", "    boneChild: 'thumb1L',"),
    ('E. 偏移改回手写数字（和 glb 脱钩）',
     SKEL,
     "    id: 'hips', parent: null, offset: O.hips, label: '胯（整体）',",
     "    id: 'hips', parent: null, offset: [0, 0.92, 0], label: '胯（整体）',"),

    # ── 滑杆与预设 ──────────────────────────────────────────────────────────
    ('F. 滑杆只写近节（中远节不动，手指弯不起来）',
     HAND, '  ids.forEach((id, index) => {', '  ids.slice(0, 1).forEach((id, index) => {'),
    ('G. 三节一样弯（卷起来像钩子而不是螺旋）',
     HAND,
     'export const FINGER_CURL_PROFILE: readonly [number, number, number] = [0.85, 1, 0.9]',
     'export const FINGER_CURL_PROFILE: readonly [number, number, number] = [1, 1, 1]'),
    ('H. 反算用近节的角度但套中节的上限（拖到 60 松手会跳成别的数）',
     HAND,
     '    return Math.round((midAngle / midRange.max) * FINGER_CURL_MAX)',
     '    return Math.round((poseAngles(pose, proximal)[2] / midRange.max) * FINGER_CURL_MAX)'),
    ('I. 反翘时按上限算（中节会跟着反翘，手指看着断一节）',
     HAND, '  return (-t / -FINGER_CURL_MIN) * range.min', '  return (-t / -FINGER_CURL_MIN) * range.max'),
    ('J. 「握拳」拇指对掌写成外张（爪子而不是拳）',
     HAND,
     '      thumb:  [[-10, -40, -5], [0, 0, 8], [0, 0, 20]],',
     '      thumb:  [[-10, 40, -5], [0, 0, 8], [0, 0, 20]],'),
    ('K. 「重置这只手」只清近节（中远节留着，手还是卷的）',
     HAND,
     '    for (const id of FINGER_JOINT_IDS[side][name]) delete next[id]',
     '    delete next[FINGER_JOINT_IDS[side][name][0]]'),

    # ── 参考图反推手指 ──────────────────────────────────────────────────────
    ('L. 不换基，直接拿观测方向当局部方向（手指朝一个和手掌无关的方向翻过去）',
     HFL,
     '      const local = rebase(observedDir, observed, rest)',
     '      const local = observedDir'),
    ('M. 换基的两组基传反了',
     HFL,
     '      const local = rebase(observedDir, observed, rest)',
     '      const local = rebase(observedDir, rest, observed)'),
    ('N. 不乘手腕的世界旋转（手腕被摆过之后手指就错）',
     HFL,
     '      const target = mat3Apply(wristRotation, vecNormalize(local))',
     '      const target = vecNormalize(local)'),
    ('O. 拇指的关键点错开一节（MakeHuman 的 finger1-1 是掌骨）',
     HFL,
     '  thumb: [[HL.thumbCmc, HL.thumbMcp], [HL.thumbMcp, HL.thumbIp], [HL.thumbIp, HL.thumbTip]],',
     '  thumb: [[HL.thumbMcp, HL.thumbIp], [HL.thumbIp, HL.thumbTip], [HL.thumbIp, HL.thumbTip]],'),
    ('P. 拇指不扫对掌旋转（三个轴瞄一个方向，后两节够不到）',
     HFL, "    if (name === 'thumb') {", '    if (false) {'),
    ('Q. 掌基退化了也照样解（手被压成一条线时会解出乱姿势）',
     HFL, '  if (vecLength(projected) < 1e-4) return null', '  if (false) return null'),

    # ── 渲染与兜底 ──────────────────────────────────────────────────────────
    ('R. 蒙皮载入成功后不隐藏程序化图元（盒子和皮肤重叠）',
     THREE,
     '  runtime.shapeMeshes.forEach((item) => { item.visible = false })',
     '  runtime.shapeMeshes.forEach((item) => { item.visible = true })'),
    ('S. 手指也建点选球（渲染那一侧，30 个球糊在手腕上）',
     THREE, '    if (joint.pickable === false) {', '    if (false) {'),
    ('T. 手部检测喂整张图，不喂裁剪（全身照里手几十个像素，检不出来）',
     EST, '  const result = landmarker.detect(canvas)', '  const result = landmarker.detect(image)'),
    ('U. 裁剪框不留余量（手指会被切掉）',
     EST, 'export const HAND_CROP_MARGIN = 1.9', 'export const HAND_CROP_MARGIN = 1.0'),
    ('V. 不用前臂长兜下限（手攥成一团时框小到看不见手）',
     EST,
     '    radius = Math.max(radius, forearm * HAND_CROP_MIN_FOREARM_RATIO)',
     '    radius = Math.max(radius, 0)'),

    # ── 生成的静止偏移（等价于「脚本跑歪了 / 忘了重跑」）────────────────────
    ('W. 静止姿势没烘（前臂还是 A-pose 的斜向）',
     GEN, '  elbowL: [0.0000, -0.2276, 0.0000],', '  elbowL: [0.1450, -0.1760, 0.0000],'),
    ('X. 右侧偏移没镜像',
     GEN, '  upperArmR: [-0.1412, 0.0054, -0.0548],', '  upperArmR: [0.1412, 0.0054, -0.0548],'),

    # ── 节点能不能拖（2026-08-26 用户反馈「拖动区域太小」）──────────────────
    ('Y. 主体重新挂上 nodrag（可拖区只剩一条细信息行，节点挪不动）',
     NODE,
     ('            title="双击看大图"',),
     ('            className="nodrag"', '            title="双击看大图"')),
    ('Z. 打开改回单击（单击就没法用来拖了）',
     NODE,
     '            onDoubleClick={(event) => { event.stopPropagation(); setPreviewOpen(true) }}',
     '            onClick={() => setPreviewOpen(true)}'),
    ('AA. 双击不拦冒泡（画布会顺手缩放）',
     NODE,
     '            onDoubleClick={(event) => { event.stopPropagation(); setOpen(true) }}',
     '            onDoubleClick={() => setOpen(true)}'),

    # ── 旋转手柄 / IK gizmo（2026-08-27：按 E 不能单轴转、按 W 出现 XYZ 平移轴）──
    ('AB. 关节旋转改回世界空间（三个环拧成一团，拖起来不像单轴）',
     THREE,
     ("      runtime.transform.setMode('rotate')",
      "      runtime.transform.setSpace('local')"),
     ("      runtime.transform.setMode('rotate')",
      "      runtime.transform.setSpace('world')")),
    ('AC. 关节旋转关掉自由旋转大环（只能单轴）',
     THREE,
     ("      runtime.transform.setSpace('local')",
      '      // 彩色环 = 单轴，外圈 E / XYZE = 自由转。用户 2026-08-27 要多轴自由旋转。',
      '      runtime.transform.showE = true'),
     ("      runtime.transform.setSpace('local')",
      '      // 彩色环 = 单轴，外圈 E / XYZE = 自由转。用户 2026-08-27 要多轴自由旋转。',
      '      runtime.transform.showE = false')),
    ('AE. 拖手柄时每帧把欧拉角写回物体（旋转会闪）',
     THREE,
     ('        const angles = semanticFromEuler(jointId, object.rotation)',
      '        callbacksRef.current.onPoseChange({ ...stateRef.current.pose, [jointId]: angles })'),
     ('        const angles = semanticFromEuler(jointId, object.rotation)',
      '        const [ex, ey, ez] = eulerForJoint(jointId, angles)',
      '        object.rotation.set(ex, ey, ez)',
      '        callbacksRef.current.onPoseChange({ ...stateRef.current.pose, [jointId]: angles })')),
    ('AF. 握拳拇指对掌写成 0（拇指支在旁边）',
     HAND,
     '      thumb:  [[-10, -40, -5], [0, 0, 8], [0, 0, 20]],',
     '      thumb:  [[-10, 0, -5], [0, 0, 8], [0, 0, 20]],'),
    ('AD. IK 时道具 gizmo 还挂着（绿色关节带着 XYZ 平移轴）',
     THREE, "    if (tool !== 'ik' && tool !== 'finger' && selectedPropId) {", '    if (selectedPropId) {'),
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
