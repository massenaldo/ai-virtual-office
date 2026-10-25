import { isDirty, type EditorState } from '../layout/history'

export type SaveStatus = 'saved' | 'unsaved' | 'save-failed' | 'default'

export const SAVE_STATUS_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  'save-failed': 'Save failed',
  default: 'Default layout (not saved)',
}

export function saveStatus(state: EditorState, lastSaveFailed: boolean): SaveStatus {
  if (state.savedJson === null && state.past.length === 0) return 'default'
  if (!isDirty(state)) return 'saved'
  return lastSaveFailed ? 'save-failed' : 'unsaved'
}
