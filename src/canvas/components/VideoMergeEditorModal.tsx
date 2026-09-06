import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Check, Copy, Loader2, Pause, Play, Scissors, Trash2, X } from 'lucide-react'
import type { VideoMergeClip } from '@/lib/types'

interface VideoMergeEditorModalProps {
  nodeName: string
  clips: VideoMergeClip[]
  outputUrl?: string
  isExporting?: boolean
  error?: string | null
  onChangeClips: (clips: VideoMergeClip[]) => void
  onExport: () => void
  onClose: () => void
}

const MIN_CLIP_DURATION = 0.2

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  const tenths = Math.floor((safe - Math.floor(safe)) * 10)
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`
}

function clipDuration(clip: VideoMergeClip, durationMap: Record<string, number>) {
  const sourceDuration = durationMap[clip.id] ?? clip.durationSec
  const safeStart = Math.max(0, Number(clip.startSec) || 0)
  const safeEnd = Number.isFinite(Number(clip.endSec))
    ? Number(clip.endSec)
    : Number(sourceDuration || safeStart + 5)
  return Math.max(MIN_CLIP_DURATION, safeEnd - safeStart)
}

function timelinePositionForClip(clips: VideoMergeClip[], clipId: string, durationMap: Record<string, number>) {
  let cursor = 0
  for (const clip of clips) {
    if (clip.id === clipId) return cursor
    cursor += clipDuration(clip, durationMap)
  }
  return 0
}

function clipAtTime(clips: VideoMergeClip[], time: number, durationMap: Record<string, number>) {
  let cursor = 0
  for (const clip of clips) {
    const duration = clipDuration(clip, durationMap)
    if (time <= cursor + duration || clip === clips[clips.length - 1]) {
      return { clip, offset: cursor, localTime: clamp(time - cursor, 0, duration) }
    }
    cursor += duration
  }
  return null
}

function safeClipEnd(clip: VideoMergeClip, durationMap: Record<string, number>) {
  const sourceDuration = durationMap[clip.id] ?? clip.durationSec
  const fallbackEnd = (Number(clip.startSec) || 0) + 5
  return Number.isFinite(Number(clip.endSec))
    ? Number(clip.endSec)
    : Number(sourceDuration || fallbackEnd)
}

export function VideoMergeEditorModal({
  nodeName,
  clips,
  outputUrl,
  isExporting,
  error,
  onChangeClips,
  onExport,
  onClose,
}: VideoMergeEditorModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const rafRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number>(0)
  const [durationMap, setDurationMap] = useState<Record<string, number>>({})
  const [selectedClipId, setSelectedClipId] = useState<string | null>(clips[0]?.id ?? null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)

  const totalDuration = useMemo(
    () => clips.reduce((sum, clip) => sum + clipDuration(clip, durationMap), 0),
    [clips, durationMap]
  )
  const active = useMemo(() => clipAtTime(clips, playhead, durationMap), [clips, durationMap, playhead])
  const selectedClip = useMemo(
    () => clips.find((clip) => clip.id === selectedClipId) ?? clips[0] ?? null,
    [clips, selectedClipId]
  )

  useEffect(() => {
    if (!clips.length) {
      setSelectedClipId(null)
      setPlayhead(0)
      return
    }
    if (!selectedClipId || !clips.some((clip) => clip.id === selectedClipId)) {
      setSelectedClipId(clips[0].id)
    }
    if (playhead > totalDuration) setPlayhead(Math.max(0, totalDuration - 0.01))
  }, [clips, playhead, selectedClipId, totalDuration])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !active?.clip) return
    const targetTime = active.clip.startSec + active.localTime
    if (Math.abs(video.currentTime - targetTime) > 0.12) {
      video.currentTime = Math.max(0, targetTime)
    }
    if (playing) {
      void video.play().catch(() => null)
    } else {
      video.pause()
    }
  }, [active?.clip?.id, active?.clip?.startSec, active?.localTime, active?.clip, playing])

  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }

    lastFrameRef.current = performance.now()
    const tick = (now: number) => {
      const delta = (now - lastFrameRef.current) / 1000
      lastFrameRef.current = now
      setPlayhead((current) => {
        const next = current + delta
        if (next >= totalDuration) {
          setPlaying(false)
          return Math.max(0, totalDuration)
        }
        return next
      })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [playing, totalDuration])

  const updateClip = useCallback((clipId: string, patch: Partial<VideoMergeClip>) => {
    onChangeClips(clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip))
  }, [clips, onChangeClips])

  const moveClip = useCallback((clipId: string, direction: -1 | 1) => {
    const index = clips.findIndex((clip) => clip.id === clipId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= clips.length) return
    const next = [...clips]
    const [clip] = next.splice(index, 1)
    next.splice(target, 0, clip)
    onChangeClips(next)
    setPlayhead(timelinePositionForClip(next, clipId, durationMap))
  }, [clips, durationMap, onChangeClips])

  const removeClip = useCallback((clipId: string) => {
    const next = clips.filter((clip) => clip.id !== clipId)
    onChangeClips(next)
    setSelectedClipId(next[0]?.id ?? null)
    setPlayhead(0)
  }, [clips, onChangeClips])

  const duplicateClip = useCallback((clipId: string) => {
    const index = clips.findIndex((clip) => clip.id === clipId)
    if (index < 0) return
    const source = clips[index]
    const nextClip = { ...source, id: `${source.id}-copy-${Date.now()}`, name: `${source.name} 复制` }
    const next = [...clips.slice(0, index + 1), nextClip, ...clips.slice(index + 1)]
    onChangeClips(next)
    setSelectedClipId(nextClip.id)
    setPlayhead(timelinePositionForClip(next, nextClip.id, durationMap))
  }, [clips, durationMap, onChangeClips])

  const splitAtPlayhead = useCallback(() => {
    const hit = clipAtTime(clips, playhead, durationMap)
    if (!hit) return
    const { clip, localTime } = hit
    const splitSourceTime = clip.startSec + localTime
    const end = safeClipEnd(clip, durationMap)
    if (splitSourceTime - clip.startSec < MIN_CLIP_DURATION || end - splitSourceTime < MIN_CLIP_DURATION) return
    const first = { ...clip, endSec: splitSourceTime }
    const second = {
      ...clip,
      id: `${clip.id}-split-${Date.now()}`,
      name: `${clip.name} B`,
      startSec: splitSourceTime,
      endSec: end,
    }
    const next = clips.flatMap((item) => item.id === clip.id ? [first, second] : [item])
    onChangeClips(next)
    setSelectedClipId(second.id)
  }, [clips, durationMap, onChangeClips, playhead])

  const selectClipAtStart = useCallback((clip: VideoMergeClip) => {
    setSelectedClipId(clip.id)
    setPlayhead(timelinePositionForClip(clips, clip.id, durationMap))
  }, [clips, durationMap])

  const currentUrl = active?.clip?.url || outputUrl || clips[0]?.url || ''
  const selectedDuration = selectedClip ? (durationMap[selectedClip.id] ?? selectedClip.durationSec ?? safeClipEnd(selectedClip, durationMap)) : 0
  const selectedStart = selectedClip ? Math.max(0, Number(selectedClip.startSec) || 0) : 0
  const selectedEnd = selectedClip ? safeClipEnd(selectedClip, durationMap) : 0

  return createPortal(
    <div
      className="nodrag"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: '#111',
        color: '#f7f7f8',
        display: 'grid',
        gridTemplateRows: '38px minmax(300px,1fr) 250px',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 12px', borderBottom: '1px solid #222', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>视频合成</strong>
        <span style={{ color: '#777', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nodeName}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onExport}
            disabled={!clips.length || isExporting}
            style={{
              height: 28,
              padding: '0 12px',
              borderRadius: 8,
              border: 'none',
              background: isExporting ? '#333' : '#fff',
              color: isExporting ? '#aaa' : '#111',
              fontWeight: 700,
              cursor: isExporting ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {isExporting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            导出
          </button>
          <button onClick={onClose} style={{ width: 28, height: 28, border: 'none', background: 'none', color: '#aaa', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e1e1f', minHeight: 0 }}>
          {currentUrl ? (
            <video
              key={active?.clip?.id || currentUrl}
              ref={videoRef}
              src={currentUrl}
              controls={false}
              muted={active?.clip?.muted ?? true}
              style={{ maxWidth: '100%', maxHeight: '100%', background: '#000' }}
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration
                if (active?.clip && Number.isFinite(duration) && duration > 0) {
                  setDurationMap((current) => ({ ...current, [active.clip.id]: Number(duration.toFixed(3)) }))
                }
              }}
            />
          ) : (
            <div style={{ color: '#777' }}>把视频节点连到视频合成节点后开始剪辑</div>
          )}
        </div>

        <div style={{ borderLeft: '1px solid #252525', padding: 14, overflow: 'auto', background: '#171717' }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>片段设置</div>
          {selectedClip ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', color: '#888', fontSize: 12, marginBottom: 5 }}>名称</label>
                <input
                  value={selectedClip.name}
                  onChange={(event) => updateClip(selectedClip.id, { name: event.currentTarget.value })}
                  style={{ width: '100%', height: 32, borderRadius: 7, border: '1px solid #333', background: '#101010', color: '#fff', padding: '0 9px' }}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ color: '#888', fontSize: 12 }}>
                  入点
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={Number(selectedStart.toFixed(1))}
                    onChange={(event) => {
                      const nextStart = clamp(Number(event.currentTarget.value), 0, Math.max(0, selectedEnd - MIN_CLIP_DURATION))
                      updateClip(selectedClip.id, { startSec: Number(nextStart.toFixed(3)) })
                    }}
                    style={{ marginTop: 5, width: '100%', height: 32, borderRadius: 7, border: '1px solid #333', background: '#101010', color: '#fff', padding: '0 9px' }}
                  />
                </label>
                <label style={{ color: '#888', fontSize: 12 }}>
                  出点
                  <input
                    type="number"
                    min={MIN_CLIP_DURATION}
                    step={0.1}
                    value={Number(selectedEnd.toFixed(1))}
                    onChange={(event) => {
                      const max = Math.max(selectedDuration, selectedStart + MIN_CLIP_DURATION)
                      const nextEnd = clamp(Number(event.currentTarget.value), selectedStart + MIN_CLIP_DURATION, max)
                      updateClip(selectedClip.id, { endSec: Number(nextEnd.toFixed(3)), durationSec: selectedDuration })
                    }}
                    style={{ marginTop: 5, width: '100%', height: 32, borderRadius: 7, border: '1px solid #333', background: '#101010', color: '#fff', padding: '0 9px' }}
                  />
                </label>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#888', fontSize: 12, marginBottom: 6 }}>
                  <span>剪辑范围</span>
                  <span>{formatTime(clipDuration(selectedClip, durationMap))}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(MIN_CLIP_DURATION, selectedDuration)}
                  step={0.1}
                  value={selectedStart}
                  onChange={(event) => {
                    const nextStart = clamp(Number(event.currentTarget.value), 0, Math.max(0, selectedEnd - MIN_CLIP_DURATION))
                    updateClip(selectedClip.id, { startSec: Number(nextStart.toFixed(3)) })
                  }}
                  style={{ width: '100%' }}
                />
                <input
                  type="range"
                  min={MIN_CLIP_DURATION}
                  max={Math.max(MIN_CLIP_DURATION, selectedDuration)}
                  step={0.1}
                  value={selectedEnd}
                  onChange={(event) => {
                    const nextEnd = clamp(Number(event.currentTarget.value), selectedStart + MIN_CLIP_DURATION, Math.max(selectedDuration, selectedStart + MIN_CLIP_DURATION))
                    updateClip(selectedClip.id, { endSec: Number(nextEnd.toFixed(3)), durationSec: selectedDuration })
                  }}
                  style={{ width: '100%' }}
                />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#bbb', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={Boolean(selectedClip.muted)}
                  onChange={(event) => updateClip(selectedClip.id, { muted: event.currentTarget.checked })}
                />
                静音预览
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
                <IconButton title="上移" onClick={() => moveClip(selectedClip.id, -1)}><ArrowUp size={15} /></IconButton>
                <IconButton title="下移" onClick={() => moveClip(selectedClip.id, 1)}><ArrowDown size={15} /></IconButton>
                <IconButton title="复制" onClick={() => duplicateClip(selectedClip.id)}><Copy size={15} /></IconButton>
                <IconButton title="删除" danger onClick={() => removeClip(selectedClip.id)}><Trash2 size={15} /></IconButton>
              </div>
            </div>
          ) : (
            <div style={{ color: '#777', fontSize: 13 }}>暂无片段</div>
          )}
          {error ? <div style={{ marginTop: 12, padding: 9, borderRadius: 8, background: '#35101a', color: '#ff8aa0', fontSize: 12 }}>{error}</div> : null}
        </div>
      </div>

      <div style={{ borderTop: '1px solid #252525', background: '#181818', display: 'grid', gridTemplateRows: '46px 1fr' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid #242424' }}>
          <IconButton title={playing ? '暂停' : '播放'} onClick={() => setPlaying((value) => !value)}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </IconButton>
          <IconButton title="在播放头分割" onClick={splitAtPlayhead}>
            <Scissors size={16} />
          </IconButton>
          <span style={{ width: 72, textAlign: 'center', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{formatTime(playhead)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(0.1, totalDuration)}
            step={0.05}
            value={Math.min(playhead, totalDuration)}
            onChange={(event) => {
              setPlaying(false)
              setPlayhead(Number(event.currentTarget.value))
            }}
            style={{ flex: 1 }}
          />
          <span style={{ width: 72, textAlign: 'center', fontVariantNumeric: 'tabular-nums', color: '#999', fontSize: 12 }}>{formatTime(totalDuration)}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', minHeight: 0 }}>
          <div style={{ borderRight: '1px solid #252525', padding: '16px 10px', color: '#999', fontSize: 12 }}>
            <div>视频</div>
            <div style={{ marginTop: 18 }}>无音频导出</div>
          </div>
          <div style={{ position: 'relative', padding: '20px 18px', overflow: 'hidden' }}>
            <div style={{ position: 'relative', height: 58, borderRadius: 8, background: '#242424', overflow: 'hidden' }}>
              {clips.map((clip) => {
                const duration = clipDuration(clip, durationMap)
                const width = totalDuration > 0 ? `${(duration / totalDuration) * 100}%` : '0%'
                const activeClip = clip.id === selectedClipId
                return (
                  <button
                    key={clip.id}
                    onClick={() => selectClipAtStart(clip)}
                    style={{
                      width,
                      height: '100%',
                      minWidth: 42,
                      border: activeClip ? '2px solid #fff' : '1px solid #444',
                      background: activeClip ? '#4651a6' : '#2f365f',
                      color: '#fff',
                      cursor: 'pointer',
                      textAlign: 'left',
                      padding: '6px 8px',
                      verticalAlign: 'top',
                      overflow: 'hidden',
                    }}
                    title={`${clip.name} ${formatTime(duration)}`}
                  >
                    <div style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{clip.name}</div>
                    <div style={{ marginTop: 6, height: 12, background: 'repeating-linear-gradient(90deg, rgba(255,255,255,.2), rgba(255,255,255,.2) 8px, transparent 8px, transparent 14px)' }} />
                  </button>
                )
              })}
              <div
                style={{
                  position: 'absolute',
                  top: -8,
                  bottom: -8,
                  left: totalDuration > 0 ? `${(playhead / totalDuration) * 100}%` : 0,
                  width: 2,
                  background: '#fff',
                  boxShadow: '0 0 0 1px rgba(0,0,0,.7)',
                  pointerEvents: 'none',
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'none' }}>
        {clips.map((clip) => (
          <video
            key={clip.id}
            src={clip.url}
            preload="metadata"
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration
              if (Number.isFinite(duration) && duration > 0) {
                setDurationMap((current) => ({ ...current, [clip.id]: Number(duration.toFixed(3)) }))
              }
            }}
          />
        ))}
      </div>
    </div>,
    document.body
  )
}

function IconButton({
  children,
  title,
  danger,
  onClick,
}: {
  children: ReactNode
  title: string
  danger?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 32,
        height: 32,
        borderRadius: 7,
        border: '1px solid #34323a',
        background: danger ? '#2a1018' : '#252229',
        color: danger ? '#ff8aa0' : '#d6d1df',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}
