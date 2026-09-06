import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Loader2, Maximize2, Minimize2, Sparkles, X } from 'lucide-react'
import {
  textureClarityApi,
  type TextureClarityAssets,
  type TextureClarityServiceStatus,
} from '@/lib/api'
import {
  TEXTURE_CLARITY_CLASSES,
  TEXTURE_CLARITY_OUTPUT_POLICY,
  TEXTURE_CLARITY_REPAIR_TARGETS,
} from '@/lib/textureClarity'
import { describeServiceError, serviceErrorLine } from '@/lib/serviceErrors'
import type { TextureClarityNodeResult } from './resultMeta'
import './texture-clarity.css'

/**
 * 细化纹理编辑器（设计文档里这个功能叫「精准修复 · 人物真实化」，仓库叫 texture-clarity；
 * 界面上统一用「细化纹理」）。
 *
 * 三栏：左边控制素材、中间单图滑杆对比、右边执行参数。浮层和全屏是同一个组件、同一份
 * 状态 —— 只切一个 className，不做第二套状态（设计文档 §4 明确要求）。
 *
 * 这个弹窗**不准备任何素材**，打开即用（2026-08-21 用户反馈"弹窗里要等很长时间"）。
 * 准备控制素材要跑 4090 的语义分区和 MoGe-2 深度/法线，几十秒；原来挂在打开时同步等，
 * 人只能干瞪眼看着四个「准备中」。现在点「生成修复」当场建节点、当场关窗，准备和生成都在
 * 那个节点的后台跑，进度条按阶段报。
 *
 * 左栏的控制素材预览改成按需 —— 想看语义分区切在哪儿就点一下「加载预览」，看完再生成的话
 * 那份结果会被复用，不会重复推理一遍。
 *
 * 融合在服务端本地做，不产生第二次生图开销，所以门禁失败时不自动重试 —— 候选图和诊断都留在
 * 新节点上给人看。
 */

/** 生图模型选择。available 之外的按文档显示为禁用并说明原因，不隐藏。 */
const REPAIR_MODELS: {
  value: string
  label: string
  note?: string
  status: 'available' | 'planned'
}[] = [
  { value: 'gemini-3-pro-image', label: 'Nano Banana Pro', note: '推荐', status: 'available' },
  { value: 'gpt-image-2', label: 'Image 2.0', note: 'GPT image 2.0', status: 'available' },
  // 设计文档：拿到真实 modelType / modelFormat.version / 参考图与蒙版协议之前不得标为可用
  { value: 'mivo-flux-pro', label: 'Mivo Flux Pro', note: 'API 待接入', status: 'planned' },
]

type AssetSlotKey = 'source' | 'semantic' | 'depth' | 'normal'

interface Props {
  projectUuid: string
  nodeKey: string
  sourceUrl: string
  /**
   * 传了它就是**对比模式**：这个节点是一次细化纹理的结果，中栏比「原图 vs 结果」，
   * 右栏显示当时的生成记录和质量门禁，不出现模型选择和生成按钮。
   * 不传就是原来的生成模式。
   */
  result?: TextureClarityNodeResult | null
  onClose: () => void
  /**
   * 点「生成」时调用：由调用方立刻建一个「生成中」的图片节点，准备素材和修复都在那个节点
   * 的后台跑，然后这个弹窗就关掉。等待不在弹窗里发生。每点一次就多一个节点，不覆盖上一次。
   *
   * assets 只在用户主动加载过预览时才有值 —— 有就让任务复用，省掉重复的语义分区推理；
   * 没有就传 null，任务自己去准备。
   */
  onGenerate?: (assets: TextureClarityAssets | null, model: string) => void
}

/** 对比模式下右半边给谁看：融合结果，还是模型的原始候选。 */
type CompareTarget = 'fused' | 'candidate'

function statusLabel(status: string | undefined, reason: string | undefined, loading: boolean) {
  switch (status) {
    case 'cached': return '已复用 · 本地缓存'
    case 'generated': return '本次生成'
    // 格子只有一行的宽度，塞不下整句人话。服务没起来时给一个短标签，
    // 完整原因和原始报错挂在 title 上（下面那行 tc-hint 会写全）。
    case 'failed': return describeServiceError(reason).isServiceDown
      ? '失败：服务未运行'
      : `失败：${reason || '未知原因'}`
    case 'unavailable': return reason || '未配置'
    default: return loading ? '准备中' : ''
  }
}

function statusTone(status?: string) {
  if (status === 'cached' || status === 'generated') return 'ok'
  if (status === 'failed') return 'bad'
  return 'idle'
}

export function TextureClarityEditor({ projectUuid, nodeKey, sourceUrl, result, onClose, onGenerate }: Props) {
  const isResultMode = Boolean(result)
  const [expanded, setExpanded] = useState(false)
  /** 对比模式：右半边默认看融合结果；有候选图时可以切过去看融合前长什么样。 */
  const [compareTarget, setCompareTarget] = useState<CompareTarget>('fused')
  const [assets, setAssets] = useState<TextureClarityAssets | null>(null)
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [assetError, setAssetError] = useState('')
  const [model, setModel] = useState(REPAIR_MODELS[0].value)

  // 中栏比较：滑杆位置（0..1）+ 缩放
  const [split, setSplit] = useState(0.5)
  const [zoom, setZoom] = useState(1)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  /** 卸载后别再 setState —— 点了预览马上关窗是很正常的操作 */
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  /**
   * 依赖服务探活。只打 worker 的 /health，不做推理，正常几毫秒就回来。
   *
   * 关键：这是**乐观**的 —— 探活没回来之前生成按钮照常可点，探活自己失败也不禁用。
   * 只有明确拿到「语义分区不可用」才灰掉。绝不能因为多了这一次探测就把弹窗
   * 又变回「打开要等」的样子，那是这次改动要解决的问题本身。
   */
  const [serviceStatus, setServiceStatus] = useState<TextureClarityServiceStatus | null>(null)
  useEffect(() => {
    // 对比模式只是看已经生成好的东西，不依赖任何 worker，没必要去探
    if (isResultMode) return
    textureClarityApi
      .serviceStatus()
      .then((status) => { if (aliveRef.current) setServiceStatus(status) })
      .catch(() => { /* 探活挂了就当没探到，不影响使用 */ })
  }, [isResultMode])

  /** 只在明确知道语义分区不可用时才算 down；未知一律当可用。 */
  const semanticDown = serviceStatus ? !serviceStatus.semantic.ok : false

  /**
   * 按需加载控制素材预览。**故意不放在打开时自动跑**：这一步要等 4090 的语义分区和
   * MoGe-2 几何，几十秒，自动跑就等于把弹窗锁死几十秒（这就是用户反馈的那个问题）。
   * 想看切分结果才点；点过之后生成会复用这份结果，不会重复推理。
   */
  const loadAssetPreview = useCallback(() => {
    if (loadingAssets) return
    setLoadingAssets(true)
    setAssetError('')
    textureClarityApi
      .assets({ projectUuid, nodeKey, sourceUrl })
      .then((data) => { if (aliveRef.current) setAssets(data) })
      .catch((error) => {
        // 连接类报错翻成人话（原文留在后半截），别把 ETIMEDOUT 直接怼给用户
        if (aliveRef.current) setAssetError(serviceErrorLine(error))
      })
      .finally(() => { if (aliveRef.current) setLoadingAssets(false) })
  }, [loadingAssets, nodeKey, projectUuid, sourceUrl])

  const slots = useMemo(() => {
    const list: { key: AssetSlotKey; title: string; url?: string; status?: string; reason?: string }[] = [
      { key: 'source', title: '原图', url: assets?.source.url, status: assets?.source.status },
      {
        key: 'semantic',
        title: '语义分区',
        url: assets?.semantic.previewUrl,
        status: assets?.semantic.status,
        reason: assets?.semantic.reason,
      },
      {
        key: 'depth',
        title: 'Z-Depth · MoGe-2',
        url: assets?.geometry.depthUrl,
        status: assets?.geometry.status,
        reason: assets?.geometry.reason,
      },
      {
        key: 'normal',
        title: 'Normal · MoGe-2',
        url: assets?.geometry.normalUrl,
        status: assets?.geometry.status,
        reason: assets?.geometry.reason,
      },
    ]
    return list
  }, [assets])

  /**
   * 生成只看两件事：有源图、选了个真接进来的模型。
   * **不再要求控制素材先备好** —— 准备是任务的第一步，在节点上跑。
   * 语义分区仍然是融合支持区的唯一依据，任务会在掏钱生图**之前**检查它，缺了就直接失败，
   * 不会生成一张没法安全融合的图。
   */
  const canRepair = Boolean(
    sourceUrl
    && REPAIR_MODELS.find((item) => item.value === model)?.status === 'available'
    // 探活明确说语义分区没起来时就别让人白建节点白等了
    && !semanticDown,
  )

  // 交给调用方去建节点 + 跑整条链，这里点完就关。等待在新节点上进行，不在弹窗里。
  const handleGenerate = useCallback(() => {
    if (!canRepair || !onGenerate) return
    // 预览加载过就把结果带过去复用，省一次语义分区推理；没加载过传 null，任务自己准备。
    onGenerate(assets?.semantic.classMapUrl ? assets : null, model)
    onClose()
  }, [assets, canRepair, model, onClose, onGenerate])

  const updateSplitFromEvent = useCallback((clientX: number) => {
    const element = stageRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return
    setSplit(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)))
  }, [])

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!draggingRef.current) return
      event.preventDefault()
      updateSplitFromEvent(event.clientX)
    }
    const onUp = () => { draggingRef.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [updateSplitFromEvent])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 必须 portal 到 body：这个组件渲染在 React Flow 的节点里，而 .react-flow__viewport
  // 带 transform —— 有 transform 的祖先会成为 position: fixed 的包含块，于是浮层跟着画布
  // 一起平移和缩放（画布缩到 50%，弹窗也只有一半大）。灯光重塑和裁剪弹窗都是这么做的。
  return createPortal(
    <div className={`tc-overlay${expanded ? ' is-expanded' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="tc-shell nodrag nowheel">
        {/* ── 左栏：控制素材 ── */}
        <section className="tc-col tc-col-assets">
          <header className="tc-col-head">
            <h3>修复控制素材</h3>
            {assets?.semantic.status === 'cached' || assets?.geometry.status === 'cached'
              ? <span className="tc-tag is-ok">已复用 · 本地缓存</span>
              : null}
          </header>

          <div className="tc-slot-grid">
            {slots.map((slot) => (
              <div key={slot.key} className="tc-slot">
                <div className="tc-slot-thumb">
                  {slot.url
                    ? <img src={slot.url} alt={slot.title} loading="lazy" />
                    : <span className="tc-slot-empty">
                        {loadingAssets ? '准备中' : isResultMode ? '未加载' : '生成时准备'}
                      </span>}
                  <i className={`tc-dot is-${statusTone(slot.status)}`} />
                </div>
                <div className="tc-slot-title">{slot.title}</div>
                <div
                  className={`tc-slot-status is-${statusTone(slot.status)}`}
                  title={slot.reason ? serviceErrorLine(slot.reason) : undefined}
                >
                  {statusLabel(slot.status, slot.reason, loadingAssets)}
                </div>
              </div>
            ))}
          </div>

          {/* 预览是按需的：自动加载就等于把弹窗锁住几十秒，那正是要修的问题 */}
          {assets ? null : (
            <button
              type="button"
              className="tc-btn is-block"
              disabled={loadingAssets || !sourceUrl}
              onClick={loadAssetPreview}
            >
              {loadingAssets
                ? <><Loader2 size={13} className="tc-spin" />正在准备预览…</>
                : <><Eye size={13} />加载控制素材预览</>}
            </button>
          )}
          {assets ? null : (
            <div className="tc-note tc-note-quiet">
              {isResultMode
                ? '想知道当时哪些区域被允许改动，可以加载语义分区看一眼（要等几十秒，会重新算一遍）。'
                : '只是想看语义分区切在哪儿才需要点它（要等几十秒）。直接生成不用等 —— 素材会在新节点上准备。'}
            </div>
          )}

          {/* 语义图例。颜色只是可视化编码，判定一律按类别 id —— 这里显示的覆盖率来自服务端按 id 统计 */}
          <div className="tc-legend">
            {TEXTURE_CLARITY_CLASSES.filter((item) => item.repairSupport).map((item) => {
              const coverage = assets?.semantic.classes?.find((c) => c.id === item.id)?.coverage
              return (
                <span key={item.key} className="tc-legend-item">
                  <i style={{ background: item.color }} />
                  {item.label}
                  {typeof coverage === 'number' ? <em>{(coverage * 100).toFixed(1)}%</em> : null}
                </span>
              )
            })}
          </div>

          {assets?.semantic.modelId ? (
            <div className="tc-meta">
              语义分区 {assets.semantic.modelId.split('/').pop()} · {assets.semantic.labelSet}
              {typeof assets.semantic.elapsedSec === 'number' ? ` · ${assets.semantic.elapsedSec.toFixed(2)}s` : ''}
            </div>
          ) : null}
          {assetError ? <div className="tc-error">{assetError}</div> : null}
        </section>

        {/* ── 中栏：单图滑杆对比 ── */}
        <section className="tc-col tc-col-stage">
          <header className="tc-col-head">
            <h3>{isResultMode ? '细化纹理 · 前后对比' : '细化纹理'}</h3>
            <div className="tc-head-actions">
              {/* 有候选图才给切换：老节点没记 candidateUrl，给个切不动的按钮只会让人困惑 */}
              {isResultMode && result?.candidateUrl ? (
                <div className="tc-seg">
                  <button
                    type="button"
                    className={`tc-seg-btn${compareTarget === 'fused' ? ' is-active' : ''}`}
                    title="融合后的最终结果，也是这个节点显示的图"
                    onClick={() => setCompareTarget('fused')}
                  >
                    融合结果
                  </button>
                  <button
                    type="button"
                    className={`tc-seg-btn${compareTarget === 'candidate' ? ' is-active' : ''}`}
                    title="模型的原始输出，还没做本地保护融合 —— 用来判断融合到底做了什么"
                    onClick={() => setCompareTarget('candidate')}
                  >
                    模型候选
                  </button>
                </div>
              ) : null}
              <button type="button" className="tc-icon-btn" title={expanded ? '还原' : '完整窗口'} onClick={() => setExpanded((v) => !v)}>
                {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
              <button type="button" className="tc-icon-btn" title="关闭" onClick={onClose}>
                <X size={15} />
              </button>
            </div>
          </header>

          <div
            className="tc-stage"
            ref={stageRef}
            onMouseDown={(event) => {
              draggingRef.current = true
              updateSplitFromEvent(event.clientX)
            }}
          >
            {/* 对比模式：左边原图、右边结果。这是这个界面存在的理由，不依赖任何准备。 */}
            {isResultMode && result ? (
              <div className="tc-stage-inner" style={{ transform: `scale(${zoom})` }}>
                <img className="tc-stage-img" src={result.sourceUrl} alt="原图" />
                <img
                  className="tc-stage-img is-right"
                  src={compareTarget === 'candidate' && result.candidateUrl ? result.candidateUrl : result.fusedUrl}
                  alt={compareTarget === 'candidate' ? '模型候选' : '细化结果'}
                  style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }}
                />
                <div className="tc-split" style={{ left: `${split * 100}%` }}>
                  <span className="tc-split-grip">‹ ›</span>
                </div>
                <span className="tc-stage-tag is-left">原图</span>
                <span className="tc-stage-tag is-right">
                  {compareTarget === 'candidate' ? '模型候选（融合前）' : '细化结果'}
                </span>
              </div>
            ) : assets?.source.url || sourceUrl ? (
              <div className="tc-stage-inner" style={{ transform: `scale(${zoom})` }}>
                <img className="tc-stage-img" src={assets?.source.url || sourceUrl} alt="原图" />
                {assets?.semantic.previewUrl ? (
                  <>
                    <img
                      className="tc-stage-img is-right"
                      src={assets.semantic.previewUrl}
                      alt="语义分区"
                      style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }}
                    />
                    <div className="tc-split" style={{ left: `${split * 100}%` }}>
                      <span className="tc-split-grip">‹ ›</span>
                    </div>
                    <span className="tc-stage-tag is-left">原图</span>
                    <span className="tc-stage-tag is-right">语义分区</span>
                  </>
                ) : (
                  <span className="tc-stage-tag is-left">原图</span>
                )}
                {loadingAssets ? (
                  <span className="tc-stage-badge"><Loader2 size={13} className="tc-spin" />正在准备预览</span>
                ) : null}
              </div>
            ) : (
              <div className="tc-stage-empty">没有可用的源图</div>
            )}
          </div>

          <div className="tc-stage-bar">
            <button type="button" className="tc-btn is-mini" onClick={() => setZoom((v) => Math.max(0.25, Number((v - 0.25).toFixed(2))))}>−</button>
            <span className="tc-zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" className="tc-btn is-mini" onClick={() => setZoom((v) => Math.min(4, Number((v + 0.25).toFixed(2))))}>+</button>
            <button type="button" className="tc-btn is-mini" onClick={() => setZoom(1)}>适合窗口</button>
            <div className="tc-gates">
              {isResultMode && result ? (
                result.passed === null
                  ? <span className="tc-gate is-idle">这个节点生成时还没记录质量门禁</span>
                  : <span className={`tc-gate is-${result.passed ? 'ok' : 'bad'}`}>
                      质量门禁{result.passed ? '通过' : '未通过'}
                    </span>
              ) : (
                <span className="tc-gate is-idle">质量门禁结果在新节点上查看</span>
              )}
            </div>
          </div>
        </section>

        {/* ── 右栏：对比模式看记录，生成模式选参数 ── */}
        {isResultMode && result ? (
          <section className="tc-col tc-col-params">
            <header className="tc-col-head">
              <h3>这次生成的记录</h3>
            </header>

            {/* 质量门禁。这就是弹窗上那句「结果在新节点上查看」一直缺的那块。 */}
            {result.passed === null ? (
              <div className="tc-note tc-note-quiet">
                这个节点是在质量门禁记录上线之前生成的，所以没有门禁结论可看。
              </div>
            ) : (
              <div className={`tc-verdict is-${result.passed ? 'ok' : 'bad'}`}>
                <strong>质量门禁{result.passed ? '通过' : '未通过'}</strong>
                {result.passed ? (
                  <em>蒙版外的像素与原图一致，身份、姿态与构图未被改动</em>
                ) : result.failures.length ? (
                  result.failures.map((item) => (
                    <em key={item.code || item.message}>{item.message}</em>
                  ))
                ) : (
                  <em>没有记录具体原因</em>
                )}
              </div>
            )}

            <dl className="tc-facts">
              <div><dt>模型</dt><dd>{result.requestModel || '未记录'}</dd></div>
              {result.resolvedModel && result.resolvedModel !== result.requestModel ? (
                <div><dt>实际调用</dt><dd>{result.resolvedModel}</dd></div>
              ) : null}
              {result.outputWidth && result.outputHeight ? (
                <div><dt>输出</dt><dd>{result.outputWidth}×{result.outputHeight}</dd></div>
              ) : null}
              {result.fusionPolicy ? (
                <div><dt>融合策略</dt><dd>{result.fusionPolicy}</dd></div>
              ) : null}
              {result.semanticModelId ? (
                <div><dt>语义分区</dt><dd>{result.semanticModelId.split('/').pop()}</dd></div>
              ) : null}
              {typeof result.generationCalls === 'number' ? (
                <div><dt>生图调用</dt><dd>{result.generationCalls} 次</dd></div>
              ) : null}
            </dl>

            {/* 诊断只在门禁没过时展开：通过的时候这些数字对人没有意义，只会挤走真正要看的东西 */}
            {result.diagnostics && result.passed === false ? (
              <dl className="tc-facts">
                {Object.entries(result.diagnostics).map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>
                ))}
              </dl>
            ) : null}

            <div className="tc-note tc-note-quiet">
              拖动中间的滑杆看前后差别。
              {result.candidateUrl
                ? '右上角可以切到「模型候选」，那是融合之前模型的原始输出 —— 两者的差别就是本地保护融合做的事。'
                : ''}
              {result.passed === false
                ? '门禁没过时候选图和结果都留着不自动重试，所以不会二次扣费。'
                : ''}
            </div>
          </section>
        ) : (
        <section className="tc-col tc-col-params">
          <header className="tc-col-head">
            <h3>生图模型</h3>
          </header>

          <div className="tc-model-list">
            {REPAIR_MODELS.map((item) => {
              const disabled = item.status !== 'available'
              return (
                <button
                  key={item.value}
                  type="button"
                  className={`tc-model${model === item.value ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
                  disabled={disabled}
                  title={disabled ? '统一模型注册表里还没有它的参考图与蒙版协议，未接入' : undefined}
                  onClick={() => { if (!disabled) setModel(item.value) }}
                >
                  <span className="tc-model-name">{item.label}</span>
                  {item.note ? <span className="tc-model-note">{item.note}</span> : null}
                </button>
              )
            })}
          </div>

          {/* 固定修复目标：只读标签，文档明确不拆成复选项 */}
          <div className="tc-targets">
            {TEXTURE_CLARITY_REPAIR_TARGETS.map((target) => (
              <span key={target} className="tc-target">{target}</span>
            ))}
          </div>
          <div className="tc-note">始终保持身份、姿态与构图</div>

          <dl className="tc-facts">
            <div><dt>尺寸</dt><dd>≤{TEXTURE_CLARITY_OUTPUT_POLICY.maxEdge / 1024}K · 跟随原图比例</dd></div>
            <div><dt>候选</dt><dd>{TEXTURE_CLARITY_OUTPUT_POLICY.candidateCount}</dd></div>
            <div><dt>融合</dt><dd>本地边缘融合</dd></div>
            {assets ? (
              <div><dt>输出</dt><dd>{assets.source.width}×{assets.source.height}</dd></div>
            ) : null}
          </dl>

          <button type="button" className="tc-btn is-primary" disabled={!canRepair} onClick={handleGenerate}>
            <Sparkles size={14} />生成修复
          </button>
          {/* 探活先报：服务没起来就在这儿说清楚，别等到建了节点才发现 */}
          {semanticDown && serviceStatus ? (
            <div className="tc-hint" title={describeServiceError(serviceStatus.semantic.reason).detail}>
              {describeServiceError(serviceStatus.semantic.reason).text}
              <br />
              生成已停用 —— 没有语义分区就算不出融合支持区。服务起来后重新打开这个窗口即可。
            </div>
          ) : null}
          {!semanticDown && assets && !assets.semantic.classMapUrl ? (
            <div className="tc-hint" title={describeServiceError(assets.semantic.reason).detail}>
              {describeServiceError(assets.semantic.reason).text}
              <br />
              没有语义分区就算不出融合支持区，所以这一次生成会在扣费之前直接停下。
            </div>
          ) : null}
          {serviceStatus && serviceStatus.semantic.ok && !serviceStatus.geometry.ok ? (
            <div className="tc-hint" title={describeServiceError(serviceStatus.geometry.reason).detail}>
              深度/法线服务连不上，这次会少一层几何约束，但仍然可以生成。
            </div>
          ) : null}

          <div className="tc-note tc-note-quiet">
            点生成后这个窗口就关掉，右侧会出现一个新的图片节点并自动连线。
            控制素材的准备和修复都在那个节点上跑，进度条会写明当前在哪一步 —— 这个窗口里不用等。
            源节点一律不动；再点一次生成就再多一个节点，不会顶掉上一次的结果。
          </div>
        </section>
        )}
      </div>
    </div>,
    document.body,
  )
}
