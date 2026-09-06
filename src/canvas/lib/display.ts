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

export function errorToText(error: unknown, fallback = '生成失败') {
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'string') {
    const text = error.trim()
    return text && text !== '[object Object]' ? text : fallback
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const response = record.response as Record<string, unknown> | undefined
    const responseData = response?.data

    if (responseData && typeof responseData === 'object') {
      const responseText = errorRecordText(responseData as Record<string, unknown>)
      if (responseText) return responseText
    }
    if (typeof responseData === 'string' && responseData.trim()) return responseData

    const code = record.code
    const message = errorRecordText(record)
    if (message) {
      return typeof code === 'string' && code.trim()
        ? `${code}: ${message}`
        : message
    }
  }

  if (error == null) return fallback
  const text = String(error)
  return text && text !== '[object Object]' ? text : fallback
}
