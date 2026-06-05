import { useRef, useCallback, useState, useEffect } from 'react'

/**
 * IME-safe textarea hook that:
 * - Uses local state as display value to prevent cursor-jump on zustand updates
 * - Defers onChange during CJK composition to avoid React replacing pinyin
 * - Syncs external value (undo/reset) only when textarea is not focused
 */
export function useImeInput(externalValue: string, onChange: (val: string) => void) {
  const [localValue, setLocalValue] = useState(externalValue)
  const composing = useRef(false)
  const focused = useRef(false)

  // Sync from external only when not focused (e.g. Ctrl+Z canvas undo, translate)
  useEffect(() => {
    if (!focused.current) setLocalValue(externalValue)
  }, [externalValue])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const val = e.target.value
    setLocalValue(val)
    if (!composing.current) onChange(val)
  }, [onChange])

  const handleCompositionStart = useCallback(() => { composing.current = true }, [])

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    composing.current = false
    const val = (e.currentTarget as HTMLTextAreaElement).value
    setLocalValue(val)
    onChange(val)
  }, [onChange])

  const handleFocus = useCallback(() => { focused.current = true }, [])
  const handleBlur = useCallback(() => {
    focused.current = false
    // Flush any pending value on blur
    if (localValue !== externalValue) onChange(localValue)
  }, [localValue, externalValue, onChange])

  return {
    value: localValue,
    onChange: handleChange,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
    onFocus: handleFocus,
    onBlur: handleBlur,
  }
}
