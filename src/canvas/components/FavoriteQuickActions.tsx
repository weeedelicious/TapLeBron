import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react'
import { Loader2, Share2, Star } from 'lucide-react'
import { favoritesApi } from '@/lib/api'
import { buildFavoriteCreatePayload } from '@/lib/favoriteLibrary'
import { useCanvasStore } from '@/store/canvasStore'
import { MediaNodeToolbar, type MediaNodeToolbarAction } from './MediaNodeToolbar'

type SavingMode = 'favorite' | 'share' | null

interface FavoriteQuickActionsProps {
  rootIds: string[]
  variant?: 'toolbar' | 'bare'
  buttonStyle?: CSSProperties
}

const L = {
  save: '\u6536\u85cf',
  share: '\u5171\u4eab',
  saveSuccess: '\u5df2\u6536\u85cf\u5230\u6536\u85cf\u5e93',
  shareSuccess: '\u5df2\u5171\u4eab\u5230\u5171\u4eab\u7a7a\u95f4',
  empty: '\u6ca1\u6709\u53ef\u6536\u85cf\u7684\u8282\u70b9',
  failed: '\u6536\u85cf\u5931\u8d25',
  // Undo labels. This file keeps every CJK string \u-escaped, so comments stay ASCII too
  // (a Chinese comment here would be escaped into unreadable \uXXXX runs).
  // unsave / unshare = "cancel favorite" / "cancel share"
  unsave: '\u53d6\u6d88\u6536\u85cf',
  unshare: '\u53d6\u6d88\u5171\u4eab',
  unsaveSuccess: '\u5df2\u4ece\u6536\u85cf\u5e93\u79fb\u9664',
  unshareSuccess: '\u5df2\u4ece\u5171\u4eab\u7a7a\u95f4\u79fb\u9664',
  // Confirm text: removing from the shared space hides it from everyone else, and the
  // tags / project labels set in the asset library are lost (re-sharing creates a new row).
  unshareConfirm: '\u4ece\u5171\u4eab\u7a7a\u95f4\u79fb\u9664\u8fd9\u4efd\u5171\u4eab\uff1f\n\n'
    + '\u5176\u4ed6\u4eba\u5c06\u4e0d\u518d\u770b\u5230\u5b83\u3002\u4f60\u5728\u8d44\u4ea7\u5e93\u91cc\u7ed9\u5b83\u8bbe\u7684'
    + '\u6807\u7b7e\u4e0e\u9879\u76ee\u4e5f\u4f1a\u4e00\u8d77\u4e22\u6389\uff0c\u91cd\u65b0\u5171\u4eab\u4f1a\u751f\u6210\u4e00\u6761\u65b0\u8bb0\u5f55\u3002',
  removeFailed: '\u53d6\u6d88\u5931\u8d25',
  // "this one was not shared by you, cannot remove"
  noPermission: '\u8fd9\u4efd\u4e0d\u662f\u4f60\u5171\u4eab\u7684\uff0c\u65e0\u6cd5\u79fb\u9664',
}

export function useFavoriteToolbarActions(rootIds: string[], enabled = true): MediaNodeToolbarAction[] {
  const nodes = useCanvasStore(state => state.nodes)
  const edges = useCanvasStore(state => state.edges)
  const projectUuid = useCanvasStore(state => state.projectUuid)
  const projectName = useCanvasStore(state => state.projectName)
  const [saving, setSaving] = useState<SavingMode>(null)
  const [success, setSuccess] = useState<SavingMode>(null)
  const [favoriteItemId, setFavoriteItemId] = useState<string | null>(null)
  const [sharedItemId, setSharedItemId] = useState<string | null>(null)
  const [isShared, setIsShared] = useState(false)
  const rootKey = useMemo(() => rootIds.filter(Boolean).join('|'), [rootIds])

  const refreshStatus = useCallback(async () => {
    if (!enabled || !projectUuid || !rootKey) {
      setFavoriteItemId(null)
      setSharedItemId(null)
      setIsShared(false)
      return
    }
    try {
      const [favoriteRes, sharedRes] = await Promise.all([
        favoritesApi.status({ projectUuid, rootIds: rootKey.split('|') }),
        favoritesApi.sharedStatus({ projectUuid, rootIds: rootKey.split('|') }),
      ])
      const favoriteItem = favoriteRes.items[0]
      const sharedItem = sharedRes.items[0]
      setFavoriteItemId(favoriteItem?.id ?? null)
      setSharedItemId(sharedItem?.id ?? null)
      setIsShared(Boolean(sharedItem))
    } catch (error) {
      console.error('load favorite status failed', error)
      setFavoriteItemId(null)
      setSharedItemId(null)
      setIsShared(false)
    }
  }, [enabled, projectUuid, rootKey])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    const reload = () => void refreshStatus()
    window.addEventListener('shotflow:favorites-changed', reload)
    window.addEventListener('shotflow:shared-assets-changed', reload)
    return () => {
      window.removeEventListener('shotflow:favorites-changed', reload)
      window.removeEventListener('shotflow:shared-assets-changed', reload)
    }
  }, [refreshStatus])

  /**
   * Undo a favorite / a share.
   *
   * DELETE /favorites/:id and /shared-assets/:id both exist already and both check
   * owner-or-admin, so no server change is needed. Both status endpoints select with
   * `WHERE owner_id = <current user>`, which means the button only ever lights up on the
   * caller's own row -- a 403 should not happen in practice, but it is reported honestly
   * if it does. A 404 means somebody already deleted it: just clear the local state.
   */
  const removeFavorite = useCallback(async (shared: boolean, itemId: string) => {
    setSaving(shared ? 'share' : 'favorite')
    setSuccess(null)
    const clearLocal = () => {
      if (shared) {
        setSharedItemId(null)
        setIsShared(false)
      } else {
        setFavoriteItemId(null)
      }
    }
    try {
      if (shared) await favoritesApi.deleteShared(itemId)
      else await favoritesApi.delete(itemId)
      clearLocal()
      window.dispatchEvent(new CustomEvent('shotflow:favorites-changed'))
      window.dispatchEvent(new CustomEvent('shotflow:shared-assets-changed'))
      window.dispatchEvent(new CustomEvent('shotflow:toast', {
        detail: { message: shared ? L.unshareSuccess : L.unsaveSuccess },
      }))
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status
      if (status === 404) {
        clearLocal()
        return
      }
      console.error('remove favorite failed', error)
      window.alert(status === 403 ? L.noPermission : L.removeFailed)
      // Do not leave the highlight lying about the real state.
      void refreshStatus()
    } finally {
      setSaving(null)
    }
  }, [refreshStatus])

  const saveFavorite = useCallback(async (shared: boolean) => {
    if (saving) return
    // Highlighted means "already saved/shared", so a second click is an undo.
    // Before 2026-08-18 these two branches only flashed the label and returned, i.e. the
    // undo path simply did not exist -- the buttons looked like toggles but were one-way.
    if (!shared && favoriteItemId) {
      await removeFavorite(false, favoriteItemId)
      return
    }
    if (shared && sharedItemId) {
      // The shared space is somewhere other people look, and re-sharing creates a new row
      // (losing the tags / project labels), so confirm this one. Un-favoriting is private
      // and trivially redone, so it goes through without a prompt.
      if (!window.confirm(L.unshareConfirm)) return
      await removeFavorite(true, sharedItemId)
      return
    }
    const payload = buildFavoriteCreatePayload(rootIds, nodes, edges, {
      projectUuid,
      projectName,
      shared,
    })
    if (!payload) {
      window.alert(L.empty)
      return
    }

    setSaving(shared ? 'share' : 'favorite')
    setSuccess(null)
    try {
      const res = shared
        ? await favoritesApi.createShared(payload)
        : await favoritesApi.create(payload)
      if (shared) {
        setSharedItemId(res.item.id)
        setIsShared(true)
      } else {
        setFavoriteItemId(res.item.id)
      }
      window.dispatchEvent(new CustomEvent('shotflow:favorites-changed'))
      window.dispatchEvent(new CustomEvent('shotflow:shared-assets-changed'))
      window.dispatchEvent(new CustomEvent('shotflow:toast', {
        detail: { message: shared ? L.shareSuccess : L.saveSuccess },
      }))
      setSuccess(shared ? 'share' : 'favorite')
      window.setTimeout(() => setSuccess(null), 1400)
    } catch (error) {
      console.error('save favorite failed', error)
      window.alert(L.failed)
    } finally {
      setSaving(null)
    }
  }, [edges, favoriteItemId, nodes, projectName, projectUuid, removeFavorite, rootIds, saving, sharedItemId])

  const isFavorite = Boolean(favoriteItemId)

  return useMemo(() => [
    {
      key: 'favorite',
      // Say what the next click does. It used to read "already favorited", which reads as
      // "not clickable" -- part of why the undo looked broken rather than missing.
      label: isFavorite || success === 'favorite' ? L.unsave : L.save,
      icon: saving === 'favorite'
        ? <Loader2 size={14} className="favorite-spin" />
        : <Star size={14} strokeWidth={2} fill={isFavorite || success === 'favorite' ? 'currentColor' : 'none'} />,
      onClick: () => void saveFavorite(false),
      disabled: Boolean(saving),
      active: isFavorite || success === 'favorite',
    },
    {
      key: 'share',
      label: isShared || success === 'share' ? L.unshare : L.share,
      icon: saving === 'share'
        ? <Loader2 size={14} className="favorite-spin" />
        : <Share2 size={14} strokeWidth={2} />,
      onClick: () => void saveFavorite(true),
      disabled: Boolean(saving),
      active: isShared || success === 'share',
    },
  ], [isFavorite, isShared, saveFavorite, saving, success])
}

export function FavoriteQuickActions({ rootIds, variant = 'toolbar', buttonStyle }: FavoriteQuickActionsProps) {
  const actions = useFavoriteToolbarActions(rootIds)

  if (variant === 'bare') {
    return (
      <>
        {actions.map(action => (
          <button
            key={action.key}
            type="button"
            className="nodrag"
            style={{
              ...buttonStyle,
              ...(action.active
                ? {
                    background: 'rgba(177,150,255,0.18)',
                    borderColor: 'rgba(225,214,255,0.28)',
                    color: '#fff',
                    boxShadow: '0 0 10px rgba(177,150,255,0.18)',
                  }
                : {}),
            }}
            title={action.label}
            aria-label={action.label}
            disabled={action.disabled}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={action.disabled ? undefined : (event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault()
              event.stopPropagation()
              action.onClick?.(event)
            }}
          >
            {action.icon}
          </button>
        ))}
      </>
    )
  }

  return <MediaNodeToolbar actions={actions} />
}
