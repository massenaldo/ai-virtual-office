import { describe, expect, it } from 'vitest'
import { BASEBOARD, FRAME, GLASS_THICKNESS, WALL_THICKNESS, roomBaseboards, roomWalls, type Box } from './architecture'

const big = { width: 4.5, depth: 3.6, wallHeight: 2.5 }
const tiny = { width: 2, depth: 2, wallHeight: 2.5 }
const EPS = 1e-9

const insideFootprint = (b: Box, r: typeof big) => Math.abs(b.x) + b.w / 2 <= r.width / 2 + EPS && Math.abs(b.z) + b.d / 2 <= r.depth / 2 + EPS

describe('roomWalls', () => {
  it('builds two solid side walls and one glass back wall', () => {
    const { solid, glass } = roomWalls(big)
    expect(solid).toHaveLength(2)
    expect(glass).toHaveLength(1)
  })

  it('keeps every wall inside the room footprint', () => {
    const { solid, glass } = roomWalls(big)
    for (const b of [...solid, ...glass]) expect(insideFootprint(b, big)).toBe(true)
  })

  it('makes solid walls full height and puts glass across the back between them', () => {
    const { solid, glass } = roomWalls(big)
    for (const w of solid) expect(w).toMatchObject({ h: 2.5, y: 1.25, w: WALL_THICKNESS, d: big.depth })
    expect(glass[0].w).toBeCloseTo(big.width - 2 * WALL_THICKNESS, 9)
    expect(glass[0].z).toBeCloseTo(-big.depth / 2 + GLASS_THICKNESS / 2, 9)
    const innerFace = big.width / 2 - WALL_THICKNESS
    expect(Math.abs(glass[0].x) + glass[0].w / 2).toBeLessThanOrEqual(innerFace + EPS)
  })

  it('leaves the front of the room open', () => {
    const { solid, glass } = roomWalls(big)
    const frontBlockers = [...solid, ...glass].filter((b) => b.w > WALL_THICKNESS && b.z + b.d / 2 > big.depth / 2 - 0.5)
    expect(frontBlockers).toHaveLength(0)
  })

  it('stays valid for the smallest allowed room', () => {
    const { solid, glass } = roomWalls(tiny)
    for (const b of [...solid, ...glass]) {
      expect(b.w).toBeGreaterThan(0)
      expect(b.d).toBeGreaterThan(0)
      expect(insideFootprint(b, tiny)).toBe(true)
    }
  })
})

describe('roomBaseboards', () => {
  it('runs a baseboard along the inner face of each side wall', () => {
    const boards = roomBaseboards(big)
    expect(boards).toHaveLength(2)
    for (const b of boards) {
      expect(b.h).toBe(BASEBOARD.height)
      expect(b.y).toBeCloseTo(BASEBOARD.height / 2, 9)
      expect(Math.abs(b.x) + b.w / 2).toBeCloseTo(big.width / 2 - WALL_THICKNESS, 9)
      expect(insideFootprint(b, big)).toBe(true)
    }
  })

  it('stops at the glass so baseboards never poke through it', () => {
    for (const b of roomBaseboards(tiny)) expect(b.z - b.d / 2).toBeGreaterThanOrEqual(-tiny.depth / 2 + GLASS_THICKNESS - EPS)
  })
})

describe('glass partitions', () => {
  const meeting = { width: 4.6, depth: 3.6, wallHeight: 2.5 }
  const glassRight = { left: 'solid', right: 'glass' } as const

  it('swaps the right wall for glass', () => {
    const { solid, glass } = roomWalls(meeting, glassRight)
    expect(solid).toHaveLength(1)
    expect(glass).toHaveLength(2)
  })

  it('frames every pane inside the footprint with positive sizes', () => {
    const { frames } = roomWalls(meeting, glassRight)
    expect(frames.length).toBeGreaterThan(0)
    for (const b of frames) {
      expect(insideFootprint(b, meeting)).toBe(true)
      expect(Math.min(b.w, b.h, b.d)).toBeGreaterThan(0)
    }
  })

  it('spaces mullions no more than FRAME.maxSpan apart along the back pane', () => {
    const { frames } = roomWalls(meeting, glassRight)
    const backMullions = frames
      .filter((b) => b.h > 1 && Math.abs(b.z - (-meeting.depth / 2 + GLASS_THICKNESS / 2)) < 0.05)
      .map((b) => b.x)
      .sort((a, b) => a - b)
    expect(backMullions.length).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < backMullions.length; i++) expect(backMullions[i] - backMullions[i - 1]).toBeLessThanOrEqual(FRAME.maxSpan + 1e-9)
  })

  it('stays valid for a small fully framed room', () => {
    const { frames, glass } = roomWalls(tiny, glassRight)
    for (const b of [...frames, ...glass]) {
      expect(Math.min(b.w, b.h, b.d)).toBeGreaterThan(0)
      expect(insideFootprint(b, tiny)).toBe(true)
    }
  })

  it('only runs baseboards along solid sides', () => {
    expect(roomBaseboards(meeting, glassRight)).toHaveLength(1)
    expect(roomBaseboards(meeting)).toHaveLength(2)
  })

  it('keeps the default all-solid shell', () => {
    const { solid, glass } = roomWalls(meeting)
    expect([solid.length, glass.length]).toEqual([2, 1])
  })
})
