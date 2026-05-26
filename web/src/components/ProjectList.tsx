import { useEffect, useState } from 'react'
import { projectsApi } from '@/lib/api'
import type { ProjectIndex } from '@/lib/types'

interface Props {
  onOpen: (uuid: string) => void
}

export function ProjectList({ onOpen }: Props) {
  const [projects, setProjects] = useState<ProjectIndex[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try { setProjects(await projectsApi.list()) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    const name = prompt('项目名称', '未命名项目') ?? '未命名项目'
    const p = await projectsApi.create(name)
    onOpen(p.projectMeta.uuid)
  }

  const handleDelete = async (uuid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('确认删除此项目？')) return
    await projectsApi.delete(uuid)
    load()
  }

  return (
    <div className="min-h-screen" style={{ background: '#0d0d0d', color: '#e5e5e5' }}>
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold" style={{ color: '#7c5cfc' }}>LibTV Canvas</h1>
          <button
            className="px-4 py-2 rounded text-sm font-medium"
            style={{ background: '#7c5cfc', color: '#fff', border: 'none', cursor: 'pointer' }}
            onClick={handleCreate}
          >+ 新建项目</button>
        </div>

        {loading ? (
          <div className="text-muted text-sm">加载中…</div>
        ) : projects.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-muted text-sm mb-4">还没有项目，点击"新建项目"开始</div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {projects.map(p => (
              <div
                key={p.uuid}
                className="rounded-lg overflow-hidden cursor-pointer group"
                style={{ border: '1px solid #2a2a2a', background: '#1e1e1e' }}
                onClick={() => onOpen(p.uuid)}
              >
                <div className="h-32 flex items-center justify-center" style={{ background: '#141414' }}>
                  {p.coverUrl ? (
                    <img src={p.coverUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span style={{ fontSize: 32, opacity: 0.3 }}>🖼</span>
                  )}
                </div>
                <div className="p-3 flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm text-fg truncate">{p.name}</div>
                    <div className="text-xs text-muted mt-1">{p.nodeCount} 个节点</div>
                  </div>
                  <button
                    className="text-xs text-red-400 opacity-0 group-hover:opacity-100 flex-shrink-0"
                    style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                    onClick={e => handleDelete(p.uuid, e)}
                  >删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
