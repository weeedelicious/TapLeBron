import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { DragEvent } from 'react'
import { FavoriteLibraryPanel } from './FavoriteLibraryPanel'
import type { FavoriteLibraryItem } from '@/lib/types'

/**
 * 画布左侧的资产库停靠栏。
 *
 * 以前资产库 / 共享空间是盖在画布右侧的浮层（.favorite-library-panel 那份 absolute
 * 定位），挡住底下的节点。现在改成画布布局的一部分：它占掉左边一条，画布本身跟着变窄，
 * 谁也不挡谁。画布最左边挂一个箭头把手，点一下展开 / 收起。
 *
 * 面板组件本身没改，只是换了个容器 —— 里面那些 absolute 的样式由
 * `.shotflow-asset-dock .favorite-library-panel` 一组规则接管。
 */

export type AssetDockMode = 'assets' | 'shared'

const STORAGE_KEY = 'shotflow:asset-dock-mode'

export function readAssetDockMode(): AssetDockMode | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === 'assets' || raw === 'shared' ? raw : null
  } catch {
    return null
  }
}

export function writeAssetDockMode(mode: AssetDockMode | null) {
  try {
    if (mode) window.localStorage.setItem(STORAGE_KEY, mode)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 隐私模式下 localStorage 会抛，记不住就算了，不影响用
  }
}

interface CanvasAssetDockProps {
  mode: AssetDockMode | null
  /** 上次展开时看的是哪个库：收起状态下点箭头要回到它 */
  lastMode: AssetDockMode
  onModeChange: (mode: AssetDockMode | null) => void
  onInsert: (item: FavoriteLibraryItem) => void
  onDragStart?: (item: FavoriteLibraryItem, event: DragEvent<HTMLElement>) => void
}

export function CanvasAssetDock({
  mode,
  lastMode,
  onModeChange,
  onInsert,
  onDragStart,
}: CanvasAssetDockProps) {
  const open = mode !== null
  const label = (mode ?? lastMode) === 'shared' ? '共享空间' : '资产库'
  const dockRef = useRef<HTMLDivElement>(null)

  // 把停靠栏占掉的宽度写成 CSS 变量挂在 <html> 上。
  // 画布本体是它的 flex 兄弟、自己会让位，但画布外面还有几个 fixed / absolute 的东西
  // （左上角那排「Shotflow / 返回管理 / 画布名」，以及版本冲突横幅）不在这个 flex 里，
  // 不跟着挪就会被停靠栏盖住。它们靠这个变量右移。
  // 窄屏 / 触屏下停靠栏是盖在画布上的浮层（position: absolute），不占布局，
  // 那种情况给 0 —— 用 computed position 判断，跟 CSS 里的媒体查询条件不用各写一份。
  useEffect(() => {
    const root = document.documentElement
    const publish = () => {
      const element = dockRef.current
      if (!element) return
      // 在流内时是 position: relative，窄屏 / 触屏的浮层态是 absolute。
      // 不能写 !== 'static' —— 它平时就是 relative，那样判出来永远是浮层、宽度永远 0。
      const overlay = window.getComputedStyle(element).position === 'absolute'
      const width = overlay ? 0 : Math.round(element.getBoundingClientRect().width)
      root.style.setProperty('--sf-asset-dock-width', `${width}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    if (dockRef.current) observer.observe(dockRef.current)
    window.addEventListener('resize', publish)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', publish)
      root.style.setProperty('--sf-asset-dock-width', '0px')
    }
  }, [open])

  return (
    <div ref={dockRef} className={`shotflow-asset-dock nodrag nopan${open ? ' is-open' : ''}`}>
      {open && (
        <FavoriteLibraryPanel
          mode={mode}
          onClose={() => onModeChange(null)}
          onInsert={onInsert}
          onDragStart={onDragStart}
        />
      )}
      <button
        type="button"
        className="shotflow-asset-dock-handle"
        title={open ? `收起${label}` : `展开${label}`}
        aria-label={open ? `收起${label}` : `展开${label}`}
        aria-expanded={open}
        onClick={() => onModeChange(open ? null : lastMode)}
      >
        {open ? <ChevronLeft size={16} strokeWidth={2.4} /> : <ChevronRight size={16} strokeWidth={2.4} />}
      </button>
    </div>
  )
}
