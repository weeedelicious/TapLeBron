import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, KeyRound, Loader2, LogOut, MoreHorizontal, NotebookText, Palette, PlugZap, Share2, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { accountApi, assetsApi, collectionsApi, logsApi, projectsApi, studioApi, type CanvasShareUser } from '@/lib/api'
import { displayDuplicateProgress, estimateDuplicateMs } from '@/lib/duplicateProgress'
import { readStoredShotflowTheme, setShotflowTheme, SHOTFLOW_THEME_OPTIONS, type ShotflowTheme } from '@/lib/theme'
import type { CanvasAssignedProject, CanvasCollection, ProjectGroups, ProjectIndex } from '@/lib/types'
import { getAdminPath, getErrorLibraryPath } from '../../shared/routes'
import { PluginTokenModal } from './PluginTokenModal'
import { ReplaceApiKeyDialog } from './ReplaceApiKeyDialog'
import { ActivityLogsModal } from './TopNav'

interface Props {
  /** name 只用于「正在打开…」那屏的标题，不影响加载本身 */
  onOpen: (uuid: string, name?: string) => void | Promise<void>
  /** 打开「AI 出片」页。入口只对白名单用户显示（服务端 /studio/status 说了算） */
  onOpenStudio: () => void
  user: { username: string; role: 'user' | 'admin' }
  onLogout: () => void
}

type MenuState =
  | {
      type: 'canvas'
      uuid: string
      x: number
      y: number
      mode: 'open' | 'duplicate'
    }
  | {
      type: 'collection'
      id: string
      x: number
      y: number
    }

type AssignedProjectDialogState =
  | {
      mode: 'create'
      collectionId: string | null
    }
  | {
      mode: 'assign'
      uuid: string
    }

type ShareMenuState = {
  uuid: string
  x: number
  y: number
}

type PersonalShareDialogState = {
  uuid: string
  canvasName: string
  loading: boolean
  saving: boolean
  users: CanvasShareUser[]
  selectedUserIds: string[]
  error?: string
}

const COLLECTION_COLLAPSE_STORAGE_KEY = 'shotflow.collection-collapse.v1'
/**
 * 右栏可折叠区块的展开状态。**默认收起**，而且收起时服务端根本不查那一组
 * （见 projectsApi.list 的 skipGroups）—— 所以这个 key 只存"用户手动展开过什么"，
 * 存不到就当全部收起，第一次进页面最省。
 */
const SIDE_SECTION_STORAGE_KEY = 'shotflow.side-section-open.v1'
type SideSectionKey = 'officialTemplates' | 'templates' | 'shared'
const CANVAS_DRAG_MIME = 'application/x-shotflow-canvas'

const MENU_VIEWPORT_MARGIN = 12
const MENU_MIN_USABLE_HEIGHT = 240

function menuPlacementStyle(x: number, y: number, width: number): CSSProperties {
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
  const viewportWidth = typeof window === 'undefined' ? 1600 : window.innerWidth
  const spaceBelow = viewportHeight - y - MENU_VIEWPORT_MARGIN
  // y 是触发按钮的下边缘 + 4，往上翻时按钮上沿大约在 y - 4 - 按钮高度，这里按 y 算够用
  const spaceAbove = y - MENU_VIEWPORT_MARGIN
  const flipUp = spaceBelow < MENU_MIN_USABLE_HEIGHT && spaceAbove > spaceBelow
  const left = Math.max(MENU_VIEWPORT_MARGIN, Math.min(x, viewportWidth - width - MENU_VIEWPORT_MARGIN))
  if (flipUp) {
    return { left, bottom: Math.max(MENU_VIEWPORT_MARGIN, viewportHeight - y + 8), maxHeight: spaceAbove }
  }
  return { left, top: y, maxHeight: Math.max(MENU_MIN_USABLE_HEIGHT, spaceBelow) }
}

function formatDate(ms: number) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatCanvasTimeLabel(label: string, ms?: number) {
  return ms ? `${label} ${formatDate(ms)}` : ''
}

/** 卡片实际宽度 176px，2 倍屏取 352。这个宽度必须在服务端 DERIVED_WIDTHS 白名单里。 */
const COVER_THUMB_WIDTH = 352

/**
 * 把封面地址换成服务端派生的静态缩略图。
 * 服务端认 ?w= 白名单宽度，生成一次 webp 落盘并发永久缓存头；不认（比如还没重启的旧后端、
 * 或者外链封面）就原样返回原图，所以这里加参数是安全的。
 */
function coverThumbUrl(url: string) {
  if (!url.startsWith('/assets/')) return url
  return `${url}${url.includes('?') ? '&' : '?'}w=${COVER_THUMB_WIDTH}`
}

function CoverPlaceholder() {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" opacity={0.2}>
        <rect x="3" y="7" width="30" height="22" rx="3" stroke="#fff" strokeWidth="2" />
        <circle cx="13" cy="16" r="3" stroke="#fff" strokeWidth="2" />
        <path d="M3 26l8-6 7 7 6-5 9 7" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

function ProjectCover({ coverUrl, name }: { coverUrl?: string; name: string }) {
  // 派生图生成失败、或者后端还没重启而封面是 mp4 时，<img> 会报错 —— 这时显示占位图，
  // 不要留一个裂图图标。
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [coverUrl])
  if (!coverUrl || failed) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" opacity={0.2}>
          <rect x="3" y="7" width="30" height="22" rx="3" stroke="#fff" strokeWidth="2" />
          <circle cx="13" cy="16" r="3" stroke="#fff" strokeWidth="2" />
          <path d="M3 26l8-6 7 7 6-5 9 7" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      </div>
    )
  }

  return (
    <img
      // 静态缩略图，不再用 <video> 实时取帧：视频封面由服务端 ffmpeg 抽第一帧成图，
      // 页面上一个 <video> 元素都没有（原来那个 16.56 MB 的 mp4 封面就是靠浏览器边下边解出帧的）。
      src={coverThumbUrl(coverUrl)}
      alt={`${name} cover`}
      draggable={false}
      onError={() => setFailed(true)}
      // 封面现在指向的是**资产原图**：线上实测持有 25 张画布的人，22 个封面合计 71.91 MB，
      // 图片中位数 2037 KB、最大 9654 KB，而卡片只有 176px 宽。在服务端缩略图做好之前，
      // 至少别让整页 22 张一进来就全下 —— lazy 交给浏览器只取视口附近的。
      // decoding=async：别让大图解码卡住主线程（2MB 的图解码本身就有几十毫秒）。
      loading="lazy"
      decoding="async"
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
    />
  )
}

function EmptyPanel({ title }: { title: string }) {
  return (
    <div
      className="shotflow-project-empty-panel"
      style={{
        minHeight: 180,
        borderRadius: 12,
        border: '1px solid #201c2d',
        background: '#12101a',
        color: '#6f6788',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 24,
        fontSize: 14,
      }}
    >
      {title}
    </div>
  )
}

export function ProjectList({ onOpen, onOpenStudio, user, onLogout }: Props) {
  // AI 出片入口只对白名单用户显示，白名单在服务端（config.studio.allowedUserIds），
  // 前端只问一句"我能不能看到"，不在前端写死用户名。
  const [studioEnabled, setStudioEnabled] = useState(false)
  const [groups, setGroups] = useState<ProjectGroups>({
    ownCanvases: [],
    officialTemplateCanvases: [],
    templateCanvases: [],
    sharedCanvases: [],
    personalSharedCanvases: [],
    ownCollections: [],
    shotflowCategories: [],
    availableProjects: [],
  })
  const [selectedOwnerId, setSelectedOwnerId] = useState('')
  const [loading, setLoading] = useState(true)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [shareMenu, setShareMenu] = useState<ShareMenuState | null>(null)
  const [personalShareDialog, setPersonalShareDialog] = useState<PersonalShareDialogState | null>(null)
  const [assignedProjectDialog, setAssignedProjectDialog] = useState<AssignedProjectDialogState | null>(null)
  const [newCanvasName, setNewCanvasName] = useState('')
  const [selectedAssignedProjectId, setSelectedAssignedProjectId] = useState('')
  const [workingUuid, setWorkingUuid] = useState<string | null>(null)
  const [duplicateStartedAtMs, setDuplicateStartedAtMs] = useState<number | null>(null)
  const [duplicateNowMs, setDuplicateNowMs] = useState(() => Date.now())
  const [openingUuid, setOpeningUuid] = useState<string | null>(null)
  const [sharingUuid, setSharingUuid] = useState<string | null>(null)
  const [editingCanvasUuid, setEditingCanvasUuid] = useState<string | null>(null)
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null)
  const [draggingCanvasUuid, setDraggingCanvasUuid] = useState<string | null>(null)
  const [dragOverCollectionId, setDragOverCollectionId] = useState<string | null>(null)
  const [dragOverUngrouped, setDragOverUngrouped] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const shareMenuRef = useRef<HTMLDivElement>(null)
  const headerMenuRef = useRef<HTMLDivElement>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [activityLogVersion, setActivityLogVersion] = useState('')
  const [pluginTokenOpen, setPluginTokenOpen] = useState(false)
  const [replaceApiKeyOpen, setReplaceApiKeyOpen] = useState(false)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [theme, setTheme] = useState<ShotflowTheme>(readStoredShotflowTheme)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const [pendingCoverUuid, setPendingCoverUuid] = useState<string | null>(null)
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      return JSON.parse(window.localStorage.getItem(COLLECTION_COLLAPSE_STORAGE_KEY) || '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  // 右栏「画布模版」「共享画布」的展开状态，默认收起。
  const [sideOpen, setSideOpen] = useState<Record<SideSectionKey, boolean>>(() => {
    const fallback = { officialTemplates: false, templates: false, shared: false }
    if (typeof window === 'undefined') return fallback
    try {
      const stored = JSON.parse(window.localStorage.getItem(SIDE_SECTION_STORAGE_KEY) || '{}')
      return { officialTemplates: Boolean(stored?.officialTemplates), templates: Boolean(stored?.templates), shared: Boolean(stored?.shared) }
    } catch {
      return fallback
    }
  })
  // 那一组的数据是否已经拿到。收起时服务端不查、返回空数组，所以"空"有两种含义：
  // 真的没有，或者压根没加载。分开记，头上的数量角标才不会在没加载时显示一个骗人的 0。
  const [sideLoaded, setSideLoaded] = useState<Record<SideSectionKey, boolean>>({
    officialTemplates: false,
    templates: false,
    shared: false,
  })
  const [sideLoading, setSideLoading] = useState<Record<SideSectionKey, boolean>>({
    officialTemplates: false,
    templates: false,
    shared: false,
  })
  const isAdmin = user.role === 'admin'
  const canViewErrorLibrary = user.username.trim() === '吴逸翔'

  const markActivityLogSeen = useCallback(() => {
    if (typeof window === 'undefined' || !activityLogVersion) return
    window.localStorage.setItem(
      `shotflow.activity-log.seen.v1:${user.username.trim()}`,
      activityLogVersion,
    )
  }, [activityLogVersion, user.username])

  const closeActivityLog = useCallback(() => {
    markActivityLogSeen()
    setLogOpen(false)
  }, [markActivityLogSeen])

  const refreshApiKeyStatus = useCallback(async () => {
    try {
      const status = await accountApi.status()
      setHasApiKey(Boolean(status.hasApiKey))
    } catch {
      setHasApiKey(null)
    }
  }, [])

  useEffect(() => {
    void refreshApiKeyStatus()
  }, [refreshApiKeyStatus])

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    void logsApi.list().then((data) => {
      if (cancelled) return
      const version = String(data.version || 'empty')
      setActivityLogVersion(version)
      if (version === 'empty' || !Array.isArray(data.logs) || data.logs.length === 0) return
      const key = `shotflow.activity-log.seen.v1:${user.username.trim()}`
      if (window.localStorage.getItem(key) !== version) setLogOpen(true)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [user.username])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(COLLECTION_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsedCollections))
  }, [collapsedCollections])

  // load() 要按当前展开状态决定跳过哪几组，但不能把 sideOpen 放进它的依赖里 ——
  // 那样每次折叠/展开都会触发一次整页重载（连"我的画布"一起重拉，还会闪一次整页 loading）。
  // 所以用 ref 读，展开时只补那一组（见 toggleSideSection）。
  const sideOpenRef = useRef(sideOpen)
  useEffect(() => {
    sideOpenRef.current = sideOpen
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SIDE_SECTION_STORAGE_KEY, JSON.stringify(sideOpen))
  }, [sideOpen])

  // 同理用 ref 读：load 里要知道"哪几组已经加载过"，但把 sideLoaded 放进它的依赖会变成
  // load → setSideLoaded → 新的 load → effect 重跑 → load…… 一个死循环。
  const sideLoadedRef = useRef(sideLoaded)
  useEffect(() => {
    sideLoadedRef.current = sideLoaded
  }, [sideLoaded])

  // 首屏与"管理员切换了查看对象"才显示整页「加载中…」，见 load()
  const hasLoadedRef = useRef(false)
  const loadedOwnerRef = useRef<string | null>(null)

  const allCanvases = useMemo(
    () => [
      ...groups.ownCanvases,
      ...groups.officialTemplateCanvases,
      ...groups.templateCanvases,
      ...groups.sharedCanvases,
      ...(groups.personalSharedCanvases ?? []),
    ],
    [groups.ownCanvases, groups.officialTemplateCanvases, groups.templateCanvases, groups.sharedCanvases, groups.personalSharedCanvases]
  )

  const selectableAssignedProjects = useMemo(
    () =>
      groups.availableProjects.filter(
        (project) => project.status === 'in_progress' && project.shotflowApplicable !== false
      ),
    [groups.availableProjects]
  )

  const defaultAssignedProjectId = useMemo(
    () =>
      selectableAssignedProjects.find((project) => project.name === '测试')?.id ?? selectableAssignedProjects[0]?.id ?? '',
    [selectableAssignedProjects]
  )

  // 分类名 → sd2 分类 id。分类块是 sd2 那份名单的镜像，所以按名字对得上。
  const categoryIdByName = useMemo(() => {
    const map = new Map<string, number>()
    for (const category of groups.shotflowCategories ?? []) map.set(category.name, category.id)
    return map
  }, [groups.shotflowCategories])

  // 名单里的第一个分类（测试）是兜底分类：它不做过滤，项目下拉给全量。
  // 用"第一个"而不是写死"测试"两个字 —— 跟迁移脚本、服务端对齐用的是同一个口径。
  const catchAllCategoryId = useMemo(
    () => (groups.shotflowCategories ?? [])[0]?.id ?? null,
    [groups.shotflowCategories]
  )

  // 从某个分类块里点"新建画布"时，项目下拉只显示属于这个分类的项目（分类归属来自
  // sd2 项目管理页的 shotflow 画布分类列）。测试分类和"我的画布"那种没有分类的入口给全量。
  const projectsForCollection = useCallback(
    (collectionId: string | null) => {
      if (!collectionId) return selectableAssignedProjects
      const collection = groups.ownCollections.find((item) => item.id === collectionId)
      const categoryId = collection ? categoryIdByName.get(collection.name) ?? null : null
      if (categoryId == null || categoryId === catchAllCategoryId) return selectableAssignedProjects
      return selectableAssignedProjects.filter((project) => Number(project.shotflowCategoryId) === categoryId)
    },
    [catchAllCategoryId, categoryIdByName, groups.ownCollections, selectableAssignedProjects]
  )

  const selectedCanvasOwner = useMemo(
    () => groups.canvasOwners?.find((owner) => owner.id === selectedOwnerId) ?? null,
    [groups.canvasOwners, selectedOwnerId]
  )

  const ownerSwitcher = isAdmin && groups.canvasOwners?.length ? (
    <select
      className="shotflow-owner-switcher"
      value={selectedOwnerId || groups.selectedOwnerId || ''}
      onChange={(event) => {
        setMenu(null)
        setSelectedOwnerId(event.target.value)
      }}
      disabled={loading}
      style={{
        height: 28,
        minWidth: 132,
        maxWidth: 190,
        border: '1px solid #312550',
        borderRadius: 8,
        background: '#171322',
        color: '#d9cffd',
        fontSize: 12,
        fontWeight: 700,
        padding: '0 9px',
        outline: 'none',
        cursor: loading ? 'wait' : 'pointer',
      }}
      title="切换查看不同用户的画布"
    >
      {groups.canvasOwners.map((owner) => (
        <option key={owner.id} value={owner.id}>
          {owner.username}（{owner.canvasCount}）
        </option>
      ))}
    </select>
  ) : null

  const findCanvas = useCallback(
    (uuid: string) => allCanvases.find((canvas) => canvas.uuid === uuid),
    [allCanvases]
  )

  const findCollection = useCallback(
    (id: string) => groups.ownCollections.find((collection) => collection.id === id),
    [groups.ownCollections]
  )

  const ungroupedOwnCanvases = useMemo(
    () => groups.ownCanvases.filter((canvas) => !canvas.collectionId),
    [groups.ownCanvases]
  )

  const canvasesByCollection = useMemo(() => {
    const map = new Map<string, ProjectIndex[]>()
    for (const canvas of groups.ownCanvases) {
      if (!canvas.collectionId) continue
      const current = map.get(canvas.collectionId) ?? []
      current.push(canvas)
      map.set(canvas.collectionId, current)
    }
    return map
  }, [groups.ownCanvases])

  useEffect(() => {
    let cancelled = false
    studioApi.status()
      .then((status) => { if (!cancelled) setStudioEnabled(Boolean(status.enabled)) })
      .catch(() => { if (!cancelled) setStudioEnabled(false) })
    return () => { cancelled = true }
  }, [])

  const load = useCallback(async () => {
    const ownerParam = isAdmin && selectedOwnerId ? selectedOwnerId : null
    // 整页「加载中…」只留给首屏，以及管理员切换查看对象（那时整份列表换人，
    // 继续显示上一个人的画布更糟）。其余任何操作触发的重载都在原地更新 ——
    // 以前新建 / 改名 / 删除 / 复制都会把整页替换成「加载中…」再画回来，
    // 用户看到的就是"新建画布后页面刷新了一下"。
    const ownerChanged = loadedOwnerRef.current !== null && loadedOwnerRef.current !== ownerParam
    if (!hasLoadedRef.current || ownerChanged) setLoading(true)
    try {
      // 收起的区块直接让服务端别查（省一次查询 + 每行一次建目录 + 一次行转换）
      const open = sideOpenRef.current
      const skip: Array<'officialTemplates' | 'templates' | 'shared'> = []
      if (!open.officialTemplates) skip.push('officialTemplates')
      if (!open.templates) skip.push('templates')
      if (!open.shared) skip.push('shared')
      const nextGroups = await projectsApi.list(ownerParam ?? undefined, skip)
      // 被 skip 的那两组服务端返回的是空数组，**不能拿它盖掉上次已经加载好的数据** ——
      // 否则"展开过一次 → 收起 → 随便做个操作触发重载 → 再展开"就又得重新加载一次。
      // 这两组跟 selectedOwnerId 无关（服务端查它们时不带 owner），所以跨切换保留也是对的。
      const loaded = sideLoadedRef.current
      setGroups((prev) => ({
        ...nextGroups,
        officialTemplateCanvases: open.officialTemplates ? nextGroups.officialTemplateCanvases : prev.officialTemplateCanvases,
        templateCanvases: open.templates ? nextGroups.templateCanvases : prev.templateCanvases,
        sharedCanvases: open.shared ? nextGroups.sharedCanvases : prev.sharedCanvases,
        personalSharedCanvases: nextGroups.personalSharedCanvases ?? [],
      }))
      // 已经加载过的就一直算加载过：数据还在手上，下次展开直接显示，不再发请求
      setSideLoaded({
        officialTemplates: open.officialTemplates || loaded.officialTemplates,
        templates: open.templates || loaded.templates,
        shared: open.shared || loaded.shared,
      })
      if (!selectedOwnerId && nextGroups.selectedOwnerId) {
        setSelectedOwnerId(nextGroups.selectedOwnerId)
      }
      loadedOwnerRef.current = ownerParam
      hasLoadedRef.current = true
    } finally {
      setLoading(false)
    }
  }, [isAdmin, selectedOwnerId])

  /**
   * 折叠 / 展开右栏区块。
   *
   * 只有"这一组这次进页面还没加载过"时才发请求，而且只补这一组（请求里把另外两组全
   * skip 掉），不顺手把整页数据重拉。收起不发请求；**加载过之后无论收起展开多少次都不再发**
   * —— 数据一直留在 groups 里，load() 也不会拿服务端返回的空数组把它盖掉。
   * 想要最新的就重新进一次页面（管理页没有单独的刷新按钮）。
   */
  const toggleSideSection = useCallback(async (key: SideSectionKey) => {
    const opening = !sideOpenRef.current[key]
    setSideOpen((prev) => ({ ...prev, [key]: opening }))
    if (!opening || sideLoaded[key] || sideLoading[key]) return
    setSideLoading((prev) => ({ ...prev, [key]: true }))
    try {
      const skip = (['officialTemplates', 'templates', 'shared', 'personalShared'] as const).filter((item) => item !== key)
      const data = await projectsApi.list(
        isAdmin && selectedOwnerId ? selectedOwnerId : undefined,
        [...skip],
      )
      setGroups((prev) => {
        if (key === 'officialTemplates') return { ...prev, officialTemplateCanvases: data.officialTemplateCanvases }
        if (key === 'templates') return { ...prev, templateCanvases: data.templateCanvases }
        return { ...prev, sharedCanvases: data.sharedCanvases }
      })
      setSideLoaded((prev) => ({ ...prev, [key]: true }))
    } catch (error) {
      console.error('load side section failed', key, error)
      // 拉失败就收回去，别让用户对着一个空区块以为"真的没有"
      setSideOpen((prev) => ({ ...prev, [key]: false }))
      window.alert(key === 'officialTemplates' ? '官方画布模板加载失败，请重试' : key === 'templates' ? '画布模版加载失败，请重试' : '共享画布加载失败，请重试')
    } finally {
      setSideLoading((prev) => ({ ...prev, [key]: false }))
    }
  }, [isAdmin, selectedOwnerId, sideLoaded, sideLoading])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!menu) return
    const closeMenu = (e: globalThis.MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenu(null)
      }
    }
    document.addEventListener('mousedown', closeMenu, true)
    return () => document.removeEventListener('mousedown', closeMenu, true)
  }, [menu])

  useEffect(() => {
    if (!shareMenu) return
    const closeShareMenu = (e: globalThis.MouseEvent) => {
      if (!shareMenuRef.current?.contains(e.target as Node)) {
        setShareMenu(null)
      }
    }
    document.addEventListener('mousedown', closeShareMenu, true)
    return () => document.removeEventListener('mousedown', closeShareMenu, true)
  }, [shareMenu])

  // 鼠标在弹出菜单里滚轮时，别让底下的画布管理页跟着滚。
  // CSS 的 overscroll-behavior: contain 只在菜单本身可滚动时管用；菜单短到不出滚动条时
  // 滚轮会直接落到页面上。所以这里挂一个 non-passive 的原生监听：菜单在这个方向上
  // 还能滚就放行，滚不动（或根本不可滚）就 preventDefault 吃掉。
  // 必须用原生监听 —— React 的 onWheel 是被动注册的，preventDefault 不生效。
  useEffect(() => {
    if (!menu && !shareMenu) return
    const onWheel = (event: globalThis.WheelEvent) => {
      const target = event.target as Element | null
      const panel = target?.closest?.('.shotflow-project-menu') as HTMLElement | null
      if (!panel) return
      const canScrollDown = panel.scrollTop + panel.clientHeight < panel.scrollHeight - 1
      const canScrollUp = panel.scrollTop > 0
      const wantsDown = event.deltaY > 0
      if ((wantsDown && canScrollDown) || (!wantsDown && canScrollUp)) return
      event.preventDefault()
    }
    document.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => document.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
  }, [menu, shareMenu])

  useEffect(() => {
    if (!headerMenuOpen) return
    const closeHeaderMenu = (event: globalThis.MouseEvent) => {
      if (!headerMenuRef.current?.contains(event.target as Node)) setHeaderMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHeaderMenuOpen(false)
    }
    document.addEventListener('mousedown', closeHeaderMenu, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeHeaderMenu, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [headerMenuOpen])

  // name 只用来让「正在打开…」那屏显示画布名（CanvasOpeningScreen）。
  // 以前这里传的是预览缓存里那份完整画布，但 App.tsx 收到后是 `void prefetchedProject`
  // 直接丢掉、始终重新 projectsApi.get(uuid) —— 那个参数从来没真的省过一次请求，
  // 唯一实际作用就是取里面的名字。预览功能删掉后就直接把名字传过去。
  const handleOpenCanvas = useCallback(async (uuid: string, name?: string) => {
    if (openingUuid || workingUuid) return
    setMenu(null)
    setOpeningUuid(uuid)
    try {
      await onOpen(uuid, name)
    } catch (error) {
      console.error('open canvas failed', error)
      window.alert('画布打开失败，请刷新后重试')
    } finally {
      setOpeningUuid(null)
    }
  }, [onOpen, openingUuid, workingUuid])

  // 建完停在画布管理页，不跳进画布。名字可以留空，留空就用「未命名画布」。
  const handleCreateCanvas = useCallback(
    async (collectionId: string | null = null, assignedProjectId: string | null = null, name = '') => {
      const canvasName = name.trim() || '未命名画布'
      await projectsApi.create(canvasName, collectionId, assignedProjectId)
      // 建在折叠着的分类里的话，展开它，否则新画布看不见
      if (collectionId) setCollapsedCollections((prev) => ({ ...prev, [collectionId]: false }))
      await load()
    },
    [load]
  )

  const handleCreateCollection = useCallback(async () => {
    const { collection } = await collectionsApi.create('未命名分类')
    setCollapsedCollections((prev) => ({ ...prev, [collection.id]: false }))
    await load()
    setEditingCollectionId(collection.id)
  }, [load])

  const handleRenameCanvas = useCallback(
    (uuid: string) => {
      const current = findCanvas(uuid)
      if (!current?.canManage) return
      setMenu(null)
      setEditingCanvasUuid(uuid)
    },
    [findCanvas]
  )

  const handleRenameCanvasSubmit = useCallback(
    async (uuid: string, name: string) => {
      const current = findCanvas(uuid)
      if (!current?.canManage) return
      const nextName = name.trim()
      setEditingCanvasUuid(null)
      if (!nextName || nextName === current.name) return
      await projectsApi.rename(uuid, nextName)
      await load()
    },
    [findCanvas, load]
  )

  const handleRenameCollectionSubmit = useCallback(
    async (id: string, name: string) => {
      const current = findCollection(id)
      const nextName = name.trim()
      setEditingCollectionId(null)
      if (!current || !nextName || nextName === current.name) return
      await collectionsApi.rename(id, nextName)
      await load()
    },
    [findCollection, load]
  )

  const handleDeleteCanvas = useCallback(
    async (uuid: string) => {
      if (!window.confirm('确认删除这个画布吗？')) return
      await projectsApi.delete(uuid)
      setMenu(null)
      await load()
    },
    [load]
  )

  const handleDeleteCollection = useCallback(
    async (id: string) => {
      if (!window.confirm('确认删除这个分类吗？分类里的画布会回到“我的画布”。')) return
      await collectionsApi.delete(id)
      setMenu(null)
      await load()
    },
    [load]
  )

  const handleDuplicate = useCallback(
    async (uuid: string) => {
      if (workingUuid) return
      setWorkingUuid(uuid)
      setDuplicateStartedAtMs(Date.now())
      try {
        setMenu(null)
        const source = findCanvas(uuid)
        const name = `${source?.name ?? '未命名画布'} - 副本`
        await projectsApi.duplicate(uuid, name)
        await load()
      } finally {
        setWorkingUuid(null)
        setDuplicateStartedAtMs(null)
      }
    },
    [findCanvas, load, workingUuid]
  )

  useEffect(() => {
    if (!workingUuid || duplicateStartedAtMs == null) return undefined
    setDuplicateNowMs(Date.now())
    const timer = window.setInterval(() => setDuplicateNowMs(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [workingUuid, duplicateStartedAtMs])

  const duplicateSource = workingUuid ? findCanvas(workingUuid) : undefined
  const duplicateProgress = workingUuid && duplicateStartedAtMs != null
    ? displayDuplicateProgress({
        startedAtMs: duplicateStartedAtMs,
        estimatedMs: estimateDuplicateMs(duplicateSource?.nodeCount),
        nowMs: duplicateNowMs,
      })
    : null

  const updateCanvasSharedState = useCallback((uuid: string, shared: boolean) => {
    setGroups((prev) => ({
      ...prev,
      ownCanvases: prev.ownCanvases.map((canvas) =>
        canvas.uuid === uuid ? { ...canvas, isShared: shared } : canvas
      ),
      officialTemplateCanvases: prev.officialTemplateCanvases.map((canvas) =>
        canvas.uuid === uuid ? { ...canvas, isShared: shared } : canvas
      ),
      templateCanvases: prev.templateCanvases.map((canvas) =>
        canvas.uuid === uuid ? { ...canvas, isShared: shared } : canvas
      ),
      sharedCanvases: prev.sharedCanvases.map((canvas) =>
        canvas.uuid === uuid ? { ...canvas, isShared: shared } : canvas
      ),
      personalSharedCanvases: (prev.personalSharedCanvases ?? []).map((canvas) =>
        canvas.uuid === uuid ? { ...canvas, isShared: shared } : canvas
      ),
    }))
  }, [])

  const handleToggleShare = useCallback(
    async (uuid: string, shared: boolean) => {
      const current = findCanvas(uuid)
      if (!current?.canManage || sharingUuid) return
      setSharingUuid(uuid)
      setShareMenu(null)
      updateCanvasSharedState(uuid, shared)
      try {
        await projectsApi.setShared(uuid, shared)
        setMenu(null)
        await load()
      } catch (error) {
        updateCanvasSharedState(uuid, Boolean(current.isShared))
        console.error('toggle canvas share failed', error)
        window.alert('共享状态更新失败')
      } finally {
        setSharingUuid(null)
      }
    },
    [findCanvas, load, sharingUuid, updateCanvasSharedState]
  )

  const openShareMenu = useCallback((uuid: string, e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu(null)
    setShareMenu({ uuid, x: Math.max(12, rect.right - 190), y: rect.bottom + 6 })
  }, [])

  const openPersonalShareDialog = useCallback(
    async (uuid: string) => {
      const canvas = findCanvas(uuid)
      if (!canvas?.canManage) return
      setShareMenu(null)
      setMenu(null)
      setPersonalShareDialog({
        uuid,
        canvasName: canvas.name,
        loading: true,
        saving: false,
        users: [],
        selectedUserIds: [],
      })
      try {
        const data = await projectsApi.getUserShares(uuid)
        setPersonalShareDialog((prev) =>
          prev && prev.uuid === uuid
            ? {
                ...prev,
                loading: false,
                users: data.users,
                selectedUserIds: data.sharedUserIds,
              }
            : prev
        )
      } catch (error) {
        console.error('load canvas user shares failed', error)
        setPersonalShareDialog((prev) =>
          prev && prev.uuid === uuid
            ? {
                ...prev,
                loading: false,
                error: '分享名单加载失败，请稍后重试。',
              }
            : prev
        )
      }
    },
    [findCanvas]
  )

  const togglePersonalShareUser = useCallback((userId: string) => {
    setPersonalShareDialog((prev) => {
      if (!prev) return prev
      const exists = prev.selectedUserIds.includes(userId)
      return {
        ...prev,
        selectedUserIds: exists
          ? prev.selectedUserIds.filter((id) => id !== userId)
          : [...prev.selectedUserIds, userId],
        error: undefined,
      }
    })
  }, [])

  const handleSavePersonalShares = useCallback(async () => {
    const dialog = personalShareDialog
    if (!dialog || dialog.loading || dialog.saving) return
    setPersonalShareDialog((prev) => (prev ? { ...prev, saving: true, error: undefined } : prev))
    try {
      await projectsApi.updateUserShares(dialog.uuid, dialog.selectedUserIds)
      setPersonalShareDialog(null)
      await load()
    } catch (error) {
      console.error('save canvas user shares failed', error)
      setPersonalShareDialog((prev) =>
        prev ? { ...prev, saving: false, error: '分享保存失败，请稍后重试。' } : prev
      )
    }
  }, [load, personalShareDialog])

  const handleCreateTemplate = useCallback(
    async (uuid: string) => {
      if (workingUuid) return
      const source = findCanvas(uuid)
      if (!source) return
      setWorkingUuid(uuid)
      setDuplicateStartedAtMs(Date.now())
      try {
        setMenu(null)
        await projectsApi.createTemplate(uuid, `${source.name} 模版`)
        await load()
      } finally {
        setWorkingUuid(null)
        setDuplicateStartedAtMs(null)
      }
    },
    [findCanvas, load, workingUuid]
  )

  const handleMoveToCollection = useCallback(
    async (uuid: string, collectionId: string | null) => {
      await projectsApi.moveToCollection(uuid, collectionId)
      setMenu(null)
      await load()
    },
    [load]
  )

  const handleAssignProject = useCallback(
    async (uuid: string, assignedProjectId: string | null) => {
      await projectsApi.assignProject(uuid, assignedProjectId)
      setMenu(null)
      await load()
    },
    [load]
  )

  // 从分类块里新建画布时，项目下拉只列属于该分类的项目；改已有画布的所属项目仍给全量
  const dialogProjects = useMemo(
    () =>
      assignedProjectDialog?.mode === 'create'
        ? projectsForCollection(assignedProjectDialog.collectionId)
        : selectableAssignedProjects,
    [assignedProjectDialog, projectsForCollection, selectableAssignedProjects]
  )

  const openCreateCanvasDialog = useCallback(
    (collectionId: string | null = null) => {
      setMenu(null)
      const scoped = projectsForCollection(collectionId)
      setSelectedAssignedProjectId(scoped[0]?.id ?? '')
      setNewCanvasName('')
      setAssignedProjectDialog({ mode: 'create', collectionId })
    },
    [projectsForCollection]
  )

  const openAssignProjectDialog = useCallback(
    (uuid: string) => {
      const canvas = findCanvas(uuid)
      if (!canvas?.canManage) return
      setMenu(null)
      const currentAssignedProjectId = canvas.assignedProjectId ?? ''
      const canKeepCurrentProject = selectableAssignedProjects.some((project) => project.id === currentAssignedProjectId)
      setSelectedAssignedProjectId(canKeepCurrentProject ? currentAssignedProjectId : defaultAssignedProjectId)
      setAssignedProjectDialog({ mode: 'assign', uuid })
    },
    [defaultAssignedProjectId, findCanvas, selectableAssignedProjects]
  )

  const closeAssignedProjectDialog = useCallback(() => {
    setAssignedProjectDialog(null)
  }, [])

  const confirmAssignedProjectDialog = useCallback(async () => {
    if (!assignedProjectDialog) return
    // 兜底值必须取"这个弹窗实际列出的项目"。分类块过滤过之后，用全局 default
    // 会把画布静默建到别的分类的项目里去。
    const fallbackProjectId = dialogProjects[0]?.id ?? ''
    const listedProjectId = dialogProjects.some((project) => project.id === selectedAssignedProjectId)
      ? selectedAssignedProjectId
      : fallbackProjectId
    if (!listedProjectId) {
      window.alert(
        assignedProjectDialog.mode === 'create' && assignedProjectDialog.collectionId
          ? '这个分类下还没有“进行中”的项目。去项目管理页把项目归到这个画布分类，或把状态改成进行中。'
          : '请先在后台管理里把项目状态设置为“进行中”'
      )
      return
    }
    const nextProjectId = listedProjectId

    const dialogState = assignedProjectDialog
    setAssignedProjectDialog(null)

    if (dialogState.mode === 'create') {
      await handleCreateCanvas(dialogState.collectionId, nextProjectId, newCanvasName)
      return
    }

    await handleAssignProject(dialogState.uuid, nextProjectId)
  }, [assignedProjectDialog, dialogProjects, handleAssignProject, handleCreateCanvas, newCanvasName, selectedAssignedProjectId])

  const endCanvasDrag = useCallback(() => {
    setDraggingCanvasUuid(null)
    setDragOverCollectionId(null)
    setDragOverUngrouped(false)
  }, [])

  const beginCanvasDrag = useCallback((uuid: string) => {
    setMenu(null)
    setShareMenu(null)
    setDraggingCanvasUuid(uuid)
  }, [])

  const getDraggedCanvasUuid = useCallback(
    (event: DragEvent<HTMLElement>) => event.dataTransfer.getData(CANVAS_DRAG_MIME) || draggingCanvasUuid || '',
    [draggingCanvasUuid]
  )

  const canDropCanvas = useCallback(
    (uuid: string, collectionId: string | null) => {
      const canvas = findCanvas(uuid)
      if (!canvas?.canManage) return false
      return (canvas.collectionId ?? null) !== collectionId
    },
    [findCanvas]
  )

  const handleCollectionDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, collectionId: string) => {
      const uuid = getDraggedCanvasUuid(event)
      if (!uuid || !canDropCanvas(uuid, collectionId)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOverCollectionId(collectionId)
      setDragOverUngrouped(false)
    },
    [canDropCanvas, getDraggedCanvasUuid]
  )

  const handleUngroupedDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const uuid = getDraggedCanvasUuid(event)
      if (!uuid || !canDropCanvas(uuid, null)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOverUngrouped(true)
      setDragOverCollectionId(null)
    },
    [canDropCanvas, getDraggedCanvasUuid]
  )

  const handleDropToCollection = useCallback(
    async (event: DragEvent<HTMLDivElement>, collectionId: string) => {
      event.preventDefault()
      event.stopPropagation()
      const uuid = getDraggedCanvasUuid(event)
      endCanvasDrag()
      if (!uuid || !canDropCanvas(uuid, collectionId)) return
      await handleMoveToCollection(uuid, collectionId)
    },
    [canDropCanvas, endCanvasDrag, getDraggedCanvasUuid, handleMoveToCollection]
  )

  const handleDropToUngrouped = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const uuid = getDraggedCanvasUuid(event)
      endCanvasDrag()
      if (!uuid || !canDropCanvas(uuid, null)) return
      await handleMoveToCollection(uuid, null)
    },
    [canDropCanvas, endCanvasDrag, getDraggedCanvasUuid, handleMoveToCollection]
  )

  const handleDropZoneLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget && event.currentTarget.contains(nextTarget)) return
    setDragOverCollectionId(null)
    setDragOverUngrouped(false)
  }, [])

  const handleChangeCover = useCallback((uuid: string) => {
    setMenu(null)
    setPendingCoverUuid(uuid)
    coverInputRef.current?.click()
  }, [])

  const handleCoverFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !pendingCoverUuid) return
      e.target.value = ''
      try {
        const { url } = await assetsApi.upload(pendingCoverUuid, file)
        await fetch(`/api/projects/${pendingCoverUuid}/cover`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coverUrl: url }),
        })
        await load()
      } catch (err) {
        alert(`封面上传失败：${String(err)}`)
      } finally {
        setPendingCoverUuid(null)
      }
    },
    [load, pendingCoverUuid]
  )

  const toggleCollectionCollapse = useCallback((id: string) => {
    setCollapsedCollections((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const openCanvasMenu = useCallback((uuid: string, e: MouseEvent, mode: 'open' | 'duplicate') => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setShareMenu(null)
    setMenu({ type: 'canvas', uuid, x: rect.left, y: rect.bottom + 4, mode })
  }, [])

  const openCollectionMenu = useCallback((id: string, e: MouseEvent) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setShareMenu(null)
    setMenu({ type: 'collection', id, x: rect.left, y: rect.bottom + 4 })
  }, [])

  const menuCanvas = menu?.type === 'canvas' ? findCanvas(menu.uuid) : null
  const shareMenuCanvas = shareMenu ? findCanvas(shareMenu.uuid) : null
  const menuCollection = menu?.type === 'collection' ? findCollection(menu.id) : null
  const dialogCanvas = assignedProjectDialog?.mode === 'assign' ? findCanvas(assignedProjectDialog.uuid) : null

  return (
    <div className="shotflow-project-page" style={{ minHeight: '100vh', background: '#0e0e0e', color: '#e5e5e5', userSelect: 'none' }}>
      <div
        className="shotflow-project-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '18px 32px',
          borderBottom: '1px solid #1e1e1e',
          background: '#0e0e0e',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div
          className="project-page-title-lock shotflow-project-title"
          style={{ display: 'flex', alignItems: 'center', gap: 12, userSelect: 'none', WebkitUserSelect: 'none' }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <img
            src="/shotflow-logo.svg"
            alt="Shotflow"
            draggable={false}
            style={{ height: 34, width: 'auto', display: 'block', objectFit: 'contain', pointerEvents: 'none' }}
          />
          <div style={{ width: 1, height: 16, background: '#333', pointerEvents: 'none' }} />
          <span
            style={{
              fontSize: 14,
              color: '#888',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              cursor: 'default',
              pointerEvents: 'none',
            }}
          >
            画布管理
          </span>
        </div>

        <div className="shotflow-project-header-actions">
          {studioEnabled ? (
            <button
              type="button"
              className="shotflow-studio-entry"
              title="AI 出片：填大纲自动出文字分镜，并在你的「测试」分类里建对应画布"
              onClick={onOpenStudio}
            >
              <Sparkles size={14} strokeWidth={2.2} />
              AI 出片
            </button>
          ) : null}
          {hasApiKey === false ? (
            <button
              type="button"
              className="shotflow-missing-apikey-hint"
              onClick={() => setReplaceApiKeyOpen(true)}
            >
              请尽快设置 API Key
            </button>
          ) : null}
          <button
            type="button"
            className="shotflow-replace-apikey-entry"
            title="设置或替换当前账号用于出图和生成的 API Key"
            onClick={() => setReplaceApiKeyOpen(true)}
          >
            <KeyRound size={14} strokeWidth={2.1} />
            设置/替换 API Key
          </button>
          <div className="shotflow-project-user-panel">
            <span className="shotflow-project-user-name">{user.username}</span>
            <span className="shotflow-project-user-divider" aria-hidden="true" />
            <div ref={headerMenuRef} className="shotflow-project-account-menu">
              <button
                type="button"
                className="shotflow-project-menu-trigger"
                title="管理菜单"
                aria-label="管理菜单"
                aria-expanded={headerMenuOpen}
                onClick={() => setHeaderMenuOpen((open) => !open)}
              >
                <MoreHorizontal size={17} strokeWidth={2.1} />
              </button>

              {headerMenuOpen && (
                <div className="shotflow-project-dropdown shotflow-management-dropdown">
                  <div className="shotflow-theme-picker">
                    <div className="shotflow-theme-picker-title">
                      <Palette size={14} strokeWidth={2} />
                      页面主题
                    </div>
                    <div className="shotflow-theme-options" role="group" aria-label="页面主题">
                      {SHOTFLOW_THEME_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`shotflow-theme-option${theme === option.value ? ' is-active' : ''}`}
                          aria-pressed={theme === option.value}
                          title={option.description}
                          onClick={() => {
                            setTheme(option.value)
                            setShotflowTheme(option.value)
                          }}
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
                  {canViewErrorLibrary && (
                    <button
                      type="button"
                      className="shotflow-project-dropdown-action"
                      onClick={() => {
                        setHeaderMenuOpen(false)
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
                        setHeaderMenuOpen(false)
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
                      setHeaderMenuOpen(false)
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
                      setHeaderMenuOpen(false)
                      setLogOpen(true)
                    }}
                  >
                    <NotebookText size={15} strokeWidth={2} />
                    查看日志
                  </button>
                  <div className="shotflow-project-dropdown-divider" />
                  <button
                    type="button"
                    className="shotflow-project-dropdown-action is-danger"
                    onClick={() => {
                      setHeaderMenuOpen(false)
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
        </div>
      </div>

      <div className="shotflow-project-content" style={{ padding: '28px 32px' }}>
        {loading ? (
          <div style={{ color: '#555', fontSize: 14, paddingTop: 60, textAlign: 'center' }}>加载中...</div>
        ) : (
          <div
            className="shotflow-project-layout"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.3fr) minmax(300px, 0.9fr)',
              gap: 28,
              alignItems: 'start',
            }}
          >
            <div
              className="shotflow-project-main"
              style={{
                minWidth: 0,
                borderRadius: 16,
                padding: dragOverUngrouped ? 14 : 0,
                margin: dragOverUngrouped ? -14 : 0,
                background: dragOverUngrouped ? 'rgba(124,92,252,0.08)' : 'transparent',
                boxShadow: dragOverUngrouped ? '0 0 0 1px rgba(124,92,252,0.45) inset' : 'none',
                transition: 'padding 0.15s, margin 0.15s, background 0.15s, box-shadow 0.15s',
              }}
              onDragOver={handleUngroupedDragOver}
              onDragLeave={handleDropZoneLeave}
              onDrop={(event) => {
                void handleDropToUngrouped(event)
              }}
            >
              <SectionHeader
                title="我的画布"
                count={ungroupedOwnCanvases.length}
                description={selectedCanvasOwner ? `当前查看：${selectedCanvasOwner.username}` : '不放在分类里的画布'}
                titleExtra={ownerSwitcher}
              />
              {dragOverUngrouped ? (
                <div
                  style={{
                    marginBottom: 14,
                    borderRadius: 10,
                    border: '1px dashed rgba(124,92,252,0.75)',
                    padding: '10px 12px',
                    fontSize: 13,
                    color: '#cbbef5',
                    background: 'rgba(20,16,30,0.75)',
                  }}
                >
                  松开后移出分类
                </div>
              ) : null}
              <div className="shotflow-project-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))', gap: 12 }}>
                {ungroupedOwnCanvases.map((canvas) => (
                  <ProjectCard
                    key={canvas.uuid}
                    project={canvas}
                    showOwner={false}
                    primaryLabel="打开画布"
                    primaryMode="open"
                    isBusy={workingUuid === canvas.uuid || openingUuid === canvas.uuid}
                    copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}
                    onPrimaryAction={() => {
                      void handleOpenCanvas(canvas.uuid, canvas.name)
                    }}
                    onRename={() => handleRenameCanvas(canvas.uuid)}
                    isEditingName={editingCanvasUuid === canvas.uuid}
                    onRenameSubmit={(name) => {
                      void handleRenameCanvasSubmit(canvas.uuid, name)
                    }}
                    onRenameCancel={() => setEditingCanvasUuid(null)}
                    onMenu={openCanvasMenu}
                    onShareMenu={openShareMenu}
                    isShareBusy={sharingUuid === canvas.uuid}
                    isDraggable
                    isDragging={draggingCanvasUuid === canvas.uuid}
                    onDragStart={beginCanvasDrag}
                    onDragEnd={endCanvasDrag}
                  />
                ))}
              </div>

              {/* 分类块直接接在"我的画布"下面：不再有"我的分类"这个标题，也不再有
                  "新建分类"按钮 —— 分类由 sd2 项目管理页的 shotflow 画布分类统一维护。 */}
              <div className="shotflow-project-collections" style={{ marginTop: 14 }}>
                {groups.ownCollections.length ? (
                  <div className="shotflow-collection-list" style={{ display: 'grid', gap: 10 }}>
                    {groups.ownCollections.map((collection) => (
                      <CollectionBlock
                        key={collection.id}
                        collection={collection}
                        canvases={canvasesByCollection.get(collection.id) ?? []}
                        collapsed={Boolean(collapsedCollections[collection.id])}
                        isEditingName={editingCollectionId === collection.id}
                        onToggle={() => toggleCollectionCollapse(collection.id)}
                        onCreateCanvas={() => {
                          openCreateCanvasDialog(collection.id)
                        }}
                        onRename={() => {
                          setMenu(null)
                          setEditingCollectionId(collection.id)
                        }}
                        onRenameSubmit={(name) => {
                          void handleRenameCollectionSubmit(collection.id, name)
                        }}
                        onRenameCancel={() => setEditingCollectionId(null)}
                        onMenu={openCollectionMenu}
                        isDropActive={dragOverCollectionId === collection.id}
                        onDragOver={(event) => handleCollectionDragOver(event, collection.id)}
                        onDragLeave={handleDropZoneLeave}
                        onDrop={(event) => {
                          void handleDropToCollection(event, collection.id)
                        }}
                        renderCanvasCard={(canvas) => (
                          <ProjectCard
                            key={canvas.uuid}
                            project={canvas}
                            showOwner={false}
                            primaryLabel="打开画布"
                            primaryMode="open"
                            isBusy={workingUuid === canvas.uuid || openingUuid === canvas.uuid}
                            copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}
                            onPrimaryAction={() => {
                              void handleOpenCanvas(canvas.uuid, canvas.name)
                            }}
                            onRename={() => handleRenameCanvas(canvas.uuid)}
                            isEditingName={editingCanvasUuid === canvas.uuid}
                            onRenameSubmit={(name) => {
                              void handleRenameCanvasSubmit(canvas.uuid, name)
                            }}
                            onRenameCancel={() => setEditingCanvasUuid(null)}
                            onMenu={openCanvasMenu}
                            onShareMenu={openShareMenu}
                            isShareBusy={sharingUuid === canvas.uuid}
                            isDraggable
                            isDragging={draggingCanvasUuid === canvas.uuid}
                            onDragStart={beginCanvasDrag}
                            onDragEnd={endCanvasDrag}
                          />
                        )}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="还没有分类，先建一个分类，再把画布放进去。" />
                )}
              </div>
            </div>

            <div className="shotflow-project-side" style={{ minWidth: 0, display: 'grid', gap: 30 }}>
              <div>
                <SectionHeader
                  title="画布模版"
                  count={sideLoaded.templates ? groups.templateCanvases.length : null}
                  description="从模板复制成新的独立画布"
                  collapsible
                  open={sideOpen.templates}
                  loading={sideLoading.templates}
                  onToggle={() => {
                    void toggleSideSection('templates')
                  }}
                />
                {!sideOpen.templates ? null : sideLoading.templates && !sideLoaded.templates ? (
                  <EmptyPanel title="正在加载画布模版…" />
                ) : groups.templateCanvases.length ? (
                  <div className="shotflow-project-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))', gap: 12 }}>
                    {groups.templateCanvases.map((canvas) => (
                      <ProjectCard
                        key={canvas.uuid}
                        project={canvas}
                        showOwner
                        primaryLabel={workingUuid === canvas.uuid ? '复制中...' : '使用模版'}
                        primaryMode="duplicate"
                        isBusy={workingUuid === canvas.uuid}
                        copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}
                        onPrimaryAction={() => {
                          void handleDuplicate(canvas.uuid)
                        }}
                        onRename={() => handleRenameCanvas(canvas.uuid)}
                        isEditingName={editingCanvasUuid === canvas.uuid}
                        onRenameSubmit={(name) => {
                          void handleRenameCanvasSubmit(canvas.uuid, name)
                        }}
                        onRenameCancel={() => setEditingCanvasUuid(null)}
                        onMenu={openCanvasMenu}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="还没有模板画布。" />
                )}
              </div>

              <div>
              <SectionHeader
                title="共享画布"
                count={sideLoaded.shared ? groups.sharedCanvases.length : null}
                description="大家共享出来的画布副本入口"
                collapsible
                open={sideOpen.shared}
                loading={sideLoading.shared}
                onToggle={() => {
                  void toggleSideSection('shared')
                }}
              />
              {!sideOpen.shared ? null : sideLoading.shared && !sideLoaded.shared ? (
                <EmptyPanel title="正在加载共享画布…" />
              ) : groups.sharedCanvases.length ? (
                <div className="shotflow-project-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))', gap: 12 }}>
                  {groups.sharedCanvases.map((canvas) => (
                    <ProjectCard
                      key={canvas.uuid}
                      project={canvas}
                      showOwner
                      primaryLabel={workingUuid === canvas.uuid ? '复制中...' : '复制画布'}
                      primaryMode="duplicate"
                      isBusy={workingUuid === canvas.uuid}
                      copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}
                      onPrimaryAction={() => {
                        void handleDuplicate(canvas.uuid)
                      }}
                      onRename={() => handleRenameCanvas(canvas.uuid)}
                      isEditingName={editingCanvasUuid === canvas.uuid}
                      onRenameSubmit={(name) => {
                        void handleRenameCanvasSubmit(canvas.uuid, name)
                      }}
                      onRenameCancel={() => setEditingCanvasUuid(null)}
                      onMenu={openCanvasMenu}
                    />
                  ))}
                </div>
              ) : (
                <EmptyPanel title="还没有共享画布。" />
              )}
              </div>

              <div>
                <SectionHeader
                  title="个人分享"
                  count={(groups.personalSharedCanvases ?? []).length}
                  description="同事单独分享给你的画布副本入口"
                />
                {(groups.personalSharedCanvases ?? []).length ? (
                  <div className="shotflow-project-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))', gap: 12 }}>
                    {(groups.personalSharedCanvases ?? []).map((canvas) => (
                      <ProjectCard
                        key={canvas.uuid}
                        project={canvas}
                        showOwner
                        primaryLabel={workingUuid === canvas.uuid ? '复制中...' : '复制画布'}
                        primaryMode="duplicate"
                        isBusy={workingUuid === canvas.uuid}
                        copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}
                        onPrimaryAction={() => {
                          void handleDuplicate(canvas.uuid)
                        }}
                        onRename={() => handleRenameCanvas(canvas.uuid)}
                        isEditingName={editingCanvasUuid === canvas.uuid}
                        onRenameSubmit={(name) => {
                          void handleRenameCanvasSubmit(canvas.uuid, name)
                        }}
                        onRenameCancel={() => setEditingCanvasUuid(null)}
                        onMenu={openCanvasMenu}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="还没有个人分享。" />
                )}
              </div>

              <div>
                <SectionHeader
                  title="官方画布模板"
                  count={sideLoaded.officialTemplates ? groups.officialTemplateCanvases.length : null}
                  description="官方模板库的一对一源画布"
                  collapsible
                  open={sideOpen.officialTemplates}
                  loading={sideLoading.officialTemplates}
                  onToggle={() => {
                    void toggleSideSection('officialTemplates')
                  }}
                />
                {!sideOpen.officialTemplates ? null : sideLoading.officialTemplates && !sideLoaded.officialTemplates ? (
                  <EmptyPanel title="正在加载官方画布模板…" />
                ) : groups.officialTemplateCanvases.length ? (
                  <div className="shotflow-project-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))', gap: 12 }}>
                    {groups.officialTemplateCanvases.map((canvas) => (
                      <ProjectCard
                        key={canvas.uuid}
                        project={canvas}
                        showOwner
                        primaryLabel={workingUuid === canvas.uuid ? '复制中...' : '使用模板'}
                        primaryMode="duplicate"
                        isBusy={workingUuid === canvas.uuid}
                        copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}
                        onPrimaryAction={() => {
                          void handleDuplicate(canvas.uuid)
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="还没有官方画布模板。" />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <input ref={coverInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleCoverFileChange} />

      {logOpen && (
        <ActivityLogsModal
          user={user}
          onClose={closeActivityLog}
        />
      )}

      {pluginTokenOpen && <PluginTokenModal onClose={() => setPluginTokenOpen(false)} />}
      {replaceApiKeyOpen && (
        <ReplaceApiKeyDialog
          onClose={() => setReplaceApiKeyOpen(false)}
          onSaved={() => {
            setHasApiKey(true)
            void refreshApiKeyStatus()
          }}
        />
      )}

      {assignedProjectDialog ? (
        <AssignedProjectDialog
          title={assignedProjectDialog.mode === 'create' ? '新建画布' : '所属项目'}
          subtitle={
            assignedProjectDialog.mode === 'create'
              ? '先选择画布所属项目，再继续创建'
              : `为“${dialogCanvas?.name || '当前画布'}”选择所属项目`
          }
          projects={dialogProjects}
          nameValue={assignedProjectDialog.mode === 'create' ? newCanvasName : undefined}
          onNameChange={assignedProjectDialog.mode === 'create' ? setNewCanvasName : undefined}
          emptyHint={
            assignedProjectDialog.mode === 'create' && assignedProjectDialog.collectionId
              ? '这个分类下还没有“进行中”的项目。去项目管理页把项目归到这个画布分类，或把状态改成进行中。'
              : undefined
          }
          value={selectedAssignedProjectId}
          onChange={setSelectedAssignedProjectId}
          onClose={closeAssignedProjectDialog}
          onConfirm={() => {
            void confirmAssignedProjectDialog()
          }}
          confirmLabel={assignedProjectDialog.mode === 'create' ? '创建画布' : '保存'}
        />
      ) : null}

      {personalShareDialog ? (
        <PersonalShareDialog
          dialog={personalShareDialog}
          onClose={() => setPersonalShareDialog(null)}
          onToggleUser={togglePersonalShareUser}
          onSave={() => {
            void handleSavePersonalShares()
          }}
        />
      ) : null}

      {shareMenu && shareMenuCanvas ? (
        <div
          ref={shareMenuRef}
          className="shotflow-project-menu"
          style={{
            position: 'fixed',
            ...menuPlacementStyle(shareMenu.x, shareMenu.y, 240),
            background: '#16121f',
            border: '1px solid #2d2248',
            borderRadius: 10,
            padding: '6px 0',
            minWidth: 190,
            maxWidth: 240,
            zIndex: 9999,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <MenuActionButton
            label={shareMenuCanvas.isShared ? '取消共享画布' : '分享到共享画布'}
            active={Boolean(shareMenuCanvas.isShared)}
            onClick={() => {
              void handleToggleShare(shareMenu.uuid, !shareMenuCanvas.isShared)
            }}
          />
          <MenuActionButton
            label={
              shareMenuCanvas.personalShareCount
                ? `分享给用户（${shareMenuCanvas.personalShareCount}）`
                : '分享给用户'
            }
            active={Boolean(shareMenuCanvas.personalShareCount)}
            onClick={() => {
              void openPersonalShareDialog(shareMenu.uuid)
            }}
          />
        </div>
      ) : null}

      {menu?.type === 'canvas' && menuCanvas ? (
        <div
          ref={menuRef}
          className="shotflow-project-menu"
          style={{
            position: 'fixed',
            ...menuPlacementStyle(menu.x, menu.y, 260),
            background: '#16121f',
            border: '1px solid #2d2248',
            borderRadius: 10,
            padding: '6px 0',
            minWidth: 210,
            maxWidth: 260,
            zIndex: 9999,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
          }}
        >
          <MenuActionButton
            label={menu.mode === 'duplicate' ? '复制画布' : '打开画布'}
            onClick={() => {
              if (menu.mode === 'duplicate') {
                void handleDuplicate(menu.uuid)
              } else {
                onOpen(menu.uuid)
                setMenu(null)
              }
            }}
          />

          {menuCanvas.canManage ? (
            <>
              <MenuActionButton
                label={menuCanvas.isShared ? '取消共享' : '共享画布'}
                onClick={() => {
                  void handleToggleShare(menu.uuid, !menuCanvas.isShared)
                }}
              />
              <MenuActionButton label="重命名" onClick={() => handleRenameCanvas(menu.uuid)} />
              <MenuActionButton label="修改封面" onClick={() => handleChangeCover(menu.uuid)} />
              <MenuActionButton label="所属项目" onClick={() => openAssignProjectDialog(menu.uuid)} />
              <MenuDivider />
              <MenuSectionTitle label="移动到分类" />
              {menuCanvas.collectionId ? (
                <MenuActionButton
                  label="移除分类"
                  onClick={() => {
                    void handleMoveToCollection(menu.uuid, null)
                  }}
                />
              ) : null}
              {groups.ownCollections.length ? (
                groups.ownCollections.map((collection) => (
                  <MenuActionButton
                    key={collection.id}
                    label={collection.name}
                    active={menuCanvas.collectionId === collection.id}
                    onClick={() => {
                      void handleMoveToCollection(menu.uuid, collection.id)
                    }}
                  />
                ))
              ) : (
                <div style={{ padding: '8px 16px 6px', fontSize: 12, color: '#7c7690' }}>还没有分类</div>
              )}
              <MenuDivider />
            </>
          ) : null}

          {menuCanvas.canvasRole !== 'template' ? (
            <MenuActionButton
              label="设为模板画布"
              onClick={() => {
                void handleCreateTemplate(menu.uuid)
              }}
            />
          ) : null}

          <MenuActionButton
            label="创建副本"
            onClick={() => {
              void handleDuplicate(menu.uuid)
            }}
          />

          {menuCanvas.canManage ? (
            <MenuActionButton
              label="删除画布"
              danger
              onClick={() => {
                void handleDeleteCanvas(menu.uuid)
              }}
            />
          ) : null}
        </div>
      ) : null}

      {menu?.type === 'collection' && menuCollection ? (
        <div
          ref={menuRef}
          className="shotflow-project-menu"
          style={{
            position: 'fixed',
            ...menuPlacementStyle(menu.x, menu.y, 180),
            background: '#16121f',
            border: '1px solid #2d2248',
            borderRadius: 10,
            padding: '6px 0',
            minWidth: 180,
            zIndex: 9999,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
          }}
        >
          <MenuActionButton
            label="新建画布"
            onClick={() => {
              setMenu(null)
              openCreateCanvasDialog(menuCollection.id)
            }}
          />
          {/* 重命名 / 删除分类的入口撤掉了：分类是 sd2 项目管理页那份 shotflow 画布分类
              的镜像，在这边改名等于跟名单对不上，下次对齐会把它当"名单外的旧分类"处理
              （画布挪进"测试"、空壳删掉）。要增删改分类去项目管理页。 */}
        </div>
      ) : null}
    </div>
  )
}

function ActionButton({ label, onClick, busy }: { label: string; onClick: () => void; busy?: boolean }) {
  return (
    <button
      className="shotflow-project-action-button"
      type="button"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        background: '#1e1830',
        border: '1px solid #312550',
        borderRadius: 8,
        padding: '7px 12px',
        color: '#8a7aaa',
        fontSize: 13,
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#251e38')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '#1e1830')}
      onClick={onClick}
      disabled={busy}
    >
      {label}
    </button>
  )
}

function SectionHeader({
  title,
  count,
  description,
  titleExtra,
  actions,
  collapsible,
  open,
  loading,
  onToggle,
}: {
  title: string
  /** null = 这一组还没加载（收起时服务端根本没查），此时不显示数量角标，免得显示一个骗人的 0 */
  count: number | null
  description: string
  titleExtra?: ReactNode
  actions?: ReactNode
  collapsible?: boolean
  open?: boolean
  loading?: boolean
  onToggle?: () => void
}) {
  const clickable = Boolean(collapsible && onToggle)
  const titleStyle: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600, color: '#efe9ff' }
  const countPill = count === null ? null : (
    <span
      style={{
        fontSize: 12,
        color: '#a899cc',
        border: '1px solid #2b2440',
        background: '#171322',
        borderRadius: 999,
        padding: '2px 8px',
      }}
    >
      {count}
    </span>
  )

  return (
    <div className="shotflow-section-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10, gap: 12 }}>
      <div className="shotflow-section-copy">
        <div className="shotflow-section-title-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {clickable ? (
            // titleExtra / actions 留在按钮外面：它们可能本身就是可点的控件，套进 button 里
            // 就成了嵌套交互元素（点子控件会连带触发折叠）。
            <button
              type="button"
              className="shotflow-section-toggle"
              aria-expanded={open}
              onClick={onToggle}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: 0,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
              }}
            >
              <span style={{ display: 'flex', color: '#a899cc' }}>
                {open ? <ChevronDown size={16} strokeWidth={2.2} /> : <ChevronRight size={16} strokeWidth={2.2} />}
              </span>
              <h2 style={titleStyle}>{title}</h2>
              {countPill}
              {loading ? <Loader2 size={13} className="shotflow-section-spin" /> : null}
            </button>
          ) : (
            <>
              <h2 style={titleStyle}>{title}</h2>
              {countPill}
            </>
          )}
          {titleExtra ? <div className="shotflow-section-extra" style={{ flexShrink: 0 }}>{titleExtra}</div> : null}
        </div>
        <div style={{ marginTop: 3, fontSize: 12, color: '#6d6685' }}>{description}</div>
      </div>
      {actions ? <div className="shotflow-section-actions" style={{ flexShrink: 0 }}>{actions}</div> : null}
    </div>
  )
}

function CollectionBlock({
  collection,
  canvases,
  collapsed,
  isEditingName,
  onToggle,
  onCreateCanvas,
  onRename,
  onRenameSubmit,
  onRenameCancel,
  onMenu,
  isDropActive,
  onDragOver,
  onDragLeave,
  onDrop,
  renderCanvasCard,
}: {
  collection: CanvasCollection
  canvases: ProjectIndex[]
  collapsed: boolean
  isEditingName: boolean
  onToggle: () => void
  onCreateCanvas: () => void
  onRename: () => void
  onRenameSubmit: (name: string) => void
  onRenameCancel: () => void
  onMenu: (id: string, e: MouseEvent) => void
  isDropActive: boolean
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  renderCanvasCard: (canvas: ProjectIndex) => ReactNode
}) {
  const [draftName, setDraftName] = useState(collection.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraftName(collection.name)
  }, [collection.name])

  useEffect(() => {
    if (!isEditingName) return
    setDraftName(collection.name)
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [collection.name, isEditingName])

  const commitRename = useCallback(() => {
    onRenameSubmit(draftName)
  }, [draftName, onRenameSubmit])

  return (
    <div
      className="shotflow-collection-block"
      style={{
        borderRadius: 12,
        border: isDropActive ? '1px solid rgba(124,92,252,0.75)' : '1px solid #221c31',
        background: isDropActive ? 'rgba(25,18,40,0.96)' : '#121019',
        overflow: 'hidden',
        boxShadow: isDropActive ? '0 0 0 1px rgba(124,92,252,0.2) inset, 0 10px 28px rgba(0,0,0,0.24)' : 'none',
        transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDropActive ? (
        <div
          style={{
            padding: '10px 16px 0',
            fontSize: 12,
            color: '#cbbef5',
          }}
        >
          松开后移入这个分类
        </div>
      ) : null}
      <div
        className="shotflow-collection-head"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 12px',
          borderBottom: collapsed ? 'none' : '1px solid #1d182a',
          cursor: 'pointer',
        }}
        onClick={onToggle}
      >
        <button
          type="button"
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            border: '1px solid #2b2440',
            background: '#171322',
            color: '#cbbef5',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>

        <div className="shotflow-collection-title-row" style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
          {isEditingName ? (
            <input
              ref={inputRef}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') {
                  setDraftName(collection.name)
                  onRenameCancel()
                }
              }}
              style={{
                minWidth: 0,
                flex: 1,
                height: 32,
                fontSize: 15,
                color: '#efe9ff',
                fontWeight: 600,
                borderRadius: 8,
                border: '1px solid #7c5cfc',
                background: '#171322',
                padding: '0 10px',
                outline: 'none',
              }}
            />
          ) : (
            <div
              style={{
                minWidth: 0,
                flex: 1,
                fontSize: 15,
                fontWeight: 600,
                color: '#efe9ff',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onRename()
              }}
              title={collection.name}
            >
              {collection.name}
            </div>
          )}

          <span
            style={{
              flexShrink: 0,
              fontSize: 12,
              color: '#a899cc',
              border: '1px solid #2b2440',
              background: '#171322',
              borderRadius: 999,
              padding: '2px 8px',
            }}
          >
            {canvases.length}
          </span>
        </div>

        <button
          type="button"
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            border: '1px solid #2b2440',
            background: '#171322',
            color: '#cbbef5',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onClick={(e) => onMenu(collection.id, e)}
        >
          ⋯
        </button>
      </div>

      {!collapsed ? (
        <div className="shotflow-collection-body" style={{ padding: 12 }}>
          <div className="shotflow-project-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))', gap: 12 }}>
            {canvases.map((canvas) => renderCanvasCard(canvas))}
            {/* "新建画布"排在画布后面 */}
            <CreateTile title="新建画布" subtitle="直接在这个分类里创建画布" onClick={onCreateCanvas} />
          </div>

          {!canvases.length ? (
            <div
              style={{
                marginTop: 10,
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px dashed #2b2440',
                color: '#746d8b',
                fontSize: 12,
                background: '#15111f',
              }}
            >
              这个分类里还没有画布。
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function CreateTile({ title, subtitle, onClick }: { title: string; subtitle: string; onClick: () => void }) {
  return (
    <div className="shotflow-create-tile" style={{ cursor: 'pointer' }} onClick={onClick}>
      <div
        className="shotflow-create-tile-surface"
        style={{
          aspectRatio: '16/10',
          background: '#161320',
          border: '1.5px dashed #312550',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          transition: 'border-color 0.15s, background 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = '#7c5cfc'
          e.currentTarget.style.background = '#1e1830'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = '#312550'
          e.currentTarget.style.background = '#161320'
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: '#251e38',
            border: '1px solid #312550',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            color: '#7c5cfc',
          }}
        >
          +
        </div>
        <span style={{ fontSize: 13, color: '#7c5cfc', fontWeight: 500 }}>{title}</span>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 13, color: '#888' }}>{subtitle}</div>
      </div>
    </div>
  )
}

function AssignedProjectDialog({
  title,
  subtitle,
  projects,
  emptyHint,
  nameValue,
  onNameChange,
  value,
  onChange,
  onClose,
  onConfirm,
  confirmLabel,
}: {
  title: string
  subtitle: string
  projects: CanvasAssignedProject[]
  emptyHint?: string
  /** 新建画布时的名字；留空就用「未命名画布」。只有新建模式会传 */
  nameValue?: string
  onNameChange?: (value: string) => void
  value: string
  onChange: (value: string) => void
  onClose: () => void
  onConfirm: () => void
  confirmLabel: string
}) {
  return (
    <div
      className="shotflow-assigned-dialog-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5, 4, 10, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        className="shotflow-assigned-dialog"
        style={{
          width: 'min(440px, calc(100vw - 32px))',
          borderRadius: 16,
          border: '1px solid #2b2440',
          background: '#14111d',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ padding: '18px 20px 12px' }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#f2edff' }}>{title}</div>
          <div style={{ marginTop: 6, fontSize: 13, color: '#8c84a6', lineHeight: 1.5 }}>{subtitle}</div>
        </div>

        <div style={{ padding: '0 20px 20px' }}>
          {onNameChange ? (
            <label style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
              <span style={{ fontSize: 13, color: '#cfc4f5' }}>画布名称<span style={{ color: '#6d6685' }}>（可留空）</span></span>
              <input
                className="shotflow-new-canvas-name"
                value={nameValue ?? ''}
                placeholder="未命名画布"
                maxLength={160}
                onChange={(event) => onNameChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onConfirm()
                  }
                }}
                style={{
                  height: 36,
                  padding: '0 10px',
                  borderRadius: 9,
                  border: '1px solid #2b2440',
                  background: '#171322',
                  color: '#f2edff',
                  fontSize: 14,
                  outline: 'none',
                }}
              />
            </label>
          ) : null}
          <label style={{ display: 'grid', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#cfc4f5' }}>项目</span>
            <div className="shotflow-assigned-project-picker">
              <button
                type="button"
                className="shotflow-assigned-project-trigger"
                aria-haspopup="listbox"
                aria-expanded="true"
              >
                <span>{projects.find((project) => project.id === value)?.name || '请选择项目'}</span>
                <span aria-hidden="true">⌄</span>
              </button>
              <div className="shotflow-assigned-project-options" role="listbox" aria-label="项目">
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="option"
                    aria-selected={project.id === value}
                    className={`shotflow-assigned-project-option${project.id === value ? ' is-selected' : ''}`}
                    onClick={() => onChange(project.id)}
                  >
                    {project.name}
                  </button>
                ))}
              </div>
            </div>
          </label>

          {!projects.length ? (
            <div style={{ marginTop: 12, fontSize: 12, color: '#fca5a5' }}>
              {emptyHint || '当前没有“进行中”的项目，请先去后台管理调整项目状态。'}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 20px 18px',
            borderTop: '1px solid #211a31',
            background: '#120f1a',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 38,
              padding: '0 16px',
              borderRadius: 10,
              border: '1px solid #312550',
              background: '#181426',
              color: '#d3caf1',
              cursor: 'pointer',
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!projects.length}
            style={{
              height: 38,
              padding: '0 16px',
              borderRadius: 10,
              border: '1px solid #7c5cfc',
              background: projects.length ? '#7c5cfc' : '#312550',
              color: '#fff',
              cursor: projects.length ? 'pointer' : 'not-allowed',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function PersonalShareDialog({
  dialog,
  onClose,
  onToggleUser,
  onSave,
}: {
  dialog: PersonalShareDialogState
  onClose: () => void
  onToggleUser: (userId: string) => void
  onSave: () => void
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleUsers = useMemo(
    () =>
      normalizedQuery
        ? dialog.users.filter((shareUser) => shareUser.username.toLowerCase().includes(normalizedQuery))
        : dialog.users,
    [dialog.users, normalizedQuery]
  )
  const selectedCount = dialog.selectedUserIds.length

  return (
    <div
      className="shotflow-personal-share-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5, 4, 10, 0.62)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        className="shotflow-personal-share-dialog"
        style={{
          width: 'min(560px, calc(100vw - 32px))',
          borderRadius: 16,
          border: '1px solid #30264c',
          background: '#14111d',
          boxShadow: '0 24px 72px rgba(0,0,0,0.54)',
          overflow: 'hidden',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid #211a31' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                border: '1px solid #3b2d5f',
                background: '#211936',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#cbb7ff',
                flexShrink: 0,
              }}
            >
              <Users size={16} strokeWidth={2.1} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#f3edff' }}>分享给用户</div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 13,
                  color: '#8d84a8',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={dialog.canvasName}
              >
                {dialog.canvasName}
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: 20 }}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索用户"
            disabled={dialog.loading}
            style={{
              width: '100%',
              height: 40,
              borderRadius: 10,
              border: '1px solid #34284f',
              background: '#100d18',
              color: '#efe9ff',
              padding: '0 13px',
              outline: 'none',
              fontSize: 14,
              boxSizing: 'border-box',
            }}
          />

          <div
            style={{
              marginTop: 12,
              minHeight: 220,
              maxHeight: 320,
              overflow: 'auto',
              borderRadius: 12,
              border: '1px solid #241d36',
              background: '#100d18',
              padding: 8,
            }}
          >
            {dialog.loading ? (
              <div style={{ height: 190, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8d84a8', fontSize: 13 }}>
                正在加载用户...
              </div>
            ) : visibleUsers.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {visibleUsers.map((shareUser) => {
                  const selected = dialog.selectedUserIds.includes(shareUser.id)
                  return (
                    <button
                      key={shareUser.id}
                      type="button"
                      onClick={() => onToggleUser(shareUser.id)}
                      style={{
                        height: 42,
                        minWidth: 0,
                        borderRadius: 10,
                        border: selected ? '1px solid #8d6bff' : '1px solid #2a223b',
                        background: selected ? 'linear-gradient(135deg, rgba(124,92,252,0.26), rgba(76,190,255,0.12))' : '#171322',
                        color: selected ? '#f8f4ff' : '#cfc4f5',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '0 11px',
                        fontSize: 13,
                        boxShadow: selected ? '0 0 0 1px rgba(124,92,252,0.12) inset' : 'none',
                      }}
                      title={shareUser.username}
                    >
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {shareUser.username}
                      </span>
                      {selected ? <Check size={14} strokeWidth={2.4} /> : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div style={{ height: 190, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7b738d', fontSize: 13 }}>
                没有找到用户
              </div>
            )}
          </div>

          <div style={{ marginTop: 10, minHeight: 18, fontSize: 12, color: dialog.error ? '#fca5a5' : '#8d84a8' }}>
            {dialog.error || `已选择 ${selectedCount} 个用户`}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            padding: '14px 20px 18px',
            borderTop: '1px solid #211a31',
            background: '#120f1a',
          }}
        >
          <button
            type="button"
            onClick={() => {
              dialog.selectedUserIds.forEach((userId) => onToggleUser(userId))
            }}
            disabled={dialog.loading || dialog.saving || !selectedCount}
            style={{
              height: 38,
              padding: '0 14px',
              borderRadius: 10,
              border: '1px solid #312550',
              background: '#181426',
              color: selectedCount ? '#d3caf1' : '#6f6685',
              cursor: selectedCount ? 'pointer' : 'not-allowed',
            }}
          >
            清空选择
          </button>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                height: 38,
                padding: '0 16px',
                borderRadius: 10,
                border: '1px solid #312550',
                background: '#181426',
                color: '#d3caf1',
                cursor: 'pointer',
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={dialog.loading || dialog.saving}
              style={{
                height: 38,
                padding: '0 18px',
                borderRadius: 10,
                border: '1px solid #7c5cfc',
                background: dialog.loading || dialog.saving ? '#312550' : '#7c5cfc',
                color: '#fff',
                cursor: dialog.loading || dialog.saving ? 'wait' : 'pointer',
                minWidth: 86,
              }}
            >
              {dialog.saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MenuSectionTitle({ label }: { label: string }) {
  return <div style={{ padding: '8px 16px 4px', fontSize: 12, color: '#8a84a1' }}>{label}</div>
}

function MenuDivider() {
  return <div style={{ height: 1, margin: '6px 0', background: 'rgba(255,255,255,0.07)' }} />
}

function MenuActionButton({
  label,
  onClick,
  danger,
  active,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '9px 16px',
        background: active ? 'rgba(124,92,252,0.12)' : 'none',
        border: 'none',
        fontSize: 14,
        cursor: 'pointer',
        color: danger ? '#f87171' : active ? '#f1ebff' : '#d0c8f0',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? 'rgba(124,92,252,0.12)' : 'none'
      }}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function ProjectCard({
  project,
  onPrimaryAction,
  onRename,
  onMenu,
  showOwner,
  primaryLabel,
  primaryMode,
  isBusy,
  copyProgress,
  isDraggable,
  isDragging,
  onDragStart,
  onDragEnd,
  isEditingName,
  onRenameSubmit,
  onRenameCancel,
  onShareMenu,
  isShareBusy,
}: {
  project: ProjectIndex
  onPrimaryAction: () => void
  onRename?: () => void
  onMenu?: (uuid: string, e: MouseEvent, mode: 'open' | 'duplicate') => void
  onShareMenu?: (uuid: string, e: MouseEvent) => void
  showOwner: boolean
  primaryLabel: string
  primaryMode: 'open' | 'duplicate'
  isBusy?: boolean
  copyProgress?: { percent: number } | null
  isDraggable?: boolean
  isDragging?: boolean
  onDragStart?: (uuid: string) => void
  onDragEnd?: () => void
  isEditingName?: boolean
  isShareBusy?: boolean
  onRenameSubmit?: (name: string) => void
  onRenameCancel?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [draftName, setDraftName] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraftName(project.name)
  }, [project.name])

  useEffect(() => {
    if (!isEditingName) return
    setDraftName(project.name)
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isEditingName, project.name])

  const commitRename = useCallback(() => {
    onRenameSubmit?.(draftName)
  }, [draftName, onRenameSubmit])

  const showShareToggle = Boolean(onShareMenu && project.canManage)
  const shareActive = Boolean(project.isShared || (project.personalShareCount ?? 0) > 0)
  const shareDisabled = Boolean(isBusy || isShareBusy)
  const showCopyProgress = Boolean(isBusy && copyProgress)
  const copyPercent = Math.max(0, Math.min(100, Math.round(Number(copyProgress?.percent) || 0)))
  const displayPrimaryLabel = isBusy && primaryMode === 'open'
    ? '打开中...'
    : showCopyProgress
      ? `复制中 ${copyPercent}%`
      : primaryLabel
  const showOverlay = hovered || Boolean(isBusy)

  return (
    <div
      className="shotflow-project-card"
      draggable={Boolean(isDraggable && !isBusy)}
      style={{
        cursor: isBusy ? 'progress' : isDraggable ? 'grab' : 'pointer',
        position: 'relative',
        zIndex: hovered ? 12 : 1,
        opacity: isDragging ? 0.42 : 1,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragStart={(event) => {
        if (!isDraggable || isBusy) {
          event.preventDefault()
          return
        }
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(CANVAS_DRAG_MIME, project.uuid)
        onDragStart?.(project.uuid)
      }}
      onDragEnd={() => {
        onDragEnd?.()
      }}
      onClick={() => {
        if (!isBusy) onPrimaryAction()
      }}
    >
      <div
        className="shotflow-project-card-cover"
        style={{
          aspectRatio: '16/10',
          background: '#141420',
          borderRadius: 10,
          overflow: 'hidden',
          position: 'relative',
          border: `1px solid ${hovered ? '#312550' : '#1e1e2a'}`,
          transition: 'border-color 0.15s',
        }}
      >
        <ProjectCover coverUrl={project.coverUrl} name={project.name} />

        {showOverlay ? (
          <div
            className="shotflow-project-card-overlay"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {showCopyProgress ? (
              <div className="shotflow-project-card-copy-progress" onClick={(e) => e.stopPropagation()}>
                <div className="shotflow-project-card-copy-progress-label">
                  <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                  <span>{displayPrimaryLabel}</span>
                </div>
                <div className="shotflow-project-card-copy-progress-track" aria-hidden="true">
                  <div
                    className="shotflow-project-card-copy-progress-fill"
                    style={{ width: `${copyPercent}%` }}
                  />
                </div>
              </div>
            ) : (
              <div
                style={{
                  background: 'rgba(124,92,252,0.9)',
                  borderRadius: 20,
                  padding: '6px 16px',
                  fontSize: 13,
                  color: '#fff',
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                }}
              >
                {isBusy && primaryMode === 'open' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                {displayPrimaryLabel}
              </div>
            )}
          </div>
        ) : null}

        {showShareToggle ? (
          <button
            className="shotflow-project-share-button"
            type="button"
            aria-pressed={shareActive}
            title={
              project.isShared
                ? '已分享到共享画布'
                : project.personalShareCount
                  ? `已分享给 ${project.personalShareCount} 个用户`
                  : '分享画布'
            }
            disabled={shareDisabled}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              width: 30,
              height: 30,
              borderRadius: 9,
              background: shareActive
                ? 'linear-gradient(135deg, rgba(124,92,252,0.96), rgba(76,190,255,0.88))'
                : 'rgba(14, 12, 23, 0.76)',
              border: shareActive ? '1px solid rgba(227,219,255,0.55)' : '1px solid rgba(255,255,255,0.12)',
              color: shareActive ? '#ffffff' : '#c9bfdf',
              cursor: shareDisabled ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: shareDisabled ? 0.72 : 1,
              zIndex: 4,
              backdropFilter: 'blur(10px)',
              boxShadow: shareActive
                ? '0 0 18px rgba(124,92,252,0.62), 0 0 8px rgba(95,205,255,0.34), inset 0 0 0 1px rgba(255,255,255,0.18)'
                : hovered
                  ? '0 8px 18px rgba(0,0,0,0.36), inset 0 0 0 1px rgba(255,255,255,0.06)'
                  : '0 6px 14px rgba(0,0,0,0.24)',
              transition: 'background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease, transform 0.16s ease',
              transform: hovered && !shareDisabled ? 'translateY(-1px)' : 'none',
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!shareDisabled) onShareMenu?.(project.uuid, e)
            }}
          >
            <Share2 size={15} strokeWidth={2.25} />
          </button>
        ) : null}

        {onMenu ? <button
          className="shotflow-project-card-menu-button"
          type="button"
          style={{
            position: 'absolute',
            top: 8,
            right: showShareToggle ? 44 : 8,
            width: 28,
            height: 28,
            borderRadius: 6,
            background: hovered ? 'rgba(20,18,32,0.9)' : 'transparent',
            border: hovered ? '1px solid #312550' : 'none',
            color: '#c4b5fd',
            fontSize: 16,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: hovered ? 1 : 0,
            transition: 'opacity 0.15s',
            zIndex: 4,
          }}
          onClick={(e) => {
            e.stopPropagation()
            onMenu(project.uuid, e, primaryMode)
          }}
        >
          ⋯
        </button> : null}
      </div>

      <div className="shotflow-project-card-meta" style={{ marginTop: 7, paddingLeft: 2 }}>
        <div className="shotflow-project-card-title-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isEditingName && onRenameSubmit ? (
            <input
              ref={inputRef}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') {
                  setDraftName(project.name)
                  onRenameCancel?.()
                }
              }}
              style={{
                minWidth: 0,
                flex: 1,
                height: 28,
                fontSize: 14,
                color: '#efe9ff',
                fontWeight: 500,
                borderRadius: 7,
                border: '1px solid #7c5cfc',
                background: '#171322',
                padding: '0 10px',
                outline: 'none',
                boxShadow: '0 0 0 1px rgba(124,92,252,0.14)',
              }}
            />
          ) : (
            <div
              style={{
                minWidth: 0,
                fontSize: 14,
                color: '#e5e5e5',
                fontWeight: 500,
                marginBottom: 3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                if (!project.canManage || !onRename) return
                e.preventDefault()
                e.stopPropagation()
                onRename()
              }}
              title={project.name}
            >
              {project.name}
            </div>
          )}

          {project.assignedProjectName ? (
            <span
              style={{
                maxWidth: 112,
                flexShrink: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 11,
                lineHeight: 1,
                color: '#d9cffd',
                border: '1px solid #352a56',
                borderRadius: 999,
                padding: '4px 7px',
                background: '#1b1730',
              }}
              title={project.assignedProjectName}
            >
              {project.assignedProjectName}
            </span>
          ) : null}

          {project.isShared ? (
            <span
              style={{
                flexShrink: 0,
                fontSize: 11,
                lineHeight: 1,
                color: '#c4b5fd',
                border: '1px solid #352a56',
                borderRadius: 999,
                padding: '4px 7px',
                background: '#1b1730',
              }}
            >
              已共享
            </span>
          ) : null}

          {!project.isShared && project.personalShareCount ? (
            <span
              style={{
                flexShrink: 0,
                fontSize: 11,
                lineHeight: 1,
                color: '#9bdcff',
                border: '1px solid rgba(76,190,255,0.28)',
                borderRadius: 999,
                padding: '4px 7px',
                background: 'rgba(76,190,255,0.08)',
              }}
            >
              已分享 {project.personalShareCount}
            </span>
          ) : null}
        </div>

        <div className="shotflow-project-card-details" style={{ fontSize: 11, color: '#6a6577', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span>{formatCanvasTimeLabel('创建', project.createdAtMs)}</span>
          <span>{formatCanvasTimeLabel('最近修改', project.updatedAtMs)}</span>
          {showOwner && project.ownerName ? <span>来自 {project.ownerName}</span> : null}
        </div>
      </div>
    </div>
  )
}
