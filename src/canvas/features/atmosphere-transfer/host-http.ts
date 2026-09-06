// Minimal apiFetch shim for the ported appearance-transfer modules.
// Matches the source `shared/api/http` contract: apiFetch<T>(url, init?) → Promise<T>.
// Uses cookie-session auth (credentials: 'include') like the rest of the app.
// Only exercised by the lighting descriptor / quality / matting paths (Phase B+);
// the Phase A color processor does not call it.
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) }
  const hasBody = init?.body != null
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData
  if (hasBody && !isForm && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json'
  }
  const response = await fetch(url, { credentials: 'include', ...init, headers })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    let message = `请求失败 (${response.status})`
    try {
      const parsed = text ? JSON.parse(text) : null
      if (parsed && typeof parsed.error === 'string') message = parsed.error
    } catch {
      if (text) message = text.slice(0, 200)
    }
    const error = new Error(message) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return (text ? JSON.parse(text) : null) as T
}
