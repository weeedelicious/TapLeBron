import type { ReactNode } from 'react'

interface ShortcutItem {
  label: string
  keys: string[]
}

interface ShortcutGroup {
  title: string
  items: ShortcutItem[]
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '创作',
    items: [
      { label: '成组', keys: ['Ctrl/Alt', 'G'] },
      { label: '合并分镜组', keys: ['Ctrl', 'Alt', 'G'] },
      { label: '解组', keys: ['Ctrl/Alt', 'Shift', 'G'] },
      { label: '连线', keys: ['Ctrl', 'L'] },
      { label: '复制节点和连线', keys: ['Ctrl', 'D'] },
      { label: '生成', keys: ['Ctrl', 'Enter'] },
      { label: '新建节点', keys: ['Tab'] },
      { label: '节点复制', keys: ['Alt', '拖动节点'] },
      { label: '创建副本', keys: ['Ctrl', 'Alt', '拖动'] },
    ],
  },
  {
    title: '缩放',
    items: [
      { label: '放大', keys: ['Ctrl', '+'] },
      { label: '缩小', keys: ['Ctrl', '-'] },
      { label: '适应画布', keys: ['Ctrl', '0'] },
      { label: '选中流程三段取景', keys: ['F'] },
      { label: '触控板缩放', keys: ['双指'] },
      { label: '鼠标缩放', keys: ['滚轮'] },
      { label: '文字大小', keys: ['左下滑条'] },
    ],
  },
  {
    title: '移动画布',
    items: [
      { label: '平移画布', keys: ['Space', '拖动'] },
      { label: '鼠标平移', keys: ['中键拖动'] },
      { label: '滚动移动', keys: ['滚轮'] },
      { label: '整理画布', keys: ['Alt', 'Shift', 'F'] },
    ],
  },
  {
    title: '其他',
    items: [
      { label: '撤销', keys: ['Ctrl', 'Z'] },
      { label: '删除选中、解组', keys: ['Delete'] },
      { label: '复制文本', keys: ['Ctrl', 'C'] },
      { label: '关闭面板', keys: ['Esc'] },
    ],
  },
]

function ShortcutKey({ children }: { children: ReactNode }) {
  return <span className="canvas-shortcut-key">{children}</span>
}

function ShortcutChord({ keys }: { keys: string[] }) {
  return (
    <span className="canvas-shortcut-chord">
      {keys.map((key, index) => (
        <span key={`${key}-${index}`} className="canvas-shortcut-chord-part">
          {index > 0 && <span className="canvas-shortcut-plus">+</span>}
          <ShortcutKey>{key}</ShortcutKey>
        </span>
      ))}
    </span>
  )
}

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="canvas-shortcuts-panel" role="dialog" aria-label="快捷键">
      <button
        type="button"
        className="canvas-shortcuts-close"
        title="关闭"
        aria-label="关闭"
        onClick={onClose}
      >
        ×
      </button>
      <div className="canvas-shortcuts-grid">
        {SHORTCUT_GROUPS.map(group => (
          <section key={group.title} className="canvas-shortcut-group">
            <h3>{group.title}</h3>
            <div className="canvas-shortcut-list">
              {group.items.map(item => (
                <div key={`${group.title}-${item.label}`} className="canvas-shortcut-row">
                  <span className="canvas-shortcut-label">{item.label}</span>
                  <ShortcutChord keys={item.keys} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
