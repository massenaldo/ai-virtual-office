import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { motion } from './Characters'
import { createDrawLoop } from './drawRate'

/**
 * Adds timer frames on top of on-demand rendering so characters keep moving: 30 fps while any acts or walks, 5 fps when all are idle
 * or on a break (floor plan too, so its dots move), none when hidden or editing. Orbiting and dragging still draw at full speed through their own invalidate calls.
 */
export default function DrawScheduler({ characters, editing, floorPlan }: { characters: number; editing: boolean; floorPlan: boolean }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const loop = createDrawLoop({
      read: () => ({ hidden: document.hidden, editing, floorPlan, characters, active: motion.current.active }),
      invalidate: () => invalidate(),
      doc: document,
    })
    loop.start()
    return () => loop.stop()
  }, [characters, editing, floorPlan, invalidate])
  return null
}
