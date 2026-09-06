"""Mutation check for the 3D 三维空间 node (2026-08-26)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAM = "src/canvas/features/director-stage/cameraMath.ts"
SKEL = "src/canvas/features/director-stage/skeleton.ts"
IK = "src/canvas/features/director-stage/ik.ts"
TYPES = "src/canvas/features/director-stage/types.ts"
MERGE = "src/canvas/features/director-stage/renderMerge.ts"
THREE = "src/canvas/features/director-stage/DirectorStageThree.tsx"
CANVAS = "src/canvas/components/Canvas.tsx"
NODEDATA = "src/canvas/lib/nodeData.ts"

MUTATIONS = [
    # ── 焦距 ────────────────────────────────────────────────────────────────
    (
        "A. 焦距换算用了感光面宽度（50mm 会拍成广角）",
        CAM,
        "  return 2 * Math.atan(SENSOR_HEIGHT_MM / 2 / focal) / DEG",
        "  return 2 * Math.atan(SENSOR_WIDTH_MM / 2 / focal) / DEG",
    ),
    (
        "B. 焦距和视场角成正比（滑杆方向反了）",
        CAM,
        "  return 2 * Math.atan(SENSOR_HEIGHT_MM / 2 / focal) / DEG",
        "  return 2 * Math.atan(focal / (SENSOR_HEIGHT_MM / 2)) / DEG",
    ),
    (
        "C. 俯仰放开到 ±90（相机 up 翻转、画面跳）",
        CAM,
        "export const MAX_PITCH_DEG = 89",
        "export const MAX_PITCH_DEG = 90",
    ),
    (
        "D. 出图尺寸不区分横竖幅",
        CAM,
        "  if (aspect >= 1) {\n    return { width: Math.round(short * aspect), height: short, aspect }\n  }\n  return { width: short, height: Math.round(short / aspect), aspect }",
        "  return { width: short, height: Math.round(short / aspect), aspect }",
    ),
    # ── 关节自由度 ──────────────────────────────────────────────────────────
    (
        "E. 肘关节放开三个轴（解剖上不存在的姿势）",
        SKEL,
        "    id: 'elbowL', parent: 'upperArmL', offset: [0, -0.27, 0], label: '左肘',\n    axes: { bend: { label: '弯曲', min: 0, max: 150, sign: -1 } },",
        "    id: 'elbowL', parent: 'upperArmL', offset: [0, -0.27, 0], label: '左肘',\n    axes: limbAxes([0, 150], [-90, 90], [-90, 90]),",
    ),
    (
        "F. clampJointAngles 不再按关节过滤轴（滑杆/手柄/IK 三条路一起失守）",
        SKEL,
        "    const def = joint.axes[axis]\n    if (!def) return\n    out[index] = Math.min(def.max, Math.max(def.min, finite(input[index])))",
        "    const def = joint.axes[axis]\n    out[index] = def ? Math.min(def.max, Math.max(def.min, finite(input[index]))) : finite(input[index])",
    ),
    (
        "G. 上下限不钳（库里的越界值会渲染成怪姿势）",
        SKEL,
        "    out[index] = Math.min(def.max, Math.max(def.min, finite(input[index])))",
        "    out[index] = finite(input[index])",
    ),
    (
        "H. 右侧关节不镜像（右臂往反方向抬）",
        SKEL,
        "  const mirror = joint.mirror && axis !== 'bend' ? -1 : 1",
        "  const mirror = 1",
    ),
    (
        "I. 手臂的前后抬不取反（拉「往前抬」结果往后甩）",
        SKEL,
        "  bend: { label: '前后抬', min: raise[0], max: raise[1], sign: -1 as const },",
        "  bend: { label: '前后抬', min: raise[0], max: raise[1] },",
    ),
    (
        "J. 膝盖也跟着取反（会朝前反折）",
        SKEL,
        "    axes: { bend: { label: '弯曲', min: 0, max: 150 } },\n    shape: { kind: 'capsule', size: [0.046, 0.3, 0], offset: [0, -0.2, 0] },",
        "    axes: { bend: { label: '弯曲', min: 0, max: 150, sign: -1 } },\n    shape: { kind: 'capsule', size: [0.046, 0.3, 0], offset: [0, -0.2, 0] },",
    ),
    # ── IK ────────────────────────────────────────────────────────────────
    (
        "K. IK 结果不过钳制（会把肘掰出侧倾）",
        IK,
        "      next[linkId] = clampJointAngles(linkId, current)",
        "      next[linkId] = current",
    ),
    (
        "L. IK 用 Euler 角度当语义角度（右臂/膝盖方向全错）",
        IK,
        "        const deltaDeg = (deltaRad * 180) / Math.PI * axisEulerSign(linkId, index)",
        "        const deltaDeg = (deltaRad * 180) / Math.PI",
    ),
    (
        "M. FK 的 Euler 顺序和 skeleton 不一致（算的和渲染的是两个姿势）",
        IK,
        "  return mat3Mul(mat3Mul(ry, rx), rz)",
        "  return mat3Mul(mat3Mul(rx, ry), rz)",
    ),
    (
        "N. FK 忘了把父关节的旋转带到子关节偏移上（转胯身体不跟着走）",
        IK,
        "      position: vecAdd(parentPosition, mat3Apply(parentRotation, joint.offset)),",
        "      position: vecAdd(parentPosition, joint.offset),",
    ),
    (
        "O. IK 每轮不重算 FK（迭代等于原地打转）",
        IK,
        "      next[linkId] = clampJointAngles(linkId, current)\n      world = forwardKinematics(next)",
        "      next[linkId] = clampJointAngles(linkId, current)",
    ),
    (
        "P. IK 直接改传进来的姿势对象（撤销/对比拿到的是被改过的）",
        IK,
        "  const next: Pose = { ...pose }",
        "  const next: Pose = pose",
    ),
    # ── 状态容错与体积 ──────────────────────────────────────────────────────
    (
        "Q. 相机脏值只兜 null（'abc' 会被当成 0，机位莫名归位）",
        TYPES,
        "    yaw: roundCoord(normalizeYawDeg(finite(source.yaw, fallback.yaw))),",
        "    yaw: roundCoord(normalizeYawDeg(source.yaw ?? fallback.yaw)),",
    ),
    (
        "R. 姿势不再丢掉全 0 的关节（state 白白变大）",
        TYPES,
        "    if (angles[0] === 0 && angles[1] === 0 && angles[2] === 0) continue",
        "",
    ),
    (
        "S. 坐标不再砍小数（JSON 里躺一串 17 位浮点）",
        TYPES,
        "  return Math.round(finite(value, fallback) * 1e4) / 1e4",
        "  return finite(value, fallback)",
    ),
    (
        "T. 道具缩放允许 0（three 退化矩阵，物体静默消失）",
        TYPES,
        "      Math.min(20, Math.max(0.02, scale[0])),",
        "      Math.min(20, scale[0]),",
    ),
    (
        "U. 写回 params 时把别的键冲掉（提示词/引用列表一起没了）",
        TYPES,
        "  return { ...source, stage: normalizeDirectorStageState(state) }",
        "  return { stage: normalizeDirectorStageState(state) }",
    ),
    # ── 出图写回（最要命的一类）──────────────────────────────────────────────
    (
        "V. 出图整体替换 url[]（8-25 冲掉 44 条视频的同一个形状）",
        MERGE,
        "  const nextUrls = existing.includes(url) ? [...existing] : [...existing, url]",
        "  const nextUrls = [url]",
    ),
    (
        "W. 出图总是抢走主图（用户挑过的被替掉）",
        MERGE,
        "  const hadPrimary = typeof data._primaryAssetUrl === 'string' && existing.includes(data._primaryAssetUrl)",
        "  const hadPrimary = false",
    ),
    (
        "X. resourceMeta 整个换掉，不保留已有的",
        MERGE,
        "    ? [...existingItems.filter((item) => !sameAsset(item, record.resourceMeta)), record.resourceMeta]",
        "    ? [record.resourceMeta]",
    ),
    (
        "Y. 已有产物的来源标记被冲掉",
        MERGE,
        "    _assetGenerationMeta: { ...(data._assetGenerationMeta ?? {}), [url]: generationMeta },",
        "    _assetGenerationMeta: { [url]: generationMeta },",
    ),
    (
        "Z. 空地址也照写（会往 url[] 里塞空串）",
        MERGE,
        "  if (!url) return {}",
        "",
    ),
    # ── 接线 ──────────────────────────────────────────────────────────────
    (
        "AA. 右键「添加节点」里没有三维空间（用户要求第 4 条）",
        CANVAS,
        "  { type: 'director_stage', label: '三维空间', desc: '摆机位调焦距 + 白模姿势，出图当构图参考', icon: '◈' },\n",
        "",
    ),
    (
        "BB. 节点类型整数被改（线上库里存的是 5，改了等于所有旧节点认不出来）",
        NODEDATA,
        "director_stage: 5,",
        "director_stage: 12,",
    ),
    (
        "CC. 出图不藏把手和 gizmo（成图里带着一堆紫色小球）",
        THREE,
        "        runtime.handles.forEach((handle) => { handle.visible = false })",
        "",
    ),
    (
        "DD. renderer 不开 preserveDrawingBuffer（toBlob 出来是空白）",
        THREE,
        "      preserveDrawingBuffer: true,",
        "",
    ),
    (
        "DD2. renderer 不开 alpha（关掉背景板也出不了透明底）",
        THREE,
        "      alpha: true,",
        "",
    ),
    (
        "EE. 焦距不接到相机 fov（滑杆变成装饰）",
        THREE,
        "    runtime.camera.fov = focalToFovDeg(clampFocalMm(camera.focalMm))",
        "",
    ),
]

TESTS = [
    "tests/director-stage-camera.test.ts",
    "tests/director-stage-skeleton.test.ts",
    "tests/director-stage-ik.test.ts",
    "tests/director-stage-state.test.ts",
    "tests/director-stage-node.test.tsx",
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
    if failed == 0 and "Test Files  5 passed" not in out:
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
