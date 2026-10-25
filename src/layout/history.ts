import { serializeLayout } from './storage'
import type { OfficeLayout, Selection } from './types'

export const HISTORY_LIMIT = 100

export type EditorState = { layout: OfficeLayout; past: OfficeLayout[]; future: OfficeLayout[]; dragOrigin: OfficeLayout | null; savedJson: string | null; selection: Selection }

export type EditorAction =
  | { type: 'edit'; update: (l: OfficeLayout) => OfficeLayout; select?: Selection }
  | { type: 'drag-start' }
  | { type: 'drag-update'; update: (l: OfficeLayout) => OfficeLayout }
  | { type: 'drag-end' }
  | { type: 'drag-cancel' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; selection: Selection }
  | { type: 'saved'; json: string }
  | { type: 'replace'; layout: OfficeLayout }

export function createEditorState(layout: OfficeLayout, savedJson: string | null): EditorState {
  return { layout, past: [], future: [], dragOrigin: null, savedJson, selection: null }
}

export const isDirty = (s: EditorState) => serializeLayout(s.layout) !== s.savedJson
export const canUndo = (s: EditorState) => s.past.length > 0 && !s.dragOrigin
export const canRedo = (s: EditorState) => s.future.length > 0 && !s.dragOrigin

function exists(layout: OfficeLayout, selection: Selection): boolean {
  if (!selection) return true
  const list = selection.kind === 'room' ? layout.rooms : layout.furniture
  return list.some((o) => o.id === selection.id)
}

function withLayout(s: EditorState, layout: OfficeLayout, selection: Selection = s.selection): EditorState {
  return { ...s, layout, selection: exists(layout, selection) ? selection : null }
}

function commit(s: EditorState, previous: OfficeLayout, next: OfficeLayout, selection?: Selection): EditorState {
  if (next === previous) return selection === undefined ? s : withLayout(s, s.layout, selection)
  return { ...withLayout(s, next, selection), past: [...s.past, previous].slice(-HISTORY_LIMIT), future: [] }
}

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case 'edit':
      // Edits during a drag are ignored so one drag always stays one undo step.
      return s.dragOrigin ? s : commit(s, s.layout, a.update(s.layout), a.select)
    case 'replace':
      return s.dragOrigin ? s : commit(s, s.layout, a.layout)
    case 'drag-start':
      return s.dragOrigin ? s : { ...s, dragOrigin: s.layout }
    case 'drag-update':
      return s.dragOrigin ? withLayout(s, a.update(s.dragOrigin)) : s
    case 'drag-end':
      if (!s.dragOrigin) return s
      return s.layout === s.dragOrigin ? { ...s, dragOrigin: null } : { ...s, dragOrigin: null, past: [...s.past, s.dragOrigin].slice(-HISTORY_LIMIT), future: [] }
    case 'drag-cancel':
      return s.dragOrigin ? { ...withLayout(s, s.dragOrigin), dragOrigin: null } : s
    case 'undo':
      if (!canUndo(s)) return s
      return { ...withLayout(s, s.past[s.past.length - 1]), past: s.past.slice(0, -1), future: [s.layout, ...s.future] }
    case 'redo':
      if (!canRedo(s)) return s
      return { ...withLayout(s, s.future[0]), past: [...s.past, s.layout], future: s.future.slice(1) }
    case 'select':
      return withLayout(s, s.layout, a.selection)
    case 'saved':
      return { ...s, savedJson: a.json }
  }
}
