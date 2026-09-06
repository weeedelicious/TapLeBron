import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useStore, useUpdateNodeInternals, useViewport } from '@xyflow/react'
import { Check, Copy, Maximize2, X } from 'lucide-react'
import { NodeShell } from './NodeShell'
import { NodeTypeIcon } from './nodeTypeIcon'
import { ResizablePanelHandle, useResizablePanel, type PanelSize } from './ResizablePanelHandle'
import { useCanvasStore } from '@/store/canvasStore'
import { generateApi } from '@/lib/api'
import { TEXT_MODELS, TEXT_THINKING_MODES, defaultTextParams, normalizeTextModel } from '@/lib/nodeData'
import { liveRefUrl } from '@/lib/primaryOutput'
import type { CanvasNodeData, NodeRef, TextParams } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

type NodeLike = {
  id: string
  data: CanvasNodeData
}

type EdgeLike = {
  source: string
  target: string
}

type TextNodeRef = NodeRef & { content?: unknown }

type NormalizedTextDisplayStyle = {
  fontSize: number
  lineHeight: number
  color: string
}

const TEXT_DISPLAY_DEFAULT: NormalizedTextDisplayStyle = {
  fontSize: 16,
  lineHeight: 1.75,
  color: '#f3f0ff',
}

const TEXT_DISPLAY_FONT_MIN = 12
const TEXT_DISPLAY_FONT_MAX = 28
const TEXT_DISPLAY_LINE_HEIGHTS = [1.45, 1.65, 1.75, 1.9, 2.1]
const TEXT_DISPLAY_COLORS = ['#f3f0ff', '#ffffff', '#dbeafe', '#fde68a', '#bbf7d0', '#fecaca']

function getParams(data: CanvasNodeData): TextParams {
  if (data.params) return data.params as unknown as TextParams
  return defaultTextParams()
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function normalizeTextDisplayStyle(style?: TextParams['displayStyle']): NormalizedTextDisplayStyle {
  const color = typeof style?.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color)
    ? style.color
    : TEXT_DISPLAY_DEFAULT.color

  return {
    fontSize: Math.round(clampNumber(style?.fontSize, TEXT_DISPLAY_FONT_MIN, TEXT_DISPLAY_FONT_MAX, TEXT_DISPLAY_DEFAULT.fontSize)),
    lineHeight: Number(clampNumber(style?.lineHeight, 1.25, 2.4, TEXT_DISPLAY_DEFAULT.lineHeight).toFixed(2)),
    color,
  }
}

function cleanTextValue(value: unknown) {
  if (typeof value === 'string') return value.trim()
  if (value == null) return ''
  return String(value).trim()
}

function textContentFromNodeData(data?: CanvasNodeData | null) {
  const params = (data?.params ?? {}) as { content?: unknown; prompt?: unknown }
  return cleanTextValue(params.content) || cleanTextValue(params.prompt)
}

function findNodeByKey(nodes: NodeLike[], key?: string | null) {
  if (!key) return undefined
  return nodes.find((node) => node.id === key || node.data.nodeKey === key)
}

function resolveConnectedTexts(
  targetId: string,
  textList: TextNodeRef[] | undefined,
  nodes: NodeLike[],
  edges: EdgeLike[]
) {
  const targetNode = findNodeByKey(nodes, targetId)
  const targetKeys = new Set([targetId, targetNode?.id, targetNode?.data.nodeKey].filter(Boolean) as string[])
  const refs = new Map<string, TextNodeRef>()

  const addRef = (ref: TextNodeRef) => {
    const srcNode = findNodeByKey(nodes, ref.nodeId)
    const key = srcNode?.id ?? ref.nodeId
    if (!key || refs.has(key)) return
    refs.set(key, ref)
  }

  for (const ref of textList ?? []) {
    if (ref?.nodeId) addRef(ref)
  }

  for (const edge of edges) {
    if (!targetKeys.has(edge.target)) continue
    const srcNode = findNodeByKey(nodes, edge.source)
    if (srcNode?.data.type !== 'text') continue
    addRef({ nodeId: srcNode.id, url: '' })
  }

  return Array.from(refs.values())
    .map((ref) => {
      const srcNode = findNodeByKey(nodes, ref.nodeId)
      const content = textContentFromNodeData(srcNode?.data) || cleanTextValue(ref.content)
      return { nodeId: srcNode?.id ?? ref.nodeId, content, name: (srcNode?.data?.name as string) ?? '' }
    })
    .filter((ref) => ref.content)
}

function resolveConnectedMediaRefs(mediaList: NodeRef[] | undefined, nodes: NodeLike[]) {
  return (mediaList ?? [])
    .map((ref) => {
      const srcNode = findNodeByKey(nodes, ref.nodeId)
      // 跟着上游当前的主图 / 主视频，而不是 url[0]（上游多图时那是第一次生成的那张）。
      const liveUrl = liveRefUrl(srcNode?.data, ref.url)
      return { nodeId: srcNode?.id ?? ref.nodeId, url: liveUrl, name: (srcNode?.data?.name as string) ?? '' }
    })
    .filter((ref) => ref.url)
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // HTTP/local permission restrictions can reject the modern Clipboard API.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!copied) throw new Error('copy failed')
}

export function TextNode({ id, data, selected }: Props) {
  const { updateNodeData, updateNodeSize, nodes, edges, selectedNodeKeys, activePanelNodeId, setActivePanelNode, pushHistory } = useCanvasStore()
  const [isGenerating, setIsGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [generationStage, setGenerationStage] = useState<string | null>(null)
  const [portalRect, setPortalRect] = useState<DOMRect | null>(null)
  const [promptDraft, setPromptDraft] = useState(() => getParams(data).prompt)
  const [contentDraft, setContentDraft] = useState(() => getParams(data).content)
  const [resizeDraft, setResizeDraft] = useState<{ width: number; height: number } | null>(null)
  const [panelSize, setPanelSize] = useState<PanelSize | null>(null)
  const [copied, setCopied] = useState(false)
  const [isTextSelectionArmed, setIsTextSelectionArmed] = useState(false)
  const [contentExpanded, setContentExpanded] = useState(false)
  const [outputAreaHeightRatio, setOutputAreaHeightRatio] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const generationRunRef = useRef(0)
  const activeTaskRef = useRef<{ taskId: string; generationVersion: number } | null>(null)
  const dividerRef = useRef<HTMLDivElement>(null)
  const panelPortalRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const inlineEditorRef = useRef<HTMLTextAreaElement>(null)
  const promptFlushTimerRef = useRef<number | null>(null)
  const contentFlushTimerRef = useRef<number | null>(null)
  const copyFeedbackTimerRef = useRef<number | null>(null)
  const textSelectionTimerRef = useRef<number | null>(null)
  const outputAreaResizeSessionRef = useRef<{
    pointerId: number
    startY: number
    startHeight: number
    panelHeight: number
  } | null>(null)
  const resizeSessionRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startWidth: number
    startHeight: number
  } | null>(null)
  const promptDraftRef = useRef(promptDraft)
  const contentDraftRef = useRef(contentDraft)
  const lastSyncedPromptRef = useRef(getParams(data).prompt)
  const lastSyncedContentRef = useRef(getParams(data).content)
  const isComposingRef = useRef(false)
  const updateNodeInternals = useUpdateNodeInternals()

  const { zoom, x: vpX, y: vpY } = useViewport()
  const nodeAbsPos = useStore(
    (s) =>
      (s.nodeLookup as Map<string, { internals?: { positionAbsolute?: { x: number; y: number } } }>)?.get(id)?.internals
        ?.positionAbsolute
  )

  const minNodeWidth = 300
  const minNodeHeight = 160
  const nodeWidth = Math.max(minNodeWidth, resizeDraft?.width ?? (Number(data.contentWidth) || 512))
  const nodeHeight = Math.max(minNodeHeight, resizeDraft?.height ?? (Number(data.contentHeight) || 256))
  const panelWidth = 510
  const effectivePanelWidth = panelSize?.width ?? panelWidth
  const panelHeightForOutput = panelSize?.height ?? panelPortalRef.current?.getBoundingClientRect().height ?? 510
  const outputAreaMinHeight = 110
  const outputAreaMaxHeight = Math.max(outputAreaMinHeight, panelHeightForOutput - 178)
  const outputAreaHeight = Math.round(
    Math.min(outputAreaMaxHeight, Math.max(outputAreaMinHeight, panelHeightForOutput * (outputAreaHeightRatio ?? 0.37)))
  )
  const params = getParams(data)
  const textDisplayStyle = normalizeTextDisplayStyle(params.displayStyle)
  const nodeTextTypographyStyle: CSSProperties = {
    fontSize: `calc(${textDisplayStyle.fontSize}px * var(--canvas-text-scale, 1))`,
    lineHeight: textDisplayStyle.lineHeight,
    color: textDisplayStyle.color,
  }
  const panelTextTypographyStyle: CSSProperties = {
    fontSize: textDisplayStyle.fontSize,
    lineHeight: textDisplayStyle.lineHeight,
    color: textDisplayStyle.color,
  }
  const manualMode = Boolean(params.manualMode)
  const hasGenerated = Boolean(params.hasGenerated)
  const showManualWriteButton = !manualMode && !hasGenerated && !params.content.trim()
  const isPanelOpen = !manualMode && activePanelNodeId === id && selectedNodeKeys.length === 1 && selectedNodeKeys[0] === id
  const handlePanelResizeStart = useResizablePanel(panelPortalRef, setPanelSize, {
    minWidth: 420,
    minHeight: 210,
  })

  useEffect(() => {
    promptDraftRef.current = promptDraft
  }, [promptDraft])

  useEffect(() => {
    contentDraftRef.current = contentDraft
  }, [contentDraft])

  useEffect(() => {
    if (params.prompt === lastSyncedPromptRef.current) return
    lastSyncedPromptRef.current = params.prompt
    setPromptDraft(params.prompt)
  }, [params.prompt])

  useEffect(() => {
    if (params.content === lastSyncedContentRef.current) return
    lastSyncedContentRef.current = params.content
    setContentDraft(params.content)
  }, [params.content])

  useEffect(() => {
    if (!manualMode) return
    window.requestAnimationFrame(() => {
      inlineEditorRef.current?.focus()
    })
  }, [manualMode])

  useLayoutEffect(() => {
    if (!isPanelOpen) {
      setPortalRect(null)
      return
    }
    setPortalRect(dividerRef.current?.getBoundingClientRect() ?? null)
  }, [isPanelOpen, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y])

  useEffect(() => {
    updateNodeInternals(id)
  }, [id, updateNodeInternals])

  const patchParams = useCallback(
    (patch: Partial<TextParams>) => {
      const freshNode = useCanvasStore.getState().nodes.find((n) => n.id === id || n.data.nodeKey === id)
      const current = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
      updateNodeData(id, { params: { ...current, ...patch } as unknown as Record<string, unknown> })
    },
    [id, params, updateNodeData]
  )

  const setParam = useCallback(
    <K extends keyof TextParams>(key: K, val: TextParams[K]) => {
      patchParams({ [key]: val } as Partial<TextParams>)
    },
    [patchParams]
  )

  const patchDisplayStyle = useCallback(
    (patch: Partial<NormalizedTextDisplayStyle>) => {
      const freshNode = useCanvasStore.getState().nodes.find((n) => n.id === id || n.data.nodeKey === id)
      const current = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
      const currentStyle = normalizeTextDisplayStyle(current.displayStyle)
      const nextStyle = normalizeTextDisplayStyle({ ...currentStyle, ...patch })
      if (
        nextStyle.fontSize === currentStyle.fontSize &&
        nextStyle.lineHeight === currentStyle.lineHeight &&
        nextStyle.color === currentStyle.color
      ) {
        return
      }
      updateNodeData(id, {
        params: { ...current, displayStyle: nextStyle } as unknown as Record<string, unknown>,
      })
    },
    [id, params, updateNodeData]
  )

  const adjustDisplayFontSize = useCallback(
    (delta: number) => {
      patchDisplayStyle({ fontSize: textDisplayStyle.fontSize + delta })
    },
    [patchDisplayStyle, textDisplayStyle.fontSize]
  )

  const cycleDisplayLineHeight = useCallback(() => {
    const currentIndex = TEXT_DISPLAY_LINE_HEIGHTS.findIndex((value) => value >= textDisplayStyle.lineHeight - 0.01)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % TEXT_DISPLAY_LINE_HEIGHTS.length : 0
    patchDisplayStyle({ lineHeight: TEXT_DISPLAY_LINE_HEIGHTS[nextIndex] })
  }, [patchDisplayStyle, textDisplayStyle.lineHeight])

  const flushPromptDraft = useCallback(
    (nextPrompt?: string) => {
      const value = typeof nextPrompt === 'string' ? nextPrompt : promptDraftRef.current
      if (promptFlushTimerRef.current !== null) {
        window.clearTimeout(promptFlushTimerRef.current)
        promptFlushTimerRef.current = null
      }
      if (value === lastSyncedPromptRef.current) return
      lastSyncedPromptRef.current = value
      setParam('prompt', value)
    },
    [setParam]
  )

  const schedulePromptFlush = useCallback(
    (nextPrompt: string) => {
      if (promptFlushTimerRef.current !== null) {
        window.clearTimeout(promptFlushTimerRef.current)
      }
      promptFlushTimerRef.current = window.setTimeout(() => {
        promptFlushTimerRef.current = null
        flushPromptDraft(nextPrompt)
      }, 180)
    },
    [flushPromptDraft]
  )

  const flushContentDraft = useCallback(
    (nextContent?: string) => {
      const value = typeof nextContent === 'string' ? nextContent : contentDraftRef.current
      if (contentFlushTimerRef.current !== null) {
        window.clearTimeout(contentFlushTimerRef.current)
        contentFlushTimerRef.current = null
      }
      if (value === lastSyncedContentRef.current) return
      lastSyncedContentRef.current = value
      setParam('content', value)
    },
    [setParam]
  )

  const scheduleContentFlush = useCallback(
    (nextContent: string) => {
      if (contentFlushTimerRef.current !== null) {
        window.clearTimeout(contentFlushTimerRef.current)
      }
      contentFlushTimerRef.current = window.setTimeout(() => {
        contentFlushTimerRef.current = null
        flushContentDraft(nextContent)
      }, 180)
    },
    [flushContentDraft]
  )

  useEffect(() => {
    if (isPanelOpen) return
    setPanelSize(null)
    flushPromptDraft()
  }, [flushPromptDraft, isPanelOpen])

  useEffect(() => {
    if (!manualMode) return
    return () => {
      flushContentDraft()
    }
  }, [flushContentDraft, manualMode])

  useEffect(() => {
    return () => {
      if (promptFlushTimerRef.current !== null) {
        window.clearTimeout(promptFlushTimerRef.current)
      }
      if (contentFlushTimerRef.current !== null) {
        window.clearTimeout(contentFlushTimerRef.current)
      }
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current)
      }
      if (textSelectionTimerRef.current !== null) {
        window.clearTimeout(textSelectionTimerRef.current)
      }
    }
  }, [])

  const connectedImages = resolveConnectedMediaRefs(params.imageList as NodeRef[] | undefined, nodes)

  const connectedTexts = resolveConnectedTexts(id, params.textList as TextNodeRef[] | undefined, nodes, edges)

  const connectedVideos = resolveConnectedMediaRefs(params.videoList as NodeRef[] | undefined, nodes)

  const handleGenerate = useCallback(async () => {
    const state = useCanvasStore.getState()
    const freshNode = findNodeByKey(state.nodes, id)
    const freshParams = getParams((freshNode?.data as CanvasNodeData | undefined) ?? data)
    const freshConnectedImages = resolveConnectedMediaRefs(freshParams.imageList as NodeRef[] | undefined, state.nodes)
    const freshConnectedTexts = resolveConnectedTexts(
      id,
      freshParams.textList as TextNodeRef[] | undefined,
      state.nodes,
      state.edges
    )
    const freshConnectedVideos = resolveConnectedMediaRefs(freshParams.videoList as NodeRef[] | undefined, state.nodes)
    const effectivePrompt = promptDraftRef.current.trim()
    const freshTextContext = freshConnectedTexts
      .map((ref, index) => {
        const label = ref.name?.trim() || `文本节点 ${index + 1}`
        return `[${label}]\n${ref.content}`
      })
      .join('\n\n')
    if (!effectivePrompt && freshConnectedTexts.length === 0 && freshConnectedImages.length === 0 && freshConnectedVideos.length === 0) {
      setGenError('请先填写提示词，或连接文本 / 图片 / 视频素材作为输入')
      return
    }
    flushPromptDraft(promptDraftRef.current)
    patchParams({ hasGenerated: true, manualMode: false })
    setGenError(null)
    setGenerationStage(null)
    setIsGenerating(true)

    const runId = generationRunRef.current + 1
    generationRunRef.current = runId
    const startingContent = freshParams.content
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const clientRequestId = generateApi.requestId()

    let output = ''
    try {
      const resp = await fetch('/api/generate/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectUuid: data.projectUuid,
          nodeKey: id,
          clientRequestId,
          params: {
            prompt: promptDraftRef.current,
            model: normalizeTextModel(freshParams.model),
            thinkingMode: freshParams.thinkingMode ?? 'fast',
            performanceMode: freshParams.performanceMode ?? 'highest',
            reasoningEffort: freshParams.reasoningEffort ?? 'high',
            imageList: freshConnectedImages.map((r) => ({ nodeId: r.nodeId, url: r.url })),
            videoList: freshConnectedVideos.map((r) => ({ nodeId: r.nodeId, url: r.url })),
            textList: freshConnectedTexts.map((r) => ({ nodeId: r.nodeId, url: '', content: r.content, name: r.name })),
            textContext: freshTextContext,
          },
        }),
        signal: ctrl.signal,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }))
        throw new Error(err.error ?? 'LLM 请求失败')
      }

      const reader = resp.body?.getReader()
      if (!reader) throw new Error('LLM 响应为空')
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const raw = trimmed.slice(5).trim()
          if (raw === '[DONE]') break
          try {
            const parsed = JSON.parse(raw)
            if (runId !== generationRunRef.current) continue
            if (parsed.error) throw new Error(parsed.error)
            if (parsed.task?.taskId) {
              const currentNode = findNodeByKey(useCanvasStore.getState().nodes, id)
              const previousVersion = Number((currentNode?.data as CanvasNodeData | undefined)?._generationVersion || 0)
              const generationVersion = Math.max(1, Number(parsed.task.generationVersion || 0) || previousVersion + 1)
              activeTaskRef.current = { taskId: String(parsed.task.taskId), generationVersion }
              useCanvasStore.getState().updateNodeData(id, { _generationVersion: generationVersion })
            }
            if (parsed.stage) {
              setGenerationStage(String(parsed.stage))
            }
            if (parsed.delta) {
              output += parsed.delta
              const freshNode = useCanvasStore.getState().nodes.find((n) => n.id === id)
              const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : freshParams
              useCanvasStore.getState().updateNodeData(id, {
                params: { ...currentParams, content: output, hasGenerated: true, manualMode: false } as unknown as Record<string, unknown>,
              })
              if (outputRef.current) {
                outputRef.current.scrollTop = outputRef.current.scrollHeight
              }
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'JSON parse fail') throw e
          }
        }
      }
      const completedTask = activeTaskRef.current
      if (runId === generationRunRef.current && completedTask) {
        const task = await generateApi.poll(completedTask.taskId)
        if (task.meta?.shouldApply === false) {
          const currentNode = findNodeByKey(useCanvasStore.getState().nodes, id)
          const currentParams = currentNode ? getParams(currentNode.data as CanvasNodeData) : freshParams
          useCanvasStore.getState().updateNodeData(id, {
            params: { ...currentParams, content: startingContent } as unknown as Record<string, unknown>,
          })
          setGenError('本次结果已被更新的生成任务取代，未覆盖当前内容')
        } else {
          void generateApi.apply(completedTask.taskId).catch(error => console.warn('mark text task applied failed', error))
        }
      }
    } catch (e: unknown) {
      if (runId === generationRunRef.current && (e as { name?: string }).name !== 'AbortError') {
        const errorMessage = e instanceof Error ? e.message : String(e)
        setGenError(errorMessage)
        generateApi.reportError({
          clientRequestId,
          taskId: activeTaskRef.current?.taskId,
          projectUuid: data.projectUuid,
          nodeKey: id,
          operationType: 'text',
          endpoint: '/generate/llm',
          model: normalizeTextModel(freshParams.model),
          mode: String(freshParams.thinkingMode || 'fast'),
          errorMessage,
          params: {
            prompt: promptDraftRef.current,
            model: normalizeTextModel(freshParams.model),
            thinkingMode: freshParams.thinkingMode ?? 'fast',
            performanceMode: freshParams.performanceMode ?? 'highest',
            reasoningEffort: freshParams.reasoningEffort ?? 'high',
            imageList: freshConnectedImages.map((ref) => ({ nodeId: ref.nodeId, url: ref.url })),
            videoList: freshConnectedVideos.map((ref) => ({ nodeId: ref.nodeId, url: ref.url })),
            textList: freshConnectedTexts.map((ref) => ({ nodeId: ref.nodeId, content: ref.content, name: ref.name })),
          },
        })
      }
    } finally {
      if (runId === generationRunRef.current) {
        activeTaskRef.current = null
        setIsGenerating(false)
        setGenerationStage(null)
      }
    }
  }, [data, flushPromptDraft, id, patchParams])

  const preview = manualMode
    ? contentDraft
    : params.content
      ? params.content.replace(/\n/g, '\n')
      : promptDraft
        ? promptDraft
        : ''
  const fullContentText = (params.content || contentDraft || '').trim()

  const handleCopy = useCallback(async () => {
    const value = (manualMode ? contentDraft : params.content || promptDraft || '').trim()
    if (!value) return
    try {
      await copyTextToClipboard(value)
      setCopied(true)
      if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current)
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopied(false)
        copyFeedbackTimerRef.current = null
      }, 1200)
    } catch (error) {
      console.warn('Copy text failed', error)
    }
  }, [contentDraft, manualMode, params.content, promptDraft])

  const handleClear = useCallback(() => {
    setParam('content', '')
    setGenError(null)
  }, [setParam])

  const handleEnableManualWriting = useCallback(() => {
    setActivePanelNode(null)
    patchParams({ manualMode: true })
  }, [patchParams, setActivePanelNode])

  const removeConnectedText = useCallback((nodeId: string) => {
    const state = useCanvasStore.getState()
    const freshNode = state.nodes.find((n) => n.id === id || n.data.nodeKey === id)
    const current = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const nextTextList = ((current.textList ?? []) as Array<NodeRef & { content?: string }>).filter((ref) => ref.nodeId !== nodeId)
    state.pushHistory()
    state.updateNodeData(id, { params: { ...current, textList: nextTextList } as unknown as Record<string, unknown> })
    state.setEdges(state.edges.filter((edge) => !(edge.source === nodeId && edge.target === id)))
  }, [id, params])

  const handleStop = useCallback(() => {
    generationRunRef.current += 1
    abortRef.current?.abort()
    if (activeTaskRef.current) {
      void generateApi.cancel(activeTaskRef.current.taskId).catch(() => undefined)
      activeTaskRef.current = null
    }
    setIsGenerating(false)
    setGenerationStage(null)
  }, [])

  const handleNodeBodyClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.shiftKey) return
    if ((event.target as Element | null)?.closest('.nodrag')) return
    setActivePanelNode(id)
  }, [id, setActivePanelNode])

  const handleTextResizeStart = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Some browsers may already release capture when React Flow handles selection.
    }
    const session = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: nodeWidth,
      startHeight: nodeHeight,
    }
    resizeSessionRef.current = session
    pushHistory()
    setResizeDraft({ width: nodeWidth, height: nodeHeight })

    function move(moveEvent: globalThis.PointerEvent) {
      if (resizeSessionRef.current?.pointerId !== session.pointerId) return
      const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
      const nextWidth = Math.max(minNodeWidth, Math.round(session.startWidth + (moveEvent.clientX - session.startX) / safeZoom))
      const nextHeight = Math.max(minNodeHeight, Math.round(session.startHeight + (moveEvent.clientY - session.startY) / safeZoom))
      setResizeDraft({ width: nextWidth, height: nextHeight })
      updateNodeInternals(id)
    }

    function cleanupResizeListeners() {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('blur', cancel)
    }

    function finish(finishEvent: globalThis.PointerEvent) {
      if (resizeSessionRef.current?.pointerId !== session.pointerId) return
      const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
      const nextWidth = Math.max(minNodeWidth, Math.round(session.startWidth + (finishEvent.clientX - session.startX) / safeZoom))
      const nextHeight = Math.max(minNodeHeight, Math.round(session.startHeight + (finishEvent.clientY - session.startY) / safeZoom))
      resizeSessionRef.current = null
      setResizeDraft(null)
      updateNodeSize(id, nextWidth, nextHeight)
      updateNodeInternals(id)
      cleanupResizeListeners()
    }

    function cancel() {
      if (resizeSessionRef.current?.pointerId !== session.pointerId) return
      resizeSessionRef.current = null
      setResizeDraft(null)
      updateNodeInternals(id)
      cleanupResizeListeners()
    }

    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', cancel)
  }, [id, minNodeHeight, minNodeWidth, nodeHeight, nodeWidth, pushHistory, updateNodeInternals, updateNodeSize, zoom])

  const handleOutputAreaResizeStart = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Window listeners below keep the drag stable even without pointer capture.
    }
    const panelHeight = panelPortalRef.current?.getBoundingClientRect().height ?? panelHeightForOutput
    const session = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: outputAreaHeight,
      panelHeight: Math.max(260, panelHeight),
    }
    outputAreaResizeSessionRef.current = session

    const applyResize = (clientY: number) => {
      const maxHeight = Math.max(outputAreaMinHeight, session.panelHeight - 178)
      const nextHeight = Math.min(maxHeight, Math.max(outputAreaMinHeight, Math.round(session.startHeight + clientY - session.startY)))
      setOutputAreaHeightRatio(nextHeight / session.panelHeight)
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('blur', cancel)
      outputAreaResizeSessionRef.current = null
    }

    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== session.pointerId) return
      moveEvent.preventDefault()
      applyResize(moveEvent.clientY)
    }

    const finish = (finishEvent: globalThis.PointerEvent) => {
      if (finishEvent.pointerId !== session.pointerId) return
      applyResize(finishEvent.clientY)
      cleanup()
    }

    const cancel = () => {
      cleanup()
    }

    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', cancel)
  }, [outputAreaHeight, outputAreaMinHeight, panelHeightForOutput])

  const armTextSelection = useCallback((duration = 850) => {
    if (textSelectionTimerRef.current !== null) {
      window.clearTimeout(textSelectionTimerRef.current)
    }
    setIsTextSelectionArmed(true)
    textSelectionTimerRef.current = window.setTimeout(() => {
      textSelectionTimerRef.current = null
      setIsTextSelectionArmed(false)
    }, duration)
  }, [])

  const handleSelectableTextPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const isSecondClick = event.detail >= 2 || textSelectionTimerRef.current !== null
      if (!isSecondClick) return
      event.stopPropagation()
      armTextSelection(1800)
    },
    [armTextSelection]
  )

  const handleSelectableTextMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const isSecondClick = event.detail >= 2 || textSelectionTimerRef.current !== null
      if (!isSecondClick) return
      event.stopPropagation()
      armTextSelection(1800)
    },
    [armTextSelection]
  )

  const renderDisplayControls = (variant: 'node' | 'panel' | 'modal') => {
    const isNode = variant === 'node'
    const isModal = variant === 'modal'
    const controlHeight = isNode ? 28 : 30
    const buttonStyle: CSSProperties = {
      height: controlHeight,
      minWidth: isNode ? 28 : 32,
      padding: isNode ? '0 7px' : '0 9px',
      borderRadius: 9,
      border: '1px solid rgba(196,181,253,0.18)',
      background: 'rgba(17,14,26,0.76)',
      color: '#e7ddff',
      cursor: 'pointer',
      fontSize: isNode ? 11 : 12,
      fontWeight: 700,
      lineHeight: 1,
    }
    const disabledButtonStyle: CSSProperties = {
      ...buttonStyle,
      cursor: 'default',
      opacity: 0.42,
    }

    return (
      <div
        className="nodrag nopan nowheel"
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
        }}
        onWheel={(event) => {
          event.stopPropagation()
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: isNode ? 4 : 6,
          padding: isNode ? 3 : '4px 5px',
          borderRadius: isNode ? 10 : 11,
          border: '1px solid rgba(196,181,253,0.14)',
          background: isModal ? 'rgba(255,255,255,0.055)' : 'rgba(10,8,18,0.64)',
          boxShadow: '0 10px 24px rgba(0,0,0,0.24)',
          backdropFilter: 'blur(10px)',
          pointerEvents: 'auto',
        }}
      >
        {!isNode && (
          <span
            style={{
              padding: '0 3px',
              color: 'rgba(216,207,253,0.66)',
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: 'nowrap',
            }}
          >
            阅读
          </span>
        )}
        <button
          type="button"
          className="nodrag nopan"
          title="字号减小"
          disabled={textDisplayStyle.fontSize <= TEXT_DISPLAY_FONT_MIN}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            adjustDisplayFontSize(-1)
          }}
          style={textDisplayStyle.fontSize <= TEXT_DISPLAY_FONT_MIN ? disabledButtonStyle : buttonStyle}
        >
          A-
        </button>
        <span
          style={{
            minWidth: isNode ? 34 : 42,
            textAlign: 'center',
            color: '#f4f0ff',
            fontSize: isNode ? 11 : 12,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {textDisplayStyle.fontSize}px
        </span>
        <button
          type="button"
          className="nodrag nopan"
          title="字号增大"
          disabled={textDisplayStyle.fontSize >= TEXT_DISPLAY_FONT_MAX}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            adjustDisplayFontSize(1)
          }}
          style={textDisplayStyle.fontSize >= TEXT_DISPLAY_FONT_MAX ? disabledButtonStyle : buttonStyle}
        >
          A+
        </button>
        <label
          className="nodrag nopan"
          title="字体颜色"
          style={{
            width: controlHeight,
            height: controlHeight,
            borderRadius: 9,
            border: '1px solid rgba(196,181,253,0.2)',
            background: 'rgba(17,14,26,0.76)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              width: isNode ? 16 : 18,
              height: isNode ? 16 : 18,
              borderRadius: 999,
              background: textDisplayStyle.color,
              boxShadow: '0 0 0 1px rgba(255,255,255,0.5) inset',
            }}
          />
          <input
            type="color"
            value={textDisplayStyle.color}
            aria-label="字体颜色"
            onChange={(event) => {
              patchDisplayStyle({ color: event.currentTarget.value })
            }}
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: 'none',
            }}
          />
        </label>
        {!isNode && TEXT_DISPLAY_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="nodrag nopan"
            title={`颜色 ${color}`}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              patchDisplayStyle({ color })
            }}
            style={{
              width: 20,
              height: 20,
              padding: 0,
              borderRadius: 999,
              border: color.toLowerCase() === textDisplayStyle.color.toLowerCase()
                ? '2px solid #ffffff'
                : '1px solid rgba(255,255,255,0.36)',
              background: color,
              cursor: 'pointer',
              boxShadow: color.toLowerCase() === textDisplayStyle.color.toLowerCase()
                ? '0 0 0 2px rgba(124,92,252,0.35)'
                : 'none',
            }}
          />
        ))}
        <button
          type="button"
          className="nodrag nopan"
          title="切换行距"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            cycleDisplayLineHeight()
          }}
          style={{
            ...buttonStyle,
            minWidth: isNode ? 40 : 48,
            fontWeight: 600,
          }}
        >
          {textDisplayStyle.lineHeight.toFixed(2)}x
        </button>
      </div>
    )
  }

  const panelLeft = portalRect
    ? Math.min(
        Math.max(16, portalRect.left + (portalRect.width - effectivePanelWidth) / 2),
        Math.max(16, window.innerWidth - effectivePanelWidth - 16)
      )
    : 16

  return (
    <>
      <NodeShell
        nodeKey={id}
        data={data}
        selected={selected}
        minWidth={nodeWidth}
        minHeight={nodeHeight}
        resizeHandle="none"
        bodyStyle={{ width: nodeWidth, height: nodeHeight }}
      >
        <div
          onClick={handleNodeBodyClick}
          style={{ position: 'relative', width: nodeWidth, height: nodeHeight, background: '#0d0b18' }}
        >
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              zIndex: 82,
              maxWidth: 'calc(100% - 56px)',
            }}
          >
            {renderDisplayControls('node')}
          </div>
          <button
            type="button"
            className="nodrag nopan shotflow-node-popover-backdrop shotflow-node-popover-text-expanded"
            title={copied ? '已复制' : '复制文本'}
            aria-disabled={!preview.trim()}
            onPointerDown={(event) => {
              event.stopPropagation()
            }}
            onMouseDown={(event) => {
              event.stopPropagation()
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void handleCopy()
            }}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 80,
              width: 30,
              height: 30,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid rgba(196,181,253,0.18)',
              borderRadius: 8,
              background: copied ? 'rgba(124,92,252,0.32)' : 'rgba(13,11,24,0.48)',
              color: copied ? '#f4f0ff' : 'rgba(216,207,255,0.78)',
              cursor: preview.trim() ? 'pointer' : 'default',
              opacity: preview.trim() ? 0.86 : 0.28,
              backdropFilter: 'blur(8px)',
              pointerEvents: 'auto',
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <div
            style={{
              height: nodeHeight,
              padding: '48px 48px 12px 14px',
              overflowY: 'auto',
              scrollbarWidth: 'thin',
              scrollbarColor: '#312550 transparent',
            }}
          >
            {manualMode ? (
              <textarea
                ref={inlineEditorRef}
                className="nodrag nopan"
                value={contentDraft}
                placeholder="在这里编写内容"
                onPointerDown={(event) => {
                  event.stopPropagation()
                }}
                onMouseDown={(event) => {
                  event.stopPropagation()
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                }}
                onKeyDown={(event) => {
                  event.stopPropagation()
                }}
                onChange={(event) => {
                  const nextContent = event.target.value
                  setContentDraft(nextContent)
                  if (!isComposingRef.current) {
                    scheduleContentFlush(nextContent)
                  }
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true
                }}
                onCompositionEnd={(event) => {
                  isComposingRef.current = false
                  const nextContent = event.currentTarget.value
                  setContentDraft(nextContent)
                  flushContentDraft(nextContent)
                }}
                onBlur={(event) => {
                  flushContentDraft(event.currentTarget.value)
                }}
                style={{
                  width: '100%',
                  height: '100%',
                  margin: 0,
                  padding: 0,
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  background: 'transparent',
                  color: nodeTextTypographyStyle.color,
                  fontFamily: 'inherit',
                  fontSize: nodeTextTypographyStyle.fontSize,
                  lineHeight: nodeTextTypographyStyle.lineHeight,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  scrollbarWidth: 'thin',
                  scrollbarColor: '#312550 transparent',
                }}
              />
            ) : preview ? (
              <div
                className={isTextSelectionArmed ? 'nodrag nopan' : undefined}
                onClick={() => armTextSelection()}
                onPointerDown={handleSelectableTextPointerDown}
                onMouseDown={handleSelectableTextMouseDown}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  armTextSelection(1800)
                }}
                style={{
                  margin: 0,
                  ...nodeTextTypographyStyle,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  cursor: 'text',
                  userSelect: 'text',
                  WebkitUserSelect: 'text',
                }}
              >
                {preview}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" opacity={0.15}>
                  <rect x="4" y="6" width="20" height="3" rx="1.5" fill="#c4b5fd" />
                  <rect x="4" y="12" width="16" height="3" rx="1.5" fill="#c4b5fd" />
                  <rect x="4" y="18" width="12" height="3" rx="1.5" fill="#c4b5fd" />
                </svg>
              </div>
            )}
          </div>
          {showManualWriteButton && (
            <button
              type="button"
              className="nodrag nopan shotflow-node-popover-shell"
              onPointerDown={(event) => {
                event.stopPropagation()
              }}
              onMouseDown={(event) => {
                event.stopPropagation()
              }}
              onDoubleClick={(event) => {
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                handleEnableManualWriting()
              }}
              style={{
                position: 'absolute',
                left: '50%',
                top: preview ? 'auto' : '50%',
                bottom: preview ? 14 : 'auto',
                transform: preview ? 'translateX(-50%)' : 'translate(-50%, -50%)',
                zIndex: 90,
                minWidth: 132,
                height: 36,
                padding: '0 16px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.16)',
                background: 'linear-gradient(180deg, rgba(58,52,74,0.92), rgba(36,31,48,0.92))',
                color: '#f8f5ff',
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: 0,
                boxShadow: '0 10px 28px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.08)',
                backdropFilter: 'blur(10px)',
                cursor: 'pointer',
              }}
            >
              自己编写内容
            </button>
          )}
          {selected && (
            <button
              type="button"
              className="text-node-resize-corner nodrag nopan"
              title="拖动调整文本节点大小"
              aria-label="拖动调整文本节点大小"
              onPointerDown={handleTextResizeStart}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
            >
              <span />
            </button>
          )}
            </div>

        <div ref={dividerRef} style={{ height: 0 }} />
      </NodeShell>

      {isPanelOpen &&
        portalRect &&
        createPortal(
          <div
            ref={panelPortalRef}
            className="nodrag shotflow-node-popover shotflow-node-popover-text"
            style={{
              position: 'fixed',
              top: portalRect.bottom + 6,
              left: panelLeft,
              width: effectivePanelWidth,
              ...(panelSize ? { height: panelSize.height, overflow: 'visible' } : {}),
              zIndex: 1000,
              background: '#171320',
              borderRadius: 10,
              border: '1px solid rgba(124,92,252,0.18)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.42)',
            }}
          >
            <div className="shotflow-node-popover-shell" style={{
              padding: '0 6px 6px',
              ...(panelSize ? { height: '100%', overflow: 'hidden', boxSizing: 'border-box' as const, display: 'flex', flexDirection: 'column' as const } : {}),
            }}>
              <div className="shotflow-node-popover-content" style={{ background: '#14111d', borderRadius: 10, border: '1px solid rgba(124,92,252,0.16)', overflow: 'hidden', ...(panelSize ? { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' as const } : {}) }}>
                {(connectedImages.length > 0 || connectedVideos.length > 0 || connectedTexts.length > 0) && (
                  <div className="flex items-center gap-1 px-2 pt-1.5 pb-1.5 shotflow-node-popover-reference-row" style={{ flexWrap: 'wrap', ...(panelSize ? { flexShrink: 0 } : {}) }}>
                    {connectedImages.map((ref, i) => (
                      <div
                        key={ref.nodeId}
                        className="relative rounded-lg overflow-hidden nodrag"
                        style={{ width: 34, height: 32, border: '1px solid rgba(124,92,252,0.18)', borderRadius: 7, flexShrink: 0 }}
                      >
                        <img src={ref.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            background: 'rgba(13,10,26,0.72)',
                            fontSize: 8,
                            color: '#c4b5fd',
                            textAlign: 'center',
                            padding: '1px 0',
                          }}
                        >
                          图{i + 1}
                        </div>
                      </div>
                    ))}
                    {connectedVideos.map((ref, i) => (
                      <div
                        key={ref.nodeId}
                        className="relative rounded-lg overflow-hidden nodrag"
                        style={{
                          width: 34,
                          height: 32,
                          border: '1px solid rgba(124,92,252,0.18)',
                          flexShrink: 0,
                          background: '#0d0b18',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <span style={{ fontSize: 18, opacity: 0.5 }}>▶</span>
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            background: 'rgba(13,10,26,0.72)',
                            fontSize: 8,
                            color: '#c4b5fd',
                            textAlign: 'center',
                            padding: '1px 0',
                          }}
                        >
                          视频{i + 1}
                        </div>
                      </div>
                    ))}
                    {connectedTexts.map((ref, i) => (
                      <div
                        key={ref.nodeId}
                        className="nodrag"
                        style={{
                          height: 32,
                          padding: '3px 20px 3px 7px',
                          border: '1px solid rgba(124,92,252,0.18)',
                          borderRadius: 7,
                          background: '#1e1830',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          position: 'relative',
                          maxWidth: 116,
                          overflow: 'hidden',
                        }}
                      >
                        <NodeTypeIcon type="text" size={12} strokeWidth={1.8} style={{ flexShrink: 0, color: '#cfc5ff' }} />
                        <span style={{ fontSize: 0, color: '#c4b5fd', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ fontSize: 9 }}>{ref.name || `文本节点 ${i + 1}`}</span>
                          文本 {ref.name || `${i + 1}`}
                        </span>
                        <button
                          type="button"
                          className="nodrag nopan"
                          title="Remove text reference"
                          onPointerDown={(event) => {
                            event.stopPropagation()
                          }}
                          onMouseDown={(event) => {
                            event.stopPropagation()
                          }}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            removeConnectedText(ref.nodeId)
                          }}
                          style={{
                            position: 'absolute',
                            top: 3,
                            right: 3,
                            width: 13,
                            height: 13,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: '1px solid rgba(196,181,253,0.18)',
                            borderRadius: 999,
                            background: 'rgba(8,7,13,0.62)',
                            color: 'rgba(232,226,255,0.82)',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                        >
                          <X size={9} strokeWidth={2.2} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="shotflow-node-popover-prompt-area" style={{ padding: '5px 10px 4px', ...(panelSize ? { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' as const } : {}) }}>
                  <div className="nodrag shotflow-node-popover-scroll" style={{ maxHeight: panelSize ? 'none' : 220, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#312550 transparent', ...(panelSize ? { flex: '1 1 auto', minHeight: 0 } : {}) }}>
                    <textarea
                      className="nodrag"
                      style={{
                        width: '100%',
                        minHeight: 96,
                        background: 'none',
                        border: 'none',
                        outline: 'none',
                        color: '#d0c8f0',
                        fontSize: 13,
                        lineHeight: 1.45,
                        resize: 'none',
                        fontFamily: 'inherit',
                        wordBreak: 'break-word',
                      }}
                      placeholder="输入指令，例如：根据图片写一段角色描述"
                      value={promptDraft}
                      onChange={(e) => {
                        const nextPrompt = e.target.value
                        setPromptDraft(nextPrompt)
                        if (!isComposingRef.current) {
                          schedulePromptFlush(nextPrompt)
                        }
                      }}
                      onCompositionStart={() => {
                        isComposingRef.current = true
                      }}
                      onCompositionEnd={(e) => {
                        isComposingRef.current = false
                        const nextPrompt = e.currentTarget.value
                        setPromptDraft(nextPrompt)
                        flushPromptDraft(nextPrompt)
                      }}
                      onBlur={(e) => {
                        flushPromptDraft(e.currentTarget.value)
                      }}
                    />
                  </div>
                </div>

                {(params.content || isGenerating) && (
                  <div className="shotflow-node-popover-output" style={{ borderTop: '1px solid rgba(124,92,252,0.12)', padding: '5px 10px 6px', position: 'relative', ...(panelSize ? { flexShrink: 0 } : {}) }}>
                    {params.content && (
                      <button
                        type="button"
                        className="nodrag nopan"
                        title="展开浏览全部"
                        aria-label="展开浏览全部"
                        onPointerDown={(event) => {
                          event.stopPropagation()
                        }}
                        onMouseDown={(event) => {
                          event.stopPropagation()
                        }}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setContentExpanded(true)
                        }}
                        style={{
                          position: 'absolute',
                          top: 7,
                          right: 12,
                          width: 24,
                          height: 24,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 8,
                          border: '1px solid rgba(196,181,253,0.18)',
                          background: 'rgba(20,17,29,0.82)',
                          color: '#d8cffd',
                          cursor: 'pointer',
                          padding: 0,
                          boxShadow: '0 8px 18px rgba(0,0,0,0.28)',
                          backdropFilter: 'blur(8px)',
                        }}
                      >
                        <Maximize2 size={13} strokeWidth={2} />
                      </button>
                    )}
                    <div style={{ marginBottom: 6, paddingRight: params.content ? 30 : 0 }}>
                      {renderDisplayControls('panel')}
                    </div>
                    {isGenerating && generationStage && (
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          maxWidth: 'calc(100% - 34px)',
                          marginBottom: 5,
                          padding: '3px 8px',
                          borderRadius: 999,
                          border: '1px solid rgba(167,139,250,0.22)',
                          background: 'rgba(41,31,67,0.72)',
                          color: '#d8ccff',
                          fontSize: 11,
                          lineHeight: 1.2,
                        }}
                      >
                        <span
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: 999,
                            background: '#a78bfa',
                            boxShadow: '0 0 10px rgba(167,139,250,0.75)',
                          }}
                        />
                        {generationStage}
                      </div>
                    )}
                    <div
                      ref={outputRef}
                      className="nodrag"
                      style={{
                        height: outputAreaHeight,
                        maxHeight: outputAreaHeight,
                        minHeight: outputAreaMinHeight,
                        paddingRight: params.content ? 30 : 0,
                        overflowY: 'auto',
                        scrollbarWidth: 'thin',
                        scrollbarColor: '#312550 transparent',
                        ...panelTextTypographyStyle,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {params.content}
                      {isGenerating && (
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 14,
                            background: '#7c5cfc',
                            borderRadius: 2,
                            marginLeft: 2,
                            verticalAlign: 'middle',
                            animation: 'spin 0.8s linear infinite',
                          }}
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className="nodrag nopan"
                      title="上下拖动调整内容区域高度"
                      aria-label="上下拖动调整内容区域高度"
                      onPointerDown={handleOutputAreaResizeStart}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      style={{
                        width: 54,
                        height: 13,
                        margin: '4px auto 0',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1px solid rgba(196,181,253,0.16)',
                        borderRadius: 999,
                        background: 'linear-gradient(180deg, rgba(48,40,68,0.58), rgba(23,19,34,0.72))',
                        color: '#bfb4ee',
                        cursor: 'ns-resize',
                        padding: 0,
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                      }}
                    >
                      <span
                        style={{
                          width: 22,
                          height: 2,
                          borderRadius: 999,
                          background: 'rgba(216,207,253,0.62)',
                          boxShadow: '0 -3px 0 rgba(216,207,253,0.22), 0 3px 0 rgba(216,207,253,0.22)',
                        }}
                      />
                    </button>
                  </div>
                )}

                {genError && (
                  <div className="shotflow-node-popover-error" style={{ margin: '0 10px 5px', padding: '4px 8px', borderRadius: 7, background: '#2a1020', color: '#f87171', fontSize: 12, ...(panelSize ? { flexShrink: 0 } : {}) }}>
                    {genError}
                  </div>
                )}

                <div className="flex items-center nodrag shotflow-node-popover-bottom-bar" style={{ borderTop: '1px solid rgba(124,92,252,0.12)', padding: '5px 8px', gap: 3, ...(panelSize ? { flexShrink: 0 } : {}) }}>
                  <select
                    className="nodrag"
                    value={normalizeTextModel(params.model)}
                    onChange={(e) => setParam('model', e.target.value)}
                    style={{
                      flex: '1 1 0',
                      minWidth: 0,
                      background: 'none',
                      border: 'none',
                      color: '#c4b5fd',
                      fontSize: 12,
                      cursor: 'pointer',
                      outline: 'none',
                      fontWeight: 500,
                    }}
                  >
                    {TEXT_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>

                  <div style={{ width: 1, height: 14, background: '#2a2040', flexShrink: 0 }} />

                  <select
                    className="nodrag"
                    value={params.thinkingMode ?? 'fast'}
                    onChange={(e) => setParam('thinkingMode', e.target.value as TextParams['thinkingMode'])}
                    title="生成模式"
                    style={{
                      flex: '0 0 82px',
                      minWidth: 82,
                      background: 'rgba(36,28,54,0.78)',
                      border: '1px solid rgba(124,92,252,0.22)',
                      borderRadius: 8,
                      color: '#d8ccff',
                      fontSize: 12,
                      cursor: 'pointer',
                      outline: 'none',
                      fontWeight: 500,
                      padding: '4px 6px',
                    }}
                  >
                    {TEXT_THINKING_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>

                  <div style={{ width: 1, height: 14, background: '#2a2040', flexShrink: 0 }} />

                  {params.content && (
                    <button
                      className="nodrag nopan"
                      onPointerDown={(event) => {
                        event.stopPropagation()
                      }}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                      }}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void handleCopy()
                      }}
                      style={{ background: 'none', border: 'none', color: '#8a7aaa', fontSize: 12, cursor: 'pointer', padding: '0 3px' }}
                      title="复制"
                    >
                      复制
                    </button>
                  )}

                  {params.content && (
                    <button
                      className="nodrag"
                      onClick={handleClear}
                      style={{ background: 'none', border: 'none', color: '#8a7aaa', fontSize: 12, cursor: 'pointer', padding: '0 3px' }}
                      title="清空"
                    >
                      清空
                    </button>
                  )}

                  <button
                    className="nodrag flex items-center justify-center shotflow-node-primary-action"
                    style={{
                      width: 30,
                      height: 30,
                      flexShrink: 0,
                      marginLeft: 3,
                      borderRadius: 8,
                      background: isGenerating ? '#1e1830' : '#ffffff',
                      border: 'none',
                      cursor: isGenerating ? 'default' : 'pointer',
                      color: isGenerating ? '#7c5cfc' : '#111',
                      boxShadow: isGenerating ? 'none' : '0 2px 8px rgba(0,0,0,0.25)',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      if (!isGenerating) (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0'
                    }}
                    onMouseLeave={(e) => {
                      if (!isGenerating) (e.currentTarget as HTMLButtonElement).style.background = '#ffffff'
                    }}
                    onClick={isGenerating ? handleStop : handleGenerate}
                    title={isGenerating ? '停止生成' : '生成'}
                  >
                    {isGenerating ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <rect x="3" y="3" width="8" height="8" rx="1.5" fill="#7c5cfc" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M8 13V3M8 3L4 7M8 3l4 4" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
            <ResizablePanelHandle onPointerDown={handlePanelResizeStart} />
          </div>,
          document.body
        )}
      {contentExpanded &&
        createPortal(
          <div
            className="nodrag nopan"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setContentExpanded(false)
            }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 12000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 32,
              background: 'rgba(5,4,9,0.68)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <div
              className="nodrag nopan"
              style={{
                width: 'min(920px, 86vw)',
                height: 'min(760px, 82vh)',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 16,
                border: '1px solid rgba(196,181,253,0.22)',
                background: 'linear-gradient(180deg, rgba(24,20,34,0.98), rgba(14,12,21,0.98))',
                boxShadow: '0 28px 80px rgba(0,0,0,0.58), inset 0 1px 0 rgba(255,255,255,0.06)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: 52,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 16px 0 20px',
                  borderBottom: '1px solid rgba(124,92,252,0.14)',
                  color: '#f5f0ff',
                  fontSize: 15,
                  fontWeight: 700,
                }}
              >
                <span>完整内容</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {renderDisplayControls('modal')}
                  {fullContentText && (
                    <button
                      type="button"
                      className="nodrag nopan"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void handleCopy()
                      }}
                      style={{
                        height: 30,
                        padding: '0 10px',
                        borderRadius: 9,
                        border: '1px solid rgba(196,181,253,0.18)',
                        background: 'rgba(255,255,255,0.06)',
                        color: '#d8cffd',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      复制
                    </button>
                  )}
                  <button
                    type="button"
                    className="nodrag nopan"
                    aria-label="关闭"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setContentExpanded(false)
                    }}
                    style={{
                      width: 30,
                      height: 30,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 9,
                      border: '1px solid rgba(196,181,253,0.18)',
                      background: 'rgba(255,255,255,0.06)',
                      color: '#d8cffd',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    <X size={15} strokeWidth={2.2} />
                  </button>
                </div>
              </div>
              <div
                className="nodrag nopan"
                style={{
                  flex: '1 1 auto',
                  minHeight: 0,
                  overflowY: 'auto',
                  padding: '20px 24px 26px',
                  ...panelTextTypographyStyle,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  scrollbarWidth: 'thin',
                  scrollbarColor: '#4a3a78 transparent',
                }}
              >
                {fullContentText}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
