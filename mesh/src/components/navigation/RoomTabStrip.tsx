import { useEffect, useRef, type KeyboardEvent } from 'react'
import {
  activateRelativeRoomTab,
  activateRoomTab,
  closeRoomTab,
  reorderRoomTab,
  reopenRoomTab,
  setRoomTabPinned,
  type RoomTabState,
} from '../../lib/room-tabs'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'

export function RoomTabStrip({
  state,
  onChange,
}: {
  state: RoomTabState
  onChange: (state: RoomTabState) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const activeTab = state.tabs.find((tab) => tab.key === state.activeKey) ?? null

  const focusTab = (key: string | null) => {
    window.requestAnimationFrame(() => {
      const target = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-room-tab-key]') ?? [])]
        .find((element) => element.dataset.roomTabKey === key)
      target?.focus()
    })
  }

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) return
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault()
        if (event.shiftKey && state.activeKey) {
          const next = reorderRoomTab(
            state,
            state.activeKey,
            event.key === 'PageDown' ? 1 : -1,
          )
          onChange(next)
          focusTab(next.activeKey)
        } else {
          onChange(activateRelativeRoomTab(state, event.key === 'PageDown' ? 1 : -1))
        }
      } else if (event.shiftKey && event.key.toLocaleLowerCase() === 't') {
        event.preventDefault()
        const next = reopenRoomTab(state)
        onChange(next)
        focusTab(next.activeKey)
      } else if (event.shiftKey && event.key.toLocaleLowerCase() === 'p' && state.activeKey) {
        event.preventDefault()
        const tab = state.tabs.find((candidate) => candidate.key === state.activeKey)
        if (tab) onChange(setRoomTabPinned(state, tab.key, !tab.pinned))
      }
    }
    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  })

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      const next = reorderRoomTab(state, key, event.key === 'ArrowRight' ? 1 : -1)
      onChange(next)
      focusTab(next.activeKey)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = activateRelativeRoomTab(
        activateRoomTab(state, key),
        event.key === 'ArrowRight' ? 1 : -1,
      )
      onChange(next)
      focusTab(next.activeKey)
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      const next = closeRoomTab(state, key)
      onChange(next)
      focusTab(next.activeKey)
      return
    }
  }

  if (state.tabs.length <= 1) return null

  return (
    <div
      ref={rootRef}
      className="mesh-room-tabs flex min-h-11 flex-none items-center gap-2 border-b border-border-subtle bg-surface-base px-2.5"
      aria-label="Open conversations"
    >
      <div
        role="tablist"
        aria-label="Open rooms and direct messages"
        className="hidden min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:flex"
      >
        {state.tabs.map((tab) => {
          const selected = tab.key === state.activeKey
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              data-room-tab-key={tab.key}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              aria-label={`${tab.title}${tab.pinned ? ', pinned' : ''}${tab.mentionCount ? `, ${tab.mentionCount} mentions` : tab.unreadCount ? `, ${tab.unreadCount} unread` : ''}`}
              aria-keyshortcuts="Delete Control+PageUp Control+PageDown Meta+PageUp Meta+PageDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
              onClick={() => onChange(activateRoomTab(state, tab.key))}
              onKeyDown={(event) => handleTabKeyDown(event, tab.key)}
              className={`mesh-room-tab flex min-h-8 min-w-0 max-w-52 flex-none items-center gap-1.5 rounded-control border px-2.5 text-xs transition-colors ${
                selected
                  ? 'border-accent/30 bg-accent/10 text-primary'
                  : 'border-transparent text-muted hover:border-border-subtle hover:bg-surface-hover hover:text-secondary'
              }`}
            >
              <Icon name={tab.kind === 'dm' ? 'messageCircle' : 'hash'} size="xs" />
              <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
              {tab.pinned && <Icon name="pin" size="xs" aria-hidden="true" />}
              {tab.mentionCount > 0 ? (
                <span
                  className="rounded-full bg-status-danger px-1 text-meta text-content-on-status"
                  aria-hidden="true"
                >
                  @{Math.min(tab.mentionCount, 99)}
                </span>
              ) : tab.unreadCount > 0 ? (
                <span
                  className="rounded-full bg-surface-active px-1 text-meta text-secondary"
                  aria-hidden="true"
                >
                  {Math.min(tab.unreadCount, 99)}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <label className="min-w-0 flex-1 sm:hidden">
        <span className="sr-only">Open conversation</span>
        <select
          aria-label="Open conversation"
          value={state.activeKey ?? ''}
          onChange={(event) => onChange(activateRoomTab(state, event.target.value))}
          className="h-8 w-full min-w-0 rounded-control border border-border-subtle bg-surface-raised px-2 text-sm text-primary"
        >
          {state.tabs.map((tab) => (
            <option key={tab.key} value={tab.key}>
              {tab.pinned ? 'Pinned · ' : ''}{tab.title}
              {tab.mentionCount ? ` · ${tab.mentionCount} mentions` : tab.unreadCount ? ` · ${tab.unreadCount} unread` : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-none items-center" role="toolbar" aria-label="Active tab actions">
        <IconButton
          size="sm"
          aria-label={activeTab?.pinned ? 'Unpin active conversation' : 'Pin active conversation'}
          aria-keyshortcuts="Control+Shift+P Meta+Shift+P"
          disabled={!activeTab}
          onClick={() => {
            if (activeTab) onChange(setRoomTabPinned(state, activeTab.key, !activeTab.pinned))
          }}
        >
          <Icon name="pin" size="xs" />
        </IconButton>
        <IconButton
          size="sm"
          aria-label="Close active conversation"
          aria-keyshortcuts="Delete"
          disabled={!activeTab}
          onClick={() => {
            if (!activeTab) return
            const next = closeRoomTab(state, activeTab.key)
            onChange(next)
            focusTab(next.activeKey)
          }}
        >
          <Icon name="x" size="xs" />
        </IconButton>
        <IconButton
          size="sm"
          aria-label="Reopen closed conversation"
          aria-keyshortcuts="Control+Shift+T Meta+Shift+T"
          disabled={state.recentlyClosed.length === 0}
          onClick={() => {
            const next = reopenRoomTab(state)
            onChange(next)
            focusTab(next.activeKey)
          }}
        >
          <Icon name="refresh" size="xs" />
        </IconButton>
      </div>
    </div>
  )
}
