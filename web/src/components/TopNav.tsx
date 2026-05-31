import { useState, useEffect } from 'react'
import { useCanvasStore } from '@/store/canvasStore'
import { projectsApi } from '@/lib/api'

interface Props {
  onHome: () => void
}

export function TopNav({ onHome }: Props) {
  const { projectName, projectUuid, isSaving, isDirty } = useCanvasStore()
  const [editing, setEditing] = useState(false)
  const [nameVal, setNameVal] = useState('')
  const [apiKeyMissing, setApiKeyMissing] = useState(false)

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then((d: { apiKeyConfigured: boolean }) => {
      setApiKeyMissing(!d.apiKeyConfigured)
    }).catch(() => {})
  }, [])

  const startEdit = () => { setNameVal(projectName); setEditing(true) }
  const commitEdit = async () => {
    setEditing(false)
    if (nameVal.trim() && nameVal !== projectName && projectUuid) {
      await projectsApi.rename(projectUuid, nameVal.trim())
      useCanvasStore.setState({ projectName: nameVal.trim() })
    }
  }

  return (
    <div
      className="flex items-center justify-between px-4"
      style={{ height: 48, background: '#141414', borderBottom: '1px solid #2a2a2a', zIndex: 20, position: 'relative' }}
    >
      <div className="flex items-center gap-3">
        <button
          className="text-sm text-muted hover:text-fg transition-colors"
          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          onClick={onHome}
        >← 项目</button>

        {editing ? (
          <input
            autoFocus
            className="text-sm rounded px-2 py-1"
            style={{ background: '#1e1e1e', border: '1px solid #7c5cfc', color: '#e5e5e5' }}
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false) }}
          />
        ) : (
          <button
            className="text-sm text-fg hover:text-accent"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={startEdit}
          >{projectName}</button>
        )}

        <span className="text-sm" style={{ color: isSaving ? '#7c5cfc' : isDirty ? '#f59e0b' : '#8a8a8a' }}>
          {isSaving ? '保存中…' : isDirty ? '未保存' : '已保存'}
        </span>
        {apiKeyMissing && (
          <span className="text-xs px-2 py-0.5 rounded" style={{ background: '#3a2a00', color: '#f59e0b' }}>
            ⚠ 未配置 Mivo API Key → 编辑 server/config.json
          </span>
        )}
      </div>

      <div className="text-sm font-bold" style={{ color: '#7c5cfc' }}>sate TV</div>
    </div>
  )
}
