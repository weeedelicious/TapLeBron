import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { AssetGenerationMeta, ResourceMeta } from '@/lib/types'
import type { MediaNodeToolbarAction } from '@/components/MediaNodeToolbar'
import { writeImageToClipboard, writeTextToClipboard } from '@/lib/clipboard'
import { videoDownloadFileName } from '@/lib/videoFileName'
import {
  isViewerChromeTarget,
  nextPanOffset,
  shouldPreventAutoscroll,
  shouldStartViewerPan,
} from '@/lib/imageViewerPan'
import './ImagePreview.css'

/** 多图节点的一张。只有 url 是必需的，其余用于信息栏和缩略图。 */
export interface ImagePreviewItem {
  url: string
  name?: string
  /** 缩略图地址；不给就用原图（大图当缩略图会拖慢轨道渲染）。 */
  thumbUrl?: string
  resourceMeta?: ResourceMeta
  generationMeta?: AssetGenerationMeta
  createdAtMs?: number
  /** 角标文字，如 "1K"、"Nano Banana"。 */
  badge?: string
}

interface Props {
  url: string
  onClose: () => void
  name?: string
  naturalWidth?: number
  naturalHeight?: number
  resourceMeta?: ResourceMeta
  generationMeta?: AssetGenerationMeta
  createdAtMs?: number
  /**
   * 同一个节点里的全部图片。给了两张以上就出现顶部缩略图轨道、左右翻页箭头和计数。
   * 不给（或只有一张）时行为和以前完全一致——其它三处调用点不用改。
   */
  items?: ImagePreviewItem[]
  /**
   * 把当前这张设为节点主图。只有多图节点（ImageNode）会传，传了才出「设为主图」按钮。
   * 其它调用点不传就没有这个按钮，行为不变。
   */
  onSetPrimary?: (url: string) => void
  /** 节点当前的主图地址，用来判断「设为主图」要不要置灰 */
  primaryUrl?: string
  /**
   * 图片节点工具栏那一整排功能（裁剪 / 白板标注 / 局部重绘 / 抠像 / 灯光 / 氛围迁移 /
   * 九宫格 / 全景 / 下载）。传了就在大图上方多一行「图标 + 文字」的按钮，
   * 用的是节点上那份同一个数组，不复制。「全屏」会被过滤掉（已经在大图里了）。
   */
  nodeActions?: MediaNodeToolbarAction[]
  /**
   * 从节点里删掉某一张 / 某一条。只有多图多视频节点（ImageNode / VideoNode）会传，
   * 传了才在顶部缩略图轨道的每一格右上角出现「×」。不传就没有这个按钮，行为不变。
   *
   * 语义是**从节点上摘掉这个产物**，不去删画布资产文件 —— 资产还在历史/资产区里，
   * 而且节点那两个 remove 函数都先 pushHistory()，所以 Ctrl+Z 能撤回。
   */
  onRemoveItem?: (url: string) => void
  /**
   * 媒体类型。默认 'image' —— 已有的四个调用点一个字都不用改。
   *
   * 'video' 时改这几处（其余的顶部工具条、计数、缩略图轨道、主图按钮、节点功能行全部共用）：
   *   · 主体换成带原生 controls 的 <video>
   *   · 缩略图轨道用 <video> 取首帧（没有 thumbUrl 时；拿 <img> 指 mp4 会显示成裂图）
   *   · 放大镜隐藏 —— 它是靠 CSS background-image 实现的，视频元素做不到
   *   · 「复制图片」变「复制地址」—— 浏览器剪贴板放不下视频文件
   *   · 不预加载相邻项 —— 视频动辄十几 MB，预加载两个反而更慢
   */
  kind?: 'image' | 'video'
}

/** 这些动作不开弹窗，点完留在大图里；其余的先关大图再执行 */
const VIEWER_INLINE_ACTION_KEYS = new Set(['download'])

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const formatBytes = (value?: number) => !value ? '—' : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(2)} MB` : `${Math.round(value / 1024)} KB`
const formatDate = (value?: number) => !value ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

export function ImagePreview({ url, onClose, name, naturalWidth, naturalHeight, resourceMeta, generationMeta, createdAtMs, items, onSetPrimary, primaryUrl, nodeActions, onRemoveItem, kind = 'image' }: Props) {
  const isVideo = kind === 'video'
  const mediaLabel = isVideo ? '视频' : '图片'
  const list = useMemo<ImagePreviewItem[]>(() => {
    const provided = (items ?? []).filter((item) => item && typeof item.url === 'string' && item.url)
    if (provided.length) return provided
    return [{ url, name, resourceMeta, generationMeta, createdAtMs }]
  }, [items, url, name, resourceMeta, generationMeta, createdAtMs])

  // 大图里点节点功能：默认先把查看器关掉再执行 —— 裁剪 / 局部重绘 / 抠像 / 灯光 这些
  // 都会开自己的弹窗，而查看器是 z-index 99999，不关就被压在下面看不见。
  // 只有不开界面的动作（下载）留在大图里，省得看一张图要重新点开。
  const viewerActions = useMemo(
    () => (nodeActions ?? []).filter((action) => action.key !== 'fullscreen'),
    [nodeActions]
  )

  const initialIndex = Math.max(0, list.findIndex((item) => item.url === url))
  const [index, setIndex] = useState(initialIndex)
  const active = list[Math.min(index, list.length - 1)] ?? list[0]
  const activeUrl = active.url
  const multiple = list.length > 1

  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [rotation, setRotation] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [imageSize, setImageSize] = useState({ w: naturalWidth || 0, h: naturalHeight || 0 })
  const [infoOpen, setInfoOpen] = useState(true)
  const [stripOpen, setStripOpen] = useState(true)
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  /** 提示词的复制反馈单独一份 —— copyState 被"复制图片/地址"那个按钮的文案共用，混用会串。 */
  const [promptCopied, setPromptCopied] = useState(false)
  const [loupe, setLoupe] = useState<0 | 2 | 4 | 8>(0)
  const [pointer, setPointer] = useState({ x: 0, y: 0, px: 0, py: 0, visible: false })
  /** 图片实际渲染出来的左边缘，操作条要跟它对齐（图是居中的，贴屏幕左边会离图很远） */
  const [imageLeft, setImageLeft] = useState(0)
  /** 从操作条左边缘到视口右边还剩多少宽 —— 节点功能那一行要单行排完，靠它定 max-width */
  const [actionsMaxWidth, setActionsMaxWidth] = useState(0)
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const scaleRef = useRef(scale)
  const isVideoRef = useRef(isVideo)
  scaleRef.current = scale
  isVideoRef.current = isVideo
  const backdropRef = useRef<HTMLDivElement>(null)
  // 视频时装的是 <video>。只用到 getBoundingClientRect（量左边缘给操作条对齐），两者都有。
  const imageRef = useRef<HTMLImageElement | HTMLVideoElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  const reset = useCallback(() => { setScale(1); setOffset({ x: 0, y: 0 }); setRotation(0) }, [])
  const zoom = useCallback((factor: number) => setScale(value => clamp(value * factor, 0.1, 20)), [])

  // 换图时必须把缩放/平移/旋转清掉：留着上一张的变换，下一张会以歪着或跑出画面的姿态出现。
  const goTo = useCallback((next: number) => {
    if (list.length < 2) return
    const total = list.length
    const wrapped = ((next % total) + total) % total
    setIndex(wrapped)
    setScale(1); setOffset({ x: 0, y: 0 }); setRotation(0)
    setImageSize({ w: 0, h: 0 })
    setCopyState('idle')
    // 翻到下一条就把提示词的"已复制"收回去，否则会误以为复制的是新这条
    setPromptCopied(false)
  }, [list.length])

  /**
   * 删掉轨道里的第 targetIndex 格。
   *
   * 真正麻烦的是 index 的账：list 是父组件传下来的，删完它会少一格重新渲染，
   * 而 index 是本地 state。三种情况要分开处理，不然画面会莫名跳到另一张：
   *   · 删的在当前之前 —— 显示的还是同一张，但它的下标前移了一格，index 要跟着减；
   *     这时**不要**清缩放，用户正看着的那张没换，凭什么把他的放大倍数抹掉；
   *   · 删的就是当前这张 —— 后面那张会顶到同一个下标上（已经是最后一格就退一格）。
   *     显示内容变了，必须跟 goTo 一样把缩放/平移/旋转清掉；
   *   · 删的在当前之后 —— index 和画面都不用动。
   *
   * 删到只剩一项时轨道自己就消失了（它只在两项以上才渲染），所以这里不用管"删光"的情况——
   * 从轨道上永远删不到最后一项。最后那一项在节点身上删（节点展开的画廊里有同一个按钮）。
   */
  const removeItemAt = useCallback((targetIndex: number) => {
    const target = list[targetIndex]
    if (!onRemoveItem || !target) return
    if (targetIndex < index) {
      setIndex(value => Math.max(0, value - 1))
    } else if (targetIndex === index) {
      setIndex(value => (value >= list.length - 1 ? Math.max(0, value - 1) : value))
      reset()
      setImageSize({ w: 0, h: 0 })
      setCopyState('idle')
      setPromptCopied(false)
    }
    onRemoveItem(target.url)
  }, [index, list, onClose, onRemoveItem, reset])

  /**
   * 右键一律交给浏览器（2026-08-25 用户要求：在大图上右键要能出「在新标签页中打开图片 /
   * 图片另存为 / 复制图片 / 复制图片地址」）。
   *
   * 只 stopPropagation、**绝不 preventDefault**：
   *   · stopPropagation 拦住上游会吃掉右键的处理器 —— 这个查看器虽然 portal 到 document.body，
   *     React 合成事件仍然顺着**组件树**冒到节点身上，被 openNodeMenu 的 preventDefault 吃掉，
   *     还会在全屏浮层上盖一个「复制节点 / 删除」菜单（详见 lib/canvasContextMenu.ts）；
   *   · preventDefault 干的正是相反的事 —— 那会连浏览器菜单一起取消掉。
   */
  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
  }, [])

  useEffect(() => {
    const el = backdropRef.current
    if (!el) return

    const killAutoscroll = (event: Event) => {
      const mouse = event as MouseEvent
      if (!shouldPreventAutoscroll(mouse.button)) return
      if (isViewerChromeTarget(event.target)) return
      event.preventDefault()
    }

    const onDown = (event: MouseEvent) => {
      if (!shouldStartViewerPan({
        button: event.button,
        isVideo: isVideoRef.current,
        scale: scaleRef.current,
        target: event.target,
      })) return
      event.preventDefault()
      event.stopPropagation()
      dragging.current = true
      lastPos.current = { x: event.clientX, y: event.clientY }
      setIsDragging(true)
    }

    const onMove = (event: MouseEvent) => {
      if (!dragging.current) return
      const prev = lastPos.current
      if (event.clientX === prev.x && event.clientY === prev.y) return
      event.preventDefault()
      lastPos.current = { x: event.clientX, y: event.clientY }
      setOffset(value => nextPanOffset(value, event.clientX, event.clientY, prev.x, prev.y))
    }

    const onUp = () => {
      dragging.current = false
      setIsDragging(false)
    }

    const capture = { capture: true } as const
    el.addEventListener('pointerdown', killAutoscroll, capture)
    el.addEventListener('mousedown', killAutoscroll, capture)
    el.addEventListener('auxclick', killAutoscroll, capture)
    el.addEventListener('mousedown', onDown, capture)
    el.addEventListener('mousemove', onMove)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      el.removeEventListener('pointerdown', killAutoscroll, capture)
      el.removeEventListener('mousedown', killAutoscroll, capture)
      el.removeEventListener('auxclick', killAutoscroll, capture)
      el.removeEventListener('mousedown', onDown, capture)
      el.removeEventListener('mousemove', onMove)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    const el = backdropRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.0012)
      setScale(oldScale => {
        const next = clamp(oldScale * factor, 0.1, 20)
        const rect = el.getBoundingClientRect()
        const x = event.clientX - rect.left - rect.width / 2
        const y = event.clientY - rect.top - rect.height / 2
        const ratio = next / oldScale
        setOffset(old => ({ x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio }))
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') goTo(index - 1)
      else if (event.key === 'ArrowRight') goTo(index + 1)
      else if (event.key === 'Home') goTo(0)
      else if (event.key === 'End') goTo(list.length - 1)
      else if (event.key === '+' || event.key === '=') zoom(1.2)
      else if (event.key === '-') zoom(1 / 1.2)
      else if (event.key === '0') reset()
      else if (event.key.toLowerCase() === 'r') setRotation(value => (value + 90) % 360)
      else if (event.key.toLowerCase() === 'i') setInfoOpen(value => !value)
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose, reset, zoom, goTo, index, list.length])

  // 预加载相邻两张：翻页时不用等网络（抄 yet-another-react-lightbox 的 preload 默认值 2）。
  // 视频不预加载 —— 一个十几 MB，预两个只会把当前这个的带宽抢掉。
  useEffect(() => {
    if (!multiple || isVideo) return
    for (const step of [1, -1, 2, -2]) {
      const target = list[((index + step) % list.length + list.length) % list.length]
      if (target && target.url !== activeUrl) new Image().src = target.url
    }
  }, [index, list, multiple, activeUrl, isVideo])

  // 当前缩略图滚进可视区，否则图多了之后完全看不出自己在第几张
  useEffect(() => {
    if (!multiple || !stripOpen) return
    const strip = stripRef.current
    const thumb = strip?.querySelector<HTMLElement>(`[data-thumb-index="${index}"]`)
    thumb?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [index, multiple, stripOpen])

  // 操作条对齐图片左边缘。缩放/旋转/换图/改窗口都会挪动图，所以每次都重新量；
  // 放大到超出视口时钳到 16px，否则按钮会跑到屏幕外面。
  useEffect(() => {
    const measure = () => {
      const rect = imageRef.current?.getBoundingClientRect()
      if (!rect) return
      const left = clamp(Math.round(rect.left), 16, Math.max(16, window.innerWidth - 260))
      setImageLeft(left)
      setActionsMaxWidth(Math.max(320, window.innerWidth - left - 16))
    }
    measure()
    const raf = window.requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => { window.cancelAnimationFrame(raf); window.removeEventListener('resize', measure) }
  }, [activeUrl, scale, rotation, offset.x, imageSize.w, imageSize.h, infoOpen, stripOpen])

  const meta = useMemo(() => {
    const width = imageSize.w || active.resourceMeta?.width || 0
    const height = imageSize.h || active.resourceMeta?.height || 0
    return { width, height, ratio: width && height ? (width / height).toFixed(3) : '—' }
  }, [imageSize, active])

  const copy = (text?: string) => { if (text) void writeTextToClipboard(text) }
  // 视频没法进剪贴板（浏览器只收 image/png），所以复制地址。
  const copyImage = useCallback(async () => {
    setCopyState('busy')
    try {
      if (isVideo) {
        await writeTextToClipboard(activeUrl)
        setCopyState('done')
      } else {
        const displayed = imageRef.current instanceof HTMLImageElement ? imageRef.current : null
        const result = await writeImageToClipboard(activeUrl, displayed)
        setCopyState(result === 'image' ? 'done' : 'failed')
      }
    } catch {
      try { await writeTextToClipboard(activeUrl) } catch { /* ignore */ }
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 1800)
  }, [activeUrl, isVideo])
  const download = () => {
    const anchor = document.createElement('a')
    anchor.href = active.resourceMeta?.originalUrl || activeUrl
    anchor.download = isVideo
      ? videoDownloadFileName(active.name || name, anchor.href)
      : active.name || name || activeUrl.split('/').pop() || 'image'
    anchor.click()
  }

  const copyLabel = copyState === 'busy' ? '…' : copyState === 'done' ? '✓' : copyState === 'failed' ? '⧉!' : '⧉'
  const copyTitle = isVideo
    ? (copyState === 'done' ? '已复制视频地址' : copyState === 'failed' ? '复制地址失败' : '复制视频地址')
    : copyState === 'done'
      ? '已复制图片到剪贴板'
      : copyState === 'failed'
        ? '图片复制失败，已改为复制地址'
        : '复制图片到剪贴板'
  const copyButtonText = isVideo
    ? (copyState === 'busy' ? '复制中…' : copyState === 'done' ? '已复制地址' : copyState === 'failed' ? '复制失败' : '复制地址')
    : copyState === 'busy' ? '复制中…' : copyState === 'done' ? '已复制' : copyState === 'failed' ? '已复制地址' : '复制图片'
  const isPrimary = Boolean(primaryUrl && primaryUrl === activeUrl)
  const stageClass = [
    'shotflow-image-viewer-stage',
    infoOpen ? 'has-info' : '',
    multiple && stripOpen ? 'has-strip' : '',
  ].filter(Boolean).join(' ')

  return createPortal(
    <div ref={backdropRef} className={['shotflow-image-viewer', isDragging ? 'is-dragging' : '', scale > 1.05 ? 'is-zoomed' : ''].filter(Boolean).join(' ')}
      onContextMenu={handleContextMenu}
      onMouseMove={event => {
        const image = imageRef.current; if (!image) return
        const rect = image.getBoundingClientRect()
        const px = clamp((event.clientX - rect.left) / rect.width, 0, 1), py = clamp((event.clientY - rect.top) / rect.height, 0, 1)
        setPointer({ x: event.clientX, y: event.clientY, px, py, visible: event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom })
      }}>
      {/* 视频不接双击缩放：双击视频在浏览器里的既有含义是全屏，抢掉会很别扭 */}
      <div className={stageClass} onDoubleClick={() => { if (isVideo) return; scale > 1.05 ? reset() : setScale(2) }}>
        {isVideo ? (
          <video
            key={activeUrl}
            ref={imageRef as React.RefObject<HTMLVideoElement>}
            src={activeUrl}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={event => setImageSize({ w: event.currentTarget.videoWidth, h: event.currentTarget.videoHeight })}
            // 原生控件必须能点。外层 backdrop 的 mousedown 会 preventDefault 来做拖动平移，
            // 不在这里挡住的话进度条、音量、播放键全都点不动。
            // 放大之后（>1.05）才放行给拖动 —— 那时用户是在看细节，不是在操作播放器。
            onMouseDown={event => { if (scale <= 1.05) event.stopPropagation() }}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`, cursor: isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'default' }}
          />
        ) : (
          <img key={activeUrl} ref={imageRef as React.RefObject<HTMLImageElement>} src={activeUrl} draggable={false} onLoad={event => setImageSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`, cursor: isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'zoom-in' }} />
        )}
      </div>

      {/* 左上角操作条：带文字的主操作，图标工具栏那些一眼看不出是什么 */}
      <div className="shotflow-image-viewer-actions" style={{ left: imageLeft }} onMouseDown={event => event.stopPropagation()}>
        {onSetPrimary && (
          <button
            type="button"
            className={isPrimary ? '' : 'is-primary'}
            disabled={isPrimary}
            title={isPrimary
              ? `这个已经是节点主${mediaLabel}`
              : `把这个设为节点主${mediaLabel}（节点封面和下游引用都用它）`}
            onClick={() => onSetPrimary(activeUrl)}
          >
            <span aria-hidden="true">{isPrimary ? '★' : '☆'}</span>
            {isPrimary ? `已是主${mediaLabel}` : `设为主${mediaLabel}`}
          </button>
        )}
        <button
          type="button"
          className={copyState === 'done' ? 'is-done' : copyState === 'failed' ? 'is-failed' : ''}
          title={copyTitle}
          onClick={copyImage}
        >
          <span aria-hidden="true">{copyState === 'done' ? '✓' : copyState === 'failed' ? '!' : '⧉'}</span>
          {copyButtonText}
        </button>
      </div>

      {viewerActions.length > 0 && (
        <div
          className="shotflow-image-viewer-node-actions"
          style={{ left: imageLeft, maxWidth: actionsMaxWidth || undefined }}
          onMouseDown={event => event.stopPropagation()}
        >
          {viewerActions.map((action) => (
            <button
              key={action.key}
              type="button"
              className={action.active ? 'is-active' : ''}
              disabled={action.disabled}
              title={action.label}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (action.disabled) return
                // 会开弹窗的动作先关掉大图，否则弹窗被查看器压在下面
                if (!VIEWER_INLINE_ACTION_KEYS.has(action.key)) onClose()
                action.onClick?.(event)
              }}
            >
              <span className="shotflow-image-viewer-node-action-icon" aria-hidden="true">{action.icon}</span>
              {action.label}
            </button>
          ))}
        </div>
      )}

      {multiple && (
        <>
          <button className="shotflow-image-viewer-nav is-prev" title="上一张（←）"
            onMouseDown={event => event.stopPropagation()} onClick={() => goTo(index - 1)}>‹</button>
          <button className="shotflow-image-viewer-nav is-next" title="下一张（→）"
            onMouseDown={event => event.stopPropagation()} onClick={() => goTo(index + 1)}>›</button>
        </>
      )}

      {multiple && stripOpen && (
        <div ref={stripRef} className={`shotflow-image-viewer-strip${infoOpen ? ' has-info' : ''}`}
          onMouseDown={event => event.stopPropagation()}>
          {/* 每格外面套一层 cell：删除的「×」必须是缩略图按钮的**兄弟**而不是子节点 ——
              button 里套 button 是非法 HTML，React 会警告，点击行为也不可靠。 */}
          {list.map((item, i) => (
            <div key={`${item.url}-${i}`} className="shotflow-image-viewer-thumb-cell">
              <button data-thumb-index={i} type="button"
                className={`shotflow-image-viewer-thumb${i === index ? ' is-active' : ''}`}
                title={item.name || `第 ${i + 1} 个`} onClick={() => goTo(i)}>
                {/* 视频且没给 thumbUrl 时必须用 <video>：<img src="xx.mp4"> 会画成裂图。
                    #t=0.001 是让浏览器停在首帧，跟节点里那些视频缩略图同一套写法。 */}
                {isVideo && !item.thumbUrl ? (
                  <video src={`${item.url}#t=0.001`} muted playsInline preload="metadata" />
                ) : (
                  <img src={item.thumbUrl || item.url} alt="" draggable={false} loading="lazy" />
                )}
                <span className="shotflow-image-viewer-thumb-order">{i + 1}</span>
                {item.badge && <span className="shotflow-image-viewer-thumb-badge">{item.badge}</span>}
              </button>
              {/* 不需要 stopPropagation：它是缩略图按钮的兄弟（点它不会触发翻页），
                  祖先里也没有任何 onClick，而拖动平移靠的 mousedown 已经被轨道容器拦下了。 */}
              {onRemoveItem && (
                <button type="button" className="shotflow-image-viewer-thumb-remove"
                  title={`从节点删除这${isVideo ? '条视频' : '张图'}（可 Ctrl+Z 撤回）`}
                  aria-label={`删除第 ${i + 1} ${isVideo ? '条视频' : '张图'}`}
                  onClick={() => removeItemAt(i)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 必须写成 loupe > 0：loupe 是数字，放大镜关着时是 0，而 {0 && ...} 会被 React
          当成文本把一个裸的 "0" 画到屏幕左上角 */}
      {!isVideo && loupe > 0 && pointer.visible && <div className="shotflow-image-viewer-loupe" style={{ left: pointer.x, top: pointer.y, backgroundImage: `url("${activeUrl}")`, backgroundSize: meta.width && meta.height ? `${meta.width * loupe}px ${meta.height * loupe}px` : `${loupe * 100}%`, backgroundPosition: `${pointer.px * 100}% ${pointer.py * 100}%` }} />}

      <div className="shotflow-image-viewer-toolbar">
        {multiple && <span className="shotflow-image-viewer-counter">{index + 1} / {list.length}</span>}
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={() => zoom(1 / 1.2)} title="缩小">−</button><button onClick={() => zoom(1.2)} title="放大">+</button>
        <button onClick={reset} title="适应窗口">⊡</button><button onClick={() => setScale(1)} title="1:1">1:1</button>
        <button onClick={() => setRotation(value => (value + 90) % 360)} title="旋转">↻</button>
        {/* 放大镜靠 CSS background-image 实现，视频元素做不到，所以视频时不出这个按钮 */}
        {!isVideo && <button onClick={() => setLoupe(value => value === 0 ? 2 : value === 2 ? 4 : value === 4 ? 8 : 0)} title="细节放大镜">⌕{loupe || ''}</button>}
        <button className={copyState === 'done' ? 'is-done' : copyState === 'failed' ? 'is-failed' : ''}
          onClick={copyImage} title={copyTitle}>{copyLabel}</button>
        <button onClick={download} title="下载">⇩</button>
        {multiple && <button className={stripOpen ? 'is-on' : ''} onClick={() => setStripOpen(value => !value)} title="缩略图">▦</button>}
        <button onClick={() => setInfoOpen(value => !value)} title={`${mediaLabel}信息`}>ⓘ</button>
        <button onClick={onClose} title="关闭">×</button>
      </div>

      {infoOpen && <aside className="shotflow-image-viewer-info">
        <h2>{active.name || name || activeUrl.split('/').pop() || mediaLabel}</h2>
        {multiple && <Info label="序号" value={`${index + 1} / ${list.length}`} />}
        <Info label="像素尺寸" value={meta.width && meta.height ? `${meta.width} × ${meta.height}` : '—'} />
        {isVideo && <Info label="时长" value={active.resourceMeta?.durationSec ? `${Number(active.resourceMeta.durationSec).toFixed(1)} 秒` : '—'} />}
        <Info label="宽高比" value={meta.ratio} /><Info label="格式" value={active.resourceMeta?.mimeType || activeUrl.split('.').pop()?.toUpperCase() || '—'} />
        <Info label="文件大小" value={formatBytes(active.resourceMeta?.byteSize)} /><Info label="模型" value={active.generationMeta?.model || '—'} />
        <Info label="生成分辨率" value={active.generationMeta?.resolution || '—'} /><Info label="生成时间" value={formatDate(active.generationMeta?.createdAtMs || active.createdAtMs || active.resourceMeta?.createdAtMs)} />
        {/* 提交时的比例 / 时长 / 模式：同一个节点里多条视频往往设置不同，不显示就分不清哪条是哪条 */}
        <Info label="生成比例" value={active.generationMeta?.ratio || '—'} /><Info label="生成时长" value={active.generationMeta?.durationSec ? `${active.generationMeta.durationSec} 秒` : '—'} />
        {active.generationMeta?.modeType && <Info label="生成模式" value={active.generationMeta.modeType} />}
        <Info label="生成版本" value={active.generationMeta?.generationVersion ? String(active.generationMeta.generationVersion) : '—'} />
        {/* 提示词紧跟在生成信息之后、放在「缩放 / 旋转」这类界面状态之前 ——
            原来排在最末尾又是暗色，用户根本没注意到它在（2026-08-19 反馈）。 */}
        <div className="shotflow-image-viewer-prompt">
          <div className="shotflow-image-viewer-prompt-head">
            <span>提示词</span>
            {active.generationMeta?.prompt && (
              <button
                type="button"
                className={promptCopied ? 'is-done' : undefined}
                title="复制这条提示词"
                onClick={() => {
                  copy(active.generationMeta?.prompt)
                  setPromptCopied(true)
                }}
              >
                {promptCopied ? '✓ 已复制' : '⧉ 复制'}
              </button>
            )}
          </div>
          {active.generationMeta?.prompt
            ? <p>{active.generationMeta.prompt}</p>
            : <p className="is-empty">这条{isVideo ? '视频' : '图片'}没有记录提示词（2026-08-19 之前生成的内容不带这项）</p>}
        </div>
        <Info label="缩放 / 旋转" value={`${Math.round(scale * 100)}% / ${rotation}°`} />
        <button onClick={copyImage}>{isVideo
          ? (copyState === 'done' ? '已复制视频地址' : copyState === 'failed' ? '复制地址失败' : '复制视频地址')
          : copyState === 'done' ? '已复制图片' : copyState === 'failed' ? '已复制地址（图片复制失败）' : '复制图片'}</button>
        <button onClick={() => copy(activeUrl)}>复制资源地址</button>{active.generationMeta?.taskId && <button onClick={() => copy(active.generationMeta?.taskId)}>复制任务 ID</button>}
        <p>{multiple ? '←/→ 翻页 · ' : ''}滚轮缩放{isVideo ? ' · 放大后按住中键拖动看细节' : ' · 放大后按住中键拖动看细节 · 左键拖动 · 双击细节'} · R旋转 · I信息 · Esc关闭</p>
      </aside>}
    </div>, document.body
  )
}

function Info({ label, value }: { label: string; value: string }) { return <div className="shotflow-image-viewer-info-row"><span>{label}</span><strong>{value}</strong></div> }
