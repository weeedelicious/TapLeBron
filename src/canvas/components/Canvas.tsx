import { useCallback, useEffect, useRef, useMemo, useState, type CSSProperties } from 'react'
import {
  ReactFlow,
  Background,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  addEdge,
  type Viewport,
  BackgroundVariant,
  SelectionMode,
  type Node,
  type ReactFlowInstance,
  getBezierPath,
  type EdgeProps,
  EdgeLabelRenderer,
  useViewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { LayoutGrid } from 'lucide-react'
import { edgesFromNodeReferences, markNodesDeletedByUser, useCanvasStore } from '@/store/canvasStore'
import {
  clearedImageCompareRefs,
  compareRefFromNode,
  isImageCompareNodeData,
  planImageCompareAssignment,
} from '@/features/image-compare/image-compare'
import {
  clearedVideoCompareRefs,
  compareVideoRefFromNode,
  isVideoCompareNodeData,
  nextUnusedVideoCompareUrl,
  planVideoCompareAssignment,
  videoCompareHandleFromEdge,
} from '@/features/video-compare/video-compare'
import { useTasksStore } from '@/store/tasksStore'
import { nodeTypes } from './NodeRegistry'
import { MultiSelectToolbar } from './MultiSelectToolbar'
import { CanvasAssetDock, readAssetDockMode, writeAssetDockMode, type AssetDockMode } from './CanvasAssetDock'
import { ShortcutsPanel } from './KeyboardShortcuts'
import { HistoryAssetsPanel, collectHistoryAssets, nodeIncludesHistoryAsset, type HistoryAsset } from './HistoryAssetsPanel'
import { BottomDock } from './BottomDock'
import { CindyAssistantPanel } from './CindyAssistantPanel'
import { CindyModeSelector } from './CindyModeSelector'
import { OfficialTemplateLibrary } from './OfficialTemplateLibrary'
import { assetsApi, favoritesApi, historyAssetsApi } from '@/lib/api'
import { PanoramaViewerModal } from '@/features/panorama/PanoramaViewerModal'
import { isPanoramaNodeData } from '@/features/panorama/panorama'
import { textPromptFromNodeData } from '@/lib/textPrompt'
import { isCanvasContextMenuTarget } from '@/lib/canvasContextMenu'
import { nodePickerFlyoutFixedStyle, nodePickerMaxHeight } from '@/lib/nodePickerLayout'
import { primaryOutputUrl } from '@/lib/primaryOutput'
import { clearedStageRef } from '@/features/director-stage/stageReference'
import { hoistGroupNodesForRender } from '@/lib/groupRenderOrder'
import {
  isCanvasMiddleButton,
  isExpandedGalleryPanTarget,
  nextCanvasPanViewport,
} from '@/lib/canvasMiddlePan'
import { DEFAULT_IMAGE_MODEL, defaultAudioParams, defaultImageParams, defaultTextParams, defaultVideoParams } from '@/lib/nodeData'
import { getImageRatioOptions, normalizeImageRatioValue, normalizeImageResolutionValue, normalizeImageGenerationCount } from '@/lib/imageRules'
import { getVideoRatioOptions, normalizeVideoRatioValue, normalizeVideoResolutionValue, normalizeVideoDurationValue, normalizeVideoGenerationCount } from '@/lib/videoRules'
import type { CanvasNodeData, FavoriteLibraryItem, NodeRef, ResourceMeta } from '@/lib/types'
import type { CindyCanvasContext, CindyProposal, CindyProposalNodeSettings } from '@/lib/cindyAssistant'
import {
  mergeAssetCreatedAtMap,
  normalizeAssetTimestamp,
  type AssetCreatedAtMap,
} from '@/lib/assetTimestamps'

const EDGE_INTERACTION_WIDTH = 34
const EDGE_INTERACTION_MIN_SCREEN_WIDTH = 10
const EDGE_INTERACTION_MAX_SCREEN_WIDTH = 44
const NODE_TITLE_SCREEN_HEIGHT = 26
const GROUP_BOUNDS_PADDING_SCREEN = 10
const NODE_REF_LIST_KEYS = ['imageList', 'videoList', 'audioList', 'textList', 'mixedList'] as const
const NODE_REF_ORDER_KEYS = ['imageListOrder', 'mixedListOrder'] as const
const MOBILE_CANVAS_QUERY = '(max-width: 900px), (pointer: coarse)'

type FileInputWithPicker = HTMLInputElement & {
  showPicker?: () => void
}

function mobileCanvasQueryMatches() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(MOBILE_CANVAS_QUERY).matches
}

function removeEdgeReferencesFromNodes(nodes: FlowNode[], removedEdges: Edge[]) {
  const aliasesBySource = new Map<string, Set<string>>()
  for (const node of nodes) {
    const aliases = new Set([node.id, node.data.nodeKey].filter(Boolean))
    aliasesBySource.set(node.id, aliases)
    aliasesBySource.set(node.data.nodeKey, aliases)
  }

  const removalsByTarget = new Map<string, Set<string>>()
  const handlesByTarget = new Map<string, Set<unknown>>()
  const edgeCountByTarget = new Map<string, number>()
  for (const edge of removedEdges) {
    const sourceAliases = aliasesBySource.get(edge.source) ?? new Set([edge.source])
    const targetNode = nodes.find(node => node.id === edge.target || node.data.nodeKey === edge.target)
    const targetAliases = [edge.target, targetNode?.id, targetNode?.data.nodeKey].filter(Boolean) as string[]
    for (const targetAlias of targetAliases) {
      const existing = removalsByTarget.get(targetAlias) ?? new Set<string>()
      sourceAliases.forEach(alias => existing.add(alias))
      removalsByTarget.set(targetAlias, existing)
      edgeCountByTarget.set(targetAlias, (edgeCountByTarget.get(targetAlias) ?? 0) + 1)
      const handles = handlesByTarget.get(targetAlias) ?? new Set<unknown>()
      const compareHandle = videoCompareHandleFromEdge(edge) ?? edge.targetHandle
      if (compareHandle) handles.add(compareHandle)
      handlesByTarget.set(targetAlias, handles)
    }
  }

  let changed = false
  const nextNodes = nodes.map(node => {
    const removeSourceIds = removalsByTarget.get(node.id) ?? removalsByTarget.get(node.data.nodeKey)
    if (!removeSourceIds || removeSourceIds.size === 0) return node

    const params = (node.data.params ?? {}) as Record<string, unknown>
    let nextParams: Record<string, unknown> | null = null
    const ensureNextParams = () => {
      if (!nextParams) nextParams = { ...params }
      return nextParams
    }

    const isCompareNode = isImageCompareNodeData(node.data) || isVideoCompareNodeData(node.data)
    if (!isCompareNode) {
      for (const listKey of NODE_REF_LIST_KEYS) {
        const value = params[listKey]
        if (!Array.isArray(value)) continue
        const filtered = value.filter(item => {
          const nodeId = String((item as { nodeId?: unknown })?.nodeId ?? '')
          return !removeSourceIds.has(nodeId)
        })
        if (filtered.length !== value.length) ensureNextParams()[listKey] = filtered
      }

      for (const orderKey of NODE_REF_ORDER_KEYS) {
        const value = params[orderKey]
        if (!Array.isArray(value)) continue
        const filtered = value.filter(item => !removeSourceIds.has(String(item ?? '')))
        if (filtered.length !== value.length) ensureNextParams()[orderKey] = filtered
      }
    }

    const panoramaRef = params.panoramaRef as { nodeId?: unknown } | null | undefined
    if (panoramaRef?.nodeId && removeSourceIds.has(String(panoramaRef.nodeId))) {
      ensureNextParams().panoramaRef = null
    }

    // 三维空间节点的参考图同理：上游图片被删掉就把引用清空，否则节点会一直显示
    // 「参考图已连」而实际上分析时取不到图。
    const clearedStage = clearedStageRef(params, removeSourceIds)
    if (clearedStage) Object.assign(ensureNextParams(), clearedStage)

    // 图片对比 / 视频对比的槽位清理不能混用：视频对比的 compareRefA/B 字段名
    // 和图片对比一样，按节点 id 清会把同一多视频占的多个槽一次清光。
    if (isImageCompareNodeData(node.data)) {
      const clearedCompareRefs = clearedImageCompareRefs(params, removeSourceIds)
      if (clearedCompareRefs) Object.assign(ensureNextParams(), clearedCompareRefs)
    }
    if (isVideoCompareNodeData(node.data)) {
      const clearedVideoCompare = clearedVideoCompareRefs(
        params,
        removeSourceIds,
        handlesByTarget.get(node.id)
          ?? handlesByTarget.get(node.data.nodeKey)
          ?? new Set<unknown>(),
        edgeCountByTarget.get(node.id) ?? edgeCountByTarget.get(node.data.nodeKey),
      )
      if (clearedVideoCompare) Object.assign(ensureNextParams(), clearedVideoCompare)
    }

    if (!nextParams) return node
    changed = true
    return { ...node, data: { ...node.data, params: nextParams } }
  })

  return { nodes: nextNodes, changed }
}
const SHOTFLOW_NODE_CLIPBOARD_MIME = 'application/x-shotflow-nodes'
const SHOTFLOW_NODE_CLIPBOARD_KIND = 'shotflow.nodes'
const SHOTFLOW_HISTORY_ASSET_DRAG_MIME = 'application/x-shotflow-history-asset'
const SHOTFLOW_FAVORITE_ITEM_DRAG_MIME = 'application/x-shotflow-favorite-item'
const SHOTFLOW_NODE_CLIPBOARD_TEXT = 'Shotflow 节点'

const INTERNAL_NODE_CLIPBOARD_TTL_MS = 30_000
const FOCUS_ZOOM_STEPS = [1, 0.55, 1.65] as const

function readDragPayload<T>(dataTransfer: DataTransfer, mime: string): T | null {
  const raw = dataTransfer.getData(mime)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    console.warn('Invalid Shotflow drag payload', error)
    return null
  }
}

function getNodeBounds(
  nodes: Array<{
    position: { x: number; y: number }
    measured?: { width?: number; height?: number }
    width?: number
    height?: number
    data?: { contentWidth?: number; contentHeight?: number }
  }>
) {
  if (nodes.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const node of nodes) {
    const width = Number(node.data?.contentWidth ?? node.width ?? node.measured?.width ?? 240)
    const height = Number(node.data?.contentHeight ?? node.height ?? node.measured?.height ?? 160)
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x + width)
    maxY = Math.max(maxY, node.position.y + height)
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

function collectFlowSelection(
  edges: Array<{ id: string; source: string; target: string }>,
  selectedNodeIds: string[]
) {
  const edgeIds = new Set<string>()
  const nodeIds = new Set<string>(selectedNodeIds)

  if (selectedNodeIds.length === 0 || edges.length === 0) {
    return { edgeIds, nodeIds }
  }

  const outgoing = new Map<string, Array<{ id: string; source: string; target: string }>>()
  const incoming = new Map<string, Array<{ id: string; source: string; target: string }>>()

  for (const edge of edges) {
    const out = outgoing.get(edge.source)
    if (out) out.push(edge)
    else outgoing.set(edge.source, [edge])

    const inc = incoming.get(edge.target)
    if (inc) inc.push(edge)
    else incoming.set(edge.target, [edge])
  }

  const walk = (
    startNodeIds: string[],
    nextEdgesForNode: Map<string, Array<{ id: string; source: string; target: string }>>,
    getNextNodeId: (edge: { id: string; source: string; target: string }) => string
  ) => {
    const queue = [...startNodeIds]
    const visitedNodes = new Set(startNodeIds)

    while (queue.length > 0) {
      const nodeId = queue.shift()
      if (!nodeId) continue
      for (const edge of nextEdgesForNode.get(nodeId) ?? []) {
        edgeIds.add(edge.id)
        const nextNodeId = getNextNodeId(edge)
        nodeIds.add(nextNodeId)
        if (!visitedNodes.has(nextNodeId)) {
          visitedNodes.add(nextNodeId)
          queue.push(nextNodeId)
        }
      }
    }
  }

  walk(selectedNodeIds, outgoing, (edge) => edge.target)
  walk(selectedNodeIds, incoming, (edge) => edge.source)

  return { edgeIds, nodeIds }
}

function resourceMetaFromUploadPayload(meta: Record<string, unknown> | undefined, fallbackKind: ResourceMeta['kind']) {
  if (!meta || typeof meta !== 'object') return null

  const width = Number(meta.width)
  const height = Number(meta.height)
  const durationSec = Number(meta.durationSec)
  const byteSize = Number(meta.byteSize)
  const displayByteSize = Number(meta.displayByteSize)
  const displayWidth = Number(meta.displayWidth)
  const displayHeight = Number(meta.displayHeight)
  const displayDurationSec = Number(meta.displayDurationSec)
  const createdAtMs = Number(meta.createdAtMs)

  return {
    kind: fallbackKind,
    mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : undefined,
    extension: typeof meta.extension === 'string' ? meta.extension : undefined,
    hashSha1: typeof meta.sha1 === 'string' ? meta.sha1 : undefined,
    displayUrl: typeof meta.displayUrl === 'string' ? meta.displayUrl : undefined,
    originalUrl: typeof meta.originalUrl === 'string' ? meta.originalUrl : undefined,
    displayByteSize: Number.isFinite(displayByteSize) && displayByteSize > 0 ? displayByteSize : undefined,
    displayWidth: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : undefined,
    displayHeight: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : undefined,
    displayDurationSec: Number.isFinite(displayDurationSec) && displayDurationSec > 0 ? displayDurationSec : undefined,
    byteSize: Number.isFinite(byteSize) && byteSize > 0 ? byteSize : undefined,
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined,
    createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : Date.now(),
  } as ResourceMeta
}

const RATIO_DEFINITIONS = [
  { value: '1:1', w: 1, h: 1 },
  { value: '16:9', w: 16, h: 9 },
  { value: '9:16', w: 9, h: 16 },
  { value: '4:3', w: 4, h: 3 },
  { value: '3:4', w: 3, h: 4 },
  { value: '3:2', w: 3, h: 2 },
  { value: '2:3', w: 2, h: 3 },
  { value: '4:5', w: 4, h: 5 },
  { value: '5:4', w: 5, h: 4 },
  { value: '21:9', w: 21, h: 9 },
]
const EXACT_DIMENSION_RATIO_OVERRIDES: Record<string, string> = {
  '720x1280': '2:3',
}

function supportedRatiosForTarget(targetType: string, targetModel?: string) {
  if (targetType === 'image') return getImageRatioOptions(targetModel || DEFAULT_IMAGE_MODEL).map((ratio) => ratio.value)
  if (targetType === 'video') return getVideoRatioOptions(targetModel || 'Seedance_2_0').map((ratio) => ratio.value)
  return []
}

function mediaDimensionsFromNodeData(data: CanvasNodeData) {
  const items = (data._resourceMeta?.items ?? []) as ResourceMeta[]
  const preferredKind: ResourceMeta['kind'] =
    data.type === 'video' || data.type === 'video_merge' ? 'video' :
      data.type === 'audio' ? 'audio' : 'image'
  const meta = items.find((item) => item?.kind === preferredKind) ??
    items.find((item) => item?.kind === 'image' || item?.kind === 'video')
  if (!meta) return null

  const width = Number(meta.width || meta.displayWidth)
  const height = Number(meta.height || meta.displayHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width: Math.round(width), height: Math.round(height) }
}

function inheritedRatioForReference(sourceData: CanvasNodeData, targetType: string, targetModel?: string) {
  const supportedRatios = supportedRatiosForTarget(targetType, targetModel)
  if (supportedRatios.length === 0) return null

  const dimensions = mediaDimensionsFromNodeData(sourceData)
  if (!dimensions) return '16:9'

  const dimensionKey = `${dimensions.width}x${dimensions.height}`
  const overrideRatio = EXACT_DIMENSION_RATIO_OVERRIDES[dimensionKey]
  if (overrideRatio && supportedRatios.includes(overrideRatio)) return overrideRatio
  if (overrideRatio) return '16:9'

  const matchedRatio = RATIO_DEFINITIONS.find((ratio) =>
    supportedRatios.includes(ratio.value) &&
    dimensions.width * ratio.h === dimensions.height * ratio.w
  )
  return matchedRatio?.value ?? '16:9'
}

function inheritedSettingsPatchForReference(
  sourceData: CanvasNodeData,
  targetData: CanvasNodeData,
  targetParams: Record<string, unknown>
) {
  const inheritedRatio = inheritedRatioForReference(sourceData, targetData.type, String(targetParams.model || ''))
  if (!inheritedRatio) return {}
  const currentSettings = ((targetParams.settings ?? {}) as Record<string, unknown>)
  return {
    settings: {
      ...currentSettings,
      ratio: inheritedRatio,
    },
  }
}

function collectFlowEdgeIds(
  edges: Array<{ id: string; source: string; target: string }>,
  selectedNodeIds: string[]
) {
  return collectFlowSelection(edges, selectedNodeIds).edgeIds
}

// ── Glow edge with wide hit area + delete button on select ───────────────────
function GlowEdge({ id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps) {
  const { zoom } = useViewport()
  const safeZoom = Math.max(zoom || 1, 0.05)
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const edgeData = data as { isFlowActive?: boolean; selectedEdgeCount?: number } | undefined
  const isFlowActive = Boolean(edgeData?.isFlowActive)
  const selectedEdgeCount = Number(edgeData?.selectedEdgeCount ?? (selected ? 1 : 0))
  const showDeleteButton = Boolean(selected && selectedEdgeCount <= 1)
  const showFlowAnimation = Boolean(isFlowActive && selectedEdgeCount <= 4)
  const interactionScreenWidth = Math.min(
    EDGE_INTERACTION_MAX_SCREEN_WIDTH,
    Math.max(EDGE_INTERACTION_MIN_SCREEN_WIDTH, EDGE_INTERACTION_WIDTH * safeZoom)
  )
  const interactionCanvasWidth = interactionScreenWidth / safeZoom
  const baseStroke = selected
    ? 'rgba(180,210,255,0.92)'
    : isFlowActive
      ? 'rgba(168,214,255,0.95)'
      : 'rgba(100,160,255,0.55)'
  const baseStrokeWidth = selected ? 2.4 : isFlowActive ? 2 : 1.5
  const deleteEdge = () => {
    const { edges, nodes, setEdges, setNodes, pushHistory } = useCanvasStore.getState()
    pushHistory()
    const edge = edges.find(e => e.id === id)
    const remainingEdges = edges.filter(e => e.id !== id)
    let nextNodes = nodes
    if (edge) {
      const result = removeEdgeReferencesFromNodes(nodes, [edge])
      if (result.changed) {
        nextNodes = result.nodes
        setNodes(result.nodes, { persist: true, markDirty: true, immediate: true })
      }
    }
    setEdges(edgesFromNodeReferences(nextNodes, remainingEdges))
  }
  return (
    <>
      <path
        d={edgePath}
        className="canvas-edge-hit"
        fill="none"
        stroke="transparent"
        strokeWidth={interactionCanvasWidth}
        strokeLinecap="round"
        pointerEvents="stroke"
      />
      {isFlowActive && (
        <>
          <path
            d={edgePath}
            className="canvas-edge-flow-glow"
            fill="none"
            stroke="rgba(106,151,255,0.22)"
            strokeWidth={8}
            strokeLinecap="round"
          />
          {showFlowAnimation && (
            <path
              d={edgePath}
              fill="none"
              stroke="rgba(214,236,255,0.95)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeDasharray="8 14"
              className="canvas-edge-flow-dash"
            />
          )}
        </>
      )}
      <path
        d={edgePath}
        className={`canvas-edge-base${selected ? ' is-selected' : isFlowActive ? ' is-flow-active' : ''}`}
        fill="none"
        stroke={baseStroke}
        strokeWidth={baseStrokeWidth}
      />
      {showDeleteButton && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan"
          >
            <button
              onClick={deleteEdge}
              style={{
                width: 20, height: 20, borderRadius: '50%',
                background: '#1a1530', border: '1px solid #f87171',
                color: '#f87171', fontSize: 12, lineHeight: 1,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >×</button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const edgeTypes = { glow: GlowEdge, default: GlowEdge }

// ── Connection menu ───────────────────────────────────────────────────────────
const CONN_ITEMS = [
  { type: 'text',           icon: '≡',  label: '文本' },
  { type: 'image',          icon: '🖼', label: '图片',   desc: '海报、分镜、角色设计' },
  { type: 'video',          icon: '▶',  label: '视频' },
  { type: 'video_merge',    icon: '✂',  label: '视频合成', badge: 'Beta' },
  { type: 'director_stage', icon: '◈',  label: '三维空间', desc: '白模摆姿势出构图', badge: 'NEW' },
  { type: 'audio',          icon: '♪',  label: '音频' },
  { type: 'script',         icon: '⊞', label: '脚本',    badge: 'Beta' },
  { type: 'panorama_viewer', icon: '◉', label: '360°查看器', desc: '环视 HDR 全景' },
]

interface ConnMenuProps {
  screenX: number
  screenY: number
  onSelect: (type: string) => void
  onClose: () => void
}

function ConnectionMenu({ screenX, screenY, onSelect, onClose }: ConnMenuProps) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.conn-menu')) onClose()
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [onClose])

  return (
    <div
      className="conn-menu"
      style={{
        position: 'fixed', left: screenX + 14, top: screenY - 10,
        zIndex: 9999,
        background: '#16121f',
        border: '1px solid #2d2248',
        borderRadius: 12,
        padding: '4px 0 6px',
        minWidth: 210,
        boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
      }}
    >
      <div style={{ padding: '6px 14px 8px', fontSize: 11, color: '#6a6085', fontWeight: 600, letterSpacing: '0.03em' }}>
        引用该节点生成
      </div>
      {CONN_ITEMS.map(item => (
        <button
          key={item.type}
          onClick={() => onSelect(item.type)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            width: '100%', padding: '7px 14px',
            background: 'none', border: 'none', cursor: 'pointer',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
        >
          <span style={{ fontSize: 15, width: 22, textAlign: 'center', color: '#a090d0' }}>{item.icon}</span>
          <span style={{ fontSize: 13, color: '#d0c8f0' }}>{item.label}</span>
          {item.desc && <span style={{ fontSize: 11, color: '#5a5070', marginLeft: 2 }}>{item.desc}</span>}
          {item.badge && (
            <span style={{
              fontSize: 10, color: '#7c5cfc', border: '1px solid #4a3880',
              borderRadius: 3, padding: '1px 5px', marginLeft: 'auto',
            }}>{item.badge}</span>
          )}
        </button>
      ))}
    </div>
  )
}

const CANVAS_NODE_ITEMS = [
  { type: 'text', label: '文本', desc: '脚本、广告词、品牌文案', icon: '☰' },
  { type: 'image', label: '图片', desc: '海报、分镜、角色设计', icon: '▧' },
  { type: 'video', label: '视频', desc: '创意广告、动画、电影', icon: '▻' },
  { type: 'audio', label: '音频', desc: '音效、配音、音乐', icon: '≋' },
  { type: 'video_merge', label: '视频合成', desc: '多个视频片段合为一个', icon: '▥' },
  { type: 'script', label: '脚本', desc: '创意脚本、故事板', icon: '▤' },
  { type: 'panorama_viewer', label: '360°查看器', desc: '连接并环视 2:1 HDR 全景图', icon: '◉' },
  { type: 'image_compare', label: '图片对比', desc: '连两张图，全屏左右/滑杆/透明度对比', icon: '◫' },
  { type: 'video_compare', label: '视频对比', desc: '左右或四宫格对比视频，可导出对比片', icon: '▥' },
  { type: 'director_stage', label: '三维空间', desc: '摆机位调焦距 + 白模姿势，出图当构图参考', icon: '◈' },
]

type CanvasMenuMode = 'main' | 'node-picker'

interface CanvasMenuState {
  screenX: number
  screenY: number
  flowX: number
  flowY: number
  mode: CanvasMenuMode
}

interface CanvasContextMenuProps {
  menu: CanvasMenuState
  canUndo: boolean
  canPaste: boolean
  onUpload: () => void
  onOpenNodePicker: () => void
  onSelectNode: (type: string) => void
  onUndo: () => void
  onPaste: () => void
  onClose: () => void
}

interface NodeMenuState {
  screenX: number
  screenY: number
  flowX: number
  flowY: number
  nodeId: string
}

interface NodeContextMenuProps {
  menu: NodeMenuState
  node?: FlowNode
  canPaste: boolean
  onComplianceCheck: () => void
  onSaveAsset: () => void
  onPanoramaPreview: () => void
  onCreateSubject: () => void
  onCopyNode: () => void
  onCopyMedia: () => void
  onDuplicate: () => void
  onPaste: () => void
  onDelete: () => void
  onDeleteGroupWithChildren: () => void
  onCopyToClipboard: () => void
  onClose: () => void
}

function getMenuPosition(screenX: number, screenY: number, width: number, height: number) {
  const margin = 12
  const left = Math.max(margin, Math.min(screenX, window.innerWidth - width - margin))
  const top = Math.max(margin, Math.min(screenY, window.innerHeight - height - margin))
  return { left, top }
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

async function writeImageUrlToClipboard(url: string) {
  const ClipboardItemCtor = window.ClipboardItem
  if (!ClipboardItemCtor || !navigator.clipboard?.write) {
    await writeClipboardText(url)
    return
  }
  try {
    const response = await fetch(url)
    const blob = await response.blob()
    const type = blob.type || 'image/png'
    if (!type.startsWith('image/')) {
      await writeClipboardText(url)
      return
    }
    await navigator.clipboard.write([new ClipboardItemCtor({ [type]: blob })])
  } catch {
    await writeClipboardText(url)
  }
}

function isImageUrl(url: string) {
  return /\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i.test(url)
}

function isVideoUrl(url: string) {
  return /\.(mp4|mov|m4v|webm|avi|mkv)(?:[?#].*)?$/i.test(url)
}

function primaryMediaKindFromNodeData(data?: CanvasNodeData): 'image' | 'video' | null {
  if (!data) return null
  if (data.type === 'image' || data.type === 'director_stage') return 'image'
  if (data.type === 'video' || data.type === 'video_merge') return 'video'

  const primaryUrl = data.url?.[0] ?? ''
  const metaKind = data._resourceMeta?.items?.find(item => item?.kind === 'image' || item?.kind === 'video')?.kind
  if (data.type === 'upload') {
    if (metaKind === 'image' || metaKind === 'video') return metaKind
    if (isVideoUrl(primaryUrl)) return 'video'
    if (isImageUrl(primaryUrl)) return 'image'
  }
  return null
}

function NodeContextMenu({
  menu,
  node,
  canPaste,
  onComplianceCheck,
  onSaveAsset,
  onPanoramaPreview,
  onCreateSubject,
  onCopyNode,
  onCopyMedia,
  onDuplicate,
  onPaste,
  onDelete,
  onDeleteGroupWithChildren,
  onCopyToClipboard,
  onClose,
}: NodeContextMenuProps) {
  useEffect(() => {
    const closeOnPointerDown = (event: MouseEvent) => {
      if (!(event.target as Element).closest('.canvas-right-menu')) onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', closeOnPointerDown, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [onClose])

  const data = node?.data
  const mediaKind = primaryMediaKindFromNodeData(data)
  const isVideoLike = mediaKind === 'video'
  const mediaCopyLabel = isVideoLike ? '复制封面视频' : '复制封面图片'
  const canCopyMedia = Boolean(data?.url?.[0] && mediaKind)
  const isGroupNode = data?.type === 'group'
  const pos = getMenuPosition(menu.screenX, menu.screenY, 238, 420)

  return (
    <div
      className="canvas-right-menu canvas-node-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button className="canvas-context-item" disabled onClick={onComplianceCheck}>
        <span>Seedance2.0合规校验</span>
        <small>?</small>
      </button>
      <button className="canvas-context-item" disabled onClick={onSaveAsset}>保存到我的资产</button>
      <button className="canvas-context-item" disabled={!isPanoramaNodeData(data)} onClick={onPanoramaPreview}>
        <span>进入全景预览</span>
        <small>{isPanoramaNodeData(data) ? '360°' : '?'}</small>
      </button>
      <button className="canvas-context-item" disabled onClick={onCreateSubject}>创建主体</button>
      <div className="canvas-context-separator" />
      <button className="canvas-context-item is-strong" onClick={onCopyNode}>
        <span>复制节点</span>
        <kbd>⌘C</kbd>
      </button>
      <button className="canvas-context-item is-strong" disabled={!canCopyMedia} onClick={onCopyMedia}>
        {mediaCopyLabel}
      </button>
      <button className="canvas-context-item" onClick={onDuplicate}>
        <span>创建副本</span>
        <kbd>⌘D</kbd>
      </button>
      <button className="canvas-context-item" disabled={!canPaste} onClick={onPaste}>
        <span>粘贴</span>
        <kbd>⌘V</kbd>
      </button>
      <button className="canvas-context-item is-danger" onClick={onDelete}>
        <span>删除</span>
        <kbd>⌘⌫</kbd>
      </button>
      {isGroupNode && (
        <button className="canvas-context-item is-danger" onClick={onDeleteGroupWithChildren}>
          <span>删除整个组</span>
        </button>
      )}
      <div className="canvas-context-separator" />
      <button className="canvas-context-item is-strong" onClick={onCopyToClipboard}>
        复制到剪贴板
      </button>
    </div>
  )
}

function CanvasContextMenu({
  menu,
  canUndo,
  canPaste,
  onUpload,
  onOpenNodePicker,
  onSelectNode,
  onUndo,
  onPaste,
  onClose,
}: CanvasContextMenuProps) {
  // 右键菜单一出来节点列表就是展开的：这是这个菜单里唯一常用的一项，还要求先把鼠标
  // 挪到它上面才看得见，等于白多一步。移到别的菜单项上会收起，移回来再展开。
  const [nodeFlyoutOpen, setNodeFlyoutOpen] = useState(true)
  useEffect(() => {
    const closeOnPointerDown = (event: MouseEvent) => {
      const target = event.target as Element
      if (!target.closest('.canvas-right-menu') && !target.closest('.canvas-context-flyout')) onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', closeOnPointerDown, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [onClose])

  // 高度按菜单项数量算，不写死 —— 见 lib/nodePickerLayout.ts 顶部那段说明。
  const pickerHeight = nodePickerMaxHeight(CANVAS_NODE_ITEMS.length, window.innerHeight)

  if (menu.mode === 'node-picker') {
    const pos = getMenuPosition(menu.screenX, menu.screenY, 310, pickerHeight)
    return (
      <div
        className="canvas-right-menu canvas-node-picker"
        style={{ left: pos.left, top: pos.top, maxHeight: pickerHeight }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="canvas-node-picker-title">添加节点</div>
        <div className="canvas-node-picker-list">
          {CANVAS_NODE_ITEMS.map(item => (
            <button key={item.type} className="canvas-node-picker-item" onClick={() => onSelectNode(item.type)}>
              <span className="canvas-node-picker-icon">{item.icon}</span>
              <span className="canvas-node-picker-copy">
                <strong>{item.label}</strong>
                <small>{item.desc}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const pos = getMenuPosition(menu.screenX, menu.screenY, 220, 262)
  // 「添加节点」的节点列表在右侧展开（点击仍保留旧的整页切换作兜底）。
  // 用 position:fixed 铺到视口上，避开父菜单的磨砂裁剪；右边不够就翻到左边，贴底边就往上长。
  const flyoutStyle = nodePickerFlyoutFixedStyle(
    pos.left,
    pos.top,
    CANVAS_NODE_ITEMS.length,
    window.innerWidth,
    window.innerHeight,
  )
  const collapseFlyout = () => setNodeFlyoutOpen(false)
  return (
    <div
      className="canvas-right-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        className="canvas-context-item is-strong"
        onClick={onUpload}
        onMouseEnter={collapseFlyout}
      >
        上传
      </button>
      <div
        className={['canvas-context-submenu', nodeFlyoutOpen ? 'is-open' : ''].filter(Boolean).join(' ')}
        onMouseEnter={() => setNodeFlyoutOpen(true)}
      >
        <button className="canvas-context-item is-strong" onClick={onOpenNodePicker}>
          <span>添加节点</span>
          <span className="canvas-context-submenu-arrow" aria-hidden="true">›</span>
        </button>
        {nodeFlyoutOpen && (
          <div
            className="canvas-context-flyout"
            style={flyoutStyle}
            onMouseEnter={() => setNodeFlyoutOpen(true)}
          >
            <div className="canvas-node-picker-title">添加节点</div>
            <div className="canvas-node-picker-list">
              {CANVAS_NODE_ITEMS.map(item => (
                <button key={item.type} className="canvas-node-picker-item" onClick={() => onSelectNode(item.type)}>
                  <span className="canvas-node-picker-icon">{item.icon}</span>
                  <span className="canvas-node-picker-copy">
                    <strong>{item.label}</strong>
                    <small>{item.desc}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="canvas-context-separator" onMouseEnter={collapseFlyout} />
      <button
        className="canvas-context-item"
        disabled={!canUndo}
        onClick={onUndo}
        onMouseEnter={collapseFlyout}
      >
        <span>撤销</span>
        <kbd>⌘Z</kbd>
      </button>
      <button className="canvas-context-item" disabled onMouseEnter={collapseFlyout}>
        <span>重做</span>
        <kbd>⇧⌘Z</kbd>
      </button>
      <div className="canvas-context-separator" onMouseEnter={collapseFlyout} />
      <button
        className="canvas-context-item"
        disabled={!canPaste}
        onClick={onPaste}
        onMouseEnter={collapseFlyout}
      >
        <span>粘贴</span>
        <kbd>⌘V</kbd>
      </button>
    </div>
  )
}

type FlowNode = Node & { data: CanvasNodeData & { nodeKey: string; projectUuid: string } }

function getMiniMapNodeKind(node: Node) {
  const data = node.data as Partial<CanvasNodeData> | undefined
  return String(data?.type ?? node.type ?? '')
}

function miniMapNodeColor(node: Node) {
  const kind = getMiniMapNodeKind(node)
  if (kind === 'image') return 'rgba(196, 196, 196, 0.86)'
  if (kind === 'panorama_viewer') return 'rgba(108, 164, 230, 0.86)'
  if (kind === 'video') return 'rgba(148, 176, 207, 0.84)'
  if (kind === 'text') return 'rgba(176, 166, 205, 0.78)'
  if (kind === 'group') return 'rgba(88, 88, 88, 0.64)'
  return 'rgba(136, 136, 142, 0.76)'
}

function miniMapNodeStrokeColor(node: Node) {
  return node.selected ? 'rgba(255, 250, 218, 0.95)' : 'rgba(255, 255, 255, 0.2)'
}

const CANVAS_MINIMAP_WIDTH = 154
const CANVAS_MINIMAP_HEIGHT = 96
const CANVAS_MINIMAP_PADDING_X = 10
const CANVAS_MINIMAP_PADDING_Y = 11
const CANVAS_MINIMAP_WORLD_PADDING_RATIO = 0.18
const CANVAS_DETAIL_RENDER_ZOOM_THRESHOLD = 0.12
const CANVAS_ZOOM_MIN_PERCENT = 5
const CANVAS_ZOOM_MAX_PERCENT = 400

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function canvasZoomToRulerValue(zoom: number) {
  const minZoom = CANVAS_ZOOM_MIN_PERCENT / 100
  const maxZoom = CANVAS_ZOOM_MAX_PERCENT / 100
  const safeZoom = clampValue(zoom, minZoom, maxZoom)
  const minLog = Math.log(minZoom)
  const maxLog = Math.log(maxZoom)
  return ((Math.log(safeZoom) - minLog) / (maxLog - minLog)) * 100
}

function canvasRulerValueToZoom(value: number) {
  const minZoom = CANVAS_ZOOM_MIN_PERCENT / 100
  const maxZoom = CANVAS_ZOOM_MAX_PERCENT / 100
  const safeValue = clampValue(value, 0, 100) / 100
  const minLog = Math.log(minZoom)
  const maxLog = Math.log(maxZoom)
  return Math.exp(minLog + (maxLog - minLog) * safeValue)
}

function CanvasDetailZoomControl({
  zoomPercent,
  detailActive,
  thresholdPercent,
  onZoomPercentChange,
  onZoomOut,
  onZoomIn,
  onFitView,
  onOpenTemplateLibrary,
}: {
  zoomPercent: number
  detailActive: boolean
  thresholdPercent: number
  onZoomPercentChange: (percent: number) => void
  onZoomOut: () => void
  onZoomIn: () => void
  onFitView: () => void
  onOpenTemplateLibrary: () => void
}) {
  const clampedZoomPercent = clampValue(zoomPercent, CANVAS_ZOOM_MIN_PERCENT, CANVAS_ZOOM_MAX_PERCENT)
  const rulerValue = canvasZoomToRulerValue(clampedZoomPercent / 100)
  const thresholdRulerValue = canvasZoomToRulerValue(thresholdPercent / 100)

  return (
    <div
      className="canvas-detail-zoom-control nodrag nopan"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div className="canvas-detail-zoom-row">
        <button type="button" className="canvas-detail-zoom-button is-minus" title="缩小" aria-label="缩小" onClick={onZoomOut}>−</button>
        <div className="canvas-detail-zoom-ruler" aria-hidden="true">
          {Array.from({ length: 9 }).map((_, index) => (
            <span key={index} className={index === 4 ? 'is-major' : undefined} />
          ))}
          <i className="canvas-detail-zoom-threshold" style={{ left: `${thresholdRulerValue}%` }} />
        </div>
        <input
          className="canvas-detail-zoom-range"
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={rulerValue}
          aria-label="画布缩放"
          onChange={(event) => onZoomPercentChange(canvasRulerValueToZoom(Number(event.currentTarget.value)) * 100)}
        />
        <span className="canvas-detail-zoom-percent">{clampedZoomPercent}%</span>
        <button type="button" className="canvas-detail-zoom-button is-plus" title="放大" aria-label="放大" onClick={onZoomIn}>+</button>
        <button type="button" className="canvas-detail-zoom-button is-fit" title="适应画布" aria-label="适应画布" onClick={onFitView}>⌗</button>
        <button
          type="button"
          className="canvas-detail-template-button"
          title="官方模板库"
          aria-label="打开官方模板库"
          onClick={onOpenTemplateLibrary}
        >
          <LayoutGrid size={15} strokeWidth={1.7} />
          <span>模板库</span>
        </button>
      </div>
      <div
        className={`canvas-detail-render-pill${detailActive ? '' : ' is-muted'}`}
        title={`低于 ${thresholdPercent}% 时隐藏图片和视频细节`}
      >
        细节渲染
      </div>
    </div>
  )
}

function miniMapNodeSize(node: FlowNode) {
  const width = Number(node.data?.contentWidth ?? node.width ?? node.measured?.width ?? 240)
  const height = Number(node.data?.contentHeight ?? node.height ?? node.measured?.height ?? 160)
  return {
    width: Number.isFinite(width) && width > 0 ? width : 240,
    height: Number.isFinite(height) && height > 0 ? height : 160,
  }
}

function expandBoundsForMiniMap(bounds: { x: number; y: number; width: number; height: number }, aspect: number) {
  const maxSide = Math.max(bounds.width, bounds.height)
  const padding = Math.max(80, maxSide * CANVAS_MINIMAP_WORLD_PADDING_RATIO)
  let x = bounds.x - padding
  let y = bounds.y - padding
  let width = Math.max(1, bounds.width + padding * 2)
  let height = Math.max(1, bounds.height + padding * 2)
  const currentAspect = width / height

  if (currentAspect > aspect) {
    const nextHeight = width / aspect
    y -= (nextHeight - height) / 2
    height = nextHeight
  } else {
    const nextWidth = height * aspect
    x -= (nextWidth - width) / 2
    width = nextWidth
  }

  return { x, y, width, height }
}

function CanvasMiniMap({
  nodes,
  viewport,
  canvasRef,
  reactFlowRef,
  setViewport,
}: {
  nodes: FlowNode[]
  viewport: Viewport
  canvasRef: RefObject<HTMLDivElement | null>
  reactFlowRef: RefObject<ReactFlowInstance<Node, Edge> | null>
  setViewport: (viewport: Viewport) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    const element = canvasRef.current
    if (!element) return

    const syncSize = () => {
      const rect = element.getBoundingClientRect()
      setCanvasSize({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      })
    }

    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [canvasRef])

  const miniMapData = useMemo(() => {
    const nodeBounds = getNodeBounds(nodes)
    if (!nodeBounds) return null

    const innerX = CANVAS_MINIMAP_PADDING_X
    const innerY = CANVAS_MINIMAP_PADDING_Y
    const innerWidth = CANVAS_MINIMAP_WIDTH - CANVAS_MINIMAP_PADDING_X * 2
    const innerHeight = CANVAS_MINIMAP_HEIGHT - CANVAS_MINIMAP_PADDING_Y * 2
    const worldBounds = expandBoundsForMiniMap(nodeBounds, innerWidth / innerHeight)
    const scale = innerWidth / worldBounds.width
    const toMiniMapX = (x: number) => innerX + (x - worldBounds.x) * scale
    const toMiniMapY = (y: number) => innerY + (y - worldBounds.y) * scale

    const nodeRects = nodes.map((node) => {
      const size = miniMapNodeSize(node)
      return {
        id: node.id,
        x: toMiniMapX(node.position.x),
        y: toMiniMapY(node.position.y),
        width: Math.max(2, size.width * scale),
        height: Math.max(2, size.height * scale),
        fill: node.selected ? 'rgba(147, 197, 253, 0.9)' : miniMapNodeColor(node),
        stroke: miniMapNodeStrokeColor(node),
      }
    })

    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
    const viewLeft = -viewport.x / zoom
    const viewTop = -viewport.y / zoom
    const viewRight = viewLeft + Math.max(1, canvasSize.width) / zoom
    const viewBottom = viewTop + Math.max(1, canvasSize.height) / zoom
    const rawViewportRect = {
      x: toMiniMapX(viewLeft),
      y: toMiniMapY(viewTop),
      width: (viewRight - viewLeft) * scale,
      height: (viewBottom - viewTop) * scale,
    }
    const viewportLeft = clampValue(rawViewportRect.x, innerX, innerX + innerWidth)
    const viewportTop = clampValue(rawViewportRect.y, innerY, innerY + innerHeight)
    const viewportRight = clampValue(rawViewportRect.x + rawViewportRect.width, innerX, innerX + innerWidth)
    const viewportBottom = clampValue(rawViewportRect.y + rawViewportRect.height, innerY, innerY + innerHeight)
    const viewportRect = {
      x: viewportLeft,
      y: viewportTop,
      width: Math.max(2, viewportRight - viewportLeft),
      height: Math.max(2, viewportBottom - viewportTop),
    }

    return {
      innerX,
      innerY,
      innerWidth,
      innerHeight,
      worldBounds,
      scale,
      nodeRects,
      viewportRect,
    }
  }, [canvasSize.height, canvasSize.width, nodes, viewport.x, viewport.y, viewport.zoom])

  const moveViewportToPointer = useCallback((event: ReactPointerEvent<HTMLElement | SVGSVGElement>) => {
    if (!miniMapData || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const svgX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * CANVAS_MINIMAP_WIDTH
    const svgY = ((event.clientY - rect.top) / Math.max(1, rect.height)) * CANVAS_MINIMAP_HEIGHT
    const x = clampValue(svgX, miniMapData.innerX, miniMapData.innerX + miniMapData.innerWidth)
    const y = clampValue(svgY, miniMapData.innerY, miniMapData.innerY + miniMapData.innerHeight)
    const flowX = miniMapData.worldBounds.x + (x - miniMapData.innerX) / miniMapData.scale
    const flowY = miniMapData.worldBounds.y + (y - miniMapData.innerY) / miniMapData.scale
    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
    const nextViewport = {
      zoom,
      x: canvasSize.width / 2 - flowX * zoom,
      y: canvasSize.height / 2 - flowY * zoom,
    }
    reactFlowRef.current?.setViewport(nextViewport, { duration: 0 })
    setViewport(nextViewport)
  }, [canvasSize.height, canvasSize.width, miniMapData, reactFlowRef, setViewport, viewport.zoom])

  if (!miniMapData) return null

  return (
    <div
      className="shotflow-canvas-minimap"
      aria-label="画布小地图"
      role="slider"
      aria-valuetext="拖动画布小地图视口"
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setIsDragging(true)
        event.currentTarget.setPointerCapture(event.pointerId)
        moveViewportToPointer(event)
      }}
      onPointerMove={(event) => {
        if (!isDragging) return
        event.preventDefault()
        event.stopPropagation()
        moveViewportToPointer(event)
      }}
      onPointerUp={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setIsDragging(false)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={(event) => {
        event.stopPropagation()
        setIsDragging(false)
      }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CANVAS_MINIMAP_WIDTH} ${CANVAS_MINIMAP_HEIGHT}`}
        aria-hidden="true"
      >
        <g>
          {miniMapData.nodeRects.map((node) => (
            <rect
              key={node.id}
              className="shotflow-minimap-node"
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={1.4}
              fill={node.fill}
              stroke={node.stroke}
            />
          ))}
        </g>
        <rect
          className="shotflow-minimap-viewport"
          x={miniMapData.viewportRect.x}
          y={miniMapData.viewportRect.y}
          width={miniMapData.viewportRect.width}
          height={miniMapData.viewportRect.height}
        />
      </svg>
    </div>
  )
}

const CINDY_PROPOSAL_NODE_TYPES = new Set(['text', 'image', 'video', 'audio', 'video_merge'])

function cindyProposalNodeData(node: CindyProposal['nodes'][number], messageId: string): Partial<CanvasNodeData> {
  const prompt = String(node.prompt || '').trim()
  const common: Partial<CanvasNodeData> = {
    name: String(node.name || '').trim(),
    _cindyProposalMessageId: messageId,
    _cindyProposalNodeId: node.id,
  }
  if (node.type === 'text') {
    const content = String(node.content || prompt).trim()
    return {
      ...common,
      params: { ...defaultTextParams(), content, prompt: prompt || content } as unknown as Record<string, unknown>,
    }
  }
  const s = node.settings ?? {}
  if (node.type === 'image') {
    const base = defaultImageParams()
    return {
      ...common,
      params: {
        ...base,
        prompt,
        count: s.count != null ? normalizeImageGenerationCount(base.model, s.count) : base.count,
        settings: {
          ...base.settings,
          ...(s.ratio != null ? { ratio: normalizeImageRatioValue(base.model, s.ratio) } : {}),
          ...(s.resolution != null ? { resolution: normalizeImageResolutionValue(base.model, s.resolution) } : {}),
        },
      } as unknown as Record<string, unknown>,
    }
  }
  if (node.type === 'video') {
    const base = defaultVideoParams()
    return {
      ...common,
      params: {
        ...base,
        prompt,
        count: s.count != null ? normalizeVideoGenerationCount(base.model, s.count, false) : base.count,
        settings: {
          ...base.settings,
          ...(s.ratio != null ? { ratio: normalizeVideoRatioValue(base.model, s.ratio) } : {}),
          ...(s.resolution != null ? { resolution: normalizeVideoResolutionValue(base.model, s.resolution) } : {}),
          ...(s.duration != null ? { duration: normalizeVideoDurationValue(base.model, s.duration) } : {}),
        },
      } as unknown as Record<string, unknown>,
    }
  }
  if (node.type === 'video_merge') {
    // A merge node derives its timeline from the video nodes wired into it and
    // carries no prompt/settings — keep makeNodeData's default video_merge params
    // so its videoList/mergeClips start empty and fill in from the connections.
    return { ...common }
  }
  return { ...common, params: { ...defaultAudioParams(), prompt } as unknown as Record<string, unknown> }
}

type ShotflowNodeClipboardPayload = {
  kind: typeof SHOTFLOW_NODE_CLIPBOARD_KIND
  version: 1
  nodes: FlowNode[]
  edges: Edge[]
}

function encodeShotflowNodeClipboard(clipboard: { nodes: FlowNode[]; edges: Edge[] } | null) {
  if (!clipboard?.nodes.length) return ''
  const payload: ShotflowNodeClipboardPayload = {
    kind: SHOTFLOW_NODE_CLIPBOARD_KIND,
    version: 1,
    nodes: clipboard.nodes,
    edges: clipboard.edges,
  }
  return JSON.stringify(payload)
}

function decodeShotflowNodeClipboard(raw: string) {
  if (!raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ShotflowNodeClipboardPayload>
    if (parsed.kind !== SHOTFLOW_NODE_CLIPBOARD_KIND) return null
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return null
    return {
      nodes: parsed.nodes as FlowNode[],
      edges: Array.isArray(parsed.edges) ? parsed.edges as Edge[] : [],
    }
  } catch {
    return null
  }
}

function flowNodeWidth(node: FlowNode) {
  return Math.max(1, Number(node.data.contentWidth ?? node.width ?? node.measured?.width ?? 240))
}

function flowNodeHeight(node: FlowNode) {
  return Math.max(1, Number(node.data.contentHeight ?? node.height ?? node.measured?.height ?? 160))
}

function collectGroupingTargets(nodes: FlowNode[], nodeIds: string[]) {
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const targetIds = new Set<string>()

  const collectNode = (nodeId: string) => {
    const node = nodeMap.get(nodeId)
    if (!node) return
    if (node.type === 'group') {
      const params = (node.data.params ?? {}) as { childIds?: string[] }
      ;(params.childIds ?? []).forEach(collectNode)
      return
    }
    targetIds.add(node.id)
  }

  nodeIds.forEach(collectNode)
  return Array.from(targetIds)
    .map(id => nodeMap.get(id))
    .filter((node): node is FlowNode => Boolean(node))
}

function getSelectionFrameBounds(nodes: FlowNode[], zoomValue: unknown) {
  const bounds = getNodeBounds(nodes)
  if (!bounds) return null
  const zoom = Number.isFinite(Number(zoomValue)) && Number(zoomValue) > 0 ? Number(zoomValue) : 1
  const padding = GROUP_BOUNDS_PADDING_SCREEN / zoom
  const titlePadding = NODE_TITLE_SCREEN_HEIGHT / zoom
  const x = bounds.x - padding
  const y = bounds.y - titlePadding - padding
  return {
    x,
    y,
    width: bounds.width + padding * 2,
    height: bounds.height + titlePadding + padding * 2,
  }
}

function fitGroupsToChangedChildren(
  nodes: FlowNode[],
  changedChildIds: Set<string>,
  skippedGroupIds: Set<string>,
  zoomValue: unknown
) {
  if (changedChildIds.size === 0) return nodes

  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  let didChange = false
  const nextNodes = nodes.map(node => {
    if (node.type !== 'group' || skippedGroupIds.has(node.id)) return node

    const params = (node.data.params ?? {}) as { childIds?: string[] }
    const childIds = params.childIds ?? []
    if (!childIds.some(childId => changedChildIds.has(childId))) return node

    const childNodes = childIds
      .map(childId => nodeMap.get(childId))
      .filter((child): child is FlowNode => Boolean(child) && child.type !== 'group')
    const bounds = getSelectionFrameBounds(childNodes, zoomValue)
    if (!bounds) return node

    const currentWidth = flowNodeWidth(node)
    const currentHeight = flowNodeHeight(node)
    const changed =
      Math.abs(node.position.x - bounds.x) > 0.001 ||
      Math.abs(node.position.y - bounds.y) > 0.001 ||
      Math.abs(currentWidth - bounds.width) > 0.001 ||
      Math.abs(currentHeight - bounds.height) > 0.001

    if (!changed) return node
    didChange = true
    return {
      ...node,
      position: { x: bounds.x, y: bounds.y },
      data: {
        ...node.data,
        contentWidth: bounds.width,
        contentHeight: bounds.height,
      },
      selected: false,
      selectable: false,
      style: {
        ...(node.style ?? {}),
        width: bounds.width,
        height: bounds.height,
        pointerEvents: 'auto' as const,
      },
    }
  })

  return didChange ? nextNodes : nodes
}

function findGroupAtPoint(nodes: FlowNode[], x: number, y: number) {
  return nodes
    .filter(node => {
      if (node.type !== 'group') return false
      const width = flowNodeWidth(node)
      const height = flowNodeHeight(node)
      return x >= node.position.x &&
        x <= node.position.x + width &&
        y >= node.position.y &&
        y <= node.position.y + height
    })
    .sort((a, b) => flowNodeWidth(a) * flowNodeHeight(a) - flowNodeWidth(b) * flowNodeHeight(b))[0] ?? null
}

function rectsIntersect(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
}

function expandScreenRect(
  rect: { left: number; top: number; right: number; bottom: number },
  padding: number
) {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding,
  }
}

function screenPointInRect(
  point: { x: number; y: number },
  rect: { left: number; top: number; right: number; bottom: number }
) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}

function ccw(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x)
}

function screenSegmentsIntersect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d)
}

function screenSegmentIntersectsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: { left: number; top: number; right: number; bottom: number }
) {
  if (screenPointInRect(a, rect) || screenPointInRect(b, rect)) return true
  const topLeft = { x: rect.left, y: rect.top }
  const topRight = { x: rect.right, y: rect.top }
  const bottomRight = { x: rect.right, y: rect.bottom }
  const bottomLeft = { x: rect.left, y: rect.bottom }
  return (
    screenSegmentsIntersect(a, b, topLeft, topRight) ||
    screenSegmentsIntersect(a, b, topRight, bottomRight) ||
    screenSegmentsIntersect(a, b, bottomRight, bottomLeft) ||
    screenSegmentsIntersect(a, b, bottomLeft, topLeft)
  )
}

function cubicBezierPoint(
  t: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number }
) {
  const u = 1 - t
  const tt = t * t
  const uu = u * u
  const uuu = uu * u
  const ttt = tt * t
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  }
}

function flowPointToScreen(
  point: { x: number; y: number },
  viewport: Viewport,
  canvasRect: DOMRect
) {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
  return {
    x: canvasRect.left + point.x * zoom + viewport.x,
    y: canvasRect.top + point.y * zoom + viewport.y,
  }
}

function edgeScreenPoints(edge: Edge, nodeMap: Map<string, FlowNode>, viewport: Viewport, canvasRect: DOMRect) {
  const source = nodeMap.get(edge.source)
  const target = nodeMap.get(edge.target)
  if (!source || !target) return null

  const sourcePoint = {
    x: source.position.x + flowNodeWidth(source),
    y: source.position.y + flowNodeHeight(source) / 2,
  }
  const targetPoint = {
    x: target.position.x,
    y: target.position.y + flowNodeHeight(target) / 2,
  }
  return {
    source: flowPointToScreen(sourcePoint, viewport, canvasRect),
    target: flowPointToScreen(targetPoint, viewport, canvasRect),
  }
}

function edgeIntersectsSelectionRect(
  edge: Edge,
  nodeMap: Map<string, FlowNode>,
  viewport: Viewport,
  canvasRect: DOMRect,
  selectionRect: { left: number; top: number; right: number; bottom: number }
) {
  const points = edgeScreenPoints(edge, nodeMap, viewport, canvasRect)
  if (!points) return false

  const rect = expandScreenRect(selectionRect, 8)
  const dx = Math.abs(points.target.x - points.source.x)
  const controlOffset = Math.max(48, Math.min(180, dx * 0.5))
  const c1 = { x: points.source.x + controlOffset, y: points.source.y }
  const c2 = { x: points.target.x - controlOffset, y: points.target.y }
  let prev = points.source
  for (let i = 1; i <= 48; i += 1) {
    const next = cubicBezierPoint(i / 48, points.source, c1, c2, points.target)
    if (screenSegmentIntersectsRect(prev, next, rect)) return true
    prev = next
  }
  return false
}

function edgeIdsIntersectingSelectionRect(
  edges: Edge[],
  nodes: FlowNode[],
  viewport: Viewport,
  canvasRect: DOMRect,
  selectionRect: { left: number; top: number; right: number; bottom: number }
) {
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  return edges
    .filter(edge => edgeIntersectsSelectionRect(edge, nodeMap, viewport, canvasRect, selectionRect))
    .map(edge => edge.id)
}

function nodeIdFromFlowHandle(handle: Element | null) {
  if (!handle) return null
  const html = handle as HTMLElement
  const directNodeId = html.dataset.nodeid || html.getAttribute('data-nodeid')
  if (directNodeId) return directNodeId
  const nodeEl = html.closest('.react-flow__node') as HTMLElement | null
  return nodeEl?.dataset.id || nodeEl?.getAttribute('data-id') || null
}

function findTargetHandleNodeIdAt(clientX: number, clientY: number, radius = 54) {
  const directHandle = document
    .elementsFromPoint(clientX, clientY)
    .map(element => element.closest?.('.react-flow__handle.target'))
    .find(Boolean)
  const directNodeId = nodeIdFromFlowHandle(directHandle ?? null)
  if (directNodeId) return directNodeId

  let best: { nodeId: string; distance: number } | null = null
  document.querySelectorAll('.react-flow__handle.target').forEach(handle => {
    const nodeId = nodeIdFromFlowHandle(handle)
    if (!nodeId) return
    const rect = handle.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const distance = Math.hypot(clientX - cx, clientY - cy)
    if (distance <= radius && (!best || distance < best.distance)) {
      best = { nodeId, distance }
    }
  })
  return best?.nodeId ?? null
}

function nodeTitleScreenRect(
  node: FlowNode,
  viewport: Viewport,
  canvasRect: DOMRect
) {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
  const left = canvasRect.left + node.position.x * zoom + viewport.x
  const top = canvasRect.top + node.position.y * zoom + viewport.y - NODE_TITLE_SCREEN_HEIGHT
  const width = flowNodeWidth(node) * zoom
  return {
    left,
    top,
    right: left + Math.max(80, width),
    bottom: top + NODE_TITLE_SCREEN_HEIGHT,
  }
}

function stripFileExtension(fileName: string) {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot <= 0) return fileName
  return fileName.slice(0, lastDot)
}

function isVideoFile(file: File) {
  return file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name)
}

function isAudioFile(file: File) {
  return file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)
}

function isImageFile(file: File) {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name)
}

function isMarkdownFile(file: File) {
  return file.type === 'text/markdown' || /\.(md|markdown|mdown)$/i.test(file.name)
}

function localFileKind(file: File): 'image' | 'video' | 'audio' | 'markdown' | null {
  if (isImageFile(file)) return 'image'
  if (isVideoFile(file)) return 'video'
  if (isAudioFile(file)) return 'audio'
  if (isMarkdownFile(file)) return 'markdown'
  return null
}

function isSupportedLocalFile(file: File) {
  return Boolean(localFileKind(file))
}

function uploadErrorToText(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  const maybeResponse = error as { response?: { data?: { error?: unknown; message?: unknown } } }
  const responseMessage = maybeResponse?.response?.data?.error ?? maybeResponse?.response?.data?.message
  if (typeof responseMessage === 'string' && responseMessage.trim()) return responseMessage
  return '上传失败'
}

function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') return true
  return element.isContentEditable || Boolean(element.closest('[contenteditable="true"]'))
}

function hasTextSelection() {
  const selection = window.getSelection()
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim())
}

function clipboardFileExtension(mimeType: string) {
  const normalized = String(mimeType || '').toLowerCase()
  if (normalized === 'image/jpeg') return 'jpg'
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/webp') return 'webp'
  if (normalized === 'image/gif') return 'gif'
  if (normalized === 'video/mp4') return 'mp4'
  if (normalized === 'video/quicktime') return 'mov'
  if (normalized === 'video/webm') return 'webm'
  if (normalized === 'audio/mpeg') return 'mp3'
  if (normalized === 'audio/wav') return 'wav'
  if (normalized === 'audio/ogg') return 'ogg'
  if (normalized === 'text/markdown') return 'md'
  return normalized.split('/')[1]?.split(';')[0] || 'bin'
}

function normalizeClipboardFile(file: File, index = 0) {
  const trimmedName = file.name?.trim()
  if (trimmedName) return file
  const ext = clipboardFileExtension(file.type)
  if (file.type === 'text/markdown') {
    return new File([file], `pasted-markdown${index > 0 ? `-${index + 1}` : ''}.${ext}`, {
      type: file.type || 'text/markdown',
      lastModified: file.lastModified || Date.now(),
    })
  }
  const baseName = file.type.startsWith('video/')
    ? '粘贴视频'
    : file.type.startsWith('audio/')
      ? '粘贴音频'
      : '粘贴图片'
  return new File([file], `${baseName}${index > 0 ? `-${index + 1}` : ''}.${ext}`, {
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now(),
  })
}

export function Canvas() {
  const { nodes, edges, viewport, canvasTextScale, setNodes, setEdges, setViewport, setCanvasTextScale, setSelected, setActivePanelNode, setConnectionHoverTarget, updateNodeData, addNodeAt, selectedNodeKeys, deleteNodes, deleteGroupWithChildren, ungroupNodes, copySelected, pasteClipboard, undo, pushHistory, clipboard, historyIndex, duplicateNodes, insertFavoritePayload } = useCanvasStore()
  const projectUuid = useCanvasStore(state => state.projectUuid)
  const projectName = useCanvasStore(state => state.projectName)
  const restoreProjectTasks = useTasksStore(state => state.restoreProjectTasks)
  // 分组节点排到子节点后面就会整片盖住它们（组里的节点点不中）。详见 groupRenderOrder.ts。
  const renderNodes = useMemo(() => hoistGroupNodesForRender(nodes), [nodes])
  const canvasRef = useRef<HTMLDivElement>(null)
  const reactFlowInstanceRef = useRef<ReactFlowInstance<Node, Edge> | null>(null)
  const autoFitCheckedProjectRef = useRef<string | null>(null)
  const restoredTaskProjectRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingUploadPositionRef = useRef<{ x: number; y: number } | null>(null)
  const canvasPointerPositionRef = useRef<{
    clientX: number
    clientY: number
    flowX: number
    flowY: number
  } | null>(null)
  const selectionPointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const selectionPointerCurrentRef = useRef<{ x: number; y: number } | null>(null)
  const selectionDragActiveRef = useRef(false)
  const recentNodeClipboardAtRef = useRef(0)
  const focusCycleRef = useRef({ selectionKey: '', nextStep: 0 })
  // O(1) node lookup map — avoids Array.find on every drag frame
  const nodeMapRef = useRef<Map<string, FlowNode>>(new Map())
  const dragHistoryPushedRef = useRef(false)
  const [connMenu, setConnMenu] = useState<{ screenX: number; screenY: number; sourceId: string } | null>(null)
  const [multiConnMenu, setMultiConnMenu] = useState<{ screenX: number; screenY: number; sourceIds: string[] } | null>(null)
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenuState | null>(null)
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null)
  const [panoramaPreview, setPanoramaPreview] = useState<{ url: string; name: string } | null>(null)
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false)
  // 资产库 / 共享空间已经搬到左侧停靠栏，不再走 dockPanel（那是底部浮层用的）。
  const [dockPanel, setDockPanel] = useState<'history' | 'shortcuts' | null>(null)
  const [assetDockMode, setAssetDockMode] = useState<AssetDockMode | null>(() => readAssetDockMode())
  // 收起后再点箭头要回到上次看的那个库
  const [lastAssetDockMode, setLastAssetDockMode] = useState<AssetDockMode>(() => readAssetDockMode() ?? 'assets')
  const changeAssetDockMode = useCallback((next: AssetDockMode | null) => {
    setAssetDockMode(next)
    writeAssetDockMode(next)
    if (next) setLastAssetDockMode(next)
  }, [])
  const [assetCreatedAtByUrl, setAssetCreatedAtByUrl] = useState<AssetCreatedAtMap>({})
  const [permanentHistoryAssets, setPermanentHistoryAssets] = useState<HistoryAsset[]>([])
  const [isMobileCanvas, setIsMobileCanvas] = useState(mobileCanvasQueryMatches)
  const [multiConnectDrag, setMultiConnectDrag] = useState<{
    startX: number
    startY: number
    currentX: number
    currentY: number
  } | null>(null)
  const [isHandleConnecting, setIsHandleConnecting] = useState(false)
  const isMultiConnectDragging = Boolean(multiConnectDrag)
  const canvasTextScalePercent = Math.round(canvasTextScale * 100)
  const canvasZoom = Math.max(0.05, Number(viewport.zoom) || 1)
  const canvasZoomPercent = Math.round(canvasZoom * 100)
  const isLowDetailRender = canvasZoom < CANVAS_DETAIL_RENDER_ZOOM_THRESHOLD
  const canvasRootStyle = useMemo(() => ({
    position: 'relative',
    '--canvas-text-scale': canvasTextScale,
    '--canvas-detail-threshold-percent': `${Math.round(CANVAS_DETAIL_RENDER_ZOOM_THRESHOLD * 100)}%`,
  }) as CSSProperties, [canvasTextScale])
  const historyAssets = useMemo(() => {
    const merged = new Map<string, HistoryAsset>()
    for (const asset of permanentHistoryAssets) merged.set(`${asset.kind}:${asset.url}`, asset)
    for (const asset of collectHistoryAssets(nodes, assetCreatedAtByUrl)) {
      const key = `${asset.kind}:${asset.url}`
      const permanent = merged.get(key)
      merged.set(key, permanent ? { ...asset, ...permanent, meta: { ...asset.meta, ...permanent.meta } } : asset)
    }
    return [...merged.values()].sort((a, b) => b.timestamp - a.timestamp)
  }, [assetCreatedAtByUrl, nodes, permanentHistoryAssets])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia(MOBILE_CANVAS_QUERY)
    const sync = () => setIsMobileCanvas(mediaQuery.matches)
    sync()
    mediaQuery.addEventListener('change', sync)
    return () => mediaQuery.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!projectUuid) {
      restoredTaskProjectRef.current = null
      return
    }
    if (restoredTaskProjectRef.current === projectUuid) return
    restoredTaskProjectRef.current = projectUuid
    void restoreProjectTasks(projectUuid)
  }, [projectUuid, restoreProjectTasks])

  useEffect(() => {
    if (!projectUuid) {
      setPermanentHistoryAssets([])
      return
    }
    let cancelled = false
    void historyAssetsApi.list(projectUuid).then((items) => {
      if (cancelled) return
      setPermanentHistoryAssets(items.map((item) => ({
        id: item.id,
        url: item.url,
        displayUrl: item.displayUrl,
        kind: item.kind,
        name: item.name,
        timestamp: Number(item.timestamp || 0),
        meta: item.meta as HistoryAsset['meta'],
      })))
    }).catch((error) => {
      console.error('load permanent history failed', error)
      if (!cancelled) setPermanentHistoryAssets([])
    })
    return () => { cancelled = true }
  }, [projectUuid])

  useEffect(() => {
    if (!projectUuid) {
      setAssetCreatedAtByUrl({})
      return
    }

    let cancelled = false
    assetsApi.listProject(projectUuid)
      .then((items) => {
        if (cancelled) return
        const next: AssetCreatedAtMap = {}
        for (const item of items) {
          const createdAtMs = normalizeAssetTimestamp(item.createdAtMs)
          if (createdAtMs && item.url) next[item.url] = createdAtMs
        }
        setAssetCreatedAtByUrl(next)
      })
      .catch((error) => {
        console.error('load asset creation times failed', error)
        if (!cancelled) setAssetCreatedAtByUrl({})
      })

    return () => {
      cancelled = true
    }
  }, [projectUuid])
  const [isFlowReady, setIsFlowReady] = useState(false)
  const connStartRef = useRef<{ nodeId: string; handleType: string } | null>(null)
  const didConnectRef = useRef(false)

  // ── Connection logic (shared between onConnect and menu select) ────────────
  const applyConnection = useCallback((source: string, target: string, options?: { recordHistory?: boolean }) => {
    const { nodes: ns, edges: es } = useCanvasStore.getState()
    const sourceNode = ns.find(n => n.id === source || n.data.nodeKey === source)
    const targetNode = ns.find(n => n.id === target || n.data.nodeKey === target)
    if (!sourceNode || !targetNode) return false

    const sourceData = sourceNode.data as CanvasNodeData
    const targetData = targetNode.data as CanvasNodeData
    if (sourceData.type === 'panorama_viewer') {
      const targetParams = (targetData.params ?? {}) as Record<string, unknown>
      const captureUrl = primaryOutputUrl(sourceData)
      const ref: NodeRef = { nodeId: sourceNode.id, url: captureUrl, mediaType: 'image' }
      const existing = Array.isArray(targetParams.imageList) ? targetParams.imageList as NodeRef[] : []
      if (!existing.some(item => item.nodeId === sourceNode.id)) {
        updateNodeData(targetNode.id, {
          params: {
            ...targetParams,
            imageList: [...existing, ref],
            imageListOrder: [...((targetParams.imageListOrder as string[]) ?? []), sourceNode.id],
            ...(targetData.type !== 'video' ? { modeType: 'image2image' } : {}),
          },
        })
      }
      const edgeId = `e-${sourceNode.id}-${targetNode.id}`
      if (!es.some(edge => edge.id === edgeId || (edge.source === sourceNode.id && edge.target === targetNode.id))) {
        if (options?.recordHistory !== false) pushHistory()
        setEdges(addEdge({
          id: edgeId,
          source: sourceNode.id,
          sourceHandle: 'capture',
          target: targetNode.id,
          type: 'glow',
          selectable: true,
          interactionWidth: 34,
        }, es))
      }
      return true
    }

    const sourceId = sourceNode.id
    const targetId = targetNode.id
    if (sourceId === targetId) return false
    // 对比节点只走具名槽路由。通用引用列表会造一根没 targetHandle 的线，
    // 删一条就把同一多视频占的多个槽一起清掉。
    if (isImageCompareNodeData(targetData) || isVideoCompareNodeData(targetData)) return false
    if (es.some(edge => edge.id === `e-${sourceId}-${targetId}` || (edge.source === sourceId && edge.target === targetId))) return false
    if (options?.recordHistory !== false) pushHistory()

    const targetParams = (targetData.params ?? {}) as Record<string, unknown>
    const ratioSettingsPatch = inheritedSettingsPatchForReference(sourceData, targetData, targetParams)
    const sourceTextPrompt = sourceData.type === 'text' ? textPromptFromNodeData(sourceData) : ''
    const shouldFillTargetPrompt =
      Boolean(sourceTextPrompt) &&
      (targetData.type === 'image' || targetData.type === 'video') &&
      !String(targetParams.prompt ?? '').trim()

    const ref: NodeRef = {
      nodeId: sourceId,
      // 存的是上游当前的主图 / 主视频。这只是个快照（上游被删掉时的兜底），
      // 平时下游都按 nodeId 实时解析，见 lib/primaryOutput.ts。
      url: primaryOutputUrl(sourceData),
      mediaType: sourceData.type === 'video' || sourceData.type === 'video_merge' ? 'video' : sourceData.type === 'audio' ? 'audio' : 'image',
    }

    if (sourceData.type === 'video' || sourceData.type === 'video_merge') {
      const existing = (targetParams.videoList ?? []) as NodeRef[]
      const nextParams: Record<string, unknown> = { ...targetParams, ...ratioSettingsPatch }
      let shouldUpdate = Object.keys(ratioSettingsPatch).length > 0
      if (!existing.find(r => r.nodeId === sourceId)) {
        shouldUpdate = true
        nextParams.videoList = [...existing, ref]
        nextParams.mixedList = [...existing, ref]
        nextParams.mixedListOrder = [...((targetParams.mixedListOrder as string[]) ?? []), sourceId]
      }
      if (shouldUpdate) updateNodeData(targetId, { params: nextParams })
    } else if (sourceData.type === 'audio') {
      const existing = (targetParams.audioList ?? []) as NodeRef[]
      const nextParams: Record<string, unknown> = { ...targetParams, ...ratioSettingsPatch }
      let shouldUpdate = Object.keys(ratioSettingsPatch).length > 0
      if (!existing.find(r => r.nodeId === sourceId)) {
        shouldUpdate = true
        nextParams.audioList = [...existing, ref]
      }
      if (shouldUpdate) updateNodeData(targetId, { params: nextParams })
    } else if (sourceData.type === 'text') {
      const existing = (targetParams.textList ?? []) as Array<NodeRef & { content?: string }>
      const nextParams: Record<string, unknown> = { ...targetParams, ...ratioSettingsPatch }
      let shouldUpdate = Object.keys(ratioSettingsPatch).length > 0
      if (!existing.find(r => r.nodeId === sourceId)) {
        shouldUpdate = true
        nextParams.textList = [...existing, sourceTextPrompt ? { ...ref, content: sourceTextPrompt } : ref]
      }
      if (shouldFillTargetPrompt) {
        shouldUpdate = true
        nextParams.prompt = sourceTextPrompt
      }
      if (shouldUpdate) updateNodeData(targetId, { params: nextParams })
    } else {
      // image / upload → target gets imageList reference
      const existing = (targetParams.imageList ?? []) as NodeRef[]
      const nextParams: Record<string, unknown> = { ...targetParams, ...ratioSettingsPatch }
      let shouldUpdate = Object.keys(ratioSettingsPatch).length > 0
      if (!existing.find(r => r.nodeId === sourceId)) {
        shouldUpdate = true
        nextParams.imageList = [...existing, ref]
        nextParams.imageListOrder = [...((targetParams.imageListOrder as string[]) ?? []), sourceId]
        if (targetData.type !== 'video') nextParams.modeType = 'image2image'
      }
      if (shouldUpdate) updateNodeData(targetId, { params: nextParams })
    }

    setEdges(addEdge({
      id: `e-${sourceId}-${targetId}`,
      source: sourceId,
      target: targetId,
      type: 'glow',
      selectable: true,
      interactionWidth: EDGE_INTERACTION_WIDTH,
    }, es))
    return true
  }, [pushHistory, updateNodeData, setEdges])

  const cindyCanvasContext = useMemo<CindyCanvasContext>(() => ({
    canvasName: projectName,
    nodes: nodes.slice(0, 120).map((node) => {
      const params = (node.data.params ?? {}) as Record<string, unknown>
      const promptValue = node.data.type === 'text'
        ? params.content ?? params.prompt
        : params.prompt
      const nodeType = String(node.data.type || node.type || '')
      // Surface existing generation settings so the model can honor follow-up
      // instructions like "把这个改成竖版" relative to the current node.
      let settings: CindyProposalNodeSettings | undefined
      if (nodeType === 'image' || nodeType === 'video') {
        const st = (params.settings ?? {}) as Record<string, unknown>
        const out: CindyProposalNodeSettings = {}
        if (st.ratio != null) out.ratio = String(st.ratio)
        if (st.resolution != null) out.resolution = String(st.resolution)
        if (nodeType === 'video' && st.duration != null && Number.isFinite(Number(st.duration))) out.duration = Number(st.duration)
        if (params.count != null && Number.isFinite(Number(params.count))) out.count = Number(params.count)
        if (Object.keys(out).length > 0) settings = out
      }
      return {
        id: node.id,
        type: nodeType,
        name: String(node.data.name || ''),
        prompt: String(promptValue || '').slice(0, 600),
        hasOutput: Array.isArray(node.data.url) && node.data.url.length > 0,
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
        ...(settings ? { settings } : {}),
      }
    }),
    edges: edges.slice(0, 240).map(edge => ({ source: edge.source, target: edge.target })),
    selectedNodeIds: selectedNodeKeys.slice(0, 30),
  }), [edges, nodes, projectName, selectedNodeKeys])

  const applyCindyProposal = useCallback(async (proposal: CindyProposal, messageId: string, options?: { autoGenerate?: boolean }) => {
    const state = useCanvasStore.getState()
    if (!projectUuid || state.projectUuid !== projectUuid) throw new Error('当前画布已切换，请重新发送需求')

    const proposalNodes = proposal.nodes.filter(node => CINDY_PROPOSAL_NODE_TYPES.has(node.type))
    if (proposalNodes.length === 0 && proposal.connections.length === 0) {
      throw new Error('这个方案中没有可应用的节点或连线')
    }

    const existingNodeIds = new Map<string, string>()
    const existingProposalNodes = new Map<string, string>()
    for (const node of state.nodes) {
      existingNodeIds.set(node.id, node.id)
      existingNodeIds.set(node.data.nodeKey, node.id)
      if (String(node.data._cindyProposalMessageId || '') === messageId) {
        existingProposalNodes.set(String(node.data._cindyProposalNodeId || ''), node.id)
      }
    }

    const nodesToCreate = proposalNodes.filter(node => !existingProposalNodes.has(node.id))
    const existingEdgePairs = new Set(state.edges.map(edge => `${edge.source}\u0000${edge.target}`))
    const hasConnectionToApply = proposal.connections.some(connection => {
      const source = existingProposalNodes.get(connection.source) || existingNodeIds.get(connection.source)
      const target = existingProposalNodes.get(connection.target) || existingNodeIds.get(connection.target)
      if (!source || !target) return proposalNodes.some(node => node.id === connection.source || node.id === connection.target)
      return !existingEdgePairs.has(`${source}\u0000${target}`)
    })
    if (nodesToCreate.length === 0 && !hasConnectionToApply) {
      return { nodesCreated: 0, connectionsCreated: 0 }
    }

    pushHistory()

    const columns = proposalNodes.map(node => Number(node.column) || 0)
    const rows = proposalNodes.map(node => Number(node.row) || 0)
    const minColumn = columns.length ? Math.min(...columns) : 0
    const maxColumn = columns.length ? Math.max(...columns) : 0
    const minRow = rows.length ? Math.min(...rows) : 0
    const maxRow = rows.length ? Math.max(...rows) : 0
    const columnCenter = (minColumn + maxColumn) / 2
    const rowCenter = (minRow + maxRow) / 2
    const columnGap = 680
    const rowGap = 480

    const selectedNodes = state.nodes.filter(node => selectedNodeKeys.includes(node.id) || selectedNodeKeys.includes(node.data.nodeKey))
    const selectedBounds = getNodeBounds(selectedNodes)
    let layoutCenterX: number
    let layoutCenterY: number
    if (selectedBounds) {
      layoutCenterX = selectedBounds.x + selectedBounds.width + 220 + ((maxColumn - minColumn) * columnGap) / 2
      layoutCenterY = selectedBounds.y + selectedBounds.height / 2
    } else {
      const rect = canvasRef.current?.getBoundingClientRect()
      const zoom = Math.max(0.05, Number(state.viewport.zoom) || 1)
      const reservedPanelWidth = isMobileCanvas ? 0 : 420
      const availableWidth = Math.max(360, (rect?.width || window.innerWidth) - reservedPanelWidth)
      layoutCenterX = (availableWidth / 2 - state.viewport.x) / zoom
      layoutCenterY = ((rect?.height || window.innerHeight) / 2 - state.viewport.y) / zoom
    }

    const resolvedNodeIds = new Map(existingProposalNodes)
    const createdNodeIds: string[] = []
    for (const node of nodesToCreate) {
      const createdNode = addNodeAt(
        node.type,
        layoutCenterX + (Number(node.column || 0) - columnCenter) * columnGap,
        layoutCenterY + (Number(node.row || 0) - rowCenter) * rowGap,
        cindyProposalNodeData(node, messageId),
        { recordHistory: false },
      )
      resolvedNodeIds.set(node.id, createdNode.id)
      createdNodeIds.push(createdNode.id)
    }

    const latestNodes = useCanvasStore.getState().nodes
    const latestExistingIds = new Map<string, string>()
    for (const node of latestNodes) {
      latestExistingIds.set(node.id, node.id)
      latestExistingIds.set(node.data.nodeKey, node.id)
    }

    let connectionsCreated = 0
    for (const connection of proposal.connections) {
      const source = resolvedNodeIds.get(connection.source) || latestExistingIds.get(connection.source)
      const target = resolvedNodeIds.get(connection.target) || latestExistingIds.get(connection.target)
      if (!source || !target) continue
      if (applyConnection(source, target, { recordHistory: false })) connectionsCreated += 1
    }

    // Cindy "应用并生成": flag freshly-created image/video generation nodes so
    // each fires its own generate (same path as a manual click). Connections are
    // already applied above, so image2image inputs resolve correctly.
    let autoGenerateCount = 0
    if (options?.autoGenerate) {
      const generatableTypes = new Set(['image', 'video'])
      const storeApi = useCanvasStore.getState()
      for (const node of nodesToCreate) {
        if (!generatableTypes.has(node.type)) continue
        const createdId = resolvedNodeIds.get(node.id)
        if (!createdId) continue
        storeApi.updateNodeData(createdId, { _autoGenerate: true })
        autoGenerateCount += 1
      }
    }

    if (createdNodeIds.length > 0) setSelected(createdNodeIds)
    void useCanvasStore.getState().persistNodes()
    return { nodesCreated: createdNodeIds.length, connectionsCreated, autoGenerateCount }
  }, [addNodeAt, applyConnection, isMobileCanvas, projectUuid, pushHistory, selectedNodeKeys, setSelected])


  // ── Drag-and-drop local files ──────────────────────────────────────────────
  const onDragOver = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types)
    const acceptsShotflowItem =
      types.includes(SHOTFLOW_HISTORY_ASSET_DRAG_MIME) ||
      types.includes(SHOTFLOW_FAVORITE_ITEM_DRAG_MIME)
    if (!acceptsShotflowItem && !types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const getFlowPositionFromClient = useCallback((clientX: number, clientY: number) => {
    const { viewport: vp } = useCanvasStore.getState()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
    return {
      x: (clientX - rect.left - vp.x) / vp.zoom,
      y: (clientY - rect.top - vp.y) / vp.zoom,
    }
  }, [])

  const trackPointerPosition = useCallback((clientX: number, clientY: number) => {
    const flowPoint = getFlowPositionFromClient(clientX, clientY)
    canvasPointerPositionRef.current = flowPoint
      ? { clientX, clientY, flowX: flowPoint.x, flowY: flowPoint.y }
      : null
  }, [getFlowPositionFromClient])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      trackPointerPosition(event.clientX, event.clientY)
      selectionPointerCurrentRef.current = { x: event.clientX, y: event.clientY }
      const start = selectionPointerStartRef.current
      if (start && !selectionDragActiveRef.current) {
        const dx = event.clientX - start.x
        const dy = event.clientY - start.y
        if (Math.hypot(dx, dy) > 4) selectionDragActiveRef.current = true
      }
    }
    const handlePointerDown = (event: PointerEvent) => {
      trackPointerPosition(event.clientX, event.clientY)
      selectionDragActiveRef.current = false
      const target = event.target
      if (event.button === 0 && target instanceof Node && canvasRef.current?.contains(target)) {
        selectionPointerStartRef.current = { x: event.clientX, y: event.clientY }
        selectionPointerCurrentRef.current = { x: event.clientX, y: event.clientY }
      } else {
        selectionPointerStartRef.current = null
      }
    }
    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [trackPointerPosition])

  const resolvePasteFlowPosition = useCallback(() => {
    const pointer = canvasPointerPositionRef.current
    if (pointer) {
      const flowPoint = getFlowPositionFromClient(pointer.clientX, pointer.clientY)
      if (flowPoint) return flowPoint
      return { x: pointer.flowX, y: pointer.flowY }
    }
    const menuPoint = pendingUploadPositionRef.current
    if (menuPoint) {
      return menuPoint
    }
    const currentSelection = window.getSelection()
    if (currentSelection && currentSelection.rangeCount > 0) {
      const rect = currentSelection.getRangeAt(0).getBoundingClientRect()
      if (rect.width || rect.height) {
        const flowPoint = getFlowPositionFromClient(rect.left + rect.width / 2, rect.top + rect.height / 2)
        if (flowPoint) return flowPoint
      }
    }
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) {
      const rect = activeElement.getBoundingClientRect()
      if (rect.width || rect.height) {
        const flowPoint = getFlowPositionFromClient(rect.left + rect.width / 2, rect.top + rect.height / 2)
        if (flowPoint) return flowPoint
      }
    }
    const rect = canvasRef.current?.getBoundingClientRect()
    if (rect) {
      const flowPoint = getFlowPositionFromClient(rect.left + rect.width / 2, rect.top + rect.height / 2)
      if (flowPoint) return flowPoint
    }
    const { viewport: vp } = useCanvasStore.getState()
    return {
      x: (rect ? rect.width / 2 : window.innerWidth / 2 - vp.x) / vp.zoom,
      y: (rect ? rect.height / 2 : window.innerHeight / 2 - vp.y) / vp.zoom,
    }
  }, [getFlowPositionFromClient])

  const uploadFilesAt = useCallback(async (files: File[], flowX: number, flowY: number) => {
    const { projectUuid } = useCanvasStore.getState()
    if (!projectUuid) return

    const supportedFiles = files
      .map((file, index) => ({ file, index, kind: localFileKind(file) }))
      .filter((entry): entry is { file: File; index: number; kind: 'image' | 'video' | 'audio' | 'markdown' } => Boolean(entry.kind))
    if (!supportedFiles.length) return

    for (const entry of supportedFiles) {
      if (entry.kind !== 'markdown') continue
      try {
        const content = await entry.file.text()
        addNodeAt('text', flowX + entry.index * 30, flowY + entry.index * 30, {
          name: stripFileExtension(entry.file.name) || 'Markdown',
          action: 'text_node',
          params: {
            ...defaultTextParams(),
            content,
            manualMode: true,
            hasGenerated: false,
          } as unknown as Record<string, unknown>,
          contentWidth: 512,
          contentHeight: 256,
          _updatedAtMs: Date.now(),
        })
      } catch (err) {
        console.error('Read markdown failed', err)
      }
    }

    const uploadableFiles = supportedFiles.filter(entry => entry.kind !== 'markdown')
    if (!uploadableFiles.length) return

    const pendingFiles = uploadableFiles.map(({ file, index }) => {
      if (!isVideoFile(file)) return { file, index, placeholderId: null as string | null }
      const node = addNodeAt('video', flowX + index * 30, flowY + index * 30, {
        url: [],
        action: 'image_resource',
        name: stripFileExtension(file.name),
        uploadInfo: {
          loading: true,
          status: 'uploading',
          progressPercent: 1,
          fileName: file.name,
          byteSize: file.size,
        },
      })
      return { file, index, placeholderId: node.id }
    })

    for (const pending of pendingFiles) {
      const file = pending.file
      try {
        const result = await assetsApi.upload(projectUuid, file, (progressPercent) => {
          if (!pending.placeholderId) return
          const isProcessing = progressPercent >= 100
          updateNodeData(pending.placeholderId, {
            uploadInfo: {
              loading: true,
              status: isProcessing ? 'processing' : 'uploading',
              progressPercent: isProcessing ? 96 : Math.max(1, Math.min(95, progressPercent)),
              fileName: file.name,
              byteSize: file.size,
            },
          })
        })
        const nodeType = isVideoFile(file) ? 'video'
          : isAudioFile(file) ? 'audio'
          : 'upload'
        const resourceKind: ResourceMeta['kind'] = isVideoFile(file)
          ? 'video'
          : isAudioFile(file)
            ? 'audio'
            : 'image'
        const resourceMeta = resourceMetaFromUploadPayload(
          result.meta as Record<string, unknown> | undefined,
          resourceKind
        )
        const assetCreatedAtMs = resourceMeta?.createdAtMs ?? Date.now()
        const nextData: Partial<CanvasNodeData> = {
          url: [result.url],
          action: 'image_resource',
          name: stripFileExtension(file.name),
          uploadInfo: undefined,
          _assetCreatedAtMs: mergeAssetCreatedAtMap(undefined, [
            result.url,
            result.displayUrl,
            resourceMeta?.displayUrl,
            resourceMeta?.originalUrl,
          ], assetCreatedAtMs),
          _updatedAtMs: assetCreatedAtMs,
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
        }

        if (pending.placeholderId) {
          updateNodeData(pending.placeholderId, nextData)
        } else {
          addNodeAt(nodeType, flowX + pending.index * 30, flowY + pending.index * 30, nextData)
        }
      } catch (err) {
        console.error('Upload failed', err)
        if (pending.placeholderId) {
          updateNodeData(pending.placeholderId, {
            uploadInfo: {
              loading: false,
              status: 'failed',
              progressPercent: 0,
              fileName: file.name,
              byteSize: file.size,
              error: uploadErrorToText(err),
            },
          })
        }
      }
    }
  }, [addNodeAt, updateNodeData])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types)
    const hasShotflowItem =
      types.includes(SHOTFLOW_HISTORY_ASSET_DRAG_MIME) ||
      types.includes(SHOTFLOW_FAVORITE_ITEM_DRAG_MIME)
    if (!hasShotflowItem && !types.includes('Files')) return
    e.preventDefault()
    trackPointerPosition(e.clientX, e.clientY)

    const flowPoint = getFlowPositionFromClient(e.clientX, e.clientY)
    if (!flowPoint) return

    const favoriteItem = readDragPayload<FavoriteLibraryItem>(e.dataTransfer, SHOTFLOW_FAVORITE_ITEM_DRAG_MIME)
    if (favoriteItem?.id) {
      const detail = favoriteItem.payload.nodes.length > 0
        ? favoriteItem
        : (await (favoriteItem.shared ? favoritesApi.getShared(favoriteItem.id) : favoritesApi.get(favoriteItem.id))).item
      if (detail.payload.nodes.length === 0) return
      await insertFavoritePayload(detail.payload, flowPoint)
      setDockPanel(null)
      return
    }

    const historyAsset = readDragPayload<HistoryAsset>(e.dataTransfer, SHOTFLOW_HISTORY_ASSET_DRAG_MIME)
    if (historyAsset?.url && historyAsset.kind) {
      const usedAtMs = Date.now()
      addNodeAt(historyAsset.kind, flowPoint.x, flowPoint.y, {
        url: [historyAsset.url],
        action: 'image_resource',
        name: historyAsset.name || historyAsset.kind,
        ...(historyAsset.meta ? { _resourceMeta: { items: [historyAsset.meta] } } : {}),
        _assetCreatedAtMs: mergeAssetCreatedAtMap(undefined, [
          historyAsset.url,
          historyAsset.displayUrl,
          historyAsset.meta?.displayUrl,
          historyAsset.meta?.originalUrl,
        ], usedAtMs),
        _updatedAtMs: usedAtMs,
      })
      return
    }

    await uploadFilesAt(Array.from(e.dataTransfer.files), flowPoint.x, flowPoint.y)
  }, [addNodeAt, getFlowPositionFromClient, insertFavoritePayload, trackPointerPosition, uploadFilesAt])

  const focusCanvasBounds = useCallback((
    bounds: { x: number; y: number; width: number; height: number },
    anchorBounds = bounds,
    zoomScale = 1
  ) => {
    const canvasRect = canvasRef.current?.getBoundingClientRect()
    const reactFlow = reactFlowInstanceRef.current
    if (!canvasRect || !reactFlow) return

    const paddingX = 72
    const paddingY = 72
    const safeLeft = paddingX
    const safeRight = paddingX
    const safeTop = paddingY
    const safeBottom = paddingY
    const safeWidth = Math.max(1, canvasRect.width - safeLeft - safeRight)
    const safeHeight = Math.max(1, canvasRect.height - safeTop - safeBottom)
    const safeCenterX = safeLeft + safeWidth / 2
    const safeCenterY = safeTop + safeHeight / 2

    const anchorCenterX = anchorBounds.x + anchorBounds.width / 2
    const anchorCenterY = anchorBounds.y + anchorBounds.height / 2
    const requiredHalfWidth = Math.max(
      1,
      anchorCenterX - bounds.x,
      bounds.x + bounds.width - anchorCenterX
    )
    const requiredHalfHeight = Math.max(
      1,
      anchorCenterY - bounds.y,
      bounds.y + bounds.height - anchorCenterY
    )

    const zoomX = safeWidth / (requiredHalfWidth * 2)
    const zoomY = safeHeight / (requiredHalfHeight * 2)
    const fittedZoom = Math.min(zoomX, zoomY)
    const nextZoom = Math.max(0.05, Math.min(4, fittedZoom * zoomScale))
    const nextViewport = {
      zoom: nextZoom,
      x: safeCenterX - anchorCenterX * nextZoom,
      y: safeCenterY - anchorCenterY * nextZoom,
    }

    void reactFlow.setViewport(nextViewport, { duration: 280 })
    setViewport(nextViewport)
  }, [setViewport])

  const focusSelectionFlow = useCallback(() => {
    if (selectedNodeKeys.length === 0) return

    const flowNodeIds = collectFlowSelection(edges, selectedNodeKeys).nodeIds
    const focusNodes = nodes.filter((node) => flowNodeIds.has(node.id))
    const selectedNodes = nodes.filter((node) => selectedNodeKeys.includes(node.id))
    const bounds = getNodeBounds(focusNodes)
    const selectedBounds = getNodeBounds(selectedNodes)
    if (!bounds || !selectedBounds) return

    const selectionKey = [
      [...selectedNodeKeys].sort().join('|'),
      [...flowNodeIds].sort().join('|'),
    ].join('::')
    const previousCycle = focusCycleRef.current
    const step = previousCycle.selectionKey === selectionKey
      ? previousCycle.nextStep
      : 0

    focusCanvasBounds(bounds, selectedBounds, FOCUS_ZOOM_STEPS[step])
    focusCycleRef.current = {
      selectionKey,
      nextStep: (step + 1) % FOCUS_ZOOM_STEPS.length,
    }
  }, [edges, focusCanvasBounds, nodes, selectedNodeKeys])

  const showCanvasOverview = useCallback(() => {
    if (nodes.length === 0) {
      const reactFlow = reactFlowInstanceRef.current
      const nextViewport = { x: 0, y: 0, zoom: 1 }
      if (reactFlow) void reactFlow.setViewport(nextViewport, { duration: 220 })
      setViewport(nextViewport)
      return
    }

    const bounds = getNodeBounds(nodes)
    if (!bounds) return
    focusCanvasBounds(bounds)
  }, [focusCanvasBounds, nodes, setViewport])

  useEffect(() => {
    if (!projectUuid || !isFlowReady || nodes.length === 0) return
    if (autoFitCheckedProjectRef.current === projectUuid) return

    const canvasRect = canvasRef.current?.getBoundingClientRect()
    if (!canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0) return

    autoFitCheckedProjectRef.current = projectUuid
    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
    const hasVisibleNode = nodes.some((node) => {
      const width = Number(node.data?.contentWidth ?? node.width ?? node.measured?.width ?? 240)
      const height = Number(node.data?.contentHeight ?? node.height ?? node.measured?.height ?? 160)
      const left = node.position.x * zoom + viewport.x
      const top = node.position.y * zoom + viewport.y
      const right = (node.position.x + width) * zoom + viewport.x
      const bottom = (node.position.y + height) * zoom + viewport.y
      return right >= 0 && bottom >= 0 && left <= canvasRect.width && top <= canvasRect.height
    })

    if (!hasVisibleNode) {
      requestAnimationFrame(() => showCanvasOverview())
    }
  }, [isFlowReady, nodes, projectUuid, showCanvasOverview, viewport.x, viewport.y, viewport.zoom])

  // ── Paste from clipboard ───────────────────────────────────────────────────
  useEffect(() => {
    const handleCopy = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return
      if (hasTextSelection()) return
      const state = useCanvasStore.getState()
      if (state.selectedNodeKeys.length === 0) return

      state.copySelected()
      recentNodeClipboardAtRef.current = Date.now()
      const encoded = encodeShotflowNodeClipboard(useCanvasStore.getState().clipboard)
      if (!encoded || !e.clipboardData) return

      e.clipboardData.setData(SHOTFLOW_NODE_CLIPBOARD_MIME, encoded)
      e.clipboardData.setData('text/plain', SHOTFLOW_NODE_CLIPBOARD_TEXT)
      e.preventDefault()
    }

    const handlePaste = async (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return
      const { projectUuid, clipboard: nodeClipboard } = useCanvasStore.getState()
      if (!projectUuid) return

      const { x, y } = resolvePasteFlowPosition()
      const shotflowClipboard = decodeShotflowNodeClipboard(
        e.clipboardData?.getData(SHOTFLOW_NODE_CLIPBOARD_MIME) ?? ''
      )
      if (shotflowClipboard) {
        e.preventDefault()
        recentNodeClipboardAtRef.current = Date.now()
        useCanvasStore.setState({ clipboard: shotflowClipboard })
        useCanvasStore.getState().pasteClipboard({ x, y })
        return
      }

      const directFiles = Array.from(e.clipboardData?.files ?? []).filter(isSupportedLocalFile)
      const itemFiles = directFiles.length
        ? []
        : Array.from(e.clipboardData?.items ?? [])
            .filter(item => item.kind === 'file')
            .map(item => item.getAsFile())
            .filter((file): file is File => Boolean(file) && isSupportedLocalFile(file))

      const clipboardFiles = (directFiles.length ? directFiles : itemFiles).map((file, index) => normalizeClipboardFile(file, index))
      const recentlyCopiedNode = Date.now() - recentNodeClipboardAtRef.current <= INTERNAL_NODE_CLIPBOARD_TTL_MS

      if (clipboardFiles.length > 0) {
        e.preventDefault()
        try {
          await uploadFilesAt(clipboardFiles, x, y)
        } catch (err) {
          console.error('Paste upload failed', err)
        }
        return
      }

      const clipboardText = e.clipboardData?.getData('text/plain').trim() ?? ''
      const canUseInternalClipboard = !clipboardText || clipboardText === SHOTFLOW_NODE_CLIPBOARD_TEXT || recentlyCopiedNode
      if (nodeClipboard?.nodes.length && canUseInternalClipboard) {
        e.preventDefault()
        useCanvasStore.getState().pasteClipboard({ x, y })
      }
    }
    window.addEventListener('copy', handleCopy)
    window.addEventListener('paste', handlePaste)
    return () => {
      window.removeEventListener('copy', handleCopy)
      window.removeEventListener('paste', handlePaste)
    }
  }, [resolvePasteFlowPosition, uploadFilesAt])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return

      const selectedGroups = nodes.filter(node =>
        (node.type === 'group' || node.data.type === 'group') &&
        (selectedNodeKeys.includes(node.id) || selectedNodeKeys.includes(node.data.nodeKey))
      )
      if (selectedGroups.length === 0) return

      e.preventDefault()
      e.stopPropagation()
      selectedGroups.forEach(group => ungroupNodes(group.id))
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [nodes, selectedNodeKeys, ungroupNodes])

  // ── Ctrl+C / Ctrl+V / Ctrl+Z ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      // Skip when typing in inputs / textareas / contenteditable
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.target as HTMLElement)?.isContentEditable) return
      const key = e.key.toLowerCase()

      if (!e.ctrlKey && !e.metaKey && !e.altKey && key === 'f') {
        focusSelectionFlow()
        e.preventDefault()
        return
      }

      const mod = e.ctrlKey || e.metaKey
      if (!mod) return

      if (key === 'c' && !e.shiftKey && !e.altKey && !hasTextSelection()) {
        const state = useCanvasStore.getState()
        if (state.selectedNodeKeys.length > 0) {
          state.copySelected()
          recentNodeClipboardAtRef.current = Date.now()
        }
        return
      }

      if (key === 'z' && e.ctrlKey && !e.shiftKey) { undo(); e.preventDefault() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusSelectionFlow, undo])

  // ── React Flow handlers ────────────────────────────────────────────────────
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const hasDraggingPosition = changes.some(change => change.type === 'position' && change.dragging)
    const hasPositionStop = changes.some(change => change.type === 'position' && !change.dragging && Boolean(change.position))
    const hasResizingDimensions = changes.some(change => change.type === 'dimensions' && Boolean((change as { resizing?: boolean }).resizing))
    const hasDimensionsStop = changes.some(change => change.type === 'dimensions' && !Boolean((change as { resizing?: boolean }).resizing))
    const hasPersistentNodeChange = hasPositionStop || hasDimensionsStop || changes.some(change => change.type === 'remove')
    if (hasDraggingPosition && !dragHistoryPushedRef.current) {
      pushHistory()
      dragHistoryPushedRef.current = true
    }
    if (hasDraggingPosition || hasResizingDimensions) {
      setActivePanelNode(null)
    }
    if (hasPositionStop) {
      dragHistoryPushedRef.current = false
    }
    if (changes.some(c => c.type === 'remove')) pushHistory()
    // Use O(1) Map lookup instead of O(n) Array.find per drag frame
    const map = nodeMapRef.current
    const extraChanges: NodeChange[] = []
    const movedChildIds = new Set<string>()
    const movedGroupIds = new Set<string>()
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        const node = map.get(change.id)
        if (node?.type === 'group') {
          movedGroupIds.add(node.id)
          const dx = change.position.x - node.position.x
          const dy = change.position.y - node.position.y
          if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
            const childIds = ((node.data.params as Record<string, unknown>)?.childIds as string[]) ?? []
            for (const childId of childIds) {
              const child = map.get(childId)
              if (child) {
                extraChanges.push({
                  type: 'position', id: childId, dragging: change.dragging,
                  position: { x: child.position.x + dx, y: child.position.y + dy },
                })
              }
            }
          }
        } else if (node) {
          movedChildIds.add(node.id)
        }
      } else if (change.type === 'dimensions') {
        const node = map.get(change.id)
        if (node?.type === 'group') movedGroupIds.add(node.id)
        else if (node) movedChildIds.add(node.id)
      }
    }
    const changedNodes = applyNodeChanges([...changes, ...extraChanges], nodes as Node[]) as FlowNode[]
    const updated = fitGroupsToChangedChildren(changedNodes, movedChildIds, movedGroupIds, viewport.zoom)
    // Keep map in sync
    nodeMapRef.current = new Map(updated.map(n => [n.id, n]))
    // Delete / Backspace 是 React Flow 自己处理的：它直接把节点摘掉，只通过 remove 变更
    // 通知我们，走不到 store 的 deleteNodes，于是删除意图没人登记 —— 自动保存按规矩拒绝
    // 删服务端节点（控制台留下"在本地消失但没有删除意图"），刷新后节点原样回来。
    // 2026-08-15 canvas 195 就是这样：右键菜单删得掉，按 Delete 删不掉。
    // 这里把键盘删掉的节点补登记上，并让这一次保存立刻发出去。
    const removedNodeKeys = changes
      .filter(change => change.type === 'remove')
      .map(change => String(map.get(change.id)?.data.nodeKey ?? change.id))
      .filter(Boolean)
    if (removedNodeKeys.length > 0 && projectUuid) {
      markNodesDeletedByUser(projectUuid, removedNodeKeys, updated.length)
    }
    setNodes(updated, {
      persist: hasPersistentNodeChange,
      markDirty: hasDraggingPosition || hasResizingDimensions || hasPersistentNodeChange,
      immediate: removedNodeKeys.length > 0,
    })
  }, [nodes, setNodes, pushHistory, setActivePanelNode, viewport.zoom, projectUuid])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (selectionDragActiveRef.current && changes.every(change => change.type === 'select')) {
      return
    }
    const removes = changes.filter(c => c.type === 'remove')
    let nextNodes = useCanvasStore.getState().nodes
    if (removes.length > 0) {
      const state = useCanvasStore.getState()
      const removeIds = new Set(removes.map(c => (c as { id: string }).id))
      const removedEdges = state.edges.filter(edge => removeIds.has(edge.id))
      if (removedEdges.length > 0) {
        pushHistory()
        const result = removeEdgeReferencesFromNodes(state.nodes, removedEdges)
        if (result.changed) {
          nextNodes = result.nodes
          setNodes(result.nodes, { persist: true, markDirty: true, immediate: true })
        }
      }
    }
    const currentEdges = useCanvasStore.getState().edges
    const changedEdges = applyEdgeChanges(changes, currentEdges)
    const nextEdges = removes.length > 0
      ? edgesFromNodeReferences(nextNodes, changedEdges)
      : changedEdges
    const sameSelection =
      nextEdges.length === currentEdges.length &&
      nextEdges.every((edge, index) =>
        edge.id === currentEdges[index]?.id &&
        Boolean(edge.selected) === Boolean(currentEdges[index]?.selected)
      )
    if (sameSelection && changes.every(change => change.type === 'select')) return
    setEdges(nextEdges)
  }, [setEdges, setNodes, pushHistory])

  const clearMultiSelection = useCallback(() => {
    const currentNodes = useCanvasStore.getState().nodes
    setSelected([])
    setActivePanelNode(null)
    setNodes(
      currentNodes.map(node => node.selected ? { ...node, selected: false } : node),
      { persist: false, markDirty: false }
    )
  }, [setActivePanelNode, setNodes, setSelected])

  const applyMultiSelectionConnection = useCallback((target: string) => {
    const state = useCanvasStore.getState()
    const targetNode = state.nodes.find(node => node.id === target || node.data.nodeKey === target)
    if (!targetNode) {
      clearMultiSelection()
      return
    }

    const sourceIds = collectGroupingTargets(state.nodes, state.selectedNodeKeys)
      .map(node => node.id)
      .filter(sourceId => sourceId !== targetNode.id)

    const connectableSourceIds = sourceIds.filter(sourceId =>
      !state.edges.some(edge => edge.source === sourceId && edge.target === targetNode.id)
    )

    if (connectableSourceIds.length > 0) {
      pushHistory()
      connectableSourceIds.forEach(sourceId => {
        if (routeImageCompareConnection(sourceId, targetNode.id)) return
        if (routeVideoCompareConnection(sourceId, targetNode.id)) return
        applyConnection(sourceId, targetNode.id, { recordHistory: false })
      })
    }

    clearMultiSelection()
    // 对比节点的专用连线路由在后面才定义。这里不能写进依赖数组，
    // 否则首次渲染会撞 temporal dead zone，整页黑屏。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyConnection, clearMultiSelection, pushHistory])

  const startMultiSelectionConnectDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setMultiConnectDrag({
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    })
  }, [])

  useEffect(() => {
    if (!isMultiConnectDragging) return

    const move = (event: PointerEvent) => {
      setMultiConnectDrag(drag => drag ? {
        ...drag,
        currentX: event.clientX,
        currentY: event.clientY,
      } : null)
      setConnectionHoverTarget(findTargetHandleNodeIdAt(event.clientX, event.clientY))
    }

    const finish = (event: PointerEvent) => {
      const targetNodeId = findTargetHandleNodeIdAt(event.clientX, event.clientY)
      const state = useCanvasStore.getState()
      const sourceIds = collectGroupingTargets(state.nodes, state.selectedNodeKeys).map(node => node.id)
      setMultiConnectDrag(null)
      setConnectionHoverTarget(null)
      if (targetNodeId) {
        applyMultiSelectionConnection(targetNodeId)
      } else if (sourceIds.length > 0) {
        setMultiConnMenu({ screenX: event.clientX, screenY: event.clientY, sourceIds })
      }
    }

    const cancel = () => {
      setMultiConnectDrag(null)
      setConnectionHoverTarget(null)
    }

    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
    }

    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', cancelOnEscape, true)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', cancelOnEscape, true)
    }
  }, [applyMultiSelectionConnection, isMultiConnectDragging, setConnectionHoverTarget])

  // Atmosphere-transfer nodes carry two typed inputs (原图 / 参考图), distinguished
  // by which target handle a connection lands on. Handle that here so the shared
  // applyConnection list-routing stays untouched for every other node type.
  const routeAtmosphereConnection = useCallback((source: string, target: string, targetHandle?: string | null) => {
    const { nodes: ns, edges: es } = useCanvasStore.getState()
    const targetNode = ns.find(n => n.id === target || n.data.nodeKey === target)
    if (!targetNode || (targetNode.data as CanvasNodeData).type !== 'atmosphere_transfer') return false
    const sourceNode = ns.find(n => n.id === source || n.data.nodeKey === source)
    if (!sourceNode || sourceNode.id === targetNode.id) return false
    const sourceId = sourceNode.id
    const targetId = targetNode.id
    const sourceData = sourceNode.data as CanvasNodeData
    const handle = targetHandle === 'reference' ? 'reference' : 'source'
    const role = handle === 'reference' ? 'referenceRef' : 'sourceRef'
    const ref = { nodeId: sourceId, url: primaryOutputUrl(sourceData), name: String(sourceData.name || '') }
    const targetParams = (targetNode.data as CanvasNodeData).params ?? {}
    updateNodeData(targetId, { params: { ...targetParams, [role]: ref } })
    const edgeId = `e-${sourceId}-${targetId}-${handle}`
    if (!es.some(edge => edge.id === edgeId || (edge.source === sourceId && edge.target === targetId && edge.targetHandle === handle))) {
      pushHistory()
      setEdges(addEdge({ id: edgeId, source: sourceId, target: targetId, targetHandle: handle, type: 'glow', selectable: true, interactionWidth: 34 }, es))
    }
    return true
  }, [updateNodeData, setEdges, pushHistory])

  const routePanoramaViewerConnection = useCallback((source: string, target: string) => {
    const { nodes: ns, edges: es } = useCanvasStore.getState()
    const targetNode = ns.find(n => n.id === target || n.data.nodeKey === target)
    if (!targetNode || (targetNode.data as CanvasNodeData).type !== 'panorama_viewer') return false
    const sourceNode = ns.find(n => n.id === source || n.data.nodeKey === source)
    if (!sourceNode || sourceNode.id === targetNode.id) return false
    const sourceData = sourceNode.data as CanvasNodeData
    const panoramaRef = {
      nodeId: sourceNode.id,
      url: primaryOutputUrl(sourceData),
      name: String(sourceData.name || 'HDR全景'),
    }
    const targetParams = (targetNode.data as CanvasNodeData).params ?? {}
    updateNodeData(targetNode.id, { params: { ...targetParams, panoramaRef } })
    const retainedEdges = es.filter(edge => !(edge.target === targetNode.id && edge.targetHandle === 'panorama'))
    pushHistory()
    setEdges(addEdge({
      id: `e-${sourceNode.id}-${targetNode.id}-panorama`,
      source: sourceNode.id,
      target: targetNode.id,
      targetHandle: 'panorama',
      type: 'glow',
      selectable: true,
      interactionWidth: 34,
    }, retainedEdges))
    return true
  }, [updateNodeData, setEdges, pushHistory])

  /**
   * 三维空间节点的参考图输入。
   *
   * 连进来的图片是用来**分析出人物姿势**的（2026-08-26 定的用法），所以它要落在
   * `params.stageRef`，不能走通用的 applyConnection —— 后者会把源节点塞进
   * `params.imageList`，而三维空间节点根本不读那个列表，只会留下一条什么都不干的连线
   * （和图片对比节点当初踩的是同一个坑）。
   *
   * 只收**一张**参考图：新连一张就把旧的入边替换掉，和全景查看器的 panorama 口一样。
   * 目标是三维空间节点时一律返回 true，哪怕这次连线没被接受。
   */
  const routeDirectorStageConnection = useCallback((source: string, target: string) => {
    const { nodes: ns, edges: es } = useCanvasStore.getState()
    const targetNode = ns.find(n => n.id === target || n.data.nodeKey === target)
    if (!targetNode || (targetNode.data as CanvasNodeData).type !== 'director_stage') return false
    const sourceNode = ns.find(n => n.id === source || n.data.nodeKey === source)
    if (!sourceNode || sourceNode.id === targetNode.id) return true

    const sourceData = sourceNode.data as CanvasNodeData
    // 视频 / 音频 / 文本没有可分析的人物姿势，别让它们占掉唯一的参考图位
    if (sourceData.type === 'video' || sourceData.type === 'video_merge' || sourceData.type === 'audio' || sourceData.type === 'text') {
      return true
    }

    const targetParams = (targetNode.data as CanvasNodeData).params ?? {}
    updateNodeData(targetNode.id, {
      params: {
        ...targetParams,
        stageRef: {
          nodeId: sourceNode.id,
          url: primaryOutputUrl(sourceData),
          name: String(sourceData.name || '参考图'),
        },
      },
    })
    const retainedEdges = es.filter(edge => edge.target !== targetNode.id)
    pushHistory()
    setEdges(addEdge({
      id: `e-${sourceNode.id}-${targetNode.id}-stage-reference`,
      source: sourceNode.id,
      target: targetNode.id,
      type: 'glow',
      selectable: true,
      interactionWidth: 34,
    }, retainedEdges))
    return true
  }, [updateNodeData, setEdges, pushHistory])

  /**
   * 图片对比节点的 A/B 输入。
   *
   * 目标是对比节点时**一律返回 true**（不管这次连线接不接受），否则会掉进通用的
   * applyConnection，把源节点塞进 params.imageList —— 那是给生成节点用的引用列表，
   * 对比节点根本不读它，只会留下一条幽灵连线。
   */
  const routeImageCompareConnection = useCallback((source: string, target: string, targetHandle?: string | null) => {
    const { nodes: ns, edges: es } = useCanvasStore.getState()
    const targetNode = ns.find(n => n.id === target || n.data.nodeKey === target)
    if (!targetNode || !isImageCompareNodeData(targetNode.data as CanvasNodeData)) return false
    const sourceNode = ns.find(n => n.id === source || n.data.nodeKey === source)
    const plan = planImageCompareAssignment({
      sourceNodeId: sourceNode?.id ?? '',
      sourceData: sourceNode?.data as CanvasNodeData | undefined,
      targetNodeId: targetNode.id,
      targetData: targetNode.data as CanvasNodeData,
      requestedHandle: targetHandle,
    })
    if (!plan.ok) return true
    const targetParams = (targetNode.data as CanvasNodeData).params ?? {}
    updateNodeData(targetNode.id, {
      params: {
        ...targetParams,
        [plan.refKey]: compareRefFromNode(sourceNode!.id, sourceNode!.data as CanvasNodeData),
      },
    })
    // 同一个槽再连一次 = 替换：先摘掉这个槽上的旧边
    const retainedEdges = es.filter(edge => !(edge.target === targetNode.id && edge.targetHandle === plan.handle))
    pushHistory()
    setEdges(addEdge({
      id: `e-${sourceNode!.id}-${targetNode.id}-${plan.handle}`,
      source: sourceNode!.id,
      target: targetNode.id,
      targetHandle: plan.handle,
      type: 'glow',
      selectable: true,
      interactionWidth: 34,
    }, retainedEdges))
    return true
  }, [updateNodeData, setEdges, pushHistory])

  const routeVideoCompareConnection = useCallback((source: string, target: string, targetHandle?: string | null) => {
    const { nodes: ns, edges: es } = useCanvasStore.getState()
    const targetNode = ns.find(n => n.id === target || n.data.nodeKey === target)
    if (!targetNode || !isVideoCompareNodeData(targetNode.data as CanvasNodeData)) return false
    const sourceNode = ns.find(n => n.id === source || n.data.nodeKey === source)
    const plan = planVideoCompareAssignment({
      sourceNodeId: sourceNode?.id ?? '',
      sourceData: sourceNode?.data as CanvasNodeData | undefined,
      targetNodeId: targetNode.id,
      targetData: targetNode.data as CanvasNodeData,
      requestedHandle: targetHandle,
    })
    if (!plan.ok) return true
    const targetParams = (targetNode.data as CanvasNodeData).params ?? {}
    const occupiedUrls = ['compareRefA', 'compareRefB', 'compareRefC', 'compareRefD']
      .filter((key) => key !== plan.refKey)
      .map((key) => String((targetParams[key] as { url?: unknown } | null | undefined)?.url || ''))
      .filter(Boolean)
    updateNodeData(targetNode.id, {
      params: {
        ...targetParams,
        [plan.refKey]: compareVideoRefFromNode(
          sourceNode!.id,
          sourceNode!.data as CanvasNodeData,
          nextUnusedVideoCompareUrl(sourceNode!.data as CanvasNodeData, occupiedUrls),
        ),
      },
    })
    const retainedEdges = es.filter(edge => !(edge.target === targetNode.id && edge.targetHandle === plan.handle))
    pushHistory()
    setEdges(addEdge({
      id: `e-${sourceNode!.id}-${targetNode.id}-${plan.handle}`,
      source: sourceNode!.id,
      target: targetNode.id,
      targetHandle: plan.handle,
      type: 'glow',
      selectable: true,
      interactionWidth: 34,
    }, retainedEdges))
    return true
  }, [updateNodeData, setEdges, pushHistory])

  const onConnect = useCallback((connection: Connection) => {
    didConnectRef.current = true
    setIsHandleConnecting(false)
    setConnectionHoverTarget(null)
    const { source, target, targetHandle } = connection
    if (!source || !target) return
    if (routeAtmosphereConnection(source, target, targetHandle)) return
    if (routePanoramaViewerConnection(source, target)) return
    if (routeDirectorStageConnection(source, target)) return
    if (routeImageCompareConnection(source, target, targetHandle)) return
    if (routeVideoCompareConnection(source, target, targetHandle)) return
    applyConnection(source, target)
  }, [applyConnection, routeAtmosphereConnection, routePanoramaViewerConnection, routeDirectorStageConnection, routeImageCompareConnection, routeVideoCompareConnection, setConnectionHoverTarget])

  const onConnectStart = useCallback((_e: unknown, { nodeId, handleType }: { nodeId?: string | null; handleType?: string | null }) => {
    connStartRef.current = { nodeId: nodeId ?? '', handleType: handleType ?? '' }
    didConnectRef.current = false
    setIsHandleConnecting(handleType === 'source')
    setConnectionHoverTarget(null)
  }, [setConnectionHoverTarget])

  const onConnectEnd = useCallback((e: MouseEvent | TouchEvent) => {
    setIsHandleConnecting(false)
    setConnectionHoverTarget(null)
    if (didConnectRef.current) return
    if (connStartRef.current?.handleType !== 'source') return

    const clientX = 'touches' in e ? (e as TouchEvent).changedTouches[0].clientX : (e as MouseEvent).clientX
    const clientY = 'touches' in e ? (e as TouchEvent).changedTouches[0].clientY : (e as MouseEvent).clientY

    if ((e.target as Element)?.closest('.react-flow__handle')) return

    setConnMenu({ screenX: clientX, screenY: clientY, sourceId: connStartRef.current.nodeId })
    connStartRef.current = null
  }, [setConnectionHoverTarget])

  useEffect(() => {
    if (!isHandleConnecting) return

    const updateHoverTarget = (event: PointerEvent) => {
      const targetNodeId = findTargetHandleNodeIdAt(event.clientX, event.clientY)
      setConnectionHoverTarget(targetNodeId)
    }

    const clearHoverTarget = () => {
      setIsHandleConnecting(false)
      setConnectionHoverTarget(null)
    }

    window.addEventListener('pointermove', updateHoverTarget, true)
    window.addEventListener('pointerup', clearHoverTarget, true)
    window.addEventListener('pointercancel', clearHoverTarget, true)
    window.addEventListener('blur', clearHoverTarget)
    return () => {
      window.removeEventListener('pointermove', updateHoverTarget, true)
      window.removeEventListener('pointerup', clearHoverTarget, true)
      window.removeEventListener('pointercancel', clearHoverTarget, true)
      window.removeEventListener('blur', clearHoverTarget)
      setConnectionHoverTarget(null)
    }
  }, [isHandleConnecting, setConnectionHoverTarget])

  const handleMenuSelect = useCallback((type: string) => {
    if (!connMenu) return
    const { viewport: vp } = useCanvasStore.getState()
    const rect = canvasRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const x = (connMenu.screenX - rect.left - vp.x) / vp.zoom
    const y = (connMenu.screenY - rect.top - vp.y) / vp.zoom
    const newNode = addNodeAt(type, x, y)
    if (
      !routePanoramaViewerConnection(connMenu.sourceId, newNode.id) &&
      !routeDirectorStageConnection(connMenu.sourceId, newNode.id) &&
      !routeImageCompareConnection(connMenu.sourceId, newNode.id) &&
      !routeVideoCompareConnection(connMenu.sourceId, newNode.id)
    ) {
      applyConnection(connMenu.sourceId, newNode.id)
    }
    setConnMenu(null)
  }, [connMenu, addNodeAt, applyConnection, routePanoramaViewerConnection, routeDirectorStageConnection, routeImageCompareConnection, routeVideoCompareConnection])

  const handleMultiMenuSelect = useCallback((type: string) => {
    if (!multiConnMenu) return
    const { viewport: vp } = useCanvasStore.getState()
    const rect = canvasRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const x = (multiConnMenu.screenX - rect.left - vp.x) / vp.zoom
    const y = (multiConnMenu.screenY - rect.top - vp.y) / vp.zoom
    const newNode = addNodeAt(type, x, y)
    multiConnMenu.sourceIds
      .filter(sourceId => sourceId !== newNode.id)
      .forEach(sourceId => {
        if (routeImageCompareConnection(sourceId, newNode.id)) return
        if (routeVideoCompareConnection(sourceId, newNode.id)) return
        applyConnection(sourceId, newNode.id, { recordHistory: false })
      })
    setMultiConnMenu(null)
    clearMultiSelection()
  }, [addNodeAt, applyConnection, clearMultiSelection, multiConnMenu, routeImageCompareConnection, routeVideoCompareConnection])

  const closeCanvasMenu = useCallback(() => {
    setCanvasMenu(null)
  }, [])

  const closeNodeMenu = useCallback(() => {
    setNodeMenu(null)
  }, [])

  const closeAllContextMenus = useCallback(() => {
    setConnMenu(null)
    setMultiConnMenu(null)
    setCanvasMenu(null)
    setNodeMenu(null)
    setDockPanel(null)
  }, [])

  useEffect(() => {
    if (!dockPanel) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDockPanel(null)
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [dockPanel])

  useEffect(() => {
    const handleCtrlWheelZoom = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()

      const root = canvasRef.current
      if (!root) return
      const rect = root.getBoundingClientRect()
      const currentViewport = useCanvasStore.getState().viewport
      const currentZoom = Number.isFinite(currentViewport.zoom) && currentViewport.zoom > 0 ? currentViewport.zoom : 1
      const nextZoom = Math.max(0.05, Math.min(4, currentZoom * Math.exp(-event.deltaY * 0.0015)))
      if (Math.abs(nextZoom - currentZoom) < 0.0001) return

      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      const flowX = (localX - currentViewport.x) / currentZoom
      const flowY = (localY - currentViewport.y) / currentZoom
      const nextViewport: Viewport = {
        x: localX - flowX * nextZoom,
        y: localY - flowY * nextZoom,
        zoom: nextZoom,
      }

      reactFlowInstanceRef.current?.setViewport(nextViewport, { duration: 0 })
      setViewport(nextViewport)
    }

    window.addEventListener('wheel', handleCtrlWheelZoom, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', handleCtrlWheelZoom, true)
  }, [setViewport])

  useEffect(() => {
    const lastPos = { x: 0, y: 0 }
    let dragging = false

    const onMouseDown = (event: MouseEvent) => {
      if (!isCanvasMiddleButton(event.button)) return
      if (!isExpandedGalleryPanTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      dragging = true
      lastPos.x = event.clientX
      lastPos.y = event.clientY
    }

    const onMouseMove = (event: MouseEvent) => {
      if (!dragging) return
      event.preventDefault()
      const current = useCanvasStore.getState().viewport
      const nextViewport = nextCanvasPanViewport(
        current,
        event.clientX,
        event.clientY,
        lastPos.x,
        lastPos.y,
      )
      lastPos.x = event.clientX
      lastPos.y = event.clientY
      reactFlowInstanceRef.current?.setViewport(nextViewport, { duration: 0 })
      setViewport(nextViewport)
    }

    const stopDrag = () => {
      dragging = false
    }

    const onAuxClick = (event: MouseEvent) => {
      if (!isCanvasMiddleButton(event.button)) return
      if (!isExpandedGalleryPanTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', stopDrag, true)
    window.addEventListener('auxclick', onAuxClick, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mousemove', onMouseMove, true)
      window.removeEventListener('mouseup', stopDrag, true)
      window.removeEventListener('auxclick', onAuxClick, true)
    }
  }, [setViewport])

  const openPanelFromNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    if ((event.target as Element | null)?.closest('.nodrag')) return
    closeAllContextMenus()
    setActivePanelNode(node.id)
  }, [closeAllContextMenus, setActivePanelNode])

  const selectGroupFromPaneClick = useCallback((event: React.MouseEvent) => {
    closeAllContextMenus()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return

    const { viewport: vp, nodes: latestNodes } = useCanvasStore.getState()
    const zoom = Number.isFinite(vp.zoom) && vp.zoom > 0 ? vp.zoom : 1
    const flowX = (event.clientX - rect.left - vp.x) / zoom
    const flowY = (event.clientY - rect.top - vp.y) / zoom
    const groupNode = findGroupAtPoint(latestNodes, flowX, flowY)
    if (!groupNode) {
      const state = useCanvasStore.getState()
      state.setActivePanelNode(null)
      state.setSelected([])
      state.setNodes(
        state.nodes.map(node => ({
          ...node,
          selected: false,
        })),
        { persist: false, markDirty: false }
      )
      return
    }

    requestAnimationFrame(() => {
      const state = useCanvasStore.getState()
      state.setActivePanelNode(groupNode.id)
      state.setSelected([groupNode.id])
      state.setNodes(
        state.nodes.map(node => ({
          ...node,
          selected: false,
        })),
        { persist: false, markDirty: false }
      )
    })
  }, [closeAllContextMenus])

  const openCanvasMenu = useCallback((event: React.MouseEvent) => {
    // 同上：浮层里的右键不算画布右键
    if (!isCanvasContextMenuTarget(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const { viewport: vp } = useCanvasStore.getState()
    const flowX = (event.clientX - rect.left - vp.x) / vp.zoom
    const flowY = (event.clientY - rect.top - vp.y) / vp.zoom
    setConnMenu(null)
    setNodeMenu(null)
    setCanvasMenu({
      screenX: event.clientX,
      screenY: event.clientY,
      flowX,
      flowY,
      mode: 'main',
    })
  }, [])

  const resolveDockActionPoint = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const { viewport: vp } = useCanvasStore.getState()
    const canvasLeft = rect?.left ?? 0
    const canvasTop = rect?.top ?? 0
    const canvasWidth = rect?.width ?? window.innerWidth
    const canvasHeight = rect?.height ?? window.innerHeight
    const screenX = canvasLeft + canvasWidth / 2
    const screenY = canvasTop + canvasHeight / 2
    const zoom = Number.isFinite(vp.zoom) && vp.zoom > 0 ? vp.zoom : 1

    return {
      screenX,
      screenY,
      flowX: (screenX - canvasLeft - vp.x) / zoom,
      flowY: (screenY - canvasTop - vp.y) / zoom,
      menuX: screenX - 155,
      menuY: Math.max(16, canvasTop + canvasHeight - 470),
    }
  }, [])

  const openDockNodePicker = useCallback(() => {
    const point = resolveDockActionPoint()
    setConnMenu(null)
    setNodeMenu(null)
    setCanvasMenu({
      screenX: point.menuX,
      screenY: point.menuY,
      flowX: point.flowX,
      flowY: point.flowY,
      mode: 'node-picker',
    })
  }, [resolveDockActionPoint])

  const insertHistoryAsset = useCallback((asset: HistoryAsset) => {
    const point = resolveDockActionPoint()
    const usedAtMs = Date.now()
    addNodeAt(asset.kind, point.flowX, point.flowY, {
      url: [asset.url],
      action: 'image_resource',
      name: asset.name || asset.kind,
      ...(asset.meta ? { _resourceMeta: { items: [asset.meta] } } : {}),
      _assetCreatedAtMs: mergeAssetCreatedAtMap(undefined, [
        asset.url,
        asset.displayUrl,
        asset.meta?.displayUrl,
        asset.meta?.originalUrl,
      ], usedAtMs),
      _updatedAtMs: usedAtMs,
    })
  }, [addNodeAt, resolveDockActionPoint])

  const insertFavoriteItem = useCallback((item: FavoriteLibraryItem) => {
    const point = resolveDockActionPoint()
    void insertFavoritePayload(item.payload, { x: point.flowX, y: point.flowY })
  }, [insertFavoritePayload, resolveDockActionPoint])

  const handleHistoryAssetDragStart = useCallback((asset: HistoryAsset, event: React.DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(SHOTFLOW_HISTORY_ASSET_DRAG_MIME, JSON.stringify(asset))
  }, [])

  const handleFavoriteItemDragStart = useCallback((item: FavoriteLibraryItem, event: React.DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(SHOTFLOW_FAVORITE_ITEM_DRAG_MIME, JSON.stringify(item))
  }, [])

  const hideHistoryAssets = useCallback((assets: HistoryAsset[]) => {
    if (assets.length === 0) return
    let changed = false
    const updatedNodes = nodes.map(node => {
      const matchingAssets = assets.filter(asset => nodeIncludesHistoryAsset(node.data, asset))
      if (matchingAssets.length === 0) return node
      const hiddenUrls = new Set((node.data._hiddenHistoryUrls ?? []).filter((item): item is string => typeof item === 'string'))
      for (const asset of matchingAssets) {
        const hiddenValues = [
          asset.url,
          asset.displayUrl,
          asset.meta?.originalUrl,
          asset.meta?.displayUrl,
        ].filter((item): item is string => typeof item === 'string' && item.length > 0)
        hiddenValues.forEach(url => hiddenUrls.add(url))
      }
      changed = true
      return {
        ...node,
        data: {
          ...node.data,
          _hiddenHistoryUrls: Array.from(hiddenUrls),
          _updatedAtMs: Date.now(),
        },
      }
    })

    if (!changed) return
    pushHistory()
    setNodes(updatedNodes)
  }, [nodes, pushHistory, setNodes])

  const hideHistoryAsset = useCallback((asset: HistoryAsset) => {
    if (!projectUuid) return
    void historyAssetsApi.hide(projectUuid, asset.url).then(() => {
      setPermanentHistoryAssets((items) => items.filter((item) => item.url !== asset.url))
    }).catch((error) => console.error('hide permanent history failed', error))
  }, [projectUuid])

  const toggleDockPanel = useCallback((panel: 'history' | 'shortcuts') => {
    setConnMenu(null)
    setCanvasMenu(null)
    setNodeMenu(null)
    setDockPanel(current => (current === panel ? null : panel))
  }, [])

  // 底部工具条上的资产库 / 共享空间按钮现在开的是左侧停靠栏；再点一次收起，
  // 点另一个库直接换过去（不用先收起）。
  const toggleAssetDock = useCallback((mode: AssetDockMode) => {
    setConnMenu(null)
    setCanvasMenu(null)
    setNodeMenu(null)
    changeAssetDockMode(assetDockMode === mode ? null : mode)
  }, [assetDockMode, changeAssetDockMode])

  const openNodeMenu = useCallback((event: React.MouseEvent, node: Node) => {
    // 节点里 portal 到 body 的全屏浮层（大图查看器、抠像、白板…）里的右键也会冒到这里
    // （React 合成事件走组件树，不走 DOM）。那种右键要留给浏览器 —— 大图上要出
    // 「图片另存为 / 复制图片」，输入框里要出「复制 / 粘贴」。详见 lib/canvasContextMenu.ts。
    if (!isCanvasContextMenuTarget(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const { viewport: vp } = useCanvasStore.getState()
    const flowX = (event.clientX - rect.left - vp.x) / vp.zoom
    const flowY = (event.clientY - rect.top - vp.y) / vp.zoom
    setConnMenu(null)
    setCanvasMenu(null)
    setSelected([node.id])
    setNodeMenu({
      screenX: event.clientX,
      screenY: event.clientY,
      flowX,
      flowY,
      nodeId: node.id,
    })
  }, [setSelected])

  const openNodePicker = useCallback(() => {
    setCanvasMenu(menu => menu ? { ...menu, mode: 'node-picker' } : menu)
  }, [])

  const selectCanvasNode = useCallback((type: string) => {
    if (!canvasMenu) return
    addNodeAt(type, canvasMenu.flowX, canvasMenu.flowY)
    setCanvasMenu(null)
  }, [addNodeAt, canvasMenu])

  const triggerMenuUpload = useCallback(() => {
    const input = fileInputRef.current as FileInputWithPicker | null
    if (!canvasMenu || !input) return
    pendingUploadPositionRef.current = { x: canvasMenu.flowX, y: canvasMenu.flowY }
    input.value = ''

    try {
      if (typeof input.showPicker === 'function') input.showPicker()
      else input.click()
    } catch (pickerError) {
      try {
        input.click()
      } catch (clickError) {
        pendingUploadPositionRef.current = null
        console.error('Open upload picker failed', { pickerError, clickError })
        window.alert('无法打开文件选择器，请尝试将文件直接拖入画布上传。')
      }
    }

    setCanvasMenu(null)
  }, [canvasMenu])

  const handleMenuFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    const position = pendingUploadPositionRef.current
    pendingUploadPositionRef.current = null
    if (!position || files.length === 0) return
    await uploadFilesAt(files, position.x, position.y)
  }, [uploadFilesAt])

  const handleContextUndo = useCallback(() => {
    undo()
    setCanvasMenu(null)
  }, [undo])

  const handleContextPaste = useCallback(() => {
    if (!canvasMenu) return
    pasteClipboard({ x: canvasMenu.flowX, y: canvasMenu.flowY })
    setCanvasMenu(null)
  }, [canvasMenu, pasteClipboard])

  const nodeMenuNode = useMemo(
    () => nodeMenu ? nodes.find(n => n.id === nodeMenu.nodeId || n.data.nodeKey === nodeMenu.nodeId) : undefined,
    [nodeMenu, nodes]
  )

  const handleNodeCopy = useCallback(() => {
    if (!nodeMenu) return
    useCanvasStore.getState().setSelected([nodeMenu.nodeId])
    useCanvasStore.getState().copySelected()
    void writeClipboardText(SHOTFLOW_NODE_CLIPBOARD_TEXT)
    setNodeMenu(null)
  }, [nodeMenu])

  const handleNodeDuplicate = useCallback(() => {
    if (!nodeMenu) return
    duplicateNodes([nodeMenu.nodeId])
    setNodeMenu(null)
  }, [duplicateNodes, nodeMenu])

  const handleNodePaste = useCallback(() => {
    if (!nodeMenu) return
    pasteClipboard({ x: nodeMenu.flowX, y: nodeMenu.flowY })
    setNodeMenu(null)
  }, [nodeMenu, pasteClipboard])

  const handleNodeDelete = useCallback(() => {
    if (!nodeMenu) return
    deleteNodes([nodeMenu.nodeId])
    setNodeMenu(null)
  }, [deleteNodes, nodeMenu])

  const handleNodeDeleteGroupWithChildren = useCallback(() => {
    if (!nodeMenu) return
    deleteGroupWithChildren(nodeMenu.nodeId)
    setNodeMenu(null)
  }, [deleteGroupWithChildren, nodeMenu])

  const handleNodeCopyCoverMedia = useCallback(async () => {
    const url = nodeMenuNode?.data.url?.[0]
    if (!url) return
    const mediaKind = primaryMediaKindFromNodeData(nodeMenuNode?.data)
    if (mediaKind === 'image') await writeImageUrlToClipboard(url)
    else await writeClipboardText(url)
    setNodeMenu(null)
  }, [nodeMenuNode])

  const handleNodeCopyToClipboard = useCallback(async () => {
    if (!nodeMenuNode) return
    const data = nodeMenuNode.data
    await writeClipboardText(JSON.stringify({
      type: data.type,
      name: data.name,
      url: data.url,
      params: data.params,
    }, null, 2))
    setNodeMenu(null)
  }, [nodeMenuNode])

  const handleNodePanoramaPreview = useCallback(() => {
    const url = nodeMenuNode?.data.url?.[0]
    if (!url || !isPanoramaNodeData(nodeMenuNode.data)) return
    setPanoramaPreview({ url, name: nodeMenuNode.data.name || 'HDR全景' })
    setNodeMenu(null)
  }, [nodeMenuNode])

  const noopNodeMenuAction = useCallback(() => {}, [])

  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => {
    setViewport(vp)
  }, [setViewport])

  const applyCanvasZoomPercent = useCallback((percent: number) => {
    const nextZoom = clampValue(percent / 100, 0.05, 4)
    const rect = canvasRef.current?.getBoundingClientRect()
    const currentViewport = useCanvasStore.getState().viewport
    const currentZoom = Math.max(0.05, Number(currentViewport.zoom) || 1)
    const centerX = (rect?.width ?? window.innerWidth) / 2
    const centerY = (rect?.height ?? window.innerHeight) / 2
    const flowCenterX = (centerX - currentViewport.x) / currentZoom
    const flowCenterY = (centerY - currentViewport.y) / currentZoom
    const nextViewport = {
      x: centerX - flowCenterX * nextZoom,
      y: centerY - flowCenterY * nextZoom,
      zoom: nextZoom,
    }
    setViewport(nextViewport)
    reactFlowInstanceRef.current?.setViewport(nextViewport, { duration: 90 })
  }, [setViewport])

  const onSelectionChange = useCallback((selection: { nodes: { id: string }[]; edges?: { id: string }[] }) => {
    const selectedNodeIds = selection.nodes.map(node => node.id)
    if (selectedNodeIds.length !== 1) setActivePanelNode(null)
    setSelected(selectedNodeIds)
  }, [setActivePanelNode, setSelected])

  const extendSelectionByTitleHits = useCallback((event: React.MouseEvent | React.PointerEvent) => {
    const start = selectionPointerStartRef.current
    const fallbackEnd = selectionPointerCurrentRef.current
    const end = {
      x: Number.isFinite(event.clientX) ? event.clientX : fallbackEnd?.x ?? start?.x ?? 0,
      y: Number.isFinite(event.clientY) ? event.clientY : fallbackEnd?.y ?? start?.y ?? 0,
    }
    selectionPointerStartRef.current = null
    selectionDragActiveRef.current = false
    if (!start) return

    const selectionRect = {
      left: Math.min(start.x, end.x),
      top: Math.min(start.y, end.y),
      right: Math.max(start.x, end.x),
      bottom: Math.max(start.y, end.y),
    }
    if (selectionRect.right - selectionRect.left < 2 || selectionRect.bottom - selectionRect.top < 2) return

    const canvasRect = canvasRef.current?.getBoundingClientRect()
    if (!canvasRect) return

    const state = useCanvasStore.getState()
    const titleHitIds = state.nodes
      .filter(node => node.type !== 'group')
      .filter(node => typeof node.data.name === 'string' && node.data.name.trim())
      .filter(node => rectsIntersect(selectionRect, nodeTitleScreenRect(node, state.viewport, canvasRect)))
      .map(node => node.id)
    const edgeHitIds = edgeIdsIntersectingSelectionRect(
      state.edges,
      state.nodes,
      state.viewport,
      canvasRect,
      selectionRect
    )

    if (titleHitIds.length === 0 && edgeHitIds.length === 0) return

    const selectedIds = new Set<string>([
      ...state.selectedNodeKeys,
      ...state.nodes.filter(node => node.selected).map(node => node.id),
    ])
    for (const id of titleHitIds) selectedIds.add(id)
    const selectedEdgeIds = new Set<string>([
      ...state.edges.filter(edge => edge.selected).map(edge => edge.id),
      ...edgeHitIds,
    ])

    const nextSelectedIds = [...selectedIds]
    state.setSelected(nextSelectedIds)
    if (titleHitIds.length > 0) {
      state.setNodes(
        state.nodes.map(node => ({
          ...node,
          selected: selectedIds.has(node.id),
        })),
        { persist: false, markDirty: false }
      )
    }
    state.setEdges(
      state.edges.map(edge => ({
        ...edge,
        selected: selectedEdgeIds.has(edge.id),
      }))
    )
  }, [])

  const defaultViewport = useMemo(() => viewport, [])
  const flowActiveEdgeIds = useMemo(
    () => collectFlowEdgeIds(edges, selectedNodeKeys),
    [edges, selectedNodeKeys]
  )
  const selectedEdgeCount = useMemo(
    () => edges.reduce((count, edge) => count + (edge.selected ? 1 : 0), 0),
    [edges]
  )
  const renderedEdges = useMemo(
    () =>
      edges.map(edge => ({
        ...edge,
        data: {
          ...((edge.data && typeof edge.data === 'object') ? edge.data as Record<string, unknown> : {}),
          isFlowActive: flowActiveEdgeIds.has(edge.id) || Boolean(edge.selected),
          selectedEdgeCount,
        },
      })),
    [edges, flowActiveEdgeIds, selectedEdgeCount]
  )
  const multiSelectToolbarPosition = useMemo(() => {
    if (selectedNodeKeys.length < 2) return null
    const canvasRect = canvasRef.current?.getBoundingClientRect()
    if (!canvasRect) return null
    const selectedNodes = collectGroupingTargets(nodes, selectedNodeKeys)
    const bounds = getSelectionFrameBounds(selectedNodes, viewport.zoom)
    if (!bounds) return null

    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
    const left = canvasRect.left + (bounds.x + bounds.width / 2) * zoom + viewport.x
    const top = canvasRect.top + bounds.y * zoom + viewport.y - 12
    return {
      left,
      top: Math.max(8, top),
    }
  }, [nodes, selectedNodeKeys, viewport.x, viewport.y, viewport.zoom])

  const multiSelectionFrame = useMemo(() => {
    if (selectedNodeKeys.length < 2) return null
    const selectedNodes = collectGroupingTargets(nodes, selectedNodeKeys)
    if (selectedNodes.length < 2) return null
    const bounds = getSelectionFrameBounds(selectedNodes, viewport.zoom)
    if (!bounds) return null

    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
    return {
      left: bounds.x * zoom + viewport.x,
      top: bounds.y * zoom + viewport.y,
      width: bounds.width * zoom,
      height: bounds.height * zoom,
    }
  }, [nodes, selectedNodeKeys, viewport.x, viewport.y, viewport.zoom])
  return (
    // 左边是资产库停靠栏，右边才是画布本体。canvasRef 必须留在画布本体上：
    // 十几处 getBoundingClientRect 都拿它做屏幕坐标→画布坐标的换算，
    // 套在外层的话停靠栏一展开，所有换算就整体偏掉一个停靠栏的宽度。
    <div className="shotflow-canvas-layout">
      <CanvasAssetDock
        mode={assetDockMode}
        lastMode={lastAssetDockMode}
        onModeChange={changeAssetDockMode}
        onInsert={insertFavoriteItem}
        onDragStart={handleFavoriteItemDragStart}
      />
      <div
        ref={canvasRef}
        className={`shotflow-canvas-root w-full h-full${isMobileCanvas ? ' is-mobile-canvas' : ''}${isLowDetailRender ? ' is-low-detail-render' : ''}`}
        style={canvasRootStyle}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onMouseDown={(event) => trackPointerPosition(event.clientX, event.clientY)}
        onMouseEnter={(event) => trackPointerPosition(event.clientX, event.clientY)}
        onMouseMove={(event) => trackPointerPosition(event.clientX, event.clientY)}
      >
        <input
          ref={fileInputRef}
          className="canvas-menu-file-input"
          type="file"
          accept="image/*,video/*,audio/*,.md,text/markdown"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={handleMenuFileChange}
        />
        <ReactFlow
          nodes={renderNodes as Node[]}
          edges={renderedEdges}
          onInit={(instance) => {
            reactFlowInstanceRef.current = instance
            setIsFlowReady(true)
          }}
          nodeTypes={nodeTypes as never}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={openPanelFromNodeClick}
          onConnectStart={onConnectStart as never}
          onConnectEnd={onConnectEnd as never}
          onNodeContextMenu={openNodeMenu}
          onPaneClick={selectGroupFromPaneClick}
          onPaneContextMenu={openCanvasMenu}
          onMoveStart={closeAllContextMenus}
          onMove={onMoveEnd}
          onMoveEnd={onMoveEnd}
          onSelectionChange={onSelectionChange}
          onSelectionEnd={extendSelectionByTitleHits}
          defaultViewport={defaultViewport}
          minZoom={0.05}
          maxZoom={4}
          deleteKeyCode={['Delete', 'Backspace']}
          connectionRadius={isMobileCanvas ? 72 : 54}
          fitView={nodes.length === 0}
          colorMode="dark"
          multiSelectionKeyCode="Shift"
          selectionOnDrag={!isMobileCanvas}
          panOnDrag={isMobileCanvas ? true : [1, 2]}
          panOnScroll={!isMobileCanvas}
          zoomOnPinch
          selectionMode={SelectionMode.Partial}
        >
          <Background
            id="canvas-grid-minor"
            variant={BackgroundVariant.Lines}
            gap={20}
            lineWidth={0.7}
            color="rgba(255,255,255,0.12)"
            bgColor="transparent"
            patternClassName="canvas-grid-minor"
          />
          <Background
            id="canvas-grid-major"
            variant={BackgroundVariant.Lines}
            gap={100}
            lineWidth={1}
            color="rgba(255,255,255,0.08)"
            patternClassName="canvas-grid-major"
          />
          <MiniMap
            className="shotflow-canvas-minimap"
            position="bottom-left"
            pannable
            zoomable
            nodeColor={miniMapNodeColor}
            nodeStrokeColor={miniMapNodeStrokeColor}
            nodeStrokeWidth={0.65}
            nodeBorderRadius={2}
            maskColor="rgba(0, 0, 0, 0.08)"
            maskStrokeColor="rgba(255, 255, 255, 0.62)"
            maskStrokeWidth={0.7}
            bgColor="transparent"
            offsetScale={4}
            ariaLabel="画布小地图"
            style={{ width: CANVAS_MINIMAP_WIDTH, height: CANVAS_MINIMAP_HEIGHT }}
          />
        </ReactFlow>

        <CanvasDetailZoomControl
          zoomPercent={canvasZoomPercent}
          detailActive={!isLowDetailRender}
          thresholdPercent={Math.round(CANVAS_DETAIL_RENDER_ZOOM_THRESHOLD * 100)}
          onZoomPercentChange={applyCanvasZoomPercent}
          onZoomOut={() => applyCanvasZoomPercent(canvasZoomPercent / 1.2)}
          onZoomIn={() => applyCanvasZoomPercent(canvasZoomPercent * 1.2)}
          onFitView={() => showCanvasOverview()}
          onOpenTemplateLibrary={() => setTemplateLibraryOpen(true)}
        />

        <CindyModeSelector />

        <CindyAssistantPanel
          projectUuid={projectUuid}
          canvasContext={cindyCanvasContext}
          onApplyProposal={applyCindyProposal}
        />

        {multiSelectionFrame && (
          <>
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: multiSelectionFrame.left,
                top: multiSelectionFrame.top,
                width: multiSelectionFrame.width,
                height: multiSelectionFrame.height,
                zIndex: 11,
                pointerEvents: 'none',
                border: '1px solid rgba(255, 255, 238, 0.62)',
                borderRadius: 10,
                boxShadow: [
                  '0 0 0 1px rgba(255,255,238,0.18)',
                  '0 0 14px rgba(255,250,218,0.42)',
                  '0 0 28px rgba(255,236,156,0.2)',
                ].join(', '),
                background: 'rgba(255,255,255,0.015)',
              }}
            />
            <button
              type="button"
              className={`multi-selection-batch-port nodrag nopan${isMultiConnectDragging ? ' is-dragging' : ''}`}
              title="批量连接到输入接口"
              aria-label="批量连接到输入接口"
              style={{
                left: multiSelectionFrame.left + multiSelectionFrame.width + 10,
                top: multiSelectionFrame.top + multiSelectionFrame.height / 2,
              }}
              onPointerDown={startMultiSelectionConnectDrag}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
            >
              <span>+</span>
            </button>
          </>
        )}

        {multiConnectDrag && (
          <svg className="multi-selection-connection-preview" aria-hidden="true">
            <path
              d={`M ${multiConnectDrag.startX} ${multiConnectDrag.startY} C ${multiConnectDrag.startX + 110} ${multiConnectDrag.startY}, ${multiConnectDrag.currentX - 110} ${multiConnectDrag.currentY}, ${multiConnectDrag.currentX} ${multiConnectDrag.currentY}`}
            />
          </svg>
        )}

        <div
          className="nodrag nopan canvas-text-scale-panel"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="canvas-text-scale-label">文字</span>
          <input
            type="range"
            min={70}
            max={180}
            step={5}
            value={canvasTextScalePercent}
            title="调整画布内文字大小"
            aria-label="调整画布内文字大小"
            onChange={(event) => setCanvasTextScale(Number(event.currentTarget.value) / 100)}
          />
          <span className="canvas-text-scale-value">
            {canvasTextScalePercent}%
          </span>
        </div>

        <div
          className="canvas-bottom-dock-wrap nodrag nopan"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {dockPanel === 'history' && (
            <HistoryAssetsPanel
              assets={historyAssets}
              onClose={() => setDockPanel(null)}
              onInsert={insertHistoryAsset}
              onDelete={hideHistoryAsset}
              onDragStart={handleHistoryAssetDragStart}
            />
          )}
          {dockPanel === 'shortcuts' && <ShortcutsPanel onClose={() => setDockPanel(null)} />}
          <BottomDock
            dockPanel={assetDockMode ?? dockPanel}
            onAddNode={openDockNodePicker}
            onToggleHistory={() => toggleDockPanel('history')}
            onToggleShortcuts={() => toggleDockPanel('shortcuts')}
            onToggleAssets={() => toggleAssetDock('assets')}
            onToggleShared={() => toggleAssetDock('shared')}
          />
        </div>

        <MultiSelectToolbar selectedIds={selectedNodeKeys} position={multiSelectToolbarPosition} />

        {connMenu && (
          <ConnectionMenu
            screenX={connMenu.screenX}
            screenY={connMenu.screenY}
            onSelect={handleMenuSelect}
            onClose={() => setConnMenu(null)}
          />
        )}

        {multiConnMenu && (
          <ConnectionMenu
            screenX={multiConnMenu.screenX}
            screenY={multiConnMenu.screenY}
            onSelect={handleMultiMenuSelect}
            onClose={() => setMultiConnMenu(null)}
          />
        )}

        {canvasMenu && (
          <CanvasContextMenu
            menu={canvasMenu}
            canUndo={historyIndex > 0}
            canPaste={Boolean(clipboard?.nodes.length)}
            onUpload={triggerMenuUpload}
            onOpenNodePicker={openNodePicker}
            onSelectNode={selectCanvasNode}
            onUndo={handleContextUndo}
            onPaste={handleContextPaste}
            onClose={closeCanvasMenu}
          />
        )}

        {panoramaPreview && (
          <PanoramaViewerModal
            url={panoramaPreview.url}
            name={panoramaPreview.name}
            onClose={() => setPanoramaPreview(null)}
          />
        )}

        {templateLibraryOpen && (
          <OfficialTemplateLibrary onClose={() => setTemplateLibraryOpen(false)} />
        )}

        {nodeMenu && (
          <NodeContextMenu
            menu={nodeMenu}
            node={nodeMenuNode}
            canPaste={Boolean(clipboard?.nodes.length)}
            onComplianceCheck={noopNodeMenuAction}
            onSaveAsset={noopNodeMenuAction}
            onPanoramaPreview={handleNodePanoramaPreview}
            onCreateSubject={noopNodeMenuAction}
            onCopyNode={handleNodeCopy}
            onCopyMedia={handleNodeCopyCoverMedia}
            onDuplicate={handleNodeDuplicate}
            onPaste={handleNodePaste}
            onDelete={handleNodeDelete}
            onDeleteGroupWithChildren={handleNodeDeleteGroupWithChildren}
            onCopyToClipboard={handleNodeCopyToClipboard}
            onClose={closeNodeMenu}
          />
        )}
      </div>
    </div>
  )
}
