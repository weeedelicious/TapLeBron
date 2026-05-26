import { useCallback, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection,
  addEdge,
  type Viewport,
  BackgroundVariant,
  type Node,
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
import type { CanvasNodeData, NodeRef } from '@/lib/types'

const nodeTypes = {
  image: ImageNode,
  video: VideoNode,
  text: TextNode,
  audio: AudioNode,
  script: ScriptNode,
  video_merge: VideoMergeNode,
  upload: UploadNode,
  director_stage: DirectorStageNode,
}

type FlowNode = Node & { data: CanvasNodeData & { nodeKey: string; projectUuid: string } }

export function Canvas() {
  const { nodes, edges, viewport, setNodes, setEdges, setViewport, setSelected, updateNodeData } = useCanvasStore()

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const updated = applyNodeChanges(changes, nodes as Node[]) as FlowNode[]
    setNodes(updated)
  }, [nodes, setNodes])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(applyEdgeChanges(changes, edges))
  }, [edges, setEdges])

  const onConnect = useCallback((connection: Connection) => {
    const { source, target } = connection
    if (!source || !target) return
    const sourceNode = nodes.find(n => n.data.nodeKey === source || n.id === source)
    const targetNode = nodes.find(n => n.data.nodeKey === target || n.id === target)
    if (!sourceNode || !targetNode) return

    const sourceData = sourceNode.data as CanvasNodeData
    const targetData = targetNode.data as CanvasNodeData
    const targetParams = (targetData.params ?? {}) as Record<string, unknown>

    const ref: NodeRef = {
      nodeId: source,
      url: sourceData.url?.[0] ?? '',
      mediaType: sourceData.type === 'video' ? 'video' : sourceData.type === 'audio' ? 'audio' : 'image',
    }

    const targetId = target

    if (sourceData.type === 'video' || sourceData.type === 'video_merge') {
      const existing = (targetParams.videoList ?? []) as NodeRef[]
      if (!existing.find(r => r.nodeId === source)) {
        updateNodeData(targetId, {
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
      if (!existing.find(r => r.nodeId === source)) {
        updateNodeData(targetId, { params: { ...targetParams, audioList: [...existing, ref] } })
      }
    } else if (sourceData.type === 'text') {
      const existing = (targetParams.textList ?? []) as NodeRef[]
      if (!existing.find(r => r.nodeId === source)) {
        updateNodeData(targetId, { params: { ...targetParams, textList: [...existing, ref] } })
      }
    } else {
      const existing = (targetParams.imageList ?? []) as NodeRef[]
      if (!existing.find(r => r.nodeId === source)) {
        updateNodeData(targetId, {
          params: {
            ...targetParams,
            imageList: [...existing, ref],
            imageListOrder: [...((targetParams.imageListOrder as string[]) ?? []), source],
            modeType: 'image2image',
          }
        })
      }
    }
    setEdges(addEdge({ ...connection, animated: true, style: { stroke: '#7c5cfc' } }, edges))
  }, [nodes, edges, setEdges, updateNodeData])

  const onMoveEnd = useCallback((_: unknown, vp: Viewport) => {
    setViewport(vp)
  }, [setViewport])

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: { id: string }[] }) => {
    setSelected(sel.map(n => n.id))
  }, [setSelected])

  const defaultViewport = useMemo(() => viewport, [])

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes as Node[]}
        edges={edges}
        nodeTypes={nodeTypes as never}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onMoveEnd={onMoveEnd}
        onSelectionChange={onSelectionChange}
        defaultViewport={defaultViewport}
        minZoom={0.05}
        maxZoom={4}
        deleteKeyCode="Delete"
        fitView={nodes.length === 0}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2a2a" />
        <MiniMap
          style={{ background: '#141414', border: '1px solid #2a2a2a' }}
          nodeColor="#7c5cfc"
          maskColor="rgba(0,0,0,0.6)"
        />
        <Controls
          style={{ background: '#1e1e1e', border: '1px solid #2a2a2a' }}
          showInteractive={false}
        />
      </ReactFlow>
    </div>
  )
}
