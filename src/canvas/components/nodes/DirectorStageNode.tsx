/**
 * 三维空间节点（类型 id 仍是 `director_stage`，2026-08-26 前是个占位版：
 * 一块黑 canvas + 截图按钮，注释里写着「完整 3D 交互需要 three-fiber」）。
 *
 * 现在它是真的了：点开是一个能自由转视角、能调焦距的三维空间，里面站一个可摆姿势的白模，
 * 摆好之后出图。3D 那一摊全在 `features/director-stage/` 里，这个文件只干三件事 ——
 * 显示已出的图、开编辑器、把出图结果安全地写回节点。
 *
 * 「安全」是重点：写回走 `appendStageRender`，**只追加不整体替换**
 * （8-25 补收路由那句 `nodeData.url = urls` 冲掉过 44 条视频）。
 */
import { useCallback, useMemo, useState } from 'react'
import { Download, Image as ImageIcon, Loader2, Maximize2, PersonStanding } from 'lucide-react'
import { NodeShell } from './NodeShell'
import { MediaNodeToolbar, type MediaNodeToolbarAction } from '@/components/MediaNodeToolbar'
import { ImagePreview } from '@/components/ImagePreview'
import { useCanvasStore } from '@/store/canvasStore'
import { assetsApi } from '@/lib/api'
import { errorToText } from '@/lib/display'
import { primaryOutputUrl } from '@/lib/primaryOutput'
import { mediaPreviewUrl } from '@/lib/mediaPreview'
import { defaultImageParams } from '@/lib/nodeData'
import { resourceMetaFromUploadPayload } from '@/lib/whiteboard'
import type { CanvasNodeData } from '@/lib/types'
import {
  DirectorStageModal,
  type DirectorStageRenderPayload,
} from '@/features/director-stage/DirectorStageModal'
import {
  appendStageRender,
  stageRenderNodeData,
  stageRenderNodePosition,
  stageRenderSourceWidth,
} from '@/features/director-stage/renderMerge'
import { readDirectorStageState, writeDirectorStageState } from '@/features/director-stage/types'
import { resolveStageReference } from '@/features/director-stage/stageReference'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

export function DirectorStageNode({ id, data, selected }: Props) {
  const nodes = useCanvasStore((state) => state.nodes)
  const edges = useCanvasStore((state) => state.edges)
  const updateNodeData = useCanvasStore((state) => state.updateNodeData)
  const addNodeAt = useCanvasStore((state) => state.addNodeAt)
  const pushHistory = useCanvasStore((state) => state.pushHistory)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)

  const stageState = useMemo(() => readDirectorStageState(data.params), [data.params])
  const reference = useMemo(() => resolveStageReference(data.params, nodes), [data.params, nodes])
  const urls = useMemo(
    () => (data.url ?? []).filter((url): url is string => typeof url === 'string' && url.trim().length > 0),
    [data.url],
  )
  const mainUrl = primaryOutputUrl(data)

  /**
   * 出图。
   *
   * 上传一次，然后三件事：
   *   ① **新建一个图片节点**装这张图，并从本节点的输出口连过去（2026-08-26 你要的）。
   *      每次出图都新建一个，位置按已有出边数往下错开 —— 不错开的话出到第三张时
   *      全叠在同一个坐标上，看起来像只出了一张。
   *   ② 同时**追加**进本节点自己的 `url[]`（`appendStageRender`，只追加不替换）。
   *      资产只上传一次、两边引用同一个地址；留着是因为节点上的缩略图 /
   *      查看大图 / 下载都依赖它，不留的话出完图三维空间节点自己是空的。
   *      这也和全景查看器截图的行为一致。
   *   ③ 把这次的机位和姿势写回 `params.stage`，下次打开接着调
   *      （不写回的话每次打开都回到默认机位，等于白摆）。
   */
  const handleRender = useCallback(async ({ blob, width, height, state }: DirectorStageRenderPayload) => {
    setBusy(true)
    setError('')
    try {
      const createdAtMs = Date.now()
      const file = new File([blob], `${data.name || 'stage'}-${createdAtMs}.png`, { type: 'image/png' })
      const uploaded = await assetsApi.upload(data.projectUuid, file)
      const resourceMeta = resourceMetaFromUploadPayload(
        uploaded.meta as Record<string, unknown> | undefined,
        'image',
      )

      const stageNode = nodes.find((node) => node.id === id || node.data.nodeKey === id)
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const position = stageRenderNodePosition({
        stageX: stageNode?.position.x ?? 0,
        stageY: stageNode?.position.y ?? 0,
        stageWidth: stageRenderSourceWidth(stageNode),
        outgoingCount,
      })

      pushHistory()
      addNodeAt(
        'image',
        position.x,
        position.y,
        stageRenderNodeData({
          stageNodeId: id,
          stageName: data.name,
          url: uploaded.url,
          width,
          height,
          createdAtMs,
          resourceMeta,
          state,
          baseImageParams: defaultImageParams() as unknown as Record<string, unknown>,
        }) as never,
      )

      updateNodeData(id, {
        ...appendStageRender(data, { url: uploaded.url, width, height, createdAtMs, resourceMeta }),
        params: writeDirectorStageState(data.params, state) as unknown as Record<string, unknown>,
      })

      // 连线不要再手写 setEdges：addNodeAt 已经按新节点 params.imageList 调过
      // edgesFromNodeReferences，当场就能画出「三维空间 → 出图节点」。
      // 以前这里拿闭包里的旧 edges 再 setEdges 一次，会把刚推好的那条边盖掉，
      // 新节点看起来像还没出图 / 显示成上游参考图，刷新才对（用户 2026-08-27）。
      setOpen(false)
    } catch (err) {
      setError(errorToText((err as { response?: { data?: { error?: unknown } } })?.response?.data?.error ?? err, '出图失败'))
    } finally {
      setBusy(false)
    }
  }, [addNodeAt, data, edges, id, nodes, pushHistory, updateNodeData])

  const download = useCallback(() => {
    if (!mainUrl) return
    const link = document.createElement('a')
    link.href = mainUrl
    link.download = `${data.name || 'stage'}.png`
    link.click()
  }, [data.name, mainUrl])

  const actions = useMemo<MediaNodeToolbarAction[]>(() => [
    { key: 'open', label: '打开三维空间', icon: <PersonStanding size={13} />, onClick: () => setOpen(true) },
    { key: 'full', label: '查看大图', icon: <Maximize2 size={13} />, onClick: () => setPreviewOpen(true), disabled: !mainUrl },
    { key: 'download', label: '下载', icon: <Download size={13} />, onClick: download, disabled: !mainUrl },
  ], [download, mainUrl])

  const posedJoints = Object.keys(stageState.pose).length

  return (
    <NodeShell
      nodeKey={id}
      data={data}
      selected={selected}
      minWidth={360}
      minHeight={280}
      toolbar={<MediaNodeToolbar actions={actions} />}
      selectedMeta={<span>{stageState.camera.focalMm.toFixed(0)}mm · {stageState.ratio}</span>}
    >
      <div className="flex flex-col gap-2 p-2" style={{ height: '100%', minHeight: 0 }}>
        {/*
          这块占了节点的大半面积，所以**不能**加 nodrag：加了就只剩下面那条细窄的信息行
          能拖，节点几乎挪不动（2026-08-26 用户反馈「拖动区域太小」）。
          所以照 ImageNode 主图区的既有惯例：单击留给选中 / 拖动，**双击**才打开。
          双击一律 stopPropagation —— 画布的 zoomOnDoubleClick 是默认开的，不拦会顺手缩放。
        */}
        {mainUrl ? (
          <div
            title="双击看大图"
            onDoubleClick={(event) => { event.stopPropagation(); setPreviewOpen(true) }}
            style={{
              flex: 1, minHeight: 0,
              cursor: 'zoom-in', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <img
              src={mediaPreviewUrl(data, mainUrl)}
              alt={data.name}
              draggable={false}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8, display: 'block' }}
            />
          </div>
        ) : (
          <div
            title="双击打开三维空间"
            onDoubleClick={(event) => { event.stopPropagation(); setOpen(true) }}
            style={{
              flex: 1, minHeight: 120, borderRadius: 10,
              border: '1px dashed rgba(124,92,252,0.32)',
              background: 'linear-gradient(180deg, rgba(124,92,252,0.08), rgba(124,92,252,0.02))',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
              color: '#9c92bb', fontSize: 12, textAlign: 'center', padding: 12,
            }}
          >
            <PersonStanding size={22} />
            <div>还没出图</div>
            <div style={{ fontSize: 11, color: '#7d7397', lineHeight: 1.5 }}>
              双击这里打开三维空间，摆好机位和白模姿势再出图
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8d83ab', flexWrap: 'wrap' }}>
          <span>{stageState.camera.focalMm.toFixed(0)}mm</span>
          <span>·</span>
          <span>{stageState.ratio}</span>
          {posedJoints > 0 && <><span>·</span><span>姿势 {posedJoints} 处</span></>}
          {urls.length > 1 && <><span>·</span><span>{urls.length} 张</span></>}
          {reference.url && !reference.missing && (
            <><span>·</span><span style={{ color: '#8fd4b4' }}>参考图已连</span></>
          )}
          {reference.missing && (
            <><span>·</span><span style={{ color: '#e0a37a' }}>参考图上游已删除</span></>
          )}
        </div>

        {error && (
          <div style={{
            padding: '5px 8px', borderRadius: 7, fontSize: 11, lineHeight: 1.45,
            border: '1px solid rgba(255,120,120,0.28)', background: 'rgba(255,90,90,0.1)', color: '#f0b4b4',
          }}>
            {error}
          </div>
        )}

        <button
          type="button"
          className="nodrag"
          onClick={() => setOpen(true)}
          disabled={busy}
          style={{
            minHeight: 30, borderRadius: 8, border: 'none', cursor: busy ? 'default' : 'pointer',
            background: busy ? '#3a3157' : '#7c5cfc', color: '#fff', fontSize: 12, fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <ImageIcon size={13} />}
          {mainUrl ? '继续调整并出图' : '打开三维空间'}
        </button>
      </div>

      {open && (
        <DirectorStageModal
          initialState={stageState}
          nodeName={data.name}
          reference={reference}
          busy={busy}
          onCancel={() => setOpen(false)}
          onRender={handleRender}
        />
      )}

      {previewOpen && mainUrl && (
        <ImagePreview
          url={mainUrl}
          items={urls.map((url) => ({
            url,
            resourceMeta: data._resourceMeta?.items?.find(
              (item) => item?.originalUrl === url || item?.displayUrl === url,
            ),
            generationMeta: data._assetGenerationMeta?.[url],
            createdAtMs: data._assetCreatedAtMs?.[url],
          }))}
          primaryUrl={mainUrl}
          name={data.name}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </NodeShell>
  )
}
