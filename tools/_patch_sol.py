"""把后端写死的 gpt-5.5 统一换成 config.defaultChatModel（= codex/gpt-5.6-sol）。一次性脚本。"""
import io

def edit(path, reps):
    s = io.open(path, encoding='utf-8', newline='').read()
    for rep in reps:
        old, new = rep[0], rep[1]
        n = rep[2] if len(rep) > 2 else 1
        assert s.count(old) == n, (path, repr(old[:70]), s.count(old), n)
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('ok', path)


# ── config.js：一个真源 ──
edit('server/config.js', [
    (
        "  cindyAssistant: {\n"
        "    allowedUserIds: positiveIntegerList(process.env.CINDY_ASSISTANT_ALLOWED_USER_IDS, '1'),\n"
        "    model: String(process.env.CINDY_ASSISTANT_MODEL || 'gpt-5.5').trim(),",
        "  // 后端所有纯文本/对话调用的默认模型。2026-08-17 从 gpt-5.5 换成 GPT-5.6 Sol：\n"
        "  // 网关账号白名单里已经没有 gpt-5.5 了，写死它的地方会直接报\n"
        "  // \"user not allowed to access model\"。目录里没有裸的 gpt-5.6-sol，Sol 只有\n"
        "  // codex/ 这一条路由，而白名单里有 codex/*。要整体换模型只改这一行。\n"
        "  defaultChatModel: String(process.env.DEFAULT_CHAT_MODEL || 'codex/gpt-5.6-sol').trim(),\n"
        "  cindyAssistant: {\n"
        "    allowedUserIds: positiveIntegerList(process.env.CINDY_ASSISTANT_ALLOWED_USER_IDS, '1'),\n"
        "    model: String(process.env.CINDY_ASSISTANT_MODEL || process.env.DEFAULT_CHAT_MODEL || 'codex/gpt-5.6-sol').trim(),",
    ),
    (
        "    model: String(process.env.STUDIO_MODEL || process.env.CINDY_ASSISTANT_MODEL || 'gpt-5.5').trim(),",
        "    model: String(process.env.STUDIO_MODEL || process.env.CINDY_ASSISTANT_MODEL || process.env.DEFAULT_CHAT_MODEL || 'codex/gpt-5.6-sol').trim(),",
    ),
])

# ── canvasRoutes.js ──
edit('server/canvasRoutes.js', [
    # 文字节点的服务端兜底
    ("    const textModel = String(params.model || 'gpt-5.5');",
     "    const textModel = String(params.model || config.defaultChatModel);"),
    # 剧本节点
    ("    const textModel = String(params.textModel || params.llmModel || 'gpt-5.5');",
     "    const textModel = String(params.textModel || params.llmModel || config.defaultChatModel);"),
    # 画布内翻译
    ("  const translated = await chatComplete(messages, 'gpt-5.5', { performanceMode: 'standard' });",
     "  const translated = await chatComplete(messages, config.defaultChatModel, { performanceMode: 'standard' });"),
    # 两个 chatComplete 的默认形参
    ("async function chatComplete(messages, model = 'gpt-5.5', options = {}) {",
     "async function chatComplete(messages, model = config.defaultChatModel, options = {}) {"),
    ("async function chatCompleteWithSignal(messages, model = 'gpt-5.5', options = {}, signal) {",
     "async function chatCompleteWithSignal(messages, model = config.defaultChatModel, options = {}, signal) {"),
    # 按节点描述建文本节点时的默认参数
    ("                content: node?.data?.description || '',\n                model: 'gpt-5.5',",
     "                content: node?.data?.description || '',\n                model: config.defaultChatModel,"),
    # isGpt5Model 认不出 codex/ 前缀 —— 这会让 Sol 拿到 temperature 而拿不到 reasoning_effort，
    # 于是「高性能 / 深度思考」这一档对它静默失效。
    (
        "function isGpt5Model(model) {\n"
        "  return String(model || '').trim().toLowerCase().startsWith('gpt-5');\n"
        "}",
        "function isGpt5Model(model) {\n"
        "  // 同时认 codex/ 前缀：网关里 Sol 只有 codex/gpt-5.6-sol 这一条路由，\n"
        "  // 只按 startsWith('gpt-5') 判会把它当成非推理模型 —— 结果是给它发 temperature、\n"
        "  // 不发 reasoning_effort，「高性能 / 深度思考」对它静默失效。\n"
        "  const normalized = String(model || '').trim().toLowerCase().replace(/^codex\\//, '');\n"
        "  return normalized.startsWith('gpt-5');\n"
        "}",
    ),
])

# ── 服务与路由里的兜底 ──
edit('server/services/CindyAssistantService.js', [
    ("    model: config.cindyAssistant?.model || 'gpt-5.5',",
     "    model: config.cindyAssistant?.model || config.defaultChatModel,"),
])
edit('server/routes/cindyAssistantRoutes.js', [
    ("    model: enabled ? config.cindyAssistant?.model || 'gpt-5.5' : null,",
     "    model: enabled ? config.cindyAssistant?.model || config.defaultChatModel : null,"),
])
edit('server/services/StudioService.js', [
    ("    model: config.studio?.model || config.cindyAssistant?.model || 'gpt-5.5',",
     "    model: config.studio?.model || config.cindyAssistant?.model || config.defaultChatModel,"),
])
edit('server/services/PluginCanvasService.js', [
    # 这个文件原本没有引入 config，直接用 config.* 会是运行时 ReferenceError
    ("const crypto = require('crypto');\nconst imageRules = require('../../src/shared/image-model-rules.json');",
     "const crypto = require('crypto');\nconst config = require('../config');\nconst imageRules = require('../../src/shared/image-model-rules.json');"),
    ("      model: 'gpt-5.5',", "      model: config.defaultChatModel,"),
])

print('\n剩余的 gpt-5.5（应只剩前端注册表目录项）:')
import subprocess
