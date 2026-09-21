import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ExternalLink, Loader2, Pencil, Plus, Search, X } from 'lucide-react'
import {
  officialTemplatesApi,
  type OfficialTemplateCategory,
  type OfficialTemplateItem,
} from '@/lib/api'
import type { FavoriteLibraryPayload, Project } from '@/lib/types'
import { useCanvasStore } from '@/store/canvasStore'

type CategoryFilter = 'all' | OfficialTemplateCategory
type TemplateDraft = Pick<
  OfficialTemplateItem,
  'categories' | 'title' | 'subtitle' | 'thumbnailUrl' | 'method' | 'canvasId' | 'tone' | 'nodes'
>

const CATEGORIES: Array<{ id: CategoryFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片生成/处理' },
  { id: 'video', label: '视频生成/处理' },
  { id: '3d', label: '3D / 多视图' },
]

const EMPTY_DRAFT: TemplateDraft = {
  categories: ['image'], title: '', subtitle: '', thumbnailUrl: '', method: '',
  canvasId: '', tone: '#718d9d', nodes: [],
}

const EDITABLE_CATEGORIES = CATEGORIES.filter(
  (item): item is { id: OfficialTemplateCategory; label: string } => item.id !== 'all',
)

function templateCategories(item: Pick<OfficialTemplateItem, 'category'> & Partial<Pick<OfficialTemplateItem, 'categories'>>) {
  return item.categories?.length ? item.categories : [item.category]
}

function errorText(error: unknown, fallback: string) {
  const candidate = error as { response?: { data?: { error?: string } }; message?: string }
  return candidate?.response?.data?.error || candidate?.message || fallback
}

function projectAsTemplatePayload(project: Project): FavoriteLibraryPayload {
  const nodes = project.nodeList.map((node) => {
    let data: Record<string, unknown>
    try { data = JSON.parse(node.data || '{}') as Record<string, unknown> }
    catch { data = { type: 'upload', name: node.name, url: [], action: 'image_resource' } }
    const type = String(data.type || 'image')
    return {
      id: node.nodeKey, type,
      position: { x: Number(node.position?.positionX || 0), y: Number(node.position?.positionY || 0) },
      width: Number(node.measured?.width || 0) || undefined,
      height: Number(node.measured?.height || 0) || undefined,
      data: { ...data, type, name: String(data.name || node.name || '节点'), nodeKey: node.nodeKey, projectUuid: project.projectMeta.uuid },
    }
  })
  return { version: 1, rootIds: nodes.map((node) => node.id), nodes, edges: [], sourceProjectUuid: project.projectMeta.uuid, sourceProjectName: project.projectMeta.name }
}

export function openLinkedCanvas(
  canvasId: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
) {
  if (!canvasId) return
  const url = new URL(window.location.href)
  url.searchParams.set('project', canvasId)
  // This is an explicit user action from the template editor. Mark it as a
  // one-shot session claim so a full-page navigation can safely replace a
  // stale token for the linked canvas without weakening normal revoked-page
  // protection. The exclusive-session bootstrap consumes and removes it.
  url.searchParams.set('claimCanvasSession', '1')
  navigate(url.toString())
}

export function OfficialTemplateLibrary({ onClose }: { onClose: () => void }) {
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<OfficialTemplateItem[]>([])
  const [canEdit, setCanEdit] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [addingId, setAddingId] = useState('')
  const [addedId, setAddedId] = useState('')
  const [actionError, setActionError] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    officialTemplatesApi.list()
      .then((result) => {
        if (cancelled) return
        setItems(result.items); setCanEdit(result.canEdit); setLoadError('')
      })
      .catch((error) => { if (!cancelled) setLoadError(errorText(error, '模板库读取失败')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return items.filter((item) => (category === 'all' || templateCategories(item).includes(category))
      && (!keyword || `${item.title} ${item.subtitle} ${item.method}`.toLowerCase().includes(keyword)))
  }, [category, items, query])

  const startCreate = () => {
    setEditingId(''); setDraft(EMPTY_DRAFT); setActionError(''); setEditorOpen(true)
  }

  const startEdit = (item: OfficialTemplateItem) => {
    setEditingId(item.id)
    setDraft({ categories: templateCategories(item), title: item.title, subtitle: item.subtitle, thumbnailUrl: item.thumbnailUrl, method: item.method, canvasId: item.canvasId, tone: item.tone, nodes: item.nodes || [] })
    setActionError(''); setEditorOpen(true)
  }

  const saveDraft = async () => {
    if (!draft.title.trim()) return setActionError('请填写标题')
    if (!draft.categories.length) return setActionError('请至少选择一个分类')
    setSaving(true); setActionError('')
    try {
      const { canvasId: _lockedCanvasId, ...editableDraft } = draft
      const editable = { ...editableDraft, category: draft.categories[0] }
      const saved = editingId ? await officialTemplatesApi.update(editingId, editable) : await officialTemplatesApi.create(editable)
      setItems((current) => editingId ? current.map((item) => item.id === editingId ? saved : item) : [...current, saved])
      setEditorOpen(false)
    } catch (error) { setActionError(errorText(error, '模板保存失败')) }
    finally { setSaving(false) }
  }

  const addTemplate = async (template: OfficialTemplateItem) => {
    if (addingId) return
    setAddingId(template.id); setActionError('')
    try {
      if (template.canvasId) {
        const sourceProject = await officialTemplatesApi.source(template.id)
        if (!sourceProject.nodeList.length) throw new Error('关联画布里没有可添加的节点')
        await useCanvasStore.getState().insertFavoritePayload(projectAsTemplatePayload(sourceProject))
      } else {
        const store = useCanvasStore.getState()
        store.pushHistory()
        const created = (template.nodes || []).map((node, index) => {
          const zoom = store.viewport.zoom || 1
          return store.addNodeAt(node.type, (-store.viewport.x + 240) / zoom + index * 320, (-store.viewport.y + 140) / zoom + (index % 2) * 390, { name: node.label, prompt: '' }, { recordHistory: false })
        })
        store.setSelected(created.map((node) => node.id))
      }
      setAddedId(template.id); window.setTimeout(() => setAddedId(''), 1600)
    } catch (error) { setActionError(errorText(error, '模板添加失败')) }
    finally { setAddingId('') }
  }

  const dialog = (
    <div className="shotflow-template-library-overlay" role="dialog" aria-modal="true"
      style={{ position: 'fixed', inset: 0, zIndex: 2147483647, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(0,0,0,.62)', pointerEvents: 'auto', isolation: 'isolate' }}
      onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose() }}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <style>{`
        .shotflow-template-scroll { scrollbar-color: #696969 #202020; scrollbar-width: auto; }
        .shotflow-template-scroll::-webkit-scrollbar { width: 12px; }
        .shotflow-template-scroll::-webkit-scrollbar-track { background: #202020; border-radius: 12px; }
        .shotflow-template-scroll::-webkit-scrollbar-thumb { background: #696969; border: 3px solid #202020; border-radius: 12px; }
        .shotflow-template-field { display: grid; gap: 7px; color: #bbb; font-size: 12px; }
        .shotflow-template-field input, .shotflow-template-field textarea, .shotflow-template-field select { width: 100%; box-sizing: border-box; border: 1px solid #4a4a4a; border-radius: 9px; padding: 10px 11px; outline: none; color: #eee; background: #202020; font: inherit; }
        .shotflow-template-field textarea { min-height: 88px; resize: vertical; }
        .shotflow-template-field input:focus, .shotflow-template-field textarea:focus, .shotflow-template-field select:focus { border-color: #7d75a2; }
      `}</style>
      <div className="shotflow-template-library-dialog" style={{ position: 'relative', width: 1080, maxWidth: '96vw', height: 780, maxHeight: '92vh', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', borderRadius: 22, background: '#292929', color: '#f4f4f4', boxShadow: '0 24px 80px rgba(0,0,0,.5)', pointerEvents: 'auto' }}>
        <header style={{ flex: '0 0 auto', padding: '26px 30px 16px', display: 'flex', justifyContent: 'space-between', gap: 20 }}>
          <div><div style={{ fontSize: 12, letterSpacing: 1.5, color: '#aaa' }}>SHOTFLOW / WORKFLOW LIBRARY</div><h2 style={{ margin: '7px 0 4px', fontSize: 28 }}>官方模板库</h2><div style={{ color: '#b9b9b9' }}>每个模板连接一块可维护的画布，一键复制完整工作流。</div></div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
            {canEdit && <button type="button" data-template-add onClick={startCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 38, padding: '0 13px', border: '1px solid #5f596f', borderRadius: 9, background: '#484359', color: '#fff', cursor: 'pointer' }}><Plus size={16} />添加</button>}
            <button type="button" aria-label="关闭模板库" onClick={onClose} style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', border: 0, borderRadius: 9, background: 'transparent', color: '#ddd', cursor: 'pointer' }}><X size={22} /></button>
          </div>
        </header>
        <div style={{ flex: '0 0 auto', display: 'flex', gap: 8, alignItems: 'center', padding: '0 30px 18px', flexWrap: 'wrap' }}>
          {CATEGORIES.map((item) => <button key={item.id} data-template-category={item.id} type="button" onClick={() => setCategory(item.id)} style={{ border: 0, borderRadius: 10, padding: '9px 14px', color: category === item.id ? '#fff' : '#bbb', background: category === item.id ? '#4a465d' : 'transparent', cursor: 'pointer' }}>{item.label}</button>)}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 38, borderRadius: 10, background: '#1d1d1d', color: '#999' }}><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模板" style={{ width: 150, border: 0, outline: 0, color: '#eee', background: 'transparent' }} /></div>
        </div>
        {actionError && !editorOpen && <div role="alert" style={{ flex: '0 0 auto', margin: '0 30px 12px', padding: '9px 12px', borderRadius: 8, color: '#ffc9c9', background: '#592f2f' }}>{actionError}</div>}
        <main className="shotflow-template-scroll" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'scroll', scrollbarGutter: 'stable', padding: '0 18px 30px 30px' }}>
          {loading && <div style={{ height: 240, display: 'grid', placeItems: 'center', color: '#aaa' }}><span><Loader2 size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />正在读取模板库…</span></div>}
          {!loading && loadError && <div role="alert" style={{ padding: 30, color: '#ffc9c9' }}>{loadError}</div>}
          {!loading && !loadError && filtered.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>没有符合条件的模板</div>}
          {!loading && !loadError && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            {filtered.map((template) => <article key={template.id} data-template-id={template.id} style={{ overflow: 'hidden', borderRadius: 16, background: '#202020', border: '1px solid rgba(255,255,255,.06)' }}>
              <div style={{ height: 132, margin: 14, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'space-evenly', background: 'linear-gradient(180deg,#171c1e,#151718)', borderRadius: 9 }}>
                {template.thumbnailUrl ? <img src={template.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (template.nodes || []).map((node, index) => <div key={`${template.id}-${node.label}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ width: 54, height: 54, display: 'grid', placeItems: 'center', border: `1px solid ${template.tone}`, color: template.tone, background: `${template.tone}18`, fontSize: 10, textAlign: 'center', padding: 3, boxSizing: 'border-box' }}>{node.label}</div>{index < template.nodes.length - 1 && <span style={{ width: 30, height: 1, background: template.tone }} />}</div>)}
                {template.method && <span style={{ position: 'absolute', left: 9, bottom: 9, padding: '4px 8px', borderRadius: 99, fontSize: 11, color: '#fff', background: 'rgba(0,0,0,.68)', backdropFilter: 'blur(6px)' }}>{template.method}</span>}
              </div>
              <div style={{ padding: '0 16px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><h3 style={{ margin: 0, fontSize: 19 }}>{template.title}</h3><span style={{ color: template.canvasId ? '#61e6b2' : '#e4bd68', fontSize: 12 }}>{template.canvasId ? `画布 ${template.canvasId}` : '待关联画布'}</span></div>
                <p style={{ minHeight: 42, margin: '10px 0 14px', color: '#bbb', lineHeight: 1.5 }}>{template.subtitle}</p>
                <div style={{ display: 'grid', gridTemplateColumns: canEdit ? 'minmax(0, 1fr) 92px' : '1fr', gap: 8 }}>
                  <button type="button" onClick={() => void addTemplate(template)} disabled={Boolean(addingId)} style={{ height: 39, border: 0, borderRadius: 9, cursor: addingId ? 'wait' : 'pointer', color: '#fff', background: addedId === template.id ? '#2c7b63' : `${template.tone}48` }}>{addingId === template.id ? <><Loader2 size={15} style={{ verticalAlign: 'middle', marginRight: 5 }} />正在复制…</> : addedId === template.id ? <><Check size={15} style={{ verticalAlign: 'middle', marginRight: 5 }} />已添加到画布</> : '添加到画布 →'}</button>
                  {canEdit && <button type="button" data-template-edit={template.id} onClick={() => startEdit(template)} style={{ height: 39, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: '1px solid #4a4a4a', borderRadius: 9, cursor: 'pointer', color: '#ddd', background: '#292929' }}><Pencil size={14} />编辑</button>}
                </div>
              </div>
            </article>)}
          </div>}
        </main>
        {editorOpen && <section data-template-editor style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(12,12,12,.76)', backdropFilter: 'blur(5px)' }}>
          <div style={{ width: 'min(720px, 92%)', maxHeight: 'calc(100% - 28px)', overflow: 'auto', border: '1px solid #4a4a4a', borderRadius: 16, background: '#2b2b2b', boxShadow: '0 20px 60px rgba(0,0,0,.5)' }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 20px', borderBottom: '1px solid #444', background: '#2b2b2b' }}>
              <div><strong style={{ fontSize: 18 }}>{editingId ? '编辑官方模板' : '添加官方模板'}</strong><div style={{ marginTop: 4, color: '#999', fontSize: 12 }}>模板内容来自关联画布，修改工作流请打开那块画布。</div></div>
              <button type="button" aria-label="关闭模板编辑器" onClick={() => setEditorOpen(false)} style={{ border: 0, background: 'transparent', color: '#ddd', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 20 }}>
              <label className="shotflow-template-field"><span>标题 *</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：角色三视图" /></label>
              <div className="shotflow-template-field" data-template-categories><span>分类 *（可多选）</span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {EDITABLE_CATEGORIES.map((item) => {
                  const selected = draft.categories.includes(item.id)
                  return <button key={item.id} type="button" data-template-category-option={item.id} aria-pressed={selected} onClick={() => setDraft((current) => ({ ...current, categories: selected ? current.categories.filter((category) => category !== item.id) : [...current.categories, item.id] }))} style={{ height: 39, display: 'flex', alignItems: 'center', gap: 6, padding: '0 11px', border: `1px solid ${selected ? '#8178a6' : '#4a4a4a'}`, borderRadius: 9, color: selected ? '#fff' : '#aaa', background: selected ? '#514b68' : '#202020', cursor: 'pointer' }}>{selected && <Check size={14} />}{item.label}</button>
                })}
              </div></div>
              <label className="shotflow-template-field" style={{ gridColumn: '1 / -1' }}><span>副标题</span><textarea value={draft.subtitle} onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} placeholder="说明这个模板能完成什么" /></label>
              <label className="shotflow-template-field"><span>方法</span><input value={draft.method} onChange={(event) => setDraft({ ...draft, method: event.target.value })} placeholder="例如：参考图生成 / FlashVSR" /></label>
              <label className="shotflow-template-field"><span>强调色</span><input type="color" value={draft.tone} onChange={(event) => setDraft({ ...draft, tone: event.target.value })} style={{ height: 39, padding: 4 }} /></label>
              <label className="shotflow-template-field" style={{ gridColumn: '1 / -1' }}><span>缩略图地址</span><input value={draft.thumbnailUrl} onChange={(event) => setDraft({ ...draft, thumbnailUrl: event.target.value })} placeholder="https://… 或 /assets/画布ID/图片.png" /></label>
              <div className="shotflow-template-field" data-template-canvas style={{ gridColumn: '1 / -1' }}><span>专属画布</span><div style={{ minHeight: 39, display: 'flex', alignItems: 'center', padding: '0 11px', border: '1px solid #4a4a4a', borderRadius: 9, color: draft.canvasId ? '#ddd' : '#999', background: '#202020' }}>{draft.canvasId ? '官方模板 · ' + draft.title + ' · 画布 ' + draft.canvasId : '保存后自动创建一块专属画布'}</div><small style={{ color: '#888' }}>模板内容与专属画布严格 1:1；关联创建后不能更换。</small></div>
              {draft.thumbnailUrl && <div style={{ gridColumn: '1 / -1', height: 132, overflow: 'hidden', borderRadius: 10, background: '#1d1d1d' }}><img src={draft.thumbnailUrl} alt="缩略图预览" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>}
            </div>
            {actionError && <div role="alert" style={{ margin: '0 20px 12px', padding: '9px 12px', borderRadius: 8, color: '#ffc9c9', background: '#592f2f' }}>{actionError}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '0 20px 20px' }}>
              <button type="button" onClick={() => openLinkedCanvas(draft.canvasId)} disabled={!draft.canvasId} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 39, padding: '0 13px', border: '1px solid #4a4a4a', borderRadius: 9, cursor: draft.canvasId ? 'pointer' : 'not-allowed', color: '#ddd', background: '#242424' }}><ExternalLink size={14} />打开关联画布</button>
              <div style={{ display: 'flex', gap: 8 }}><button type="button" onClick={() => setEditorOpen(false)} style={{ height: 39, padding: '0 16px', border: '1px solid #4a4a4a', borderRadius: 9, cursor: 'pointer', color: '#ddd', background: 'transparent' }}>取消</button><button type="button" data-template-save onClick={() => void saveDraft()} disabled={saving} style={{ height: 39, minWidth: 96, padding: '0 16px', border: 0, borderRadius: 9, cursor: saving ? 'wait' : 'pointer', color: '#fff', background: '#665f80' }}>{saving ? '保存中…' : '保存'}</button></div>
            </div>
          </div>
        </section>}
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}
