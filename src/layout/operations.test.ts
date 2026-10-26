import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from './defaultLayout'
import { addFurniture, addRoom, deleteFurniture, deleteRoom, duplicateFurniture, furnitureInRoom, resizeRoomEdge, rotateFurniture, rotateRoom, updateFurniture, updateRoom } from './operations'
import { nextRotation, rotateOffset } from './geometry'
import type { OfficeLayout } from './types'

const CEO = 'room-ceo-office'
const fresh = () => createDefaultLayout()
const room = (l = fresh(), id = CEO) => l.rooms.find((r) => r.id === id)!
const item = (l: ReturnType<typeof fresh>, id: string) => l.furniture.find((f) => f.id === id)!

describe('updateRoom', () => {
  it('moves furniture inside the room along with it', () => {
    const l = fresh()
    const next = updateRoom(l, CEO, { x: room(l).x + 1 })
    expect(item(next, 'desk-01').x).toBeCloseTo(item(l, 'desk-01').x + 1)
    expect(item(next, 'desk-03')).toEqual(item(l, 'desk-03'))
  })

  it('never stores NaN and clamps out-of-range sizes', () => {
    const l = fresh()
    expect(room(updateRoom(l, CEO, { width: Number('abc') })).width).toBe(room(l).width)
    expect(room(updateRoom(l, CEO, { width: 0 })).width).toBe(2)
    expect(room(updateRoom(l, CEO, { width: -4 })).width).toBe(2)
  })

  it('returns the same layout when nothing changes', () => {
    const l = fresh()
    expect(updateRoom(l, 'missing', { x: 1 })).toBe(l)
    expect(updateRoom(l, CEO, { x: room(l).x })).toBe(l)
  })

  it('renames rooms and changes their department', () => {
    const next = updateRoom(fresh(), CEO, { name: 'FOUNDER', department: 'design' })
    expect(room(next)).toMatchObject({ name: 'FOUNDER', department: 'design' })
  })
})

describe('resizeRoomEdge', () => {
  it('moves one edge and keeps the opposite edge fixed', () => {
    const l = fresh()
    const r = room(l)
    const west = r.x - r.width / 2
    const next = room(resizeRoomEdge(l, CEO, 'e', r.x + r.width / 2 + 1))
    expect(next.width).toBeCloseTo(r.width + 1)
    expect(next.x - next.width / 2).toBeCloseTo(west)
  })

  it('never drifts the fixed edge across repeated resizes', () => {
    let l = fresh()
    const r = room(l)
    const west = r.x - r.width / 2
    for (const east of [-3.33, -2.13, -4.07, -3.9]) l = resizeRoomEdge(l, CEO, 'e', east)
    const next = room(l)
    expect(next.x - next.width / 2).toBeCloseTo(west, 9)
    expect(next.x + next.width / 2).toBeCloseTo(-3.9, 9)
  })

  it('stops at the minimum size without moving the opposite edge', () => {
    const l = fresh()
    const r = room(l)
    const south = r.z + r.depth / 2
    const next = room(resizeRoomEdge(l, CEO, 'n', south + 5))
    expect(next.depth).toBe(2)
    expect(next.z + next.depth / 2).toBeCloseTo(south)
  })
})

describe('deleteRoom', () => {
  it('removes the room and its furniture', () => {
    const l = fresh()
    expect(furnitureInRoom(l, CEO).length).toBeGreaterThan(0)
    const next = deleteRoom(l, CEO)
    expect(next.rooms.some((r) => r.id === CEO)).toBe(false)
    expect(furnitureInRoom(next, CEO)).toHaveLength(0)
    expect(next.furniture.length).toBe(l.furniture.length - furnitureInRoom(l, CEO).length)
  })
})

describe('furniture operations', () => {
  it('reassigns the room when furniture moves to open floor or another room', () => {
    const l = fresh()
    expect(item(updateFurniture(l, 'desk-01', { x: 0, z: 7 }), 'desk-01').roomId).toBeNull()
    expect(item(updateFurniture(l, 'desk-01', { x: -2, z: -4.4 }), 'desk-01').roomId).toBe('room-project-management')
  })

  it('rotates in 90 degree steps back to the start', () => {
    let l = fresh()
    for (let i = 0; i < 4; i++) l = rotateFurniture(l, 'plant-01')
    expect(item(l, 'plant-01').rotation).toBe(0)
    expect(item(rotateFurniture(fresh(), 'plant-01'), 'plant-01').rotation).toBe(90)
  })

  it('duplicates with a new unique id and an offset', () => {
    const l = fresh()
    const { layout, id } = duplicateFurniture(l, 'plant-03')
    expect(layout.furniture).toHaveLength(l.furniture.length + 1)
    expect(l.furniture.some((f) => f.id === id)).toBe(false)
    expect(item(layout, id)).toMatchObject({ type: 'plant', x: item(l, 'plant-03').x + 0.5, z: item(l, 'plant-03').z + 0.5 })
  })

  it('adds furniture assigned to the room under it and deletes it again', () => {
    const l = fresh()
    const { layout, id } = addFurniture(l, 'chair', { x: -7, z: -4 })
    expect(item(layout, id)).toMatchObject({ type: 'chair', rotation: 0, roomId: CEO })
    expect(deleteFurniture(layout, id).furniture).toHaveLength(l.furniture.length)
  })
})

describe('addRoom', () => {
  it('adds a room from a template with a unique id', () => {
    const l = fresh()
    const { layout, id } = addRoom(l, 'meeting-room')
    expect(layout.rooms).toHaveLength(11)
    expect(l.rooms.some((r) => r.id === id)).toBe(false)
    expect(room(layout, id)).toMatchObject({ width: 4.6, depth: 3.6, department: 'meeting', wallHeight: 2.5 })
  })
})

describe('new furniture types', () => {
  it('adds a storage cabinet into the room under it', () => {
    const { layout, id } = addFurniture(fresh(), 'storage-cabinet', { x: -7, z: -4 })
    expect(item(layout, id)).toMatchObject({ type: 'storage-cabinet', roomId: CEO })
  })
})

describe('rotateRoom', () => {
  it('swaps the footprint and steps the rotation', () => {
    const before = room()
    const after = room(rotateRoom(fresh(), CEO))
    expect(after).toMatchObject({ width: before.depth, depth: before.width, rotation: 90, x: before.x, z: before.z })
  })

  it("carries the room's furniture around its centre", () => {
    const l = fresh()
    const centre = room(l)
    const turned = rotateRoom(l, CEO)
    const inRoom = furnitureInRoom(l, CEO)
    expect(inRoom.length).toBeGreaterThan(0)
    for (const f of inRoom) {
      const o = rotateOffset(f.x - centre.x, f.z - centre.z, 90)
      const g = item(turned, f.id)
      expect(g.x).toBeCloseTo(centre.x + o.dx, 2)
      expect(g.z).toBeCloseTo(centre.z + o.dz, 2)
      expect(g.rotation).toBe(nextRotation(f.rotation))
      expect(g.roomId).toBe(CEO)
    }
  })

  it('leaves other rooms and open-floor furniture untouched', () => {
    const l = fresh()
    const turned = rotateRoom(l, CEO)
    expect(turned.rooms.filter((r) => r.id !== CEO)).toEqual(l.rooms.filter((r) => r.id !== CEO))
    expect(turned.furniture.filter((f) => f.roomId !== CEO)).toEqual(l.furniture.filter((f) => f.roomId !== CEO))
  })

  it('four turns restore the room and its furniture', () => {
    const l = fresh()
    let turned = l
    for (let i = 0; i < 4; i++) turned = rotateRoom(turned, CEO)
    expect(turned).toEqual(l)
  })

  it('four turns restore furniture even when the room centre is on a half centimetre', () => {
    const c = room()
    const l = updateRoom(fresh(), CEO, { x: c.x + 0.005 })
    let turned = l
    for (let i = 0; i < 4; i++) turned = rotateRoom(turned, CEO)
    expect(turned).toEqual(l)
  })

  it('slides a room back inside the office', () => {
    const base = fresh()
    const l: OfficeLayout = {
      ...base,
      rooms: [{ ...room(base), id: 'edge-room', x: 0, z: -9, width: 6, depth: 2, rotation: 0 }],
      furniture: [{ id: 'edge-plant', type: 'plant', x: 2, z: -9.5, rotation: 0, roomId: 'edge-room' }],
    }
    const turned = rotateRoom(l, 'edge-room')
    expect(room(turned, 'edge-room')).toMatchObject({ x: 0, z: -7, width: 2, depth: 6, rotation: 90 })
    const plant = item(turned, 'edge-plant')
    expect(plant.x).toBeCloseTo(-0.5, 2)
    expect(plant.z).toBeCloseTo(-9, 2)
  })

  it('returns the same layout for an unknown id', () => {
    const l = fresh()
    expect(rotateRoom(l, 'nope')).toBe(l)
  })
})
