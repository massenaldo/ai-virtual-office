import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import type { OfficeLayout } from '../layout/types'
import { breakSpots, QIBLA_ROTATION } from './breakSpots'
import { ownerOffice, ownerOfficeWithoutBreaks } from './layoutFixtures'

describe('breakSpots', () => {
  it('finds a spot per chair, mat and counter place in the default office', () => {
    const layout = createDefaultLayout()
    const spots = breakSpots(layout)
    expect(spots.dining).toHaveLength(layout.furniture.filter((f) => f.type === 'dining-chair').length)
    expect(spots.prayer).toHaveLength(layout.furniture.filter((f) => f.type === 'prayer-mat').length)
    expect(spots.coffee).toHaveLength(9)
    expect(spots.dining.every((s) => s.pose === 'sit')).toBe(true)
    expect([...spots.coffee, ...spots.prayer].every((s) => s.pose === 'stand')).toBe(true)
  })

  it('stands at the counter 0.55 m south of it, 0.7 m apart, facing it', () => {
    const layout = createDefaultLayout()
    const counter = layout.furniture.find((f) => f.type === 'kitchen-counter')!
    const spots = breakSpots(layout).coffee.slice(0, 3)
    expect(spots.map((s) => s.z)).toEqual([counter.z + 0.55, counter.z + 0.55, counter.z + 0.55].map((z) => expect.closeTo(z, 5)))
    expect(spots.map((s) => s.x).sort((a, b) => a - b)).toEqual([counter.x - 0.7, counter.x, counter.x + 0.7].map((x) => expect.closeTo(x, 5)))
    expect(spots.every((s) => s.rotation === 0)).toBe(true)
  })

  it('turns the standing places with the counter', () => {
    const layout = createDefaultLayout()
    const turned: OfficeLayout = { ...layout, furniture: layout.furniture.map((f) => (f.type === 'kitchen-counter' ? { ...f, rotation: 90 } : f)) }
    const counter = turned.furniture.find((f) => f.type === 'kitchen-counter')!
    const spots = breakSpots(turned).coffee.slice(0, 3)
    // The front of a counter turned 90 degrees faces east, so people stand east of it, looking west (+90).
    expect(spots.length).toBeGreaterThan(0)
    for (const s of spots) {
      expect(s.x).toBeCloseTo(counter.x + 0.55, 5)
      expect(s.rotation).toBe(90)
    }
  })

  it('sits on each dining chair with the chair rotation', () => {
    const layout = createDefaultLayout()
    const chairs = layout.furniture.filter((f) => f.type === 'dining-chair')
    breakSpots(layout).dining.forEach((s, i) => expect(s).toMatchObject({ x: chairs[i].x, z: chairs[i].z, rotation: chairs[i].rotation, pose: 'sit' }))
  })

  it('stands on each mat facing the qibla', () => {
    const layout = createDefaultLayout()
    const mats = layout.furniture.filter((f) => f.type === 'prayer-mat')
    const spots = breakSpots(layout).prayer
    expect(spots).toHaveLength(mats.length)
    spots.forEach((s, i) => expect(s).toMatchObject({ x: mats[i].x, z: mats[i].z, rotation: QIBLA_ROTATION }))
    // Forward is (-sin r, -cos r) with -Z as north and +X as east: its bearing from north, clockwise, is about 295 degrees.
    const r = (QIBLA_ROTATION * Math.PI) / 180
    const dx = -Math.sin(r)
    const dz = -Math.cos(r)
    const bearing = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360
    expect(bearing).toBeGreaterThan(293)
    expect(bearing).toBeLessThan(297)
  })

  it('finds none with no break rooms, and a spot per chair in the compact row', () => {
    expect(breakSpots(ownerOfficeWithoutBreaks())).toEqual({ coffee: [], dining: [], prayer: [] })
    const spots = breakSpots(ownerOffice())
    expect(spots.coffee.length).toBeGreaterThanOrEqual(2)
    expect(spots.dining).toHaveLength(4)
    expect(spots.prayer).toHaveLength(4)
  })

  it('ignores a chair or a mat that is not in a room of the right kind', () => {
    const layout = createDefaultLayout()
    const stray = [{ id: 'x1', type: 'dining-chair' as const, x: 9, z: -9, rotation: 0 as const, roomId: null }, { id: 'x2', type: 'prayer-mat' as const, x: 9, z: -9.5, rotation: 0 as const, roomId: null }, { id: 'x3', type: 'kitchen-counter' as const, x: 9, z: -9.5, rotation: 0 as const, roomId: null }]
    const base = breakSpots(layout)
    const withStray = breakSpots({ ...layout, furniture: [...layout.furniture, ...stray] })
    expect(withStray.dining).toHaveLength(base.dining.length)
    expect(withStray.prayer).toHaveLength(base.prayer.length)
    expect(withStray.coffee).toHaveLength(base.coffee.length)
  })
})
