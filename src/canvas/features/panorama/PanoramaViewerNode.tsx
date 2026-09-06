import { useCallback, useMemo, useState } from 'react'
import { addEdge, Handle, Position } from '@xyflow/react'
import { Download, Expand, Grid3X3, Image, Minus, Plus, RotateCcw, View } from 'lucide-react'
import { useCanvasStore } from '@/store/canvasStore'
import { assetsApi } from '@/lib/api'
import { defaultImageParams } from '@/lib/nodeData'
import { resourceMetaFromUploadPayload } from '@/lib/whiteboard'
import type { CanvasNodeData } from '@/lib/types'
import { isPanoramaNodeData } from './panorama'
import {
  DEFAULT_PANORAMA_EXPOSURE,
  DEFAULT_PANORAMA_VIEW,
  PanoramaViewport,
  clampPanoramaExposure,
  type PanoramaCaptureResult,
  type PanoramaView,
} from './PanoramaViewport'
import { PanoramaViewerModal } from './PanoramaViewerModal'
import type { PanoramaCaptureRatio, PanoramaCaptureResolution } from './panorama-capture'
import './panorama-viewer.css'
import './panorama-viewer-node.css'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

interface PanoramaNodeRef {
  nodeId?: string
  url?: string
  name?: string
}

export function resolvePanoramaViewerSource(
  ref: PanoramaNodeRef | null | undefined,
  nodes: Array<{ id: string; data: CanvasNodeData & { nodeKey?: string } }>,
) {
  if (!ref) return { url: '', name: '', loading: false, error: '', validPanorama: false }
  const upstream = ref.nodeId
    ? nodes.find((node) => node.id === ref.nodeId || node.data.nodeKey === ref.nodeId)
    : undefined
  const upstreamUrl = upstream?.data._primaryAssetUrl || upstream?.data.url?.[0] || ''
  const taskInfo = upstream?.data.taskInfo
  return {
    url: upstreamUrl || ref.url || '',
    name: String(upstream?.data.name || ref.name || 'HDR全景'),
    loading: Boolean(taskInfo?.loading),
    error: String(taskInfo?.error || ''),
    validPanorama: upstream ? isPanoramaNodeData(upstream.data) : Boolean(ref.url),
  }
}

const NODE_WIDTH = 500

function nextExposure(current: number, delta: number) {
  return clampPanoramaExposure(Math.round((current + delta) * 100) / 100)
}

export function PanoramaViewerNode({ id, data, selected }: Props) {
  const { nodes, edges, addNodeAt, setEdges, updateNodeData } = useCanvasStore()
  const params = (data.params ?? {}) as Record<string, unknown>
  const panoramaRef = (params.panoramaRef ?? null) as PanoramaNodeRef | null
  const source = useMemo(
    () => resolvePanoramaViewerSource(panoramaRef, nodes),
    [nodes, panoramaRef],
  )
  const [view, setView] = useState<PanoramaView>({ ...DEFAULT_PANORAMA_VIEW })
  const [exposure, setExposure] = useState(DEFAULT_PANORAMA_EXPOSURE)
  const [flat, setFlat] = useState(false)
  const [grid, setGrid] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  const download = useCallback(() => {
    if (!source.url) return
    const anchor = document.createElement('a')
    anchor.href = source.url
    anchor.download = `${source.name || 'HDR全景'}.jpg`
    anchor.click()
  }, [source.name, source.url])

  const captureViewpoint = useCallback(async (result: PanoramaCaptureResult & {
    file: File
    ratio: PanoramaCaptureRatio
    resolution: PanoramaCaptureResolution
  }) => {
    const uploaded = await assetsApi.upload(data.projectUuid, result.file)
    const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
    const viewerNode = nodes.find((node) => node.id === id || node.data.nodeKey === id)
    const outgoingCount = edges.filter((edge) => edge.source === id).length
    const existingCaptureUrls = Array.isArray(viewerNode?.data.url) ? viewerNode.data.url : []
    const createdAtMs = Date.now()
    const baseImageParams = defaultImageParams()
    const viewerOutputRef = {
      nodeId: id,
      url: uploaded.url,
      mediaType: 'image' as const,
    }
    const captureNode = addNodeAt(
      'image',
      (viewerNode?.position.x ?? 0) + NODE_WIDTH + 140,
      (viewerNode?.position.y ?? 0) + outgoingCount * 44,
      {
        name: result.file.name.replace(/\.png$/i, ''),
        url: [uploaded.url],
        action: 'image_resource',
        sourceKind: 'derived',
        generatorType: 'panorama-viewpoint-capture',
        ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
        _primaryAssetUrl: uploaded.url,
        _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
        _updatedAtMs: createdAtMs,
        params: {
          ...baseImageParams,
          prompt: '',
          modeType: 'image2image',
          imageList: [viewerOutputRef],
          imageListOrder: [id],
          mixedList: [viewerOutputRef],
          mixedListOrder: [id],
          settings: {
            ...baseImageParams.settings,
            ratio: result.ratio === 'source' ? `${result.width}:${result.height}` : result.ratio,
            resolution: result.resolution,
          },
          advancedSettings: {
            panoramaCapture: {
              version: 1,
              panoramaNodeId: panoramaRef?.nodeId || '',
              panoramaUrl: source.url,
              viewerNodeId: id,
              yaw: result.view.yaw,
              pitch: result.view.pitch,
              fov: result.view.fov,
              exposure: result.exposure,
              aspectRatio: result.ratio,
              resolution: result.resolution,
              width: result.width,
              height: result.height,
              createdAtMs,
            },
          },
        } as unknown as Record<string, unknown>,
      },
    )
    updateNodeData(id, {
      url: [uploaded.url, ...existingCaptureUrls.filter((url) => url !== uploaded.url)],
      _primaryAssetUrl: uploaded.url,
      _updatedAtMs: createdAtMs,
    })
    const edgeId = `e-${id}-${captureNode.id}-panorama-capture`
    if (!edges.some((edge) => edge.id === edgeId)) {
      setEdges(addEdge({
        id: edgeId,
        source: id,
        sourceHandle: 'capture',
        target: captureNode.id,
        type: 'glow',
        selectable: true,
        interactionWidth: 34,
      }, edges))
    }
  }, [addNodeAt, data.projectUuid, edges, id, nodes, panoramaRef?.nodeId, setEdges, source.url, updateNodeData])

  const stateMessage = source.error
    ? `上游生成失败：${source.error}`
    : source.loading && !source.url
      ? 'HDR 全景生成中…'
      : panoramaRef && !source.validPanorama
        ? '输入不是已验证的 2:1 HDR 全景图'
        : '连接 HDR 全景图片节点的输出'

  return (
    <div className={`panorama-node${selected ? ' is-selected' : ''}`} style={{ width: NODE_WIDTH }}>
      <Handle id="panorama" type="target" position={Position.Left} className="panorama-node-handle" />
      <Handle id="capture" type="source" position={Position.Right} className="panorama-node-handle panorama-node-output-handle" />
      <header className="panorama-node-header">
        <div>
          <View size={15} strokeWidth={1.9} />
          <strong>360°查看器</strong>
          <span>ERP · 2:1</span>
        </div>
        <div className="panorama-node-actions nodrag">
          <button type="button" className={flat ? 'is-active' : ''} disabled={!source.url} onClick={() => setFlat((current) => !current)} title={flat ? '返回球面查看' : '查看2:1平铺原图'}><Image size={14} /></button>
          <button type="button" className={grid ? 'is-active' : ''} disabled={!source.url || flat} onClick={() => setGrid((current) => !current)} title="参考网格"><Grid3X3 size={14} /></button>
          <button type="button" disabled={!source.url} onClick={() => setView({ ...DEFAULT_PANORAMA_VIEW })} title="重置视角"><RotateCcw size={14} /></button>
          <button type="button" disabled={!source.url} onClick={download} title="下载全景原图"><Download size={14} /></button>
          <button type="button" disabled={!source.url} onClick={() => setFullscreen(true)} title="全屏查看"><Expand size={14} /></button>
        </div>
      </header>
      <PanoramaViewport
        url={source.validPanorama ? source.url : ''}
        view={view}
        exposure={exposure}
        flat={flat}
        grid={grid}
        onViewChange={setView}
        className="panorama-node-viewport nodrag"
        help="拖拽环视 · 滚轮缩放"
        emptyMessage={stateMessage}
      />
      <footer className="panorama-node-footer">
        <span>{source.name || '等待全景输入'}</span>
        <div className="panorama-node-exposure nodrag">
          <button type="button" disabled={!source.url} onClick={() => setExposure(nextExposure(exposure, -0.1))} title="降低显示亮度"><Minus size={12} /></button>
          <b>{Math.round(exposure * 100)}%</b>
          <button type="button" disabled={!source.url} onClick={() => setExposure(nextExposure(exposure, 0.1))} title="提高显示亮度"><Plus size={12} /></button>
        </div>
        <b>Y {Math.round(view.yaw)}° · P {Math.round(view.pitch)}° · FOV {Math.round(view.fov)}°</b>
      </footer>
      {fullscreen && source.url && (
        <PanoramaViewerModal
          url={source.url}
          name={source.name}
          initialView={view}
          initialExposure={exposure}
          onViewChange={setView}
          onExposureChange={setExposure}
          onCapture={captureViewpoint}
          onClose={() => setFullscreen(false)}
        />
      )}
    </div>
  )
}
