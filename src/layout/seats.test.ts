import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from './defaultLayout'
import { seatForDesk } from './seats'
import type { Furniture, OfficeLayout, Rotation } from './types'

const desk = (rotation: Rotation): Furniture => ({ id: 'd', type: 'desk', x: 0, z: 0, rotation, roomId: null })
const chair = (x: number, z: number, type: Furniture['type'] = 'chair'): Furniture => ({ id: 'c', type, x, z, rotation: 0, roomId: null })
const layoutWith = (furniture: Furniture[]): OfficeLayout => ({ ...createDefaultLayout(), rooms: [], furniture })

describe('seatForDesk', () => {
  it.each([[0, 0, 0.56], [90, 0.56, 0], [180, 0, -0.56], [270, -0.56, 0]] as const)('with no chair, rotation %i stands at the seat point', (r, x, z) => {
    expect(seatForDesk(layoutWith([desk(r)]), desk(r))).toEqual({ x, z, rotation: r, seated: false })
  })

  it('sits in a chair moved within 0.9 m of the seat point', () => {
    const d = desk(0)
    expect(seatForDesk(layoutWith([d, chair(0.3, 0.9)]), d)).toEqual({ x: 0.3, z: 0.9, rotation: 0, seated: true })
  })

  it('does not use a chair further than 0.9 m away', () => {
    const d = desk(0)
    expect(seatForDesk(layoutWith([d, chair(0, 2)]), d).seated).toBe(false)
  })

  it('ignores meeting chairs', () => {
    const d = desk(0)
    expect(seatForDesk(layoutWith([d, chair(0, 0.56, 'meeting-chair')]), d).seated).toBe(false)
  })

  it('takes the nearest of two chairs', () => {
    const d = desk(0)
    const s = seatForDesk(layoutWith([d, chair(0.5, 0.56), { ...chair(0.1, 0.56), id: 'c2' }]), d)
    expect(s.x).toBe(0.1)
  })

  it('every default desk sits in its own chair', () => {
    const layout = createDefaultLayout()
    const desks = layout.furniture.filter((f) => f.type === 'desk')
    expect(desks).toHaveLength(14)
    const seats = desks.map((d) => {
      const seat = seatForDesk(layout, d)
      const chairAt = layout.furniture.find((f) => f.id === d.id.replace('desk', 'chair'))!
      expect(seat).toEqual({ x: chairAt.x, z: chairAt.z, rotation: d.rotation, seated: true })
      return `${seat.x},${seat.z}`
    })
    expect(new Set(seats).size).toBe(14)
  })
})
