type AppearanceReferenceExperimentDialogProps = {
  open: boolean
  submitting?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function AppearanceReferenceExperimentDialog({
  open,
  submitting = false,
  onCancel,
  onConfirm,
}: AppearanceReferenceExperimentDialogProps) {
  if (!open) return null
  return (
    <div className="appearance-reference-experiment__backdrop">
      <section
        className="appearance-reference-experiment"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appearance-reference-experiment-title"
      >
        <header>
          <div>
            <span>实验模式 · 仅本次生成</span>
            <h3 id="appearance-reference-experiment-title">附加参考图增强氛围</h3>
          </div>
          <button
            type="button"
            aria-label="取消实验生成"
            disabled={submitting}
            onClick={onCancel}
          >
            ×
          </button>
        </header>
        <p>
          标准模式只把结构化光说明书交给模型。实验模式会额外附加参考图，
          有机会增强复杂光感，但参考图内容可能泄漏，人物、背景或构图也可能漂移。
        </p>
        <ul>
          <li>原图/确定性色彩底图仍是唯一内容与构图来源。</li>
          <li>参考图只作为第二张“灯光证据图”，结果会单独标记为实验。</li>
          <li>质量检查只提示风险；生成结果仍会保留并允许输出。</li>
        </ul>
        <footer>
          <button
            type="button"
            className="appearance-transfer__secondary"
            disabled={submitting}
            onClick={onCancel}
          >
            取消，使用标准模式
          </button>
          <button
            type="button"
            className="appearance-transfer__generate"
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? '正在提交…' : '确认并生成实验预览'}
          </button>
        </footer>
      </section>
    </div>
  )
}
