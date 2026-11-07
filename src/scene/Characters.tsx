import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { buildPartInstances, type SceneCharacter } from './characterInstances'
import { characterLook } from './characterLook'
import { JOINTS, characterAction, jointMatrices, partVisible, stepPose, targetPose, type CharacterAction, type Pose } from './characterRig'
import { CLICK_SLOP } from './FurnitureItem'
import { stableHash } from './furnitureModels'

/** Written by Characters every frame: true while any character is acting or still easing back, so the draw rate can follow. */
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

type Motion = { pose: Pose; action: CharacterAction; changedAt: number }

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

export type CharactersProps = { characters: SceneCharacter[]; floorPlan: boolean; onDeskClick?: (deskId: string) => void }

/**
 * Draws every character with one InstancedMesh per unique geometry, so draw calls follow the number of parts and not the number
 * of agents. In floor plan each one is a coloured dot instead. Rendering is on demand: this writes what it is told to draw and asks
 * for a frame when the characters change.
 */
export default function Characters({ characters, floorPlan, onDeskClick }: CharactersProps) {
  const invalidate = useThree((s) => s.invalidate)
  const groups = useMemo(() => buildPartInstances(characters), [characters])
  const meshes = useRef<(THREE.InstancedMesh | null)[]>([])
  const dotMesh = useRef<THREE.InstancedMesh>(null)
  const state = useRef(new Map<string, Motion>())
  const lastMs = useRef<number | null>(null)
  const tmp = useRef({ root: new THREE.Matrix4(), m: new THREE.Matrix4() }).current
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
      motion.current.active = false
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
      const action = characterAction(c.status, c.doneAt, nowWall)
      const target = targetPose(action, c.seated, timeS, phases[i])
      let mo = state.current.get(c.id)
      if (!mo) {
        // A new character starts in its pose. An idle one has not "just changed".
        mo = { pose: target, action, changedAt: Number.NEGATIVE_INFINITY }
        state.current.set(c.id, mo)
      } else if (mo.action !== action) {
        mo.action = action
        mo.changedAt = nowPerf
      }
      mo.pose = stepPose(mo.pose, target, dtS).pose
      // Breathing moves the idle target, so "settled" never holds; a per-character timer decides instead.
      if (action !== 'idle' || nowPerf - mo.changedAt < EASE_BACK_MS) active = true
      actions.push(action)
      poses.push(mo.pose)
    })
    for (const id of state.current.keys()) if (!live.has(id)) state.current.delete(id)
    motion.current.active = active

    const joints = characters.map((_, i) => {
      const out = JOINTS.map(() => new THREE.Matrix4())
      jointMatrices(poses[i], out, bodies[i])
      return out
    })
    groups.forEach((g, gi) => {
      const mesh = meshes.current[gi]
      if (!mesh) return
      g.instances.forEach((inst, i) => {
        const ci = inst.characterIndex
        if (!partVisible(inst.entry.part, actions[ci])) return void mesh.setMatrixAt(i, ZERO)
        const c = characters[ci]
        tmp.root.makeRotationY((c.rotation * Math.PI) / 180).setPosition(c.x, 0, c.z)
        mesh.setMatrixAt(i, tmp.m.multiplyMatrices(tmp.root, joints[ci][JOINTS.indexOf(inst.entry.joint)]))
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
