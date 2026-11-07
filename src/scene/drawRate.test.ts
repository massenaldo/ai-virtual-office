import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_FPS, IDLE_FPS, createDrawLoop, drawRate } from './drawRate'

const base = { hidden: false, editing: false, floorPlan: false, characters: 3, active: false }

describe('drawRate', () => {
  it('idle characters draw at 5', () => expect(drawRate(base)).toBe(IDLE_FPS))
  it('anything active draws at 30', () => expect(drawRate({ ...base, active: true })).toBe(ACTIVE_FPS))
  it.each([{ hidden: true }, { editing: true }, { floorPlan: true }, { characters: 0 }])('%o never draws on a timer', (o) => {
    expect(drawRate({ ...base, active: true, ...o })).toBe(0)
  })
})

describe('createDrawLoop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (initial: Partial<typeof base> = {}) => {
    const state = { ...base, ...initial }
    const listeners = new Set<() => void>()
    const doc = {
      get hidden() { return state.hidden },
      addEventListener: (_: 'visibilitychange', fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: 'visibilitychange', fn: () => void) => void listeners.delete(fn),
    }
    const invalidate = vi.fn()
    const loop = createDrawLoop({ read: () => state, invalidate, doc })
    const setHidden = (hidden: boolean) => { state.hidden = hidden; listeners.forEach((fn) => fn()) }
    return { state, listeners, invalidate, loop, setHidden }
  }

  it('draws idle characters 5 times a second', () => {
    const { loop, invalidate } = setup()
    loop.start()
    vi.advanceTimersByTime(1000)
    expect(invalidate).toHaveBeenCalledTimes(IDLE_FPS)
    loop.stop()
  })

  it('picks up a rate change at the next tick', () => {
    const { loop, invalidate, state } = setup()
    loop.start()
    vi.advanceTimersByTime(200)
    expect(invalidate).toHaveBeenCalledTimes(1)
    state.active = true
    vi.advanceTimersByTime(200)
    expect(invalidate).toHaveBeenCalledTimes(2)
    invalidate.mockClear()
    vi.advanceTimersByTime(1000)
    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(ACTIVE_FPS - 1)
    loop.stop()
  })

  it('a hidden tab clears the timer and showing it restarts', () => {
    const { loop, invalidate, setHidden } = setup()
    loop.start()
    setHidden(true)
    expect(vi.getTimerCount()).toBe(0)
    invalidate.mockClear()
    vi.advanceTimersByTime(5000)
    expect(invalidate).not.toHaveBeenCalled()
    setHidden(false)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(invalidate).toHaveBeenCalled()
    loop.stop()
  })

  it('creates no timer at rate 0', () => {
    for (const o of [{ editing: true }, { floorPlan: true }, { characters: 0 }, { hidden: true }]) {
      const { loop } = setup(o)
      loop.start()
      expect(vi.getTimerCount()).toBe(0)
      loop.stop()
    }
  })

  it('stops when a tick finds rate 0', () => {
    const { loop, state } = setup()
    loop.start()
    state.characters = 0
    vi.advanceTimersByTime(200)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop clears the timer and the listener', () => {
    const { loop, listeners } = setup()
    loop.start()
    expect(listeners.size).toBe(1)
    loop.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(listeners.size).toBe(0)
  })

  it('start twice does not double the timers', () => {
    const { loop, listeners } = setup()
    loop.start()
    loop.start()
    expect(vi.getTimerCount()).toBe(1)
    expect(listeners.size).toBe(1)
    loop.stop()
  })
})
