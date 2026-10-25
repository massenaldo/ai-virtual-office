import type { DepartmentId, FurnitureType } from './types'

export const DEPARTMENTS: Record<DepartmentId, { label: string; color: string }> = {
  executive: { label: 'Executive', color: '#9c7c59' },
  'project-management': { label: 'Project Management', color: '#a8b7a0' },
  'tech-lead': { label: 'Tech Lead', color: '#8ca9b5' },
  backend: { label: 'Backend Engineering', color: '#7898a7' },
  frontend: { label: 'Frontend Engineering', color: '#8daab7' },
  data: { label: 'Data & Database', color: '#6f8f9b' },
  design: { label: 'UI/UX Design', color: '#c4a58b' },
  qa: { label: 'QA Testing', color: '#b5a5a0' },
  meeting: { label: 'Meeting', color: '#b99b72' },
  devops: { label: 'DevOps', color: '#596a78' },
}

/** width runs along X and depth along Z at rotation 0. */
export const FURNITURE_SPECS: Record<FurnitureType, { label: string; width: number; depth: number; planColor: string }> = {
  desk: { label: 'Desk', width: 1.35, depth: 0.72, planColor: '#b78d61' },
  chair: { label: 'Chair', width: 0.48, depth: 0.48, planColor: '#303842' },
  monitor: { label: 'Monitor', width: 0.48, depth: 0.1, planColor: '#222a33' },
  plant: { label: 'Plant', width: 0.56, depth: 0.56, planColor: '#53775d' },
  'meeting-table': { label: 'Meeting table', width: 2.7, depth: 1.15, planColor: '#b88e61' },
}

export type RoomTemplateId = 'office' | 'team-room' | 'meeting-room'

export const ROOM_TEMPLATES: { id: RoomTemplateId; label: string; width: number; depth: number; department: DepartmentId }[] = [
  { id: 'office', label: 'Private office', width: 4.5, depth: 3.6, department: 'executive' },
  { id: 'team-room', label: 'Team room', width: 4.3, depth: 2.4, department: 'backend' },
  { id: 'meeting-room', label: 'Meeting room', width: 4.6, depth: 3.6, department: 'meeting' },
]

export const ROOM_LIMITS = { minWidth: 2, maxWidth: 12, minDepth: 2, maxDepth: 10 }

export const DEFAULT_WALL_HEIGHT = 2.5
