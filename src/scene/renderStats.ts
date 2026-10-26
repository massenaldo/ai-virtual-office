/** Renderer totals for one whole frame (shadow pass, contact shadows and main pass), stamped with performance.now(). */
export type FrameSample = { calls: number; triangles: number; time: number }
/** Latest frame's totals plus rendered frames per second; fps is null when nothing rendered in the window (idle). */
export type StatsSummary = { calls: number; triangles: number; fps: number | null }

/**
 * Rolling window of frame samples. FPS counts rendered frames only, so idle time under demand rendering
 * reads as "idle" instead of as dropped frames.
 */
export function createStatsWindow(windowMs = 1000) {
  let samples: FrameSample[] = []
  return {
    push(sample: FrameSample) {
      samples.push(sample)
    },
    summary(now: number): StatsSummary {
      samples = samples.filter((s) => s.time > now - windowMs)
      const last = samples[samples.length - 1]
      if (!last) return { calls: 0, triangles: 0, fps: null }
      return { calls: last.calls, triangles: last.triangles, fps: Math.round((samples.length * 1000) / windowMs) }
    },
  }
}

/** The overlay is opt-in: add `?stats` to the URL. */
export function statsEnabled(search: string): boolean {
  return new URLSearchParams(search).has('stats')
}
