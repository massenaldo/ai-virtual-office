import { useEffect, useMemo, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { createStatsWindow } from './renderStats'

const REFRESH_MS = 250

/** Small read-out over the canvas, filled in by RenderStatsProbe. */
export function RenderStatsPanel({ panel }: { panel: RefObject<HTMLDivElement | null> }) {
  return <div ref={panel} className="render-stats">idle</div>
}

/**
 * Sums renderer.info and the time spent in renderer.render over each whole frame. It runs before every other frame
 * callback (priority −1, so R3F keeps rendering), records the previous frame's totals and resets them; the panel text
 * is updated without React state. FPS is capped by the display, so CPU time is the number to compare.
 */
export function RenderStatsProbe({ panel }: { panel: RefObject<HTMLDivElement | null> }) {
  const gl = useThree((s) => s.gl)
  const stats = useMemo(() => createStatsWindow(), [])
  const frame = useMemo(() => ({ cpuMs: 0 }), [])
  useEffect(() => {
    gl.info.autoReset = false
    gl.info.reset()
    const render = gl.render
    gl.render = (...args) => {
      const start = performance.now()
      render.apply(gl, args)
      frame.cpuMs += performance.now() - start
    }
    const show = () => {
      const { calls, triangles, fps, cpuMs } = stats.summary(performance.now())
      const rate = fps === null ? 'idle' : `${fps} fps · ${cpuMs.toFixed(1)} ms cpu`
      if (panel.current) panel.current.textContent = `${rate} · ${calls} calls · ${triangles.toLocaleString()} tris`
    }
    const timer = setInterval(show, REFRESH_MS)
    return () => {
      clearInterval(timer)
      gl.render = render
      gl.info.autoReset = true
    }
  }, [gl, stats, frame, panel])
  useFrame(() => {
    const { calls, triangles } = gl.info.render
    if (calls > 0) stats.push({ calls, triangles, cpuMs: frame.cpuMs, time: performance.now() })
    gl.info.reset()
    frame.cpuMs = 0
  }, -1)
  return null
}
