import { useState } from 'react'
import { accountApi } from '@/lib/api'

const API_KEY_CREATE_URL = 'https://console.tapsvc.com/nova/#/ai-gateway?tab=keys'

function requestError(error: unknown, fallback: string) {
  const responseError = (error as { response?: { data?: { error?: string } } })?.response?.data?.error
  return responseError || (error instanceof Error ? error.message : fallback)
}

export function ReplaceApiKeyDialog({
  onClose,
  onSaved,
  dismissible = true,
}: {
  onClose: () => void
  onSaved?: () => void
  dismissible?: boolean
}) {
  const [apiKey, setApiKey] = useState('')
  const [confirmKey, setConfirmKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const nextKey = apiKey.trim()
    if (nextKey.length < 12 || nextKey.length > 512) {
      setError('请填写有效的 API Key')
      return
    }
    if (nextKey !== confirmKey.trim()) {
      setError('两次填写的 API Key 不一致')
      return
    }
    if (saving) return
    setSaving(true)
    setError('')
    try {
      await accountApi.replaceApiKey(nextKey)
      onSaved?.()
      onClose()
    } catch (err) {
      setError(requestError(err, '保存失败，请稍后重试'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="shotflow-assigned-dialog-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5, 4, 10, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 10000,
      }}
      onClick={dismissible ? onClose : undefined}
    >
      <form
        className="shotflow-assigned-dialog"
        style={{
          width: 'min(440px, calc(100vw - 32px))',
          borderRadius: 16,
          border: '1px solid #2b2440',
          background: '#14111d',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div style={{ padding: '18px 20px 12px' }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#f2edff' }}>设置/替换 API Key</div>
          <div style={{ marginTop: 6, fontSize: 13, color: '#8c84a6', lineHeight: 1.5 }}>
            只改当前账号自己的网关 Key，不影响别人。旧 Key 不会显示。
          </div>
        </div>

        <div style={{ padding: '0 20px 20px', display: 'grid', gap: 14 }}>
          <label style={{ display: 'grid', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#cfc4f5' }}>新 API Key</span>
            <input
              className="shotflow-new-canvas-name"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              type="password"
              autoComplete="off"
              autoFocus
              placeholder="必填，用于出图和生成"
              style={{
                height: 36,
                padding: '0 10px',
                borderRadius: 9,
                border: '1px solid #2b2440',
                background: '#171322',
                color: '#f2edff',
                fontSize: 14,
                outline: 'none',
              }}
            />
          </label>
          <label style={{ display: 'grid', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#cfc4f5' }}>再填一次</span>
            <input
              className="shotflow-new-canvas-name"
              value={confirmKey}
              onChange={(event) => setConfirmKey(event.currentTarget.value)}
              type="password"
              autoComplete="off"
              placeholder="确认新的 API Key"
              style={{
                height: 36,
                padding: '0 10px',
                borderRadius: 9,
                border: '1px solid #2b2440',
                background: '#171322',
                color: '#f2edff',
                fontSize: 14,
                outline: 'none',
              }}
            />
          </label>
          <a
            href={API_KEY_CREATE_URL}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 13, color: '#a78bfa', textDecoration: 'underline', width: 'fit-content' }}
          >
            去创建 API Key
          </a>
          {error ? <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div> : null}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 20px 18px',
            borderTop: '1px solid #211a31',
            background: '#120f1a',
          }}
        >
          {dismissible ? (
            <button
              type="button"
              onClick={onClose}
              style={{
                height: 38,
                padding: '0 16px',
                borderRadius: 10,
                border: '1px solid #312550',
                background: '#181426',
                color: '#d3caf1',
                cursor: 'pointer',
              }}
            >
              取消
            </button>
          ) : null}
          <button
            type="submit"
            disabled={saving}
            style={{
              height: 38,
              padding: '0 16px',
              borderRadius: 10,
              border: '1px solid #7c5cfc',
              background: saving ? '#312550' : '#7c5cfc',
              color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? '保存中' : '保存'}
          </button>
        </div>
      </form>
    </div>
  )
}
