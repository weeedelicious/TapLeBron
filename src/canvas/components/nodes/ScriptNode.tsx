import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react'
import { addEdge, type Edge } from '@xyflow/react'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  FileJson,
  ImagePlus,
  Images,
  Loader2,
  LocateFixed,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import { MediaNodeToolbar } from '@/components/MediaNodeToolbar'
import { NodeShell } from './NodeShell'
import { useCanvasStore, type FlowNode } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import { errorToText } from '@/lib/display'
import { defaultImageParams, defaultScriptParams, DEFAULT_TEXT_MODEL, IMAGE_MODELS, normalizeImageModel } from '@/lib/nodeData'
import {
  getImageRatioOptions,
  getImageResolutionOptions,
  normalizeImageRatioValue,
  normalizeImageResolutionValue,
} from '@/lib/imageRules'
import { primaryOutputUrl } from '@/lib/primaryOutput'
import type { CanvasNodeData, ScriptParams, ScriptRow } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

interface ScriptRowExt extends ScriptRow {
  imageNodeId?: string
  notes?: string
}

interface ScriptSettings {
  shotCount: number
  stylePreset: string
  ratio: string
  resolution: string
  model: string
}

interface ScriptParamsView extends ScriptParams {
  rows: ScriptRowExt[]
  settings: ScriptSettings
}

const SCENE_TYPES = ['', '远景', '全景', '中景', '近景', '特写', '超特写', '航拍', '俯拍', '仰拍']

const STYLE_PRESETS = [
  { value: 'cinematic', label: '电影写实' },
  { value: 'animation', label: '动画分镜' },
  { value: 'commercial', label: '广告分镜' },
  { value: 'product', label: '产品展示' },
  { value: 'short_drama', label: '短剧镜头' },
  { value: 'free', label: '自由风格' },
]

const DEFAULT_SETTINGS: ScriptSettings = {
  shotCount: 8,
  stylePreset: 'cinematic',
  ratio: '16:9',
  resolution: '1K',
  model: 'gemini-3-pro-image',
}

const inputStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  border: '1px solid rgba(124,92,252,0.18)',
  borderRadius: 7,
  background: 'rgba(8,6,18,0.72)',
  color: '#f4f1ff',
  outline: 'none',
  fontSize: 12,
}

const iconButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid rgba(124,92,252,0.22)',
  borderRadius: 7,
  background: 'rgba(124,92,252,0.08)',
  color: '#cfc5ff',
  cursor: 'pointer',
  flexShrink: 0,
}

const textButtonStyle: CSSProperties = {
  height: 34,
  border: '1px solid rgba(124,92,252,0.2)',
  borderRadius: 8,
  background: 'rgba(124,92,252,0.08)',
  color: '#cfc5ff',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '0 10px',
}

function shouldBlockScriptNodeDrag(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  return Boolean(
    element.closest('input, textarea, select, button, label, a, [contenteditable="true"], [role="button"], .nodrag, .nopan')
  )
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function readString(row: Record<string, unknown>, keys: string[], fallback = '') {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
  }
  return fallback
}

function readNumber(row: Record<string, unknown>, keys: string[], fallback = 3) {
  for (const key of keys) {
    const value = Number(row[key])
    if (Number.isFinite(value)) return value
  }
  return fallback
}

function normalizeSettings(raw?: Record<string, unknown>): ScriptSettings {
  const settings = raw ?? {}
  const model = typeof settings.model === 'string' ? normalizeImageModel(settings.model) : DEFAULT_SETTINGS.model
  const ratio = normalizeImageRatioValue(model, typeof settings.ratio === 'string' ? settings.ratio : DEFAULT_SETTINGS.ratio)
  const resolution = normalizeImageResolutionValue(model, typeof settings.resolution === 'string' ? settings.resolution : DEFAULT_SETTINGS.resolution)
  const stylePreset = typeof settings.stylePreset === 'string' && STYLE_PRESETS.some((item) => item.value === settings.stylePreset)
    ? settings.stylePreset
    : DEFAULT_SETTINGS.stylePreset

  return {
    shotCount: clampNumber(Number(settings.shotCount), 1, 80, DEFAULT_SETTINGS.shotCount),
    stylePreset,
    ratio,
    resolution,
    model,
  }
}

function normalizeRow(row: Partial<ScriptRowExt> | Record<string, unknown> | null | undefined, index: number): ScriptRowExt {
  const source = (row ?? {}) as Record<string, unknown>
  return {
    id: readString(source, ['id', 'rowId']) || uuidv4(),
    shot: readString(source, ['shot', '镜号', '镜头', '分镜'], String(index + 1).padStart(2, '0')),
    sceneType: readString(source, ['sceneType', '景别', 'shotType', 'framing']),
    action: readString(source, ['action', '画面', '画面/动作', 'description', 'visual', '内容']),
    dialogue: readString(source, ['dialogue', '对白', '旁白', 'voiceover', 'line']),
    duration: readNumber(source, ['duration', '时长', 'seconds', 'sec'], 3),
    imageNodeId: readString(source, ['imageNodeId', 'image_node_id']) || undefined,
    notes: readString(source, ['notes', '备注']) || undefined,
  }
}

function normalizeScriptParams(raw?: Record<string, unknown> | ScriptParams): ScriptParamsView {
  const fallback = defaultScriptParams()
  const value = (raw ?? {}) as Record<string, unknown> & Partial<ScriptParams>
  return {
    description: typeof value.description === 'string' ? value.description : fallback.description,
    rows: Array.isArray(value.rows) ? value.rows.map((row, index) => normalizeRow(row as Record<string, unknown>, index)) : [],
    settings: normalizeSettings(value.settings as Record<string, unknown> | undefined),
  }
}

function getRowCandidates(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return []
  const value = parsed as Record<string, unknown>
  for (const key of ['rows', 'shots', 'storyboard', 'scenes', '分镜']) {
    if (Array.isArray(value[key])) return value[key] as unknown[]
  }
  return []
}

function parseScriptRows(text: string): ScriptRowExt[] {
  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? '',
    text.slice(text.indexOf('['), text.lastIndexOf(']') + 1),
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const rows = getRowCandidates(parsed)
      if (rows.length > 0) return rows.map((row, index) => normalizeRow(row as Record<string, unknown>, index))
    } catch {
      // Try the next shape.
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean)
  if (lines.length > 0) {
    return lines.slice(0, 40).map((line, index) => normalizeRow({ action: line, duration: 3 }, index))
  }

  throw new Error('AI 返回的分镜格式不是可用 JSON')
}

function formatShotLabel(row: ScriptRowExt, index: number) {
  return row.shot.trim() || String(index + 1).padStart(2, '0')
}

function rowHasContent(row: ScriptRowExt) {
  return Boolean(row.shot.trim() || row.sceneType.trim() || row.action.trim() || row.dialogue.trim() || row.notes?.trim())
}

function buildShotPrompt(row: ScriptRowExt, index: number) {
  const duration = Number(row.duration)
  return [
    `镜号：${formatShotLabel(row, index)}`,
    row.sceneType ? `景别：${row.sceneType}` : '',
    row.action ? `画面：${row.action}` : '',
    row.dialogue ? `对白/旁白：${row.dialogue}` : '',
    row.notes ? `备注：${row.notes}` : '',
    Number.isFinite(duration) && duration > 0 ? `时长：${duration}秒` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildStoryboardPrompt(params: ScriptParamsView) {
  const styleLabel = STYLE_PRESETS.find((item) => item.value === params.settings.stylePreset)?.label ?? '电影写实'
  return [
    '请把下面的内容拆成结构化分镜。',
    '必须只返回 JSON，不要 Markdown，不要解释。',
    'JSON 格式为数组，每一项字段必须是：id, shot, sceneType, action, dialogue, duration。',
    `分镜数量：${params.settings.shotCount}`,
    `画面比例：${params.settings.ratio}`,
    `风格：${styleLabel}`,
    'sceneType 优先使用：远景、全景、中景、近景、特写、超特写、俯拍、仰拍。',
    'action 写清楚画面主体、动作、镜头运动、环境和情绪；dialogue 没有就留空字符串；duration 用数字秒数。',
    '',
    params.description,
  ].join('\n')
}

function getScriptSource(params: unknown): { nodeId?: string; rowId?: string; shot?: string } | null {
  const advancedSettings = (params as { advancedSettings?: Record<string, unknown> } | undefined)?.advancedSettings
  const source = advancedSettings?.scriptSource
  return source && typeof source === 'object' ? source as { nodeId?: string; rowId?: string; shot?: string } : null
}

function hasNodeRef(list: unknown, nodeId: string) {
  return Array.isArray(list) && list.some((item) => (item as { nodeId?: string })?.nodeId === nodeId)
}

function uniqueNodeRefs(list: unknown, ref: { nodeId: string; url: string }) {
  const refs = Array.isArray(list) ? list.filter((item) => (item as { nodeId?: string })?.nodeId) : []
  return hasNodeRef(refs, ref.nodeId) ? refs : [...refs, ref]
}

function sourceIdForRow(row: ScriptRowExt, index: number, scriptId: string) {
  return { nodeId: scriptId, rowId: row.id, shot: formatShotLabel(row, index) }
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function stripUnsafeFileName(name: string) {
  return (name || 'storyboard').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
}

/** 名副其实：取这一行挂着的图片节点的**主图**，不是它第一次生成的那张。 */
function primaryImageUrl(node?: FlowNode) {
  return primaryOutputUrl(node?.data)
}

export function ScriptNode({ id, data, selected }: Props) {
  const {
    updateNodeData,
    addNodeAt,
    nodes,
    edges,
    setEdges,
    selectedNodeKeys,
    activePanelNodeId,
    setSelected,
  } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isGeneratingImages, setIsGeneratingImages] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const params = useMemo(() => normalizeScriptParams(data.params), [data.params])
  const isSoleSelected = selectedNodeKeys.length === 1 && selectedNodeKeys[0] === id
  const isPanelActive = activePanelNodeId === id && isSoleSelected

  const rowImageMap = useMemo(() => {
    const map = new Map<string, FlowNode>()
    for (const row of params.rows) {
      const linkedById = row.imageNodeId ? nodes.find((node) => node.id === row.imageNodeId) : undefined
      const linkedByMeta = nodes.find((node) => {
        if (node.data.type !== 'image') return false
        const source = getScriptSource(node.data.params)
        return source?.nodeId === id && source?.rowId === row.id
      })
      const node = linkedById ?? linkedByMeta
      if (node) map.set(row.id, node)
    }
    return map
  }, [id, nodes, params.rows])

  const generatedCount = params.rows.filter((row) => Boolean(primaryImageUrl(rowImageMap.get(row.id)))).length
  const linkedCount = rowImageMap.size
  const totalDuration = params.rows.reduce((sum, row) => sum + (Number(row.duration) || 0), 0)
  const imageRatioOptions = getImageRatioOptions(params.settings.model)
  const imageResolutionOptions = getImageResolutionOptions(params.settings.model)

  const setParams = useCallback(
    (patch: Record<string, unknown>) => {
      const freshNode = useCanvasStore.getState().nodes.find((node) => node.id === id || node.data.nodeKey === id)
      const currentRaw = ((freshNode?.data.params ?? data.params ?? {}) as Record<string, unknown>)
      updateNodeData(id, { params: { ...currentRaw, ...patch } as unknown as Record<string, unknown> })
    },
    [data.params, id, updateNodeData]
  )

  const setRows = useCallback((rows: ScriptRowExt[]) => setParams({ rows }), [setParams])

  const setSetting = useCallback(
    <K extends keyof ScriptSettings>(key: K, value: ScriptSettings[K]) => {
      const nextSettings = { ...params.settings, [key]: value }
      const nextModel = key === 'model' ? normalizeImageModel(String(value)) : params.settings.model
      setParams({
        settings: {
          ...nextSettings,
          model: nextModel,
          ratio: normalizeImageRatioValue(nextModel, String(nextSettings.ratio)),
          resolution: normalizeImageResolutionValue(nextModel, String(nextSettings.resolution)),
        },
      })
    },
    [params.settings, setParams]
  )

  const updateRow = useCallback(
    <K extends keyof ScriptRowExt>(rowId: string, key: K, value: ScriptRowExt[K]) => {
      setRows(params.rows.map((row) => (row.id === rowId ? { ...row, [key]: value } : row)))
    },
    [params.rows, setRows]
  )

  const syncRowsWithImageLinks = useCallback(
    (links: Record<string, string>) => {
      setRows(params.rows.map((row) => (links[row.id] && row.imageNodeId !== links[row.id] ? { ...row, imageNodeId: links[row.id] } : row)))
    },
    [params.rows, setRows]
  )

  const addRow = useCallback(() => {
    setRows([...params.rows, normalizeRow({ id: uuidv4(), duration: 3 }, params.rows.length)])
  }, [params.rows, setRows])

  const deleteRow = useCallback(
    (rowId: string) => {
      setRows(params.rows.filter((row) => row.id !== rowId))
    },
    [params.rows, setRows]
  )

  const copyRow = useCallback(
    (row: ScriptRowExt) => {
      const index = params.rows.findIndex((item) => item.id === row.id)
      const next = [...params.rows]
      const { imageNodeId: _imageNodeId, ...copy } = row
      next.splice(index + 1, 0, { ...copy, id: uuidv4(), shot: `${row.shot || index + 1} 副本` })
      setRows(next)
    },
    [params.rows, setRows]
  )

  const moveRow = useCallback(
    (rowId: string, direction: -1 | 1) => {
      const index = params.rows.findIndex((row) => row.id === rowId)
      const targetIndex = index + direction
      if (index < 0 || targetIndex < 0 || targetIndex >= params.rows.length) return
      const next = [...params.rows]
      const [picked] = next.splice(index, 1)
      next.splice(targetIndex, 0, picked)
      setRows(next)
    },
    [params.rows, setRows]
  )

  const prepareImageParamsForRow = useCallback(
    (node: FlowNode | undefined, row: ScriptRowExt, index: number) => {
      const base = defaultImageParams()
      const current = ((node?.data.params ?? {}) as Record<string, unknown>)
      const currentSettings = (current.settings ?? {}) as Record<string, unknown>
      const advancedSettings = (current.advancedSettings ?? {}) as Record<string, unknown>
      return {
        ...base,
        ...current,
        prompt: buildShotPrompt(row, index),
        model: params.settings.model,
        count: 1,
        modeType: 'text2image',
        settings: {
          ...base.settings,
          ...currentSettings,
          ratio: params.settings.ratio,
          resolution: params.settings.resolution,
        },
        textList: uniqueNodeRefs(current.textList, { nodeId: id, url: '' }),
        advancedSettings: {
          ...advancedSettings,
          scriptSource: sourceIdForRow(row, index, id),
          storyboard: {
            stylePreset: params.settings.stylePreset,
            updatedAtMs: Date.now(),
          },
        },
      }
    },
    [id, params.settings]
  )

  const findLinkedImageNode = useCallback(
    (row: ScriptRowExt) => {
      if (row.imageNodeId) {
        const linked = nodes.find((node) => node.id === row.imageNodeId && node.data.type === 'image')
        if (linked) return linked
      }
      return nodes.find((node) => {
        if (node.data.type !== 'image') return false
        const source = getScriptSource(node.data.params)
        return source?.nodeId === id && source?.rowId === row.id
      })
    },
    [id, nodes]
  )

  const ensureImageNodeForRow = useCallback(
    (
      row: ScriptRowExt,
      index: number,
      currentEdges: Edge[] = useCanvasStore.getState().edges,
      options: { updateExistingParams?: boolean } = {}
    ) => {
      const sourceNode = nodes.find((node) => node.id === id || node.data.nodeKey === id)
      const sourceWidth = Number(sourceNode?.measured?.width ?? sourceNode?.width ?? sourceNode?.data.contentWidth ?? 920)
      const sourceHeight = Number(sourceNode?.measured?.height ?? sourceNode?.height ?? sourceNode?.data.contentHeight ?? 440)
      const x = (sourceNode?.position.x ?? 0) + sourceWidth + 140
      const y = (sourceNode?.position.y ?? 0) + Math.min(index * 132, Math.max(0, sourceHeight - 160))
      const shotLabel = formatShotLabel(row, index)
      const existingNode = findLinkedImageNode(row)

      if (existingNode) {
        const currentParams = ((existingNode.data.params ?? {}) as Record<string, unknown>)
        const currentAdvancedSettings = (currentParams.advancedSettings ?? {}) as Record<string, unknown>
        const nextParams = options.updateExistingParams
          ? prepareImageParamsForRow(existingNode, row, index)
          : {
            ...currentParams,
            textList: uniqueNodeRefs(currentParams.textList, { nodeId: id, url: '' }),
            advancedSettings: {
              ...currentAdvancedSettings,
              scriptSource: sourceIdForRow(row, index, id),
            },
          }
        const edgeId = `e-${id}-${existingNode.id}`
        updateNodeData(existingNode.id, { params: nextParams as unknown as Record<string, unknown> })
        return {
          nodeId: existingNode.id,
          created: false,
          edges: currentEdges.some((edge) => edge.id === edgeId)
            ? currentEdges
            : addEdge({
              id: edgeId,
              source: id,
              target: existingNode.id,
              type: 'glow',
              selectable: true,
              interactionWidth: 34,
            }, currentEdges),
        }
      }

      const nextParams = prepareImageParamsForRow(undefined, row, index)
      const createdNode = addNodeAt('image', x, y, {
        name: `分镜 ${shotLabel}`,
        params: nextParams as unknown as Record<string, unknown>,
      })

      const edgeId = `e-${id}-${createdNode.id}`
      return {
        nodeId: createdNode.id,
        created: true,
        edges: currentEdges.some((edge) => edge.id === edgeId)
          ? currentEdges
          : addEdge({
            id: edgeId,
            source: id,
            target: createdNode.id,
            type: 'glow',
            selectable: true,
            interactionWidth: 34,
          }, currentEdges),
      }
    },
    [addNodeAt, findLinkedImageNode, id, nodes, prepareImageParamsForRow, updateNodeData]
  )

  const convertRowToImageNode = useCallback(
    (row: ScriptRowExt, index: number) => {
      setError(null)
      setNotice(null)
      const result = ensureImageNodeForRow(row, index)
      setEdges(result.edges)
      syncRowsWithImageLinks({ [row.id]: result.nodeId })
      setNotice(result.created ? '已创建图片节点' : '这条分镜已经有图片节点，已补齐回链')
      return result.nodeId
    },
    [ensureImageNodeForRow, setEdges, syncRowsWithImageLinks]
  )

  const convertAllRowsToImageNodes = useCallback(() => {
    const usableRows = params.rows.filter(rowHasContent)
    if (usableRows.length === 0) {
      setNotice(null)
      setError('没有可转换的分镜行')
      return {}
    }

    setError(null)
    let nextEdges = useCanvasStore.getState().edges
    let createdCount = 0
    let keptCount = 0
    const links: Record<string, string> = {}

    params.rows.forEach((row, index) => {
      if (!rowHasContent(row)) return
      const result = ensureImageNodeForRow(row, index, nextEdges)
      nextEdges = result.edges
      links[row.id] = result.nodeId
      if (result.created) createdCount += 1
      else keptCount += 1
    })

    setEdges(nextEdges)
    syncRowsWithImageLinks(links)
    setNotice(`已创建 ${createdCount} 个图片节点${keptCount ? `，更新 ${keptCount} 个已有节点` : ''}`)
    return links
  }, [ensureImageNodeForRow, params.rows, setEdges, syncRowsWithImageLinks])

  const startImageGeneration = useCallback(
    async (nodeId: string, row: ScriptRowExt, index: number) => {
      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId || item.data.nodeKey === nodeId)
      const nextParams = prepareImageParamsForRow(node, row, index)
      updateNodeData(nodeId, {
        action: 'image_generate',
        params: nextParams as unknown as Record<string, unknown>,
        taskInfo: undefined,
      })
      const result = await generateApi.image(data.projectUuid, nodeId, {
        ...nextParams,
        model: normalizeImageModel(String(nextParams.model)),
      } as unknown as Record<string, unknown>)
      addTask(result.jobId, nodeId, result.generationVersion)
      startPolling(result.jobId, data.projectUuid)
    },
    [addTask, data.projectUuid, prepareImageParamsForRow, startPolling, updateNodeData]
  )

  const generateImageForRow = useCallback(
    async (row: ScriptRowExt, index: number) => {
      if (!rowHasContent(row)) {
        setError('这条分镜没有可生成的内容')
        return
      }
      setError(null)
      setNotice(null)
      try {
        const nodeId = convertRowToImageNode(row, index)
        await startImageGeneration(nodeId, row, index)
        setNotice('已提交图片生成任务')
      } catch (err) {
        const apiError = err as { response?: { data?: { error?: unknown } }; message?: string }
        setError(errorToText(apiError.response?.data?.error ?? apiError.message, '图片生成失败'))
      }
    },
    [convertRowToImageNode, startImageGeneration]
  )

  const submitRowsToImageGeneration = useCallback(
    async (rows: ScriptRowExt[]) => {
      const rowsToGenerate = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => rowHasContent(row))
      const links: Record<string, string> = {}
      if (rowsToGenerate.length === 0) return { submitted: 0, links, error: null as string | null }

      setIsGeneratingImages(true)
      let nextEdges = useCanvasStore.getState().edges
      let submitted = 0
      let firstError: string | null = null
      try {
        for (const { row, index } of rowsToGenerate) {
          try {
            const result = ensureImageNodeForRow(row, index, nextEdges, { updateExistingParams: true })
            nextEdges = result.edges
            links[row.id] = result.nodeId
            await startImageGeneration(result.nodeId, row, index)
            submitted += 1
          } catch (err) {
            const apiError = err as { response?: { data?: { error?: unknown } }; message?: string }
            firstError = errorToText(apiError.response?.data?.error ?? apiError.message, '图片生成失败')
            break
          }
        }
        setEdges(nextEdges)
        return { submitted, links, error: firstError }
      } finally {
        setIsGeneratingImages(false)
      }
    },
    [ensureImageNodeForRow, setEdges, startImageGeneration]
  )

  const generateMissingImages = useCallback(async () => {
    const rowsToGenerate = params.rows
      .map((row, index) => ({ row, index, node: rowImageMap.get(row.id) }))
      .filter(({ row, node }) => rowHasContent(row) && !primaryImageUrl(node) && !node?.data.taskInfo?.loading)
    if (rowsToGenerate.length === 0) {
      setError(null)
      setNotice('没有缺失图片的分镜行')
      return
    }

    setIsGeneratingImages(true)
    setError(null)
    setNotice(`开始提交 ${rowsToGenerate.length} 个图片生成任务`)
    try {
      let nextEdges = useCanvasStore.getState().edges
      const links: Record<string, string> = {}
      for (const { row, index } of rowsToGenerate) {
        const result = ensureImageNodeForRow(row, index, nextEdges)
        nextEdges = result.edges
        links[row.id] = result.nodeId
        await startImageGeneration(result.nodeId, row, index)
      }
      setEdges(nextEdges)
      syncRowsWithImageLinks(links)
      setNotice(`已提交 ${rowsToGenerate.length} 个图片生成任务`)
    } catch (err) {
      const apiError = err as { response?: { data?: { error?: unknown } }; message?: string }
      setError(errorToText(apiError.response?.data?.error ?? apiError.message, '批量生成图片失败'))
    } finally {
      setIsGeneratingImages(false)
    }
  }, [ensureImageNodeForRow, params.rows, rowImageMap, setEdges, startImageGeneration, syncRowsWithImageLinks])

  const handleGenerateScript = useCallback(async () => {
    if (!params.description.trim()) {
      setError('先输入故事描述')
      return
    }
    if (params.rows.length > 0 && !window.confirm('AI 生成会替换当前分镜表，已有图片节点不会被删除。继续吗？')) return
    if (isSubmitting) return
    setIsSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      const result = await generateApi.script(data.projectUuid, id, {
        description: buildStoryboardPrompt(params),
        textModel: DEFAULT_TEXT_MODEL,
      })
      if (result.taskId) {
        const task = await generateApi.poll(result.taskId)
        if (task.meta?.shouldApply === false) {
          setNotice('本次分镜结果已被更新的生成任务取代，未覆盖当前内容')
          return
        }
      }
      const rows = parseScriptRows(result.text)
      setRows(rows)
      const imageResult = await submitRowsToImageGeneration(rows)
      const rowsWithLinks = rows.map((row) => imageResult.links[row.id] ? { ...row, imageNodeId: imageResult.links[row.id] } : row)
      if (Object.keys(imageResult.links).length) setRows(rowsWithLinks)
      if (imageResult.error) {
        setError(imageResult.error)
        setNotice(`\u5df2\u751f\u6210 ${rows.length} \u6761\u5206\u955c\uff0c\u5df2\u63d0\u4ea4 ${imageResult.submitted} \u5f20\u56fe\u7247\uff0c\u90e8\u5206\u56fe\u7247\u672a\u63d0\u4ea4`)
      } else {
        setNotice(`\u5df2\u751f\u6210 ${rows.length} \u6761\u5206\u955c\uff0c\u5df2\u63d0\u4ea4 ${imageResult.submitted} \u5f20\u56fe\u7247\u751f\u6210`)
      }
      if (result.taskId) {
        void generateApi.apply(result.taskId).catch(error => console.warn('mark script task applied failed', error))
      }
      return
    } catch (err) {
      const apiError = err as { response?: { data?: { error?: unknown } }; message?: string }
      setError(errorToText(apiError.response?.data?.error ?? apiError.message, '生成分镜失败'))
    } finally {
      setIsSubmitting(false)
    }
  }, [data.projectUuid, id, isSubmitting, params, setRows, submitRowsToImageGeneration])

  const exportStoryboard = useCallback(() => {
    downloadJson(`${stripUnsafeFileName(data.name)}.storyboard.json`, {
      version: 1,
      name: data.name,
      description: params.description,
      settings: params.settings,
      rows: params.rows,
    })
  }, [data.name, params.description, params.rows, params.settings])

  const importStoryboardFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (!file) return
      try {
        const text = await file.text()
        const parsed = JSON.parse(text)
        const rows = getRowCandidates(parsed).map((row, index) => normalizeRow(row as Record<string, unknown>, index))
        if (rows.length === 0) throw new Error('JSON 里没有 rows/shots/storyboard 数组')
        if (params.rows.length > 0 && !window.confirm('导入会替换当前分镜表，已有图片节点不会被删除。继续吗？')) return
        const nextDescription = typeof parsed.description === 'string' ? parsed.description : params.description
        const nextSettings = normalizeSettings(parsed.settings as Record<string, unknown> | undefined)
        setParams({ description: nextDescription, rows, settings: nextSettings })
        setError(null)
        setNotice(`已导入 ${rows.length} 条分镜`)
      } catch (err) {
        setNotice(null)
        setError(err instanceof Error ? err.message : '导入失败')
      }
    },
    [params.description, params.rows.length, setParams]
  )

  const selectImageNode = useCallback(
    (nodeId: string) => {
      setSelected([nodeId])
    },
    [setSelected]
  )

  const toolbar = isPanelActive ? (
    <MediaNodeToolbar
      actions={[
        {
          key: 'generate',
          label: isSubmitting ? '生成中' : 'AI 生成分镜',
          icon: isSubmitting || isGeneratingImages ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />,
          onClick: handleGenerateScript,
          disabled: isSubmitting || isGeneratingImages,
        },
        { key: 'add-row', label: '添加镜头', icon: <Plus size={16} />, onClick: addRow },
        { key: 'rows-to-images', label: '全部转图片节点', icon: <Images size={16} />, onClick: convertAllRowsToImageNodes },
        {
          key: 'generate-missing',
          label: isGeneratingImages ? '提交中' : '生成缺失图片',
          icon: isGeneratingImages ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />,
          onClick: generateMissingImages,
          disabled: isGeneratingImages,
        },
        { key: 'export', label: '导出 JSON', icon: <Download size={16} />, onClick: exportStoryboard },
      ]}
    />
  ) : undefined

  return (
    <NodeShell
      nodeKey={id}
      data={data}
      selected={selected}
      toolbar={toolbar}
      minWidth={920}
      minHeight={430}
      bodyStyle={{ background: '#12101b' }}
    >
      <div
        className="script-node-drag-area script-node-grip"
        title="拖动脚本节点"
        style={{
          height: 12,
          margin: '7px 14px -5px',
          borderRadius: 999,
          cursor: 'grab',
          background: 'rgba(124,92,252,0.08)',
        }}
      />
      <div
        className="script-node-drag-area script-node-root"
        onPointerDownCapture={(event) => {
          if (shouldBlockScriptNodeDrag(event.target)) event.stopPropagation()
        }}
        onMouseDownCapture={(event) => {
          if (shouldBlockScriptNodeDrag(event.target)) event.stopPropagation()
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 14,
          color: '#eeeaff',
          fontSize: 12,
        }}
      >
        <div className="script-node-settings" style={{ display: 'grid', gridTemplateColumns: 'minmax(280px,1fr) 118px 124px 104px 104px 176px', gap: 8 }}>
          <textarea
            className="script-node-description"
            value={params.description}
            onChange={(event) => setParams({ description: event.currentTarget.value })}
            placeholder="输入故事描述，或直接在下方编辑分镜表"
            style={{ ...inputStyle, minHeight: 78, padding: '10px 12px', resize: 'vertical', lineHeight: 1.5 }}
          />
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: '#9187b1' }}>
            分镜数
            <input
              type="number"
              min={1}
              max={80}
              value={params.settings.shotCount}
              onChange={(event) => setSetting('shotCount', clampNumber(Number(event.currentTarget.value), 1, 80, DEFAULT_SETTINGS.shotCount))}
              style={{ ...inputStyle, height: 34, padding: '0 9px' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: '#9187b1' }}>
            风格
            <select
              value={params.settings.stylePreset}
              onChange={(event) => setSetting('stylePreset', event.currentTarget.value)}
              style={{ ...inputStyle, height: 34, padding: '0 8px' }}
            >
              {STYLE_PRESETS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: '#9187b1' }}>
            比例
            <select
              value={params.settings.ratio}
              onChange={(event) => setSetting('ratio', event.currentTarget.value)}
              style={{ ...inputStyle, height: 34, padding: '0 8px' }}
            >
              {imageRatioOptions.map((ratio) => <option key={ratio.value} value={ratio.value}>{ratio.label}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: '#9187b1' }}>
            清晰度
            <select
              value={params.settings.resolution}
              onChange={(event) => setSetting('resolution', event.currentTarget.value)}
              style={{ ...inputStyle, height: 34, padding: '0 8px' }}
            >
              {imageResolutionOptions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: '#9187b1' }}>
            图片模型
            <select
              value={params.settings.model}
              onChange={(event) => setSetting('model', normalizeImageModel(event.currentTarget.value))}
              style={{ ...inputStyle, height: 34, padding: '0 8px' }}
            >
              {IMAGE_MODELS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
          </label>
        </div>

        <div className="script-node-summary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', color: '#9187b1' }}>
            <span>镜头 {params.rows.length}</span>
            <span>时长 {totalDuration.toFixed(totalDuration % 1 === 0 ? 0 : 1)}s</span>
            <span>已连图片 {linkedCount}</span>
            <span>已出图 {generatedCount}</span>
          </div>
          <button
            className="script-node-primary-button"
            title="AI 生成分镜"
            onClick={handleGenerateScript}
            disabled={isSubmitting || isGeneratingImages}
            style={{
              ...textButtonStyle,
              width: 112,
              background: isSubmitting ? 'rgba(124,92,252,0.08)' : 'rgba(124,92,252,0.18)',
              color: isSubmitting ? '#83799f' : '#f7f3ff',
              cursor: isSubmitting ? 'default' : 'pointer',
            }}
          >
            {isSubmitting || isGeneratingImages ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            生成分镜
          </button>
        </div>

        {error && (
          <div className="script-node-message is-error" style={{ borderRadius: 8, background: 'rgba(120,18,38,0.32)', color: '#ff8aa0', padding: '8px 10px', border: '1px solid rgba(255,95,126,0.18)' }}>
            {error}
          </div>
        )}

        {notice && (
          <div className="script-node-message is-notice" style={{ borderRadius: 8, background: 'rgba(48,42,92,0.34)', color: '#d6ccff', padding: '8px 10px', border: '1px solid rgba(124,92,252,0.18)' }}>
            {notice}
          </div>
        )}

        <div className="script-node-table" style={{ border: '1px solid rgba(124,92,252,0.16)', borderRadius: 10, overflow: 'hidden', background: 'rgba(8,6,18,0.42)' }}>
          <div
            className="script-node-table-head"
            style={{
              display: 'grid',
              gridTemplateColumns: '74px 64px 88px minmax(210px,1.25fr) minmax(150px,0.8fr) 64px 208px',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              borderBottom: '1px solid rgba(124,92,252,0.14)',
              color: '#9187b1',
              fontSize: 11,
              letterSpacing: 0,
            }}
          >
            <span>画面</span>
            <span>镜号</span>
            <span>景别</span>
            <span>画面/动作</span>
            <span>对白/备注</span>
            <span>时长</span>
            <span style={{ textAlign: 'right' }}>操作</span>
          </div>

          {params.rows.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#746a91' }}>还没有分镜，先添加镜头或用 AI 生成。</div>
          ) : (
            params.rows.map((row, index) => {
              const linkedNode = rowImageMap.get(row.id)
              const imageUrl = primaryImageUrl(linkedNode)
              const isImageLoading = Boolean(linkedNode?.data.taskInfo?.loading)
              const rowError = linkedNode?.data.taskInfo?.status === 3 ? errorToText(linkedNode.data.taskInfo.error, '') : ''
              return (
                <div
                  key={row.id}
                  className="script-node-table-row"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '74px 64px 88px minmax(210px,1.25fr) minmax(150px,0.8fr) 64px 208px',
                    alignItems: 'start',
                    gap: 8,
                    padding: '8px 10px',
                    borderTop: index === 0 ? 'none' : '1px solid rgba(124,92,252,0.1)',
                  }}
                >
                  <button
                    className="script-node-preview-button"
                    title={linkedNode ? '定位图片节点' : '还没有图片节点'}
                    onClick={() => linkedNode && selectImageNode(linkedNode.id)}
                    style={{
                      width: 68,
                      height: 48,
                      border: '1px solid rgba(124,92,252,0.2)',
                      borderRadius: 7,
                      background: 'rgba(13,10,28,0.92)',
                      color: '#9f94c9',
                      cursor: linkedNode ? 'pointer' : 'default',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      padding: 0,
                    }}
                  >
                    {imageUrl ? (
                      <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    ) : isImageLoading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <ImagePlus size={16} />
                    )}
                  </button>
                  <input
                    value={row.shot}
                    onChange={(event) => updateRow(row.id, 'shot', event.currentTarget.value)}
                    style={{ ...inputStyle, height: 32, padding: '0 8px' }}
                  />
                  <select
                    value={row.sceneType}
                    onChange={(event) => updateRow(row.id, 'sceneType', event.currentTarget.value)}
                    style={{ ...inputStyle, height: 32, padding: '0 7px' }}
                  >
                    {SCENE_TYPES.map((type) => (
                      <option key={type || 'empty'} value={type}>{type || '未定'}</option>
                    ))}
                  </select>
                  <textarea
                    value={row.action}
                    onChange={(event) => updateRow(row.id, 'action', event.currentTarget.value)}
                    placeholder="画面内容、人物动作、镜头运动"
                    style={{ ...inputStyle, minHeight: 54, padding: '7px 8px', resize: 'vertical', lineHeight: 1.45 }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <textarea
                      value={row.dialogue}
                      onChange={(event) => updateRow(row.id, 'dialogue', event.currentTarget.value)}
                      placeholder="对白/旁白"
                      style={{ ...inputStyle, minHeight: 32, padding: '7px 8px', resize: 'vertical', lineHeight: 1.45 }}
                    />
                    <input
                      value={row.notes ?? ''}
                      onChange={(event) => updateRow(row.id, 'notes', event.currentTarget.value)}
                      placeholder="备注"
                      style={{ ...inputStyle, height: 26, padding: '0 8px', color: '#c7bddf' }}
                    />
                    {rowError && <span style={{ color: '#ff8aa0', fontSize: 11 }}>{rowError}</span>}
                  </div>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={row.duration}
                    onChange={(event) => updateRow(row.id, 'duration', Number(event.currentTarget.value))}
                    style={{ ...inputStyle, height: 32, padding: '0 8px' }}
                  />
                  <div className="script-node-row-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
                    <button title="上移" style={iconButtonStyle} onClick={() => moveRow(row.id, -1)} disabled={index === 0}>
                      <ArrowUp size={14} />
                    </button>
                    <button title="下移" style={iconButtonStyle} onClick={() => moveRow(row.id, 1)} disabled={index === params.rows.length - 1}>
                      <ArrowDown size={14} />
                    </button>
                    <button title="复制镜头" style={iconButtonStyle} onClick={() => copyRow(row)}>
                      <Copy size={14} />
                    </button>
                    <button title="转为图片节点" style={iconButtonStyle} onClick={() => convertRowToImageNode(row, index)}>
                      <ImagePlus size={14} />
                    </button>
                    <button title={imageUrl ? '按本行分镜重生成图片' : '生成图片'} style={iconButtonStyle} onClick={() => generateImageForRow(row, index)}>
                      {isImageLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    </button>
                    <button title="定位图片节点" style={iconButtonStyle} onClick={() => linkedNode && selectImageNode(linkedNode.id)} disabled={!linkedNode}>
                      <LocateFixed size={14} />
                    </button>
                    <button title="删除镜头" style={{ ...iconButtonStyle, color: '#ff9aa8' }} onClick={() => deleteRow(row.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <input ref={importInputRef} type="file" accept="application/json,.json" onChange={importStoryboardFile} style={{ display: 'none' }} />
        <div className="script-node-footer-actions" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 8 }}>
          <button title="添加镜头" onClick={addRow} style={textButtonStyle}>
            <Plus size={15} />
            添加镜头
          </button>
          <button title="全部转图片节点" onClick={convertAllRowsToImageNodes} style={textButtonStyle}>
            <Images size={15} />
            全部转图片
          </button>
          <button
            title="生成缺失图片"
            onClick={generateMissingImages}
            disabled={isGeneratingImages}
            style={{ ...textButtonStyle, color: isGeneratingImages ? '#7c7294' : '#cfc5ff', cursor: isGeneratingImages ? 'default' : 'pointer' }}
          >
            {isGeneratingImages ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            生成缺失图片
          </button>
          <button title="导出 JSON" onClick={exportStoryboard} style={textButtonStyle}>
            <FileJson size={15} />
            导出 JSON
          </button>
          <button title="导入 JSON" onClick={() => importInputRef.current?.click()} style={textButtonStyle}>
            <Upload size={15} />
            导入 JSON
          </button>
        </div>
      </div>
    </NodeShell>
  )
}
