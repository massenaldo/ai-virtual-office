import { describe, expect, it } from 'vitest'
import { createStatsWindow, statsEnabled } from './renderStats'

describe('createStatsWindow', () => {
  it('reports idle with no samples', () => {
    expect(createStatsWindow().summary(1000)).toEqual({ calls: 0, triangles: 0, fps: null, cpuMs: 0 })
  })

  it('counts rendered frames over the last second and reports the latest totals', () => {
    const stats = createStatsWindow()
    for (let i = 0; i < 30; i++) stats.push({ calls: 100 + i, triangles: 5000 + i, cpuMs: i % 2 ? 3 : 1, time: 2000 - (29 - i) * 33 })
    const summary = stats.summary(2000)
    expect(summary.fps).toBeGreaterThanOrEqual(29)
    expect(summary.fps).toBeLessThanOrEqual(31)
    expect(summary.calls).toBe(129)
    expect(summary.triangles).toBe(5029)
    expect(summary.cpuMs).toBeCloseTo(2)
  })

  it('keeps the last finite triangle count when instanced lines report Infinity', () => {
    const stats = createStatsWindow()
    stats.push({ calls: 10, triangles: 400, cpuMs: 1, time: 900 })
    stats.push({ calls: 12, triangles: Infinity, cpuMs: 1, time: 950 })
    expect(stats.summary(1000)).toMatchObject({ calls: 12, triangles: 400 })
  })

  it('reports idle when the last frame is older than the window', () => {
    const stats = createStatsWindow()
    stats.push({ calls: 10, triangles: 20, cpuMs: 1, time: 500 })
    expect(stats.summary(2000).fps).toBeNull()
  })
})

describe('statsEnabled', () => {
  it('is on only when the query string has a stats key', () => {
    expect(statsEnabled('?stats')).toBe(true)
    expect(statsEnabled('?a=1&stats=1')).toBe(true)
    expect(statsEnabled('')).toBe(false)
    expect(statsEnabled('?status')).toBe(false)
  })
})
