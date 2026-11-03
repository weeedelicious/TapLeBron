function errorRecordText(record: Record<string, unknown>) {
  for (const key of ['message', 'detail', 'error_description', 'reason']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  const nestedError = record.error
  if (typeof nestedError === 'string' && nestedError.trim()) return nestedError.trim()
  if (nestedError && typeof nestedError === 'object') {
    const nested = errorToText(nestedError, '')
    if (nested.trim()) return nested
  }

  try {
    const json = JSON.stringify(record)
    return json === '{}' ? '' : json
  } catch {
    return ''
  }
}

function sanitizeDisplayedError(text: string) {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return compact
  if (/cuda out of memory|out of memory|outofmemoryerror/i.test(compact)) {
    return '显存不足，当前增强倍数太大。请改用 2 倍，或改用 NVIDIA VSR。'
  }
  return compact.length > 280 ? compact.slice(0, 277) + '…' : compact
}

export function errorToText(error: unknown, fallback = '生成失败') {
  if (error instanceof Error) return sanitizeDisplayedError(error.message || fallback)
  if (typeof error === 'string') {
    const text = error.trim()
    return text && text !== '[object Object]' ? sanitizeDisplayedError(text) : fallback
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const response = record.response as Record<string, unknown> | undefined
    const responseData = response?.data

    if (responseData && typeof responseData === 'object') {
      const responseText = errorRecordText(responseData as Record<string, unknown>)
      if (responseText) return sanitizeDisplayedError(responseText)
    }
    if (typeof responseData === 'string' && responseData.trim()) return sanitizeDisplayedError(responseData)

    const code = record.code
    const message = errorRecordText(record)
    if (message) {
      const combined = typeof code === 'string' && code.trim()
        ? `${code}: ${message}`
        : message
      return sanitizeDisplayedError(combined)
    }
  }

  if (error == null) return fallback
  const text = String(error)
  return text && text !== '[object Object]' ? sanitizeDisplayedError(text) : fallback
}
