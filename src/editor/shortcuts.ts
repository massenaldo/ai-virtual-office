import { useEffect, useRef } from 'react'

type KeyTarget = { tagName?: string; isContentEditable?: boolean } | null
type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; target: unknown }

export type ShortcutAction = 'undo' | 'redo' | 'delete' | 'escape' | null

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function isTypingTarget(target: KeyTarget): boolean {
  return !!target && (TYPING_TAGS.has(target.tagName ?? '') || !!target.isContentEditable)
}

/** Editor shortcuts only apply in edit mode and never while the user is typing in a field. */
export function matchShortcut(e: KeyLike, editing: boolean): ShortcutAction {
  if (!editing || isTypingTarget(e.target as KeyTarget)) return null
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (e.metaKey || e.ctrlKey) return null
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete'
  if (e.key === 'Escape') return 'escape'
  return null
}

export function useEditorShortcuts(editing: boolean, handlers: Record<Exclude<ShortcutAction, null>, () => void>): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = matchShortcut(e, editing)
      if (!action) return
      e.preventDefault()
      latest.current[action]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing])
}
