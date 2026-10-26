/**
 * Renderer totals for one whole frame (shadow pass, contact shadows and main pass): draw calls, triangles and the
 * main-thread time spent in renderer.render, stamped with performance.now().
 */
export type FrameSample = { calls: number; triangles: number; cpuMs: number; time: number }
/** Latest frame's totals, rendered frames per second and mean CPU render time; fps is null when idle (nothing rendered in the window). */
export type StatsSummary = { calls: number; triangles: number; fps: number | null; cpuMs: number }

/**
 * Rolling window of frame samples. FPS counts rendered frames only, so idle time under demand rendering
 * reads as "idle" instead of as dropped frames.
 */
export function createStatsWindow(windowMs = 1000) {
  let samples: FrameSample[] = []
  return {
    push(sample: FrameSample) {
      // drei's fat lines are instanced with instanceCount = Infinity, which makes renderer.info report Infinity triangles.
      const triangles = Number.isFinite(sample.triangles) ? sample.triangles : (samples[samples.length - 1]?.triangles ?? 0)
      samples.push({ ...sample, triangles })
    },
    summary(now: number): StatsSummary {
      samples = samples.filter((s) => s.time > now - windowMs)
      const last = samples[samples.length - 1]
      if (!last) return { calls: 0, triangles: 0, fps: null, cpuMs: 0 }
      const cpuMs = samples.reduce((sum, s) => sum + s.cpuMs, 0) / samples.length
      return { calls: last.calls, triangles: last.triangles, fps: Math.round((samples.length * 1000) / windowMs), cpuMs }
    },
  }
}

/** The overlay is opt-in: add `?stats` to the URL. */
export function statsEnabled(search: string): boolean {
  return new URLSearchParams(search).has('stats')
}
