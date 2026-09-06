import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronDown, FileText, LayoutGrid, LogOut, MoreHorizontal, NotebookText, Palette, PlugZap, Plus, Search, ShieldCheck, X } from 'lucide-react'
import { useCanvasStore } from '@/store/canvasStore'
import { logsApi, projectsApi, type ActivityLogEntry } from '@/lib/api'
import { readStoredShotflowTheme, setShotflowTheme, SHOTFLOW_THEME_OPTIONS, type ShotflowTheme } from '@/lib/theme'
import { getAdminPath, getErrorLibraryPath } from '../../shared/routes'
import { PluginTokenModal } from './PluginTokenModal'
import { SkillDocsModal } from './SkillDocsModal'

interface Props {
  onHome: () => void
  user: { username: string; role: 'user' | 'admin' }
  onLogout: () => void
}

function formatLogTime(log: ActivityLogEntry) {
  return new Date(logCreatedAtMs(log)).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function logCreatedAtMs(log: ActivityLogEntry) {
  if (typeof log.createdAtMs === 'number') return log.createdAtMs
  const parsed = Date.parse(log.createdAt || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function formatLogDateTitle(log: ActivityLogEntry) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(new Date(logCreatedAtMs(log)))
  const value = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${value('month')}/${value('day')} ${value('year')}`
}

export function ActivityLogsModal({
  user,
  onClose,
}: {
  user: { username: string; role: 'user' | 'admin' }
  onClose: () => void
}) {
  const [logs, setLogs] = useState<ActivityLogEntry[]>([])
  const [filterDate, setFilterDate] = useState('')
  const [canAdd, setCanAdd] = useState(false)
  const [canEdit, setCanEdit] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingLog, setEditingLog] = useState<ActivityLogEntry | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')
  const [searchKeyword, setSearchKeyword] = useState('')
  const loadLogsSeqRef = useRef(0)

  const loadLogs = useCallback(async (date = filterDate) => {
    const seq = loadLogsSeqRef.current + 1
    loadLogsSeqRef.current = seq
    setLoading(true)
    setError('')
    try {
      const data = await logsApi.list(date || undefined)
      if (seq !== loadLogsSeqRef.current) return
      setLogs(Array.isArray(data.logs) ? data.logs : [])
      setCanAdd(Boolean(data.canAdd))
      setCanEdit(Boolean(data.canEdit ?? data.canAdd))
    } catch (err) {
      if (seq !== loadLogsSeqRef.current) return
      const responseError = (err as { response?: { data?: { error?: string } }; code?: string })?.response?.data?.error
      const timedOut = (err as { code?: string })?.code === 'ECONNABORTED'
      setLogs([])
      setError(responseError || (timedOut ? '日志加载超时，请关闭后重试' : (err instanceof Error ? err.message : '日志加载失败')))
    } finally {
      if (seq === loadLogsSeqRef.current) setLoading(false)
    }
  }, [filterDate])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const openAddEditor = () => {
    setEditingLog(null)
    setDraft('')
    setEditorOpen(true)
  }

  const openEditEditor = (log: ActivityLogEntry) => {
    setEditingLog(log)
    setDraft(log.content)
    setEditorOpen(true)
  }

  const closeEditor = () => {
    setEditorOpen(false)
    setEditingLog(null)
    setDraft('')
  }

  const submitLog = async () => {
    const content = draft.trim()
    if (!content || saving) return
    setSaving(true)
    setError('')
    try {
      if (editingLog) {
        await logsApi.update(editingLog.id, content)
        await loadLogs(filterDate)
      } else {
        await logsApi.add(content)
        setFilterDate('')
        await loadLogs('')
      }
      closeEditor()
    } catch (err) {
      const responseError = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(responseError || (err instanceof Error ? err.message : '日志添加失败'))
    } finally {
      setSaving(false)
    }
  }

  const orderedLogs = useMemo(() => {
    return [...logs].sort((a, b) => {
      const delta = logCreatedAtMs(b) - logCreatedAtMs(a)
      return sortOrder === 'newest' ? delta : -delta
    })
  }, [logs, sortOrder])

  const visibleLogs = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase()
    if (!keyword) return orderedLogs
    return orderedLogs.filter((log) => {
      const haystack = [
        log.content,
        log.authorName,
        formatLogTime(log),
        formatLogDateTitle(log),
      ].join('\n').toLowerCase()
      return haystack.includes(keyword)
    })
  }, [orderedLogs, searchKeyword])

  const groupedLogs = useMemo(() => {
    return visibleLogs.reduce<Array<{ title: string; logs: ActivityLogEntry[] }>>((groups, log) => {
      const title = formatLogDateTitle(log)
      const lastGroup = groups[groups.length - 1]
      if (lastGroup?.title === title) {
        lastGroup.logs.push(log)
      } else {
        groups.push({ title, logs: [log] })
      }
      return groups
    }, [])
  }, [visibleLogs])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="shotflow-log-overlay" role="dialog" aria-modal="true" aria-label="查看日志">
      <div className="shotflow-log-modal">
        <header className="shotflow-log-header">
          <div>
            <h2>工具更新日志</h2>
          </div>
          <div className="shotflow-log-header-actions">
            {canAdd && (
              <button type="button" className="shotflow-log-add-button" onClick={openAddEditor}>
                <Plus size={15} />
                添加日志
              </button>
            )}
            <button className="shotflow-log-close" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="shotflow-log-toolbar">
          <label>
            <span>日期</span>
            <input
              type="date"
              value={filterDate}
              onChange={(event) => setFilterDate(event.target.value)}
            />
          </label>
          {filterDate && (
            <button type="button" className="shotflow-log-ghost" onClick={() => setFilterDate('')}>
              全部日志
            </button>
          )}
          <label className="shotflow-log-search-field">
            <Search size={14} strokeWidth={2} />
            <input
              type="search"
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="搜索日志关键字"
            />
          </label>
          {searchKeyword && (
            <button type="button" className="shotflow-log-ghost" onClick={() => setSearchKeyword('')}>
              清空搜索
            </button>
          )}
          <div className="shotflow-log-spacer" />
          <select
            className="shotflow-log-sort-select"
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value as 'newest' | 'oldest')}
            aria-label="日志排列顺序"
          >
            <option value="newest">任务时间由近到远</option>
            <option value="oldest">任务时间由远到近</option>
          </select>
        </div>

        {error && <div className="shotflow-log-error">{error}</div>}

        <div className="shotflow-log-list">
          {loading ? (
            <div className="shotflow-log-empty">正在加载日志...</div>
          ) : groupedLogs.length === 0 ? (
            <div className="shotflow-log-empty">
              {searchKeyword.trim() ? '没有匹配的日志' : (filterDate ? '这一天没有日志' : '还没有日志')}
            </div>
          ) : (
            groupedLogs.map((group) => (
              <section className="shotflow-log-day-group" key={group.title}>
                <h3 className="shotflow-log-day-title">{group.title}</h3>
                {group.logs.map((log) => (
                  <article className="shotflow-log-item" key={log.id}>
                <div className="shotflow-log-item-head">
                  <time>{formatLogTime(log)}</time>
                </div>
                <p>{log.content}</p>
                <div className="shotflow-log-item-footer">
                  {canEdit && (
                    <button type="button" className="shotflow-log-edit-button" onClick={() => openEditEditor(log)}>
                      修改
                    </button>
                  )}
                  <span className="shotflow-log-author">{log.authorName || user.username}</span>
                </div>
                  </article>
                ))}
              </section>
            ))
          )}
        </div>

        {editorOpen && canAdd && (
          <div className="shotflow-log-editor-backdrop">
            <div className="shotflow-log-editor">
              <div className="shotflow-log-editor-head">
                <strong>{editingLog ? '修改日志' : '添加日志'}</strong>
                <button type="button" className="shotflow-log-close" onClick={closeEditor}>
                  <X size={16} />
                </button>
              </div>
              <textarea
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="输入日志内容"
              />
              <div className="shotflow-log-editor-actions">
                <button type="button" className="shotflow-log-ghost" onClick={closeEditor}>
                  取消
                </button>
                <button type="button" className="shotflow-log-add-button" disabled={!draft.trim() || saving} onClick={submitLog}>
                  {saving ? (editingLog ? '保存中...' : '添加中...') : (editingLog ? '保存' : '添加')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

export function TopNav({ onHome, user, onLogout }: Props) {
  const {
    projectName,
    collectionName,
    projectUuid,
    projectShared,
    projectCanManage,
    isSaving,
    isDirty,
  } = useCanvasStore()
  const workspaceLabel = collectionName.trim() || '我的画布'
  const [editing, setEditing] = useState(false)
  const [nameVal, setNameVal] = useState('')
  const [apiKeyMessage, setApiKeyMessage] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [pluginTokenOpen, setPluginTokenOpen] = useState(false)
  const [skillDocsOpen, setSkillDocsOpen] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [theme, setTheme] = useState<ShotflowTheme>(readStoredShotflowTheme)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then((d: { mivoApiConfigured?: boolean; llmApiConfigured?: boolean }) => {
        const missing: string[] = []
        if (!d.mivoApiConfigured) missing.push('MIVO_API_KEY')
        if (!d.llmApiConfigured) missing.push('LLM_API_KEY')
        setApiKeyMessage(missing.length ? `未配置 ${missing.join(' / ')}` : '')
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleEscape, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleEscape, true)
    }
  }, [menuOpen])

  const startEdit = () => {
    if (!projectCanManage) return
    setNameVal(projectName)
    setEditing(true)
  }

  const commitEdit = async () => {
    setEditing(false)
    if (!projectCanManage) return
    if (nameVal.trim() && nameVal !== projectName && projectUuid) {
      await projectsApi.rename(projectUuid, nameVal.trim())
      useCanvasStore.setState({ projectName: nameVal.trim() })
    }
  }

  const toggleShare = async () => {
    if (!projectUuid || !projectCanManage || shareLoading) return
    setShareLoading(true)
    try {
      const project = await projectsApi.setShared(projectUuid, !projectShared)
      useCanvasStore.setState({
        projectShared: Boolean(project.projectMeta.isShared),
        projectIsOwner: Boolean(project.projectMeta.isOwner),
        projectCanManage: Boolean(project.projectMeta.canManage),
        projectCanWrite: Boolean(project.projectMeta.canWrite),
        projectOwnerId: project.projectMeta.ownerId ?? null,
        projectOwnerName: project.projectMeta.ownerName ?? '',
      })
      setMenuOpen(false)
    } finally {
      setShareLoading(false)
    }
  }

  const selectTheme = (nextTheme: ShotflowTheme) => {
    setTheme(nextTheme)
    setShotflowTheme(nextTheme)
  }

  return (
    <div
      className="shotflow-top-nav flex items-center justify-between px-4"
      style={{
        position: 'fixed',
        top: 10,
        left: 0,
        right: 0,
        zIndex: 20,
        height: 40,
        background: 'transparent',
        borderBottom: 'none',
        pointerEvents: 'none',
      }}
    >
      <div className="shotflow-top-cluster">
        <button
          type="button"
          className="shotflow-mark"
          title="返回画布管理"
          aria-label="返回画布管理"
          onClick={onHome}
        >
          <img
            src="/shotflow-mark.svg"
            alt=""
            style={{ height: 22, width: 22, display: 'block', objectFit: 'contain' }}
          />
        </button>
        <div className="shotflow-canvas-dock flex items-center" style={{ minWidth: 0 }}>
        <button
          type="button"
          className="shotflow-crumb-button"
          title="返回画布管理"
          onClick={onHome}
        >
          <LayoutGrid size={13} strokeWidth={1.6} />
          <span>{workspaceLabel}</span>
          <ChevronDown size={12} strokeWidth={1.6} />
        </button>
        <div className="shotflow-dock-separator" />

        {editing ? (
          <input
            autoFocus
            className="shotflow-title-input"
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') void commitEdit()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : projectCanManage ? (
          <button
            type="button"
            className="shotflow-title-button"
            style={{ cursor: 'text' }}
            onDoubleClick={startEdit}
            title={projectName}
          >
            <span>{projectName}</span>
            <ChevronDown size={12} strokeWidth={1.6} />
          </button>
        ) : (
          <span
            className="shotflow-title-button"
            title={projectName}
          >
            <span>{projectName}</span>
          </span>
        )}

        {projectShared && (
          <span
            className="shotflow-shared-badge"
          >
            已共享
          </span>
        )}

        <span className="text-sm" style={{ display: 'none', color: isSaving ? '#7c5cfc' : isDirty ? '#f59e0b' : '#8a8a8a' }}>
          {isSaving ? '保存中' : isDirty ? '未保存' : '已保存'}
        </span>
        {apiKeyMessage && (
          <span className="text-xs px-2 py-0.5 rounded" style={{ background: '#3a2a00', color: '#f59e0b' }}>
            {apiKeyMessage}，请编辑服务器 `.env`
          </span>
        )}
        </div>
      </div>

      <div className="shotflow-right-tools flex items-center" style={{ pointerEvents: 'auto' }}>
        <span className="shotflow-user-chip">{user.username}</span>
        <span className="shotflow-right-divider" aria-hidden="true" />
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            className="shotflow-control-button shotflow-control-icon"
            onClick={() => setMenuOpen(open => !open)}
            title="项目菜单"
          >
            <MoreHorizontal size={16} strokeWidth={1.6} />
          </button>

          {menuOpen && (
            <div
              className="shotflow-project-dropdown"
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 8px)',
                minWidth: 244,
                borderRadius: 10,
                padding: 6,
                zIndex: 40,
              }}
            >
              <div className="shotflow-theme-picker">
                <div className="shotflow-theme-picker-title">
                  <Palette size={14} strokeWidth={2} />
                  画布主题
                </div>
                <div className="shotflow-theme-options" role="group" aria-label="画布主题">
                  {SHOTFLOW_THEME_OPTIONS.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      className={`shotflow-theme-option${theme === option.value ? ' is-active' : ''}`}
                      aria-pressed={theme === option.value}
                      title={option.description}
                      onClick={() => selectTheme(option.value)}
                    >
                      <span
                        className="shotflow-theme-swatch"
                        style={{ background: option.swatch }}
                        aria-hidden="true"
                      >
                        {theme === option.value && <Check size={12} strokeWidth={2.6} />}
                      </span>
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="shotflow-project-dropdown-divider" />
              {user.username.trim() === '吴逸翔' && (
                <button
                  type="button"
                  className="shotflow-project-dropdown-action"
                  onClick={() => {
                    setMenuOpen(false)
                    window.location.href = getErrorLibraryPath()
                  }}
                >
                  <AlertTriangle size={15} strokeWidth={2} />
                  报错信息
                </button>
              )}
              {user.role === 'admin' && (
                <button
                  type="button"
                  className="shotflow-project-dropdown-action"
                  onClick={() => {
                    setMenuOpen(false)
                    window.location.href = getAdminPath()
                  }}
                >
                  <ShieldCheck size={15} strokeWidth={2} />
                  后台管理
                  </button>
                )}
              <button
                type="button"
                className="shotflow-project-dropdown-action"
                onClick={() => {
                  setMenuOpen(false)
                  setPluginTokenOpen(true)
                }}
              >
                <PlugZap size={15} strokeWidth={2} />
                Cindy 插件
              </button>
              <button
                type="button"
                className="shotflow-project-dropdown-action"
                onClick={() => {
                  setMenuOpen(false)
                  setSkillDocsOpen(true)
                }}
              >
                <FileText size={15} strokeWidth={2} />
                Cindy Skill
              </button>
              <button
                type="button"
                className="shotflow-project-dropdown-action"
                onClick={() => {
                  setMenuOpen(false)
                  setLogOpen(true)
                }}
              >
                <NotebookText size={15} strokeWidth={2} />
                查看日志
              </button>
              <div className="shotflow-project-dropdown-divider" />
              <button
                type="button"
                className="shotflow-project-dropdown-action"
                onClick={() => { void toggleShare() }}
                disabled={!projectCanManage || !projectUuid || shareLoading}
              >
                {shareLoading ? '处理中...' : projectShared ? '取消共享' : '共享项目'}
              </button>
              {!projectCanManage && (
                <div style={{ padding: '6px 12px 8px', fontSize: 12, color: '#7f759f' }}>
                  只有项目创建者或管理员可以更改共享状态
                </div>
              )}
              <div className="shotflow-project-dropdown-divider" />
              <button
                type="button"
                className="shotflow-project-dropdown-action is-danger"
                onClick={() => {
                  setMenuOpen(false)
                  onLogout()
                }}
              >
                <LogOut size={15} strokeWidth={2} />
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
      {logOpen && (
        <ActivityLogsModal
          user={user}
          onClose={() => setLogOpen(false)}
        />
      )}
      {pluginTokenOpen && <PluginTokenModal onClose={() => setPluginTokenOpen(false)} />}
      {skillDocsOpen && <SkillDocsModal onClose={() => setSkillDocsOpen(false)} />}
    </div>
  )
}
