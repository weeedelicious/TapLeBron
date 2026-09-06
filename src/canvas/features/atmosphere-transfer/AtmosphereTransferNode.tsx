import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Maximize2, Palette } from 'lucide-react'
import { useCanvasStore } from '@/store/canvasStore'
import { primaryOutputUrl } from '@/lib/primaryOutput'
import type { CanvasNodeData, NodeRef } from '@/lib/types'
import { useAtmosphereTransfer } from './useAtmosphereTransfer'
import { DEFAULT_APPEARANCE_TRANSFER_STATE, type AppearanceTransferState } from './appearance-transfer-types'
import './atmosphere-transfer.css'
import './atmosphere-node.css'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

// The persisted subset of AppearanceTransferState — only the user-facing controls.
// Analysis / candidates / generation are ephemeral (recomputed), so we never write
// them into node params (keeps the canvas payload small — see the OOM history).
type AtControls = Pick<
  AppearanceTransferState,
  | 'colorEnabled' | 'lightingEnabled' | 'lightingMode' | 'backgroundTransferMethod'
  | 'referencePersonAction' | 'poseReplacementMode' | 'removeGraphicOverlays'
  | 'colorStrength' | 'luminanceMatch' | 'temperature' | 'saturation' | 'preserveSkin'
  | 'backendId' | 'resolution'
>

function pickAtControls(s: AppearanceTransferState): AtControls {
  return {
    colorEnabled: s.colorEnabled,
    lightingEnabled: s.lightingEnabled,
    lightingMode: s.lightingMode,
    backgroundTransferMethod: s.backgroundTransferMethod,
    referencePersonAction: s.referencePersonAction,
    poseReplacementMode: s.poseReplacementMode,
    removeGraphicOverlays: s.removeGraphicOverlays,
    colorStrength: s.colorStrength,
    luminanceMatch: s.luminanceMatch,
    temperature: s.temperature,
    saturation: s.saturation,
    preserveSkin: s.preserveSkin,
    backendId: s.backendId,
    resolution: s.resolution,
  }
}

const NODE_WIDTH = 360

export function AtmosphereTransferNode({ id, data, selected }: Props) {
  const nodes = useCanvasStore((s) => s.nodes)
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const params = (data.params ?? {}) as Record<string, unknown>

  // Resolve a connected input's live URL by nodeId (falls back to the stored url so
  // a deleted/renamed upstream node doesn't blank the input).
  const resolveRefUrl = useCallback((ref: { nodeId?: string; url?: string } | null | undefined): string => {
    if (!ref) return ''
    if (ref.nodeId) {
      // 跟着上游当前的主图（useAtmosphereTransfer 提交时也是这么取的），不是 url[0]。
      const live = primaryOutputUrl(
        nodes.find((n) => n.id === ref.nodeId || n.data?.nodeKey === ref.nodeId)?.data as
          | CanvasNodeData
          | undefined,
      )
      if (live) return live
    }
    return ref.url || ''
  }, [nodes])

  const sourceRef = (params.sourceRef ?? null) as { nodeId?: string; url?: string; name?: string } | null
  const referenceRef = (params.referenceRef ?? null) as { nodeId?: string; url?: string; name?: string } | null
  const sourceUrl = resolveRefUrl(sourceRef)
  const referenceUrl = resolveRefUrl(referenceRef)
  const referenceName = referenceRef?.name || '参考图'
  const sourceName = sourceRef?.name || data.name || '原图'

  const initialState = useMemo<AppearanceTransferState>(() => {
    const stored = (params.atState ?? null) as Partial<AppearanceTransferState> | null
    return stored ? { ...DEFAULT_APPEARANCE_TRANSFER_STATE, ...stored } : { ...DEFAULT_APPEARANCE_TRANSFER_STATE }
    // Only seed once from the persisted controls; live edits flow through the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const presetReference = useMemo(
    () => (referenceUrl ? { url: referenceUrl, name: referenceName, nodeId: referenceRef?.nodeId } : null),
    [referenceUrl, referenceName, referenceRef?.nodeId],
  )

  const atmosphere = useAtmosphereTransfer({
    id,
    data,
    sourceUrl,
    sourceName,
    shellWidth: NODE_WIDTH,
    presetReference,
    initialState,
  })
  const { atState, setAtState, openEditor, submitting } = atmosphere

  // Persist only the control subset back to params, and only when it actually
  // changes, to avoid autosave churn and payload bloat.
  const lastPersistedRef = useRef<string>(JSON.stringify(pickAtControls(initialState)))
  useEffect(() => {
    const controls = pickAtControls(atState)
    const key = JSON.stringify(controls)
    if (key === lastPersistedRef.current) return
    lastPersistedRef.current = key
    const cur = (useCanvasStore.getState().nodes.find((n) => n.id === id)?.data.params ?? {}) as Record<string, unknown>
    updateNodeData(id, { params: { ...cur, atState: controls } })
  }, [atState, id, updateNodeData])

  const toggleColor = useCallback(() => setAtState((s) => ({ ...s, colorEnabled: !s.colorEnabled })), [setAtState])
  const toggleLighting = useCallback(() => setAtState((s) => ({ ...s, lightingEnabled: !s.lightingEnabled })), [setAtState])

  const canOpen = Boolean(sourceUrl) && !submitting
  const statusText = !sourceUrl
    ? '连接原图'
    : !referenceUrl
      ? '连接参考图作为氛围来源'
      : submitting
        ? '生成中…'
        : '路线 A 可生成'
  const lightingText = atState.lightingMode === 'replace-background' ? '换背景' : '原场景'

  return (
    <div
      className={`atmo-node${selected ? ' is-selected' : ''}`}
      style={{ width: NODE_WIDTH }}
    >
      {/* 原图 input (top) */}
      <Handle
        id="source"
        type="target"
        position={Position.Left}
        className="atmo-node-handle"
        style={{ top: 92 }}
      />
      {/* 参考图 input (below) */}
      <Handle
        id="reference"
        type="target"
        position={Position.Left}
        className="atmo-node-handle atmo-node-handle-ref"
        style={{ top: 150 }}
      />
      {/* output (default source handle — derived result edges attach here) */}
      <Handle type="source" position={Position.Right} className="atmo-node-handle" style={{ top: 92 }} />

      <div className="atmo-node-head">
        <Palette size={14} strokeWidth={1.9} />
        <span className="atmo-node-title">色彩与灯光氛围迁移</span>
        <span className="atmo-node-badge">实时</span>
        <button
          type="button"
          className="atmo-node-expand nodrag"
          title="展开编辑器"
          disabled={!canOpen}
          onClick={openEditor}
        >
          <Maximize2 size={13} strokeWidth={2} />
        </button>
      </div>

      <div className="atmo-node-thumbs">
        <div className="atmo-node-thumb">
          {sourceUrl ? <img src={sourceUrl} alt="原图" draggable={false} /> : <div className="atmo-node-thumb-empty">原图</div>}
          <span className="atmo-node-thumb-tag">原图</span>
        </div>
        <div className="atmo-node-thumb">
          {referenceUrl ? <img src={referenceUrl} alt="参考图" draggable={false} /> : <div className="atmo-node-thumb-empty">参考图</div>}
          <span className="atmo-node-thumb-tag">参考图</span>
        </div>
      </div>

      <div className="atmo-node-toggles">
        <button
          type="button"
          className={`atmo-node-toggle nodrag${atState.colorEnabled ? ' is-on' : ''}`}
          onClick={toggleColor}
        >色彩{atState.colorEnabled ? '开启' : '关闭'}</button>
        <button
          type="button"
          className={`atmo-node-toggle nodrag${atState.lightingEnabled ? ' is-on' : ''}`}
          onClick={toggleLighting}
        >灯光{atState.lightingEnabled ? '开启' : '关闭'}</button>
      </div>

      <div className="atmo-node-readouts">
        <span>色彩</span><b>{atState.colorStrength}</b>
        <span className="atmo-node-readout-sep">灯光</span><b>{lightingText}</b>
      </div>

      <div className="atmo-node-foot">
        <span className="atmo-node-model">Nano Banana Pro</span>
        <button
          type="button"
          className="atmo-node-generate nodrag"
          disabled={!canOpen || !referenceUrl}
          onClick={openEditor}
        >{statusText}</button>
      </div>

      {atmosphere.modal}
    </div>
  )
}
