import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from './defaultLayout'
import { clampFurniture, clampRoom, furnitureRect, nextRotation, rectsOverlap, roomAt, rotateOffset, snap } from './geometry'
import type { Furniture } from './types'

const layout = createDefaultLayout()
const ceo = layout.rooms.find((r) => r.id === 'room-ceo-office')!

describe('snap', () => {
  it('rounds to the nearest grid step', () => {
    expect(snap(1.13, 0.25)).toBe(1.25)
    expect(snap(-0.6, 0.25)).toBe(-0.5)
  })
})

describe('rotation helpers', () => {
  it('rotates local offsets by quarter turns', () => {
    const r = rotateOffset(0, 0.56, 180)
    expect(r.dx).toBeCloseTo(0)
    expect(r.dz).toBeCloseTo(-0.56)
    const q = rotateOffset(0, 1, 90)
    expect(Math.abs(q.dx)).toBeCloseTo(1)
    expect(q.dz).toBeCloseTo(0)
  })

  it('advances 90 degrees and wraps', () => {
    expect(nextRotation(0)).toBe(90)
    expect(nextRotation(270)).toBe(0)
  })
})

describe('footprints', () => {
  it('swaps width and depth for quarter-turned furniture', () => {
    const desk: Furniture = { id: 'd', type: 'desk', x: 0, z: 0, rotation: 90, roomId: null }
    const r = furnitureRect(desk)
    expect(r.maxX - r.minX).toBeCloseTo(0.72)
    expect(r.maxZ - r.minZ).toBeCloseTo(1.35)
  })

  it('does not count touching edges as overlap', () => {
    expect(rectsOverlap({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, { minX: 1, maxX: 2, minZ: 0, maxZ: 1 })).toBe(false)
    expect(rectsOverlap({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, { minX: 0.5, maxX: 2, minZ: 0.5, maxZ: 1 })).toBe(true)
  })
})

describe('roomAt', () => {
  it('finds the room containing a point, or null for open floor', () => {
    expect(roomAt(layout, -7.4, -4.4)).toBe('room-ceo-office')
    expect(roomAt(layout, 0, 7)).toBeNull()
  })

  it('agrees with every default furniture roomId', () => {
    for (const f of layout.furniture) expect([f.id, roomAt(layout, f.x, f.z)]).toEqual([f.id, f.roomId])
  })
})

describe('clampRoom', () => {
  it('keeps the previous value when a field is not finite', () => {
    expect(clampRoom({ ...ceo, width: NaN }, layout.office, ceo).width).toBe(ceo.width)
    expect(clampRoom({ ...ceo, x: Infinity }, layout.office, ceo).x).toBe(ceo.x)
  })

  it('enforces dimension limits', () => {
    expect(clampRoom({ ...ceo, width: 50 }, layout.office).width).toBe(12)
    expect(clampRoom({ ...ceo, depth: 0.5 }, layout.office).depth).toBe(2)
  })

  it('keeps the footprint inside the office', () => {
    const r = clampRoom({ ...ceo, x: 100, z: -100 }, layout.office)
    expect(r.x).toBeCloseTo(12.5 - ceo.width / 2)
    expect(r.z).toBeCloseTo(-10 + ceo.depth / 2)
  })
})

describe('clampFurniture', () => {
  it('keeps furniture inside the office and finite', () => {
    const desk = layout.furniture[0]
    const out = clampFurniture({ ...desk, x: 99, z: NaN }, layout.office, desk)
    expect(out.x + 1.35 / 2).toBeLessThanOrEqual(12.5)
    expect(out.x).toBeGreaterThan(12.5 - 1.35 / 2 - 0.011)
    expect(out.z).toBe(desk.z)
  })
})
