import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from './defaultLayout'
import { HISTORY_LIMIT, canUndo, createEditorState, editorReducer, isDirty, type EditorAction, type EditorState } from './history'
import { addRoom, updateFurniture, updateRoom } from './operations'
import { serializeLayout } from './storage'

const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s)
const start = () => createEditorState(createDefaultLayout(), null)
const nudge = (x: number): EditorAction => ({ type: 'edit', update: (l) => updateFurniture(l, 'plant-01', { x }) })

describe('editorReducer', () => {
  it('skips history for edits that change nothing', () => {
    const s = run(start(), { type: 'edit', update: (l) => l })
    expect(s.past).toHaveLength(0)
  })

  it('groups one whole drag into a single undo entry', () => {
    const drags: EditorAction[] = Array.from({ length: 30 }, (_, i) => ({ type: 'drag-update', update: (l) => updateRoom(l, 'room-ceo-office', { x: -7 + i * 0.01 }) }))
    const s = run(start(), { type: 'drag-start' }, ...drags, { type: 'drag-end' })
    expect(s.past).toHaveLength(1)
    expect(s.dragOrigin).toBeNull()
    expect(s.layout.rooms[0].x).toBeCloseTo(-6.71)
  })

  it('applies each drag update to the drag origin, not cumulatively', () => {
    const move = (dx: number): EditorAction => ({ type: 'drag-update', update: (l) => updateRoom(l, 'room-ceo-office', { x: l.rooms[0].x + dx }) })
    const s = run(start(), { type: 'drag-start' }, move(1), move(1))
    expect(s.layout.rooms[0].x).toBeCloseTo(-6.1)
  })

  it('restores the origin when a drag is cancelled', () => {
    const before = start()
    const s = run(before, { type: 'drag-start' }, nudge(3), { type: 'drag-update', update: (l) => updateFurniture(l, 'plant-01', { x: 3 }) }, { type: 'drag-cancel' })
    expect(s.layout).toBe(before.layout)
    expect(s.past).toHaveLength(0)
  })

  it('caps history at the limit', () => {
    const edits = Array.from({ length: HISTORY_LIMIT + 1 }, (_, i) => nudge(-8 + i * 0.05))
    expect(run(start(), ...edits).past).toHaveLength(HISTORY_LIMIT)
  })

  it('tracks dirty state through save, undo and redo', () => {
    let s = run(start(), nudge(-8))
    s = run(s, { type: 'saved', json: serializeLayout(s.layout) })
    expect(isDirty(s)).toBe(false)
    s = run(s, { type: 'undo' })
    expect(isDirty(s)).toBe(true)
    s = run(s, { type: 'redo' })
    expect(isDirty(s)).toBe(false)
  })

  it('clears redo after a new edit', () => {
    const s = run(start(), nudge(-8), { type: 'undo' }, nudge(-7))
    expect(s.future).toHaveLength(0)
  })

  it('drops a selection whose object disappears on undo', () => {
    let id = ''
    const s1 = run(start(), { type: 'edit', update: (l) => { const r = addRoom(l, 'meeting-room'); id = r.id; return r.layout } })
    const s2 = run(s1, { type: 'select', selection: { kind: 'room', id } })
    expect(s2.selection).toEqual({ kind: 'room', id })
    expect(run(s2, { type: 'undo' }).selection).toBeNull()
  })

  it('makes replace undoable', () => {
    const s = run(start(), nudge(-8))
    const replaced = run(s, { type: 'replace', layout: createDefaultLayout() })
    expect(run(replaced, { type: 'undo' }).layout).toBe(s.layout)
  })

  it('ignores undo while dragging', () => {
    const s = run(start(), nudge(-8), { type: 'drag-start' })
    expect(canUndo(s)).toBe(false)
    expect(run(s, { type: 'undo' })).toBe(s)
  })
})
