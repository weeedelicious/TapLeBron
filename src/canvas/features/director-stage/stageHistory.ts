/**
 * 三维空间编辑器自己的撤销 / 重做（2026-08-26 用户反馈：在三维空间里按 Ctrl+Z
 * 撤销的是画布上的节点，而不是三维空间里的操作）。
 *
 * 纯函数，不碰 React 也不碰 three —— 历史栈这种东西最容易在「连续拖动」上出错，
 * 抽出来才能单测。
 *
 * ── 核心问题：一次拖动不能记成六十条 ────────────────────────────────────────
 *
 * 滑杆和 3D 手柄都是连续输入：拖一次会触发几十次状态更新。要是每次都入栈，
 * 按一下撤销只退回一像素，用户得按七八十下才回到拖动之前 —— 那和没有撤销一样难用。
 *
 * 所以用 `gesture` 标识「这是同一次操作」：同一个标识连续来，只在**第一次**留基线。
 * 标识由调用方给，比如 `joint:elbowL:0`（某个关节的某个轴）、`camera:focalMm`。
 * 松手 / 抬键时调 `endStageGesture` 清掉标识，下一次改动就是新的一条。
 *
 * 离散操作（手势预设、参考图分析、重置、加删道具）传 `null`，一律各记一条。
 */
import type { DirectorStageState } from './types'

/** 最多记多少步。和灯光台的 80 一致 —— 三维空间的状态更小，80 步内存上毫无压力。 */
export const STAGE_HISTORY_LIMIT = 80

export interface StageHistory {
  /** 越靠后越近。撤销从末尾取。 */
  past: DirectorStageState[]
  future: DirectorStageState[]
  /** 正在进行的那次操作的标识；null 表示下一次改动会新起一条。 */
  gesture: string | null
}

export function emptyStageHistory(): StageHistory {
  return { past: [], future: [], gesture: null }
}

/**
 * 两个状态是不是一样。
 *
 * 用 JSON 比较是安全的：所有状态都过 `normalizeDirectorStageState`，键序固定。
 * 这一步是为了不让「把滑杆拖回原值」也占一条历史。
 */
export function sameStageState(a: DirectorStageState, b: DirectorStageState): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 把 A 的轨道（转 / 平移 / 推拉）换成 B 的，其它字段不动。
 *
 * 焦距滑杆仍要能撤销；用户明确说不回撤的是「转一下视角、右键平移、滚轮推拉」。
 */
export function withOrbitFrom(state: DirectorStageState, orbit: DirectorStageState): DirectorStageState {
  return {
    ...state,
    camera: {
      ...state.camera,
      yaw: orbit.camera.yaw,
      pitch: orbit.camera.pitch,
      distance: orbit.camera.distance,
      target: orbit.camera.target,
    },
  }
}

/**
 * 两个状态是不是「除了轨道以外都一样」。
 *
 * 只转了镜头的那一步根本不该进历史 —— 画面会跟着走，Ctrl+Z 撤不回机位。
 */
export function sameStageStateIgnoringOrbit(a: DirectorStageState, b: DirectorStageState): boolean {
  if (a === b) return true
  return sameStageState(withOrbitFrom(a, b), b)
}

/**
 * 记一步。`previous` 是改动**之前**的状态，`next` 是之后的。
 *
 * 注意重做栈：任何新改动都要清空它 —— 撤销几步之后又改了别的，
 * 原来那条「未来」已经不存在了，留着会让重做跳到一个不相干的状态。
 */
export function commitStageHistory(
  history: StageHistory,
  previous: DirectorStageState,
  next: DirectorStageState,
  gesture: string | null,
): StageHistory {
  if (sameStageState(previous, next)) return history
  // 只动轨道（转视角 / 平移 / 滚轮）不入栈。current 仍会被调用方改掉，
  // 所以画面会跟着镜头走，只是 Ctrl+Z 撤不回机位。
  if (sameStageStateIgnoringOrbit(previous, next)) return history
  if (gesture !== null && gesture === history.gesture) {
    // 同一次拖动的后续帧：基线已经留过了，只需要作废重做栈
    return history.future.length === 0 ? history : { ...history, future: [] }
  }
  return {
    past: [...history.past, previous].slice(-STAGE_HISTORY_LIMIT),
    future: [],
    gesture,
  }
}

/** 松手 / 抬键：下一次改动新起一条。 */
export function endStageGesture(history: StageHistory): StageHistory {
  return history.gesture === null ? history : { ...history, gesture: null }
}

export function canUndoStage(history: StageHistory): boolean {
  return history.past.length > 0
}

export function canRedoStage(history: StageHistory): boolean {
  return history.future.length > 0
}

export interface StageHistoryStep {
  history: StageHistory
  state: DirectorStageState
}

/** 撤销。没得撤就返回 null（调用方据此决定还要不要吞掉这个按键）。 */
export function undoStage(history: StageHistory, current: DirectorStageState): StageHistoryStep | null {
  const state = history.past[history.past.length - 1]
  if (!state) return null
  return {
    // 撤销姿势时把当前轨道留下来 —— 不然刚转好的构图会被一并倒回去。
    // 焦距仍跟历史走：它是面板滑杆，用户要撤的。
    state: withOrbitFrom(state, current),
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, current].slice(-STAGE_HISTORY_LIMIT),
      // 撤销之后必须清掉标识：否则紧接着的改动会被当成「上一次拖动的后续」而不入栈
      gesture: null,
    },
  }
}

export function redoStage(history: StageHistory, current: DirectorStageState): StageHistoryStep | null {
  const state = history.future[history.future.length - 1]
  if (!state) return null
  return {
    state: withOrbitFrom(state, current),
    history: {
      past: [...history.past, current].slice(-STAGE_HISTORY_LIMIT),
      future: history.future.slice(0, -1),
      gesture: null,
    },
  }
}

/**
 * 这个按键是不是「撤销 / 重做」。
 *
 * 三维空间弹窗必须在 **capture 阶段**认出它们并 `stopPropagation` ——
 * 画布在 window 上挂了个冒泡阶段的 Ctrl+Z，不拦的话按 Z 撤销的是画布上的节点
 * （用户 2026-08-26 就是这么把整个三维空间节点撤销掉的）。
 * 而且**即使栈是空的也要拦**：没得撤 ≠ 该让画布去撤。
 */
export function readHistoryHotkey(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): 'undo' | 'redo' | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null
  const key = String(event.key ?? '').toLowerCase()
  if (key === 'y') return 'redo'
  if (key !== 'z') return null
  return event.shiftKey ? 'redo' : 'undo'
}

/**
 * 这个按键会不会被画布的快捷键抢走。
 *
 * 除了撤销，画布还在 window 上听着 `Ctrl+C` / `Ctrl+V`（复制粘贴**节点**）和
 * 裸的 `f`（把视野对到选中节点）。三维空间开着的时候这几个都不该生效 ——
 * 在一个全屏编辑器里按 f，背后的画布悄悄跳了视野，没人能想到是这个原因。
 */
export function isCanvasHotkeyToSwallow(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  const key = String(event.key ?? '').toLowerCase()
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === 'f') return true
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false
  return key === 'c' || key === 'v'
}

/**
 * 三维空间里切姿势工具的快捷键（2026-08-27：按 E 进旋转手柄、按 W 进拖手脚）。
 *
 * 只认裸键：带 Ctrl / Cmd / Alt 的交给浏览器和撤销，Shift 也不认 ——
 * 不然按 Shift 转视角的时候会把工具切掉。
 *
 * 滑杆没有快捷键：它是默认工具，从手柄 / IK 退回去点一下面板就行。
 */
export function readStageToolHotkey(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): 'rotate' | 'ik' | 'finger' | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const key = String(event.key ?? '').toLowerCase()
  if (key === 'e') return 'rotate'
  if (key === 'w') return 'ik'
  if (key === 'r') return 'finger'
  return null
}

/**
 * 这个按键目标是不是正在输入文字。是的话别拦 —— 输入框里的 Ctrl+Z 该撤销文字。
 *
 * `type="range"` 故意**不算**输入文字：刚拖完滑杆焦点就在它上面，
 * 这时候按 Ctrl+Z 想撤销的显然是那次拖动。
 */
export function isTextEditingTarget(target: unknown): boolean {
  const element = target as { isContentEditable?: boolean; tagName?: string; type?: string } | null
  if (!element || typeof element !== 'object') return false
  if (element.isContentEditable) return true
  const tag = String(element.tagName ?? '').toLowerCase()
  if (tag === 'textarea') return true
  if (tag !== 'input') return false
  return ['email', 'number', 'password', 'search', 'tel', 'text', 'url'].includes(String(element.type ?? ''))
}
