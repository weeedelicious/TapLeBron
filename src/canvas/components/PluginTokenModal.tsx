import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, KeyRound, Loader2, PlugZap, ShieldCheck, Trash2, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { pluginTokensApi, type PluginTokenRecord } from '@/lib/api'
import './PluginTokenModal.css'

function dateText(value: string | null) {
  if (!value) return '尚未使用'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function requestError(error: unknown, fallback: string) {
  const responseError = (error as { response?: { data?: { error?: string } } })?.response?.data?.error
  return responseError || (error instanceof Error ? error.message : fallback)
}

export function PluginTokenModal({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<PluginTokenRecord[]>([])
  const [name, setName] = useState('Cindy Shotflow')
  const [access, setAccess] = useState<'read' | 'write'>('write')
  const [expiresInDays, setExpiresInDays] = useState(180)
  const [createdToken, setCreatedToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState('')
  const [error, setError] = useState('')

  const loadTokens = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await pluginTokensApi.list()
      setTokens(Array.isArray(result.tokens) ? result.tokens : [])
    } catch (err) {
      setError(requestError(err, '连接令牌加载失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTokens()
  }, [loadTokens])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const createToken = async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    setCreatedToken('')
    setCopied(false)
    setError('')
    try {
      const result = await pluginTokensApi.create({
        name: name.trim(),
        scopes: access === 'write' ? ['read', 'canvas:write'] : ['read'],
        expiresInDays,
      })
      setCreatedToken(result.token)
      setTokens(current => [result.record, ...current.filter(token => token.id !== result.record.id)])
    } catch (err) {
      setError(requestError(err, '创建连接令牌失败'))
    } finally {
      setCreating(false)
    }
  }

  const copyToken = async () => {
    if (!createdToken) return
    try {
      await navigator.clipboard.writeText(createdToken)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('系统未允许自动复制，请手动选择令牌文本。')
    }
  }

  const revokeToken = async (token: PluginTokenRecord) => {
    if (revokingId || !window.confirm(`确认撤销“${token.name}”连接令牌？撤销后 Cindy 将立即无法访问。`)) return
    setRevokingId(token.id)
    setError('')
    try {
      await pluginTokensApi.revoke(token.id)
      setTokens(current => current.filter(item => item.id !== token.id))
    } catch (err) {
      setError(requestError(err, '撤销连接令牌失败'))
    } finally {
      setRevokingId('')
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="shotflow-plugin-token-overlay" role="dialog" aria-modal="true" aria-label="Cindy 插件连接">
      <div className="shotflow-plugin-token-modal">
        <header className="shotflow-plugin-token-header">
          <div className="shotflow-plugin-token-heading">
            <span className="shotflow-plugin-token-mark"><PlugZap size={20} strokeWidth={2.1} /></span>
            <div>
              <h2>Cindy 插件连接</h2>
              <p>为当前 Shotflow 账号签发独立、可撤销的访问令牌。</p>
            </div>
          </div>
          <button type="button" className="shotflow-plugin-token-close" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="shotflow-plugin-token-body">
          <section className="shotflow-plugin-token-guide">
            <span>连接步骤</span>
            <p>创建令牌后，将它粘贴到 Cindy 的「插件 → Shotflow → Shotflow API Token」。令牌只显示一次，Shotflow 不保存明文。</p>
          </section>

          <section className="shotflow-plugin-token-create">
            <div className="shotflow-plugin-token-section-title">
              <KeyRound size={16} />
              <strong>新建连接令牌</strong>
            </div>
            <div className="shotflow-plugin-token-form-grid">
              <label>
                <span>设备名称</span>
                <input value={name} maxLength={80} onChange={event => setName(event.target.value)} />
              </label>
              <label>
                <span>有效期</span>
                <select value={expiresInDays} onChange={event => setExpiresInDays(Number(event.target.value))}>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                  <option value={180}>180 天</option>
                  <option value={365}>365 天</option>
                </select>
              </label>
            </div>
            <div className="shotflow-plugin-token-access" role="group" aria-label="令牌权限">
              <button type="button" className={access === 'write' ? 'is-active' : ''} onClick={() => setAccess('write')}>
                <ShieldCheck size={15} />
                <span><strong>画布协作</strong><small>读取、创建和编辑节点与连线</small></span>
                {access === 'write' && <Check size={15} />}
              </button>
              <button type="button" className={access === 'read' ? 'is-active' : ''} onClick={() => setAccess('read')}>
                <KeyRound size={15} />
                <span><strong>仅查看</strong><small>只读取项目与画布，不做修改</small></span>
                {access === 'read' && <Check size={15} />}
              </button>
            </div>
            <button
              type="button"
              className="shotflow-plugin-token-create-button"
              disabled={!name.trim() || creating}
              onClick={() => { void createToken() }}
            >
              {creating ? <Loader2 className="is-spinning" size={16} /> : <KeyRound size={16} />}
              {creating ? '正在创建...' : '创建连接令牌'}
            </button>
          </section>

          {createdToken && (
            <section className="shotflow-plugin-token-reveal">
              <div>
                <strong>立即复制，此令牌关闭后不再显示</strong>
                <span>如遗失，请撤销并重新创建。</span>
              </div>
              <div className="shotflow-plugin-token-value-row">
                <input readOnly value={createdToken} onFocus={event => event.currentTarget.select()} />
                <button type="button" onClick={() => { void copyToken() }}>
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
            </section>
          )}

          {error && <div className="shotflow-plugin-token-error">{error}</div>}

          <section className="shotflow-plugin-token-list-section">
            <div className="shotflow-plugin-token-section-title">
              <ShieldCheck size={16} />
              <strong>有效连接</strong>
              <span>{tokens.length}</span>
            </div>
            <div className="shotflow-plugin-token-list">
              {loading ? (
                <div className="shotflow-plugin-token-empty"><Loader2 className="is-spinning" size={17} />正在加载...</div>
              ) : tokens.length === 0 ? (
                <div className="shotflow-plugin-token-empty">当前没有有效的 Cindy 连接令牌</div>
              ) : tokens.map(token => (
                <article key={token.id} className="shotflow-plugin-token-item">
                  <div className="shotflow-plugin-token-item-main">
                    <div><strong>{token.name}</strong><code>{token.prefix}••••</code></div>
                    <p>
                      {token.scopes.includes('canvas:write') ? '画布协作' : '仅查看'}
                      <span>到期 {dateText(token.expiresAt)}</span>
                      <span>最近使用 {dateText(token.lastUsedAt)}</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    className="shotflow-plugin-token-revoke"
                    disabled={Boolean(revokingId)}
                    onClick={() => { void revokeToken(token) }}
                  >
                    {revokingId === token.id ? <Loader2 className="is-spinning" size={15} /> : <Trash2 size={15} />}
                    撤销
                  </button>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body
  )
}
