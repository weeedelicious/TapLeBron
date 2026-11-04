import { useEffect } from 'react'
import { assetsApi } from '@/lib/api'
import { parseLocalAssetUrl } from '@/lib/localAssetUrls'
import { useCanvasStore } from '@/store/canvasStore'
import type { CanvasNodeData, VideoVariants } from '@/lib/types'

/**
 * 视频节点里的视频还没有 360P 预览版记录时，向服务端要（services/VideoVariantService.js）。
 * 服务端做好了就写进节点的 `_assetVideoVariants`，节点和展开播放自动换成小版本；
 * 还在转码就过一会儿再问；旧视频（上线前的）服务端返回 skipped，这一页不再问。
 */
const settled = new Set<string>()
const inFlight = new Set<string>()
const RETRY_MS = 15_000
const MAX_TRIES = 12

function localVideoUrl(projectUuid: string, url: string) {
  const parsed = parseLocalAssetUrl(url)
  if (!parsed || parsed.projectUuid !== projectUuid) return false
  return /\.(mp4|mov|m4v|webm)$/i.test(parsed.storedName) && !/_(?:360|1080|display)\.mp4$/i.test(parsed.storedName)
}

function applyVariants(nodeId: string, url: string, variants: VideoVariants) {
  const state = useCanvasStore.getState()
  const node = state.nodes.find((item) => item.id === nodeId)
  if (!node || !(node.data.url ?? []).includes(url)) return
  if (node.data._assetVideoVariants?.[url]?.previewUrl === variants.previewUrl) return
  state.updateNodeData(nodeId, {
    _assetVideoVariants: { ...(node.data._assetVideoVariants ?? {}), [url]: variants },
  } as Partial<CanvasNodeData>)
}

async function request(nodeId: string, projectUuid: string, url: string, attempt: number) {
  const key = `${projectUuid}|${url}`
  if (settled.has(key) || inFlight.has(key)) return
  inFlight.add(key)
  try {
    const result = await assetsApi.videoVariants(projectUuid, url)
    if (result?.previewUrl) {
      settled.add(key)
      const { url: _url, pending: _pending, skipped: _skipped, ...variants } = result
      applyVariants(nodeId, url, variants as VideoVariants)
      return
    }
    if (result?.skipped) {
      settled.add(key)
      return
    }
  } catch {
    // 网络抖动 / 服务重启：按下面的节奏重试
  } finally {
    inFlight.delete(key)
  }
  if (attempt + 1 < MAX_TRIES) {
    window.setTimeout(() => void request(nodeId, projectUuid, url, attempt + 1), RETRY_MS)
  } else {
    settled.add(key)
  }
}

export function useVideoVariants(nodeId: string, data: CanvasNodeData) {
  const projectUuid = String(data.projectUuid || '')
  const urls = (data.url ?? []).filter((url): url is string => typeof url === 'string' && Boolean(url))
  const missing = urls.filter((url) => localVideoUrl(projectUuid, url) && !data._assetVideoVariants?.[url]?.previewUrl)
  const missingKey = missing.join('|')
  useEffect(() => {
    if (!projectUuid || !missingKey) return
    for (const url of missingKey.split('|')) void request(nodeId, projectUuid, url, 0)
  }, [nodeId, projectUuid, missingKey])
}
