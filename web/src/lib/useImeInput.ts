import { useRef, useCallback, useState } from 'react'

/**
 * IME-safe controlled textarea.
 * During composition (pinyin input), state updates are deferred to avoid
 * React replacing the intermediate composition string.
 */
export function useImeInput(externalValue: string, onChange: (val: string) => void) {
  const [localValue, setLocalValue] = useState(externalValue)
  const composing = useRef(false)

  // Keep local in sync when external changes (e.g. undo, reset)
  // but don't override while the user is actively composing
  const syncedValue = composing.current ? localValue : externalValue

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    setLocalValue(e.target.value)
    if (!composing.current) onChange(e.target.value)
  }, [onChange])

  const handleCompositionStart = useCallback(() => {
    composing.current = true
  }, [])

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    composing.current = false
    const val = (e.currentTarget as HTMLTextAreaElement).value
    setLocalValue(val)
    onChange(val)
  }, [onChange])

  return {
    value: syncedValue,
    onChange: handleChange,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
  }
}
