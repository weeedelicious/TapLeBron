"""删掉画布管理页的「画布预览」悬浮浮层（用户要求不要了）。一次性脚本。

顺带把 handleOpenCanvas 那个假预取改成只传画布名：
App.tsx 里 `void prefetchedProject` 已经明确把它丢掉了，画布始终重新 get，
它唯一的实际用途是让打开中的加载页显示画布名。所以只需要名字。
"""
import io
import re

P = 'src/canvas/components/ProjectList.tsx'
s = io.open(P, encoding='utf-8', newline='').read()
NL = '\r\n' if '\r\n' in s else '\n'


def cut_between(start_marker, end_marker, keep_end=True):
    """删掉 start_marker 起、end_marker 前的所有内容。两个标记都必须唯一。"""
    global s
    start_marker = start_marker.replace('\n', NL)
    end_marker = end_marker.replace('\n', NL)
    assert s.count(start_marker) == 1, ('start not unique', start_marker[:60], s.count(start_marker))
    assert s.count(end_marker) == 1, ('end not unique', end_marker[:60], s.count(end_marker))
    a = s.index(start_marker)
    b = s.index(end_marker)
    assert a < b, ('order', start_marker[:40], end_marker[:40])
    s = s[:a] + (end_marker if keep_end else '') + s[b + len(end_marker):]


def rep(old, new, n=1):
    global s
    old = old.replace('\n', NL)
    new = new.replace('\n', NL)
    assert s.count(old) == n, (repr(old[:70]), s.count(old), n)
    s = s.replace(old, new)


def sub(pattern, new, expected):
    global s
    s, count = re.subn(pattern, new, s)
    assert count == expected, (pattern[:50], count, expected)


# ── 1. 类型与常量 ──
cut_between('interface PreviewCacheEntry {', 'const COLLECTION_COLLAPSE_STORAGE_KEY')

# ── 2. 只给预览用的图计算：fallbackNodeData / parseNodeData / nodeDefaultSize /
#       nodeMeasuredSize / projectPreviewGraph。
#       PreviewVideoFrame 与 isVideoCoverUrl / coverVideoSrc 是卡片封面在用的，留着。 ──
cut_between('function fallbackNodeData(node: CanvasNode): CanvasNodeData {',
            'function PreviewVideoFrame({ url }: { url: string }) {')

# ── 3. 浮层三个组件 ──
cut_between('function SharedProjectPreview({ entry }: { entry?: PreviewCacheEntry }) {',
            'export function ProjectList({ onOpen, onOpenStudio, user, onLogout }: Props) {')

# ── 4. 缓存状态与同步 ref 的 effect ──
rep(
    "  const [previewCache, setPreviewCache] = useState<Record<string, PreviewCacheEntry>>({})\n"
    "  const previewCacheRef = useRef<Record<string, PreviewCacheEntry>>({})\n"
    "  const previewRequestsRef = useRef<Record<string, Promise<Project | null>>>({})\n",
    '',
)
rep(
    "  useEffect(() => {\n"
    "    previewCacheRef.current = previewCache\n"
    "  }, [previewCache])\n"
    "\n",
    '',
)

# ── 5. 取预览的请求 ──
cut_between('  const ensurePreview = useCallback((uuid: string): Promise<Project | null> => {',
            '  const handleOpenCanvas = useCallback(')

# ── 6. handleOpenCanvas：改成只传画布名 ──
rep(
    "  const handleOpenCanvas = useCallback(async (uuid: string) => {\n"
    "    if (openingUuid || workingUuid) return\n"
    "    setMenu(null)\n"
    "    setOpeningUuid(uuid)\n"
    "    try {\n"
    "      const prefetchedProject = previewCacheRef.current[uuid]?.project ?? previewRequestsRef.current[uuid] ?? null\n"
    "      await onOpen(uuid, prefetchedProject)",

    "  // name 只用来让「正在打开…」那屏显示画布名（CanvasOpeningScreen）。\n"
    "  // 以前这里传的是预览缓存里那份完整画布，但 App.tsx 收到后是 `void prefetchedProject`\n"
    "  // 直接丢掉、始终重新 projectsApi.get(uuid) —— 那个参数从来没真的省过一次请求，\n"
    "  // 唯一实际作用就是取里面的名字。预览功能删掉后就直接把名字传过去。\n"
    "  const handleOpenCanvas = useCallback(async (uuid: string, name?: string) => {\n"
    "    if (openingUuid || workingUuid) return\n"
    "    setMenu(null)\n"
    "    setOpeningUuid(uuid)\n"
    "    try {\n"
    "      await onOpen(uuid, name)",
)

# ── 7. 五张卡片上的三个预览属性 ──
sub(r'[ \t]*showPreview' + NL, '', 5)
sub(r'[ \t]*previewEntry=\{previewCache\[canvas\.uuid\]\}' + NL, '', 5)
sub(r'[ \t]*onHoverPreview=\{\(\) => \{' + NL + r'[ \t]*void ensurePreview\(canvas\.uuid\)' + NL + r'[ \t]*\}\}' + NL, '', 5)
# 打开时把名字一起带上。只有 2 处 —— 另外三张卡（模板 / 共享 / 个人共享）的主操作是
# handleDuplicate（复制到我的画布），不是打开。
sub(r'void handleOpenCanvas\(canvas\.uuid\)', 'void handleOpenCanvas(canvas.uuid, canvas.name)', 2)

# ── 8. ProjectCard 的属性与浮层本体 ──
rep(
    "  primaryMode,\n"
    "  showPreview,\n"
    "  previewEntry,\n"
    "  onHoverPreview,\n"
    "  isBusy,",

    "  primaryMode,\n"
    "  isBusy,",
)
rep(
    "  primaryMode: 'open' | 'duplicate'\n"
    "  showPreview?: boolean\n"
    "  previewEntry?: PreviewCacheEntry\n"
    "  onHoverPreview?: () => void\n"
    "  isBusy?: boolean",

    "  primaryMode: 'open' | 'duplicate'\n"
    "  isBusy?: boolean",
)
rep(
    "      onMouseEnter={() => {\n"
    "        setHovered(true)\n"
    "        onHoverPreview?.()\n"
    "      }}",

    "      onMouseEnter={() => setHovered(true)}",
)
rep(
    "      {hovered && showPreview && !isDragging ? (\n"
    "        <div\n"
    "          className=\"shotflow-project-preview-popover\"\n"
    "          style={{\n"
    "            position: 'absolute',\n"
    "            top: 'calc(100% + 14px)',\n"
    "            left: '50%',\n"
    "            transform: 'translateX(-50%)',\n"
    "            zIndex: 20,\n"
    "            pointerEvents: 'auto',\n"
    "          }}\n"
    "          onClick={(e) => e.stopPropagation()}\n"
    "        >\n"
    "          <SharedProjectPreview entry={previewEntry} />\n"
    "        </div>\n"
    "      ) : null}\n"
    "\n",
    '',
)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('ProjectList.tsx 已删除画布预览')
print('残留检查：', [k for k in
                 ('PreviewCacheEntry', 'previewCache', 'ensurePreview', 'SharedProjectPreview',
                  'showPreview', 'onHoverPreview', 'projectPreviewGraph', 'preview-popover')
                 if k in s] or '干净')
