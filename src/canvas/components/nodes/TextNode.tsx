import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useStore, useUpdateNodeInternals, useViewport } from '@xyflow/react'
import { Check, Copy, Maximize2, WandSparkles, X } from 'lucide-react'
import { NodeShell } from './NodeShell'
import { NodeTypeIcon } from './nodeTypeIcon'
import { MediaNodeToolbar } from '@/components/MediaNodeToolbar'
import { ResizablePanelHandle, useResizablePanel, type PanelSize } from './ResizablePanelHandle'
import { useCanvasStore } from '@/store/canvasStore'
import { generateApi } from '@/lib/api'
import { TEXT_MODELS, TEXT_THINKING_MODES, defaultTextParams, defaultVideoParams, normalizeTextModel } from '@/lib/nodeData'
import { liveRefUrl } from '@/lib/primaryOutput'
import type { CanvasNodeData, NodeRef, TextParams, VideoParams } from '@/lib/types'

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
type PromptWashMode = 'conservative' | 'cinematic' | 'references' | 'timeline'
type PromptWashResult = Awaited<ReturnType<typeof generateApi.promptWash>>

const PROMPT_WASH_MODES: Array<{ value: PromptWashMode; label: string; description: string; project: string }> = [
  { value: 'conservative', label: '保守优化', description: '保留原创意，只补齐歧义与必要细节', project: 'dexhunter/seedance2-skill' },
  { value: 'cinematic', label: '电影化', description: '强化镜头、光影、节奏与声音设计', project: 'jnMetaCode/ai-shortfilm-prompts' },
  { value: 'references', label: '参考素材强化', description: '明确每个 @素材继承与不继承的内容', project: 'OSideMedia/higgsfield-ai-prompt-skill' },
  { value: 'timeline', label: '时间轴分镜', description: '按总时长拆分连续镜头和主要动作', project: 'LearnPrompt/awesome-seedance' },
]

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
  const [promptWashOpen, setPromptWashOpen] = useState(false)
  const [promptWashMode, setPromptWashMode] = useState<PromptWashMode>('conservative')
  const [promptWashHoverMode, setPromptWashHoverMode] = useState<PromptWashMode | null>(null)
  const [promptWashSource, setPromptWashSource] = useState('')
  const [promptWashResult, setPromptWashResult] = useState<PromptWashResult | null>(null)
  const [promptWashLoading, setPromptWashLoading] = useState(false)
  const [promptWashProgress, setPromptWashProgress] = useState(0)
  const [promptWashError, setPromptWashError] = useState<string | null>(null)
  const [promptWashMenuRect, setPromptWashMenuRect] = useState<DOMRect | null>(null)
  const [promptWashProgressRect, setPromptWashProgressRect] = useState<DOMRect | null>(null)
  const [outputAreaHeightRatio, setOutputAreaHeightRatio] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const generationRunRef = useRef(0)
  const activeTaskRef = useRef<{ taskId: string; generationVersion: number } | null>(null)
  const dividerRef = useRef<HTMLDivElement>(null)
  const promptWashButtonRef = useRef<HTMLButtonElement>(null)
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
  const promptWashActionRef = useRef<{ mode: PromptWashMode; at: number } | null>(null)
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

  useLayoutEffect(() => {
    if (!promptWashOpen) {
      setPromptWashMenuRect(null)
      return
    }

    const updateMenuRect = () => {
      const toolbarButton = document.querySelector('[data-media-node-toolbar="true"] [aria-label="洗提示词"]') as HTMLButtonElement | null
      setPromptWashMenuRect((toolbarButton ?? promptWashButtonRef.current)?.getBoundingClientRect() ?? null)
    }

    updateMenuRect()
    window.addEventListener('resize', updateMenuRect)
    window.addEventListener('scroll', updateMenuRect, true)
    return () => {
      window.removeEventListener('resize', updateMenuRect)
      window.removeEventListener('scroll', updateMenuRect, true)
    }
  }, [promptWashOpen, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y])

  useLayoutEffect(() => {
    const isProgressVisible = promptWashLoading || promptWashProgress > 0 || Boolean(promptWashError)
    if (!isProgressVisible) return

    let frame = 0
    const syncProgressPosition = () => {
      const nextRect = dividerRef.current?.getBoundingClientRect()
      if (nextRect) {
        setPromptWashProgressRect((previous) => {
          if (
            previous &&
            previous.left === nextRect.left &&
            previous.top === nextRect.top &&
            previous.right === nextRect.right &&
            previous.bottom === nextRect.bottom
          ) {
            return previous
          }
          return nextRect
        })
      }
      frame = window.requestAnimationFrame(syncProgressPosition)
    }

    syncProgressPosition()
    return () => window.cancelAnimationFrame(frame)
  }, [promptWashError, promptWashLoading, promptWashProgress])

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

  const findDownstreamVideo = useCallback(() => {
    const state = useCanvasStore.getState()
    const sourceNode = findNodeByKey(state.nodes, id)
    const sourceKeys = new Set([id, sourceNode?.id, sourceNode?.data.nodeKey].filter(Boolean) as string[])
    const edge = state.edges.find((item) => sourceKeys.has(item.source))
    if (!edge) return undefined
    const target = findNodeByKey(state.nodes, edge.target)
    return target?.data.type === 'video' ? target : undefined
  }, [id])

  const getCurrentTextNodeContent = useCallback(() => {
    const state = useCanvasStore.getState()
    const freshNode = findNodeByKey(state.nodes, id)
    const freshParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    if (Boolean(freshParams.manualMode)) {
      return (contentDraftRef.current || freshParams.content || '').trim()
    }
    return (freshParams.content || freshParams.prompt || promptDraftRef.current || '').trim()
  }, [id, params])

  const openPromptWash = useCallback(() => {
    const source = getCurrentTextNodeContent()
    setPromptWashSource(source)
    setPromptWashResult(null)
    setPromptWashError(source ? null : '请先在文字节点中填写内容')
    const toolbarButton = document.querySelector('[data-media-node-toolbar="true"] [aria-label="洗提示词"]') as HTMLButtonElement | null
    setPromptWashMenuRect((toolbarButton ?? promptWashButtonRef.current)?.getBoundingClientRect() ?? null)
    setActivePanelNode(id)
    setPromptWashOpen(true)
  }, [getCurrentTextNodeContent, id, setActivePanelNode])

  const handlePromptWash = useCallback(async (requestedMode: PromptWashMode = promptWashMode, requestedSource = promptWashSource) => {
    const sourceText = requestedSource.trim()
    if (!sourceText) {
      setPromptWashError('请先填写要优化的文字')
      return
    }
    const videoNode = findDownstreamVideo()
    const videoParams = videoNode?.data.params as unknown as VideoParams | undefined
    const defaults = defaultVideoParams()
    const targetSettings = videoParams?.settings ?? defaults.settings
    const state = useCanvasStore.getState()
    const referenceLists = [
      ...(videoParams?.imageList ?? []),
      ...(videoParams?.videoList ?? []),
      ...(videoParams?.audioList ?? []),
    ]
    const names = referenceLists.map((ref) => {
      const refNode = findNodeByKey(state.nodes, ref.nodeId)
      return String(refNode?.data.name || ref.nodeId || '').trim()
    }).filter(Boolean)

    setPromptWashLoading(true)
    setPromptWashProgress(8)
    setPromptWashError(null)
    const progressTimer = window.setInterval(() => {
      setPromptWashProgress((value) => Math.min(92, value + Math.max(1, Math.round((92 - value) / 7))))
    }, 420)
    try {
      const result = await generateApi.promptWash({
        projectUuid: data.projectUuid,
        nodeKey: id,
        sourceText,
        mode: requestedMode,
        textModel: normalizeTextModel(params.model),
        thinkingMode: params.thinkingMode ?? 'fast',
        target: {
          model: videoParams?.model ?? defaults.model,
          modeType: videoParams?.modeType ?? defaults.modeType,
          duration: targetSettings.duration,
          ratio: targetSettings.ratio,
          resolution: targetSettings.resolution,
          enableSound: targetSettings.enableSound,
        },
        references: {
          imageCount: videoParams?.imageList?.length ?? connectedImages.length,
          videoCount: videoParams?.videoList?.length ?? connectedVideos.length,
          audioCount: videoParams?.audioList?.length ?? 0,
          names,
        },
      })
      setPromptWashResult(result)
      setPromptWashProgress(100)
      window.setTimeout(() => {
        const current = useCanvasStore.getState().nodes.find((node) => node.id === id || node.data.nodeKey === id)
        const x = Number(current?.position?.x || 0) + nodeWidth + 80
        const y = Number(current?.position?.y || 0) + nodeHeight + 70
        useCanvasStore.getState().addNodeAt('text', x, y, {
          params: { ...defaultTextParams(), content: result.prompt, hasGenerated: true, manualMode: false, textList: [{ nodeId: id, url: '', content: sourceText }] } as unknown as Record<string, unknown>,
        })
        setPromptWashProgress(0)
        setPromptWashProgressRect(null)
      }, 360)
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
        || (error instanceof Error ? error.message : String(error))
      setPromptWashError(message)
      setPromptWashProgress(0)
    } finally {
      window.clearInterval(progressTimer)
      setPromptWashLoading(false)
    }
  }, [connectedImages.length, connectedVideos.length, data.projectUuid, findDownstreamVideo, id, nodeHeight, nodeWidth, params.model, params.thinkingMode, promptWashMode, promptWashSource])

  const startPromptWashMode = useCallback((mode: PromptWashMode) => {
    const source = getCurrentTextNodeContent()
    setPromptWashProgressRect(dividerRef.current?.getBoundingClientRect() ?? null)
    setPromptWashMode(mode)
    setPromptWashOpen(false)
    setPromptWashMenuRect(null)
    setPromptWashSource(source)
    setPromptWashResult(null)
    setPromptWashHoverMode(null)
    setPromptWashProgress(source ? 4 : 0)
    setPromptWashError(null)
    if (!source) {
      setPromptWashError('请先在文字节点中填写内容')
      return
    }
    void handlePromptWash(mode, source)
  }, [getCurrentTextNodeContent, handlePromptWash])

  const selectPromptWashMode = useCallback((event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>, mode: PromptWashMode) => {
    event.preventDefault()
    event.stopPropagation()
    const now = Date.now()
    const previous = promptWashActionRef.current
    if (previous?.mode === mode && now - previous.at < 500) return
    promptWashActionRef.current = { mode, at: now }
    startPromptWashMode(mode)
  }, [startPromptWashMode])

  const applyPromptWashToCurrent = useCallback(() => {
    if (!promptWashResult?.prompt) return
    const state = useCanvasStore.getState()
    const freshNode = findNodeByKey(state.nodes, id)
    const current = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    state.pushHistory()
    state.updateNodeData(id, {
      params: { ...current, content: promptWashResult.prompt, hasGenerated: true, manualMode: false } as unknown as Record<string, unknown>,
    })
    setContentDraft(promptWashResult.prompt)
    contentDraftRef.current = promptWashResult.prompt
    setPromptWashOpen(false)
  }, [id, params, promptWashResult])

  const createPromptWashTextNode = useCallback(() => {
    if (!promptWashResult?.prompt) return
    const state = useCanvasStore.getState()
    const sourceNode = findNodeByKey(state.nodes, id) as (NodeLike & { position?: { x: number; y: number } }) | undefined
    const x = Number(sourceNode?.position?.x || 0) + nodeWidth + 80
    const y = Number(sourceNode?.position?.y || 0)
    state.addNodeAt('text', x, y, {
      params: {
        ...defaultTextParams(),
        content: promptWashResult.prompt,
        hasGenerated: true,
        manualMode: false,
      } as unknown as Record<string, unknown>,
    })
    setPromptWashOpen(false)
  }, [id, nodeWidth, promptWashResult])

  const applyPromptWashToVideo = useCallback(() => {
    if (!promptWashResult?.prompt) return
    const videoNode = findDownstreamVideo()
    if (!videoNode) {
      setPromptWashError('当前文字节点没有连接下游视频节点')
      return
    }
    const state = useCanvasStore.getState()
    const current = (videoNode.data.params || defaultVideoParams()) as unknown as VideoParams
    state.pushHistory()
    state.updateNodeData(videoNode.id, {
      params: {
        ...current,
        prompt: promptWashResult.prompt,
        model: promptWashResult.settings.model,
        modeType: promptWashResult.settings.modeType as VideoParams['modeType'],
        settings: {
          ...current.settings,
          duration: promptWashResult.settings.duration,
          ratio: promptWashResult.settings.ratio,
          resolution: promptWashResult.settings.resolution,
          enableSound: promptWashResult.settings.enableSound,
        },
      } as unknown as Record<string, unknown>,
    })
    setPromptWashOpen(false)
  }, [findDownstreamVideo, promptWashResult])

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

  const promptWashToolbar = selected ? (
    <MediaNodeToolbar
      actions={[{
        key: 'prompt-wash',
        label: '洗提示词',
        icon: <WandSparkles size={14} strokeWidth={1.9} />,
        active: promptWashOpen,
        onClick: openPromptWash,
      }]}
    />
  ) : undefined

  return (
    <>
      <NodeShell
        nodeKey={id}
        data={data}
        selected={selected}
        toolbar={promptWashToolbar}
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
                  contentDraftRef.current = nextContent
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
            {false && (promptWashLoading || promptWashProgress > 0 || promptWashError) && (
              <div className="nodrag nopan" style={{ position: 'absolute', left: 8, right: 8, top: nodeHeight + 8, zIndex: 150, padding: '7px 10px', borderRadius: 9, border: '1px solid rgba(196,181,253,0.18)', background: 'rgba(24,19,37,0.96)', boxShadow: '0 10px 24px rgba(0,0,0,0.32)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, color: promptWashError ? '#fca5a5' : '#cfc3ff', fontSize: 11 }}>
                  <span>{promptWashError || (promptWashProgress >= 100 ? '洗词完成，正在创建新的文字节点…' : `正在洗提示词… ${promptWashProgress}%`)}</span>
                  {promptWashLoading && <span style={{ color: '#8f7ee3' }}>Seedance Skill</span>}
                </div>
                {!promptWashError && <div style={{ height: 4, marginTop: 6, overflow: 'hidden', borderRadius: 99, background: 'rgba(196,181,253,0.14)' }}><div style={{ width: `${Math.max(3, promptWashProgress)}%`, height: '100%', borderRadius: 99, background: 'linear-gradient(90deg, #7c5cfc, #c4b5fd)', transition: 'width 0.3s ease' }} /></div>}
              </div>
            )}

        <div ref={dividerRef} style={{ height: 0 }} />
      </NodeShell>

      {promptWashProgressRect && (promptWashLoading || promptWashProgress > 0 || promptWashError) && createPortal(
        <div
          className="nodrag nopan"
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.max(12, Math.min(promptWashProgressRect.left, window.innerWidth - 432)),
            top: Math.min(window.innerHeight - 58, promptWashProgressRect.bottom + 8),
            width: 'min(420px, calc(100vw - 24px))',
            zIndex: 21000,
            padding: '9px 12px',
            borderRadius: 10,
            border: '1px solid rgba(196,181,253,0.32)',
            background: 'rgba(24,19,37,0.98)',
            boxShadow: '0 12px 30px rgba(0,0,0,0.44)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, color: promptWashError ? '#fca5a5' : '#cfc3ff', fontSize: 11 }}>
            <span>{promptWashError || (promptWashProgress >= 100 ? '洗提示词完成，正在创建新的文字节点…' : '正在洗提示词… ' + promptWashProgress + '%')}</span>
            {promptWashLoading && <span style={{ color: '#a996ee' }}>Seedance Skill</span>}
          </div>
          {!promptWashError && <div style={{ height: 5, marginTop: 7, overflow: 'hidden', borderRadius: 99, background: 'rgba(196,181,253,0.14)' }}><div style={{ width: Math.max(4, promptWashProgress) + '%', height: '100%', borderRadius: 99, background: 'linear-gradient(90deg, #7c5cfc, #c4b5fd)', transition: 'width 0.3s ease' }} /></div>}
        </div>,
        document.body
      )}

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

                  <div className="nodrag nopan" style={{ position: 'relative', flexShrink: 0 }}>
                    <button
                      type="button"
                      className="nodrag nopan"
                      ref={promptWashButtonRef}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        openPromptWash()
                      }}
                      title="洗提示词"
                      aria-label="洗提示词"
                      style={{ display: 'none' }}
                    >
                      <WandSparkles size={15} strokeWidth={1.8} />
                    </button>
                    {false && promptWashOpen && promptWashMenuRect && createPortal(
                      <div
                        className="nodrag nopan"
                        onMouseDown={(event) => event.stopPropagation()}
                        style={{
                          position: 'fixed',
                          right: Math.max(12, window.innerWidth - promptWashMenuRect.right),
                          top: promptWashMenuRect.top <= 240 ? promptWashMenuRect.bottom + 8 : undefined,
                          bottom: promptWashMenuRect.top > 240 ? Math.max(12, window.innerHeight - promptWashMenuRect.top + 8) : undefined,
                          width: 260,
                          maxHeight: 'min(300px, calc(100vh - 24px))',
                          overflowY: 'auto',
                          padding: 6,
                          zIndex: 20000,
                          borderRadius: 11,
                          border: '1px solid rgba(196,181,253,0.22)',
                          background: 'rgba(25,20,39,0.99)',
                          boxShadow: '0 16px 36px rgba(0,0,0,0.46)',
                        }}
                      >
                        <div style={{ padding: '5px 8px 7px', color: '#9488ad', fontSize: 10 }}>选择洗提示词模式，选中后立即执行</div>
                        {PROMPT_WASH_MODES.map((mode) => (
                          <button key={mode.value} type="button" className="nodrag nopan" onPointerDown={(event) => selectPromptWashMode(event, mode.value)} onClick={(event) => selectPromptWashMode(event, mode.value)} onMouseEnter={() => setPromptWashHoverMode(mode.value)} onMouseLeave={() => setPromptWashHoverMode(null)} style={{ width: '100%', display: 'block', padding: '8px 9px', textAlign: 'left', border: '1px solid transparent', borderRadius: 8, background: promptWashHoverMode === mode.value || promptWashMode === mode.value ? 'rgba(124,92,252,0.28)' : 'transparent', borderColor: promptWashHoverMode === mode.value ? 'rgba(196,181,253,0.42)' : 'transparent', color: '#e8e1f7', cursor: 'pointer', pointerEvents: 'auto', boxShadow: promptWashHoverMode === mode.value ? '0 0 0 1px rgba(124,92,252,0.18), inset 0 0 18px rgba(124,92,252,0.12)' : 'none', transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease' }}>
                            <div style={{ fontSize: 12, fontWeight: 700 }}>{mode.label}</div>
                            <div style={{ marginTop: 3, color: '#8d829e', fontSize: 10, lineHeight: 1.35 }}>{mode.description}</div>
                          </button>
                        ))}
                      </div>,
                      document.body
                    )}
                  </div>

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
      {promptWashOpen && promptWashMenuRect && createPortal(
        <div
          className="nodrag nopan"
          onMouseDown={(event) => event.stopPropagation()}
          style={{
            position: 'fixed',
            right: Math.max(12, window.innerWidth - promptWashMenuRect.right),
            top: promptWashMenuRect.top <= 240 ? promptWashMenuRect.bottom + 8 : undefined,
            bottom: promptWashMenuRect.top > 240 ? Math.max(12, window.innerHeight - promptWashMenuRect.top + 8) : undefined,
            width: 260,
            maxHeight: 'min(300px, calc(100vh - 24px))',
            overflowY: 'auto',
            padding: 6,
            zIndex: 20000,
            borderRadius: 11,
            border: '1px solid rgba(196,181,253,0.22)',
            background: 'rgba(25,20,39,0.99)',
            boxShadow: '0 16px 36px rgba(0,0,0,0.46)',
          }}
        >
          <div style={{ padding: '5px 8px 7px', color: '#9488ad', fontSize: 10 }}>选择洗提示词模式，选中后立即执行</div>
          {PROMPT_WASH_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              className="nodrag nopan"
              onPointerDown={(event) => selectPromptWashMode(event, mode.value)}
              onClick={(event) => selectPromptWashMode(event, mode.value)}
              onMouseEnter={() => setPromptWashHoverMode(mode.value)}
              onMouseLeave={() => setPromptWashHoverMode(null)}
              style={{
                width: '100%',
                display: 'block',
                padding: '8px 9px',
                textAlign: 'left',
                border: '1px solid transparent',
                borderRadius: 8,
                background: promptWashHoverMode === mode.value || promptWashMode === mode.value ? 'rgba(124,92,252,0.28)' : 'transparent',
                borderColor: promptWashHoverMode === mode.value ? 'rgba(196,181,253,0.42)' : 'transparent',
                color: '#e8e1f7',
                cursor: 'pointer',
                pointerEvents: 'auto',
                boxShadow: promptWashHoverMode === mode.value ? '0 0 0 1px rgba(124,92,252,0.18), inset 0 0 18px rgba(124,92,252,0.12)' : 'none',
                transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700 }}>{mode.label}</div>
              <div style={{ marginTop: 3, color: '#8d829e', fontSize: 10, lineHeight: 1.35 }}>{mode.description}</div>
            </button>
          ))}
        </div>,
        document.body
      )}
      {false && promptWashOpen &&
        createPortal(
          <div
            className="nodrag nopan"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !promptWashLoading) setPromptWashOpen(false)
            }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 12500,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              background: 'rgba(5,4,9,0.72)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <div
              className="nodrag nopan"
              style={{
                width: 'min(980px, 94vw)',
                height: 'min(760px, 90vh)',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 18,
                border: '1px solid rgba(196,181,253,0.24)',
                background: 'linear-gradient(180deg, rgba(26,21,38,0.99), rgba(13,11,20,0.99))',
                boxShadow: '0 32px 90px rgba(0,0,0,0.64)',
                overflow: 'hidden',
                color: '#f4f0ff',
              }}
            >
              <div style={{ height: 58, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px 0 22px', borderBottom: '1px solid rgba(124,92,252,0.16)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: 'rgba(124,92,252,0.18)', color: '#c4b5fd' }}>
                    <WandSparkles size={16} />
                  </span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 750 }}>洗提示词</div>
                    <div style={{ marginTop: 2, fontSize: 11, color: '#9185ac' }}>面向 Seedance 的可执行视频提示词</div>
                  </div>
                </div>
                <button type="button" disabled={promptWashLoading} onClick={() => setPromptWashOpen(false)} aria-label="关闭" style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, border: '1px solid rgba(196,181,253,0.18)', background: 'rgba(255,255,255,0.05)', color: '#d8cffd', cursor: promptWashLoading ? 'default' : 'pointer' }}>
                  <X size={15} />
                </button>
              </div>

              <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: 20, scrollbarWidth: 'thin', scrollbarColor: '#4a3a78 transparent' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 16 }}>
                  {PROMPT_WASH_MODES.map((mode) => {
                    const active = promptWashMode === mode.value
                    return (
                      <button
                        key={mode.value}
                        type="button"
                        onClick={() => { setPromptWashMode(mode.value); setPromptWashResult(null) }}
                        style={{ minHeight: 96, padding: '12px 13px', textAlign: 'left', borderRadius: 11, border: active ? '1px solid #8b6cff' : '1px solid rgba(196,181,253,0.16)', background: active ? 'rgba(124,92,252,0.18)' : 'rgba(255,255,255,0.035)', color: active ? '#fff' : '#d8cff0', cursor: 'pointer' }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{mode.label}</div>
                        <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.45, color: active ? '#cfc3ff' : '#83799a' }}>{mode.description}</div>
                        <div title={mode.project} style={{ marginTop: 7, fontSize: 10, lineHeight: 1.3, color: active ? '#a996ee' : '#6e6384', overflowWrap: 'anywhere' }}>参考项目：{mode.project}</div>
                      </button>
                    )
                  })}
                </div>

                <div style={{ padding: '9px 12px', marginBottom: 12, borderRadius: 9, border: '1px solid rgba(196,181,253,0.12)', background: 'rgba(255,255,255,0.025)', color: '#968bac', fontSize: 11 }}>
                  {findDownstreamVideo() ? '已读取下游视频节点的模型、模式、时长和参考素材；写入时不会自动生成。' : '未连接下游视频节点，先按 Seedance 2.5 多模态默认设置优化。'}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14 }}>
                  <div>
                    <div style={{ marginBottom: 7, fontSize: 12, color: '#b5a8cf', fontWeight: 650 }}>原始提示词</div>
                    <textarea
                      value={promptWashSource}
                      onChange={(event) => { setPromptWashSource(event.target.value); setPromptWashResult(null) }}
                      placeholder="输入需要优化的视频提示词"
                      style={{ boxSizing: 'border-box', width: '100%', height: 300, resize: 'none', padding: 14, borderRadius: 11, border: '1px solid rgba(196,181,253,0.16)', outline: 'none', background: 'rgba(4,3,8,0.52)', color: '#eee9fa', fontSize: 13, lineHeight: 1.65 }}
                    />
                  </div>
                  <div>
                    <div style={{ marginBottom: 7, fontSize: 12, color: '#b5a8cf', fontWeight: 650 }}>优化结果</div>
                    <div style={{ boxSizing: 'border-box', width: '100%', height: 300, overflowY: 'auto', padding: 14, borderRadius: 11, border: '1px solid rgba(196,181,253,0.16)', background: 'rgba(4,3,8,0.52)', color: '#eee9fa', fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {promptWashLoading ? (
                        <span style={{ color: '#b9a9ef' }}>正在按“{PROMPT_WASH_MODES.find((item) => item.value === promptWashMode)?.label}”优化…</span>
                      ) : promptWashResult?.prompt ? promptWashResult.prompt : (
                        <span style={{ color: '#665d77' }}>点击下方“开始优化”后在这里预览，不会直接覆盖原文。</span>
                      )}
                    </div>
                  </div>
                </div>

                {promptWashResult && (promptWashResult.changeSummary.length > 0 || promptWashResult.warnings.length > 0) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
                    <div style={{ padding: '10px 12px', borderRadius: 9, background: 'rgba(124,92,252,0.08)', color: '#bfb4d6', fontSize: 11, lineHeight: 1.55 }}>
                      <strong style={{ color: '#d9ceef' }}>优化内容：</strong>{promptWashResult.changeSummary.join('；') || '已整理结构'}
                    </div>
                    <div style={{ padding: '10px 12px', borderRadius: 9, background: promptWashResult.warnings.length ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.025)', color: promptWashResult.warnings.length ? '#e8c88a' : '#8b829b', fontSize: 11, lineHeight: 1.55 }}>
                      <strong>提示：</strong>{promptWashResult.warnings.join('；') || '未发现设置冲突'}
                    </div>
                  </div>
                )}
                {promptWashError && <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 9, background: 'rgba(127,29,29,0.3)', color: '#fca5a5', fontSize: 12 }}>{promptWashError}</div>}
              </div>

              <div style={{ minHeight: 62, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 18px', borderTop: '1px solid rgba(124,92,252,0.16)', background: 'rgba(8,6,13,0.48)' }}>
                <button type="button" disabled={promptWashLoading || !promptWashSource.trim()} onClick={() => void handlePromptWash()} style={{ height: 36, padding: '0 18px', border: 'none', borderRadius: 10, background: promptWashLoading ? '#31284a' : '#7c5cfc', color: '#fff', fontSize: 12, fontWeight: 700, cursor: promptWashLoading ? 'default' : 'pointer' }}>
                  {promptWashLoading ? '优化中…' : promptWashResult ? '重新优化' : '开始优化'}
                </button>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" disabled={!promptWashResult} onClick={() => promptWashResult && void copyTextToClipboard(promptWashResult.prompt)} style={{ height: 34, padding: '0 12px', borderRadius: 9, border: '1px solid rgba(196,181,253,0.18)', background: 'rgba(255,255,255,0.05)', color: '#cfc5df', cursor: promptWashResult ? 'pointer' : 'default', opacity: promptWashResult ? 1 : 0.42 }}>复制</button>
                  <button type="button" disabled={!promptWashResult} onClick={createPromptWashTextNode} style={{ height: 34, padding: '0 12px', borderRadius: 9, border: '1px solid rgba(196,181,253,0.18)', background: 'rgba(255,255,255,0.05)', color: '#cfc5df', cursor: promptWashResult ? 'pointer' : 'default', opacity: promptWashResult ? 1 : 0.42 }}>新建文字节点</button>
                  <button type="button" disabled={!promptWashResult || !findDownstreamVideo()} onClick={applyPromptWashToVideo} style={{ height: 34, padding: '0 12px', borderRadius: 9, border: '1px solid rgba(196,181,253,0.18)', background: 'rgba(255,255,255,0.05)', color: '#cfc5df', cursor: promptWashResult && findDownstreamVideo() ? 'pointer' : 'default', opacity: promptWashResult && findDownstreamVideo() ? 1 : 0.42 }}>写入视频节点</button>
                  <button type="button" disabled={!promptWashResult} onClick={applyPromptWashToCurrent} style={{ height: 34, padding: '0 14px', borderRadius: 9, border: 'none', background: '#fff', color: '#17121f', fontSize: 12, fontWeight: 700, cursor: promptWashResult ? 'pointer' : 'default', opacity: promptWashResult ? 1 : 0.42 }}>替换当前文字</button>
                </div>
              </div>
            </div>
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
