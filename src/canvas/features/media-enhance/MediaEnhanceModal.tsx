import { useCallback, useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Loader2, Sparkles, X } from 'lucide-react'

export type MediaEnhanceScale = 2 | 4
export type MediaEnhanceMode = 'faithful' | 'generative' | 'nvidia-vsr' | 'flashvsr'

interface MediaEnhanceModalProps {
  mediaType: 'image' | 'video'
  url: string
  name?: string
  widthHint?: number
  heightHint?: number
  fpsHint?: number
  durationHintSec?: number
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: (mode: MediaEnhanceMode, scale: MediaEnhanceScale) => Promise<void> | void
}

function positive(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function formatDuration(value: number) {
  if (!value) return '—'
  const seconds = Math.max(0, Math.round(value))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function formatFps(value: number) {
  return value ? `${Number(value.toFixed(3))} fps` : '读取中'
}

const cardStyle: CSSProperties = {
  width: 'min(720px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  borderRadius: 20,
  border: '1px solid #34275b',
  background: 'linear-gradient(180deg, #171129, #0e0b17)',
  boxShadow: '0 30px 100px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.06)',
}

export function MediaEnhanceModal({
  mediaType,
  url,
  name,
  widthHint,
  heightHint,
  fpsHint,
  durationHintSec,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: MediaEnhanceModalProps) {
  // Video leads with NVIDIA's official MP4-compatible VSR. Images keep the
  // existing generative default; the server still accepts faithful for old jobs.
  const [mode, setMode] = useState<MediaEnhanceMode>(
    mediaType === 'video' ? 'nvidia-vsr' : 'generative',
  )
  const [scale, setScale] = useState<MediaEnhanceScale>(2)
  const [width, setWidth] = useState(() => Math.round(positive(widthHint)))
  const [height, setHeight] = useState(() => Math.round(positive(heightHint)))
  const [fps, setFps] = useState(() => positive(fpsHint))
  const [durationSec, setDurationSec] = useState(() => positive(durationHintSec))
  const [previewError, setPreviewError] = useState('')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])

  const outputWidth = width ? width * scale : 0
  const outputHeight = height ? height * scale : 0
  const outputMegapixels = outputWidth && outputHeight ? outputWidth * outputHeight / 1_000_000 : 0
  const outputLabel = outputWidth && outputHeight
    ? `${outputWidth} × ${outputHeight}${outputMegapixels ? ` · ${outputMegapixels.toFixed(outputMegapixels >= 10 ? 1 : 2)} MP` : ''}`
    : '读取源尺寸后计算'
  const sourceLabel = width && height ? `${width} × ${height}` : '读取中'

  const handleImageMetadata = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    if (image.naturalWidth > 0) setWidth(image.naturalWidth)
    if (image.naturalHeight > 0) setHeight(image.naturalHeight)
    setPreviewError('')
  }, [])

  const handleVideoMetadata = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    if (video.videoWidth > 0) setWidth(video.videoWidth)
    if (video.videoHeight > 0) setHeight(video.videoHeight)
    if (Number.isFinite(video.duration) && video.duration > 0) setDurationSec(video.duration)
    setPreviewError('')
  }, [])

  const infoCells = useMemo(() => mediaType === 'video'
    ? [
        ['源分辨率', sourceLabel],
        ['源帧率', formatFps(fps)],
        ['时长', formatDuration(durationSec)],
      ]
    : [['源分辨率', sourceLabel]], [durationSec, fps, mediaType, sourceLabel])

  const enhancementOptions = mediaType === 'video'
    ? [
        {
          value: 'nvidia-vsr' as const,
          title: 'NVIDIA RTX 视频超分',
          subtitle: '官方 Video Super Resolution · 超分、去噪、去压缩瑕疵',
        },
        {
          value: 'generative' as const,
          title: 'SeedVR2 生成式细节',
          subtitle: '补皮肤、发丝、材质与光影，会轻微重绘画面',
        },
        {
          value: 'flashvsr' as const,
          title: 'FlashVSR 电影级细节',
          subtitle: '官方 v1.1 一步扩散 · 强化皮肤、发丝、布料与材质',
        },
      ]
    : [
        {
          value: 'faithful' as const,
          title: '忠实放大',
          subtitle: 'RealSR · 恢复已有纹理，不重画内容',
        },
        {
          value: 'generative' as const,
          title: '生成式细节',
          subtitle: 'SeedVR2 7B Sharp · 补皮肤、发丝、材质与光影',
        },
      ]

  return createPortal(
    <div
      className="nodrag"
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(2,1,7,.84)',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div className="nodrag" role="dialog" aria-modal="true" aria-label="AI 高清增强" style={cardStyle} onMouseDown={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 18px 14px', borderBottom: '1px solid #2b2048' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <span style={{ width: 36, height: 36, borderRadius: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#ded5ff', background: 'rgba(124,92,252,.17)', border: '1px solid rgba(167,139,250,.3)', flexShrink: 0 }}>
              <Sparkles size={18} strokeWidth={1.9} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#f7f3ff', fontSize: 16, fontWeight: 720 }}>AI 高清增强</div>
              <div title={name} style={{ marginTop: 3, maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#9488b6', fontSize: 12 }}>
                {name || (mediaType === 'video' ? '视频' : '图片')}
              </div>
            </div>
          </div>
          <button type="button" aria-label="关闭" disabled={busy} onClick={onCancel} style={{ width: 32, height: 32, borderRadius: 10, border: '1px solid #392c5e', background: '#1b1530', color: '#b9addb', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: busy ? 'default' : 'pointer', opacity: busy ? .5 : 1 }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 18 }}>
          <div style={{ overflow: 'hidden', borderRadius: 14, border: '1px solid #2b2148', background: '#050408' }}>
            {mediaType === 'video' ? (
              <video src={url} controls muted playsInline preload="metadata" onLoadedMetadata={handleVideoMetadata} onError={() => setPreviewError('预览加载失败，仍可由服务端读取源视频')} style={{ display: 'block', width: '100%', maxHeight: '38vh', background: '#000' }} />
            ) : (
              <img src={url} alt={name || '待增强图片'} onLoad={handleImageMetadata} onError={() => setPreviewError('预览加载失败，仍可由服务端读取源图片')} style={{ display: 'block', width: '100%', maxHeight: '38vh', objectFit: 'contain', background: '#08070c' }} />
            )}
          </div>
          {previewError && <div style={{ marginTop: 7, color: '#a99bcf', fontSize: 11 }}>{previewError}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, infoCells.length)}, minmax(0, 1fr))`, gap: 8, marginTop: 12 }}>
            {infoCells.map(([label, value]) => <InfoCell key={label} label={label} value={value} />)}
          </div>

          <div style={{ marginTop: 14, padding: 14, borderRadius: 14, border: '1px solid #302451', background: 'rgba(31,23,56,.58)' }}>
            <div style={{ color: '#eee8ff', fontSize: 13, fontWeight: 700, marginBottom: 10 }}>增强方式</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 9 }}>
              {enhancementOptions.map((option) => {
                const active = mode === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={busy}
                    onClick={() => setMode(option.value)}
                    style={{ minHeight: 70, padding: '9px 12px', borderRadius: 11, border: active ? '1px solid #a78bfa' : '1px solid #3b2c61', background: active ? 'rgba(124,92,252,.72)' : '#1a1430', color: active ? '#fff' : '#c9bdf0', cursor: busy ? 'default' : 'pointer', textAlign: 'left' }}
                  >
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 750 }}>{option.title}</span>
                    <span style={{ display: 'block', marginTop: 5, color: active ? '#ddd4ff' : '#897da9', fontSize: 10, lineHeight: 1.45 }}>{option.subtitle}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div style={{ marginTop: 14, padding: 14, borderRadius: 14, border: '1px solid #302451', background: 'rgba(31,23,56,.58)' }}>
            <div style={{ color: '#eee8ff', fontSize: 13, fontWeight: 700, marginBottom: 10 }}>放大倍数</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 9 }}>
              {([2, 4] as const).map((value) => {
                const active = scale === value
                return (
                  <button key={value} type="button" disabled={busy} onClick={() => setScale(value)} style={{ minHeight: 58, padding: '8px 12px', borderRadius: 11, border: active ? '1px solid #a78bfa' : '1px solid #3b2c61', background: active ? 'rgba(124,92,252,.72)' : '#1a1430', color: active ? '#fff' : '#c9bdf0', cursor: busy ? 'default' : 'pointer', textAlign: 'left' }}>
                    <span style={{ display: 'block', fontSize: 15, fontWeight: 750 }}>{value}×</span>
                    <span style={{ display: 'block', marginTop: 3, color: active ? '#ddd4ff' : '#897da9', fontSize: 10 }}>{value === 2 ? '更快，精确 2 倍尺寸' : '最高细节，文件和耗时更大'}</span>
                  </button>
                )
              })}
            </div>
            <div style={{ marginTop: 11, padding: '10px 12px', borderRadius: 10, background: '#141022', border: '1px solid #281e43' }}>
              <div style={{ color: '#756a94', fontSize: 10 }}>预计输出</div>
              <div style={{ marginTop: 4, color: '#e5def8', fontSize: 13, fontWeight: 700 }}>{outputLabel}</div>
            </div>
          </div>

          <div style={{ marginTop: 12, padding: '11px 13px', borderRadius: 12, border: '1px solid rgba(167,139,250,.2)', background: 'rgba(124,92,252,.07)', color: '#aa9dcb', fontSize: 11, lineHeight: 1.65 }}>
            <div style={{ color: '#dcd3ff', fontWeight: 700, marginBottom: 2 }}>
              {mode === 'generative'
                ? 'SeedVR2 7B Sharp · 生成式画质优先'
                : mode === 'flashvsr'
                  ? 'FlashVSR v1.1 Tiny Long · 官方完整管线'
                : mode === 'nvidia-vsr'
                  ? 'NVIDIA RTX Video Super Resolution · ULTRA 画质'
                  : 'RealSR · 忠实画质优先'}
            </div>
            {mode === 'generative' ? (
              <>
                <div>按连续视频帧重建照片级纹理、皮肤、发丝、材质和自然光影，不是简单锐化。</div>
                <div style={{ marginTop: 3, color: '#c4b6e8' }}>会重绘像素，人物五官、文字和细线可能轻微变化；耗时明显高于忠实放大。</div>
              </>
            ) : mode === 'flashvsr' ? (
              <>
                <div>使用 FlashVSR 官方 v1.1 一步扩散模型，生成原视频里没有的合理高频细节，并保持跨帧连贯。</div>
                <div style={{ marginTop: 3, color: '#c4b6e8' }}>4× 是官方推荐档；处理比 NVIDIA 慢，人脸、文字和精细图案可能被生成式重建。</div>
              </>
            ) : mode === 'nvidia-vsr' ? (
              <>
                <div>使用 NVIDIA 官方 Video Effects SDK，逐帧执行超分、去噪和去压缩瑕疵；不生成不存在的皮肤或发丝。</div>
                <div style={{ marginTop: 3, color: '#c4b6e8' }}>普通 MP4 没有游戏 DLSS 所需的深度和运动矢量，因此这里使用 NVIDIA 面向视频的真实 VSR。</div>
              </>
            ) : (
              <div>开源 NCNN/Vulkan AI 超分，只恢复已有纹理，不重画内容。</div>
            )}
            {mediaType === 'video' ? (
              <div style={{ marginTop: 3 }}>保留帧数、帧率、时长和音轨；H.264 High / yuv420p / MP4，兼容 RV。</div>
            ) : (
              mode === 'faithful' && <div style={{ marginTop: 3 }}>图片默认启用 TTA；2× 会先做 4× AI 推理，再用 Lanczos 高质量回采样。</div>
            )}
          </div>

          {error && <div role="alert" style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(248,113,113,.3)', background: 'rgba(127,29,29,.28)', color: '#fca5a5', fontSize: 12, lineHeight: 1.5 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button type="button" disabled={busy} onClick={onCancel} style={{ height: 40, padding: '0 16px', borderRadius: 10, border: '1px solid #3b2c61', background: '#1a1430', color: '#b9addb', cursor: busy ? 'default' : 'pointer' }}>取消</button>
            <button type="button" disabled={busy} onClick={() => void onConfirm(mode, scale)} style={{ minWidth: 132, height: 40, padding: '0 16px', border: 0, borderRadius: 10, background: busy ? '#322951' : '#fff', color: busy ? '#978abd' : '#17111f', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: busy ? 'default' : 'pointer', fontWeight: 750 }}>
              {busy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={16} strokeWidth={2.2} />}
              {busy
                ? '正在创建任务'
                : mode === 'generative'
                  ? '执行生成式增强'
                : mode === 'flashvsr'
                  ? '执行 FlashVSR 增强'
                : mode === 'nvidia-vsr'
                    ? '执行 NVIDIA 超分'
                    : '执行高清增强'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0, padding: '8px 10px', borderRadius: 10, background: '#141022', border: '1px solid #261c40' }}>
      <div style={{ color: '#71658f', fontSize: 10, marginBottom: 3 }}>{label}</div>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ddd5f5', fontSize: 12, fontWeight: 650 }}>{value}</div>
    </div>
  )
}
