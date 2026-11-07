export const ACTIVE_FPS = 30
export const IDLE_FPS = 5

export type DrawState = { hidden: boolean; editing: boolean; floorPlan: boolean; characters: number; active: boolean }

/**
 * Timer frames per second: 0 when nothing animates on a timer (hidden tab, editing, no characters). Floor plan draws like 3D,
 * because its dots move with the routine; `active` is set there only while someone walks.
 */
export function drawRate(s: DrawState): number {
  if (s.hidden || s.editing || s.characters === 0) return 0
  return s.active ? ACTIVE_FPS : IDLE_FPS
}

type VisibilityDoc = {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', fn: () => void): void
  removeEventListener(type: 'visibilitychange', fn: () => void): void
}

/**
 * A setTimeout chain that asks for a frame at drawRate(). Each tick re-reads the state, so a rate change applies from the next
 * tick. At rate 0 no timer exists. Showing a hidden tab restarts it. Orbiting and dragging are not affected: they draw through
 * their own invalidate calls.
 */
export function createDrawLoop(opts: { read: () => DrawState; invalidate: () => void; doc: VisibilityDoc }) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let listening = false
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const schedule = () => {
    clear()
    const rate = drawRate(opts.read())
    if (rate > 0) timer = setTimeout(tick, 1000 / rate)
  }
  const tick = () => {
    timer = undefined
    if (drawRate(opts.read()) === 0) return
    opts.invalidate()
    schedule()
  }
  const onVisibility = () => {
    schedule()
    if (!opts.doc.hidden) opts.invalidate()
  }
  return {
    start() {
      if (!listening) {
        opts.doc.addEventListener('visibilitychange', onVisibility)
        listening = true
      }
      schedule()
    },
    stop() {
      clear()
      if (listening) opts.doc.removeEventListener('visibilitychange', onVisibility)
      listening = false
    },
  }
}
