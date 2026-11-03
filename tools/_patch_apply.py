from pathlib import Path
p = Path(r"C:/Users/wuyixiang/Documents/TapLeBron/src/canvas/components/nodes/VideoNode.tsx")
text = p.read_text(encoding="utf-8")
old = "  const draftTaskId = String((data._assetGenerationMeta?.[videoUrl || ''] as AssetGenerationMeta | undefined)?.draftTaskId || '')\n"
new = """  const draftMeta = data._assetGenerationMeta || {}
  const draftTaskId = String((draftMeta[videoUrl || ''] as AssetGenerationMeta | undefined)?.draftTaskId || Object.values(draftMeta).map((item) => (item as AssetGenerationMeta | undefined)?.draftTaskId).find(Boolean) || '')
"""
if text.count(old) != 1:
    raise SystemExit(text.count(old))
text = text.replace(old, new, 1)
hint_old = """                {draftTaskId && (
                  <button type="button" className="w-full text-sm py-2 rounded nodrag"
"""
hint_new = """                <div className="text-xs" style={{ color: '#8a7aaa', marginTop: 8 }}>
                  {draftTaskId ? '\u6837\u7247\u5df2\u597d\uff0c\u70b9\u4e0b\u9762\u51fa 1080P \u6210\u7247' : '\u6837\u7247\u5b8c\u6210\u540e\uff0c\u8fd9\u91cc\u4f1a\u51fa\u73b0 1080P \u6210\u7247\u6309\u94ae'}
                </div>
                {draftTaskId && (
                  <button type="button" className="w-full text-sm py-2 rounded nodrag"
"""
if text.count(hint_old) != 1:
    raise SystemExit('hint %s' % text.count(hint_old))
text = text.replace(hint_old, hint_new, 1)
p.write_text(text, encoding="utf-8")
print("ui ok")
