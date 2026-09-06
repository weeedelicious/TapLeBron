import { History, Keyboard, Plus, Share2, Star } from 'lucide-react'

type DockPanel = 'history' | 'shortcuts' | 'assets' | 'shared' | null

interface BottomDockProps {
  dockPanel: DockPanel
  onAddNode: () => void
  onToggleAssets: () => void
  onToggleHistory: () => void
  onToggleShared: () => void
  onToggleShortcuts: () => void
}

export function BottomDock({
  dockPanel,
  onAddNode,
  onToggleAssets,
  onToggleHistory,
  onToggleShared,
  onToggleShortcuts,
}: BottomDockProps) {
  return (
    <div className="canvas-bottom-dock" role="toolbar" aria-label="画布快捷工具">
      <button
        type="button"
        className="canvas-bottom-dock-button is-primary"
        title="添加节点"
        aria-label="添加节点"
        onClick={onAddNode}
      >
        <Plus size={19} strokeWidth={2.2} />
      </button>
      <button
        type="button"
        className={`canvas-bottom-dock-button${dockPanel === 'history' ? ' is-active' : ''}`}
        title="历史记录"
        aria-label="历史记录"
        onClick={onToggleHistory}
      >
        <History size={16} strokeWidth={2} />
      </button>
      <button
        type="button"
        className={`canvas-bottom-dock-button${dockPanel === 'shortcuts' ? ' is-active' : ''}`}
        title="快捷键"
        aria-label="快捷键"
        onClick={onToggleShortcuts}
      >
        <Keyboard size={16} strokeWidth={2} />
      </button>
      <button
        type="button"
        className={`canvas-bottom-dock-button${dockPanel === 'assets' ? ' is-active' : ''}`}
        title="资产库"
        aria-label="资产库"
        onClick={onToggleAssets}
      >
        <Star size={16} strokeWidth={2} />
      </button>
      <button
        type="button"
        className={`canvas-bottom-dock-button${dockPanel === 'shared' ? ' is-active' : ''}`}
        title="共享空间"
        aria-label="共享空间"
        onClick={onToggleShared}
      >
        <Share2 size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
