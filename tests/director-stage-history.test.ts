/**
 * 三维空间自己的撤销 / 重做（2026-08-26 用户反馈：在三维空间里按 Ctrl+Z，
 * 撤销的是画布上的**节点**，而不是三维空间里的操作 —— 整个节点被撤掉了）。
 *
 * 这里守三件事，每一件都是那个 bug 的一个侧面：
 *
 * ① **按键必须在 capture 阶段被拦下来。** 画布在 window 上挂了个冒泡阶段的 Ctrl+Z。
 *    而且**历史栈空的时候也要拦** —— 「没得撤」不等于「该让画布去撤」，
 *    恰恰是刚打开弹窗、还没操作过的时候最容易一按就把节点撤没了。
 *
 * ② **一次拖动只能记一条。** 滑杆和 3D 手柄拖一下会触发几十次更新，
 *    每次都入栈的话按一下撤销只退回一像素，等于没有撤销。
 *
 * ③ **所有改动都得走同一个入口。** 将来谁加一个新的面板控件、直接调 setState，
 *    那个控件就悄悄不进历史了 —— 这种漏没人会注意到，所以用源码断言钉住。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')

const {
  STAGE_HISTORY_LIMIT,
  canRedoStage,
  canUndoStage,
  commitStageHistory,
  emptyStageHistory,
  endStageGesture,
  isCanvasHotkeyToSwallow,
  isTextEditingTarget,
  readHistoryHotkey,
  readStageToolHotkey,
  redoStage,
  sameStageState,
  sameStageStateIgnoringOrbit,
  undoStage,
  withOrbitFrom,
} = await import('@/features/director-stage/stageHistory')
const { DEFAULT_DIRECTOR_STAGE_STATE, normalizeDirectorStageState } =
  await import('@/features/director-stage/types')

type State = ReturnType<typeof normalizeDirectorStageState>

const base = () => normalizeDirectorStageState(DEFAULT_DIRECTOR_STAGE_STATE)
/** 造一个「弯了 N 度」的状态，用来当历史里的不同快照。 */
const withElbow = (deg: number): State =>
  normalizeDirectorStageState({ ...base(), pose: { elbowL: [deg, 0, 0] } })
const withYaw = (yaw: number): State =>
  normalizeDirectorStageState({ ...base(), camera: { ...base().camera, yaw } })
const withFocal = (focalMm: number): State =>
  normalizeDirectorStageState({ ...base(), camera: { ...base().camera, focalMm } })

describe('记一步 / 撤销 / 重做', () => {
  it('撤销回到上一步，重做再回来', () => {
    const a = base()
    const b = withElbow(30)
    let history = commitStageHistory(emptyStageHistory(), a, b, null)
    expect(canUndoStage(history)).toBe(true)
    expect(canRedoStage(history)).toBe(false)

    const undone = undoStage(history, b)!
    expect(undone.state).toEqual(a)
    expect(canRedoStage(undone.history)).toBe(true)

    const redone = redoStage(undone.history, undone.state)!
    expect(redone.state).toEqual(b)
    expect(canUndoStage(redone.history)).toBe(true)
    expect(canRedoStage(redone.history)).toBe(false)
  })

  it('多步撤销按倒序回退', () => {
    const steps = [base(), withElbow(10), withElbow(20), withElbow(30)]
    let history = emptyStageHistory()
    for (let i = 1; i < steps.length; i += 1) {
      history = commitStageHistory(history, steps[i - 1], steps[i], `step-${i}`)
    }
    let current = steps[3]
    for (let i = 2; i >= 0; i -= 1) {
      const step = undoStage(history, current)!
      expect(step.state, `第 ${i} 步`).toEqual(steps[i])
      history = step.history
      current = step.state
    }
    expect(undoStage(history, current)).toBeNull()
  })

  it('空栈时撤销 / 重做返回 null（调用方据此仍然要吞掉按键）', () => {
    const history = emptyStageHistory()
    expect(undoStage(history, base())).toBeNull()
    expect(redoStage(history, base())).toBeNull()
    expect(canUndoStage(history)).toBe(false)
    expect(canRedoStage(history)).toBe(false)
  })

  it('★ 撤销之后又做了新改动 → 重做栈作废', () => {
    let history = commitStageHistory(emptyStageHistory(), base(), withElbow(30), null)
    const undone = undoStage(history, withElbow(30))!
    expect(canRedoStage(undone.history)).toBe(true)
    history = commitStageHistory(undone.history, undone.state, withElbow(90), null)
    expect(canRedoStage(history), '旧的「未来」已经不存在了，留着会重做到一个不相干的状态').toBe(false)
  })

  it('状态没变就不记（把滑杆拖回原值不该占一条）', () => {
    const a = base()
    const history = commitStageHistory(emptyStageHistory(), a, normalizeDirectorStageState(a), 'x')
    expect(canUndoStage(history)).toBe(false)
    expect(sameStageState(a, normalizeDirectorStageState(a))).toBe(true)
    expect(sameStageState(a, withElbow(1))).toBe(false)
  })

  it(`最多记 ${STAGE_HISTORY_LIMIT} 步，超了丢最老的`, () => {
    let history = emptyStageHistory()
    for (let i = 1; i <= STAGE_HISTORY_LIMIT + 20; i += 1) {
      history = commitStageHistory(history, withElbow(i - 1), withElbow(i), `step-${i}`)
    }
    expect(history.past).toHaveLength(STAGE_HISTORY_LIMIT)
    // 最老的那条应该是第 21 步之前的状态，不是第 0 步
    expect(history.past[0]).toEqual(withElbow(20))
  })

  it('脏输入不抛', () => {
    expect(() => sameStageState(undefined as never, undefined as never)).not.toThrow()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(sameStageState(circular as never, circular as never)).toBe(true)
    expect(sameStageState(circular as never, base())).toBe(false)
  })

  it('★ 只转视角 / 平移 / 滚轮不入栈（对视角的操作不会回撤）', () => {
    const a = base()
    const turned = withYaw(90)
    expect(sameStageStateIgnoringOrbit(a, turned)).toBe(true)
    const history = commitStageHistory(emptyStageHistory(), a, turned, 'camera:orbit')
    expect(canUndoStage(history), '只转了镜头却进了历史，Ctrl+Z 会把构图倒回去').toBe(false)
  })

  it('★ 焦距滑杆仍要能撤（它不是转视角）', () => {
    const a = base()
    const zoomed = withFocal(85)
    expect(sameStageStateIgnoringOrbit(a, zoomed)).toBe(false)
    const history = commitStageHistory(emptyStageHistory(), a, zoomed, 'camera:focalMm')
    expect(canUndoStage(history)).toBe(true)
    expect(undoStage(history, zoomed)!.state.camera.focalMm).toBe(a.camera.focalMm)
  })

  it('★ 撤销姿势时轨道留在当前机位，不跟着倒回去', () => {
    const posed = withElbow(30)
    const posedAndTurned = withOrbitFrom(posed, withYaw(120))
    const history = commitStageHistory(emptyStageHistory(), base(), posed, 'pose3d')
    const undone = undoStage(history, posedAndTurned)!
    expect(undone.state.pose).toEqual(base().pose)
    expect(undone.state.camera.yaw).toBe(120)
    expect(undone.state.camera.focalMm).toBe(base().camera.focalMm)
  })
})

describe('★ 一次拖动只记一条', () => {
  it('同一个 gesture 连续来，只留一条基线', () => {
    let history = emptyStageHistory()
    let previous = base()
    // 模拟拖一次滑杆：六十帧
    for (let i = 1; i <= 60; i += 1) {
      const next = withElbow(i)
      history = commitStageHistory(history, previous, next, 'joint:elbowL:0')
      previous = next
    }
    expect(history.past, '拖一次滑杆记了 60 条，按一下撤销只退一度').toHaveLength(1)
    // 撤销要一步回到拖动之前
    expect(undoStage(history, previous)!.state).toEqual(base())
  })

  it('换了 gesture 就新起一条', () => {
    let history = commitStageHistory(emptyStageHistory(), base(), withElbow(10), 'joint:elbowL:0')
    history = commitStageHistory(history, withElbow(10), withElbow(20), 'joint:kneeL:0')
    expect(history.past).toHaveLength(2)
  })

  it('松手（endStageGesture）之后同一根滑杆也新起一条', () => {
    let history = commitStageHistory(emptyStageHistory(), base(), withElbow(10), 'joint:elbowL:0')
    history = endStageGesture(history)
    expect(history.gesture).toBeNull()
    history = commitStageHistory(history, withElbow(10), withElbow(20), 'joint:elbowL:0')
    expect(history.past).toHaveLength(2)
  })

  it('gesture 传 null 的离散操作各记一条（连着点两次预设要能各撤一次）', () => {
    let history = commitStageHistory(emptyStageHistory(), base(), withElbow(10), null)
    history = commitStageHistory(history, withElbow(10), withElbow(20), null)
    expect(history.past).toHaveLength(2)
  })

  it('拖动中途也要作废重做栈（撤销几步后又开始拖，旧的未来就不成立了）', () => {
    let history = commitStageHistory(emptyStageHistory(), base(), withElbow(30), null)
    const undone = undoStage(history, withElbow(30))!
    history = commitStageHistory(undone.history, undone.state, withElbow(5), 'joint:elbowL:0')
    expect(canRedoStage(history)).toBe(false)
    // 同一次拖动的后续帧仍然不新增基线
    history = commitStageHistory(history, withElbow(5), withElbow(6), 'joint:elbowL:0')
    expect(history.past).toHaveLength(1)
  })

  it('撤销之后 gesture 被清掉（否则紧接着的改动会被当成上一次拖动的后续而不入栈）', () => {
    let history = commitStageHistory(emptyStageHistory(), base(), withElbow(10), 'joint:elbowL:0')
    const undone = undoStage(history, withElbow(10))!
    expect(undone.history.gesture).toBeNull()
    history = commitStageHistory(undone.history, undone.state, withElbow(50), 'joint:elbowL:0')
    expect(history.past).toHaveLength(1)
  })
})

describe('★ 认按键', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

  it('Ctrl+Z 撤销、Ctrl+Shift+Z 和 Ctrl+Y 重做', () => {
    expect(readHistoryHotkey(key('z', { ctrlKey: true }))).toBe('undo')
    expect(readHistoryHotkey(key('Z', { ctrlKey: true }))).toBe('undo')
    expect(readHistoryHotkey(key('z', { ctrlKey: true, shiftKey: true }))).toBe('redo')
    expect(readHistoryHotkey(key('y', { ctrlKey: true }))).toBe('redo')
  })

  it('Mac 的 Cmd+Z 也认', () => {
    expect(readHistoryHotkey(key('z', { metaKey: true }))).toBe('undo')
    expect(readHistoryHotkey(key('z', { metaKey: true, shiftKey: true }))).toBe('redo')
  })

  it('裸的 z、带 Alt 的、别的键都不认', () => {
    expect(readHistoryHotkey(key('z'))).toBeNull()
    expect(readHistoryHotkey(key('z', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(readHistoryHotkey(key('a', { ctrlKey: true }))).toBeNull()
    expect(readHistoryHotkey({ key: undefined as never, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBeNull()
  })

  it('★ 画布那几个快捷键也要吞：裸 f、Ctrl+C、Ctrl+V', () => {
    expect(isCanvasHotkeyToSwallow(key('f'))).toBe(true)
    expect(isCanvasHotkeyToSwallow(key('F'))).toBe(true)
    expect(isCanvasHotkeyToSwallow(key('c', { ctrlKey: true }))).toBe(true)
    expect(isCanvasHotkeyToSwallow(key('v', { metaKey: true }))).toBe(true)
  })

  it('不该吞的：Ctrl+F（浏览器查找）、裸 c、撤销本身（那条走 readHistoryHotkey）', () => {
    expect(isCanvasHotkeyToSwallow(key('f', { ctrlKey: true }))).toBe(false)
    expect(isCanvasHotkeyToSwallow(key('c'))).toBe(false)
    expect(isCanvasHotkeyToSwallow(key('z', { ctrlKey: true }))).toBe(false)
  })

  it('★ 焦点在滑杆上时算「不是在输入文字」—— 刚拖完滑杆按 Ctrl+Z 要撤销那次拖动', () => {
    expect(isTextEditingTarget({ tagName: 'INPUT', type: 'range' })).toBe(false)
    expect(isTextEditingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTextEditingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTextEditingTarget(null)).toBe(false)
    expect(isTextEditingTarget(undefined)).toBe(false)
  })

  it('真在输入文字时不拦（输入框里的 Ctrl+Z 该撤销文字）', () => {
    expect(isTextEditingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTextEditingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextEditingTarget({ isContentEditable: true, tagName: 'DIV' })).toBe(true)
  })

  it('★ 裸 E 切旋转手柄、裸 W 切拖手脚', () => {
    expect(readStageToolHotkey(key('e'))).toBe('rotate')
    expect(readStageToolHotkey(key('E'))).toBe('rotate')
    expect(readStageToolHotkey(key('w'))).toBe('ik')
    expect(readStageToolHotkey(key('W'))).toBe('ik')
    expect(readStageToolHotkey(key('r'))).toBe('finger')
    expect(readStageToolHotkey(key('R'))).toBe('finger')
  })

  it('带修饰键的 E / W 不切工具（Ctrl+E 是浏览器收藏，Shift 转视角也不该切）', () => {
    expect(readStageToolHotkey(key('e', { ctrlKey: true }))).toBeNull()
    expect(readStageToolHotkey(key('w', { metaKey: true }))).toBeNull()
    expect(readStageToolHotkey(key('e', { altKey: true }))).toBeNull()
    expect(readStageToolHotkey(key('q'))).toBeNull()
    expect(readStageToolHotkey({ key: undefined as never, ctrlKey: false, metaKey: false, altKey: false })).toBeNull()
  })
})

describe('★ 接线：按键真的在 capture 阶段被拦下来', () => {
  const SOURCE = (fs.readFileSync(
    path.join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageModal.tsx'),
    'utf8',
  ) as string).replace(/\r\n/g, '\n')

  const handler = SOURCE.slice(
    SOURCE.indexOf('const onKeyDown = (event: KeyboardEvent) => {'),
    SOURCE.indexOf("window.addEventListener('keydown', onKeyDown, true)"),
  )

  it('capture 阶段注册（画布那个是冒泡阶段的 window 监听）', () => {
    expect(SOURCE).toContain("window.addEventListener('keydown', onKeyDown, true)")
    expect(SOURCE).toContain("window.removeEventListener('keydown', onKeyDown, true)")
  })

  it('★ 栈空也要拦：stopPropagation 在分派 undo/redo **之前**、且不带任何条件', () => {
    expect(handler.length).toBeGreaterThan(120)
    const stopAt = handler.indexOf('event.stopPropagation()')
    const undoAt = handler.indexOf('doUndo()')
    expect(stopAt, '没有 stopPropagation —— 按键会漏给画布').toBeGreaterThan(-1)
    expect(undoAt).toBeGreaterThan(-1)
    expect(stopAt, 'stopPropagation 排在 doUndo 之后 —— 那就得等「有东西可撤」才拦，栈空时节点还是会被撤掉')
      .toBeLessThan(undoAt)
    // 拦之前不许出现 canUndo / past.length 这种条件
    expect(handler.slice(0, stopAt), '拦按键这一步不许带「有没有东西可撤」的条件')
      .not.toMatch(/canUndo|past\.length|canRedo/)
  })

  it('Esc 关闭那个监听保持原样（它不需要 capture）', () => {
    expect(SOURCE).toContain("window.addEventListener('keydown', onKey)")
  })

  it('松手 / 抬键会结束这次拖动', () => {
    expect(SOURCE).toContain("window.addEventListener('pointerup', endGesture, true)")
    expect(SOURCE).toContain("window.addEventListener('keyup', endGesture, true)")
    expect(SOURCE).toContain('endStageGesture(historyRef.current)')
  })
})

describe('★ 接线：所有状态改动都走同一个入口', () => {
  const SOURCE = (fs.readFileSync(
    path.join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageModal.tsx'),
    'utf8',
  ) as string).replace(/\r\n/g, '\n')

  it('没有任何绕过 commit 的 setState（绕过的控件会悄悄不进历史）', () => {
    expect(SOURCE, '还有直接改 state 的地方，那个控件的操作撤销不了')
      .not.toMatch(/setState\(\(current\)/)
    // 只剩两处：commit 里写新状态、applyHistoryStep 里回放历史
    expect((SOURCE.match(/setState\(/g) ?? []).length).toBe(2)
  })

  it('连续输入都带 gesture，离散操作传 null', () => {
    // 滑杆按「关节 + 轴」合并
    expect(SOURCE).toContain('`joint:${jointId}:${index}`')
    // 3D 里拖手柄 / IK
    expect(SOURCE).toContain("setPose(pose, 'pose3d')")
    // 手指「整根」滑杆按手 + 指合并；近/中/远走关节轴
    expect(SOURCE).toContain('`finger:${handSide}:${name}:curl`')
    expect(SOURCE).toContain("setJointAxis(id, 2, Number(event.target.value))")
    // 手势预设、参考图分析、重置：各记一条
    expect(SOURCE).toContain('preset.key), null)')
    expect(SOURCE).toContain('setPose(nextPose, null)')
    expect(SOURCE).toContain('setPose({}, null)')
    // 3D 里拖视角标成 camera:orbit，历史层会把它丢掉、不进撤销
    expect(SOURCE).toContain("orbitKeys.length > 0 ? 'camera:orbit'")
  })

  it('★ 打开时必须先摆好机位，再让 OrbitControls 发 change（否则对着原点）', () => {
    const three = (fs.readFileSync(
      path.join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageThree.tsx'),
      'utf8',
    ) as string).replace(/\r\n/g, '\n')
    const setup = three.slice(
      three.indexOf('const scene = new THREE.Scene()'),
      three.indexOf('const transform = new TransformControls'),
    )
    expect(setup).toContain('orbitToPosition(initialCamera)')
    expect(setup).toContain('camera.position.set(ix, iy, iz)')
    const orbitAt = setup.indexOf('const orbit = new OrbitControls')
    const posAt = setup.indexOf('camera.position.set(ix, iy, iz)')
    expect(posAt, '相机还在原点就 new OrbitControls，第一帧 change 会把默认机位冲掉')
      .toBeGreaterThan(-1)
    expect(orbitAt).toBeGreaterThan(-1)
    expect(posAt).toBeLessThan(orbitAt)
    expect(three).toContain("orbit.addEventListener('change', emitCamera)")
    expect(three).toContain('if (applyingCameraRef.current || !cameraLiveRef.current) return')
  })

  it('界面上有撤销 / 重做按钮，不是只有快捷键', () => {
    expect(SOURCE).toContain('onClick={doUndo}')
    expect(SOURCE).toContain('onClick={doRedo}')
    expect(SOURCE).toContain('title="撤销（Ctrl+Z）"')
  })

  it('★ E / W 在 capture 阶段切工具，并且清掉道具选中（否则绿色关节会带着 XYZ 平移轴）', () => {
    expect(SOURCE).toContain('readStageToolHotkey(event)')
    const toolAt = SOURCE.indexOf('const toolHotkey = readStageToolHotkey(event)')
    expect(toolAt).toBeGreaterThan(-1)
    const block = SOURCE.slice(toolAt, SOURCE.indexOf('return', SOURCE.indexOf('setTool(toolHotkey)', toolAt)))
    expect(block).toContain('event.stopPropagation()')
    expect(block).toContain('setTool(toolHotkey)')
    expect(block, '切工具时必须清掉道具选中，不然按 W 绿色关节会带着 XYZ 平移轴')
      .toContain('setSelectedPropId(null)')
    const stopAt = block.indexOf('event.stopPropagation()')
    const setToolAt = block.indexOf('setTool(toolHotkey)')
    expect(stopAt, 'E / W 不拦冒泡的话，按键还会漏给画布').toBeGreaterThan(-1)
    expect(setToolAt).toBeGreaterThan(stopAt)
  })
})
