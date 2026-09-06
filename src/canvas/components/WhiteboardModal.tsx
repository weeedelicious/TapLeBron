import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import 'tldraw/tldraw.css'
import {
  Tldraw,
  createShapeId,
  notifyIfFileNotAllowed,
  useEditor,
  useToasts,
  useTranslation,
  type Editor,
  type TLEditorSnapshot,
  type TldrawOptions,
} from 'tldraw'
import { DefaultColorStyle, DefaultSizeStyle } from '@tldraw/editor'

export interface WhiteboardModalAcceptPayload {
  dataUrl: string
  width: number
  height: number
  snapshot: TLEditorSnapshot
}

interface WhiteboardModalProps {
  sourceName: string
  sourceFile?: File | null
  initialSnapshot?: TLEditorSnapshot | null
  isPreparing?: boolean
  loadError?: string | null
  onCancel: () => void
  onAccept: (payload: WhiteboardModalAcceptPayload) => Promise<void> | void
}

const TLDRAW_OPTIONS: Partial<TldrawOptions> = {
  maxPages: 1,
  actionShortcutsLocation: 'menu',
  maxFontsToLoadBeforeRender: 0,
}

function applyWhiteboardDefaults(editor: Editor) {
  editor.setStyleForNextShapes(DefaultColorStyle, 'red')
  editor.setStyleForNextShapes(DefaultSizeStyle, 'xl')
  editor.setCurrentTool('draw')
}

function resolveWhiteboardExportPixelRatio(editor: Editor, shapes: Array<{ type?: string; props?: Record<string, unknown> }>) {
  for (const shape of shapes) {
    if (shape?.type !== 'image') continue

    const props = shape.props ?? {}
    const assetId = typeof props.assetId === 'string' ? props.assetId : null
    if (!assetId) continue

    const asset = editor.getAsset(assetId) as { props?: Record<string, unknown> } | undefined
    const assetProps = asset?.props ?? {}
    const assetWidth = Number(assetProps.w)
    const assetHeight = Number(assetProps.h)
    const shapeWidth = Number(props.w)
    const shapeHeight = Number(props.h)
    const widthRatio = assetWidth > 0 && shapeWidth > 0 ? assetWidth / shapeWidth : NaN
    const heightRatio = assetHeight > 0 && shapeHeight > 0 ? assetHeight / shapeHeight : NaN
    const ratios = [widthRatio, heightRatio].filter((value) => Number.isFinite(value) && value > 0)

    if (ratios.length > 0) {
      return Math.min(Math.max(Math.max(...ratios), 1), 8)
    }
  }

  return 1
}

export function WhiteboardModal({
  sourceName,
  sourceFile,
  initialSnapshot,
  isPreparing = false,
  loadError = null,
  onCancel,
  onAccept,
}: WhiteboardModalProps) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) {
        event.preventDefault()
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSaving, onCancel])

  const handleSave = useCallback(async () => {
    if (!editor || isSaving) return

    setIsSaving(true)
    try {
      const shapes = editor.getCurrentPageShapes()
      if (shapes.length === 0) {
        onCancel()
        return
      }

      const pixelRatio = resolveWhiteboardExportPixelRatio(
        editor,
        shapes as Array<{ type?: string; props?: Record<string, unknown> }>
      )
      const image = await editor.toImageDataUrl(shapes, {
        format: 'png',
        pixelRatio,
        padding: 0,
      })
      const snapshot = editor.getSnapshot()
      await onAccept({
        dataUrl: image.url,
        width: image.width,
        height: image.height,
        snapshot,
      })
    } finally {
      setIsSaving(false)
    }
  }, [editor, isSaving, onAccept, onCancel])

  return createPortal(
    <div
      className="nodrag"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 120000,
        background: 'rgba(3,2,8,0.82)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onCancel()
      }}
    >
      <div
        className="nodrag"
        style={{
          width: 'min(1380px, calc(100vw - 40px))',
          height: 'min(900px, calc(100vh - 40px))',
          background: '#0d0b14',
          border: '1px solid rgba(124,92,252,0.28)',
          borderRadius: 18,
          overflow: 'hidden',
          boxShadow: '0 32px 90px rgba(0,0,0,0.52)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="nodrag"
          style={{
            height: 58,
            borderBottom: '1px solid rgba(124,92,252,0.14)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '0 18px',
            flexShrink: 0,
            background: 'rgba(12,10,18,0.92)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#f4f0ff', fontSize: 15, fontWeight: 600 }}>白板标注</div>
            <div
              style={{
                color: '#8e85a9',
                fontSize: 12,
                marginTop: 2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 460,
              }}
            >
              {sourceName}
            </div>
          </div>
          <div className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              className="nodrag"
              style={{
                minWidth: 82,
                height: 36,
                borderRadius: 10,
                border: '1px solid rgba(124,92,252,0.26)',
                background: '#161220',
                color: '#cdbfff',
                fontSize: 13,
                cursor: isSaving ? 'default' : 'pointer',
                opacity: isSaving ? 0.55 : 1,
                padding: '0 14px',
              }}
              onClick={isSaving ? undefined : onCancel}
              disabled={isSaving}
            >
              取消
            </button>
            <button
              className="nodrag"
              style={{
                minWidth: 108,
                height: 36,
                borderRadius: 10,
                border: 'none',
                background: '#ffffff',
                color: '#111111',
                fontSize: 13,
                fontWeight: 600,
                cursor: isSaving ? 'default' : 'pointer',
                padding: '0 14px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                opacity: isSaving ? 0.72 : 1,
              }}
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : null}
              保存标注
            </button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <Tldraw
            options={TLDRAW_OPTIONS}
            snapshot={initialSnapshot ?? undefined}
            onMount={(mountedEditor) => {
              setEditor(mountedEditor)
              mountedEditor.user.updateUserPreferences({ colorScheme: 'dark' })

              window.setTimeout(() => {
                const shapeIds = mountedEditor.getCurrentPageShapes().map((shape) => shape.id)
                if (shapeIds.length > 0) {
                  mountedEditor.setSelectedShapes(shapeIds)
                  mountedEditor.zoomToSelection()
                  mountedEditor.selectNone()
                }
                applyWhiteboardDefaults(mountedEditor)
              }, 0)
            }}
          >
            <WhiteboardSeedAsset
              sourceFile={sourceFile}
              skipImport={Boolean(initialSnapshot)}
            />
          </Tldraw>
          {(isPreparing || loadError || (!sourceFile && !initialSnapshot)) ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 20,
                display: 'grid',
                placeItems: 'center',
                pointerEvents: 'none',
                background: 'linear-gradient(180deg, rgba(6,5,10,0.72), rgba(6,5,10,0.48))',
              }}
            >
              <div
                style={{
                  minWidth: 260,
                  maxWidth: 420,
                  padding: '18px 20px',
                  borderRadius: 14,
                  border: '1px solid rgba(190,174,255,0.2)',
                  background: 'rgba(14,12,22,0.88)',
                  boxShadow: '0 18px 60px rgba(0,0,0,0.42)',
                  textAlign: 'center',
                }}
              >
                {loadError ? null : (
                  <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: '#c7bbff', margin: '0 auto 10px' }} />
                )}
                <div style={{ color: loadError ? '#ff9aa7' : '#f5f1ff', fontSize: 13, fontWeight: 700 }}>
                  {loadError || '正在准备白板素材...'}
                </div>
                <div style={{ color: '#8c83a4', fontSize: 11, marginTop: 6 }}>
                  {loadError ? '可以关闭后重试' : '大图或视频帧可能需要几秒钟'}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}

function WhiteboardSeedAsset({
  sourceFile,
  skipImport,
}: {
  sourceFile?: File | null
  skipImport: boolean
}) {
  const editor = useEditor()
  const toasts = useToasts()
  const msg = useTranslation()
  const insertedRef = useRef(false)

  useEffect(() => {
    if (!sourceFile || skipImport || insertedRef.current) return

    insertedRef.current = true

    void (async () => {
      const isOk = notifyIfFileNotAllowed(editor, sourceFile, { toasts, msg })
      if (!isOk) return

      const asset = await editor.getAssetForExternalContent({ type: 'file', file: sourceFile })
      if (!asset || asset.type !== 'image') return

      const scale = Math.min(1000 / Math.max(asset.props.w, asset.props.h), 1)
      const center = editor.getViewportPageBounds().center
      const width = asset.props.w * scale
      const height = asset.props.h * scale
      const shapeId = createShapeId()

      editor
        .createAssets([asset])
        .createShape({
          id: shapeId,
          type: 'image',
          x: center.x - width / 2,
          y: center.y - height / 2,
          props: {
            assetId: asset.id,
            w: width,
            h: height,
          },
        })
        .setSelectedShapes([shapeId])
        .zoomToSelection()
        .selectNone()

      applyWhiteboardDefaults(editor)
    })().catch((error) => {
      console.error('Failed to seed whiteboard asset', error)
      insertedRef.current = false
    })
  }, [editor, msg, skipImport, sourceFile, toasts])

  return null
}
