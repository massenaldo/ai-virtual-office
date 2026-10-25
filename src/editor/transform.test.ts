import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { applyTransform, pastDragThreshold } from './transform'

const layout = createDefaultLayout()
const room = (l = layout, id = 'room-ceo-office') => l.rooms.find((r) => r.id === id)!
const item = (l = layout, id = 'desk-01') => l.furniture.find((f) => f.id === id)!

describe('applyTransform', () => {
  it('moves a room to the snapped centre and carries its furniture', () => {
    const next = applyTransform(layout, { kind: 'move', target: { kind: 'room', id: 'room-ceo-office' }, x: -6.13, z: -4.38 }, 0.25)
    expect(room(next)).toMatchObject({ x: -6.25, z: -4.5 })
    expect(item(next).x).toBeCloseTo(item().x + 0.85)
  })

  it('moves furniture without snapping when snap is off', () => {
    const next = applyTransform(layout, { kind: 'move', target: { kind: 'furniture', id: 'desk-01' }, x: 0.13, z: 6.97 }, null)
    expect(item(next)).toMatchObject({ x: 0.13, z: 6.97, roomId: null })
  })

  it('resizes a room edge to the snapped coordinate', () => {
    const r = room()
    const next = room(applyTransform(layout, { kind: 'resize', roomId: r.id, edge: 'e', coordinate: -3.9 }, 0.25))
    expect(next.x + next.width / 2).toBeCloseTo(-4)
    expect(next.x - next.width / 2).toBeCloseTo(r.x - r.width / 2)
  })
})

describe('pastDragThreshold', () => {
  it('treats small pointer movement as a click', () => {
    expect(pastDragThreshold({ x: 10, y: 10 }, { x: 13, y: 11 })).toBe(false)
    expect(pastDragThreshold({ x: 10, y: 10 }, { x: 14, y: 13 })).toBe(true)
  })
})
