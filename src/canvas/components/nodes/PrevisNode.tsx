import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { assetsApi, previsApi, type PrevisDocument } from '@/lib/api'
import { errorToText } from '@/lib/display'
import { defaultImageParams, defaultVideoParams } from '@/lib/nodeData'
import { resourceMetaFromUploadPayload } from '@/lib/whiteboard'
import { stageRenderNodePosition, stageRenderSourceWidth } from '@/features/director-stage/renderMerge'
import { PREVIS_EXPORT_GENERATOR, appendPrevisStill, previsImageNodeData, previsVideoNodeData } from '@/features/previs/previsExport'
import { resolvePrevisReference } from '@/features/previs/previsReference'
import type { CanvasNodeData } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

type PrevisParams = {
  documentId: string
  revision: number
  activeShotId: string
  thumbUrl: string
}

type ExportMessage = {
  type?: string
  kind?: string
  blob?: Blob
  width?: number
  height?: number
  durationSec?: number
  fps?: number
  project?: unknown
}

function readPrevisParams(params: unknown): PrevisParams {
  const source = params && typeof params === 'object' ? (params as { previs?: Partial<PrevisParams> }).previs : undefined
  return {
    documentId: typeof source?.documentId === 'string' ? source.documentId : '',
    revision: Number(source?.revision) || 0,
    activeShotId: typeof source?.activeShotId === 'string' ? source.activeShotId : '',
    thumbUrl: typeof source?.thumbUrl === 'string' ? source.thumbUrl : '',
  }
}

function loadPayload(project: unknown, reference: { url: string; name: string }) {
  return {
    type: 'shotflow-previs:load',
    project,
    reference: reference.url ? { url: reference.url, name: reference.name } : null,
  }
}

export function PrevisNode({ id, data }: Props) {
  const nodes = useCanvasStore((state) => state.nodes)
  const edges = useCanvasStore((state) => state.edges)
  const updateNodeData = useCanvasStore((state) => state.updateNodeData)
  const addNodeAt = useCanvasStore((state) => state.addNodeAt)
  const pushHistory = useCanvasStore((state) => state.pushHistory)
  const previs = readPrevisParams(data.params)
  const reference = useMemo(() => resolvePrevisReference(data.params, nodes), [data.params, nodes])
  const stillUrl = useMemo(() => {
    const urls = (data.url ?? []).filter((url): url is string => typeof url === 'string' && /\.(png|jpe?g|webp)(?:$|[?#])/i.test(url))
    return urls.at(-1) || ''
  }, [data.url])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const documentRef = useRef<PrevisDocument | null>(null)
  const loadedRef = useRef(false)
  const savingRef = useRef(false)
  const referenceRef = useRef(reference)
  referenceRef.current = reference

  const postToFrame = useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, window.location.origin)
  }, [])

  const rememberDocument = useCallback((document: PrevisDocument) => {
    documentRef.current = document
    const current = readPrevisParams(data.params)
    if (current.documentId === document.documentId) return
    updateNodeData(id, {
      params: {
        ...(data.params || {}),
        previs: {
          documentId: document.documentId,
          revision: document.revision,
          activeShotId: document.activeShotId || '',
          thumbUrl: current.thumbUrl,
        },
      },
    })
  }, [data.params, id, updateNodeData])

  const openEditor = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const document = await previsApi.ensure(data.projectUuid, data.nodeKey || id)
      rememberDocument(document)
      loadedRef.current = false
      setOpen(true)
    } catch (cause) {
      setError(errorToText(cause) || '打不开预演工程')
    } finally {
      setBusy(false)
    }
  }, [data.nodeKey, data.projectUuid, id, rememberDocument])

  const saveProject = useCallback(async (project: unknown) => {
    const current = documentRef.current
    if (!current || savingRef.current || !loadedRef.current) return
    savingRef.current = true
    setStatus('保存中')
    try {
      const saved = await previsApi.save(data.projectUuid, current.documentId, {
        project,
        baseRevision: current.revision,
        activeShotId: project && typeof project === 'object' && 'activeShotId' in project ? String((project as { activeShotId?: string }).activeShotId || '') : current.activeShotId,
      })
      documentRef.current = saved
      setStatus('已保存')
      setError('')
    } catch (cause) {
      const statusCode = Number((cause as { response?: { status?: number } })?.response?.status)
      if (statusCode === 409) {
        const latest = await previsApi.read(data.projectUuid, current.documentId).catch(() => null)
        if (latest) {
          documentRef.current = latest
          loadedRef.current = false
          postToFrame(loadPayload(latest.project, referenceRef.current))
        }
      }
      setStatus('')
      setError(errorToText(cause) || '保存预演工程失败')
    } finally {
      savingRef.current = false
    }
  }, [data.projectUuid, postToFrame])

  const placeExport = useCallback(async (message: ExportMessage) => {
    if (!(message.blob instanceof Blob)) return
    const kind = message.kind === 'mp4' ? 'mp4' : 'png'
    setBusy(true)
    setError('')
    setStatus(kind === 'mp4' ? '正在接收视频' : '正在接收截图')
    try {
      const createdAtMs = Date.now()
      const width = Math.max(1, Math.round(Number(message.width) || 1280))
      const height = Math.max(1, Math.round(Number(message.height) || 720))
      const file = new File(
        [message.blob],
        `${data.name || 'previs'}-${createdAtMs}.${kind === 'mp4' ? 'mp4' : 'png'}`,
        { type: kind === 'mp4' ? 'video/mp4' : 'image/png' },
      )
      const uploaded = await assetsApi.upload(
        data.projectUuid,
        file,
        undefined,
        kind === 'mp4' ? { sourceType: 'previs-export', normalizeVideoToMp4: true } : { sourceType: 'previs-export' },
      )
      const resourceMeta = resourceMetaFromUploadPayload(
        uploaded.meta as Record<string, unknown> | undefined,
        kind === 'mp4' ? 'video' : 'image',
      )
      const sourceNode = nodes.find((node) => node.id === id || node.data.nodeKey === id)
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const position = stageRenderNodePosition({
        stageX: sourceNode?.position.x ?? 0,
        stageY: sourceNode?.position.y ?? 0,
        stageWidth: stageRenderSourceWidth(sourceNode),
        outgoingCount,
      })
      pushHistory()
      if (kind === 'png') {
        addNodeAt('image', position.x, position.y, previsImageNodeData({
          sourceNodeId: id,
          sourceName: data.name,
          url: uploaded.url,
          width,
          height,
          createdAtMs,
          resourceMeta,
          baseImageParams: defaultImageParams() as unknown as Record<string, unknown>,
        }) as never)
        updateNodeData(id, appendPrevisStill(data, { url: uploaded.url, width, height, createdAtMs, resourceMeta }))
      } else {
        addNodeAt('video', position.x, position.y, previsVideoNodeData({
          sourceNodeId: id,
          sourceName: data.name,
          url: uploaded.url,
          width: resourceMeta?.width || width,
          height: resourceMeta?.height || height,
          durationSec: resourceMeta?.durationSec || Number(message.durationSec) || 1,
          fps: Number(message.fps) || 24,
          createdAtMs,
          resourceMeta,
          baseVideoParams: defaultVideoParams() as unknown as Record<string, unknown>,
        }) as never)
      }
      setStatus(kind === 'mp4' ? '视频已放入画布' : '截图已放入画布')
    } catch (cause) {
      setStatus('')
      setError(errorToText(cause) || '导出到画布失败')
    } finally {
      setBusy(false)
    }
  }, [addNodeAt, data, edges, id, nodes, pushHistory, updateNodeData])

  /** 预演台里点「出参考视频」后，在右侧建一个视频节点，把最新截图接成它的参考图。 */
  const createLinkedVideo = useCallback(() => {
    pushHistory()
    const sourceNode = nodes.find((node) => node.id === id || node.data.nodeKey === id)
    const outgoingCount = edges.filter((edge) => edge.source === id).length
    const position = stageRenderNodePosition({
      stageX: sourceNode?.position.x ?? 0,
      stageY: sourceNode?.position.y ?? 0,
      stageWidth: stageRenderSourceWidth(sourceNode),
      outgoingCount,
    })
    const latestStill = (data.url ?? []).filter((url) => typeof url === 'string' && /\.(png|jpe?g|webp)(?:$|[?#])/i.test(url)).at(-1) || ''
    const ref = { nodeId: id, url: latestStill, mediaType: 'image' as const }
    addNodeAt('video', position.x, position.y, {
      name: `${data.name || '白模预演'} 视频`,
      url: [],
      action: 'video_generate',
      sourceKind: 'derived',
      generatorType: PREVIS_EXPORT_GENERATOR,
      params: {
        ...defaultVideoParams(),
        prompt: '',
        imageList: [ref],
        imageListOrder: [id],
        mixedList: [ref],
        mixedListOrder: [id],
      } as unknown as Record<string, unknown>,
    })
    setStatus('已生成链接的视频节点')
  }, [addNodeAt, data, edges, id, nodes, pushHistory])

  useEffect(() => {
    if (!open || !loadedRef.current) return
    postToFrame({
      type: 'shotflow-previs:reference',
      reference: reference.url ? { url: reference.url, name: reference.name } : null,
    })
  }, [open, postToFrame, reference.name, reference.url])

  useEffect(() => {
    if (!open) return undefined
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.source !== frameRef.current?.contentWindow) return
      const message = event.data as ExportMessage
      if (message?.type === 'shotflow-previs:ready' && !loadedRef.current) {
        postToFrame(loadPayload(documentRef.current?.project ?? null, referenceRef.current))
      }
      if (message?.type === 'shotflow-previs:loaded') loadedRef.current = true
      if (message?.type === 'shotflow-previs:save') void saveProject(message.project)
      if (message?.type === 'shotflow-previs:create-video') createLinkedVideo()
      if (message?.type === 'shotflow-previs:export') void placeExport(message)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [createLinkedVideo, open, placeExport, postToFrame, saveProject])

  // 同一个节点组件服务两种入口：M-STUDIO 预演（monoform）和 M-studio 工作台（mstudio）。
  const isWorkbench = (data.params as { workbench?: string } | undefined)?.workbench === 'mstudio'

  return (
    <>
      <NodeShell nodeKey={id} data={data} minWidth={280}>
        <div className="nopan flex h-full flex-col justify-between gap-3 p-3 text-xs shotflow-previs-body">
          <div>
            <div className="text-sm shotflow-previs-title">{isWorkbench ? 'M-studio工作台' : 'M-STUDIO'}</div>
            <p className="mt-1 leading-5">{reference.missing ? '上游参考图已经不在画布上。' : reference.url ? `参考图：${reference.name}` : previs.documentId ? '可以把图片节点连到这里，当作当前镜头的参考图。' : '打开后建立一份独立工程，不写入画布 JSON。'}</p>
            {stillUrl && <img src={stillUrl} alt="" className="mt-2 max-h-24 w-full rounded object-contain" />}
            {error && <p className="mt-2 text-red-300">{error}</p>}
          </div>
          <button type="button" className="nodrag nopan shotflow-previs-open rounded-md px-3 py-2 disabled:opacity-50" onClick={() => void openEditor()} disabled={busy}>
            {busy ? '正在处理' : isWorkbench ? '打开工作台' : '打开预演'}
          </button>
        </div>
      </NodeShell>
      {open && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 2600, display: 'flex', flexDirection: 'column', background: '#141414' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 44, padding: '0 12px', color: '#f3f0e8', background: '#1c1c1c', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <strong style={{ fontSize: 13 }}>{data.name || 'M-STUDIO'}</strong>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{status}</span>
            <button type="button" style={{ marginLeft: 'auto', color: '#f3f0e8', background: 'transparent', border: 0, cursor: 'pointer' }} onClick={() => setOpen(false)}>关闭</button>
          </div>
          {error && <div style={{ padding: '6px 12px', color: '#ffb4b4', fontSize: 12 }}>{error}</div>}
          <iframe
            ref={frameRef}
            title="M-STUDIO"
            src={isWorkbench ? '/mstudio/index.html?embed=1&v=20261018-core' : '/Shotflow/monoform/?embed=1&v=20261017-title'}
            style={{ flex: 1, width: '100%', border: 0, background: '#111' }}
          />
        </div>,
        document.body,
      )}
    </>
  )
}
