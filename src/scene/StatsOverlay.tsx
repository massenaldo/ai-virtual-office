import { useEffect, useMemo, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { createStatsWindow } from './renderStats'

const REFRESH_MS = 250

/** Small read-out over the canvas, filled in by RenderStatsProbe. */
export function RenderStatsPanel({ panel }: { panel: RefObject<HTMLDivElement | null> }) {
  return <div ref={panel} className="render-stats">idle</div>
}

/**
 * Sums renderer.info over each whole frame. It runs before every other frame callback (priority −1, so R3F keeps
 * rendering), records the previous frame's totals and resets them; the panel text is updated without React state.
 */
export function RenderStatsProbe({ panel }: { panel: RefObject<HTMLDivElement | null> }) {
  const gl = useThree((s) => s.gl)
  const stats = useMemo(() => createStatsWindow(), [])
  useEffect(() => {
    gl.info.autoReset = false
    gl.info.reset()
    const show = () => {
      const { calls, triangles, fps } = stats.summary(performance.now())
      if (panel.current) panel.current.textContent = fps === null ? `idle · ${calls} calls · ${triangles.toLocaleString()} tris` : `${fps} fps · ${calls} calls · ${triangles.toLocaleString()} tris`
    }
    const timer = setInterval(show, REFRESH_MS)
    return () => {
      clearInterval(timer)
      gl.info.autoReset = true
    }
  }, [gl, stats, panel])
  useFrame(() => {
    const { calls, triangles } = gl.info.render
    if (calls > 0) stats.push({ calls, triangles, time: performance.now() })
    gl.info.reset()
  }, -1)
  return null
}
