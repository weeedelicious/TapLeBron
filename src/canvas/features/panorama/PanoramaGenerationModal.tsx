import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronLeft, FlaskConical, Globe2, Loader2, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_PANORAMA_GENERATION_SETTINGS,
  PANORAMA_MODEL_OPTIONS,
  PANORAMA_RESOLUTION_OPTIONS,
  normalizePanoramaMode,
  panoramaGenerateButtonLabel,
  panoramaModeLabel,
  panoramaModeOptions,
  panoramaModelLabel,
  type PanoramaGenerationMode,
  type PanoramaGenerationSettings,
  type PanoramaModel,
  type PanoramaResolution,
} from './panorama-generation'
import './panorama-generation-modal.css'

interface PanoramaGenerationModalProps {
  sourceName?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: (settings: PanoramaGenerationSettings) => void | Promise<void>
}

type ModalStep = 'settings' | 'confirm'

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="panorama-generation-modal__field-label">{children}</div>
}

export function PanoramaGenerationModal({
  sourceName,
  busy = false,
  onCancel,
  onConfirm,
}: PanoramaGenerationModalProps) {
  const [step, setStep] = useState<ModalStep>('settings')
  const [settings, setSettings] = useState<PanoramaGenerationSettings>(DEFAULT_PANORAMA_GENERATION_SETTINGS)
  const [localError, setLocalError] = useState('')
  const modeOptions = useMemo(() => panoramaModeOptions(settings.model), [settings.model])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])

  const updateModel = (model: PanoramaModel) => {
    setSettings((current) => ({
      ...current,
      model,
      generationMode: normalizePanoramaMode(model, current.generationMode),
    }))
  }

  const prepareConfirmation = (generationMode: PanoramaGenerationMode) => {
    setLocalError('')
    setSettings((current) => ({ ...current, generationMode }))
    setStep('confirm')
  }

  const confirm = async () => {
    if (busy) return
    try {
      setLocalError('')
      await onConfirm({ ...settings, description: settings.description.trim() })
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '全景生成提交失败')
    }
  }

  const callout = settings.generationMode === 'erp-template-mask-experiment'
    ? '本次只生成 ERP 模板第一阶段。若接缝需要修复，不会自动发起第二次付费调用。'
    : '请求发出后不会因画质问题自动再次付费生成；失败原因会直接显示在结果节点。'

  return createPortal(
    <div
      className="panorama-generation-modal nodrag"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div className="panorama-generation-modal__card" onMouseDown={(event) => event.stopPropagation()}>
        <header className="panorama-generation-modal__header">
          <div className="panorama-generation-modal__icon"><Globe2 size={20} /></div>
          <div className="panorama-generation-modal__heading">
            <div className="panorama-generation-modal__eyebrow">
              {step === 'confirm' ? 'ONE IMAGE API CALL' : 'HDR · 720° PANORAMA'}
            </div>
            <h2>{step === 'confirm' ? '确认生成 720° 全景图' : 'HDR / 720° 全景生成'}</h2>
            <p>{sourceName || '当前图片'}</p>
          </div>
          <button type="button" className="panorama-generation-modal__close" onClick={onCancel} disabled={busy} aria-label="关闭">
            <X size={17} />
          </button>
        </header>

        {step === 'settings' ? (
          <div className="panorama-generation-modal__body">
            <FieldLabel>补充描述（可选）</FieldLabel>
            <textarea
              value={settings.description}
              onChange={(event) => setSettings((current) => ({ ...current, description: event.target.value }))}
              placeholder="可选：描述画面外延续的场景、风格或灯光"
              rows={3}
              disabled={busy}
            />

            <div className="panorama-generation-modal__grid">
              <label>
                <FieldLabel>生成模型</FieldLabel>
                <select value={settings.model} onChange={(event) => updateModel(event.target.value as PanoramaModel)} disabled={busy}>
                  {PANORAMA_MODEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label>
                <FieldLabel>全景分辨率</FieldLabel>
                <select
                  value={settings.resolution}
                  onChange={(event) => setSettings((current) => ({ ...current, resolution: event.target.value as PanoramaResolution }))}
                  disabled={busy}
                >
                  {PANORAMA_RESOLUTION_OPTIONS.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
                </select>
              </label>
            </div>

            <FieldLabel>生成模式</FieldLabel>
            <div className="panorama-generation-modal__modes">
              {modeOptions.map((option) => {
                const active = settings.generationMode === option.value
                return (
                  <button
                    type="button"
                    key={option.value}
                    className={active ? 'is-active' : ''}
                    onClick={() => setSettings((current) => ({ ...current, generationMode: option.value }))}
                    disabled={busy}
                  >
                    <span>{option.label}</span>
                    <small>{option.summary}</small>
                    {active && <Check size={17} />}
                  </button>
                )
              })}
            </div>

            <div className="panorama-generation-modal__one-call">
              <Check size={15} />
              <span>当前主路线每次只调用 1 次公司 Gateway 图片 API</span>
            </div>

            <button
              type="button"
              className="panorama-generation-modal__primary"
              onClick={() => prepareConfirmation(settings.generationMode)}
              disabled={busy}
            >
              {panoramaGenerateButtonLabel(settings)}
              <span>›</span>
            </button>

            <button
              type="button"
              className="panorama-generation-modal__experiment"
              onClick={() => prepareConfirmation('erp-template-mask-experiment')}
              disabled={busy}
            >
              <span className="panorama-generation-modal__experiment-badge"><FlaskConical size={13} />实验</span>
              <span>
                <strong>ERP 模板生成 · {panoramaModelLabel(settings.model)}</strong>
                <small>第一阶段调用 1 次；接缝修复需再次确认</small>
              </span>
              <span>›</span>
            </button>
          </div>
        ) : (
          <div className="panorama-generation-modal__body">
            <div className="panorama-generation-modal__summary">
              <div><span>模型</span><strong>{panoramaModelLabel(settings.model)}</strong></div>
              <div><span>模式</span><strong>{panoramaModeLabel(settings.model, settings.generationMode)}</strong></div>
              <div><span>生成档位</span><strong>{settings.resolution}</strong></div>
              <div><span>输出全景</span><strong>2:1 ERP · 360°×180°</strong></div>
              <div><span>付费调用</span><strong>1 次图片 API</strong></div>
            </div>

            <div className="panorama-generation-modal__warning">
              <AlertTriangle size={17} />
              <span>{callout}</span>
            </div>

            {localError && <div className="panorama-generation-modal__error">{localError}</div>}

            <div className="panorama-generation-modal__actions">
              <button type="button" className="panorama-generation-modal__back" onClick={() => setStep('settings')} disabled={busy}>
                <ChevronLeft size={15} />返回修改
              </button>
              <button type="button" className="panorama-generation-modal__confirm" onClick={confirm} disabled={busy}>
                {busy && <Loader2 size={16} className="panorama-generation-modal__spin" />}
                {busy ? '正在提交' : '确认并生成'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
