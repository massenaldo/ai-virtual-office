import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from './defaultLayout'
import type { FurnitureType } from './types'

describe('createDefaultLayout', () => {
  it('converts the existing scene into versioned layout data', () => {
    const l = createDefaultLayout()
    expect(l.schemaVersion).toBe(1)
    expect(l.office).toEqual({ width: 25, depth: 20, gridSize: 0.25 })
    expect(l.rooms).toHaveLength(10)
  })

  it('splits each desk into desk, chair and monitor and keeps plants and the meeting table', () => {
    const l = createDefaultLayout()
    const count = (t: FurnitureType) => l.furniture.filter((f) => f.type === t).length
    expect([count('desk'), count('chair'), count('monitor'), count('plant'), count('meeting-table')]).toEqual([14, 14, 14, 11, 1])
  })

  it('uses unique stable ids', () => {
    const l = createDefaultLayout()
    const ids = [...l.rooms, ...l.furniture].map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps existing room geometry and assigns furniture to rooms', () => {
    const l = createDefaultLayout()
    expect(l.rooms.find((r) => r.id === 'room-ceo-office')).toMatchObject({ x: -7.1, z: -4.3, width: 4.5, depth: 3.6, wallHeight: 2.5 })
    expect(l.furniture.find((f) => f.id === 'desk-01')?.roomId).toBe('room-ceo-office')
  })

  it('places chairs and monitors relative to rotated desks', () => {
    const l = createDefaultLayout()
    const byId = (id: string) => l.furniture.find((f) => f.id === id)!
    expect(byId('chair-01')).toMatchObject({ x: -7.4, rotation: 0 })
    expect(byId('chair-01').z).toBeCloseTo(-4.4 + 0.56)
    expect(byId('monitor-01').z).toBeCloseTo(-4.4 - 0.18)
    expect(byId('desk-09')).toMatchObject({ x: -7.5, z: -1.8, rotation: 180 })
    expect(byId('chair-09').z).toBeCloseTo(-1.8 - 0.56)
  })

  it('returns a fresh object each call', () => {
    expect(createDefaultLayout()).not.toBe(createDefaultLayout())
  })
})
