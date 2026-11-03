from pathlib import Path
text = Path(r'C:/Users/wuyixiang/Documents/TapLeBron/server/services/PromptWashService.js').read_text(encoding='utf-8')
start = text.find('function extractSourceDuration')
end = text.find('function resolveTarget')
print(text[start:end].encode('unicode_escape').decode())
