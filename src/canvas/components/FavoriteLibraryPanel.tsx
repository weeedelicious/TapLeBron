import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Box,
  CopyPlus,
  FileText,
  Expand,
  FolderOpen,
  Image as ImageIcon,
  Layers3,
  RefreshCw,
  Search,
  Share2,
  Star,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import { favoritesApi, projectAssetLibraryApi, type ProjectAssetInsertPayload, type ProjectAssetLibraryItem, type ProjectAssetLibraryProject } from '@/lib/api'
import { ImagePreview, type ImagePreviewItem } from '@/components/ImagePreview'
import type { FavoriteLibraryItem, FavoriteLibraryItemType } from '@/lib/types'

type FavoriteLibraryMode = 'assets' | 'shared'
type FavoriteCategory = 'text' | 'image' | 'video' | 'group' | 'other'
type FavoriteTypeFilter = 'all' | FavoriteCategory
type FavoriteSortOrder = 'shared_desc' | 'shared_asc'
type FavoritePanelMemory = {
  type: FavoriteTypeFilter
  sortOrder: FavoriteSortOrder
  query: string
  scrollTop: number
}

interface FavoriteLibraryPanelProps {
  mode?: FavoriteLibraryMode
  onClose: () => void
  onInsert: (item: FavoriteLibraryItem) => void
  onInsertProjectAsset?: (asset: ProjectAssetInsertPayload) => void
  onDragStart?: (item: FavoriteLibraryItem, event: DragEvent<HTMLElement>) => void
}

const TYPE_LABELS: Array<{ key: FavoriteTypeFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'text', label: '文本' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'group', label: '组' },
  { key: 'other', label: '其他' },
]

const DEFAULT_PANEL_MEMORY: FavoritePanelMemory = {
  type: 'all',
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

export function FavoriteLibraryPanel({ mode = 'assets', onClose, onInsert, onInsertProjectAsset, onDragStart }: FavoriteLibraryPanelProps) {
  const [panelMemory, setPanelMemory] = useState<Record<FavoriteLibraryMode, FavoritePanelMemory>>(() => ({
    assets: readFavoritePanelMemory('assets'),
    shared: readFavoritePanelMemory('shared'),
  }))
  const [items, setItems] = useState<FavoriteLibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [projectLibraryOpen, setProjectLibraryOpen] = useState(true)
  const isSharedMode = mode === 'shared'
  const currentMemory = panelMemory[mode] ?? DEFAULT_PANEL_MEMORY
  const { type, sortOrder, query } = currentMemory
  const title = isSharedMode ? '共享空间' : projectLibraryOpen ? '项目资产库' : '我的资产库'
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

  const filteredItems = useMemo(() => (
    type === 'all'
      ? items
      : items.filter(item => favoriteItemCategory(item) === type)
  ), [items, type])

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
          <button type="button" title="刷新" onClick={() => { if (projectLibraryOpen) window.dispatchEvent(new Event("shotflow:project-assets-refresh")); else void loadItems() }}>
            <RefreshCw size={15} className={loading ? 'favorite-spin' : undefined} />
          </button>
          <button type="button" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="favorite-library-tabs" role="tablist" aria-label="资产库切换">
        <button type="button" className={projectLibraryOpen ? 'is-active' : undefined} onClick={() => setProjectLibraryOpen(true)}>项目资产库</button>
        <button type="button" className={!projectLibraryOpen ? 'is-active' : undefined} onClick={() => setProjectLibraryOpen(false)}>我的资产库</button>
      </div>

      {projectLibraryOpen ? (
        <ProjectAssetLibraryPane onInsertProjectAsset={onInsertProjectAsset} />
      ) : (
      <>
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

      <div className="favorite-library-type-row">
        <div className="favorite-library-type-buttons">
          {TYPE_LABELS.map(option => (
            <button
              key={option.key}
              type="button"
              value={option.key}
              className={type === option.key ? 'is-active' : ''}
              onClick={() => updateMemory({ type: option.key, scrollTop: 0 })}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="favorite-library-sort-wrap">
          <select
            className="favorite-library-sort-select"
            value={sortOrder}
            onChange={(event) => updateMemory({ sortOrder: event.currentTarget.value as FavoriteSortOrder, scrollTop: 0 })}
            aria-label="时间排序"
          >
            <option value="shared_desc">{sortPrefix} · 由近到远</option>
            <option value="shared_asc">{sortPrefix} · 由远到近</option>
          </select>
        </div>
      </div>

      {error && <div className="favorite-library-error">{error}</div>}

      {/* 和项目资产库同一套方块网格：一排三个，拖进画布或双击插入副本 */}
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
          const busy = busyId === item.id
          const detail = [
            `${item.nodeCount} 个节点`,
            item.ownerName || '',
            item.updatedAtMs ? formatTime(item.updatedAtMs) : '',
          ].filter(Boolean).join(' · ')
          return (
            <article
              key={item.id}
              className={`favorite-library-tile is-${category}${busy ? ' is-busy' : ''}`}
              title={`${item.title}\n${detail}${item.tags.length ? `\n${item.tags.join(' / ')}` : ''}`}
              draggable
              onDragStart={(event) => onDragStart?.(item, event)}
              onDoubleClick={() => { if (!busy) void insertItem(item) }}
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
                <span className="favorite-library-tile-kind" title={categoryLabel(category)}>
                  {categoryIcon(category)}
                </span>
                <div className="favorite-library-tile-buttons">
                  <button
                    type="button"
                    title="插入副本"
                    draggable={false}
                    disabled={busy}
                    onPointerDown={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onClick={(event) => { event.stopPropagation(); void insertItem(item) }}
                  >
                    <CopyPlus size={12} />
                  </button>
                  {!isSharedMode && (
                    <button
                      type="button"
                      title="共享"
                      draggable={false}
                      disabled={busy}
                      onPointerDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); void shareItem(item) }}
                    >
                      <Share2 size={12} />
                    </button>
                  )}
                  {item.canManage && (
                    <button
                      type="button"
                      title="删除"
                      draggable={false}
                      disabled={busy}
                      onPointerDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); void deleteItem(item) }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                {isSharedMode && (
                  <div className="favorite-library-tile-chips"><span>共享</span></div>
                )}
              </div>
              <div className="project-asset-caption">
                <strong>{item.title}</strong>
              </div>
            </article>
          )
        })}
      </div>
      </>
      )}
    </aside>
  )
}

const PROJECT_ASSET_HOVER_DELAY_MS = 160
const PROJECT_ASSET_HOVER_MAX_WIDTH = 420
const PROJECT_ASSET_HOVER_MAX_HEIGHT = 460

function placeProjectAssetHover(rect: DOMRect) {
  const maxWidth = Math.min(PROJECT_ASSET_HOVER_MAX_WIDTH, Math.max(220, window.innerWidth * 0.38))
  const maxHeight = Math.min(PROJECT_ASSET_HOVER_MAX_HEIGHT, Math.max(220, window.innerHeight * 0.72))
  const gap = 14
  let left = rect.right + gap
  if (left + maxWidth > window.innerWidth - 12) left = Math.max(12, rect.left - gap - maxWidth)
  let top = rect.top
  if (top + maxHeight > window.innerHeight - 12) top = Math.max(12, window.innerHeight - 12 - maxHeight)
  return { left, top, maxWidth, maxHeight }
}

const PROJECT_ASSET_STAGES = [
  { id: 'all', label: '全部' },
  { id: '2d', label: '2D美术' },
  { id: '3d', label: '3D美术' },
  { id: 'atmosphere', label: '氛围图' },
] as const
const PROJECT_ASSET_TYPES = [
  { id: 'all', label: '全部' },
  { id: 'character', label: '角色' },
  { id: 'scene', label: '场景' },
  { id: 'hero', label: '英雄' },
] as const

function readProjectAssetFilter<T extends string>(key: string, allow: readonly T[]): T {
  try {
    const value = window.localStorage.getItem(key) || ''
    return (allow as readonly string[]).includes(value) ? value as T : allow[0]
  } catch {
    return allow[0]
  }
}

function rememberProjectAssetSetting(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch {}
}

function projectAssetErrorText(err: unknown, fallback: string) {
  const data = (err as { response?: { data?: { error?: unknown; message?: unknown } } } | null)?.response?.data
  const message = data?.error ?? data?.message
  return typeof message === 'string' && message.trim() ? message : fallback
}

/**
 * 项目资产库：按游戏列出 CGTeamWork 资产表里登记的 2D / 3D 美术和氛围图，可按环节、类型（含英雄）筛选。
 * 拖进画布或双击时交给服务端导入（projectId + relativePath），不在浏览器里转存原图。
 */
function ProjectAssetLibraryPane({
  onInsertProjectAsset,
}: {
  onInsertProjectAsset?: (asset: ProjectAssetInsertPayload) => void
}) {
  type StageId = typeof PROJECT_ASSET_STAGES[number]['id']
  type TypeId = typeof PROJECT_ASSET_TYPES[number]['id']
  const [games, setGames] = useState<ProjectAssetLibraryProject[]>([])
  const [gameId, setGameId] = useState<number | ''>(() => {
    try {
      const value = Number(window.localStorage.getItem('shotflow:project-asset-library:project-id'))
      return Number.isFinite(value) && value > 0 ? value : ''
    } catch {
      return ''
    }
  })
  const [assets, setAssets] = useState<ProjectAssetLibraryItem[]>([])
  const [typeLabels, setTypeLabels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [stage, setStage] = useState<StageId>(() => readProjectAssetFilter('shotflow:project-asset-library:stage', PROJECT_ASSET_STAGES.map((item) => item.id)))
  const [assetType, setAssetType] = useState<TypeId>(() => readProjectAssetFilter('shotflow:project-asset-library:asset-type', PROJECT_ASSET_TYPES.map((item) => item.id)))
  const [query, setQuery] = useState('')
  const [viewer, setViewer] = useState<{ url: string; name: string; kind: 'image' | 'video'; items: ImagePreviewItem[] } | null>(null)
  const [hover, setHover] = useState<{
    previewUrl: string
    thumbUrl: string
    name: string
    left: number
    top: number
    maxWidth: number
    maxHeight: number
  } | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  // 切换游戏时旧请求可能晚到，用序号丢掉过期结果。
  const requestSeqRef = useRef(0)

  const clearHover = useCallback(() => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setHover(null)
  }, [])

  useEffect(() => () => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
  }, [])

  const loadGames = useCallback(async () => {
    try {
      const list = await projectAssetLibraryApi.listProjects()
      setGames(Array.isArray(list) ? list : [])
      setError('')
    } catch (err) {
      setGames([])
      setError(projectAssetErrorText(err, '游戏列表加载失败'))
    }
  }, [])

  const loadAssets = useCallback(async (id: number, token: number) => {
    setLoading(true)
    setError('')
    try {
      const data = await projectAssetLibraryApi.listModules(id)
      if (token !== requestSeqRef.current) return
      setAssets(Array.isArray(data.assets) ? data.assets : [])
      // 筛选按钮名按游戏走：火炬叫「英雄」，心动小镇叫「NPC」
      setTypeLabels(Object.fromEntries((Array.isArray(data.assetTypes) ? data.assetTypes : []).map((item) => [item.id, item.label])))
      rememberProjectAssetSetting('shotflow:project-asset-library:project-id', String(id))
    } catch (err) {
      if (token !== requestSeqRef.current) return
      setAssets([])
      setError(projectAssetErrorText(err, '项目资产库加载失败'))
    } finally {
      if (token === requestSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void loadGames() }, [loadGames])
  useEffect(() => {
    const refresh = () => { void loadGames() }
    window.addEventListener('shotflow:project-assets-refresh', refresh)
    return () => window.removeEventListener('shotflow:project-assets-refresh', refresh)
  }, [loadGames])
  useEffect(() => {
    if (!games.length) return
    const selected = games.some((item) => item.id === gameId) ? gameId : games[0].id
    if (selected !== gameId) {
      setGameId(selected)
      return
    }
    const token = requestSeqRef.current + 1
    requestSeqRef.current = token
    void loadAssets(Number(selected), token)
  }, [gameId, games, loadAssets])

  const keyword = query.trim().toLowerCase()
  const filtered = assets.filter((item) => (
    (stage === 'all' || item.stage === stage)
    && (assetType === 'all' || (assetType === 'hero' ? Boolean(item.hero) : item.assetType === assetType))
    && (!keyword || String(item.name || '').toLowerCase().includes(keyword))
  ))

  const chooseStage = (value: StageId) => {
    setStage(value)
    rememberProjectAssetSetting('shotflow:project-asset-library:stage', value)
    clearHover()
  }
  const chooseType = (value: TypeId) => {
    setAssetType(value)
    rememberProjectAssetSetting('shotflow:project-asset-library:asset-type', value)
    clearHover()
  }

  return (
    <>
      <div className="favorite-library-sort-wrap project-asset-game">
        <select
          className="favorite-library-sort-select"
          aria-label="选择游戏"
          value={gameId}
          onChange={(event) => {
            const next = Number(event.currentTarget.value)
            setGameId(Number.isFinite(next) && next > 0 ? next : '')
          }}
        >
          {games.length === 0 ? <option value="">暂无游戏</option> : null}
          {games.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      <div className="favorite-library-search project-asset-search">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索名称" aria-label="搜索资产" />
      </div>
      <div className="project-asset-filters">
        <div className="favorite-library-type-buttons project-asset-filter-row">
          {PROJECT_ASSET_STAGES.map((item) => (
            <button key={item.id} type="button" className={stage === item.id ? 'is-active' : undefined} onClick={() => chooseStage(item.id)}>{item.label}</button>
          ))}
        </div>
        <div className="favorite-library-type-buttons project-asset-filter-row">
          {PROJECT_ASSET_TYPES.map((item) => (
            <button key={item.id} type="button" className={assetType === item.id ? 'is-active' : undefined} onClick={() => chooseType(item.id)}>{typeLabels[item.id] || item.label}</button>
          ))}
        </div>
      </div>
      {error ? <div className="favorite-library-error">{error}</div> : null}
      <div className="favorite-library-list favorite-library-tile-grid" onScroll={clearHover}>
        {loading ? (
          <div className="favorite-library-empty">正在加载项目资产库...</div>
        ) : gameId ? (
          filtered.length === 0 ? (
            <div className="favorite-library-empty">
              <FolderOpen size={24} />
              <strong>{keyword ? '没有找到匹配的资产' : '这个筛选下没有资产'}</strong>
              <span>{keyword ? '换个关键词再试。' : '换个环节或类型看看。'}</span>
            </div>
          ) : filtered.map((item) => {
            const projectNumber = Number(gameId)
            const originalUrl = projectAssetLibraryApi.fileUrl(projectNumber, item.relativePath)
            // 列表小图和悬停预览都用 360P（短边 360），浏览大图用 1080P；插入画布 / 下载仍是原图
            const thumbUrl = projectAssetLibraryApi.shortEdgeUrl(projectNumber, item.relativePath, 360)
            const previewUrl = thumbUrl
            const payload: ProjectAssetInsertPayload = {
              projectId: projectNumber,
              relativePath: item.relativePath,
              url: originalUrl,
              name: item.name,
              mediaType: item.mediaType,
            }
            return (
              <article
                key={item.relativePath}
                className="favorite-library-tile is-image"
                title={item.name}
                draggable
                onMouseEnter={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
                  hoverTimerRef.current = window.setTimeout(() => {
                    setHover({ previewUrl, thumbUrl, name: item.name, ...placeProjectAssetHover(rect) })
                  }, PROJECT_ASSET_HOVER_DELAY_MS)
                }}
                onMouseLeave={clearHover}
                onDragStart={(event) => {
                  clearHover()
                  event.dataTransfer.effectAllowed = 'copy'
                  event.dataTransfer.setData('application/x-shotflow-project-asset', JSON.stringify(payload))
                  event.dataTransfer.setData('text/plain', originalUrl)
                }}
                onDoubleClick={() => onInsertProjectAsset?.(payload)}
              >
                <div
                  className="favorite-library-tile-thumb"
                  style={{ backgroundImage: 'url("' + thumbUrl + '")', backgroundSize: 'cover', backgroundPosition: 'center' }}
                >
                  {item.mediaType === 'video' ? <span className="project-asset-video-mark">视频</span> : null}
                  <button
                    type="button"
                    className="project-asset-preview-btn"
                    title="浏览大图"
                    draggable={false}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      clearHover()
                      setViewer({
                        url: originalUrl,
                        name: item.name,
                        kind: item.mediaType === 'video' ? 'video' : 'image',
                        items: filtered.map((entry) => ({
                          url: projectAssetLibraryApi.fileUrl(projectNumber, entry.relativePath),
                          viewerUrl: entry.mediaType === 'video' ? undefined : projectAssetLibraryApi.shortEdgeUrl(projectNumber, entry.relativePath, 1080),
                          thumbUrl: projectAssetLibraryApi.shortEdgeUrl(projectNumber, entry.relativePath, 360),
                          name: entry.name,
                        })),
                      })
                    }}
                  >
                    <Expand size={13} strokeWidth={1.9} />
                  </button>
                </div>
                <div className="project-asset-caption">
                  <strong>{item.name}</strong>
                </div>
              </article>
            )
          })
        ) : (
          <div className="favorite-library-empty">
            <FolderOpen size={24} />
            <strong>资产表里还没有可显示的内容</strong>
            <span>表格补上游戏和文件路径后，这里会出现对应资产。</span>
          </div>
        )}
      </div>
      {hover && !viewer ? createPortal(
        <div className="project-asset-hover-preview" style={{ left: hover.left, top: hover.top, maxWidth: hover.maxWidth }}>
          <img
            src={hover.previewUrl}
            alt={hover.name}
            style={{ maxWidth: hover.maxWidth - 16, maxHeight: hover.maxHeight - 40 }}
            onError={(event) => {
              if (event.currentTarget.src !== hover.thumbUrl) event.currentTarget.src = hover.thumbUrl
            }}
          />
          <strong title={hover.name}>{hover.name}</strong>
        </div>,
        document.body,
      ) : null}
      {viewer ? (
        <ImagePreview
          url={viewer.url}
          viewerUrl={viewer.items.find((entry) => entry.url === viewer.url)?.viewerUrl}
          name={viewer.name}
          items={viewer.items}
          kind={viewer.kind}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </>
  )
}
