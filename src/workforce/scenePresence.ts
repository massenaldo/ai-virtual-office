import type { OfficeClock } from '../office/officeClock'
import type { Presence, PresenceState } from '../office/presence'
import type { SceneCharacter } from '../scene/characterInstances'
import type { PresenceSource, ScenePresence } from '../scene/presenceTypes'

const ACTIVITY: Record<PresenceState, ScenePresence['activity']> = {
  'at-desk': 'idle',
  walking: 'idle',
  chatting: 'chat',
  coffee: 'coffee',
  lunch: 'eat',
  praying: 'pray',
}

/**
 * Adapts the routine to the scene: a stable function from agent ID to position, asked at the office time on every call. With no
 * routine, or `clock.routine` false, every agent sits at its seat with no label. One object per agent is reused, so asking every
 * frame allocates nothing beyond what the routine itself returns.
 */
export function createPresenceSource(
  routine: { presenceAt(agentId: string, nowMs: number): Presence | null } | null,
  clock: Pick<OfficeClock, 'now' | 'routine'>,
  characters: SceneCharacter[],
): PresenceSource {
  const seats = new Map(characters.map((c) => [c.id, c]))
  const reused = new Map<string, ScenePresence>()
  const slot = (id: string) => {
    let out = reused.get(id)
    if (!out) reused.set(id, (out = { x: 0, z: 0, rotation: 0, pose: 'sit', activity: 'idle', label: null, bubble: false }))
    return out
  }
  const atSeat = (id: string) => {
    const c = seats.get(id)
    if (!c) return null
    const out = slot(id)
    out.x = c.x; out.z = c.z; out.rotation = c.rotation; out.pose = c.seated ? 'sit' : 'stand'
    out.activity = 'idle'; out.label = null; out.bubble = false
    return out
  }
  let warned = false
  return (id) => {
    if (!routine || !clock.routine) return atSeat(id)
    let p: Presence | null
    try {
      p = routine.presenceAt(id, clock.now())
    } catch (error) {
      // This runs inside the render loop, so a bug in the routine must cost the routine, never the 3D view.
      if (!warned) console.warn('The office routine failed, so agents stay at their desks.', error)
      warned = true
      return atSeat(id)
    }
    if (!p) return null
    const out = slot(id)
    out.x = p.x; out.z = p.z; out.rotation = p.rotation; out.pose = p.pose
    // A seated character can only eat; coffee or prayer at a desk (nowhere to go) shows as a label alone.
    const activity = ACTIVITY[p.state] ?? 'idle'
    out.activity = p.pose === 'sit' && activity !== 'eat' ? 'idle' : activity
    out.label = p.label; out.bubble = p.bubble
    return out
  }
}
