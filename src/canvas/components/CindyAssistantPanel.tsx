import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ArrowUp, Bot, Check, ImagePlus, LoaderCircle, Network, ShieldCheck, X } from 'lucide-react'
import { assetsApi } from '@/lib/api'
import { prepareAssetForUpload } from '@/lib/uploadPrep'
import {
  cindyAssistantApi,
  cindyModesFromStatus,
  type CindyApplyResult,
  type CindyAssistantMessage,
  type CindyCanvasContext,
  type CindyProposal,
} from '@/lib/cindyAssistant'
import { useCanvasStore } from '@/store/canvasStore'
import './CindyAssistantPanel.css'

interface Props {
  projectUuid: string | null
  canvasContext: CindyCanvasContext
  onApplyProposal: (proposal: CindyProposal, messageId: string, options?: { autoGenerate?: boolean }) => Promise<CindyApplyResult>
}

const NODE_TYPE_LABELS: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
}

type OverlayKind = 'launcher' | 'panel'

interface OverlayPosition {
  x: number
  y: number
}

interface OverlaySize {
  width: number
  height: number
}

interface OverlayAnchor extends OverlayPosition, OverlaySize {}

interface OverlayDragSession {
  kind: OverlayKind
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  maxX: number
  maxY: number
  moved: boolean
}

const OVERLAY_PADDING = 8
const DRAG_THRESHOLD_PX = 4
/** 一条消息最多附几张图。服务端也按同一上限截断，这里只是别让用户白传。 */
const MAX_PENDING_IMAGES = 4

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function clampOverlayPosition(element: HTMLElement, position: OverlayPosition) {
  const container = element.parentElement
  if (!container) return position
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  return {
    x: clamp(position.x, OVERLAY_PADDING, containerRect.width - elementRect.width - OVERLAY_PADDING),
    y: clamp(position.y, OVERLAY_PADDING, containerRect.height - elementRect.height - OVERLAY_PADDING),
  }
}

function positionsMatch(left: OverlayPosition, right: OverlayPosition) {
  return Math.abs(left.x - right.x) < 0.5 && Math.abs(left.y - right.y) < 0.5
}

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function formatTime(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function proposalFlowLabel(proposal: CindyProposal) {
  return proposal.nodes.map(node => NODE_TYPE_LABELS[node.type] || node.type).join(' → ')
}

export function CindyAssistantPanel({ projectUuid, canvasContext, onApplyProposal }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [model, setModel] = useState('')
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<CindyAssistantMessage[]>([])
  const [draft, setDraft] = useState('')
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sending, setSending] = useState(false)
  const [busyMessageId, setBusyMessageId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const messageListRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const launcherAnchorRef = useRef<OverlayAnchor | null>(null)
  const dragSessionRef = useRef<OverlayDragSession | null>(null)
  const suppressLauncherClickRef = useRef(false)
  const [launcherPosition, setLauncherPosition] = useState<OverlayPosition | null>(null)
  const [panelPosition, setPanelPosition] = useState<OverlayPosition | null>(null)
  const [panelSize, setPanelSize] = useState<OverlaySize | null>(null)
  const [draggingOverlay, setDraggingOverlay] = useState<OverlayKind | null>(null)
  const cindyMode = useCanvasStore((s) => s.cindyMode)
  const setCindyEnabled = useCanvasStore((s) => s.setCindyEnabled)
  const setCindyModes = useCanvasStore((s) => s.setCindyModes)

  useEffect(() => {
    let cancelled = false
    cindyAssistantApi.status()
      .then((status) => {
        if (cancelled) return
        const isEnabled = Boolean(status.enabled)
        setEnabled(isEnabled)
        setModel(status.model || '')
        setCindyEnabled(isEnabled)
        setCindyModes(cindyModesFromStatus(status.modes, isEnabled))
      })
      .catch(() => {
        if (!cancelled) {
          setEnabled(false)
          setCindyEnabled(false)
          setCindyModes(['default'])
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setMessages([])
    setError('')
    if (!enabled || !projectUuid) return
    let cancelled = false
    setLoadingMessages(true)
    cindyAssistantApi.listMessages(projectUuid)
      .then((result) => {
        if (!cancelled) setMessages(result.messages)
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorText(loadError, '对话记录加载失败'))
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, projectUuid])

  useEffect(() => {
    if (!open) return
    const element = messageListRef.current
    if (!element) return
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight
    })
  }, [messages, open, sending])

  useLayoutEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const container = panel?.parentElement
    if (!panel || !container) return

    const panelRect = panel.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const panelWidth = panel.offsetWidth || panelRect.width
    const panelHeight = panel.offsetHeight || panelRect.height
    const anchor = launcherAnchorRef.current
    const fallbackPosition = {
      x: panelRect.left - containerRect.left,
      y: panelRect.top - containerRect.top,
    }

    if (!anchor) {
      setPanelPosition({
        x: clamp(fallbackPosition.x, OVERLAY_PADDING, containerRect.width - panelWidth - OVERLAY_PADDING),
        y: clamp(fallbackPosition.y, OVERLAY_PADDING, containerRect.height - panelHeight - OVERLAY_PADDING),
      })
      setPanelSize({ width: panelWidth, height: panelHeight })
      return
    }

    const opensToLeft = anchor.x + anchor.width / 2 > containerRect.width / 2
    const opensUpward = anchor.y + anchor.height / 2 > containerRect.height / 2
    const desiredPosition = {
      x: opensToLeft ? anchor.x + anchor.width - panelWidth : anchor.x,
      y: opensUpward ? anchor.y + anchor.height - panelHeight : anchor.y,
    }

    setPanelPosition({
      x: clamp(desiredPosition.x, OVERLAY_PADDING, containerRect.width - panelWidth - OVERLAY_PADDING),
      y: clamp(desiredPosition.y, OVERLAY_PADDING, containerRect.height - panelHeight - OVERLAY_PADDING),
    })
    setPanelSize({ width: panelWidth, height: panelHeight })
  }, [open])

  const openPanelFromLauncher = useCallback(() => {
    if (suppressLauncherClickRef.current) {
      suppressLauncherClickRef.current = false
      return
    }

    const launcher = launcherRef.current
    const container = launcher?.parentElement
    if (launcher && container) {
      const launcherRect = launcher.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      launcherAnchorRef.current = {
        x: launcherRect.left - containerRect.left,
        y: launcherRect.top - containerRect.top,
        width: launcher.offsetWidth || launcherRect.width,
        height: launcher.offsetHeight || launcherRect.height,
      }
    } else {
      launcherAnchorRef.current = null
    }

    setPanelPosition(null)
    setPanelSize(null)
    setOpen(true)
  }, [])

  const startOverlayDrag = useCallback((kind: OverlayKind, event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0) return
    if (kind === 'panel' && (event.target as HTMLElement).closest('button, input, textarea, select, a')) return

    const element = kind === 'launcher' ? launcherRef.current : panelRef.current
    const container = element?.parentElement
    if (!element || !container) return

    const elementRect = element.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const elementWidth = element.offsetWidth || elementRect.width
    const elementHeight = element.offsetHeight || elementRect.height
    const startX = clamp(
      elementRect.left - containerRect.left,
      OVERLAY_PADDING,
      containerRect.width - elementWidth - OVERLAY_PADDING,
    )
    const startY = clamp(
      elementRect.top - containerRect.top,
      OVERLAY_PADDING,
      containerRect.height - elementHeight - OVERLAY_PADDING,
    )

    dragSessionRef.current = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX,
      startY,
      maxX: Math.max(OVERLAY_PADDING, containerRect.width - elementWidth - OVERLAY_PADDING),
      maxY: Math.max(OVERLAY_PADDING, containerRect.height - elementHeight - OVERLAY_PADDING),
      moved: false,
    }

    if (kind === 'launcher') {
      setLauncherPosition({ x: startX, y: startY })
    } else {
      setPanelPosition({ x: startX, y: startY })
      setPanelSize({ width: elementWidth, height: elementHeight })
    }

    setDraggingOverlay(kind)
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is best-effort; regular pointer events still keep dragging usable.
    }
  }, [])

  const moveOverlayDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = dragSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return

    const deltaX = event.clientX - session.startClientX
    const deltaY = event.clientY - session.startClientY
    if (!session.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return

    session.moved = true
    event.preventDefault()
    event.stopPropagation()
    const nextPosition = {
      x: clamp(session.startX + deltaX, OVERLAY_PADDING, session.maxX),
      y: clamp(session.startY + deltaY, OVERLAY_PADDING, session.maxY),
    }
    if (session.kind === 'launcher') setLauncherPosition(nextPosition)
    else setPanelPosition(nextPosition)
  }, [])

  const finishOverlayDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = dragSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return

    event.stopPropagation()
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // The browser may already have released capture on pointer cancellation.
    }

    if (session.kind === 'launcher' && session.moved) {
      suppressLauncherClickRef.current = true
      window.setTimeout(() => {
        suppressLauncherClickRef.current = false
      }, 0)
    }
    dragSessionRef.current = null
    setDraggingOverlay(null)
  }, [])

  useEffect(() => {
    const keepOverlaysInBounds = () => {
      if (launcherRef.current) {
        setLauncherPosition(current => {
          if (!current || !launcherRef.current) return current
          const next = clampOverlayPosition(launcherRef.current, current)
          return positionsMatch(current, next) ? current : next
        })
      }
      if (panelRef.current) {
        setPanelPosition(current => {
          if (!current || !panelRef.current) return current
          const next = clampOverlayPosition(panelRef.current, current)
          return positionsMatch(current, next) ? current : next
        })
      }
    }

    const frame = window.requestAnimationFrame(keepOverlaysInBounds)
    window.addEventListener('resize', keepOverlaysInBounds)
    const container = launcherRef.current?.parentElement || panelRef.current?.parentElement
    const resizeObserver = container && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(keepOverlaysInBounds)
      : null
    if (container) resizeObserver?.observe(container)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', keepOverlaysInBounds)
      resizeObserver?.disconnect()
    }
  }, [open])

  // ── 附图：拖入 / 粘贴 / 点选 ───────────────────────────────────────────
  // 图先上传成**本画布的资产**（跟画布里其它上传同一套 prepareAssetForUpload：超大图会先压到
  // 10MB 以内），拿到 /assets/<canvasId>/<file> 地址再随消息发出去。服务端只认本画布的地址。
  //
  // 这几个 hook 必须留在下面那句 `return null` 之前。放到早退之后会让「enabled 拿到之前 / 之后」
  // 两帧的 hook 数量不一致，React 直接抛 Rendered more hooks 把整棵树卸载 —— 也就是
  // 2026-08-18 18:05 那次画布黑屏。
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [uploadingImages, setUploadingImages] = useState(0)
  const imageInputRef = useRef<HTMLInputElement | null>(null)

  const uploadImages = useCallback(async (files: File[]) => {
    if (!projectUuid) return
    const picked = files.filter(file => file.type.startsWith('image/'))
    if (picked.length === 0) return
    setError('')
    setUploadingImages(count => count + picked.length)
    for (const file of picked) {
      try {
        const prepared = await prepareAssetForUpload(file)
        const asset = await assetsApi.upload(projectUuid, prepared)
        if (asset?.url) {
          setPendingImages(current => (current.length >= MAX_PENDING_IMAGES ? current : [...current, asset.url]))
        }
      } catch (uploadError) {
        setError(errorText(uploadError, '图片上传失败'))
      } finally {
        setUploadingImages(count => Math.max(0, count - 1))
      }
    }
  }, [projectUuid])

  const handleComposerPaste = useCallback((event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'))
    if (files.length === 0) return
    // 只在真有图时拦下来，纯文本照常粘进输入框
    event.preventDefault()
    void uploadImages(files)
  }, [uploadImages])

  const handleComposerDrop = useCallback((event: React.DragEvent) => {
    const files = Array.from(event.dataTransfer?.files || []).filter(file => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    void uploadImages(files)
  }, [uploadImages])

  if (enabled !== true || !projectUuid) return null

  const sendMessage = async () => {
    const content = draft.trim()
    // 只带图不打字也能发；服务端文字为空时会补一句默认提问
    if ((!content && pendingImages.length === 0) || sending || uploadingImages > 0) return
    const temporaryId = `temporary-${Date.now()}`
    const temporaryMessage: CindyAssistantMessage = {
      id: temporaryId,
      canvasId: projectUuid,
      role: 'user',
      content,
      images: pendingImages,
      proposal: null,
      proposalStatus: null,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    }
    const outgoingImages = pendingImages
    setDraft('')
    setPendingImages([])
    setError('')
    setSending(true)
    setMessages(current => [...current, temporaryMessage])
    try {
      const result = await cindyAssistantApi.sendMessage(projectUuid, content, canvasContext, cindyMode, outgoingImages)
      setMessages(current => [
        ...current.filter(message => message.id !== temporaryId && message.id !== result.userMessage.id),
        result.userMessage,
        result.assistantMessage,
      ])
    } catch (sendError) {
      setError(errorText(sendError, 'Cindy 暂时无法回复'))
      try {
        const result = await cindyAssistantApi.listMessages(projectUuid)
        setMessages(result.messages)
      } catch {
        setMessages(current => current.filter(message => message.id !== temporaryId))
      }
    } finally {
      setSending(false)
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void sendMessage()
  }

  const applyProposal = async (message: CindyAssistantMessage, autoGenerate = false) => {
    if (!message.proposal || message.proposalStatus !== 'pending' || busyMessageId) return
    if (autoGenerate) {
      const genCount = message.proposal.nodes.filter((node) => node.type === 'image' || node.type === 'video').length
      if (genCount === 0) {
        setError('这个方案里没有可自动生成的图片 / 视频节点')
        return
      }
      if (!window.confirm(`将应用方案并自动生成 ${genCount} 个图片 / 视频节点,会产生生成费用。确认?`)) return
    }
    setBusyMessageId(message.id)
    setError('')
    try {
      await onApplyProposal(message.proposal, message.id, { autoGenerate })
      setMessages(current => current.map(item => (
        item.id === message.id ? { ...item, proposalStatus: 'applied' } : item
      )))
      try {
        const result = await cindyAssistantApi.setProposalStatus(message.id, 'applied')
        setMessages(current => current.map(item => item.id === message.id ? result.message : item))
      } catch (syncError) {
        setError(`工作流已应用，但状态同步失败：${errorText(syncError, '请稍后重试')}`)
      }
    } catch (applyError) {
      setError(errorText(applyError, '工作流应用失败'))
    } finally {
      setBusyMessageId(null)
    }
  }

  const dismissProposal = async (message: CindyAssistantMessage) => {
    if (message.proposalStatus !== 'pending' || busyMessageId) return
    setBusyMessageId(message.id)
    setError('')
    try {
      const result = await cindyAssistantApi.setProposalStatus(message.id, 'dismissed')
      setMessages(current => current.map(item => item.id === message.id ? result.message : item))
    } catch (dismissError) {
      setError(errorText(dismissError, '提案状态更新失败'))
    } finally {
      setBusyMessageId(null)
    }
  }

  const launcherStyle: CSSProperties | undefined = launcherPosition
    ? { left: launcherPosition.x, top: launcherPosition.y, right: 'auto', bottom: 'auto' }
    : undefined
  const panelStyle: CSSProperties | undefined = panelPosition
    ? {
        left: panelPosition.x,
        top: panelPosition.y,
        right: 'auto',
        bottom: 'auto',
        ...(panelSize ? { width: panelSize.width, height: panelSize.height } : {}),
      }
    : undefined

  return (
    <div className="cindy-assistant-layer nodrag nopan">
      {!open && (
        <button
          ref={launcherRef}
          type="button"
          className={`cindy-assistant-launcher nodrag nopan${draggingOverlay === 'launcher' ? ' is-dragging' : ''}`}
          style={launcherStyle}
          aria-label="打开 Cindy"
          aria-expanded={false}
          onPointerDown={event => startOverlayDrag('launcher', event)}
          onPointerMove={moveOverlayDrag}
          onPointerUp={finishOverlayDrag}
          onPointerCancel={finishOverlayDrag}
          onClick={openPanelFromLauncher}
        >
          <span className="cindy-assistant-orb" aria-hidden="true"><Bot size={16} /></span>
          <span className="cindy-assistant-launcher-copy">
            <strong>Cindy</strong>
            <small>搭建工作流</small>
          </span>
        </button>
      )}

      {open && (
        <aside
          ref={panelRef}
          className={`cindy-assistant-panel nodrag nopan${panelPosition ? ' is-positioned' : ''}${draggingOverlay === 'panel' ? ' is-dragging' : ''}`}
          style={panelStyle}
          aria-label="Cindy 画布助手"
          onMouseDown={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
        >
          <header
            className="cindy-assistant-header"
            onPointerDown={event => startOverlayDrag('panel', event)}
            onPointerMove={moveOverlayDrag}
            onPointerUp={finishOverlayDrag}
            onPointerCancel={finishOverlayDrag}
          >
            <div className="cindy-assistant-identity">
              <span className="cindy-assistant-orb is-large" aria-hidden="true"><Bot size={18} /></span>
              <span>
                <strong>Cindy</strong>
                <small>{model || '画布工作流助手'}</small>
              </span>
            </div>
            <button type="button" className="cindy-assistant-icon-button" aria-label="关闭 Cindy" onClick={() => setOpen(false)}>
              <X size={17} />
            </button>
          </header>

          <div className="cindy-assistant-safety">
            <ShieldCheck size={14} />
            <span>只搭建节点与连线，不执行生成，不删除节点</span>
          </div>

          <div ref={messageListRef} className="cindy-assistant-messages" aria-live="polite">
            {loadingMessages && (
              <div className="cindy-assistant-loading"><LoaderCircle size={16} /> 正在读取本画布对话</div>
            )}

            {!loadingMessages && messages.length === 0 && (
              <div className="cindy-assistant-welcome">
                <span className="cindy-assistant-welcome-mark"><Network size={20} /></span>
                <strong>告诉我你想怎样出片</strong>
                <p>我会结合当前画布设计节点顺序和连线。方案需要你确认后才会应用。</p>
              </div>
            )}

            {messages.map(message => (
              <article key={message.id} className={`cindy-assistant-message is-${message.role}`}>
                <div className="cindy-assistant-message-meta">
                  <span>{message.role === 'assistant' ? 'Cindy' : '你'}</span>
                  <time>{formatTime(message.createdAt)}</time>
                </div>
                {message.images && message.images.length > 0 && (
                <div className="cindy-assistant-message-images">
                  {message.images.map(url => (
                    <img key={url} src={`${url}${url.includes('?') ? '&' : '?'}w=352`} alt="附图" loading="lazy" decoding="async" />
                  ))}
                </div>
              )}
              <div className="cindy-assistant-message-body">{message.content}</div>

                {message.proposal && (
                  <div className={`cindy-assistant-proposal is-${message.proposalStatus || 'pending'}`}>
                    <div className="cindy-assistant-proposal-heading">
                      <span className="cindy-assistant-proposal-icon"><Network size={15} /></span>
                      <span>
                        <strong>{message.proposal.title}</strong>
                        <small>{message.proposal.nodes.length} 个节点 · {message.proposal.connections.length} 条连线</small>
                      </span>
                    </div>
                    {message.proposal.summary && <p>{message.proposal.summary}</p>}
                    {message.proposal.nodes.length > 0 && (
                      <div className="cindy-assistant-flow-preview">{proposalFlowLabel(message.proposal)}</div>
                    )}

                    {message.proposalStatus === 'pending' && (
                      <div className="cindy-assistant-proposal-actions">
                        <button
                          type="button"
                          className="is-primary"
                          disabled={Boolean(busyMessageId)}
                          onClick={() => void applyProposal(message)}
                        >
                          {busyMessageId === message.id ? <LoaderCircle className="is-spinning" size={14} /> : <Check size={14} />}
                          应用到画布
                        </button>
                        <button
                          type="button"
                          className="is-primary"
                          disabled={Boolean(busyMessageId)}
                          onClick={() => void applyProposal(message, true)}
                        >
                          {busyMessageId === message.id ? <LoaderCircle className="is-spinning" size={14} /> : <Check size={14} />}
                          应用并生成
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(busyMessageId)}
                          onClick={() => void dismissProposal(message)}
                        >
                          暂不应用
                        </button>
                      </div>
                    )}

                    {message.proposalStatus === 'applied' && (
                      <div className="cindy-assistant-proposal-state"><Check size={13} /> 已应用到画布，可按 Ctrl+Z 撤销</div>
                    )}
                    {message.proposalStatus === 'dismissed' && (
                      <div className="cindy-assistant-proposal-state is-muted">已暂不应用</div>
                    )}
                  </div>
                )}
              </article>
            ))}

            {sending && (
              <div className="cindy-assistant-thinking">
                <span /><span /><span />
                <small>Cindy 正在理解画布</small>
              </div>
            )}
          </div>

          {error && <div className="cindy-assistant-error" role="alert">{error}</div>}

          <div
            className="cindy-assistant-composer"
            onDragOver={event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault() }}
            onDrop={handleComposerDrop}
          >
            {(pendingImages.length > 0 || uploadingImages > 0) && (
              <div className="cindy-assistant-attachments">
                {pendingImages.map(url => (
                  <span key={url} className="cindy-assistant-attachment">
                    <img src={`${url}${url.includes('?') ? '&' : '?'}w=176`} alt="待发送附图" loading="lazy" decoding="async" />
                    <button
                      type="button"
                      aria-label="移除这张图"
                      onClick={() => setPendingImages(current => current.filter(item => item !== url))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {uploadingImages > 0 && (
                  <span className="cindy-assistant-attachment is-loading">
                    <LoaderCircle className="is-spinning" size={16} />
                  </span>
                )}
              </div>
            )}
            <textarea
              value={draft}
              rows={3}
              maxLength={4000}
              placeholder="描述你想搭建的出片流程…（图片可以直接拖进来或粘贴）"
              aria-label="给 Cindy 发送消息"
              disabled={sending}
              onChange={event => setDraft(event.currentTarget.value)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
            />
            <div className="cindy-assistant-composer-footer">
              <span>Enter 发送 · Shift+Enter 换行 · 可拖入/粘贴图片</span>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={event => {
                  const files = Array.from(event.currentTarget.files || [])
                  event.currentTarget.value = ''
                  void uploadImages(files)
                }}
              />
              <button
                type="button"
                aria-label="添加图片"
                title={pendingImages.length >= MAX_PENDING_IMAGES ? `一条最多 ${MAX_PENDING_IMAGES} 张` : '添加图片'}
                disabled={sending || pendingImages.length >= MAX_PENDING_IMAGES}
                onClick={() => imageInputRef.current?.click()}
              >
                <ImagePlus size={16} />
              </button>
              <button
                type="button"
                aria-label="发送消息"
                disabled={(!draft.trim() && pendingImages.length === 0) || sending || uploadingImages > 0}
                onClick={() => void sendMessage()}
              >
                {sending ? <LoaderCircle className="is-spinning" size={16} /> : <ArrowUp size={16} />}
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}
