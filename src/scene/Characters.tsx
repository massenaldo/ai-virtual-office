import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { buildPartInstances, type SceneCharacter } from './characterInstances'
import { characterLook } from './characterLook'
import { JOINTS, chooseAction, easeRotation, gaitAfter, jointMatrices, partMatrix, partVisible, stepPose, targetPose, type CharacterAction, type Pose } from './characterRig'
import type { PresenceSource } from './presenceTypes'
import { CLICK_SLOP } from './FurnitureItem'
import { stableHash } from './furnitureModels'

/**
 * Written by Characters every frame: true while any character is working, walking, turning or still easing back, so the draw rate can
 * follow. Standing at a break (coffee, lunch, chat, prayer) is not active: it only breathes, and draws at the idle rate.
 */
export const motion: MutableRefObject<{ active: boolean }> = { current: { active: false } }

/** After an action changes, the pose keeps easing for about this long. */
const EASE_BACK_MS = 1500
const PLAN_DOT_Y = 0.09
const PLAN_DOT_RADIUS = 0.3

// Shared by every Characters and never disposed. The shells of hair, hijab and jacket are open, so both sides are drawn.
let sharedMaterial: THREE.MeshStandardMaterial | null = null
const material = () => (sharedMaterial ??= new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.75, metalness: 0, side: THREE.DoubleSide }))
let dotGeometry: THREE.CircleGeometry | null = null
const dotShape = () => (dotGeometry ??= new THREE.CircleGeometry(PLAN_DOT_RADIUS, 20).rotateX(-Math.PI / 2))

/** Per character, kept between frames. `rot` is the facing now, in degrees; `gait` is the walking cycle phase, advanced by distance walked. */
type Motion = { pose: Pose; action: CharacterAction; changedAt: number; rot: number; prevX: number; prevZ: number; gait: number }

const AWAY_ACTIONS: ReadonlySet<CharacterAction> = new Set<CharacterAction>(['coffee', 'eat', 'chat', 'pray'])
/** A turn bigger than this many degrees still counts as moving, so the draw rate keeps up while it eases. */
const TURNING_DEG = 0.5
/** How close to its seat counts as being at its desk. The seat comes from the same numbers, so this is only for rounding. */
const AT_SEAT = 0.02

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

/**
 * Pointer handlers for an instanced mesh, mapped to the character's desk, with the same click slop and cursor handling as a desk.
 * Without onDeskClick there are none. `resetKey` clears a hover whose mesh was replaced.
 */
function usePointer(onDeskClick: ((deskId: string) => void) | undefined, deskOf: (instanceId: number | undefined, mesh: number) => string | undefined, resetKey: unknown) {
  const [hovered, setHovered] = useState(false)
  useEffect(() => setHovered(false), [resetKey])
  useEffect(() => {
    if (!onDeskClick || !hovered) return
    document.body.style.cursor = 'pointer'
    return () => { document.body.style.cursor = '' }
  }, [onDeskClick, hovered])
  return (mesh: number) => (onDeskClick ? {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (e.delta > CLICK_SLOP) return
      const deskId = deskOf(e.instanceId, mesh)
      if (deskId === undefined) return
      e.stopPropagation()
      onDeskClick(deskId)
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(true) },
    onPointerOut: () => setHovered(false),
  } : {})
}

export type CharactersProps = { characters: SceneCharacter[]; presence: PresenceSource; floorPlan: boolean; onDeskClick?: (deskId: string) => void }

/**
 * Draws every character with one InstancedMesh per unique geometry, so draw calls follow the number of parts and not the number
 * of agents. In floor plan each one is a coloured dot instead. Rendering is on demand: this writes what it is told to draw and asks
 * for a frame when the characters change. Where each one is comes from `presence`, read every frame: nothing here is rebuilt when
 * it or the time changes, only matrices are written.
 */
export default function Characters({ characters, presence, floorPlan, onDeskClick }: CharactersProps) {
  const invalidate = useThree((s) => s.invalidate)
  const groups = useMemo(() => buildPartInstances(characters), [characters])
  const meshes = useRef<(THREE.InstancedMesh | null)[]>([])
  const dotMesh = useRef<THREE.InstancedMesh>(null)
  const state = useRef(new Map<string, Motion>())
  const lastMs = useRef<number | null>(null)
  const jointCache = useRef<THREE.Matrix4[][]>([])
  const spots = useRef({ x: [] as number[], z: [] as number[], rot: [] as number[] }).current
  const tmp = useRef({ root: new THREE.Matrix4(), m: new THREE.Matrix4(), part: new THREE.Matrix4() }).current
  const pointer = usePointer(onDeskClick, (instanceId, mesh) => {
    if (instanceId === undefined) return undefined
    const index = floorPlan ? instanceId : groups[mesh]?.instances[instanceId]?.characterIndex
    return index === undefined ? undefined : characters[index]?.deskId
  }, floorPlan ? characters : groups)

  // Each character's phase comes from its id, so they are out of step. Their look comes from characterLook(id) only.
  const phases = useMemo(() => characters.map((c) => (stableHash(`${c.id}:phase`) % 1000) / 1000), [characters])
  const bodies = useMemo(() => characters.map((c) => characterLook(c.id).body), [characters])

  useLayoutEffect(() => {
    const color = new THREE.Color()
    groups.forEach((g, gi) => {
      const mesh = meshes.current[gi]
      if (!mesh) return
      g.instances.forEach((inst, i) => mesh.setColorAt(i, color.set(inst.color)))
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    })
    // floorPlan too: returning from floor plan builds new meshes from the same groups, and they start with no colours.
  }, [groups, floorPlan])

  useLayoutEffect(() => {
    const mesh = dotMesh.current
    if (!floorPlan || !mesh) return
    const color = new THREE.Color()
    characters.forEach((c, i) => {
      mesh.setMatrixAt(i, tmp.m.makeTranslation(c.x, PLAN_DOT_Y, c.z))
      mesh.setColorAt(i, color.set(c.accent))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [floorPlan, characters, tmp])

  // Rendering is on demand, so a change of characters or view has to ask for a frame.
  useEffect(() => { invalidate() }, [characters, floorPlan, invalidate])
  useEffect(() => () => { motion.current.active = false }, [])

  useFrame(() => {
    if (floorPlan) {
      // The dots follow the same source. Only a walk needs smooth drawing.
      const mesh = dotMesh.current
      let walking = false
      characters.forEach((c, i) => {
        const p = presence(c.id)
        if (p?.pose === 'walk') walking = true
        mesh?.setMatrixAt(i, tmp.m.makeTranslation(p ? p.x : c.x, PLAN_DOT_Y, p ? p.z : c.z))
      })
      if (mesh) {
        mesh.instanceMatrix.needsUpdate = true
        // Clicks raycast against this sphere, so it follows the dots.
        mesh.computeBoundingSphere()
      }
      motion.current.active = walking
      return
    }
    // Own clock, not r3f's delta. A long gap, such as a hidden tab, is handled by stepPose, which lands on the target.
    const nowPerf = performance.now()
    const dtS = lastMs.current === null ? 0 : Math.max(0, (nowPerf - lastMs.current) / 1000)
    lastMs.current = nowPerf
    const nowWall = Date.now()
    const timeS = nowPerf / 1000
    const live = new Set<string>()
    const actions: CharacterAction[] = []
    const poses: Pose[] = []
    let active = false
    characters.forEach((c, i) => {
      live.add(c.id)
      const p = presence(c.id)
      const x = p ? p.x : c.x
      const z = p ? p.z : c.z
      const rotation = p ? p.rotation : c.rotation
      const pose = p ? p.pose : c.seated ? 'sit' : 'stand'
      // A task's status acts only back at the desk. Away from it, or on the way, the character is walking or on a break.
      const atDesk = pose !== 'walk' && Math.abs(x - c.x) < AT_SEAT && Math.abs(z - c.z) < AT_SEAT
      const action = chooseAction({ status: c.status, doneAt: c.doneAt, nowMs: nowWall, pose, activity: p ? p.activity : 'idle', atDesk })
      let mo = state.current.get(c.id)
      if (!mo) {
        mo = { pose: targetPose(action, pose === 'sit', timeS, phases[i], 0), action, changedAt: Number.NEGATIVE_INFINITY, rot: rotation, prevX: x, prevZ: z, gait: 0 }
        state.current.set(c.id, mo)
      } else if (mo.action !== action) {
        mo.action = action
        mo.changedAt = nowPerf
      }
      // The walking cycle follows the ground covered since the last frame, so feet don't slide at any frame rate, and a
      // character that was far away (a hidden tab) simply continues the cycle from there.
      mo.gait = pose === 'walk' ? gaitAfter(mo.gait, Math.hypot(x - mo.prevX, z - mo.prevZ)) : 0
      mo.prevX = x
      mo.prevZ = z
      const target = targetPose(action, pose === 'sit', timeS, phases[i], mo.gait)
      mo.pose = stepPose(mo.pose, target, dtS).pose
      mo.rot = easeRotation(mo.rot, rotation, dtS)
      const turning = Math.abs(((((rotation - mo.rot) % 360) + 540) % 360) - 180) > TURNING_DEG
      spots.x[i] = x
      spots.z[i] = z
      spots.rot[i] = (mo.rot * Math.PI) / 180
      // Breathing moves the idle target, so "settled" never holds; a per-character timer decides instead.
      if (action === 'walk' || turning || (action !== 'idle' && !AWAY_ACTIONS.has(action)) || nowPerf - mo.changedAt < EASE_BACK_MS) active = true
      actions.push(action)
      poses.push(mo.pose)
    })
    for (const id of state.current.keys()) if (!live.has(id)) state.current.delete(id)
    motion.current.active = active

    // Reused every frame: continuous drawing would otherwise allocate a matrix per joint per character per frame.
    const joints = jointCache.current
    characters.forEach((_, i) => {
      const out = (joints[i] ??= JOINTS.map(() => new THREE.Matrix4()))
      jointMatrices(poses[i], out, bodies[i])
    })
    groups.forEach((g, gi) => {
      const mesh = meshes.current[gi]
      if (!mesh) return
      g.instances.forEach((inst, i) => {
        const ci = inst.characterIndex
        if (!partVisible(inst.entry.part, actions[ci], characters[ci].status)) return void mesh.setMatrixAt(i, ZERO)
        tmp.root.makeRotationY(spots.rot[ci]).setPosition(spots.x[ci], 0, spots.z[ci])
        mesh.setMatrixAt(i, tmp.m.multiplyMatrices(tmp.root, partMatrix(inst.entry.part, joints[ci][JOINTS.indexOf(inst.entry.joint)], tmp.part)))
      })
      mesh.instanceMatrix.needsUpdate = true
      // Three caches the sphere it raycasts against; refresh it after the instances moved.
      mesh.computeBoundingSphere()
    })
  })

  if (floorPlan) {
    return characters.length === 0 ? null : <instancedMesh key={`dots-${characters.length}`} ref={dotMesh} args={[dotShape(), material(), characters.length]} frustumCulled={false} {...pointer(0)} />
  }
  return <>{groups.map((g, gi) => (
    <instancedMesh key={`${gi}-${g.instances.length}`} ref={(m) => { meshes.current[gi] = m }} args={[g.geometry, material(), g.instances.length]}
      frustumCulled={false} castShadow={g.castShadow} {...pointer(gi)} />
  ))}</>
}
