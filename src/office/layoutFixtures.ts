import { DEFAULT_WALL_HEIGHT, DEPARTMENTS } from '../layout/catalog'
import { withBreakAreasIfTheyFit } from '../layout/breakAreas'
import { LAYOUT_SCHEMA_VERSION, type Furniture, type OfficeLayout, type Room } from '../layout/types'

// Layouts shared by the tests in this folder.

/** The owner's real office: one 5.5 x 3.6 m room at (-9.75, -8.2) with two desks turned 180 degrees, before any break rooms. */
export function ownerOfficeWithoutBreaks(): OfficeLayout {
  const room: Room = { id: 'room-exec', name: 'EXEC', department: 'executive', x: -9.75, z: -8.2, width: 5.5, depth: 3.6, wallHeight: DEFAULT_WALL_HEIGHT, color: DEPARTMENTS.executive.color, rotation: 0 }
  const furniture: Furniture[] = []
  ;[-11.0, -8.5].forEach((x, i) => {
    const n = `0${i + 1}`
    furniture.push(
      { id: `desk-${n}`, type: 'desk', x, z: -7.4, rotation: 180, roomId: room.id },
      { id: `chair-${n}`, type: 'chair', x, z: -7.96, rotation: 180, roomId: room.id },
      { id: `monitor-${n}`, type: 'monitor', x, z: -7.22, rotation: 180, roomId: room.id },
    )
  })
  return { schemaVersion: LAYOUT_SCHEMA_VERSION, office: { width: 25, depth: 20, gridSize: 0.25 }, rooms: [room], furniture }
}

/** The owner's office with the compact kitchen, dining and prayer rooms beside it. */
export const ownerOffice = (): OfficeLayout => withBreakAreasIfTheyFit(ownerOfficeWithoutBreaks())
