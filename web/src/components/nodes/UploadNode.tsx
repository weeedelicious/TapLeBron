import { useCallback, useRef } from 'react'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { assetsApi } from '@/lib/api'
import type { CanvasNodeData } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

export function UploadNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const urls = data.url ?? []

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    const uploaded: string[] = []
    for (const file of Array.from(files)) {
      try {
        const res = await assetsApi.upload(data.projectUuid, file)
        uploaded.push(res.url)
      } catch (e) { console.error(e) }
    }
    updateNodeData(id, { url: [...urls, ...uploaded] })
  }, [id, data.projectUuid, urls, updateNodeData])

  const isImage = (url: string) => /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(url)
  const isVideo = (url: string) => /\.(mp4|webm|mov)$/i.test(url)

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={280} minHeight={200}>
      <div className="p-3 flex flex-col gap-2">
        <input ref={inputRef} type="file" multiple accept="image/*,video/*,audio/*" className="hidden" onChange={e => handleFiles(e.target.files)} />

        {urls.length > 0 ? (
          <div className="flex flex-col gap-1">
            {urls.map((url, i) => (
              <div key={i}>
                {isImage(url) && <img src={url} alt="" className="w-full rounded" style={{ maxHeight: 200, objectFit: 'contain' }} />}
                {isVideo(url) && <video src={url} controls className="w-full rounded" style={{ maxHeight: 200 }} />}
                {!isImage(url) && !isVideo(url) && <div className="text-xs text-muted truncate">{url.split('/').pop()}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center rounded cursor-pointer gap-2"
            style={{ border: '2px dashed #2a2a2a', height: 120, color: '#8a8a8a' }}
            onClick={() => inputRef.current?.click()}
          >
            <span style={{ fontSize: 24 }}>⬆</span>
            <span className="text-xs">点击上传图片/视频/音频</span>
          </div>
        )}

        <button
          className="text-xs py-1 rounded nodrag"
          style={{ border: '1px solid #2a2a2a', color: '#8a8a8a' }}
          onClick={() => inputRef.current?.click()}
        >添加文件</button>
      </div>
    </NodeShell>
  )
}
