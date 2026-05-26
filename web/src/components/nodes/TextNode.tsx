import { useCallback } from 'react'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { generateApi } from '@/lib/api'
import { defaultTextParams } from '@/lib/nodeData'
import type { CanvasNodeData, TextParams } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

export function TextNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const params = data.params ? (data.params as unknown as TextParams) : defaultTextParams()

  const handleTranslate = useCallback(async () => {
    if (!params.content) return
    try {
      const res = await generateApi.translate(params.content)
      updateNodeData(id, { params: { content: res.translated } })
    } catch (e) { console.error(e) }
  }, [id, params.content, updateNodeData])

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={320} minHeight={200}>
      <div className="p-3 flex flex-col gap-2 h-full">
        <textarea
          className="flex-1 w-full rounded p-2 text-xs resize-none nodrag"
          style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5', minHeight: 140 }}
          placeholder="剧本、广告词、品牌文案…"
          value={params.content}
          onChange={e => updateNodeData(id, { params: { content: e.target.value } })}
        />
        <div className="flex justify-between items-center">
          <span className="text-xs text-muted">{params.content.length} 字</span>
          <button
            className="text-xs px-3 py-1 rounded text-muted nodrag"
            style={{ border: '1px solid #2a2a2a', background: 'none', cursor: 'pointer' }}
            onClick={handleTranslate}
          >翻译</button>
        </div>
      </div>
    </NodeShell>
  )
}
