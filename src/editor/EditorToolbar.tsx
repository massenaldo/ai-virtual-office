import { Boxes, Grid3x3, LayoutGrid, PencilRuler, Redo2, LocateFixed, RotateCcw, Save, Undo2 } from 'lucide-react'
import { SAVE_STATUS_LABEL, type SaveStatus } from './status'

export type EditorToolbarProps = {
  editing: boolean
  floorPlan: boolean
  snap: boolean
  canUndo: boolean
  canRedo: boolean
  status: SaveStatus
  onToggleEditing(): void
  onFloorPlan(value: boolean): void
  onToggleSnap(): void
  onUndo(): void
  onRedo(): void
  onSave(): void
  onResetLayout(): void
  onResetView(): void
}

export default function EditorToolbar(p: EditorToolbarProps) {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
  return <div className="scene-controls">
    <button className={p.editing ? 'view-button editing' : 'view-button'} onClick={p.onToggleEditing} aria-pressed={p.editing}><PencilRuler size={15}/> {p.editing ? 'Done editing' : 'Edit layout'}</button>
    <span className="toolbar-divider"/>
    <button className={!p.floorPlan ? 'view-button selected' : 'view-button'} onClick={() => p.onFloorPlan(false)}><Boxes size={15}/> 3D view</button>
    <button className={p.floorPlan ? 'view-button selected' : 'view-button'} onClick={() => p.onFloorPlan(true)}><LayoutGrid size={15}/> Floor plan</button>
    {p.editing && <>
      {p.floorPlan && <button className={p.snap ? 'view-button selected' : 'view-button'} onClick={p.onToggleSnap} aria-pressed={p.snap} title="Snap to a 0.25 m grid"><Grid3x3 size={15}/> Snap</button>}
      <span className="toolbar-divider"/>
      <button className="square-button" onClick={p.onUndo} disabled={!p.canUndo} title={`Undo (${mod}Z)`} aria-label="Undo"><Undo2 size={16}/></button>
      <button className="square-button" onClick={p.onRedo} disabled={!p.canRedo} title={`Redo (${mod}Shift+Z)`} aria-label="Redo"><Redo2 size={16}/></button>
      <button className="view-button" onClick={p.onResetLayout}><RotateCcw size={15}/> Reset layout</button>
    </>}
    <span className="toolbar-divider"/>
    <span className={`save-chip ${p.status}`} role="status"><span className="save-chip-dot"/>{SAVE_STATUS_LABEL[p.status]}</span>
    <button className="view-button" onClick={p.onSave} disabled={p.status === 'saved'}><Save size={15}/> Save</button>
    <button className="square-button" onClick={p.onResetView} title="Reset view" aria-label="Reset view"><LocateFixed size={16}/></button>
  </div>
}
