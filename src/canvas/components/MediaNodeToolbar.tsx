import { createContext, useContext, type MouseEvent, type ReactNode } from 'react'

export interface MediaNodeToolbarAction {
  key: string
  label: string
  icon: ReactNode
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  active?: boolean
}

interface MediaNodeToolbarProps {
  actions: MediaNodeToolbarAction[]
}

const ExtraMediaToolbarActionsContext = createContext<MediaNodeToolbarAction[]>([])

export function MediaToolbarActionsProvider({
  actions,
  children,
}: {
  actions: MediaNodeToolbarAction[]
  children: ReactNode
}) {
  return (
    <ExtraMediaToolbarActionsContext.Provider value={actions}>
      {children}
    </ExtraMediaToolbarActionsContext.Provider>
  )
}

export function MediaNodeToolbar({ actions }: MediaNodeToolbarProps) {
  const extraActions = useContext(ExtraMediaToolbarActionsContext)
  const allActions = extraActions.length > 0 ? [...extraActions, ...actions] : actions

  return (
    <div
      data-media-node-toolbar="true"
      className="nodrag flex items-center rounded-full shotflow-media-toolbar"
      style={{
        gap: 2,
        padding: 2,
        background: 'linear-gradient(180deg, rgba(18,22,28,0.92), rgba(8,10,14,0.9))',
        border: '1px solid rgba(128,189,255,0.16)',
        boxShadow: '0 10px 26px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.08)',
        whiteSpace: 'nowrap',
        width: 'fit-content',
        margin: '0 auto',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      {allActions.map((action) => (
        <button
          key={action.key}
          type="button"
          className={`nodrag flex items-center justify-center shotflow-media-toolbar-button${action.active ? ' is-active' : ''}${action.disabled ? ' is-disabled' : ''}`}
          style={{
            width: 21,
            height: 21,
            borderRadius: 6,
            background: action.active ? 'rgba(128,189,255,0.18)' : 'rgba(255,255,255,0.02)',
            border: action.active ? '1px solid rgba(176,218,255,0.32)' : '1px solid transparent',
            cursor: action.disabled ? 'default' : 'pointer',
            color: action.disabled ? 'rgba(138,148,164,0.42)' : action.active ? '#ffffff' : 'rgba(226,232,240,0.78)',
            boxShadow: action.active ? '0 0 10px rgba(128,189,255,0.16)' : 'none',
            opacity: action.disabled ? 0.48 : 1,
            transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease, transform 0.15s ease',
          }}
          onMouseEnter={(event) => {
            if (action.disabled) return
            event.currentTarget.style.background = 'rgba(128,189,255,0.14)'
            event.currentTarget.style.borderColor = 'rgba(176,218,255,0.28)'
            event.currentTarget.style.transform = 'translateY(-1px)'
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = action.active ? 'rgba(128,189,255,0.18)' : 'rgba(255,255,255,0.02)'
            event.currentTarget.style.borderColor = action.active ? 'rgba(176,218,255,0.32)' : 'transparent'
            event.currentTarget.style.transform = 'translateY(0)'
          }}
          title={action.label}
          aria-label={action.label}
          onPointerDown={(event) => {
            event.stopPropagation()
          }}
          onMouseDown={(event) => {
            event.stopPropagation()
          }}
          onClick={action.disabled ? undefined : (event) => {
            event.preventDefault()
            event.stopPropagation()
            action.onClick?.(event)
          }}
          disabled={action.disabled}
        >
          {action.icon}
        </button>
      ))}
    </div>
  )
}
