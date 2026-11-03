import { useEffect } from 'react'
import { NodeShell } from '@/components/nodes/NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { defaultTextParams } from '@/lib/nodeData'
import type { CanvasNodeData } from '@/lib/types'
import { extractWordText, loadWordHandle, wordNodeHandles, wordNodeStamps } from './wordDocument'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
}

function fileBaseName(name: string) {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

type WordParams = {
  content?: string
  fileName?: string
  sourceModifiedMs?: number
  sourceSize?: number
  linked?: boolean
  wordSyncError?: string
}

/**
 * Word 节点：显示 .docx / .doc 的正文。拖入时拿到了原文件句柄（Chrome / Edge）就「跟随原文件」，
 * 每 2 秒看一次原文件有没有改，改了就重新读正文；拿不到句柄就只是导入那一刻的副本。
 */
export function WordNode({ id, data }: Props) {
  useEffect(() => {
    let cancelled = false
    let timer = 0
    const start = async () => {
      let handle = wordNodeHandles.get(id)
      if (!handle) {
        handle = (await loadWordHandle(id)) ?? undefined
        if (handle) wordNodeHandles.set(id, handle)
      }
      if (!handle || cancelled) return
      const sync = async () => {
        if (cancelled) return
        try {
          const file = await handle!.getFile()
          const stamp = file.lastModified + ':' + file.size
          if (wordNodeStamps.get(id) === stamp) return
          const content = await extractWordText(await file.arrayBuffer())
          const store = useCanvasStore.getState()
          const node = store.nodes.find((item) => item.id === id)
          const params = ((node?.data?.params ?? {}) as WordParams)
          if (params.content === content && params.sourceModifiedMs === file.lastModified) {
            wordNodeStamps.set(id, stamp)
            return
          }
          wordNodeStamps.set(id, stamp)
          store.updateNodeData(id, {
            name: fileBaseName(file.name) || node?.data?.name,
            params: {
              ...params,
              content,
              fileName: file.name,
              sourceModifiedMs: file.lastModified,
              sourceSize: file.size,
              linked: true,
              wordSyncError: '',
            } as unknown as Record<string, unknown>,
            _updatedAtMs: Date.now(),
          })
        } catch (error) {
          const store = useCanvasStore.getState()
          const node = store.nodes.find((item) => item.id === id)
          const params = ((node?.data?.params ?? {}) as WordParams)
          const message = error && (error as { name?: string }).name === 'NotAllowedError'
            ? '点击节点后继续跟随原文件'
            : '原文件读取失败'
          if (params.wordSyncError !== message) {
            store.updateNodeData(id, { params: { ...params, wordSyncError: message } as unknown as Record<string, unknown> })
          }
        }
      }
      timer = window.setInterval(sync, 2000)
      void sync()
    }
    void start()
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [id])

  const convertToText = () => {
    const store = useCanvasStore.getState()
    const node = store.nodes.find((item) => item.id === id)
    const content = String((node?.data?.params as WordParams | undefined)?.content || '')
    store.addNodeAt('text', (node?.position.x ?? 0) + 460, node?.position.y ?? 0, {
      name: (node?.data?.name || 'Word') + ' 文本',
      action: 'text_node',
      params: { ...defaultTextParams(), content, manualMode: true, hasGenerated: false } as unknown as Record<string, unknown>,
      contentWidth: 512,
      contentHeight: 256,
      _updatedAtMs: Date.now(),
    })
  }

  /** 浏览器重启后句柄还在，但读权限要用户点一下才能恢复。 */
  const resumeFollow = async () => {
    const handle = wordNodeHandles.get(id) || await loadWordHandle(id)
    if (handle?.requestPermission && await handle.requestPermission({ mode: 'read' }) === 'granted') {
      wordNodeHandles.set(id, handle)
      const store = useCanvasStore.getState()
      const node = store.nodes.find((item) => item.id === id)
      store.updateNodeData(id, {
        params: { ...((node?.data?.params ?? {}) as Record<string, unknown>), linked: true, wordSyncError: '' },
      })
    }
  }

  const params = (data?.params ?? {}) as WordParams
  const content = String(params.content || '')
  const linked = Boolean(params.linked)
  const syncError = String(params.wordSyncError || '')

  return (
    <NodeShell nodeKey={id} data={data} minWidth={360}>
      <div className="nodrag nopan" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 180 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--sf-text-muted)' }}>
          <span>{linked ? '跟随原文件' : '仅当前副本'}</span>
          <span>{params.fileName || ''}</span>
        </div>
        {syncError ? (
          <button type="button" onClick={() => { void resumeFollow() }} style={{ textAlign: 'left', border: 0, background: 'transparent', color: '#b7384c', fontSize: 12, cursor: 'pointer', padding: 0 }}>
            {syncError}
          </button>
        ) : null}
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, color: 'var(--sf-text-body)', maxHeight: 220, overflow: 'auto' }}>
          {content || '文档没有文字'}
        </div>
        <button
          type="button"
          onClick={convertToText}
          style={{ height: 32, borderRadius: 8, border: '1px solid var(--sf-border-strong)', background: 'var(--sf-panel-soft)', color: 'var(--sf-text-title)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
        >
          转为文本节点
        </button>
      </div>
    </NodeShell>
  )
}
