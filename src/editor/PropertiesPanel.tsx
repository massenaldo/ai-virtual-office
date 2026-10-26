import { useEffect, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, Copy, RotateCw, Trash2 } from 'lucide-react'
import { DEPARTMENTS, FURNITURE_SPECS, ROOM_LIMITS } from '../layout/catalog'
import type { DepartmentId, Furniture, OfficeLayout, Room, Rotation, Selection } from '../layout/types'
import type { Issue } from '../layout/validation'
import { parseNumberInput } from './fields'

export type PropertiesPanelProps = {
  layout: OfficeLayout
  selection: Selection
  issues: Map<string, Issue[]>
  onRoomChange(id: string, patch: Partial<Omit<Room, 'id'>>): void
  onFurnitureChange(id: string, patch: Partial<Omit<Furniture, 'id' | 'type'>>): void
  onRotate(id: string): void
  onRotateRoom(id: string): void
  onDuplicate(id: string): void
  onDelete(): void
}

const format = (n: number) => String(Math.round(n * 100) / 100)
const ROTATIONS: Rotation[] = [0, 90, 180, 270]

/** Text input that applies on Enter or blur and reverts on Escape or invalid input. */
function DraftInput({ value, onCommit, label, numeric }: { value: string; onCommit(text: string): void; label: string; numeric?: boolean }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft !== value) onCommit(draft)
    setDraft(value)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      setDraft(value)
      requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
    }
  }
  return <input className="field-input" aria-label={label} value={draft} inputMode={numeric ? 'decimal' : undefined} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKeyDown}/>
}

function NumberField({ label, unit = 'm', value, onCommit }: { label: string; unit?: string; value: number; onCommit(v: number): void }) {
  return <label className="field"><span>{label}</span><div className="field-unit"><DraftInput label={label} numeric value={format(value)} onCommit={(text) => { const v = parseNumberInput(text); if (v !== null) onCommit(v) }}/><small>{unit}</small></div></label>
}

function Issues({ list }: { list?: Issue[] }) {
  if (!list?.length) return null
  return <ul className="issue-list">{list.map((issue, i) => <li key={i}><AlertTriangle size={12}/>{issue.message}</li>)}</ul>
}

export default function PropertiesPanel(p: PropertiesPanelProps) {
  const { layout, selection } = p
  const room = selection?.kind === 'room' ? layout.rooms.find((r) => r.id === selection.id) : undefined
  const item = selection?.kind === 'furniture' ? layout.furniture.find((f) => f.id === selection.id) : undefined

  if (room) return <aside className="editor-panel properties" aria-label="Room properties">
    <div className="panel-title">Room <small>{room.id}</small></div>
    <label className="field"><span>Name</span><DraftInput label="Name" value={room.name} onCommit={(name) => p.onRoomChange(room.id, { name })}/></label>
    <label className="field"><span>Department</span>
      <select className="field-input" value={room.department} onChange={(e) => p.onRoomChange(room.id, { department: e.target.value as DepartmentId })}>
        {(Object.keys(DEPARTMENTS) as DepartmentId[]).map((id) => <option key={id} value={id}>{DEPARTMENTS[id].label}</option>)}
      </select>
    </label>
    <div className="field-group-label">Footprint centre (floor plane)</div>
    <div className="field-row"><NumberField label="X" value={room.x} onCommit={(x) => p.onRoomChange(room.id, { x })}/><NumberField label="Z" value={room.z} onCommit={(z) => p.onRoomChange(room.id, { z })}/></div>
    <div className="field-group-label">Size ({ROOM_LIMITS.minWidth}–{ROOM_LIMITS.maxWidth} m wide, {ROOM_LIMITS.minDepth}–{ROOM_LIMITS.maxDepth} m deep)</div>
    <div className="field-row"><NumberField label="Width" value={room.width} onCommit={(width) => p.onRoomChange(room.id, { width })}/><NumberField label="Depth" value={room.depth} onCommit={(depth) => p.onRoomChange(room.id, { depth })}/></div>
    <div className="field-static"><span>Wall height</span><strong>{format(room.wallHeight)} m</strong></div>
    <Issues list={p.issues.get(room.id)}/>
    <div className="panel-actions">
      <button className="panel-button" onClick={() => p.onRotateRoom(room.id)}><RotateCw size={13}/> Rotate 90°</button>
      <button className="panel-button danger" onClick={p.onDelete}><Trash2 size={13}/> Delete room</button>
    </div>
  </aside>

  if (item) return <aside className="editor-panel properties" aria-label="Furniture properties">
    <div className="panel-title">{FURNITURE_SPECS[item.type].label} <small>{item.id}</small></div>
    <div className="field-group-label">Position (floor plane)</div>
    <div className="field-row"><NumberField label="X" value={item.x} onCommit={(x) => p.onFurnitureChange(item.id, { x })}/><NumberField label="Z" value={item.z} onCommit={(z) => p.onFurnitureChange(item.id, { z })}/></div>
    <label className="field"><span>Rotation</span>
      <select className="field-input" value={item.rotation} onChange={(e) => p.onFurnitureChange(item.id, { rotation: Number(e.target.value) as Rotation })}>
        {ROTATIONS.map((r) => <option key={r} value={r}>{r}°</option>)}
      </select>
    </label>
    <label className="field"><span>Room</span>
      <select className="field-input" value={item.roomId ?? ''} onChange={(e) => p.onFurnitureChange(item.id, { roomId: e.target.value || null })}>
        <option value="">Open floor</option>
        {layout.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    </label>
    <Issues list={p.issues.get(item.id)}/>
    <div className="panel-actions">
      <button className="panel-button" onClick={() => p.onRotate(item.id)}><RotateCw size={13}/> Rotate 90°</button>
      <button className="panel-button" onClick={() => p.onDuplicate(item.id)}><Copy size={13}/> Duplicate</button>
      <button className="panel-button danger" onClick={p.onDelete}><Trash2 size={13}/> Delete</button>
    </div>
  </aside>

  return <aside className="editor-panel properties empty" aria-label="Properties">
    <div className="panel-title">Properties</div>
    <p className="panel-hint">Select a room or furniture item in the scene or the list to edit it.</p>
    <ul className="shortcut-list">
      <li><kbd>Delete</kbd> remove selection</li>
      <li><kbd>Esc</kbd> clear selection</li>
      <li><kbd>⌘/Ctrl Z</kbd> undo · <kbd>⇧</kbd> redo</li>
    </ul>
  </aside>
}
