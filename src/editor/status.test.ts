import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { createEditorState, editorReducer } from '../layout/history'
import { updateFurniture } from '../layout/operations'
import { serializeLayout } from '../layout/storage'
import { saveStatus } from './status'

const nudge = { type: 'edit' as const, update: (l: ReturnType<typeof createDefaultLayout>) => updateFurniture(l, 'plant-01', { x: -8 }) }

describe('saveStatus', () => {
  it('shows the default layout as not saved until it is edited', () => {
    const s = createEditorState(createDefaultLayout(), null)
    expect(saveStatus(s, false)).toBe('default')
    expect(saveStatus(editorReducer(s, nudge), false)).toBe('unsaved')
  })

  it('is saved when the layout matches what was stored', () => {
    const layout = createDefaultLayout()
    const s = createEditorState(layout, serializeLayout(layout))
    expect(saveStatus(s, false)).toBe('saved')
    expect(saveStatus(editorReducer(s, nudge), false)).toBe('unsaved')
  })

  it('reports a failed save only while changes are still unsaved', () => {
    const layout = createDefaultLayout()
    const s = editorReducer(createEditorState(layout, serializeLayout(layout)), nudge)
    expect(saveStatus(s, true)).toBe('save-failed')
    expect(saveStatus(editorReducer(s, { type: 'undo' }), true)).toBe('saved')
  })
})
