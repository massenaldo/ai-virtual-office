export const LAYOUT_SCHEMA_VERSION = 1

/** Quarter turns around the vertical axis, in degrees. */
export type Rotation = 0 | 90 | 180 | 270

export type DepartmentId = 'executive' | 'project-management' | 'tech-lead' | 'backend' | 'frontend' | 'data' | 'design' | 'qa' | 'meeting' | 'devops'

export type FurnitureType = 'desk' | 'chair' | 'monitor' | 'plant' | 'meeting-table'

/** Footprint fields (x, z, width, depth) live on the floor plane; wallHeight is the only vertical value. */
export type Room = { id: string; name: string; department: DepartmentId; x: number; z: number; width: number; depth: number; wallHeight: number; color: string }

/** x and z are the footprint centre. roomId null means open floor. */
export type Furniture = { id: string; type: FurnitureType; x: number; z: number; rotation: Rotation; roomId: string | null }

export type OfficeSettings = { width: number; depth: number; gridSize: number }

export type OfficeLayout = { schemaVersion: typeof LAYOUT_SCHEMA_VERSION; office: OfficeSettings; rooms: Room[]; furniture: Furniture[] }

export type Selection = { kind: 'room' | 'furniture'; id: string } | null
