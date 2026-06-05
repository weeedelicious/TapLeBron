import { useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { generateApi } from '@/lib/api'
import { defaultScriptParams } from '@/lib/nodeData'
import type { CanvasNodeData, ScriptParams, ScriptRow } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

export function ScriptNode({ id, data, selected }: Props) {
  const { updateNodeData, addNode } = useCanvasStore()
  const params = data.params ? (data.params as unknown as ScriptParams) : defaultScriptParams()

  const setRows = useCallback((rows: ScriptRow[]) => {
    updateNodeData(id, { params: { ...params, rows } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  const addRow = useCallback(() => {
    setRows([...params.rows, { id: uuidv4(), shot: '', sceneType: '', action: '', dialogue: '', duration: 3 }])
  }, [params.rows, setRows])

  const updateRow = useCallback((rowId: string, key: keyof ScriptRow, val: string | number) => {
    setRows(params.rows.map(r => r.id === rowId ? { ...r, [key]: val } : r))
  }, [params.rows, setRows])

  const deleteRow = useCallback((rowId: string) => {
    setRows(params.rows.filter(r => r.id !== rowId))
  }, [params.rows, setRows])

  const handleGenerate = useCallback(async () => {
    if (!params.description) return
    try {
      const res = await generateApi.script(data.projectUuid, id, { description: params.description })
      if (res.text) {
        try {
          const rows: ScriptRow[] = JSON.parse(res.text)
          setRows(rows)
        } catch { /* non-JSON response, ignore */ }
      }
    } catch (e) { console.error(e) }
  }, [data.projectUuid, id, params.description, setRows])

  const rowToImageNode = useCallback((row: ScriptRow) => {
    const newNode = addNode('image')
    const prompt = `${row.sceneType} ${row.action} ${row.dialogue}`.trim()
    updateNodeData(newNode.id, {
      params: { prompt, model: 'gemini-3-pro-image-preview', count: 1, settings: { ratio: '16:9' }, modeType: 'text2image', imageList: [], imageListOrder: [], videoList: [], audioList: [], textList: [] }
    })
  }, [addNode, updateNodeData])

  const thStyle = { background: '#141414', color: '#8a8a8a', padding: '4px 8px', borderBottom: '1px solid #2a2a2a', fontSize: 11, whiteSpace: 'nowrap' as const }
  const tdStyle = { padding: '4px 6px', borderBottom: '1px solid #1a1a1a', fontSize: 11 }
  const inputStyle = { background: 'transparent', border: 'none', color: '#e5e5e5', width: '100%', fontSize: 11 }

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={700} minHeight={300}>
      <div className="p-3 flex flex-col gap-2">
        <div className="flex gap-2">
          <textarea
            className="flex-1 rounded p-2 text-xs resize-none nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5', minHeight: 48 }}
            placeholder="故事描述，生成故事板脚本…"
            value={params.description}
            onChange={e => updateNodeData(id, { params: { ...params, description: e.target.value } as unknown as Record<string, unknown> })}
            rows={2}
          />
          <button
            className="text-xs px-3 rounded font-medium nodrag"
            style={{ background: '#7c5cfc', color: '#fff', border: 'none', cursor: 'pointer', flexShrink: 0 }}
            onClick={handleGenerate}
          >AI 生成</button>
        </div>

        <div className="overflow-auto nodrag" style={{ maxHeight: 400 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr>
                <th style={thStyle}>镜号</th>
                <th style={thStyle}>景别</th>
                <th style={{ ...thStyle, width: '35%' }}>动作/内容</th>
                <th style={{ ...thStyle, width: '25%' }}>对白</th>
                <th style={thStyle}>时长(s)</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {params.rows.map((row, i) => (
                <tr key={row.id}>
                  <td style={tdStyle}><input style={inputStyle} className="nodrag" value={row.shot || String(i + 1)} onChange={e => updateRow(row.id, 'shot', e.target.value)} /></td>
                  <td style={tdStyle}>
                    <select style={{ ...inputStyle, background: '#141414' }} className="nodrag" value={row.sceneType} onChange={e => updateRow(row.id, 'sceneType', e.target.value)}>
                      {['', '远景', '全景', '中景', '近景', '特写', '超特写'].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={tdStyle}><input style={inputStyle} className="nodrag" value={row.action} onChange={e => updateRow(row.id, 'action', e.target.value)} /></td>
                  <td style={tdStyle}><input style={inputStyle} className="nodrag" value={row.dialogue} onChange={e => updateRow(row.id, 'dialogue', e.target.value)} /></td>
                  <td style={tdStyle}><input style={{ ...inputStyle, width: 48 }} type="number" className="nodrag" value={row.duration} min={1} max={60} onChange={e => updateRow(row.id, 'duration', Number(e.target.value))} /></td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="text-xs nodrag" style={{ color: '#7c5cfc', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => rowToImageNode(row)} title="转为图片节点">🖼</button>
                      <button className="text-xs nodrag" style={{ color: '#f87171', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => deleteRow(row.id)}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="mt-2 w-full text-xs py-1 rounded nodrag"
            style={{ border: '1px dashed #2a2a2a', color: '#8a8a8a', background: 'none', cursor: 'pointer' }}
            onClick={addRow}
          >+ 添加镜头</button>
        </div>
      </div>
    </NodeShell>
  )
}
