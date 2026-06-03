import { useCallback, useRef, useState, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useUpdateNodeInternals, useViewport, useStore } from '@xyflow/react'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { TEXT_MODELS, defaultTextParams } from '@/lib/nodeData'
import type { CanvasNodeData, TextParams, NodeRef } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

function getParams(data: CanvasNodeData): TextParams {
  if (data.params) return data.params as unknown as TextParams
  return defaultTextParams()
}

export function TextNode({ id, data, selected }: Props) {
  const { updateNodeData, nodes } = useCanvasStore()
  const [collapsed, setCollapsed] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const nodeContainerRef = useRef<HTMLDivElement>(null)
  const controlsPortalRef = useRef<HTMLDivElement>(null)
  const dividerRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const updateNodeInternals = useUpdateNodeInternals()

  const { zoom, x: vpX, y: vpY } = useViewport()
  const nodeAbsPos = useStore(s => (s.nodeLookup as Map<string, { internals?: { positionAbsolute?: { x: number; y: number } } }>)?.get(id)?.internals?.positionAbsolute)
  const [portalRect, setPortalRect] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    if (collapsed) { setPortalRect(null); return }
    setPortalRect(dividerRef.current?.getBoundingClientRect() ?? null)
  }, [collapsed, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y])

  useEffect(() => { updateNodeInternals(id) }, [collapsed, id, updateNodeInternals])

  // Outside-click collapse
  useEffect(() => {
    if (collapsed) return
    const handler = (e: MouseEvent) => {
      if (
        !nodeContainerRef.current?.contains(e.target as Node) &&
        !controlsPortalRef.current?.contains(e.target as Node)
      ) {
        setCollapsed(true)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [collapsed])

  const params = getParams(data)

  // setParam reads fresh state to avoid stale closure overwrites
  const setParam = useCallback(<K extends keyof TextParams>(key: K, val: TextParams[K]) => {
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const current = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    updateNodeData(id, { params: { ...current, [key]: val } as unknown as Record<string, unknown> })
  }, [id, updateNodeData]) // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve live URLs for connected nodes
  const connectedImages: { nodeId: string; url: string; name: string }[] = (
    (params.imageList as NodeRef[] | undefined) ?? []
  ).map(ref => {
    const srcNode = nodes.find(n => n.id === ref.nodeId)
    const liveUrl = (srcNode?.data as CanvasNodeData)?.url?.[0] ?? ref.url
    return { nodeId: ref.nodeId, url: liveUrl, name: srcNode?.data?.name as string ?? '' }
  }).filter(r => r.url)

  const connectedTexts: { nodeId: string; content: string; name: string }[] = (
    (params.textList as NodeRef[] | undefined) ?? []
  ).map(ref => {
    const srcNode = nodes.find(n => n.id === ref.nodeId)
    const content = (srcNode?.data?.params as { content?: string })?.content ?? ''
    return { nodeId: ref.nodeId, content, name: srcNode?.data?.name as string ?? '' }
  }).filter(r => r.content)

  const connectedVideos: { nodeId: string; url: string; name: string }[] = (
    (params.videoList as NodeRef[] | undefined) ?? []
  ).map(ref => {
    const srcNode = nodes.find(n => n.id === ref.nodeId)
    const liveUrl = (srcNode?.data as CanvasNodeData)?.url?.[0] ?? ref.url
    return { nodeId: ref.nodeId, url: liveUrl, name: srcNode?.data?.name as string ?? '' }
  }).filter(r => r.url)

  const handleGenerate = useCallback(async () => {
    const freshParams = getParams(
      useCanvasStore.getState().nodes.find(n => n.id === id)?.data as CanvasNodeData ?? data
    )
    if (!freshParams.prompt.trim()) return
    setGenError(null)
    setIsGenerating(true)

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    let output = ''
    try {
      const resp = await fetch('/api/generate/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectUuid: data.projectUuid,
          nodeKey: id,
          params: {
            prompt: freshParams.prompt,
            model: freshParams.model,
            imageList: connectedImages.map(r => ({ nodeId: r.nodeId, url: r.url })),
            videoList: connectedVideos.map(r => ({ nodeId: r.nodeId, url: r.url })),
            textList: connectedTexts.map(r => ({ nodeId: r.nodeId, url: '', content: r.content })),
          },
        }),
        signal: ctrl.signal,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }))
        throw new Error(err.error ?? 'LLM 请求失败')
      }

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const raw = trimmed.slice(5).trim()
          if (raw === '[DONE]') break
          try {
            const parsed = JSON.parse(raw)
            if (parsed.error) throw new Error(parsed.error)
            if (parsed.delta) {
              output += parsed.delta
              // Update store in real-time
              const fn = useCanvasStore.getState().nodes.find(n => n.id === id)
              const cp = fn ? getParams(fn.data as CanvasNodeData) : freshParams
              useCanvasStore.getState().updateNodeData(id, {
                params: { ...cp, content: output } as unknown as Record<string, unknown>
              })
              // Scroll output to bottom
              if (outputRef.current) {
                outputRef.current.scrollTop = outputRef.current.scrollHeight
              }
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'JSON parse fail') throw e
          }
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        setGenError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setIsGenerating(false)
    }
  }, [id, data.projectUuid, connectedImages, connectedVideos, connectedTexts]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = useCallback(() => {
    if (params.content) navigator.clipboard.writeText(params.content).catch(() => {})
  }, [params.content])

  const handleClear = useCallback(() => {
    setParam('content', '')
    setGenError(null)
  }, [setParam])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    setIsGenerating(false)
  }, [])

  // Collapsed preview: show first 60 chars of content
  const preview = params.content
    ? params.content.replace(/\n/g, ' ').slice(0, 80) + (params.content.length > 80 ? '…' : '')
    : null

  return (
    <>
    <div ref={nodeContainerRef} style={{ display: 'contents' }}>
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={collapsed ? 220 : 340} minHeight={collapsed ? 100 : 120}>
      {/* Content preview (collapsed state) */}
      <div
        style={{ minHeight: collapsed ? 80 : 100, background: '#0d0b18', cursor: collapsed ? 'pointer' : 'default', padding: '12px 14px' }}
        onClick={collapsed ? () => setCollapsed(false) : undefined}
      >
        {preview ? (
          <p style={{ margin: 0, fontSize: 13, color: '#c0b8e0', lineHeight: 1.6, wordBreak: 'break-word' }}>
            {preview}
          </p>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 56 }}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" opacity={0.15}>
              <rect x="4" y="6" width="20" height="3" rx="1.5" fill="#c4b5fd"/>
              <rect x="4" y="12" width="16" height="3" rx="1.5" fill="#c4b5fd"/>
              <rect x="4" y="18" width="12" height="3" rx="1.5" fill="#c4b5fd"/>
            </svg>
          </div>
        )}
        {collapsed && (
          <div style={{ position: 'absolute', bottom: 8, right: 10, fontSize: 11, color: '#c4b5fd', background: 'rgba(13,10,26,0.75)', borderRadius: 4, padding: '2px 7px', pointerEvents: 'none' }}>
            点击展开
          </div>
        )}
      </div>

      {/* Divider ref — portal anchor */}
      <div ref={dividerRef} style={{ height: 0 }} />
    </NodeShell>
    </div>

    {/* Controls portal — fixed screen size regardless of canvas zoom */}
    {!collapsed && portalRect && createPortal(
      <div ref={controlsPortalRef} className="nodrag" style={{
        position: 'fixed',
        top: portalRect.bottom,
        left: portalRect.left,
        width: portalRect.width / zoom,
        zIndex: 1000,
        background: '#1a1625',
        borderRadius: '0 0 10px 10px',
        border: '1px solid #2d2040',
        borderTop: 'none',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}>
      <div style={{ padding: '0 10px 10px' }}>
      <div style={{ background: '#16121f', borderRadius: 12, border: '1px solid #221a35', overflow: 'hidden' }}>

        {/* Connected reference thumbnails */}
        {(connectedImages.length > 0 || connectedVideos.length > 0 || connectedTexts.length > 0) && (
          <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-2" style={{ flexWrap: 'wrap' }}>
            {connectedImages.map((ref, i) => (
              <div key={ref.nodeId} className="relative rounded-lg overflow-hidden nodrag"
                style={{ width: 46, height: 44, border: '1px solid #2a2040', flexShrink: 0 }}>
                <img src={ref.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(13,10,26,0.72)', fontSize: 9, color: '#c4b5fd', textAlign: 'center', padding: '1px 0' }}>
                  图{i + 1}
                </div>
              </div>
            ))}
            {connectedVideos.map((ref, i) => (
              <div key={ref.nodeId} className="relative rounded-lg overflow-hidden nodrag"
                style={{ width: 46, height: 44, border: '1px solid #2a2040', flexShrink: 0, background: '#0d0b18', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 18, opacity: 0.5 }}>▶</span>
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(13,10,26,0.72)', fontSize: 9, color: '#c4b5fd', textAlign: 'center', padding: '1px 0' }}>
                  视频{i + 1}
                </div>
              </div>
            ))}
            {connectedTexts.map((ref, i) => (
              <div key={ref.nodeId} className="nodrag"
                style={{ height: 44, padding: '4px 8px', border: '1px solid #2a2040', borderRadius: 8, background: '#1e1830', display: 'flex', alignItems: 'center', maxWidth: 120, overflow: 'hidden' }}>
                <span style={{ fontSize: 10, color: '#8a7aaa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  📝 {ref.name || `文本${i + 1}`}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Prompt input */}
        <div style={{ padding: '8px 14px 6px' }}>
          <div className="nodrag" style={{ maxHeight: 140, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#312550 transparent' }}>
            <textarea
              className="nodrag"
              style={{
                width: '100%', minHeight: 72, background: 'none', border: 'none', outline: 'none',
                color: '#d0c8f0', fontSize: 14, lineHeight: 1.7, resize: 'none',
                fontFamily: 'inherit', wordBreak: 'break-word',
              }}
              placeholder="输入指令，例如：根据图片写一段角色描述…"
              value={params.prompt}
              onChange={e => setParam('prompt', e.target.value)}
            />
          </div>
        </div>

        {/* Generated text output */}
        {(params.content || isGenerating) && (
          <div style={{ borderTop: '1px solid #1e1a2e', padding: '8px 14px 6px' }}>
            <div
              ref={outputRef}
              className="nodrag"
              style={{
                maxHeight: 260, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#312550 transparent',
                fontSize: 14, lineHeight: 1.75, color: '#e0d8f8', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}
            >
              {params.content}
              {isGenerating && <span style={{ display: 'inline-block', width: 8, height: 14, background: '#7c5cfc', borderRadius: 2, marginLeft: 2, verticalAlign: 'middle', animation: 'spin 0.8s linear infinite' }} />}
            </div>
          </div>
        )}

        {/* Error */}
        {genError && (
          <div style={{ margin: '0 14px 8px', padding: '6px 10px', borderRadius: 8, background: '#2a1020', color: '#f87171', fontSize: 13 }}>
            {genError}
          </div>
        )}

        {/* Bottom bar */}
        <div className="flex items-center nodrag" style={{ borderTop: '1px solid #1e1a2e', padding: '8px 12px', gap: 4 }}>
          {/* Model selector */}
          <select
            className="nodrag"
            value={params.model}
            onChange={e => setParam('model', e.target.value)}
            style={{ flex: '1 1 0', minWidth: 0, background: 'none', border: 'none', color: '#c4b5fd', fontSize: 13, cursor: 'pointer', outline: 'none', fontWeight: 500 }}
          >
            {TEXT_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>

          <div style={{ width: 1, height: 16, background: '#2a2040', flexShrink: 0 }} />

          {/* Copy */}
          {params.content && (
            <button className="nodrag" onClick={handleCopy}
              style={{ background: 'none', border: 'none', color: '#8a7aaa', fontSize: 13, cursor: 'pointer', padding: '0 4px' }}
              title="复制">复制</button>
          )}

          {/* Clear */}
          {params.content && (
            <button className="nodrag" onClick={handleClear}
              style={{ background: 'none', border: 'none', color: '#8a7aaa', fontSize: 13, cursor: 'pointer', padding: '0 4px' }}
              title="清空">清空</button>
          )}

          {/* Generate / Stop button */}
          <button
            className="nodrag flex items-center justify-center"
            style={{
              width: 36, height: 36, flexShrink: 0, marginLeft: 4, borderRadius: 10,
              background: isGenerating ? '#1e1830' : '#ffffff',
              border: 'none',
              cursor: isGenerating ? 'default' : 'pointer',
              color: isGenerating ? '#7c5cfc' : '#111',
              boxShadow: isGenerating ? 'none' : '0 2px 8px rgba(0,0,0,0.25)',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { if (!isGenerating) (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0' }}
            onMouseLeave={e => { if (!isGenerating) (e.currentTarget as HTMLButtonElement).style.background = '#ffffff' }}
            onClick={isGenerating ? handleStop : handleGenerate}
            title={isGenerating ? '停止生成' : '生成'}
          >
            {isGenerating
              ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="3" y="3" width="8" height="8" rx="1.5" fill="#7c5cfc"/>
                </svg>
              : <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 13V3M8 3L4 7M8 3l4 4" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
            }
          </button>
        </div>
      </div>
      </div>
      </div>,
      document.body
    )}
    </>
  )
}
