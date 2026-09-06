import { useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import type { CanvasNodeData, ResourceMeta, VideoHistoryItem } from '@/lib/types'
import { assetHistoryTimestamp, type AssetCreatedAtMap } from '@/lib/assetTimestamps'

export type HistoryAssetKind = 'image' | 'video'

export interface HistoryAsset {
  id: string
  kind: HistoryAssetKind
  url: string
  displayUrl: string
  name: string
  nodeId: string
  timestamp: number
  posterUrl?: string
  meta?: ResourceMeta
}

type HistoryKindFilter = 'all' | HistoryAssetKind
type HistorySortOrder = 'desc' | 'asc'

type HistoryNode = {
  id: string
  data: CanvasNodeData
}

function safeHistoryTimestamp(value: unknown) {
  const time = Number(value)
  return Number.isFinite(time) && time > 0 ? time : Date.now()
}

function formatHistoryDate(timestamp: number) {
  const date = new Date(safeHistoryTimestamp(timestamp))
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isImageUrl(url: string) {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)(?:[?#].*)?$/i.test(String(url || ''))
}

function isVideoUrl(url: string) {
  return /\.(mp4|mov|m4v|webm|mkv|avi)(?:[?#].*)?$/i.test(String(url || ''))
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function videoThumbnailUrl(url: string) {
  if (!url || /#t=/i.test(url)) return url
  return `${url}#t=0.05`
}

function historyAssetKindFromNode(data: CanvasNodeData, url: string, meta?: ResourceMeta): HistoryAssetKind | null {
  if (meta?.kind === 'image' || meta?.kind === 'video') return meta.kind
  if (data.type === 'image' || data.type === 'director_stage') return 'image'
  if (data.type === 'video' || data.type === 'video_merge') return 'video'
  if (data.type === 'upload') {
    if (isVideoUrl(url)) return 'video'
    if (isImageUrl(url)) return 'image'
  }
  return null
}

function resourceMetaForHistoryUrl(data: CanvasNodeData, url: string, kindHint: HistoryAssetKind | null, index: number) {
  const items = (data._resourceMeta?.items ?? []) as ResourceMeta[]
  const direct = items.find(item =>
    (item.kind === kindHint || !kindHint) &&
    (item.originalUrl === url || item.displayUrl === url)
  )
  if (direct) return direct
  const matchingKind = kindHint ? items.filter(item => item.kind === kindHint) : items
  return matchingKind[index] ?? matchingKind[0]
}

function isHistoryUrlHidden(data: CanvasNodeData, url: string, meta?: ResourceMeta) {
  const hiddenUrls = new Set((data._hiddenHistoryUrls ?? []).filter((item): item is string => typeof item === 'string'))
  return hiddenUrls.has(url) ||
    Boolean(meta?.displayUrl && hiddenUrls.has(meta.displayUrl)) ||
    Boolean(meta?.originalUrl && hiddenUrls.has(meta.originalUrl))
}

export function collectHistoryAssets(nodes: HistoryNode[], assetCreatedAtByUrl: AssetCreatedAtMap = {}) {
  const assetMap = new Map<string, HistoryAsset>()

  const pushAsset = (asset: HistoryAsset) => {
    if (!asset.url) return
    const key = `${asset.kind}:${asset.url}`
    const existing = assetMap.get(key)
    if (!existing || asset.timestamp > existing.timestamp) {
      assetMap.set(key, asset)
    }
  }

  for (const node of nodes) {
    const data = node.data as CanvasNodeData
    const urls = (data.url ?? []).filter((url): url is string => typeof url === 'string' && url.trim().length > 0)

    urls.forEach((url, index) => {
      const roughKind = historyAssetKindFromNode(data, url)
      const meta = resourceMetaForHistoryUrl(data, url, roughKind, index)
      const kind = historyAssetKindFromNode(data, url, meta)
      if (isHistoryUrlHidden(data, url, meta)) return
      if (!kind) return
      pushAsset({
        id: `${node.id}-${kind}-${index}`,
        kind,
        url,
        displayUrl: meta?.displayUrl || url,
        name: data.name || (kind === 'video' ? 'video' : 'image'),
        nodeId: node.id,
        timestamp: assetHistoryTimestamp(data, url, meta, assetCreatedAtByUrl, data._updatedAtMs),
        posterUrl: kind === 'video' ? firstText(data.poster) : undefined,
        meta,
      })
    })

    if (data.type === 'video') {
      const params = (data.params ?? {}) as Partial<{ history: VideoHistoryItem[] }>
      ;(params.history ?? []).forEach((item, index) => {
        if (!item?.url) return
        if (isHistoryUrlHidden(data, item.url)) return
        pushAsset({
          id: `${node.id}-video-history-${item.id || index}`,
          kind: 'video',
          url: item.url,
          displayUrl: item.url,
          name: data.name || 'video',
          nodeId: node.id,
          timestamp: assetHistoryTimestamp(data, item.url, undefined, assetCreatedAtByUrl, item.timestamp),
          posterUrl: firstText(
            (item as unknown as Record<string, unknown>).posterUrl,
            (item as unknown as Record<string, unknown>).thumbnailUrl,
            (item as unknown as Record<string, unknown>).poster
          ),
        })
      })
    }
  }

  return Array.from(assetMap.values()).sort((a, b) => b.timestamp - a.timestamp)
}

function historyDownloadFileName(asset: HistoryAsset) {
  const source = asset.meta?.originalUrl || asset.url
  const sourceName = decodeURIComponent(source.split(/[?#]/)[0]?.split('/').pop() || '')
  const fallbackExt = asset.kind === 'video' ? 'mp4' : 'png'
  const safeName = (asset.name || sourceName || asset.kind)
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  const hasExtension = /\.[a-z0-9]{2,5}$/i.test(safeName)
  return hasExtension ? safeName : `${safeName || asset.kind}.${asset.meta?.extension || fallbackExt}`
}

function downloadHistoryAsset(asset: HistoryAsset) {
  const anchor = document.createElement('a')
  anchor.href = asset.meta?.originalUrl || asset.url
  anchor.download = historyDownloadFileName(asset)
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
}

function previewHistoryAsset(asset: HistoryAsset) {
  window.open(asset.displayUrl || asset.url, '_blank', 'noopener,noreferrer')
}

function HistoryVideoThumbnail({ asset }: { asset: HistoryAsset }) {
  return (
    <video
      src={videoThumbnailUrl(asset.displayUrl || asset.url)}
      poster={asset.posterUrl || undefined}
      muted
      playsInline
      preload="metadata"
      draggable={false}
    />
  )
}

export function nodeIncludesHistoryAsset(data: CanvasNodeData, asset: HistoryAsset) {
  const candidates = new Set([
    asset.url,
    asset.displayUrl,
    asset.meta?.originalUrl,
    asset.meta?.displayUrl,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0))

  if ((data.url ?? []).some(url => candidates.has(url))) return true
  if ((data._resourceMeta?.items ?? []).some(item =>
    (item.originalUrl && candidates.has(item.originalUrl)) ||
    (item.displayUrl && candidates.has(item.displayUrl))
  )) return true

  if (data.type === 'video') {
    const params = (data.params ?? {}) as Partial<{ history: VideoHistoryItem[] }>
    if ((params.history ?? []).some(item => item?.url && candidates.has(item.url))) return true
  }

  return false
}

export function HistoryAssetsPanel({
  assets,
  onClose,
  onInsert,
  onDelete,
  onDragStart,
}: {
  assets: HistoryAsset[]
  onClose: () => void
  onInsert: (asset: HistoryAsset) => void
  onDelete: (asset: HistoryAsset) => void
  onDragStart?: (asset: HistoryAsset, event: DragEvent<HTMLDivElement>) => void
}) {
  const imageCount = assets.filter(asset => asset.kind === 'image').length
  const videoCount = assets.filter(asset => asset.kind === 'video').length
  const [activeKind, setActiveKind] = useState<HistoryKindFilter>('all')
  const [sortOrder, setSortOrder] = useState<HistorySortOrder>('desc')
  const [zoom, setZoom] = useState(1)

  const filteredAssets = useMemo(() => {
    const matching = activeKind === 'all' ? assets : assets.filter(asset => asset.kind === activeKind)
    const direction = sortOrder === 'desc' ? -1 : 1
    return [...matching].sort((left, right) => (left.timestamp - right.timestamp) * direction)
  }, [activeKind, assets, sortOrder])
  const groups = useMemo(() => {
    const map = new Map<string, HistoryAsset[]>()
    for (const asset of filteredAssets) {
      const key = formatHistoryDate(asset.timestamp)
      const list = map.get(key)
      if (list) list.push(asset)
      else map.set(key, [asset])
    }
    return Array.from(map.entries()).map(([date, items]) => ({ date, items }))
  }, [filteredAssets])

  const zoomPercent = Math.round(zoom * 100)
  const thumbSize = Math.round(144 * zoom)

  return (
    <div
      className="canvas-history-panel"
      role="dialog"
      aria-label="历史资产"
      style={{ '--history-thumb-size': `${thumbSize}px` } as CSSProperties}
    >
      <header className="canvas-history-header">
        <h2>历史资产</h2>
        <div className="canvas-history-actions">
          <div className="canvas-history-zoom">
            <button type="button" onClick={() => setZoom(value => Math.max(0.7, Number((value - 0.1).toFixed(1))))}>−</button>
            <span>{zoomPercent}%</span>
            <button type="button" onClick={() => setZoom(value => Math.min(1.5, Number((value + 0.1).toFixed(1))))}>＋</button>
          </div>
          <button type="button" className="canvas-history-close" title="关闭" aria-label="关闭" onClick={onClose}>×</button>
        </div>
      </header>
      <div className="canvas-history-toolbar">
        <div className="canvas-history-tabs">
          <button type="button" className={activeKind === 'all' ? 'is-active' : ''} onClick={() => setActiveKind('all')}>
            全部({assets.length})
          </button>
          <button type="button" className={activeKind === 'image' ? 'is-active' : ''} onClick={() => setActiveKind('image')}>
            图片历史({imageCount})
          </button>
          <button type="button" className={activeKind === 'video' ? 'is-active' : ''} onClick={() => setActiveKind('video')}>
            视频历史({videoCount})
          </button>
        </div>
        <div className="canvas-history-sort">
          <button
            type="button"
            className="canvas-history-sort-button"
            title={sortOrder === 'desc' ? '时间降序，点击切换为升序' : '时间升序，点击切换为降序'}
            aria-label={sortOrder === 'desc' ? '时间降序' : '时间升序'}
            onClick={() => setSortOrder(current => current === 'desc' ? 'asc' : 'desc')}
          >
            {sortOrder === 'desc' ? <ArrowDown size={16} /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      <div className="canvas-history-content">
        {groups.length ? groups.map(group => (
          <section key={group.date} className="canvas-history-day">
            <h3>{group.date}</h3>
            <div className="canvas-history-grid">
              {group.items.map(asset => (
                <div
                  key={asset.id}
                  className="canvas-history-card"
                  title={asset.name}
                  draggable
                  onDragStart={(event) => onDragStart?.(asset, event)}
                >
                  <button
                    type="button"
                    className="canvas-history-preview"
                    aria-label="查看"
                    onClick={() => previewHistoryAsset(asset)}
                  >
                    {asset.kind === 'video' ? (
                      <>
                        <HistoryVideoThumbnail asset={asset} />
                        <span className="canvas-history-play">▶</span>
                      </>
                    ) : (
                      <img src={asset.displayUrl || asset.url} alt={asset.name} loading="lazy" draggable={false} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="canvas-history-delete"
                    title="删除历史"
                    aria-label="删除历史"
                    onClick={() => onDelete(asset)}
                  >
                    <Trash2 size={14} strokeWidth={2.2} />
                  </button>
                  <div className="canvas-history-card-actions">
                    <button type="button" onClick={() => previewHistoryAsset(asset)}>查看</button>
                    <button type="button" onClick={() => onInsert(asset)}>使用</button>
                    <button type="button" onClick={() => downloadHistoryAsset(asset)}>下载</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )) : (
          <div className="canvas-history-empty">
            {activeKind === 'all' ? '暂无历史资产' : `暂无${activeKind === 'image' ? '图片' : '视频'}历史`}
          </div>
        )}
      </div>
    </div>
  )
}
