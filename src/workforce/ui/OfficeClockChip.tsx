import { useEffect, useState } from 'react'
import { officeClockLabel } from '../../office/officeClock'
import { useOfficeClock } from '../officeClockContext'

/** The office time, like `Jakarta 12:03`. Its own timer and state, so a tick re-renders only this chip, never the scene. */
export default function OfficeClockChip({ speed = 1 }: { speed?: number }) {
  const clock = useOfficeClock()
  const [label, setLabel] = useState(() => officeClockLabel(clock.now(), speed))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = () => { if (timer !== null) clearTimeout(timer); timer = null }
    const tick = () => {
      stop()
      const now = clock.now()
      setLabel(officeClockLabel(now, speed))
      // At most once a minute: on the minute when the clock is real, every real minute when it is sped up.
      timer = setTimeout(tick, speed === 1 ? 60000 - (now % 60000) + 50 : 60000)
    }
    const onVisibility = () => { if (document.hidden) stop(); else tick() }
    document.addEventListener('visibilitychange', onVisibility)
    if (document.hidden) setLabel(officeClockLabel(clock.now(), speed)); else tick()
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [clock, speed])
  return <div className="scene-chip" role="status" aria-label="Office time">{label}</div>
}
