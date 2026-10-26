import { DEFAULT_WALL_HEIGHT, DEPARTMENTS } from './catalog'
import { LAYOUT_SCHEMA_VERSION, type DepartmentId, type Furniture, type OfficeLayout, type Room } from './types'

const ROOMS: [id: string, name: string, department: DepartmentId, x: number, z: number, width: number, depth: number][] = [
  ['room-ceo-office', 'CEO OFFICE', 'executive', -7.1, -4.3, 4.5, 3.6],
  ['room-project-management', 'PROJECT MANAGEMENT', 'project-management', -2.1, -4.3, 4.4, 3.6],
  ['room-tech-lead', 'TECH LEAD', 'tech-lead', 2.5, -4.3, 3.7, 3.6],
  ['room-backend', 'BACKEND ENGINEERING', 'backend', 7.0, -5.0, 4.3, 2.4],
  ['room-frontend', 'FRONTEND ENGINEERING', 'frontend', 7.0, -2.2, 4.3, 2.4],
  ['room-data', 'DATA & DATABASE', 'data', 7.0, 0.6, 4.3, 2.4],
  ['room-design', 'UI/UX DESIGN', 'design', 7.0, 3.4, 4.3, 2.4],
  ['room-qa', 'QA TESTING', 'qa', 7.0, 6.2, 4.3, 2.4],
  ['room-meeting', 'MEETING ROOM', 'meeting', -3.9, 2.2, 4.6, 3.6],
  ['room-devops', 'DEVOPS / SERVER ROOM', 'devops', -8.0, 5.5, 3.8, 3.0],
]

// Desk workstations from the original scene: back row faces north, front row is turned 180°.
const DESKS: [x: number, z: number, rotation: 0 | 180, roomId: string | null][] = [
  [-7.4, -4.4, 0, 'room-ceo-office'], [-5.7, -4.4, 0, 'room-ceo-office'],
  [-2.7, -4.4, 0, 'room-project-management'], [-1.2, -4.4, 0, 'room-project-management'],
  [1.7, -4.4, 0, 'room-tech-lead'], [3.1, -4.4, 0, 'room-tech-lead'],
  [6.2, -4.9, 0, 'room-backend'], [7.6, -4.9, 0, 'room-backend'],
  [-7.5, -1.8, 180, null], [-5.8, -1.8, 180, null], [-2.8, -1.8, 180, null], [-1.2, -1.8, 180, null],
  [1.6, 1.4, 180, null], [3.0, 1.4, 180, null],
]

const PLANTS: [x: number, z: number][] = [[-8.7, -7.8], [-4.5, -7.8], [0, -7.8], [4.5, -7.8], [10.3, -5.9], [10.3, -3.1], [10.3, -0.3], [10.3, 2.5], [10.3, 5.3], [-9.8, 7.5], [1.2, 7.5]]

// Meeting room (centre −3.9, 2.2): table in the middle, three chairs along each long side facing it.
const MEETING_TABLE: [x: number, z: number] = [-3.9, 2.2]
const MEETING_CHAIRS: [x: number, z: number, rotation: 0 | 180][] = [
  [-4.8, 1.42, 180], [-3.9, 1.42, 180], [-3.0, 1.42, 180],
  [-4.8, 2.98, 0], [-3.9, 2.98, 0], [-3.0, 2.98, 0],
]

const CHAIR_OFFSET_Z = 0.56
const MONITOR_OFFSET_Z = -0.18

const pad = (n: number) => String(n).padStart(2, '0')
const round = (n: number) => Math.round(n * 100) / 100

export function createDefaultLayout(): OfficeLayout {
  const rooms: Room[] = ROOMS.map(([id, name, department, x, z, width, depth]) => ({ id, name, department, x, z, width, depth, wallHeight: DEFAULT_WALL_HEIGHT, color: DEPARTMENTS[department].color, rotation: 0 }))
  const furniture: Furniture[] = []
  DESKS.forEach(([x, z, rotation, roomId], i) => {
    const n = pad(i + 1)
    const facing = rotation === 180 ? -1 : 1
    furniture.push(
      { id: `desk-${n}`, type: 'desk', x, z, rotation, roomId },
      { id: `chair-${n}`, type: 'chair', x, z: round(z + CHAIR_OFFSET_Z * facing), rotation, roomId },
      { id: `monitor-${n}`, type: 'monitor', x, z: round(z + MONITOR_OFFSET_Z * facing), rotation, roomId },
    )
  })
  PLANTS.forEach(([x, z], i) => furniture.push({ id: `plant-${pad(i + 1)}`, type: 'plant', x, z, rotation: 0, roomId: null }))
  furniture.push({ id: 'meeting-table-01', type: 'meeting-table', x: MEETING_TABLE[0], z: MEETING_TABLE[1], rotation: 0, roomId: 'room-meeting' })
  MEETING_CHAIRS.forEach(([x, z, rotation], i) => furniture.push({ id: `meeting-chair-${pad(i + 1)}`, type: 'meeting-chair', x, z, rotation, roomId: 'room-meeting' }))
  // Storage along the solid left walls, turned to face into the room.
  furniture.push(
    { id: 'storage-cabinet-01', type: 'storage-cabinet', x: -9.0, z: -5.4, rotation: 90, roomId: 'room-ceo-office' },
    { id: 'shelf-01', type: 'shelf', x: -4.0, z: -5.3, rotation: 90, roomId: 'room-project-management' },
  )
  return { schemaVersion: LAYOUT_SCHEMA_VERSION, office: { width: 25, depth: 20, gridSize: 0.25 }, rooms, furniture }
}
