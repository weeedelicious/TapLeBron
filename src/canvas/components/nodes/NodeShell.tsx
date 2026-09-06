import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Handle, Position, NodeResizer, useStore, useViewport } from '@xyflow/react'
import { MoreHorizontal } from 'lucide-react'
import { useCanvasStore } from '@/store/canvasStore'
import { useFavoriteToolbarActions } from '@/components/FavoriteQuickActions'
import { MediaNodeToolbar, MediaToolbarActionsProvider } from '@/components/MediaNodeToolbar'
import { NodeTypeIcon } from './nodeTypeIcon'
import { errorToText } from '@/lib/display'
import type { CanvasNodeData } from '@/lib/types'

function PlusHandleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="9.35" fill="rgba(8,12,18,0.92)" stroke="rgba(128,189,255,0.68)" strokeWidth="1.15" />
      <path d="M10 6.5v7M6.5 10h7" stroke="rgba(229,244,255,0.92)" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 标题行钉在节点上沿之上这么多**屏幕** px（先除 zoom 再反向 scale，所以缩放画布时不变）。
 * 提成常量是因为「选中时的分辨率」要紧贴它上沿 —— 两个数字必须绑在一起，
 * 分开写死的话改了一个另一个就会脱开一条缝。
 */
const HEADER_OFFSET_SCREEN_PX = 24
/** 选中时那行分辨率的行高（屏幕 px）。它的底边正好落在标题行上沿。 */
const SELECTED_META_HEIGHT_PX = 15
/** 标题文字的左边缘：图标 14 + 标题行的 gap-1.5（6px）。分辨率要落在**名字**上方而不是图标上方。 */
const HEADER_NAME_LEFT_PX = 20

interface NodeShellProps {
  nodeKey: string
  data: CanvasNodeData & { nodeKey: string }
  children: ReactNode
  toolbar?: ReactNode
  headerMeta?: ReactNode
  /**
   * 只在**选中时**显示的一行小字，贴在节点名字正上方、50% 透明度（图片 / 视频节点的分辨率）。
   * 不选中时整个不渲染 —— 画布上几十个节点各挂一串数字太吵。
   * 跟 headerMeta 是两个口子：headerMeta 仍然是「一直显示在标题行右端」，上传节点还在用。
   */
  selectedMeta?: ReactNode
  headerIcon?: ReactNode
  headerMode?: 'default' | 'menu-only' | 'hidden'
  showMenuButton?: boolean
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  resizeHandle?: 'all' | 'bottom-right' | 'none'
  persistResize?: boolean
  showFavoriteToolbarFallback?: boolean
  selected?: boolean
  bodyStyle?: CSSProperties
}

export function NodeShell({
  nodeKey,
  data,
  children,
  toolbar,
  headerMeta,
  selectedMeta,
  headerIcon,
  headerMode = 'default',
  showMenuButton = true,
  minWidth = 320,
  maxWidth,
  minHeight = 200,
  resizeHandle = 'all',
  persistResize = false,
  showFavoriteToolbarFallback = true,
  selected,
  bodyStyle,
}: NodeShellProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState(data.name)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isSourceHandleHovered, setIsSourceHandleHovered] = useState(false)
  const sourceHandleLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { deleteNodes, updateNodeData, duplicateNodes, updateNodeSize, pushHistory, connectionHoverTargetId, selectedNodeKeys } = useCanvasStore()
  const measuredNodeWidth = useStore((state) => {
    const node = (state.nodeLookup as Map<string, {
      measured?: { width?: number }
      width?: number
      internals?: { userNode?: { measured?: { width?: number }; width?: number } }
    }>)?.get(nodeKey)

    return Number(
      node?.measured?.width ??
      node?.width ??
      node?.internals?.userNode?.measured?.width ??
      node?.internals?.userNode?.width ??
      0
    ) || 0
  })
  const { zoom } = useViewport()
  const safeZoom = zoom || 1
  const inverseZoom = 1 / safeZoom
  const handleScreenSize = Math.min(22, Math.max(8, 24 * safeZoom))
  const sourceHandleHoverScreenSize = Math.min(28, Math.max(10, 34 * safeZoom))
  const handleIconScreenScale = Math.min(1, Math.max(0.6, safeZoom))
  const handleHitSize = handleScreenSize / safeZoom
  const sourceHandleHoverSize = sourceHandleHoverScreenSize / safeZoom
  const sourceHandleHoverInset = (handleHitSize - sourceHandleHoverSize) / 2
  const handleIconVisualOffset = handleHitSize / 2 + 6 / safeZoom
  const layoutNodeWidth = maxWidth ?? (measuredNodeWidth || minWidth)
  const headerScreenWidth = Math.max(0, layoutNodeWidth * safeZoom)

  useEffect(() => {
    setTitleDraft(data.name)
    setIsRenaming(false)
  }, [data.name])

  useEffect(() => () => {
    if (sourceHandleLeaveTimerRef.current) clearTimeout(sourceHandleLeaveTimerRef.current)
  }, [])

  const handleDelete = useCallback(() => {
    deleteNodes([nodeKey])
    setMenuOpen(false)
  }, [deleteNodes, nodeKey])

  const handleRename = useCallback(() => {
    const name = prompt('重命名节点', data.name)
    if (name) updateNodeData(nodeKey, { name })
    setMenuOpen(false)
  }, [data.name, nodeKey, updateNodeData])

  const handleDuplicate = useCallback(() => {
    duplicateNodes([nodeKey])
    setMenuOpen(false)
  }, [duplicateNodes, nodeKey])

  const commitInlineTitle = useCallback(() => {
    const nextName = titleDraft.trim() || (data.type === 'image' ? 'image' : data.name)
    setTitleDraft(nextName)
    setIsRenaming(false)
    if (nextName !== data.name) updateNodeData(nodeKey, { name: nextName })
  }, [data.name, data.type, nodeKey, titleDraft, updateNodeData])

  const showSourceHandleNow = useCallback(() => {
    if (sourceHandleLeaveTimerRef.current) {
      clearTimeout(sourceHandleLeaveTimerRef.current)
      sourceHandleLeaveTimerRef.current = null
    }
    setIsSourceHandleHovered(true)
  }, [])

  const hideSourceHandleSoon = useCallback(() => {
    if (sourceHandleLeaveTimerRef.current) clearTimeout(sourceHandleLeaveTimerRef.current)
    sourceHandleLeaveTimerRef.current = setTimeout(() => {
      setIsSourceHandleHovered(false)
      sourceHandleLeaveTimerRef.current = null
    }, 140)
  }, [])

  const hasError = data.taskInfo?.status === 3
  const isGenerating = Boolean(data.taskInfo?.loading && !hasError)
  const generationProgress = Math.max(4, Math.min(100, Number(data.taskInfo?.progressPercent ?? 0)))
  const isConnectionHoverTarget = connectionHoverTargetId === nodeKey || connectionHoverTargetId === data.nodeKey
  const showTargetHandle = Boolean(selected || isConnectionHoverTarget)
  const showSourceHandle = Boolean(selected || isHovered || isSourceHandleHovered)
  const targetHandleIconScale = inverseZoom * handleIconScreenScale * (isConnectionHoverTarget ? 1.08 : showTargetHandle ? 1 : 0.9)
  const sourceHandleIconScale = inverseZoom * handleIconScreenScale * (showSourceHandle ? 1 : 0.9)
  const showDefaultHeader = headerMode === 'default'
  const showMenuOnly = headerMode === 'menu-only'
  const toolbarTopOffset = showDefaultHeader ? 74 : 52
  const showFavoriteActions = Boolean(selected && selectedNodeKeys.length === 1)
  const showStandaloneFavoriteToolbar = Boolean(showFavoriteToolbarFallback && showFavoriteActions)
  const favoriteActions = useFavoriteToolbarActions([nodeKey], showFavoriteActions)
  const selectedStrokeWidth = Math.max(0.45, 0.8 / safeZoom)
  const selectedGlowRing = 0.7 / safeZoom
  const selectedGlowInner = 5 / safeZoom
  const selectedGlowOuter = 12 / safeZoom
  const selectedHandleScaleBase = safeZoom > 1 ? safeZoom : 1
  const selectedHandleSize = Math.max(4, 7 / selectedHandleScaleBase)
  const selectedHandleGlow = 8 / selectedHandleScaleBase
  const isResizeVisible = Boolean(selected && resizeHandle !== 'none')
  const isCindyOrigin = Boolean(data._cindyProposalMessageId)
  const selectedGlowStyle: CSSProperties = selected
    ? {
        border: `${selectedStrokeWidth}px solid rgba(142, 210, 255, 0.58)`,
        '--selected-node-ring': `${selectedGlowRing}px`,
        '--selected-node-inner': `${selectedGlowInner}px`,
        '--selected-node-outer': `${selectedGlowOuter}px`,
      } as CSSProperties
    : isCindyOrigin
      ? {
          // Let the .is-cindy-origin pink-breathe animation drive box-shadow;
          // only set the border here so we don't clobber the glow with an
          // inline boxShadow: 'none'.
          border: '1px solid rgba(255, 168, 224, 0.42)',
        }
      : {
          border: '1px solid #2d2040',
          boxShadow: 'none',
        }

  const resolvedHeaderIcon = headerIcon ?? (
    <NodeTypeIcon type={data.type} size={13} strokeWidth={1.9} />
  )

  const renderMenuButton = (align: 'left' | 'right' = 'left') => (
    <div className="relative nodrag" style={{ flexShrink: 0 }}>
      <button
        style={{
          width: 20,
          height: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: '#6a6080',
          padding: 0,
        }}
        onClick={e => {
          e.stopPropagation()
          setMenuOpen(v => !v)
        }}
      >
        <MoreHorizontal size={16} strokeWidth={1.9} />
      </button>
      {menuOpen && (
        <div
          className="absolute z-50 rounded shadow-lg py-1"
          style={{
            top: 24,
            minWidth: 96,
            background: '#1a1428',
            border: '1px solid #3a2860',
            ...(align === 'right' ? { right: 0 } : { left: 0 }),
          }}
        >
          <button
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-white/5"
            style={{ color: '#c0b8e0' }}
            onClick={handleRename}
          >
            重命名
          </button>
          <button
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-white/5"
            style={{ color: '#c0b8e0' }}
            onClick={handleDuplicate}
          >
            复制节点
          </button>
          <button
            className="block w-full text-left px-3 py-1 text-xs text-red-400 hover:bg-white/5"
            onClick={handleDelete}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div
      // canvas-node-cindy-wrap 必须留在这层外壳上：Cindy 建的节点那圈粉框和呼吸光靠它的
      // ::after 画。节点主体是 overflow:hidden 的，光挂在主体上会被裁掉，所以只能挂外壳。
      // 这个条件类曾经被改成硬编码字符串，粉色标记就此静默失效了 11 天（2026-08-13 → 08-24）——
      // 没有任何报错，只剩一条 42% 透明度的 1px 边，在暗色画布上等于看不见。
      className={`relative flex flex-col${isCindyOrigin ? ' canvas-node-cindy-wrap' : ''}`}
      style={{ minWidth, minHeight, ...(maxWidth ? { maxWidth, width: maxWidth } : {}) }}
      onClick={() => menuOpen && setMenuOpen(false)}
    >
      <NodeResizer
        isVisible={isResizeVisible}
        minWidth={minWidth}
        minHeight={minHeight}
        maxWidth={maxWidth}
        keepAspectRatio={false}
        shouldResize={(_, params) => resizeHandle !== 'bottom-right' || params.direction === 'bottom-right'}
        handleClassName={resizeHandle === 'bottom-right' ? 'text-node-bottom-right-resize-handle' : undefined}
        onResizeStart={persistResize ? () => pushHistory() : undefined}
        onResizeEnd={persistResize ? (_, params) => {
          updateNodeSize(nodeKey, Math.round(params.width), Math.round(params.height))
        } : undefined}
        handleStyle={{
          background: 'rgba(224, 242, 255, 0.98)',
          border: '1px solid rgba(240, 248, 255, 0.96)',
          borderRadius: 999,
          width: selectedHandleSize,
          height: selectedHandleSize,
          boxShadow: `0 0 ${selectedHandleGlow}px rgba(103, 190, 255, 0.72)`,
        }}
        lineStyle={{ borderColor: 'transparent' }}
      />

      {(toolbar || showStandaloneFavoriteToolbar) && (
        <div
          className="absolute"
          style={{ top: -toolbarTopOffset / safeZoom, left: 0, right: 0, zIndex: 50, pointerEvents: 'none' }}
        >
          <div style={{ pointerEvents: 'all', transform: `scale(${inverseZoom})`, transformOrigin: 'top center' }}>
            {toolbar ? (
              <MediaToolbarActionsProvider actions={showFavoriteActions ? favoriteActions : []}>
                {toolbar}
              </MediaToolbarActionsProvider>
            ) : (
              <MediaNodeToolbar actions={showStandaloneFavoriteToolbar ? favoriteActions : []} />
            )}
          </div>
        </div>
      )}

      <div
        className="relative flex flex-col"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >

      {/* 选中时才出现的分辨率，紧贴在标题上方。不选中时整个不渲染：
          画布上几十个节点各顶一串数字太吵，用户明确要求只在选中时看。
          pointerEvents:none —— 它压在节点上方的空白区，不能挡住框选和连线。 */}
      {showDefaultHeader && selected && selectedMeta && (
        <div
          className="absolute shotflow-node-selected-meta"
          style={{
            top: -(HEADER_OFFSET_SCREEN_PX + SELECTED_META_HEIGHT_PX) / safeZoom,
            left: 0,
            height: SELECTED_META_HEIGHT_PX,
            width: headerScreenWidth,
            maxWidth: headerScreenWidth,
            paddingLeft: HEADER_NAME_LEFT_PX,
            zIndex: 20,
            display: 'flex',
            alignItems: 'flex-end',
            whiteSpace: 'nowrap',
            opacity: 0.5,
            pointerEvents: 'none',
            transform: `scale(${inverseZoom})`,
            transformOrigin: 'top left',
          }}
        >
          {selectedMeta}
        </div>
      )}

      {showDefaultHeader && (
        <div
          className="absolute flex items-center gap-1.5 shotflow-node-header"
          style={{
            top: -HEADER_OFFSET_SCREEN_PX / safeZoom,
            left: 0,
            height: 22,
            width: headerScreenWidth,
            maxWidth: headerScreenWidth,
            zIndex: 20,
            overflow: 'hidden',
            transform: `scale(${inverseZoom})`,
            transformOrigin: 'top left',
          }}
        >
          <span
            className="shotflow-node-header-icon"
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ece8ff',
            }}
          >
            {resolvedHeaderIcon}
          </span>

          {isRenaming ? (
            <input
              className="nodrag shotflow-node-title-input"
              autoFocus
              value={titleDraft}
              onChange={e => setTitleDraft(e.currentTarget.value)}
              onBlur={commitInlineTitle}
              onMouseDown={e => e.stopPropagation()}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                  setTitleDraft(data.name)
                  setIsRenaming(false)
                  e.currentTarget.blur()
                }
              }}
              onClick={e => e.stopPropagation()}
              style={{
                flex: 1,
                minWidth: 0,
                height: 20,
                padding: '0 5px',
                borderRadius: 5,
                border: '1px solid rgba(124,92,252,0.2)',
                background: 'rgba(26,22,37,0.9)',
                color: '#f6f4ff',
                fontSize: 'calc(12px * var(--canvas-text-scale, 1))',
                outline: 'none',
              }}
            />
          ) : (
            <span
              className="shotflow-node-title"
              onDoubleClick={e => {
                e.stopPropagation()
                setIsRenaming(true)
              }}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 'calc(12px * var(--canvas-text-scale, 1))',
                color: '#f2efff',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                cursor: 'text',
              }}
            >
              {data.name}
            </span>
          )}

          {headerMeta && (
            <div
              className="shotflow-node-header-meta"
              style={{
                marginLeft: 'auto',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                whiteSpace: 'nowrap',
              }}
            >
              {headerMeta}
            </div>
          )}

          {showMenuButton && renderMenuButton()}
        </div>
      )}

      {showMenuOnly && showMenuButton && (
        <div
          className="absolute nodrag"
          style={{
            top: -24 / safeZoom,
            right: 0,
            height: 22,
            zIndex: 20,
            transform: `scale(${inverseZoom})`,
            transformOrigin: 'top right',
          }}
        >
          {renderMenuButton('right')}
        </div>
      )}

      </div>

      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: handleHitSize,
          height: handleHitSize,
          minWidth: handleHitSize,
          background: 'transparent',
          border: 'none',
          borderRadius: 999,
          left: 0,
          top: '50%',
          transform: 'translateY(-50%)',
          zIndex: 20,
          opacity: showTargetHandle ? 1 : 0,
          pointerEvents: showTargetHandle ? 'auto' : 'none',
          transition: 'opacity 0.15s ease',
        }}
      >
        <div
          className={`nodrag${isConnectionHoverTarget ? ' connection-target-snap' : ''}`}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            opacity: showTargetHandle ? 1 : 0,
            transform: `translateX(${-handleIconVisualOffset}px) scale(${targetHandleIconScale})`,
            transformOrigin: 'center',
            transition: 'opacity 0.15s ease, transform 0.15s ease',
            filter: isConnectionHoverTarget
              ? 'drop-shadow(0 0 5px rgba(255,252,224,0.88)) drop-shadow(0 0 15px rgba(140,196,255,0.5))'
              : undefined,
          }}
        >
          <PlusHandleIcon />
        </div>
      </Handle>

      <Handle
        type="source"
        position={Position.Right}
        onMouseEnter={() => {
          setIsHovered(true)
          showSourceHandleNow()
        }}
        onMouseLeave={hideSourceHandleSoon}
        style={{
          width: handleHitSize,
          height: handleHitSize,
          minWidth: handleHitSize,
          background: 'transparent',
          border: 'none',
          borderRadius: 999,
          right: 0,
          left: 'auto',
          top: '50%',
          transform: 'translateY(-50%)',
          zIndex: 20,
          opacity: showSourceHandle ? 1 : 0,
          pointerEvents: showSourceHandle ? 'auto' : 'none',
          transition: 'opacity 0.15s ease',
        }}
      >
        <div
          className="nodrag"
          style={{
            position: 'absolute',
            width: sourceHandleHoverSize,
            height: sourceHandleHoverSize,
            left: sourceHandleHoverInset,
            top: sourceHandleHoverInset,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: showSourceHandle ? 'auto' : 'none',
            opacity: showSourceHandle ? 1 : 0,
            transform: `translateX(${handleIconVisualOffset}px) scale(${sourceHandleIconScale})`,
            transformOrigin: 'center',
            transition: 'opacity 0.15s ease, transform 0.15s ease',
            borderRadius: 999,
          }}
          onMouseEnter={showSourceHandleNow}
          onMouseLeave={hideSourceHandleSoon}
        >
          <PlusHandleIcon />
        </div>
      </Handle>

      <div
        className={`relative flex flex-col flex-1 rounded-lg overflow-hidden canvas-node-body${selected ? ' is-selected' : ''}${isGenerating ? ' is-generating' : ''}${hasError ? ' has-error' : ''}${data._cindyProposalMessageId ? ' is-cindy-origin' : ''}`}
        style={{
          background: '#1a1625',
          ...selectedGlowStyle,
          ...bodyStyle,
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div className="flex-1 min-h-0">{children}</div>

        {isGenerating && (
          <div className="shotflow-node-status-strip is-generating" aria-label="generating">
            <span style={{ width: `${generationProgress}%` }} />
          </div>
        )}

        {hasError && (
          <div
            className="shotflow-node-status-strip is-error"
            style={{ zIndex: 30 }}
          >
            {errorToText(data.taskInfo?.error, '生成失败，请重试')}
          </div>
        )}
      </div>
    </div>
  )
}
