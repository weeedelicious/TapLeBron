import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Sparkles } from 'lucide-react'
import { useCanvasStore } from '@/store/canvasStore'
import type { CindyMode } from '@/lib/cindyAssistant'
import './CindyModeSelector.css'

const MODES: Array<{ value: CindyMode; label: string; desc: string }> = [
  { value: 'default', label: '默认模式', desc: 'Cindy 通用助手：按需求自由搭建节点工作流' },
  { value: 'film', label: '一键出片模式', desc: '按出片流水线：故事 → 文字分镜场次 → 线稿黑白分镜' },
  { value: 'master', label: '电影大师模式', desc: '以一键出片为基础的电影大师方法论（持续完善中）' },
]

// Top-left canvas control that selects the active Cindy Skill mode. Only shown
// when Cindy is enabled for the current account (written to the store by the
// Cindy assistant panel after its status fetch). The selected mode is read by
// the assistant panel and sent with each message so the backend injects the
// matching skill guidance.
//
// 2026-08-24：聊天和默认模式对所有人开放，film / master 仍按名单。只有默认模式可用时
// 这个选择器整个不显示 —— 一个点不动的下拉框比没有更让人困惑。可用模式来自 /status，
// 服务端还会再挡一层（越权的 mode 静默降级为默认），这里只管别显示不该显示的选项。
export function CindyModeSelector() {
  const enabled = useCanvasStore((s) => s.cindyEnabled)
  const mode = useCanvasStore((s) => s.cindyMode)
  const availableModes = useCanvasStore((s) => s.cindyModes)
  const setMode = useCanvasStore((s) => s.setCindyMode)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 这两个早退必须留在所有 hook 之后 —— 早退之上多一个 hook 就是 2026-08-18 那次画布黑屏
  if (!enabled) return null
  const modes = MODES.filter((m) => availableModes.includes(m.value))
  if (modes.length <= 1) return null
  const current = modes.find((m) => m.value === mode) ?? modes[0]

  return (
    <div className="cindy-mode-selector" ref={ref}>
      <button
        type="button"
        className="cindy-mode-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Cindy Skill 模式"
      >
        <Sparkles size={14} strokeWidth={1.6} />
        <span className="cindy-mode-selector-label">Cindy Skill</span>
        <span className="cindy-mode-selector-current">{current.label}</span>
        <ChevronDown size={13} strokeWidth={1.6} />
      </button>
      {open && (
        <div className="cindy-mode-menu" role="listbox" aria-label="Cindy Skill 模式">
          {modes.map((m) => (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={m.value === mode}
              className={`cindy-mode-option${m.value === mode ? ' is-active' : ''}`}
              onClick={() => {
                setMode(m.value)
                setOpen(false)
              }}
            >
              <div className="cindy-mode-option-head">
                <span>{m.label}</span>
                {m.value === mode && <Check size={14} strokeWidth={2.6} />}
              </div>
              <div className="cindy-mode-option-desc">{m.desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
