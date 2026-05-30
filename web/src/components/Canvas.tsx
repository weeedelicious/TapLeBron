import { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection,
  addEdge,
  type Viewport,
  BackgroundVariant,
  SelectionMode,
  type Node,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCanvasStore } from '@/store/canvasStore'
import { ImageNode } from './nodes/ImageNode'
import { VideoNode } from './nodes/VideoNode'
import { TextNode } from './nodes/TextNode'
import { AudioNode } from './nodes/AudioNode'
import { ScriptNode } from './nodes/ScriptNode'
import { VideoMergeNode } from './nodes/VideoMergeNode'
import { UploadNode } from './nodes/UploadNode'
import { DirectorStageNode } from './nodes/DirectorStageNode'
import { GroupNode } from './nodes/GroupNode'
import { MultiSelectToolbar } from './MultiSelectToolbar'
import { assetsApi } from '@/lib/api'
import type { CanvasNodeData, NodeRef } from '@/lib/types'

// ── Glow edge ────────────────────────────────────────────────────────────────
const FLOW_STYLE = `
@keyframes flow {
  from { stroke-dashoffset: 200; }
  to   { stroke-dashoffset: 0; }
}
@keyframes flowGlow {
  from { stroke-dashoffset: 200; }
  to   { stroke-dashoffset: 0; }
}
`

function GlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const filterId = `glow-${id}`
  return (
    <g>
      <defs>
        <style>{FLOW_STYLE}</style>
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
          <feColorMatrix in="blur" type="matrix"
            values="0 0 0 0 0.39  0 0 0 0 0.71  0 0 0 0 1  0 0 0 0.6 0"
            result="glow"
          />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Static base track */}
      <path d={edgePath} fill="none"
        stroke="rgba(80,140,255,0.12)"
        strokeWidth={selected ? 3 : 2}
      />

      {/* Flowing glow layer */}
      <path d={edgePath} fill="none"
        stroke="rgba(100,180,255,0.35)"
        strokeWidth={selected ? 10 : 7}
        strokeDasharray="60 140"
        filter={`url(#${filterId})`}
        style={{ animation: 'flowGlow 1.8s linear infinite' }}
      />

      {/* Flowing bright line */}
      <path d={edgePath} fill="none"
        stroke={selected ? 'rgba(210,230,255,0.98)' : 'rgba(160,210,255,0.9)'}
        strokeWidth={selected ? 2 : 1.5}
        strokeDasharray="60 140"
        strokeLinecap="round"
        style={{ animation: 'flow 1.8s linear infinite' }}
      />
    </g>
  )
}

const edgeTypes = { glow: GlowEdge, default: GlowEdge }

// ── Connection menu ───────────────────────────────────────────────────────────
const CONN_ITEMS = [
  { type: 'text',           icon: '≡',  label: '文本' },
  { type: 'image',          icon: '🖼', label: '图片',   desc: '海报、分镜、角色设计' },
  { type: 'video',          icon: '▶',  label: '视频' },
  { type: 'video_merge',    icon: '✂',  label: '视频合成', badge: 'Beta' },
  { type: 'director_stage', icon: '◈',  label: '导演台',   badge: 'NEW' },
  { type: 'audio',          icon: '♪',  label: '音频' },
  { type: 'script',         icon: '⊞', label: '脚本',    badge: 'Beta' },
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

// ── Node types ────────────────────────────────────────────────────────────────
const nodeTypes = {
  image: ImageNode,
  video: VideoNode,
  text: TextNode,
  audio: AudioNode,
  script: ScriptNode,
  video_merge: VideoMergeNode,
  upload: UploadNode,
  director_stage: DirectorStageNode,
  group: GroupNode,
}

type FlowNode = Node & { data: CanvasNodeData & { nodeKey: string; projectUuid: string } }

export function Canvas() {
  const { nodes, edges, viewport, setNodes, setEdges, setViewport, setSelected, updateNodeData, addNodeAt, selectedNodeKeys, copySelected, pasteClipboard, undo } = useCanvasStore()
  const canvasRef = useRef<HTMLDivElement>(null)
  const [connMenu, setConnMenu] = useState<{ screenX: number; screenY: number; sourceId: string } | null>(null)
  const connStartRef = useRef<{ nodeId: string; handleType: string } | null>(null)
  const didConnectRef = useRef(false)

  // ── Connection logic (shared between onConnect and menu select) ────────────
  const applyConnection = useCallback((source: string, target: string) => {
    const { nodes: ns, edges: es } = useCanvasStore.getState()
    const sourceNode = ns.find(n => n.id === source || n.data.nodeKey === source)
    const targetNode = ns.find(n => n.id === target || n.data.nodeKey === target)
    if (!sourceNode || !targetNode) return

    const sourceData = sourceNode.data as CanvasNodeData
    const targetData = targetNode.data as CanvasNodeData
    const targetParams = (targetData.params ?? {}) as Record<string, unknown>

    const ref: NodeRef = {
      nodeId: source,
      url: sourceData.url?.[0] ?? '',
      mediaType: sourceData.type === 'video' ? 'video' : sourceData.type === 'audio' ? 'audio' : 'image',
    }

    if (sourceData.type === 'video' || sourceData.type === 'video_merge') {
      const existing = (targetParams.videoList ?? []) as NodeRef[]
      if (!existing.find(r => r.nodeId === source)) {
        updateNodeData(target, {
          params: {
            ...targetParams,
            videoList: [...existing, ref],
            mixedList: [...existing, ref],
            mixedListOrder: [...((targetParams.mixedListOrder as string[]) ?? []), source],
          }
        })
      }
    } else if (sourceData.type === 'audio') {
      const existing = (targetParams.audioList ?? []) as NodeRef[]
      if (!existing.find(r => r.nodeId === source))
        updateNodeData(target, { params: { ...targetParams, audioList: [...existing, ref] } })
    } else if (sourceData.type === 'text') {
      const existing = (targetParams.textList ?? []) as NodeRef[]
      if (!existing.find(r => r.nodeId === source))
        updateNodeData(target, { params: { ...targetParams, textList: [...existing, ref] } })
    } else {
      // image / upload → target gets imageList reference
      const existing = (targetParams.imageList ?? []) as NodeRef[]
      if (!existing.find(r => r.nodeId === source)) {
        updateNodeData(target, {
          params: {
            ...targetParams,
            imageList: [...existing, ref],
            imageListOrder: [...((targetParams.imageListOrder as string[]) ?? []), source],
            modeType: 'image2image',
          }
        })
      }
    }

    setEdges(addEdge({ id: `e-${source}-${target}`, source, target, type: 'glow' }, es))
  }, [updateNodeData, setEdges])

  // ── Drag-and-drop local files ──────────────────────────────────────────────
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    const { projectUuid, viewport: vp } = useCanvasStore.getState()
    if (!projectUuid) return

    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/')
    )
    if (!files.length) return

    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const flowX = (e.clientX - rect.left - vp.x) / vp.zoom + i * 30
      const flowY = (e.clientY - rect.top - vp.y) / vp.zoom + i * 30
      try {
        const result = await assetsApi.upload(projectUuid, file)
        const nodeType = file.type.startsWith('video/') ? 'video'
          : file.type.startsWith('audio/') ? 'audio'
          : 'upload'
        addNodeAt(nodeType, flowX, flowY, { url: [result.url], action: 'image_resource', name: file.name })
      } catch (err) {
        console.error('Upload failed', err)
      }
    }
  }, [addNodeAt])

  // ── Paste from clipboard ───────────────────────────────────────────────────
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const { projectUuid, viewport: vp } = useCanvasStore.getState()
      if (!projectUuid) return

      const items = Array.from(e.clipboardData?.items ?? [])
      const imageItem = items.find(item => item.type.startsWith('image/'))
      if (!imageItem) return

      const file = imageItem.getAsFile()
      if (!file) return
      e.preventDefault()

      try {
        const result = await assetsApi.upload(projectUuid, file)
        const x = (-vp.x + window.innerWidth / 2) / vp.zoom
        const y = (-vp.y + window.innerHeight / 2) / vp.zoom
        addNodeAt('upload', x, y, { url: [result.url], action: 'image_resource', name: '粘贴图片' })
      } catch (err) {
        console.error('Paste upload failed', err)
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [addNodeAt])

  // ── Ctrl+C / Ctrl+V / Ctrl+Z ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      // Skip when typing in inputs / textareas / contenteditable
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.target as HTMLElement)?.isContentEditable) return

      const mod = e.ctrlKey || e.metaKey
      if (!mod) return

      if (e.key === 'c') { copySelected(); e.preventDefault() }
      else if (e.key === 'v') { pasteClipboard(); e.preventDefault() }
      else if (e.key === 'z' && !e.shiftKey) { undo(); e.preventDefault() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [copySelected, pasteClipboard, undo])

  // ── React Flow handlers ────────────────────────────────────────────────────
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // When a group node is dragged, also move its children
    const extraChanges: NodeChange[] = []
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        const node = nodes.find(n => n.id === change.id)
        if (node?.type === 'group') {
          const dx = change.position.x - node.position.x
          const dy = change.position.y - node.position.y
          if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
            const childIds = ((node.data.params as Record<string, unknown>)?.childIds as string[]) ?? []
            for (const childId of childIds) {
              const child = nodes.find(n => n.id === childId)
              if (child) {
                extraChanges.push({
                  type: 'position', id: childId, dragging: change.dragging,
                  position: { x: child.position.x + dx, y: child.position.y + dy },
                })
              }
            }
          }
        }
      }
    }
    const updated = applyNodeChanges([...changes, ...extraChanges], nodes as Node[]) as FlowNode[]
    setNodes(updated)
  }, [nodes, setNodes])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(applyEdgeChanges(changes, edges))
  }, [edges, setEdges])

  const onConnect = useCallback((connection: Connection) => {
    didConnectRef.current = true
    const { source, target } = connection
    if (!source || !target) return
    applyConnection(source, target)
  }, [applyConnection])

  const onConnectStart = useCallback((_e: unknown, { nodeId, handleType }: { nodeId?: string | null; handleType?: string | null }) => {
    connStartRef.current = { nodeId: nodeId ?? '', handleType: handleType ?? '' }
    didConnectRef.current = false
  }, [])

  const onConnectEnd = useCallback((e: MouseEvent | TouchEvent) => {
    if (didConnectRef.current) return
    if (connStartRef.current?.handleType !== 'source') return

    const clientX = 'touches' in e ? (e as TouchEvent).changedTouches[0].clientX : (e as MouseEvent).clientX
    const clientY = 'touches' in e ? (e as TouchEvent).changedTouches[0].clientY : (e as MouseEvent).clientY

    if ((e.target as Element)?.closest('.react-flow__handle')) return

    setConnMenu({ screenX: clientX, screenY: clientY, sourceId: connStartRef.current.nodeId })
    connStartRef.current = null
  }, [])

  const handleMenuSelect = useCallback((type: string) => {
    if (!connMenu) return
    const { viewport: vp } = useCanvasStore.getState()
    const rect = canvasRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const x = (connMenu.screenX - rect.left - vp.x) / vp.zoom
    const y = (connMenu.screenY - rect.top - vp.y) / vp.zoom
    const newNode = addNodeAt(type, x, y)
    applyConnection(connMenu.sourceId, newNode.id)
    setConnMenu(null)
  }, [connMenu, addNodeAt, applyConnection])

  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => {
    setViewport(vp)
  }, [setViewport])

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: { id: string }[] }) => {
    setSelected(sel.map(n => n.id))
  }, [setSelected])

  const defaultViewport = useMemo(() => viewport, [])

  return (
    <div ref={canvasRef} className="w-full h-full" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes as Node[]}
        edges={edges}
        nodeTypes={nodeTypes as never}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart as never}
        onConnectEnd={onConnectEnd as never}
        onMoveEnd={onMoveEnd}
        onSelectionChange={onSelectionChange}
        defaultViewport={defaultViewport}
        minZoom={0.05}
        maxZoom={4}
        deleteKeyCode="Delete"
        connectionRadius={60}
        fitView={nodes.length === 0}
        colorMode="dark"
        selectionOnDrag={true}
        panOnDrag={[1, 2]}
        panOnScroll={true}
        selectionMode={SelectionMode.Partial}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2a2a" />
        <Controls style={{ background: '#1e1e1e', border: '1px solid #2a2a2a' }} showInteractive={false} />
      </ReactFlow>

      <MultiSelectToolbar selectedIds={selectedNodeKeys} />

      {connMenu && (
        <ConnectionMenu
          screenX={connMenu.screenX}
          screenY={connMenu.screenY}
          onSelect={handleMenuSelect}
          onClose={() => setConnMenu(null)}
        />
      )}
    </div>
  )
}
