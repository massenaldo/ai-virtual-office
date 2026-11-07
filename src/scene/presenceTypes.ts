// What the scene needs to know about where a character is. The scene never imports the office's own types: App.tsx adapts them.

/**
 * `rotation` is in degrees: 0 faces -Z and a positive value turns toward -X. `activity` is what the character is doing when it is
 * not walking. `label` is the text for the marker, such as `On lunch`, or null. `bubble` is true while it is chatting.
 */
export type ScenePresence = {
  x: number
  z: number
  rotation: number
  pose: 'sit' | 'stand' | 'walk'
  activity: 'idle' | 'coffee' | 'eat' | 'chat' | 'pray'
  label: string | null
  bubble: boolean
}

/**
 * Where an agent is right now, or null when it is unknown. A stable function, so reading it never changes what is drawn. The
 * returned object is reused for that agent and is only valid until the next call for it: read it, do not keep it.
 */
export type PresenceSource = (id: string) => ScenePresence | null
