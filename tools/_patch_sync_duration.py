from pathlib import Path
p = Path(r'C:/Users/wuyixiang/Documents/TapLeBron/src/canvas/components/nodes/VideoNode.tsx')
t = p.read_text(encoding='utf-8')
old_imp = "import { textPromptFromRefs } from '@/lib/textPrompt'"
new_imp = old_imp + "\nimport { extractPromptDurationSeconds } from '@/lib/promptDuration'"
assert t.count(old_imp)==1
t = t.replace(old_imp, new_imp, 1)
old = '''  const handleSyncTextPrompt = useCallback(() => {
    const text = textPromptFromRefs((params.textList as NodeRef[] | undefined)?.filter(r => r.nodeId), useCanvasStore.getState().nodes)
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    editorRef.current?.setPlainText(text)
    updateNodeData(id, {
      params: {
        ...currentParams,
        prompt: text,
        promptChips: [],
        promptHtml: undefined,
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, updateNodeData])'''
new = '''  const handleSyncTextPrompt = useCallback(() => {
    const text = textPromptFromRefs((params.textList as NodeRef[] | undefined)?.filter(r => r.nodeId), useCanvasStore.getState().nodes)
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const durationRule = getVideoDurationRule(String(currentParams.model || ''), currentParams.modeType)
    const durationLocked = durationRule.min === durationRule.max && durationRule.default === durationRule.min && durationRule.min < 0
    const promptSeconds = extractPromptDurationSeconds(text)
    const settings = !durationLocked && promptSeconds != null
      ? { ...currentParams.settings, duration: normalizeVideoDurationValue(String(currentParams.model || ''), promptSeconds, currentParams.modeType) }
      : currentParams.settings
    editorRef.current?.setPlainText(text)
    updateNodeData(id, {
      params: {
        ...currentParams,
        prompt: text,
        promptChips: [],
        promptHtml: undefined,
        settings,
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, updateNodeData])'''
print('handler', t.count(old))
assert t.count(old)==1
t = t.replace(old, new, 1)
old_title = "title={upstreamTextPrompt ? '同步上游文本节点内容' : '上游文本节点暂无内容'}"
new_title = "title={upstreamTextPrompt ? '同步上游文本，并按提示词里的秒数设置时长' : '上游文本节点暂无内容'}"
print('title', t.count(old_title))
assert t.count(old_title)==1
t = t.replace(old_title, new_title, 1)
p.write_text(t, encoding='utf-8')
print('node ok')