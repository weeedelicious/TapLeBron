import { useCallback } from 'react'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { toolboxApi } from '@/lib/api'
import type { CanvasNodeData } from '@/lib/types'

interface Props {
  selectedNode?: { data: CanvasNodeData & { nodeKey: string; projectUuid: string } } | null
}

export function Toolbox({ selectedNode }: Props) {
  const { addNode, updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()

  const imageUrl = selectedNode?.data.url?.[0]
  const nodeKey = selectedNode?.data.nodeKey
  const projectUuid = selectedNode?.data.projectUuid

  const run = useCallback(async (action: () => Promise<{ jobId: string }>) => {
    if (!nodeKey || !projectUuid) return
    try {
      const res = await action()
      addTask(res.jobId, nodeKey)
      startPolling(res.jobId, projectUuid)
    } catch (e) { console.error(e) }
  }, [nodeKey, projectUuid, addTask, startPolling])

  const handleSuperRes = () => {
    if (!imageUrl || !nodeKey || !projectUuid) return
    run(() => toolboxApi.superResolution(projectUuid, nodeKey, imageUrl))
  }

  const handlePanorama = () => {
    if (!imageUrl || !nodeKey || !projectUuid) return
    run(() => toolboxApi.panorama(projectUuid, nodeKey, imageUrl))
  }

  const handleMultiAngle = () => {
    if (!imageUrl || !nodeKey || !projectUuid) return
    run(() => toolboxApi.multiAngle(projectUuid, nodeKey, imageUrl))
  }

  const handleLighting = () => {
    if (!imageUrl || !nodeKey || !projectUuid) return
    run(() => toolboxApi.lighting(projectUuid, nodeKey, imageUrl))
  }

  const handleGrid = async () => {
    if (!imageUrl || !nodeKey || !projectUuid) return
    run(() => toolboxApi.grid(projectUuid, nodeKey, imageUrl, 3))
  }

  const handleSplitGrid = async () => {
    if (!imageUrl || !nodeKey || !projectUuid) return
    const res = await toolboxApi.splitGrid(projectUuid, nodeKey, imageUrl, 3, 3)
    for (const _k of res.nodeKeys) {
      addNode('image')
    }
  }

  const actions = [
    { label: '全景 NEW', desc: '全景拓展', handler: handlePanorama, icon: '🔭' },
    { label: '多角度', desc: '多角度生成', handler: handleMultiAngle, icon: '📐' },
    { label: '打光', desc: '重新打光', handler: handleLighting, icon: '💡' },
    { label: '九宫格', desc: '网格拼接', handler: handleGrid, icon: '⊞' },
    { label: '高清', desc: '超分辨率', handler: handleSuperRes, icon: '✨' },
    { label: '宫格切分', desc: '切分为独立图片', handler: handleSplitGrid, icon: '✂' },
  ]

  const disabled = !imageUrl

  return (
    <div className="p-3">
      <div className="text-xs font-medium text-fg mb-3">工具箱</div>
      {disabled && (
        <div className="text-xs text-muted mb-2">请先选中一个含图片的节点</div>
      )}
      <div className="flex flex-col gap-1">
        {actions.map(a => (
          <button
            key={a.label}
            disabled={disabled}
            className="text-left rounded p-2 flex items-center gap-2"
            style={{
              border: 'none', background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.4 : 1,
            }}
            onMouseEnter={e => !disabled && (e.currentTarget.style.background = '#2a2a2a')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={a.handler}
          >
            <span style={{ fontSize: 16 }}>{a.icon}</span>
            <div>
              <div className="text-xs text-fg">{a.label}</div>
              <div className="text-xs text-muted">{a.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
