import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import {
  Box,
  CopyPlus,
  FileText,
  Image as ImageIcon,
  Layers3,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Star,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import { favoritesApi } from '@/lib/api'
import type { FavoriteLibraryItem, FavoriteLibraryItemType } from '@/lib/types'
import {
  ASSET_FILTER_ALL,
  ASSET_LABEL_OPTIONS,
  ASSET_PROJECT_OPTIONS,
  ASSET_TYPE_OPTIONS,
  readAssetLabel,
  readAssetProject,
  visibleAssetTags,
  withAssetLabel,
  withAssetProject,
} from '@/lib/libraryTaxonomy'

type FavoriteLibraryMode = 'assets' | 'shared'
type FavoriteCategory = 'text' | 'image' | 'video' | 'group' | 'other'
type FavoriteTypeFilter = 'all' | FavoriteCategory
type FavoriteSortOrder = 'shared_desc' | 'shared_asc'
type FavoritePanelMemory = {
  type: FavoriteTypeFilter
  /** 标签筛选，空串 = 全部 */
  label: string
  /** 项目筛选，空串 = 全部 */
  project: string
  sortOrder: FavoriteSortOrder
  query: string
  scrollTop: number
}

interface FavoriteLibraryPanelProps {
  mode?: FavoriteLibraryMode
  onClose: () => void
  onInsert: (item: FavoriteLibraryItem) => void
  onDragStart?: (item: FavoriteLibraryItem, event: DragEvent<HTMLElement>) => void
}

const DEFAULT_PANEL_MEMORY: FavoritePanelMemory = {
  type: 'all',
  label: ASSET_FILTER_ALL,
  project: ASSET_FILTER_ALL,
  sortOrder: 'shared_desc',
  query: '',
  scrollTop: 0,
}

function favoritePanelMemoryKey(mode: FavoriteLibraryMode) {
  return `shotflow:${mode}:library-panel-memory`
}

function isFavoriteTypeFilter(value: unknown): value is FavoriteTypeFilter {
  return value === 'all' || value === 'text' || value === 'image' || value === 'video' || value === 'group' || value === 'other'
}

function isFavoriteSortOrder(value: unknown): value is FavoriteSortOrder {
  return value === 'shared_desc' || value === 'shared_asc'
}

function readFavoritePanelMemory(mode: FavoriteLibraryMode): FavoritePanelMemory {
  if (typeof window === 'undefined') return DEFAULT_PANEL_MEMORY
  try {
    const raw = window.localStorage.getItem(favoritePanelMemoryKey(mode))
    const parsed = raw ? JSON.parse(raw) as Partial<FavoritePanelMemory> : {}
    return {
      type: isFavoriteTypeFilter(parsed.type) ? parsed.type : DEFAULT_PANEL_MEMORY.type,
      // 选项列表以后会改，记住的值不在列表里就退回"全部"，不要留一个筛不出任何东西的旧值
      label: ASSET_LABEL_OPTIONS.includes(String(parsed.label)) ? String(parsed.label) : ASSET_FILTER_ALL,
      project: ASSET_PROJECT_OPTIONS.includes(String(parsed.project)) ? String(parsed.project) : ASSET_FILTER_ALL,
      sortOrder: isFavoriteSortOrder(parsed.sortOrder) ? parsed.sortOrder : DEFAULT_PANEL_MEMORY.sortOrder,
      query: typeof parsed.query === 'string' ? parsed.query : DEFAULT_PANEL_MEMORY.query,
      scrollTop: Number.isFinite(Number(parsed.scrollTop)) ? Math.max(0, Number(parsed.scrollTop)) : DEFAULT_PANEL_MEMORY.scrollTop,
    }
  } catch {
    return DEFAULT_PANEL_MEMORY
  }
}

function writeFavoritePanelMemory(mode: FavoriteLibraryMode, memory: FavoritePanelMemory) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(favoritePanelMemoryKey(mode), JSON.stringify(memory))
  } catch {
    // Best-effort UI memory only.
  }
}

function categoryLabel(category: FavoriteCategory) {
  if (category === 'text') return '文本节点'
  if (category === 'image') return '图片节点'
  if (category === 'video') return '视频节点'
  if (category === 'group') return '组节点'
  return '其他节点'
}

function categoryIcon(category: FavoriteCategory, size = 15) {
  if (category === 'text') return <FileText size={size} />
  if (category === 'image') return <ImageIcon size={size} />
  if (category === 'video') return <Video size={size} />
  if (category === 'group') return <Layers3 size={size} />
  return <Box size={size} />
}

function itemTypeIcon(type: FavoriteLibraryItemType) {
  if (type === 'image') return categoryIcon('image')
  if (type === 'video') return categoryIcon('video')
  if (type === 'group') return categoryIcon('group')
  return <Box size={15} />
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function previewLooksVideo(url: string) {
  return /\.(mp4|mov|m4v|webm)(?:[?#].*)?$/i.test(url)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asNumber(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

function payloadNodeId(node: Record<string, unknown>) {
  const data = asRecord(node.data)
  return firstString(node.id, data.nodeKey)
}

function payloadNodeMediaUrl(node: Record<string, unknown>) {
  const data = asRecord(node.data)
  const urls = stringArray(data.url)
  const meta = asRecord(data._resourceMeta)
  const items = Array.isArray(meta.items) ? meta.items.map(asRecord) : []
  const metaUrl = firstString(
    ...items.map(item => firstString(item.displayUrl, item.thumbUrl, item.thumbnailUrl, item.posterUrl, item.originalUrl))
  )
  const params = asRecord(data.params)
  return firstString(
    data._primaryAssetUrl,
    data.previewUrl,
    data.displayUrl,
    data.imageUrl,
    data.videoUrl,
    data.poster,
    data.src,
    data.assetUrl,
    params.previewUrl,
    params.imageUrl,
    params.videoUrl,
    urls[0],
    metaUrl
  )
}

function payloadNodeBox(node: Record<string, unknown>) {
  const data = asRecord(node.data)
  const position = asRecord(node.position)
  const measured = asRecord(node.measured)
  const style = asRecord(node.style)
  return {
    x: asNumber(position.x),
    y: asNumber(position.y),
    width: Math.max(12, asNumber(data.contentWidth, asNumber(node.width, asNumber(measured.width, asNumber(style.width, 220))))),
    height: Math.max(12, asNumber(data.contentHeight, asNumber(node.height, asNumber(measured.height, asNumber(style.height, 140))))),
  }
}

function payloadNodeType(node: Record<string, unknown>) {
  const data = asRecord(node.data)
  return firstString(node.type, data.type)
}

function payloadNodeLabel(node: Record<string, unknown>) {
  const data = asRecord(node.data)
  return firstString(data.name, data.type, node.type, 'node')
}

function favoriteItemRootNode(item: FavoriteLibraryItem) {
  const nodes = Array.isArray(item.payload?.nodes) ? item.payload.nodes.map(asRecord) : []
  if (!nodes.length) return null
  const rootIds = Array.isArray(item.payload?.rootIds) ? item.payload.rootIds : []
  const rootKey = firstString(item.sourceRootKey, rootIds[0])
  return nodes.find(node => {
    const data = asRecord(node.data)
    return firstString(node.id, data.nodeKey) === rootKey
  }) ?? nodes[0]
}

function favoriteItemCategory(item: FavoriteLibraryItem): FavoriteCategory {
  if (item.itemType === 'image') return 'image'
  if (item.itemType === 'video') return 'video'
  if (item.itemType === 'group') return 'group'

  const rootNode = favoriteItemRootNode(item)
  const rootType = rootNode ? payloadNodeType(rootNode) : ''
  if (rootType === 'text') return 'text'
  if (rootType === 'image' || rootType === 'director_stage') return 'image'
  if (rootType === 'video' || rootType === 'video_merge') return 'video'
  if (rootType === 'group') return 'group'
  return 'other'
}

function buildGroupPreview(item: FavoriteLibraryItem) {
  const rawNodes = Array.isArray(item.payload?.nodes) ? item.payload.nodes.map(asRecord) : []
  const nodes = rawNodes
    .filter(node => {
      const type = payloadNodeType(node)
      return type !== 'group' && payloadNodeId(node)
    })
    .slice(0, 42)
  if (!nodes.length) return null

  const boxes = nodes.map(node => ({ node, id: payloadNodeId(node), box: payloadNodeBox(node) }))
  const minX = Math.min(...boxes.map(entry => entry.box.x))
  const minY = Math.min(...boxes.map(entry => entry.box.y))
  const maxX = Math.max(...boxes.map(entry => entry.box.x + entry.box.width))
  const maxY = Math.max(...boxes.map(entry => entry.box.y + entry.box.height))
  const viewWidth = 112
  const viewHeight = 92
  const margin = 7
  const rawWidth = Math.max(1, maxX - minX)
  const rawHeight = Math.max(1, maxY - minY)
  const scale = Math.min((viewWidth - margin * 2) / rawWidth, (viewHeight - margin * 2) / rawHeight)
  const contentWidth = rawWidth * scale
  const contentHeight = rawHeight * scale
  const offsetX = margin + (viewWidth - margin * 2 - contentWidth) / 2
  const offsetY = margin + (viewHeight - margin * 2 - contentHeight) / 2

  const renderedNodes = boxes.map(entry => {
    const left = offsetX + (entry.box.x - minX) * scale
    const top = offsetY + (entry.box.y - minY) * scale
    const width = Math.max(8, entry.box.width * scale)
    const height = Math.max(8, entry.box.height * scale)
    const mediaUrl = payloadNodeMediaUrl(entry.node)
    return {
      id: entry.id,
      label: payloadNodeLabel(entry.node),
      mediaUrl,
      isVideo: previewLooksVideo(mediaUrl),
      rect: { left, top, width, height },
    }
  })

  const nodeById = new Map(renderedNodes.map(node => [node.id, node]))
  const edges = (Array.isArray(item.payload?.edges) ? item.payload.edges.map(asRecord) : [])
    .map(edge => {
      const source = nodeById.get(firstString(edge.source))
      const target = nodeById.get(firstString(edge.target))
      if (!source || !target) return null
      const sx = source.rect.left + source.rect.width
      const sy = source.rect.top + source.rect.height / 2
      const tx = target.rect.left
      const ty = target.rect.top + target.rect.height / 2
      const bend = Math.max(12, Math.abs(tx - sx) * 0.45)
      return {
        id: firstString(edge.id, `${source.id}-${target.id}`),
        d: `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${(sx + bend).toFixed(1)} ${sy.toFixed(1)}, ${(tx - bend).toFixed(1)} ${ty.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`,
      }
    })
    .filter((edge): edge is { id: string; d: string } => Boolean(edge))

  return { viewWidth, viewHeight, nodes: renderedNodes, edges }
}

function GroupLibraryPreview({ item }: { item: FavoriteLibraryItem }) {
  const preview = useMemo(() => buildGroupPreview(item), [item])
  if (!preview) {
    return (
      <div className="favorite-library-preview-placeholder">
        {itemTypeIcon('group')}
      </div>
    )
  }

  return (
    <div className="favorite-group-preview" aria-hidden="true">
      <svg viewBox={`0 0 ${preview.viewWidth} ${preview.viewHeight}`} preserveAspectRatio="none">
        {preview.edges.map(edge => <path key={edge.id} d={edge.d} />)}
      </svg>
      {preview.nodes.map(node => {
        const style = {
          left: node.rect.left,
          top: node.rect.top,
          width: node.rect.width,
          height: node.rect.height,
        } as CSSProperties
        return (
          <div key={node.id} className="favorite-group-preview-node" style={style}>
            {node.mediaUrl ? (
              node.isVideo ? (
                <video src={node.mediaUrl} muted playsInline preload="metadata" draggable={false} />
              ) : (
                <img src={node.mediaUrl} alt="" loading="lazy" draggable={false} />
              )
            ) : (
              <span className="favorite-group-preview-node-fallback">{itemTypeIcon('node')}</span>
            )}
            {node.rect.width > 24 && (
              <span className="favorite-group-preview-node-label">{node.label}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function FavoriteLibraryPanel({ mode = 'assets', onClose, onInsert, onDragStart }: FavoriteLibraryPanelProps) {
  const [panelMemory, setPanelMemory] = useState<Record<FavoriteLibraryMode, FavoritePanelMemory>>(() => ({
    assets: readFavoritePanelMemory('assets'),
    shared: readFavoritePanelMemory('shared'),
  }))
  const [items, setItems] = useState<FavoriteLibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cardMenu, setCardMenu] = useState<{ item: FavoriteLibraryItem; x: number; y: number } | null>(null)
  const [settingsItem, setSettingsItem] = useState<FavoriteLibraryItem | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isSharedMode = mode === 'shared'
  const currentMemory = panelMemory[mode] ?? DEFAULT_PANEL_MEMORY
  const { type, label: labelFilter, project: projectFilter, sortOrder, query } = currentMemory
  const title = isSharedMode ? '共享空间' : '资产库'
  const kicker = isSharedMode ? '团队共享库' : '节点收藏库'
  const emptyTitle = isSharedMode ? '还没有共享内容' : '还没有收藏内容'
  const emptyHint = isSharedMode
    ? '选中节点或分组，在上方工具条点击共享。'
    : '选中节点或分组，在上方工具条点击收藏。'
  const sortPrefix = isSharedMode ? '共享时间' : '收藏时间'

  const updateMemory = useCallback((patch: Partial<FavoritePanelMemory>) => {
    setPanelMemory(current => {
      const next = {
        ...(current[mode] ?? DEFAULT_PANEL_MEMORY),
        ...patch,
      }
      writeFavoritePanelMemory(mode, next)
      return { ...current, [mode]: next }
    })
  }, [mode])

  const loadItems = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await (mode === 'shared' ? favoritesApi.listShared : favoritesApi.list)({
        q: query.trim() || undefined,
      })
      setItems(res.items)
    } catch (err) {
      console.error('load favorites failed', err)
      setError(mode === 'shared' ? '共享空间加载失败' : '资产库加载失败')
    } finally {
      setLoading(false)
    }
  }, [mode, query])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  useEffect(() => {
    const reload = () => void loadItems()
    const eventName = mode === 'shared' ? 'shotflow:shared-assets-changed' : 'shotflow:favorites-changed'
    window.addEventListener(eventName, reload)
    return () => window.removeEventListener(eventName, reload)
  }, [loadItems, mode])

  const stats = useMemo(() => {
    const mine = items.filter(item => item.isOwner).length
    return { sharedTotal: items.length, myShared: mine }
  }, [items])

  const filteredItems = useMemo(() => items.filter(item => {
    if (type !== 'all' && favoriteItemCategory(item) !== type) return false
    // 没打标签 / 没归项目的资产只出现在"全部"里
    if (labelFilter && readAssetLabel(item.tags) !== labelFilter) return false
    if (projectFilter && readAssetProject(item.tags) !== projectFilter) return false
    return true
  }), [items, labelFilter, projectFilter, type])

  const sortedItems = useMemo(() => {
    const direction = sortOrder === 'shared_asc' ? 1 : -1
    return [...filteredItems].sort((a, b) => {
      const left = Number(a.updatedAtMs || a.createdAtMs || 0)
      const right = Number(b.updatedAtMs || b.createdAtMs || 0)
      if (left !== right) return (left - right) * direction
      return (Number(a.id) - Number(b.id)) * direction
    })
  }, [filteredItems, sortOrder])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = listRef.current
      if (!element) return
      const maxTop = Math.max(0, element.scrollHeight - element.clientHeight)
      element.scrollTop = Math.min(currentMemory.scrollTop, maxTop)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [currentMemory.scrollTop, mode, sortedItems.length])

  // 列表项的 payload 可能是精简过的，插入前必须取一次详情，
  // 否则会插入一个空副本。失败要明确提示，不能静默吞掉。
  const insertItem = useCallback(async (item: FavoriteLibraryItem) => {
    setBusyId(item.id)
    try {
      const detail = (await (isSharedMode ? favoritesApi.getShared(item.id) : favoritesApi.get(item.id))).item
      await onInsert(detail)
    } catch (err) {
      console.error('insert favorite failed', err)
      window.alert('插入失败')
    } finally {
      setBusyId(null)
    }
  }, [isSharedMode, onInsert])

  // 标签和项目都写在收藏记录原有的 tags 数组里（带 label: / project: 前缀），
  // 所以这里只要 PATCH tags —— 服务端本来就收这个字段，没加接口也没改表。
  const saveItemTaxonomy = useCallback(async (
    item: FavoriteLibraryItem,
    next: { label: string; project: string },
  ) => {
    const tags = withAssetProject(withAssetLabel(item.tags, next.label), next.project)
    setBusyId(item.id)
    try {
      const updated = await (isSharedMode
        ? favoritesApi.updateShared(item.id, { tags })
        : favoritesApi.update(item.id, { tags }))
      // 用服务端回的那份（tags 会被规范化：去重、截长度），别拿本地猜的顶上去
      const serverTags = updated.item?.tags ?? tags
      setItems(current => current.map(entry => (
        entry.id === item.id ? { ...entry, tags: serverTags } : entry
      )))
      setSettingsItem(null)
    } catch (err) {
      console.error('update favorite taxonomy failed', err)
      window.alert('保存标签 / 项目失败')
    } finally {
      setBusyId(null)
    }
  }, [isSharedMode])

  const shareItem = useCallback(async (item: FavoriteLibraryItem) => {
    setBusyId(item.id)
    try {
      await favoritesApi.createShared({
        itemType: item.itemType,
        sourceProjectUuid: item.sourceProjectUuid,
        sourceRootKey: item.sourceRootKey,
        title: item.title,
        description: item.description,
        previewUrl: item.previewUrl,
        nodeCount: item.nodeCount,
        shared: true,
        tags: Array.from(new Set([...(item.tags ?? []), 'shared'])),
        payload: item.payload,
      })
      window.dispatchEvent(new CustomEvent('shotflow:shared-assets-changed'))
    } catch (err) {
      console.error('toggle favorite shared failed', err)
      window.alert('共享失败')
    } finally {
      setBusyId(null)
    }
  }, [])

  const deleteItem = useCallback(async (item: FavoriteLibraryItem) => {
    if (!item.canManage) return
    if (!window.confirm(`${isSharedMode ? '取消共享' : '删除收藏'}「${item.title}」？`)) return
    setBusyId(item.id)
    try {
      if (isSharedMode) await favoritesApi.deleteShared(item.id)
      else await favoritesApi.delete(item.id)
      setItems(current => current.filter(entry => entry.id !== item.id))
      window.dispatchEvent(new CustomEvent(isSharedMode ? 'shotflow:shared-assets-changed' : 'shotflow:favorites-changed'))
    } catch (err) {
      console.error('delete favorite failed', err)
      window.alert(isSharedMode ? '取消共享失败' : '删除收藏失败')
    } finally {
      setBusyId(null)
    }
  }, [isSharedMode])

  return (
    <aside className="favorite-library-panel nodrag nopan" aria-label={title}>
      <header className="favorite-library-header">
        <div>
          <div className="favorite-library-kicker">
            <Star size={13} fill="currentColor" />
            {kicker}
          </div>
          <h2>{title}</h2>
        </div>
        <div className="favorite-library-header-actions">
          <button type="button" title="刷新" onClick={() => void loadItems()}>
            <RefreshCw size={15} className={loading ? 'favorite-spin' : undefined} />
          </button>
          <button type="button" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </header>

      {isSharedMode && (
        <div className="favorite-library-stats">
          <span>{stats.sharedTotal}<small>共享总数</small></span>
          <span>{stats.myShared}<small>我的共享数</small></span>
        </div>
      )}

      <div className="favorite-library-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => updateMemory({ query: event.currentTarget.value, scrollTop: 0 })}
          placeholder={isSharedMode ? '搜索共享的节点、图片、视频、组' : '搜索收藏的节点、图片、视频、组'}
        />
      </div>

      <div className="favorite-library-filter-row">
        <select
          className="favorite-library-filter-select"
          value={type}
          onChange={(event) => updateMemory({ type: event.currentTarget.value as FavoriteTypeFilter, scrollTop: 0 })}
          aria-label="按类型筛选"
        >
          {ASSET_TYPE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="favorite-library-filter-select"
          value={labelFilter}
          onChange={(event) => updateMemory({ label: event.currentTarget.value, scrollTop: 0 })}
          aria-label="按标签筛选"
        >
          <option value={ASSET_FILTER_ALL}>全部标签</option>
          {ASSET_LABEL_OPTIONS.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <select
          className="favorite-library-filter-select"
          value={projectFilter}
          onChange={(event) => updateMemory({ project: event.currentTarget.value, scrollTop: 0 })}
          aria-label="按项目筛选"
        >
          <option value={ASSET_FILTER_ALL}>全部项目</option>
          {ASSET_PROJECT_OPTIONS.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <select
          className="favorite-library-filter-select"
          value={sortOrder}
          onChange={(event) => updateMemory({ sortOrder: event.currentTarget.value as FavoriteSortOrder, scrollTop: 0 })}
          aria-label="共享时间排序"
        >
          <option value="shared_desc">{sortPrefix}由近到远</option>
          <option value="shared_asc">{sortPrefix}由远到近</option>
        </select>
      </div>

      {error && <div className="favorite-library-error">{error}</div>}

      <div
        ref={listRef}
        className="favorite-library-list favorite-library-tile-grid"
        onScroll={(event) => updateMemory({ scrollTop: event.currentTarget.scrollTop })}
      >
        {loading && items.length === 0 ? (
          <div className="favorite-library-empty">正在加载{title}...</div>
        ) : sortedItems.length === 0 ? (
          <div className="favorite-library-empty">
            <Star size={24} />
            <strong>{emptyTitle}</strong>
            <span>{emptyHint}</span>
          </div>
        ) : sortedItems.map(item => {
          const category = favoriteItemCategory(item)
          const itemLabel = readAssetLabel(item.tags)
          const itemProject = readAssetProject(item.tags)
          const busy = busyId === item.id
          const meta = [
            categoryLabel(category),
            `${item.nodeCount} 个节点`,
            item.ownerName,
            formatTime(item.updatedAtMs),
            itemLabel && `标签 ${itemLabel}`,
            itemProject && `项目 ${itemProject}`,
            ...visibleAssetTags(item.tags),
          ].filter(Boolean).join(' · ')
          return (
            <article
              key={item.id}
              className={`favorite-library-tile is-${category}${busy ? ' is-busy' : ''}`}
              title={`${item.title}\n${meta}\n右键更多操作`}
              draggable
              onDragStart={(event) => onDragStart?.(item, event)}
              onDoubleClick={() => void insertItem(item)}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setSettingsItem(null)
                setCardMenu({ item, x: event.clientX, y: event.clientY })
              }}
            >
              <div className="favorite-library-tile-thumb">
                {item.itemType === 'group' ? (
                  <GroupLibraryPreview item={item} />
                ) : item.previewUrl ? (
                  previewLooksVideo(item.previewUrl) ? (
                    <video src={item.previewUrl} muted playsInline preload="metadata" draggable={false} />
                  ) : (
                    <img src={item.previewUrl} alt="" loading="lazy" draggable={false} />
                  )
                ) : (
                  <div className="favorite-library-preview-placeholder">
                    {itemTypeIcon(item.itemType)}
                  </div>
                )}
                <span className={`favorite-library-tile-kind is-${category}`} aria-hidden="true">
                  {categoryIcon(category, 12)}
                </span>
                <div className="favorite-library-tile-buttons">
                  <button
                    type="button"
                    title="插入画布"
                    aria-label="插入画布"
                    disabled={busy}
                    onClick={(event) => { event.stopPropagation(); void insertItem(item) }}
                  >
                    <CopyPlus size={13} strokeWidth={2.2} />
                  </button>
                  <button
                    type="button"
                    title={item.canManage ? '设置标签与项目' : '只有拥有者能改标签与项目'}
                    aria-label="设置标签与项目"
                    disabled={busy || !item.canManage}
                    onClick={(event) => { event.stopPropagation(); setCardMenu(null); setSettingsItem(item) }}
                  >
                    <Settings size={13} strokeWidth={2.2} />
                  </button>
                </div>
                {(itemLabel || itemProject) && (
                  <div className="favorite-library-tile-chips">
                    {itemProject && <span className="is-project">{itemProject}</span>}
                    {itemLabel && <span>{itemLabel}</span>}
                  </div>
                )}
              </div>
              <span className="favorite-library-tile-title">{item.title}</span>
            </article>
          )
        })}
      </div>

      {cardMenu && (
        <FavoriteTileMenu
          x={cardMenu.x}
          y={cardMenu.y}
          item={cardMenu.item}
          isSharedMode={isSharedMode}
          onClose={() => setCardMenu(null)}
          onInsert={() => { const target = cardMenu.item; setCardMenu(null); void insertItem(target) }}
          onSettings={() => { const target = cardMenu.item; setCardMenu(null); setSettingsItem(target) }}
          onShare={() => { const target = cardMenu.item; setCardMenu(null); void shareItem(target) }}
          onDelete={() => { const target = cardMenu.item; setCardMenu(null); void deleteItem(target) }}
        />
      )}

      {settingsItem && (
        <FavoriteTileSettings
          item={settingsItem}
          busy={busyId === settingsItem.id}
          onCancel={() => setSettingsItem(null)}
          onSave={(next) => void saveItemTaxonomy(settingsItem, next)}
        />
      )}
    </aside>
  )
}

interface FavoriteTileMenuProps {
  x: number
  y: number
  item: FavoriteLibraryItem
  isSharedMode: boolean
  onClose: () => void
  onInsert: () => void
  onSettings: () => void
  onShare: () => void
  onDelete: () => void
}

function FavoriteTileMenu({
  x,
  y,
  item,
  isSharedMode,
  onClose,
  onInsert,
  onSettings,
  onShare,
  onDelete,
}: FavoriteTileMenuProps) {
  useEffect(() => {
    const closeOnPointerDown = (event: MouseEvent) => {
      if (!(event.target as Element)?.closest?.('.favorite-library-tile-menu')) onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', closeOnPointerDown, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [onClose])

  // 贴着窗口右下角右键时把菜单收回可视区
  const width = 196
  const height = isSharedMode ? 132 : 168
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8))

  return (
    <div className="favorite-library-tile-menu" style={{ left, top, width }} role="menu">
      <div className="favorite-library-tile-menu-title" title={item.title}>{item.title}</div>
      <button type="button" onClick={onInsert}>
        <CopyPlus size={14} />
        插入画布
      </button>
      <button type="button" disabled={!item.canManage} onClick={onSettings}>
        <Settings size={14} />
        设置标签与项目
      </button>
      {!isSharedMode && (
        <button type="button" onClick={onShare}>
          <Share2 size={14} />
          共享到团队
        </button>
      )}
      {item.canManage && (
        <button type="button" className="is-danger" onClick={onDelete}>
          <Trash2 size={14} />
          {isSharedMode ? '取消共享' : '删除收藏'}
        </button>
      )}
    </div>
  )
}

interface FavoriteTileSettingsProps {
  item: FavoriteLibraryItem
  busy: boolean
  onCancel: () => void
  onSave: (next: { label: string; project: string }) => void
}

function FavoriteTileSettings({ item, busy, onCancel, onSave }: FavoriteTileSettingsProps) {
  const [label, setLabel] = useState(() => readAssetLabel(item.tags))
  const [project, setProject] = useState(() => readAssetProject(item.tags))

  useEffect(() => {
    setLabel(readAssetLabel(item.tags))
    setProject(readAssetProject(item.tags))
  }, [item])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [onCancel])

  return (
    <div className="favorite-library-settings-backdrop" onMouseDown={onCancel}>
      <div
        className="favorite-library-settings"
        role="dialog"
        aria-label="设置标签与项目"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 title={item.title}>{item.title}</h3>
        <label>
          <span>标签</span>
          <select value={label} onChange={(event) => setLabel(event.currentTarget.value)}>
            <option value={ASSET_FILTER_ALL}>未设置</option>
            {ASSET_LABEL_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label>
          <span>项目</span>
          <select value={project} onChange={(event) => setProject(event.currentTarget.value)}>
            <option value={ASSET_FILTER_ALL}>未设置</option>
            {ASSET_PROJECT_OPTIONS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <div className="favorite-library-settings-actions">
          <button type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button
            type="button"
            className="is-primary"
            disabled={busy}
            onClick={() => onSave({ label, project })}
          >
            {busy ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
