from pathlib import Path
p = Path(r"C:/Users/wuyixiang/Documents/TapLeBron/src/canvas/components/nodes/VideoNode.tsx")
text = p.read_text(encoding="utf-8")
old = "  const draftMeta = data._assetGenerationMeta || {}\n  const draftTaskId = String((draftMeta[videoUrl || ''] as AssetGenerationMeta | undefined)?.draftTaskId || Object.values(draftMeta).map((item) => (item as AssetGenerationMeta | undefined)?.draftTaskId).find(Boolean) || '')\n"
new = """  const draftMeta = data._assetGenerationMeta || {}
  const directDraftTaskId = videoUrl ? (draftMeta[videoUrl] as AssetGenerationMeta | undefined)?.draftTaskId : ''
  const matchedDraftTaskId = directDraftTaskId || Object.entries(draftMeta).find(([key, item]) => {
    const clean = (value: string) => value.split('#')[0].split('?')[0]
    return Boolean(videoUrl) && clean(key) === clean(videoUrl || '') && (item as AssetGenerationMeta | undefined)?.draftTaskId
  })?.[1]?.draftTaskId
  const draftTaskId = String(matchedDraftTaskId || '')
"""
if text.count(old) != 1:
    raise SystemExit('lookup %s' % text.count(old))
text = text.replace(old, new, 1)
old_hint = "\u6837\u7247\u5b8c\u6210\u540e\uff0c\u8fd9\u91cc\u4f1a\u51fa\u73b0 1080P \u6210\u7247\u6309\u94ae"
new_hint = "\u8bf7\u5148\u628a\u8981\u8f6c\u6210\u7247\u7684\u90a3\u6761 480P \u6837\u7247\u8bbe\u4e3a\u4e3b\u89c6\u9891"
if text.count(old_hint) != 1:
    raise SystemExit('hint %s' % text.count(old_hint))
text = text.replace(old_hint, new_hint, 1)
p.write_text(text, encoding="utf-8")
print("source ok")
