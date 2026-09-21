import { useEffect, useState, type MouseEvent } from 'react'
import { Loader2 } from 'lucide-react'
import type { TaskInfo } from '@/lib/types'
import { displayGenerationProgress, formatGenerationDuration } from '@/lib/generationProgress'
import { getImageModelDisplayName } from '@/lib/imageRules'

interface GenerationProgressProps {
  taskInfo?: Partial<TaskInfo> | null
  label?: string
  compact?: boolean
  variant?: 'card' | 'panel'
  onCancel?: () => void
}

export function GenerationProgress({
  taskInfo,
  label: labelProp = '生成中',
  compact = false,
  variant = 'card',
  onCancel,
}: GenerationProgressProps) {
  const [now, setNow] = useState(() => Date.now())

  // 分阶段的任务自己报当前阶段（细化纹理：准备控制素材 → 生成修复），
  // 比调用方写死的「生成图片」有用。没设就还是用调用方给的。
  const phaseLabel = typeof taskInfo?.phaseLabel === 'string' ? taskInfo.phaseLabel.trim() : ''
  const label = phaseLabel || labelProp

  useEffect(() => {
    if (!taskInfo?.loading) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [taskInfo?.loading, taskInfo?.taskId])

  const progress = displayGenerationProgress(taskInfo, now)
  const percent = progress.percent
  const model = getImageModelDisplayName(typeof taskInfo?.model === 'string' ? taskInfo.model : '')
  const quantity = Math.max(1, Math.floor(Number(taskInfo?.quantity) || 1))
  const quantityBadge = quantity > 1 ? `*${quantity}` : ''
  const overEstimate = Boolean(taskInfo?.loading && progress.remainingMs <= 0 && progress.elapsedMs >= progress.estimatedMs)

  const handleCancel = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onCancel?.()
  }

  if (variant === 'panel') {
    return (
      <div
        className="nodrag nopan shotflow-generation-progress shotflow-generation-progress-panel"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 10px 9px',
          borderRadius: 10,
          border: '1px solid rgba(128,189,255,0.16)',
          background: 'linear-gradient(180deg, rgba(18,22,28,0.72), rgba(8,10,14,0.84))',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
          color: '#e8f3ff',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Loader2
            size={13}
            strokeWidth={2.2}
            style={{
              color: '#80bdff',
              animation: 'spin 1s linear infinite',
              flexShrink: 0,
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>{label}</span>
              {model && (
                <span
                  style={{
                    minWidth: 0,
                    color: 'rgba(174,184,198,0.64)',
                    fontSize: 10,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {model}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            {quantityBadge && (
              <span
                style={{
                  height: 18,
                  padding: '0 7px',
                  borderRadius: 999,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px solid rgba(128,189,255,0.24)',
                  background: 'linear-gradient(180deg, rgba(128,189,255,0.24), rgba(54,88,118,0.20))',
                  color: '#eef8ff',
                  fontSize: 10,
                  fontWeight: 900,
                  lineHeight: 1,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 0 12px rgba(128,189,255,0.18)',
                }}
              >
                {quantityBadge}
              </span>
            )}
            <span style={{ fontSize: 12, fontWeight: 900, color: '#ffffff' }}>{percent}%</span>
          </div>
          {onCancel && (
            <button
              type="button"
              className="nodrag nopan"
              onPointerDown={event => event.stopPropagation()}
              onClick={handleCancel}
              style={{
                height: 24,
                padding: '0 10px',
                borderRadius: 7,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.045)',
                color: 'rgba(226,232,240,0.72)',
                fontSize: 11,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              取消
            </button>
          )}
        </div>

        <div
          style={{
            height: 4,
            marginTop: 7,
            borderRadius: 999,
            overflow: 'hidden',
            background: 'rgba(255,255,255,0.08)',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.035)',
          }}
        >
          <div
            style={{
              width: `${percent}%`,
              height: '100%',
              borderRadius: 999,
              background: 'linear-gradient(90deg, #80bdff, #d8f3ff 72%, #ffffff)',
              boxShadow: '0 0 14px rgba(128,189,255,0.45)',
              transition: 'width 420ms ease',
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginTop: 6,
            color: 'rgba(174,184,198,0.64)',
            fontSize: 10,
            lineHeight: 1.2,
          }}
        >
          <span>已用 {formatGenerationDuration(progress.elapsedMs)}</span>
          <span>{overEstimate ? '仍在等待结果' : `预计剩余 ${formatGenerationDuration(progress.remainingMs)}`}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className="nodrag nopan shotflow-generation-progress shotflow-generation-progress-card"
      style={{
        width: compact ? 168 : 238,
        padding: compact ? '9px 10px' : '12px 13px',
        borderRadius: 14,
        border: '1px solid rgba(128,189,255,0.18)',
        background: 'linear-gradient(180deg, rgba(18,22,28,0.94), rgba(8,10,14,0.94))',
        boxShadow: '0 16px 36px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.08)',
        color: '#e8f3ff',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Loader2
          size={compact ? 13 : 15}
          strokeWidth={2.1}
          style={{ color: '#80bdff', animation: 'spin 1s linear infinite', flexShrink: 0 }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: compact ? 11 : 12, fontWeight: 800, whiteSpace: 'nowrap' }}>{label}</span>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
              {quantityBadge && (
                <span
                  style={{
                    height: compact ? 16 : 18,
                    padding: compact ? '0 6px' : '0 7px',
                    borderRadius: 999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px solid rgba(128,189,255,0.24)',
                    background: 'linear-gradient(180deg, rgba(128,189,255,0.24), rgba(54,88,118,0.20))',
                    color: '#eef8ff',
                    fontSize: compact ? 9 : 10,
                    fontWeight: 900,
                    lineHeight: 1,
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 0 12px rgba(128,189,255,0.18)',
                  }}
                >
                  {quantityBadge}
                </span>
              )}
              <span style={{ fontSize: compact ? 11 : 12, fontWeight: 900, color: '#ffffff' }}>{percent}%</span>
            </div>
          </div>
          {!compact && model && (
            <div style={{ marginTop: 2, color: 'rgba(174,184,198,0.64)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {model}
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          height: compact ? 4 : 5,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.08)',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: 999,
            background: 'linear-gradient(90deg, #80bdff, #d8f3ff 72%, #ffffff)',
            boxShadow: '0 0 16px rgba(128,189,255,0.45)',
            transition: 'width 420ms ease',
          }}
        />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginTop: compact ? 7 : 8,
          color: 'rgba(174,184,198,0.64)',
          fontSize: compact ? 10 : 11,
          lineHeight: 1.25,
        }}
      >
        <span>已用 {formatGenerationDuration(progress.elapsedMs)}</span>
        <span>{overEstimate ? '仍在等待结果' : `预计剩余 ${formatGenerationDuration(progress.remainingMs)}`}</span>
      </div>

      {onCancel && (
        <button
          type="button"
          className="nodrag nopan"
          onPointerDown={event => event.stopPropagation()}
          onClick={handleCancel}
          style={{
            marginTop: compact ? 7 : 9,
            width: '100%',
            height: compact ? 22 : 24,
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.045)',
            color: 'rgba(226,232,240,0.72)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          取消生成
        </button>
      )}
    </div>
  )
}
