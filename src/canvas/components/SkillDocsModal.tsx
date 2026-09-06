import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clapperboard, Film, Image as ImageIcon, Lightbulb, Loader2, Palette, Sparkles, Video, X } from 'lucide-react'
import { cindyAssistantApi, type CindySkillDocs } from '@/lib/cindyAssistant'
import './SkillDocsModal.css'

type SkillTab = 'image' | 'video' | 'strategy' | 'film' | 'master' | 'aiStudio' | 'aiStudioConcept'

function requestError(error: unknown, fallback: string) {
  const responseError = (error as { response?: { data?: { error?: string } } })?.response?.data?.error
  return responseError || (error instanceof Error ? error.message : fallback)
}

export function SkillDocsModal({ onClose }: { onClose: () => void }) {
  const [docs, setDocs] = useState<CindySkillDocs | null>(null)
  const [tab, setTab] = useState<SkillTab>('image')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    cindyAssistantApi
      .skills()
      .then(result => {
        if (cancelled) return
        setDocs(result.skills)
      })
      .catch(err => {
        if (cancelled) return
        setError(requestError(err, '提示词规范加载失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const current = useMemo(() => (docs ? docs[tab] : null), [docs, tab])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="shotflow-skill-docs-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Cindy Skill"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="shotflow-skill-docs-modal">
        <header className="shotflow-skill-docs-header">
          <div className="shotflow-skill-docs-heading">
            <span className="shotflow-skill-docs-mark"><Sparkles size={19} strokeWidth={2.1} /></span>
            <div>
              <h2>Cindy Skill</h2>
              <p>Cindy 生成图片 / 视频提示词、规划工作流时遵循的规则与思路，以及 AI 出片各阶段的口径，都可在服务器 skill 文件中编辑。</p>
            </div>
          </div>
          <button type="button" className="shotflow-skill-docs-close" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="shotflow-skill-docs-tabs" role="tablist" aria-label="提示词类型">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'image'}
            className={`shotflow-skill-docs-tab${tab === 'image' ? ' is-active' : ''}`}
            onClick={() => setTab('image')}
          >
            <ImageIcon size={15} strokeWidth={2} />
            图片提示词
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'video'}
            className={`shotflow-skill-docs-tab${tab === 'video' ? ' is-active' : ''}`}
            onClick={() => setTab('video')}
          >
            <Video size={15} strokeWidth={2} />
            视频提示词
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'strategy'}
            className={`shotflow-skill-docs-tab${tab === 'strategy' ? ' is-active' : ''}`}
            onClick={() => setTab('strategy')}
          >
            <Lightbulb size={15} strokeWidth={2} />
            Cindy 思路
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'film'}
            className={`shotflow-skill-docs-tab${tab === 'film' ? ' is-active' : ''}`}
            onClick={() => setTab('film')}
          >
            <Clapperboard size={15} strokeWidth={2} />
            一键出片
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'master'}
            className={`shotflow-skill-docs-tab${tab === 'master' ? ' is-active' : ''}`}
            onClick={() => setTab('master')}
          >
            <Clapperboard size={15} strokeWidth={2} />
            电影大师
          </button>
          {/* 下面两个是 AI 出片页面用的 skill。它们不参与画布 Cindy 的对话，只是放在同一处
              可查可改 —— 否则改出片口径要去服务器上盲改文件，没有任何地方能核对当前生效的内容。 */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'aiStudio'}
            className={`shotflow-skill-docs-tab${tab === 'aiStudio' ? ' is-active' : ''}`}
            onClick={() => setTab('aiStudio')}
          >
            <Film size={15} strokeWidth={2} />
            AI 出片 · 分镜
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'aiStudioConcept'}
            className={`shotflow-skill-docs-tab${tab === 'aiStudioConcept' ? ' is-active' : ''}`}
            onClick={() => setTab('aiStudioConcept')}
          >
            <Palette size={15} strokeWidth={2} />
            AI 出片 · 概念图
          </button>
        </div>

        <div className="shotflow-skill-docs-body">
          {loading ? (
            <div className="shotflow-skill-docs-state"><Loader2 className="is-spinning" size={18} />正在加载...</div>
          ) : error ? (
            <div className="shotflow-skill-docs-state is-error">{error}</div>
          ) : current && current.content ? (
            <>
              <div className="shotflow-skill-docs-filename">server/skills/{current.name}</div>
              <pre className="shotflow-skill-docs-content">{current.content}</pre>
            </>
          ) : (
            <div className="shotflow-skill-docs-state">该 skill 文件为空或未找到。</div>
          )}
        </div>

        <footer className="shotflow-skill-docs-footer">
          只读查看。要修改，请编辑服务器上对应的 skill 文件，改动即时生效（下次对话读取），无需重启。
        </footer>
      </div>
    </div>,
    document.body
  )
}
