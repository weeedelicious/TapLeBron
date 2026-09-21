/**
 * 三维空间的全屏编辑器。壳子照 `features/light-stage/LightStageModal.tsx`：
 * portal 到 body、`nodrag` 免得画布跟着拖、Esc 关闭。
 *
 * 面板分四块（镜头 / 姿势 / 场景 / 道具），中间是 three 视图，底部是出图。
 * 所有数值都直接改 state，three 那边靠 effect 同步 —— 面板自己不碰 three。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Camera, Cylinder, Download, Eye, EyeOff, Loader2, PersonStanding, Redo2, RotateCcw, Sparkles, Trash2, Undo2, Upload, X } from 'lucide-react'
import {
  DEFAULT_JOINT_HANDLE_SCALE,
  DirectorStageThree,
  MAX_JOINT_HANDLE_SCALE,
  MIN_JOINT_HANDLE_SCALE,
  clampJointHandleScale,
  type DirectorStageThreeHandle,
  type PropTool,
  type StageTool,
} from './DirectorStageThree'
import {
  FOCAL_PRESETS_MM,
  MAX_FOCAL_MM,
  MIN_FOCAL_MM,
  captureSize,
  focalToFovDeg,
  horizontalFovDeg,
} from './cameraMath'
import {
  DIRECTOR_JOINTS,
  FINGER_JOINT_IDS,
  FINGER_NAMES,
  JOINT_BY_ID,
  isFingerJoint,
  jointAxes,
  poseAngles,
  type JointId,
  type Pose,
  type Side,
} from './skeleton'
import {
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
  undoStage,
  type StageHistory,
  type StageHistoryStep,
} from './stageHistory'
import {
  FINGER_CURL_MAX,
  FINGER_CURL_MIN,
  FINGER_DISPLAY_NAMES,
  HAND_PRESETS,
  applyHandPreset,
  applyHandSnapshot,
  clearHand,
  fingerSpreadRange,
  handPoseCount,
  readFingerCurl,
  readFingerSpread,
  setFingerCurl,
  setFingerSpread,
  snapshotHand,
  type HandPresetFingers,
} from './handPose'
import {
  DEFAULT_DIRECTOR_STAGE_STATE,
  DIRECTOR_RATIO_OPTIONS,
  DIRECTOR_RESOLUTION_OPTIONS,
  MAX_STAGE_PROPS,
  RESOLUTION_SHORT_EDGE,
  makeStageProp,
  normalizeDirectorStageState,
  type DirectorStageState,
  type PropKind,
  type StageProp,
} from './types'
import { assetsApi } from '@/lib/api'
import { errorToText } from '@/lib/display'
import './director-stage.css'

export interface DirectorStageRenderPayload {
  blob: Blob
  width: number
  height: number
  state: DirectorStageState
}

interface Props {
  initialState: DirectorStageState
  projectUuid: string
  nodeName?: string
  /** 连进来的参考图（用来分析姿势）。没连时传 undefined 或 url 为空。 */
  reference?: { url: string; name: string; missing: boolean }
  busy?: boolean
  onCancel: () => void
  /** 出图：把 PNG 和当次状态交回节点，由节点负责上传和写回 */
  onRender: (payload: DirectorStageRenderPayload) => void | Promise<void>
}

/**
 * 首次分析要下的大致体积（WASM 11.8MB + 模型 9MB）。
 *
 * 刻意在这里写一份常量、不从 `poseEstimator` 静态 import：那个模块是要被代码分割出去的，
 * 静态引用它会把它拽回主包（主包已经 3.9MB，是已知的加载瓶颈）。
 * 改模型体积时记得同步 `poseEstimator.ts` 的 `POSE_FIRST_LOAD_MB`，测试有对账。
 */
const POSE_FIRST_LOAD_MB = 21
/** 勾了「连手指一起推」再多下的体积（手部模型 7.5MB；WASM 和姿势模型共用，不重复下）。 */
const HAND_FIRST_LOAD_MB = 8

type PanelTab = 'camera' | 'pose' | 'scene' | 'props'

const TABS: Array<{ key: PanelTab; label: string; icon: React.ReactNode }> = [
  { key: 'camera', label: '镜头', icon: <Camera size={14} /> },
  { key: 'pose', label: '姿势', icon: <PersonStanding size={14} /> },
  { key: 'scene', label: '场景', icon: <Sparkles size={14} /> },
  { key: 'props', label: '道具', icon: <Box size={14} /> },
]

const TOOL_LABELS: Array<{ key: StageTool; label: string; hint: string }> = [
  { key: 'slider', label: '滑杆', hint: '点关节，右侧拉数值 —— 最精确' },
  { key: 'rotate', label: '旋转手柄', hint: '按 E。点关节，拖彩色环绕单轴转，拖外圈自由转' },
  { key: 'ik', label: '拖手脚', hint: '按 W。拖绿色的手腕 / 脚踝，手臂自动跟着算' },
  { key: 'finger', label: '手指', hint: '按 R。点蓝色指节，拖指尖整根跟着弯' },
]

const PROP_TOOL_LABELS: Array<{ key: PropTool; label: string }> = [
  { key: 'translate', label: '移动' },
  { key: 'rotate', label: '旋转' },
  { key: 'scale', label: '缩放' },
]

/** 关节树的显示顺序：躯干、左臂、右臂、左腿、右腿。按 DIRECTOR_JOINTS 的顺序天然就是这个。 */
const JOINT_GROUPS: Array<{ label: string; ids: JointId[] }> = [
  { label: '躯干 / 头', ids: ['hips', 'spine', 'chest', 'neck', 'head'] },
  { label: '左臂', ids: ['shoulderL', 'upperArmL', 'elbowL', 'wristL'] },
  { label: '右臂', ids: ['shoulderR', 'upperArmR', 'elbowR', 'wristR'] },
  { label: '左腿', ids: ['thighL', 'kneeL', 'ankleL'] },
  { label: '右腿', ids: ['thighR', 'kneeR', 'ankleR'] },
]

function Row({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <label className="director-stage-row">
      <span className="director-stage-row-label">
        {label}
        {value !== undefined && <em>{value}</em>}
      </span>
      {children}
    </label>
  )
}

export function DirectorStageModal({ initialState, projectUuid, nodeName, reference, busy = false, onCancel, onRender }: Props) {
  const [state, setState] = useState<DirectorStageState>(() => normalizeDirectorStageState(initialState))
  const [tab, setTab] = useState<PanelTab>('camera')
  const [tool, setTool] = useState<StageTool>('slider')
  const [propTool, setPropTool] = useState<PropTool>('translate')
  const [selectedJoint, setSelectedJoint] = useState<JointId | null>(null)
  const [selectedPropId, setSelectedPropId] = useState<string | null>(null)
  const [showJointHandles, setShowJointHandles] = useState(true)
  const [jointHandleScale, setJointHandleScale] = useState(DEFAULT_JOINT_HANDLE_SCALE)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState('')
  const [modelUploading, setModelUploading] = useState(false)
  const [modelProgress, setModelProgress] = useState(0)
  const [modelImportPhase, setModelImportPhase] = useState<'uploading' | 'converting'>('uploading')
  const [modelToSave, setModelToSave] = useState<DirectorStageState['models'][number] | null>(null)
  const viewRef = useRef<DirectorStageThreeHandle>(null)

  // ── 从参考图分析姿势 ──────────────────────────────────────────────────────
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeNote, setAnalyzeNote] = useState('')
  const [analyzeError, setAnalyzeError] = useState('')
  /** 分析前那一版姿势，留着给「撤销分析」——手调半天被一键覆盖会很恼人。 */
  const [poseBeforeAnalyze, setPoseBeforeAnalyze] = useState<Pose | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !rendering && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel, rendering])

  // ── 撤销 / 重做 ────────────────────────────────────────────────────────────
  /**
   * 状态的镜像。历史栈要的是「改动之前」那一份，而 React 的 state 是异步的，
   * 在事件回调里读到的可能已经是旧值。
   */
  const stateRef = useRef(state)
  stateRef.current = state
  const historyRef = useRef<StageHistory>(emptyStageHistory())
  /** 只为了让上面那两个按钮的 disabled 跟着变 —— 历史本身在 ref 里。 */
  const [historyTick, setHistoryTick] = useState(0)

  /**
   * **所有**状态改动的唯一入口，顺手记一步历史。
   *
   * `gesture` 相同且连续的改动只记一条（拖一次滑杆不该变成六十条，见 stageHistory）。
   * 离散操作（预设、分析、重置、加删道具）传 null，各记一条。
   */
  const commit = useCallback((
    update: (current: DirectorStageState) => DirectorStageState,
    gesture: string | null,
  ) => {
    const previous = stateRef.current
    const next = normalizeDirectorStageState(update(previous))
    historyRef.current = commitStageHistory(historyRef.current, previous, next, gesture)
    stateRef.current = next
    setState(next)
    setHistoryTick((value) => value + 1)
  }, [])

  const applyHistoryStep = useCallback((step: StageHistoryStep | null) => {
    if (!step) return
    historyRef.current = step.history
    stateRef.current = step.state
    setState(step.state)
    // 撤销可能把选中的道具撤掉了 —— 别让旋转手柄挂在一个不存在的道具上
    setSelectedPropId((current) => (step.state.props.some((item) => item.id === current) ? current : null))
    setHistoryTick((value) => value + 1)
  }, [])

  const doUndo = useCallback(() => {
    applyHistoryStep(undoStage(historyRef.current, stateRef.current))
  }, [applyHistoryStep])

  const doRedo = useCallback(() => {
    applyHistoryStep(redoStage(historyRef.current, stateRef.current))
  }, [applyHistoryStep])

  // 历史在 ref 里（连续拖动时不该每帧重渲染），所以按钮的 disabled 靠 historyTick 触发重算
  const canUndo = useMemo(() => canUndoStage(historyRef.current), [historyTick])
  const canRedo = useMemo(() => canRedoStage(historyRef.current), [historyTick])

  /**
   * 快捷键。**capture 阶段**注册，和灯光台 / 抠像一致 ——
   * 画布在 window 上挂了个冒泡阶段的 Ctrl+Z，不在这里拦住，按 Z 撤销的会是画布上的节点
   * （用户 2026-08-26 就是这么把整个三维空间节点撤销掉的）。
   *
   * 关键：**即使历史栈是空的也要拦**。没得撤 ≠ 该让画布去撤。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEditingTarget(event.target)) return
      const hotkey = readHistoryHotkey(event)
      if (hotkey) {
        event.preventDefault()
        event.stopPropagation()
        if (hotkey === 'undo') doUndo()
        else doRedo()
        return
      }
      const toolHotkey = readStageToolHotkey(event)
      if (toolHotkey) {
        event.preventDefault()
        event.stopPropagation()
        setTool(toolHotkey)
        // 道具的平移 gizmo 和关节的旋转 / IK 不能同时挂在 TransformControls 上，
        // 切姿势工具时把道具选中清掉，否则按 W 之后绿色关节还会带着 XYZ 平移轴。
        setSelectedPropId(null)
        setTab('pose')
        return
      }
      // 画布还听着 Ctrl+C / Ctrl+V（复制粘贴节点）和裸的 f（对焦视野），
      // 全屏编辑器开着的时候这几个都不该生效。只拦冒泡，浏览器自己的复制照旧。
      if (isCanvasHotkeyToSwallow(event)) {
        const key = event.key.toLowerCase()
        if (key === 'c' && (window.getSelection()?.toString() ?? '').length > 0) return
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [doRedo, doUndo])

  /** 松手 / 抬键 = 这次拖动结束，下一次改动新起一条历史。 */
  useEffect(() => {
    const endGesture = () => { historyRef.current = endStageGesture(historyRef.current) }
    window.addEventListener('pointerup', endGesture, true)
    window.addEventListener('pointercancel', endGesture, true)
    window.addEventListener('keyup', endGesture, true)
    return () => {
      window.removeEventListener('pointerup', endGesture, true)
      window.removeEventListener('pointercancel', endGesture, true)
      window.removeEventListener('keyup', endGesture, true)
    }
  }, [])

  const patchCamera = useCallback((patch: Partial<DirectorStageState['camera']>) => {
    const keys = Object.keys(patch).sort()
    // 轨道（转 / 平移 / 滚轮）不进撤销；焦距滑杆仍要能撤，所以 gesture 按是不是
    // 只动机位来分。commitStageHistory 里还会再挡一层只改轨道的提交。
    const orbitKeys = keys.filter((key) => key !== 'focalMm')
    const gesture = orbitKeys.length > 0 ? 'camera:orbit' : `camera:${keys.join(',')}`
    commit(
      (current) => ({ ...current, camera: { ...current.camera, ...patch } }),
      gesture,
    )
  }, [commit])

  /** `gesture` 默认按「3D 里拖出来的姿势」算；离散调用要显式传 null。 */
  const setPose = useCallback((pose: Pose, gesture: string | null = 'pose3d') => {
    commit((current) => ({ ...current, pose }), gesture)
  }, [commit])

  const patchScene = useCallback((patch: Partial<DirectorStageState['scene']>) => {
    commit(
      (current) => ({ ...current, scene: { ...current.scene, ...patch } }),
      `scene:${Object.keys(patch).sort().join(',')}`,
    )
  }, [commit])

  const setJointAxis = useCallback((jointId: JointId, index: number, value: number) => {
    commit((current) => {
      const angles = [...poseAngles(current.pose, jointId)] as [number, number, number]
      angles[index] = value
      return { ...current, pose: { ...current.pose, [jointId]: angles } }
    }, `joint:${jointId}:${index}`)
  }, [commit])

  const addProp = useCallback((kind: PropKind) => {
    if (stateRef.current.props.length >= MAX_STAGE_PROPS) return
    const prop = makeStageProp(stateRef.current.props, kind)
    commit((current) => ({ ...current, props: [...current.props, prop] }), null)
    setSelectedPropId(prop.id)
    setSelectedJoint(null)
    setTab('props')
  }, [commit])

  const updateProp = useCallback((prop: StageProp) => {
    commit(
      (current) => ({ ...current, props: current.props.map((item) => (item.id === prop.id ? prop : item)) }),
      `prop:${prop.id}`,
    )
  }, [commit])

  const removeProp = useCallback((propId: string) => {
    commit((current) => ({ ...current, props: current.props.filter((item) => item.id !== propId) }), null)
    setSelectedPropId((current) => (current === propId ? null : current))
  }, [commit])

  const importMaxModel = useCallback(async (file: File) => {
    if (!/\.max$/i.test(file.name)) { setError('请选择 .max 文件'); return }
    setModelUploading(true)
    setModelProgress(0)
    setModelImportPhase('uploading')
    setError('')
    try {
      const result = await assetsApi.importMaxModel(projectUuid, file, (progress) => {
        const uploadPercent = Math.max(0, Math.min(100, Math.round(progress)))
        setModelProgress(uploadPercent)
        if (uploadPercent >= 100) setModelImportPhase('converting')
      })
      const model = result.model
      commit((current) => ({
        ...current,
          models: [...current.models, {
          id: 'model-' + Date.now(), name: model.name || file.name, sourceUrl: model.url,
          format: 'fbx' as const, position: [current.models.length * 0.35, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        }],
      }), null)
    } catch (err) {
      setError(errorToText(err, '3ds Max 模型导入失败'))
    } finally { setModelUploading(false) }
  }, [commit, projectUuid])

  const resetView = useCallback(() => {
    patchCamera(DEFAULT_DIRECTOR_STAGE_STATE.camera)
  }, [patchCamera])

  const resetPose = useCallback(() => {
    setPose({}, null)
  }, [setPose])

  /** 手指面板一次只管一只手 —— 两只手 10 根滑杆同时摊开就没法看了。 */
  const [handSide, setHandSide] = useState<Side>('L')

  /** 默认连手指一起推。模型仍按需下载；全身照检不到会写明哪只手失败，不再静默当成功。 */
  const [analyzeHands, setAnalyzeHands] = useState(true)
  const [customHandPresets, setCustomHandPresets] = useState<Array<{ key: string; label: string; fingers: HandPresetFingers }>>([])

  /**
   * 从参考图分析姿势。
   *
   * 首次点击要下约 21MB（WASM + 模型），勾了手指再多约 8MB，所以必须有明确的等待态 ——
   * 只把按钮置灰会让人以为卡住了。分析前把当前姿势存起来，给一步「撤销分析」。
   */
  const analyzeReference = useCallback(async () => {
    if (analyzing || !reference?.url) return
    setAnalyzeError('')
    setAnalyzeNote('')
    setAnalyzing(true)
    try {
      // 动态引入：这一坨带着 MediaPipe 的 WASM，绝不能进主包（主包已经 3.9MB）
      const { estimatePoseFromImage, estimateHandsFromImage } = await import('./poseEstimator')
      const { poseFromLandmarks } = await import('./poseFromLandmarks')
      const detection = await estimatePoseFromImage(reference.url)
      let { pose: nextPose, applied, skipped } = poseFromLandmarks(detection.landmarks)
      if (applied.length === 0) {
        setAnalyzeError('识别到人物但关键点都不可用，换一张人物更完整的图试试')
        return
      }

      /*
       * 手指必须在身体之后解：指骨的目标方向是用**手腕当前的世界朝向**换算出来的
       * （见 handFromLandmarks 的换基说明），手腕还没摆好就解手指，手指会整只手转过去。
       */
      const handNotes: string[] = []
      if (analyzeHands) {
        const { handFromLandmarks } = await import('./handFromLandmarks')
        const hands = await estimateHandsFromImage(detection.image, detection.imageLandmarks)
        for (const side of ['L', 'R'] as const) {
          const label = side === 'L' ? '左' : '右'
          const hand = hands[side]
          if (!hand) {
            handNotes.push(`${label}手没看清`)
            continue
          }
          const result = handFromLandmarks(nextPose, side, hand)
          nextPose = result.pose
          applied = [...applied, ...result.applied]
          skipped = [...skipped, ...result.skipped]
          handNotes.push(result.applied.length > 0
            ? `${label}手摆好 ${result.applied.length} 节`
            : `${label}手检到了但指节对不上`)
        }
      }

      setPoseBeforeAnalyze(state.pose)
      setPose(nextPose, null)
      setTool(analyzeHands ? 'finger' : 'slider')
      setSelectedJoint(null)
      setAnalyzeNote([
        skipped.length > 0
          ? `摆好 ${applied.length} 处关节；有 ${skipped.length} 处在图里看不清，留在原位了`
          : `摆好 ${applied.length} 处关节`,
        ...handNotes,
      ].join('；'))
    } catch (err) {
      const kind = (err as { kind?: string })?.kind
      const message = err instanceof Error ? err.message : String(err)
      setAnalyzeError(
        kind === 'load-failed'
          ? `${message}。刷新页面重试；一直不行就是模型文件没部署好，告诉维护同学。`
          : message,
      )
    } finally {
      setAnalyzing(false)
    }
  }, [analyzeHands, analyzing, reference?.url, setPose, state.pose])

  const undoAnalyze = useCallback(() => {
    if (!poseBeforeAnalyze) return
    setPose(poseBeforeAnalyze, null)
    setPoseBeforeAnalyze(null)
    setAnalyzeNote('')
  }, [poseBeforeAnalyze, setPose])

  const size = useMemo(
    () => captureSize(state.ratio, RESOLUTION_SHORT_EDGE[state.resolution] ?? 1536),
    [state.ratio, state.resolution],
  )

  const handleRender = useCallback(async () => {
    if (rendering || busy) return
    setError('')
    setRendering(true)
    try {
      const result = await viewRef.current?.capture({ width: size.width, height: size.height })
      if (!result) throw new Error('三维空间还没准备好')
      await onRender({ ...result, state })
    } catch (err) {
      setError(err instanceof Error ? err.message : '出图失败')
    } finally {
      setRendering(false)
    }
  }, [busy, onRender, rendering, size.height, size.width, state])

  const selectedProp = state.props.find((prop) => prop.id === selectedPropId) ?? null
  const poseCount = Object.keys(state.pose).length
  // 关节树那一块的计数要排掉指骨 —— 不排的话点一下手势预设，「已调」会莫名跳 15
  const bodyPoseCount = Object.keys(state.pose).filter((id) => !isFingerJoint(id as JointId)).length
  const handCount = handPoseCount(state.pose, handSide)
  const activeJoint = selectedJoint ?? null

  return createPortal(
    <div className="director-stage-backdrop nodrag" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !rendering && !busy) onCancel()
    }}>
      <div className="director-stage-shell nodrag" onMouseDown={(event) => event.stopPropagation()}>
        <header className="director-stage-header">
          <div className="director-stage-title">
            <span className="director-stage-title-icon"><PersonStanding size={17} /></span>
            <div>
              <strong>三维空间</strong>
              <small>{nodeName ? `${nodeName} · ` : ''}摆机位 + 调白模姿势，出图当构图参考</small>
            </div>
          </div>
          {/*
            撤销 / 重做。快捷键是主路（用户就是按 Ctrl+Z 才发现问题的），
            但键盘操作没有可发现性，所以摆两个按钮出来，顺便让人知道这里**有**历史。
          */}
          <div className="director-stage-history">
            <button type="button" onClick={doUndo} disabled={!canUndo} title="撤销（Ctrl+Z）" aria-label="撤销">
              <Undo2 size={15} />
            </button>
            <button type="button" onClick={doRedo} disabled={!canRedo} title="重做（Ctrl+Shift+Z）" aria-label="重做">
              <Redo2 size={15} />
            </button>
          </div>
          <button type="button" className="director-stage-close" onClick={onCancel} disabled={rendering || busy} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="director-stage-body">
          <div className="director-stage-view">
            <DirectorStageThree
              ref={viewRef}
              state={state}
              tool={tool}
              propTool={propTool}
              selectedJoint={selectedJoint}
              selectedPropId={selectedPropId}
              onSelectJoint={(jointId) => {
                setSelectedJoint(jointId)
                if (jointId) {
                  setTab('pose')
                  if (isFingerJoint(jointId)) setHandSide(jointId.endsWith('R') ? 'R' : 'L')
                }
              }}
              onSelectProp={(propId) => { setSelectedPropId(propId); if (propId) setTab('props') }}
              onPoseChange={(pose) => setPose(pose, 'pose3d')}
              onPropChange={updateProp}
              onCameraChange={(camera) => patchCamera(camera)}
              showJointHandles={showJointHandles}
              jointHandleScale={jointHandleScale}
              /* patchCamera 自己会把轨道改动并成 camera:orbit，焦距滑杆另走 focalMm */
            />
            <div className="director-stage-viewhint">
              左键拖转视角 · 滚轮推拉 · 右键拖平移 ·{' '}
              {tool === 'ik'
                ? '拖绿色手腕 / 脚踝解算手臂'
                : tool === 'finger'
                  ? '拖蓝色指节，指尖带着整根弯'
                  : '点身上的小球选关节'}
            </div>
            <div className="director-stage-viewmeta">
              <span>
                {state.camera.focalMm.toFixed(0)}mm · 垂直 {focalToFovDeg(state.camera.focalMm).toFixed(1)}° ·
                {' '}水平 {horizontalFovDeg(state.camera.focalMm, size.aspect).toFixed(1)}°
              </span>
              <button
                type="button"
                className="director-stage-handle-toggle"
                onClick={() => setShowJointHandles((value) => !value)}
                title={showJointHandles ? '隐藏关节控制' : '显示关节控制'}
                aria-pressed={!showJointHandles}
                aria-label={showJointHandles ? '隐藏关节控制' : '显示关节控制'}
              >
                {showJointHandles ? <EyeOff size={13} /> : <Eye size={13} />}
                {showJointHandles ? '隐藏关节' : '显示关节'}
              </button>
              <label className="director-stage-handle-scale">
                <span>关节大小 {jointHandleScale.toFixed(1)}</span>
                <input
                  type="range"
                  min={MIN_JOINT_HANDLE_SCALE}
                  max={MAX_JOINT_HANDLE_SCALE}
                  step={0.1}
                  value={jointHandleScale}
                  onChange={(event) => setJointHandleScale(clampJointHandleScale(event.target.value))}
                  aria-label="关节大小"
                />
              </label>
            </div>
          </div>

          <aside className="director-stage-panel">
            <nav className="director-stage-tabs">
              {TABS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={tab === item.key ? 'is-active' : ''}
                  onClick={() => setTab(item.key)}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </nav>

            <div className="director-stage-panel-body">
              {tab === 'camera' && (
                <>
                  <div className="director-stage-section-title">焦距</div>
                  <div className="director-stage-chips">
                    {FOCAL_PRESETS_MM.map((focal) => (
                      <button
                        key={focal}
                        type="button"
                        className={Math.round(state.camera.focalMm) === focal ? 'is-active' : ''}
                        onClick={() => patchCamera({ focalMm: focal })}
                      >
                        {focal}mm
                      </button>
                    ))}
                  </div>
                  <Row label="焦距" value={`${state.camera.focalMm.toFixed(0)}mm`}>
                    <input
                      type="range" min={MIN_FOCAL_MM} max={MAX_FOCAL_MM} step={1}
                      value={state.camera.focalMm}
                      onChange={(event) => patchCamera({ focalMm: Number(event.target.value) })}
                    />
                  </Row>

                  <div className="director-stage-section-title">机位</div>
                  <Row label="水平环绕" value={`${state.camera.yaw.toFixed(0)}°`}>
                    <input
                      type="range" min={0} max={360} step={1}
                      value={state.camera.yaw}
                      onChange={(event) => patchCamera({ yaw: Number(event.target.value) })}
                    />
                  </Row>
                  <Row label="俯仰" value={`${state.camera.pitch.toFixed(0)}°`}>
                    <input
                      type="range" min={-89} max={89} step={1}
                      value={state.camera.pitch}
                      onChange={(event) => patchCamera({ pitch: Number(event.target.value) })}
                    />
                  </Row>
                  <Row label="距离" value={`${state.camera.distance.toFixed(2)}m`}>
                    <input
                      type="range" min={0.4} max={20} step={0.05}
                      value={state.camera.distance}
                      onChange={(event) => patchCamera({ distance: Number(event.target.value) })}
                    />
                  </Row>
                  <Row label="看向高度" value={`${state.camera.target[1].toFixed(2)}m`}>
                    <input
                      type="range" min={0} max={2} step={0.01}
                      value={state.camera.target[1]}
                      onChange={(event) => patchCamera({
                        target: [state.camera.target[0], Number(event.target.value), state.camera.target[2]],
                      })}
                    />
                  </Row>
                  <button type="button" className="director-stage-ghost" onClick={resetView}>
                    <RotateCcw size={13} /> 重置视角
                  </button>
                </>
              )}

              {tab === 'pose' && (
                <>
                  {/* 参考图分析。放在最上面：有参考图时这是最省事的起手式。 */}
                  <div className="director-stage-section-title">参考图</div>
                  {!reference?.url ? (
                    <p className="director-stage-hint">
                      从画布上拉一张图片节点连到这个三维空间节点，就能一键把图里人物的姿势套到白模上。
                    </p>
                  ) : (
                    <div className="director-stage-reference">
                      <img src={reference.url} alt={reference.name} draggable={false} />
                      <div className="director-stage-reference-body">
                        <strong title={reference.name}>{reference.name}</strong>
                        {reference.missing && <em>上游节点已删除，用的是最后一次的快照</em>}
                        <button
                          type="button"
                          className="director-stage-primary is-compact"
                          onClick={analyzeReference}
                          disabled={analyzing}
                        >
                          {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                          {analyzing ? '正在分析…' : '分析参考图姿势'}
                        </button>
                        {poseBeforeAnalyze && !analyzing && (
                          <button type="button" className="director-stage-ghost is-compact" onClick={undoAnalyze}>
                            <RotateCcw size={12} />撤销分析
                          </button>
                        )}
                        <label className="director-stage-check">
                          <input
                            type="checkbox"
                            checked={analyzeHands}
                            disabled={analyzing}
                            onChange={(event) => setAnalyzeHands(event.target.checked)}
                          />
                          连手指一起推（首次多下约 {HAND_FIRST_LOAD_MB}MB，之后浏览器缓存）
                        </label>
                      </div>
                    </div>
                  )}
                  {analyzing && (
                    <p className="director-stage-hint">
                      第一次用要下约 {analyzeHands ? POSE_FIRST_LOAD_MB + HAND_FIRST_LOAD_MB : POSE_FIRST_LOAD_MB}MB
                      的识别模型（之后浏览器会缓存），请稍等。
                    </p>
                  )}
                  {analyzeNote && <p className="director-stage-note">{analyzeNote}</p>}
                  {analyzeError && <p className="director-stage-warn">{analyzeError}</p>}
                  {reference?.url && !analyzing && !analyzeError && (
                    <p className="director-stage-hint">
                      单图能推出的深度是有限的 —— 大动作能对上，胳膊绕自身轴的旋转、手腕朝向这类
                      容易偏。<strong>当成起点</strong>，再用下面的滑杆和手柄微调。机位不会被改动。
                    </p>
                  )}

                  <div className="director-stage-section-title">怎么调</div>
                  <div className="director-stage-chips is-block">
                    {TOOL_LABELS.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={tool === item.key ? 'is-active' : ''}
                        title={item.hint}
                        onClick={() => {
                          setTool(item.key)
                          if (item.key !== 'slider') setSelectedPropId(null)
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <p className="director-stage-hint">{TOOL_LABELS.find((item) => item.key === tool)?.hint}</p>

                  <div className="director-stage-section-title">关节{bodyPoseCount > 0 && <em>已调 {bodyPoseCount} 处</em>}</div>
                  <div className="director-stage-joints">
                    {JOINT_GROUPS.map((group) => (
                      <div key={group.label} className="director-stage-joint-group">
                        <span>{group.label}</span>
                        <div>
                          {group.ids.map((id) => (
                            <button
                              key={id}
                              type="button"
                              className={[
                                activeJoint === id ? 'is-active' : '',
                                state.pose[id] ? 'is-posed' : '',
                              ].filter(Boolean).join(' ')}
                              onClick={() => { setSelectedJoint(id); setSelectedPropId(null) }}
                            >
                              {JOINT_BY_ID[id].label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {activeJoint ? (
                    <>
                      <div className="director-stage-section-title">{JOINT_BY_ID[activeJoint].label}</div>
                      {jointAxes(activeJoint).map(({ axis, index, def }) => (
                        <Row
                          key={axis}
                          label={def.label}
                          value={`${poseAngles(state.pose, activeJoint)[index].toFixed(0)}°`}
                        >
                          <input
                            type="range" min={def.min} max={def.max} step={1}
                            value={poseAngles(state.pose, activeJoint)[index]}
                            onChange={(event) => setJointAxis(activeJoint, index, Number(event.target.value))}
                          />
                        </Row>
                      ))}
                    </>
                  ) : (
                    <p className="director-stage-hint">在 3D 里点身上的小球，或者点上面的关节名。</p>
                  )}

                  {/*
                    手指单开一块，不进上面那棵关节树 —— 30 根指骨摊进去会让关节树从 19 行变 49 行。
                    3D 里默认不出身体那套大球；「手指」工具会另出小号蓝球，点到哪根侧栏就切到哪只手。
                  */}
                  <div className="director-stage-section-title">
                    手指{handCount > 0 && <em>已调 {handCount} 处</em>}
                  </div>
                  <div className="director-stage-hand-side">
                    {(['L', 'R'] as const).map((side) => (
                      <button
                        key={side}
                        type="button"
                        className={handSide === side ? 'is-active' : ''}
                        onClick={() => setHandSide(side)}
                      >
                        {side === 'L' ? '左手' : '右手'}
                        {handPoseCount(state.pose, side) > 0 && <i />}
                      </button>
                    ))}
                  </div>
                  <div className="director-stage-hand-presets">
                    {HAND_PRESETS.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() => setPose(applyHandPreset(state.pose, handSide, preset.key), null)}
                      >
                        {preset.label}
                      </button>
                    ))}
                    {customHandPresets.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() => setPose(applyHandSnapshot(state.pose, handSide, preset.fingers), null)}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const next = {
                          key: `custom-${Date.now()}`,
                          label: `当前${handSide === 'L' ? '左' : '右'}手`,
                          fingers: snapshotHand(state.pose, handSide),
                        }
                        setCustomHandPresets((current) => [...current.slice(-7), next])
                      }}
                    >
                      存当前手
                    </button>
                  </div>
                  {FINGER_NAMES.map((name) => {
                    const ids = FINGER_JOINT_IDS[handSide][name]
                    const spread = fingerSpreadRange(handSide, name)
                    const curl = readFingerCurl(state.pose, handSide, name)
                    const open = readFingerSpread(state.pose, handSide, name)
                    const twistDef = JOINT_BY_ID[ids[0]]?.axes?.turn
                    return (
                      <div
                        key={name}
                        className={[
                          'director-stage-finger-block',
                          ids.includes(selectedJoint as never) ? 'is-selected' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        <div className="director-stage-finger-row">
                          <span>{FINGER_DISPLAY_NAMES[name]}</span>
                          <label>
                            <em>整根 {curl}</em>
                            <input
                              type="range" min={FINGER_CURL_MIN} max={FINGER_CURL_MAX} step={1} value={curl}
                              onChange={(event) => setPose(setFingerCurl(state.pose, handSide, name, Number(event.target.value)), `finger:${handSide}:${name}:curl`)}
                            />
                          </label>
                          <label>
                            <em>张 {open}°</em>
                            <input
                              type="range" min={spread.min} max={spread.max} step={1} value={open}
                              onChange={(event) => setPose(setFingerSpread(state.pose, handSide, name, Number(event.target.value)), `finger:${handSide}:${name}:spread`)}
                            />
                          </label>
                        </div>
                        <div className="director-stage-finger-detail">
                          {ids.map((id, index) => {
                            const def = JOINT_BY_ID[id]?.axes?.tilt
                            if (!def) return null
                            const value = poseAngles(state.pose, id)[2]
                            return (
                              <label key={id}>
                                <em>{['近', '中', '远'][index]} {value.toFixed(0)}°</em>
                                <input
                                  type="range" min={def.min} max={def.max} step={1} value={value}
                                  onChange={(event) => setJointAxis(id, 2, Number(event.target.value))}
                                />
                              </label>
                            )
                          })}
                          {twistDef && (
                            <label>
                              <em>对掌 {poseAngles(state.pose, ids[0])[1].toFixed(0)}°</em>
                              <input
                                type="range" min={twistDef.min} max={twistDef.max} step={1}
                                value={poseAngles(state.pose, ids[0])[1]}
                                onChange={(event) => setJointAxis(ids[0], 1, Number(event.target.value))}
                              />
                            </label>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  <p className="director-stage-hint">
                    上面那根「整根」一次卷三个指节；下面三根是近 / 中 / 远。3D 里按 R 切「手指」，拖蓝色指尖。
                  </p>
                  <button
                    type="button"
                    className="director-stage-ghost"
                    onClick={() => setPose(clearHand(state.pose, handSide), null)}
                    disabled={handCount === 0}
                  >
                    <RotateCcw size={13} /> 重置{handSide === 'L' ? '左' : '右'}手
                  </button>

                  <button type="button" className="director-stage-ghost" onClick={resetPose} disabled={poseCount === 0}>
                    <RotateCcw size={13} /> 重置姿势
                  </button>
                </>
              )}

              {tab === 'scene' && (
                <>
                  <div className="director-stage-section-title">地面与背景</div>
                  <label className="director-stage-check">
                    <input type="checkbox" checked={state.scene.groundVisible}
                      onChange={(event) => patchScene({ groundVisible: event.target.checked })} />
                    显示地面
                  </label>
                  <label className="director-stage-check">
                    <input type="checkbox" checked={state.scene.gridVisible}
                      onChange={(event) => patchScene({ gridVisible: event.target.checked })} />
                    显示网格
                  </label>
                  <label className="director-stage-check">
                    <input type="checkbox" checked={state.scene.backdropVisible}
                      onChange={(event) => patchScene({ backdropVisible: event.target.checked })} />
                    显示背景板
                  </label>
                  <p className="director-stage-hint">
                    关掉背景板出的是<strong>透明底 PNG</strong> —— 当参考图时更好抠。
                  </p>
                  <Row label="地面颜色">
                    <input type="color" value={state.scene.groundColor}
                      onChange={(event) => patchScene({ groundColor: event.target.value })} />
                  </Row>
                  <Row label="背景颜色">
                    <input type="color" value={state.scene.backdropColor}
                      onChange={(event) => patchScene({ backdropColor: event.target.value })} />
                  </Row>
                </>
              )}

              {tab === 'props' && (
                <>
                  <div className="director-stage-section-title">加道具</div>
                  <div className="director-stage-chips">
                    <button type="button" onClick={() => addProp('box')} disabled={state.props.length >= MAX_STAGE_PROPS}>
                      <Box size={13} /> 长方体
                    </button>
                    <button type="button" onClick={() => addProp('cylinder')} disabled={state.props.length >= MAX_STAGE_PROPS}>
                      <Cylinder size={13} /> 圆柱
                    </button>
                  </div>
                  <p className="director-stage-hint">摆桌子、门框、箱子、柱子 —— 给构图一个空间关系。</p>

                  <label className="director-stage-ghost" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: modelUploading ? 'default' : 'pointer' }}>
                    {modelUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    {modelUploading
                      ? modelImportPhase === 'uploading'
                        ? <>上传中 {modelProgress}%</>
                        : '已上传，3ds Max 转换中…'
                      : '导入 3ds Max (.max)'}
                    <input className="nodrag" type="file" accept=".max,application/vnd.autodesk.max" disabled={modelUploading} style={{ display: 'none' }}
                      onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importMaxModel(file) }} />
                  </label>
                  {modelUploading && modelImportPhase === 'converting' && (
                    <p className="director-stage-hint" data-max-conversion-hint>
                      正在读取场景并导出 FBX，通常需要 30–90 秒，请勿重复导入或关闭页面。
                    </p>
                  )}
                  {state.models.length > 0 && (
                    <div className="director-stage-proplist">
                      {state.models.map((model) => (
                        <div key={model.id}>
                          <button type="button" disabled>{model.name} · FBX</button>
                          <button type="button" className="is-save" onClick={() => setModelToSave(model)} aria-label="保存 FBX 文件"><Download size={13} /></button>
                          <button type="button" className="is-remove" onClick={() => commit((current) => ({ ...current, models: current.models.filter((item) => item.id !== model.id) }), null)} aria-label="删除模型"><Trash2 size={13} /></button>
                        </div>
                      ))}
                    </div>
                  )}

                  {state.props.length > 0 && (
                    <>
                      <div className="director-stage-section-title">
                        已有 {state.props.length} / {MAX_STAGE_PROPS}
                      </div>
                      <div className="director-stage-proplist">
                        {state.props.map((prop) => (
                          <div key={prop.id} className={selectedPropId === prop.id ? 'is-active' : ''}>
                            <button type="button" onClick={() => { setSelectedPropId(prop.id); setSelectedJoint(null) }}>
                              {prop.kind === 'cylinder' ? '圆柱' : '长方体'} · {prop.id}
                            </button>
                            <button type="button" className="is-remove" onClick={() => removeProp(prop.id)} aria-label="删除">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {selectedProp && (
                    <>
                      <div className="director-stage-section-title">手柄</div>
                      <div className="director-stage-chips">
                        {PROP_TOOL_LABELS.map((item) => (
                          <button
                            key={item.key}
                            type="button"
                            className={propTool === item.key ? 'is-active' : ''}
                            onClick={() => setPropTool(item.key)}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                      <p className="director-stage-hint">选中的道具在 3D 里出手柄，直接拖。</p>
                    </>
                  )}
                </>
              )}
            </div>

            {modelToSave && (
              <div className="director-stage-save-backdrop" role="dialog" aria-modal="true" aria-label="保存 FBX">
                <div className="director-stage-save-dialog">
                  <div className="director-stage-save-title">保存导入的 FBX</div>
                  <p>将模型文件下载到本机，名称：<strong>{modelToSave.name}</strong></p>
                  <div className="director-stage-save-actions">
                    <button type="button" className="director-stage-ghost" onClick={() => setModelToSave(null)}>取消</button>
                    <a className="director-stage-primary is-compact" href={modelToSave.sourceUrl} download={modelToSave.name || 'model.fbx'} onClick={() => setModelToSave(null)}>
                      <Download size={14} /> 保存 FBX
                    </a>
                  </div>
                </div>
              </div>
            )}

            <footer className="director-stage-footer">
              <div className="director-stage-section-title">出图</div>
              <div className="director-stage-chips">
                {DIRECTOR_RATIO_OPTIONS.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    className={state.ratio === ratio ? 'is-active' : ''}
                    onClick={() => commit((current) => ({ ...current, ratio }), null)}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
              <div className="director-stage-chips">
                {DIRECTOR_RESOLUTION_OPTIONS.map((resolution) => (
                  <button
                    key={resolution}
                    type="button"
                    className={state.resolution === resolution ? 'is-active' : ''}
                    onClick={() => commit((current) => ({ ...current, resolution }), null)}
                  >
                    {resolution}
                  </button>
                ))}
              </div>
              <div className="director-stage-outsize">{size.width} × {size.height}</div>
              {error && <div className="director-stage-error">{error}</div>}
              <button
                type="button"
                className="director-stage-primary"
                onClick={handleRender}
                disabled={rendering || busy}
              >
                {(rendering || busy) && <Loader2 size={14} className="director-stage-spin" />}
                出图
              </button>
            </footer>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export { DIRECTOR_JOINTS }
