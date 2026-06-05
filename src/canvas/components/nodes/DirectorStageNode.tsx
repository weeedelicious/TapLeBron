import { useCallback, useRef } from 'react'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { assetsApi } from '@/lib/api'
import type { CanvasNodeData } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

export function DirectorStageNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const handleCapture = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob(async (blob) => {
      if (!blob) return
      const file = new File([blob], 'screenshot.png', { type: 'image/png' })
      const res = await assetsApi.upload(data.projectUuid, file)
      updateNodeData(id, { url: [res.url], action: 'image_resource' })
    }, 'image/png')
  }, [id, data.projectUuid, updateNodeData])

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={480} minHeight={360}>
      <div className="p-3 flex flex-col gap-2">
        <div className="text-xs text-muted">3D 导演台（简版）</div>
        <canvas
          ref={canvasRef}
          width={440}
          height={248}
          className="rounded nodrag"
          style={{ background: '#0a0a0a', border: '1px solid #2a2a2a' }}
        />
        <div className="text-xs text-muted text-center">
          完整 3D 交互需要 three-fiber，当前为占位版。
        </div>
        {data.url?.[0] && (
          <img src={data.url[0]} alt="截图" className="w-full rounded" style={{ maxHeight: 200 }} />
        )}
        <button
          className="text-xs py-1 rounded nodrag"
          style={{ background: '#7c5cfc', color: '#fff' }}
          onClick={handleCapture}
        >截图导出</button>
      </div>
    </NodeShell>
  )
}
