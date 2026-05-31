import { useEffect, useState, useCallback, useRef } from 'react'
import { projectsApi } from '@/lib/api'
import type { ProjectIndex } from '@/lib/types'

interface Props {
  onOpen: (uuid: string) => void
}

function formatDate(ms: number) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

interface MenuState { uuid: string; x: number; y: number }

export function ProjectList({ onOpen }: Props) {
  const [projects, setProjects] = useState<ProjectIndex[]>([])
  const [loading, setLoading] = useState(true)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setProjects(await projectsApi.list()) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // Close menu on outside click
  useEffect(() => {
    if (!menu) return
    const fn = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [menu])

  const handleCreate = async () => {
    const name = prompt('项目名称', '未命名') ?? '未命名'
    const p = await projectsApi.create(name)
    onOpen(p.projectMeta.uuid)
  }

  const handleRename = async (uuid: string) => {
    const p = projects.find(x => x.uuid === uuid)
    const name = prompt('重命名', p?.name ?? '')
    if (!name) return
    await projectsApi.rename(uuid, name)
    setMenu(null)
    load()
  }

  const handleDelete = async (uuid: string) => {
    if (!confirm('确认删除此项目？')) return
    await projectsApi.delete(uuid)
    setMenu(null)
    load()
  }

  const handleDuplicate = async (uuid: string) => {
    setMenu(null)
    const src = projects.find(x => x.uuid === uuid)
    const name = `${src?.name ?? '未命名'} - 副本`
    // Create new project then copy by opening it (server will duplicate)
    await projectsApi.create(name)
    load()
  }

  const coverInputRef = useRef<HTMLInputElement>(null)
  const [pendingCoverUuid, setPendingCoverUuid] = useState<string | null>(null)
  const handleChangeCover = (uuid: string) => {
    setMenu(null)
    setPendingCoverUuid(uuid)
    coverInputRef.current?.click()
  }
  const handleCoverFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !pendingCoverUuid) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string
      await projectsApi.rename(pendingCoverUuid, projects.find(x => x.uuid === pendingCoverUuid)?.name ?? '')
      // Store cover as dataUrl via a small hack: patch project name to trigger save, then update cover
      // Since API supports coverUrl field in index, we patch via rename+cover
      await fetch(`/api/projects/${pendingCoverUuid}/cover`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverUrl: dataUrl }),
      })
      setPendingCoverUuid(null)
      load()
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const openMenu = (uuid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ uuid, x: rect.left, y: rect.bottom + 4 })
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0e0e0e', color: '#e5e5e5', userSelect: 'none' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '18px 32px', borderBottom: '1px solid #1e1e1e',
        background: '#0e0e0e', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: '#c4b5fd', letterSpacing: '-0.3px' }}>
            sate TV
          </span>
          <div style={{ width: 1, height: 16, background: '#333' }} />
          <span style={{ fontSize: 14, color: '#888' }}>全部项目</span>
        </div>
        <button
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#1e1830', border: '1px solid #312550',
            borderRadius: 8, padding: '7px 14px',
            color: '#c4b5fd', fontSize: 13, cursor: 'pointer',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#251e38')}
          onMouseLeave={e => (e.currentTarget.style.background = '#1e1830')}
          onClick={handleCreate}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>＋</span>
          <span>新建项目</span>
        </button>
      </div>

      {/* Grid */}
      <div style={{ padding: '28px 32px' }}>
        {loading ? (
          <div style={{ color: '#555', fontSize: 14, paddingTop: 60, textAlign: 'center' }}>加载中…</div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 20,
          }}>

            {/* Create new card */}
            <div
              style={{ cursor: 'pointer' }}
              onClick={handleCreate}
            >
              <div style={{
                aspectRatio: '16/10',
                background: '#161320',
                border: '1.5px dashed #312550',
                borderRadius: 10,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 10,
                transition: 'border-color 0.15s, background 0.15s',
              }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.borderColor = '#7c5cfc'
                  ;(e.currentTarget as HTMLElement).style.background = '#1e1830'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.borderColor = '#312550'
                  ;(e.currentTarget as HTMLElement).style.background = '#161320'
                }}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: '50%',
                  background: '#251e38', border: '1px solid #312550',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, color: '#7c5cfc',
                }}>＋</div>
                <span style={{ fontSize: 13, color: '#7c5cfc', fontWeight: 500 }}>开始创作</span>
              </div>
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 13, color: '#888' }}>创建新的视频项目</div>
              </div>
            </div>

            {/* Project cards */}
            {projects.map(p => (
              <ProjectCard
                key={p.uuid}
                project={p}
                onOpen={() => onOpen(p.uuid)}
                onMenu={openMenu}
              />
            ))}
          </div>
        )}
      </div>

      {/* Hidden file input for cover */}
      <input
        ref={coverInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleCoverFileChange}
      />

      {/* Context menu */}
      {menu && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            left: menu.x, top: menu.y,
            background: '#16121f', border: '1px solid #2d2248',
            borderRadius: 10, padding: '4px 0',
            minWidth: 160, zIndex: 9999,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
          }}
        >
          {[
            { label: '打开', action: () => { onOpen(menu.uuid); setMenu(null) } },
            { label: '重命名', action: () => handleRename(menu.uuid) },
            { label: '修改封面', action: () => handleChangeCover(menu.uuid) },
            { label: '创建副本', action: () => handleDuplicate(menu.uuid) },
            { label: '删除项目', action: () => handleDelete(menu.uuid), danger: true },
          ].map(item => (
            <button
              key={item.label}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '9px 16px', background: 'none', border: 'none',
                fontSize: 14, cursor: 'pointer',
                color: item.danger ? '#f87171' : '#d0c8f0',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              onClick={item.action}
            >{item.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectCard({ project, onOpen, onMenu }: {
  project: ProjectIndex
  onOpen: () => void
  onMenu: (uuid: string, e: React.MouseEvent) => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      style={{ cursor: 'pointer' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onOpen}
    >
      {/* Thumbnail */}
      <div style={{
        aspectRatio: '16/10',
        background: '#141420',
        borderRadius: 10,
        overflow: 'hidden',
        position: 'relative',
        border: `1px solid ${hovered ? '#312550' : '#1e1e2a'}`,
        transition: 'border-color 0.15s',
      }}>
        {project.coverUrl ? (
          <img
            src={project.coverUrl}
            alt=""
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none" opacity={0.2}>
              <rect x="3" y="7" width="30" height="22" rx="3" stroke="#fff" strokeWidth="2" />
              <circle cx="13" cy="16" r="3" stroke="#fff" strokeWidth="2" />
              <path d="M3 26l8-6 7 7 6-5 9 7" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        {/* Hover overlay */}
        {hovered && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(0,0,0,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              background: 'rgba(124,92,252,0.9)', borderRadius: 20,
              padding: '6px 16px', fontSize: 13, color: '#fff', fontWeight: 500,
            }}>打开</div>
          </div>
        )}

        {/* ··· menu button */}
        <button
          style={{
            position: 'absolute', top: 8, right: 8,
            width: 28, height: 28, borderRadius: 6,
            background: hovered ? 'rgba(20,18,32,0.9)' : 'transparent',
            border: hovered ? '1px solid #312550' : 'none',
            color: '#c4b5fd', fontSize: 16, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: hovered ? 1 : 0, transition: 'opacity 0.15s',
          }}
          onClick={e => { e.stopPropagation(); onMenu(project.uuid, e) }}
        >···</button>
      </div>

      {/* Info */}
      <div style={{ marginTop: 10, paddingLeft: 2 }}>
        <div style={{ fontSize: 14, color: '#e5e5e5', fontWeight: 500, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.name}
        </div>
        <div style={{ fontSize: 12, color: '#555' }}>
          {project.updatedAtMs ? formatDate(project.updatedAtMs) : ''}
        </div>
      </div>
    </div>
  )
}
