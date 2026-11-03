from pathlib import Path
p = Path(r"C:/Users/wuyixiang/Documents/TapLeBron/tools/_backfill_draft.js")
text = p.read_text(encoding="utf-8")
text = text.replace("server/CanvasMutationQueue", "server/services/CanvasMutationQueue")
p.write_text(text, encoding="utf-8")
print("ok", "services/CanvasMutationQueue" in text)
