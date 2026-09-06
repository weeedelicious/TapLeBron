"""变异验证：三维空间的出图落点、全屏、参考图反推姿势（2026-08-26）。

每一条都对应一个真实踩过或差点踩到的坑。姿势那几条尤其重要 ——
坐标系符号错了在界面上只是「解得不太准」，不像 bug，最容易蒙过去。

多行锚点写成**行的元组**（运行时拼起来），这样脚本里不需要任何换行转义，
而且能自动适配仓库里 CRLF / LF 混用的情况（读写都按字节往返，不改行尾）。

用法：python tools/_mutate_director_stage_pose_ref.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Union

ROOT = Path(__file__).resolve().parent.parent
D = ROOT / 'src' / 'canvas' / 'features' / 'director-stage'
PFL = D / 'poseFromLandmarks.ts'
IK = D / 'ik.ts'
MERGE = D / 'renderMerge.ts'
MODAL = D / 'DirectorStageModal.tsx'
CSS = D / 'director-stage.css'
ESTIMATOR = D / 'poseEstimator.ts'
STAGE_REF = D / 'stageReference.ts'
NODE = ROOT / 'src' / 'canvas' / 'components' / 'nodes' / 'DirectorStageNode.tsx'
CANVAS = ROOT / 'src' / 'canvas' / 'components' / 'Canvas.tsx'

SUITE = [
    'tests/director-stage-pose-from-landmarks.test.ts',
    'tests/director-stage-render-and-reference.test.ts',
    'tests/director-stage-node.test.tsx',
    'tests/director-stage-ik.test.ts',
    'tests/canvas-add-node-edges.test.ts',
]

Anchor = Union[str, tuple]

MUTATIONS: list[tuple[str, Path, Anchor, Anchor]] = [
    # ── 坐标系：三个符号各错一次 ────────────────────────────────────────────
    ('A. 左右镜像（x 不取角色左）—— 抬左手会变成抬右手',
     PFL, 'return [x, -y, -z]', 'return [-x, -y, -z]'),
    ('B. 上下颠倒（y 不翻）—— 整个人倒过来',
     PFL, 'return [x, -y, -z]', 'return [x, y, -z]'),
    ('C. 前后颠倒（z 不翻）—— 向前伸手变成向后',
     PFL, 'return [x, -y, -z]', 'return [x, -y, z]'),

    # ── 约束：漏一处就会解出解剖上不存在的角度 ──────────────────────────────
    ('D. 头部左右转不过钳制（范围只有 ±60，耳线算出来能远超）',
     PFL,
     "head: clampJointAngles('head', [current[0], wrapDeg(earYaw - shoulderYaw), current[2]]),",
     'head: [current[0], wrapDeg(earYaw - shoulderYaw), current[2]] as [number, number, number],'),
    ('E. aimJoint 的结果不过 clampJointAngles',
     IK,
     'const candidate: Pose = { ...best, [jointId]: clampJointAngles(jointId, angles) }',
     'const candidate: Pose = { ...best, [jointId]: angles as [number, number, number] }'),

    # ── 数值稳定性：这几条都是实际踩过的 ────────────────────────────────────
    ('F. aimJoint 退回「无条件接受每一步」（原来发散到 80° 的写法）',
     IK, 'if (gap < bestGap - 1e-12) {', 'if (gap < bestGap + 1e9) {'),
    ('G. 去掉阻尼线搜索，只走整步',
     IK,
     'const AIM_STEP_SCALES = [1, 0.5, 0.25, 0.1] as const',
     'const AIM_STEP_SCALES = [1] as const'),
    ('H. 去掉「骨头几乎躺在旋转轴上就跳过」的病态护栏（垂手会解出 turn=-43°）',
     IK,
     'if (Math.abs(vecDot(current, axis)) > AIM_AXIS_PARALLEL_LIMIT) continue',
     'if (Math.abs(vecDot(current, axis)) > 2) continue'),

    # ── 冗余自由度：肘 / 膝的弯曲平面 ───────────────────────────────────────
    ('I. 不扫冗余自由度（肘的弯曲平面对不上，实测差 15°）',
     PFL,
     '  for (const tilt of redundancySweep(chain.upper)) {',
     '  for (const tilt of [] as number[]) {'),
    ('J. 扫的时候不冻结 tilt（坐标下降会把初值覆盖掉，等于没扫）',
     PFL,
     ('      [0, 1],', '    )'),
     ('      undefined,', '    )')),
    ('K. 去掉「宁可自然一点」的正则（自然站立会解出莫名的大扭转）',
     PFL, 'const NATURALNESS_WEIGHT = 1e-3', 'const NATURALNESS_WEIGHT = 0'),
    ('L. CCD 结果无条件采纳（位置压近 1mm 换来朝向拧歪）',
     PFL,
     'if (boneError(refined) < boneError(candidate)) candidate = refined',
     'candidate = refined'),

    # ── 左右串线 / 可见度 / 头部朝向 ────────────────────────────────────────
    ('M. 左右臂关键点下标互换',
     PFL,
     "  { upper: 'upperArmL', hinge: 'elbowL', tip: 'wristL', upperFrom: LM.leftShoulder, upperTo: LM.leftElbow, hingeTo: LM.leftWrist, tipTo: LM.leftIndex },",
     "  { upper: 'upperArmL', hinge: 'elbowL', tip: 'wristL', upperFrom: LM.rightShoulder, upperTo: LM.rightElbow, hingeTo: LM.rightWrist, tipTo: LM.rightIndex },"),
    ('N. 可见度门槛失效（挡住的半身会被瞎解）',
     PFL,
     'visibility < MIN_VISIBILITY) return null',
     'visibility < -1) return null'),
    ('O. 头部朝上向量退回「嘴→耳」（耳朵比嘴靠后，直立的头都会被判成后仰）',
     PFL,
     'const headUp = direction(resolveSentinel(list, -4), resolveSentinel(list, -5))',
     'const headUp = direction(resolveSentinel(list, -4), resolveSentinel(list, -3))'),

    # ── 出图落点 ──────────────────────────────────────────────────────────
    ('P. 新节点位置不错开（第三张压在第一张身上）',
     MERGE,
     'y: finite(input.stageY, 0) + count * STAGE_RENDER_STAGGER_Y,',
     'y: finite(input.stageY, 0),'),
    ('Q. 出图整体替换自己的 url[]（8-25 冲掉 44 条视频的写法）',
     MERGE,
     'const nextUrls = existing.includes(url) ? [...existing] : [...existing, url]',
     'const nextUrls = [url]'),
    ('R. 已有主图被顶掉（用户挑过的主图不该被改）',
     MERGE,
     "const hadPrimary = typeof data._primaryAssetUrl === 'string' && existing.includes(data._primaryAssetUrl)",
     'const hadPrimary = false'),
    ('S. 不记来源（这张图怎么出来的没法追溯）',
     MERGE, '        directorStageRender: {', '        directorStageRenderDisabled: {'),
    # 注意：8 空格缩进的那行是 10 空格那行的子串（str.count 按子串数），
    # 所以必须带上前一行一起锚定，否则会命中 2 次。
    ('T. 新节点比例不跟三维空间的设置',
     MERGE,
     ('        ...baseSettings,', '        ratio: input.state.ratio,'),
     ('        ...baseSettings,', "        ratio: '1:1',")),
    ('U. 出图后又用手写 setEdges 盖掉刚推好的边（刷新才对）',
     NODE,
     '      // 连线不要再手写 setEdges：addNodeAt 已经按新节点 params.imageList 调过',
     '      setEdges(addEdge({ id: `e-${id}-x-stage-render`, source: id, target: id }, edges))'),
    ('UH. 排位置用过期的 contentWidth（新节点叠在三维空间身上）',
     NODE,
     '        stageWidth: stageRenderSourceWidth(stageNode),',
     '        stageWidth: Number(stageNode?.data?.contentWidth ?? 420),'),
    ('UI. 新节点不写预览框尺寸（当场按 620×350 撑开，刷新才对）',
     MERGE,
     ('    contentWidth: frame.width,', '    contentHeight: frame.height,'),
     ('    contentWidth: 620,', '    contentHeight: 350,')),

    # ── 参考图 ────────────────────────────────────────────────────────────
    ('V. 参考图不实时取上游主图（上游换主图后还在分析旧图）',
     STAGE_REF, "const liveUrl = upstream ? primaryOutputUrl(upstream.data) : ''", "const liveUrl = ''"),
    ('W. 上游删除后不清引用',
     STAGE_REF, 'if (!ref?.nodeId || !removedNodeIds.has(ref.nodeId)) return null', 'return null'),
    ('X. 参考图路由允许多条入边（连第二张不替换第一张）',
     CANVAS,
     'const retainedEdges = es.filter(edge => edge.target !== targetNode.id)',
     'const retainedEdges = es'),
    ('Y. 视频 / 音频 / 文本也能占参考图位',
     CANVAS,
     "    if (sourceData.type === 'video' || sourceData.type === 'video_merge' || sourceData.type === 'audio' || sourceData.type === 'text') {",
     '    if (false) {'),

    # ── 全屏 ──────────────────────────────────────────────────────────────
    ('Z. 弹窗改回居中卡片（写死 1520×920）',
     CSS,
     ('  width: 100%;', '  height: 100%;', '  border-radius: 0;', '  border: none;'),
     ('  width: min(1520px, 100%);', '  height: min(920px, 100%);',
      '  border-radius: 16px;', '  border: 1px solid rgba(124, 92, 252, 0.2);')),
    ('AA. backdrop 又留边',
     CSS,
     ('  padding: 0;', '  background: rgba(6, 6, 10, 0.68);'),
     ('  padding: 20px;', '  background: rgba(6, 6, 10, 0.68);')),

    # ── MediaPipe 接线 ────────────────────────────────────────────────────
    ('AB. 模型改成外网 CDN（内网用户加载不了）',
     ESTIMATOR,
     "export const POSE_MODEL_BASE = '/models'",
     "export const POSE_MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models'"),
    ('AC. 用归一化图像坐标而不是世界坐标',
     ESTIMATOR,
     'const world = Array.isArray(result?.worldLandmarks) ? result.worldLandmarks : []',
     'const world = Array.isArray(result?.landmarks) ? result.landmarks : []'),
    ('AD. 加载失败不清缓存（一次抽风让功能整个会话失效）',
     ESTIMATOR,
     ('      landmarkerPromise = null', '      throw new PoseEstimateError('),
     ('      throw new PoseEstimateError(',)),
    # 'IMAGE' 在文件顶部的说明里也出现过一次，所以带缩进和逗号锚定代码里那处
    ('AE. 不是 IMAGE 模式（单张图会走视频那条路）',
     ESTIMATOR, "        runningMode: 'IMAGE',", "        runningMode: 'VIDEO',"),
    ('AF. 分析前不存旧姿势（手调半天被一键覆盖且不可撤销）',
     MODAL, 'setPoseBeforeAnalyze(state.pose)', 'setPoseBeforeAnalyze(null)'),
    ('AG. 首次下载体积两处对不上（界面骗用户）',
     MODAL, 'const POSE_FIRST_LOAD_MB = 21', 'const POSE_FIRST_LOAD_MB = 3'),
]


# 这几条**预期**测不出来，不算失败 —— 它们是 aimJoint 里的纵深防御层。
#
# aimJoint 的主要正确性机制是「按需多起点升级」（第一次下降没解好就从种子网格重来）。
# 下面三个守卫的作用是让**第一次下降**就足够好、从而不必触发那 27 次重启 ——
# 也就是说它们主要影响性能，而不是最终结果。单独去掉任何一个，升级都会把结果兜回来，
# 所以行为上不可观测。它们保护的行为本身另有断言覆盖：
#   · 「不比 20° 步长穷举差多少」（发散会立刻现形）
#   · 「对末位级输入扰动稳定」
#   · 「自然站立解出来还是自然站立」
#
# 三个一起去掉是会红的 —— 想验证的话手动改，不要为了刷 caught 去写钉实现细节的脆测试。
EXPECTED_REDUNDANT = {
    'F.': 'aimJoint 的单调接受；升级机制会兜回来',
    'G.': '阻尼线搜索；升级机制会兜回来',
    'H.': '病态轴护栏；升级 + 自然度正则会兜回来',
}


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
    files = {mutation[1] for mutation in MUTATIONS}
    originals = {path: read_raw(path) for path in files}

    print('baseline ...', end=' ', flush=True)
    if not run_suite():
        print('RED — 基线就不绿，先修基线')
        return 1
    print('green')

    missed: list[str] = []
    skipped: list[str] = []
    try:
        for label, path, raw_old, raw_new in MUTATIONS:
            source = originals[path]
            newline = '\r\n' if '\r\n' in source else '\n'
            old = render(raw_old, newline)
            new = render(raw_new, newline)
            count = source.count(old)
            if count != 1:
                print(f'SKIP    {label}  (锚点命中 {count} 次，改脚本)')
                skipped.append(label)
                continue
            write_raw(path, source.replace(old, new))
            green = run_suite()
            write_raw(path, source)
            key = label.split()[0]
            if green and key in EXPECTED_REDUNDANT:
                print(f'(冗余)  {label}\n         └─ {EXPECTED_REDUNDANT[key]}')
            else:
                print(f'{"MISS" if green else "caught"}  {label}')
                if green:
                    missed.append(label)
    finally:
        for path, source in originals.items():
            write_raw(path, source)

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
    print(f'\n{len(MUTATIONS) - len(EXPECTED_REDUNDANT)} 条都被测出来了'
          f'（另有 {len(EXPECTED_REDUNDANT)} 条是预期冗余的纵深防御层，见脚本里的说明）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
