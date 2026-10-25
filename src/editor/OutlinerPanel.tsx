import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { FURNITURE_SPECS, ROOM_TEMPLATES, type RoomTemplateId } from '../layout/catalog'
import type { Furniture, FurnitureType, OfficeLayout, Selection } from '../layout/types'
import type { Issue } from '../layout/validation'

export type OutlinerPanelProps = {
  layout: OfficeLayout
  selection: Selection
  issues: Map<string, Issue[]>
  onSelect(selection: Selection): void
  onAddRoom(template: RoomTemplateId): void
  onAddFurniture(type: FurnitureType): void
}

const OPEN_FLOOR = '__open-floor'
const FURNITURE_TYPES = Object.keys(FURNITURE_SPECS) as FurnitureType[]

export default function OutlinerPanel({ layout, selection, issues, onSelect, onAddRoom, onAddFurniture }: OutlinerPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const selectedFurniture = selection?.kind === 'furniture' ? layout.furniture.find((f) => f.id === selection.id) : undefined
  // The group holding the selected furniture is always open so the selection is visible in the list.
  const isOpen = (groupId: string) => expanded.has(groupId) || (selectedFurniture !== undefined && (selectedFurniture.roomId ?? OPEN_FLOOR) === groupId)
  const toggle = (groupId: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    return next
  })
  const byGroup = new Map<string, Furniture[]>()
  for (const f of layout.furniture) byGroup.set(f.roomId ?? OPEN_FLOOR, [...(byGroup.get(f.roomId ?? OPEN_FLOOR) ?? []), f])

  const furnitureRows = (groupId: string) => isOpen(groupId) && (byGroup.get(groupId) ?? []).map((f) =>
    <button key={f.id} className={`outline-row child${selection?.id === f.id ? ' selected' : ''}`} onClick={() => onSelect({ kind: 'furniture', id: f.id })}>
      <span className="outline-swatch small" style={{ background: FURNITURE_SPECS[f.type].planColor }}/>
      <span className="outline-name">{FURNITURE_SPECS[f.type].label}</span>
      {issues.has(f.id) && <AlertTriangle size={12} className="outline-warning"/>}
      <small>{f.id}</small>
    </button>)

  return <aside className="editor-panel outliner" aria-label="Rooms and furniture">
    <div className="panel-title">Rooms <small>{layout.rooms.length}</small></div>
    <div className="outline-list">
      {layout.rooms.map((room) => <div key={room.id}>
        <div className={`outline-row${selection?.id === room.id ? ' selected' : ''}`}>
          <button className="outline-toggle" onClick={() => toggle(room.id)} aria-label={isOpen(room.id) ? 'Collapse' : 'Expand'}>{isOpen(room.id) ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
          <button className="outline-main" onClick={() => onSelect({ kind: 'room', id: room.id })}>
            <span className="outline-swatch" style={{ background: room.color }}/>
            <span className="outline-name">{room.name}</span>
            {issues.has(room.id) && <AlertTriangle size={12} className="outline-warning"/>}
            <small>{byGroup.get(room.id)?.length ?? 0}</small>
          </button>
        </div>
        {furnitureRows(room.id)}
      </div>)}
      <div className="outline-row">
        <button className="outline-toggle" onClick={() => toggle(OPEN_FLOOR)} aria-label={isOpen(OPEN_FLOOR) ? 'Collapse' : 'Expand'}>{isOpen(OPEN_FLOOR) ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
        <button className="outline-main" onClick={() => toggle(OPEN_FLOOR)}><span className="outline-name muted">Open floor</span><small>{byGroup.get(OPEN_FLOOR)?.length ?? 0}</small></button>
      </div>
      {furnitureRows(OPEN_FLOOR)}
    </div>
    <div className="panel-title">Add room</div>
    <div className="palette">{ROOM_TEMPLATES.map((t) => <button key={t.id} className="palette-button" onClick={() => onAddRoom(t.id)}><Plus size={12}/>{t.label}<small>{t.width} × {t.depth} m</small></button>)}</div>
    <div className="panel-title">Add furniture</div>
    <div className="palette">{FURNITURE_TYPES.map((type) => <button key={type} className="palette-button" onClick={() => onAddFurniture(type)}><span className="outline-swatch small" style={{ background: FURNITURE_SPECS[type].planColor }}/>{FURNITURE_SPECS[type].label}</button>)}</div>
  </aside>
}
