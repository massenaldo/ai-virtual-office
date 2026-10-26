import { describe, expect, it, vi } from 'vitest'
import { createClientTracker } from './voAutoExit'

describe('createClientTracker', () => {
  it('does nothing until a page has connected', () => {
    const onEmpty = vi.fn()
    createClientTracker(onEmpty)
    expect(onEmpty).not.toHaveBeenCalled()
  })

  it('fires as soon as the only page disconnects', () => {
    const onEmpty = vi.fn()
    const tracker = createClientTracker(onEmpty)
    tracker.connected()
    tracker.disconnected()
    expect(onEmpty).toHaveBeenCalledTimes(1)
  })

  it('waits for the last of several pages', () => {
    const onEmpty = vi.fn()
    const tracker = createClientTracker(onEmpty)
    tracker.connected()
    tracker.connected()
    tracker.disconnected()
    expect(onEmpty).not.toHaveBeenCalled()
    tracker.disconnected()
    expect(onEmpty).toHaveBeenCalledTimes(1)
  })

  it('ignores a stray disconnect with no page open', () => {
    const onEmpty = vi.fn()
    const tracker = createClientTracker(onEmpty)
    tracker.disconnected()
    expect(onEmpty).not.toHaveBeenCalled()
  })

  it('fires again when a page connects and closes after an earlier one', () => {
    const onEmpty = vi.fn()
    const tracker = createClientTracker(onEmpty)
    tracker.connected()
    tracker.disconnected()
    tracker.connected()
    tracker.disconnected()
    expect(onEmpty).toHaveBeenCalledTimes(2)
  })
})
