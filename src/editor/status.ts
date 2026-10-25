import { createDefaultLayout } from '../layout/defaultLayout'
import { isDirty, type EditorState } from '../layout/history'
import { serializeLayout } from '../layout/storage'

export type SaveStatus = 'saved' | 'unsaved' | 'save-failed' | 'default'

export const SAVE_STATUS_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  'save-failed': 'Save failed',
  default: 'Default layout (not saved)',
}

const DEFAULT_JSON = serializeLayout(createDefaultLayout())

export function saveStatus(state: EditorState, lastSaveFailed: boolean): SaveStatus {
  // With nothing saved yet, the untouched default layout has nothing to lose.
  if (state.savedJson === null && serializeLayout(state.layout) === DEFAULT_JSON) return 'default'
  if (!isDirty(state)) return 'saved'
  return lastSaveFailed ? 'save-failed' : 'unsaved'
}

/** True when leaving now would lose edits that Save would keep. */
export function hasUnsavedChanges(status: SaveStatus): boolean {
  return status === 'unsaved' || status === 'save-failed'
}
