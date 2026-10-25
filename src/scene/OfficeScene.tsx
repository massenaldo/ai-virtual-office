import { useLayoutEffect, useMemo } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { OfficeLayout, OfficeSettings, Selection } from '../layout/types'
import type { Issue } from '../layout/validation'
import FurnitureItem from './FurnitureItem'
import RoomMesh from './RoomMesh'

export type OfficeSceneProps = {
  layout: OfficeLayout
  floorPlan: boolean
  viewKey: number
  editing: boolean
  selection: Selection
  issues: Map<string, Issue[]>
  onSelect(selection: Selection): void
}

function Floor({ office, floorPlan }: { office: OfficeSettings; floorPlan: boolean }) {
  const floorMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: floorPlan ? '#d8dce0' : '#b8a58d', roughness: 0.78 }), [floorPlan])
  return <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.08, 0]} material={floorMaterial}>
    <planeGeometry args={[office.width, office.depth]} />
  </mesh>
}

const PERSPECTIVE_POSITION: [number, number, number] = [15, 17, 19]
const PERSPECTIVE_TARGET: [number, number, number] = [0, 0.4, 0]

/**
 * Owns both cameras and makes one the scene default. Switching view or bumping viewKey
 * puts the camera back at its start position: the 3D overview or a straight-down floor plan fitted to the office.
 */
function ViewCameras({ office, floorPlan, viewKey }: { office: OfficeSettings; floorPlan: boolean; viewKey: number }) {
  const set = useThree((s) => s.set)
  const size = useThree((s) => s.size)
  const perspective = useMemo(() => new THREE.PerspectiveCamera(42, 1, 0.1, 1000), [])
  const ortho = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100), [])
  const camera = floorPlan ? ortho : perspective
  const fitZoom = Math.min(size.width / (office.width + 2), size.height / (office.depth + 2))

  // R3F only auto-sizes its own default camera, so keep both of ours in step with the canvas.
  useLayoutEffect(() => {
    perspective.aspect = size.width / size.height
    perspective.updateProjectionMatrix()
    Object.assign(ortho, { left: -size.width / 2, right: size.width / 2, top: size.height / 2, bottom: -size.height / 2 })
    ortho.updateProjectionMatrix()
  }, [perspective, ortho, size.width, size.height])

  useLayoutEffect(() => {
    if (floorPlan) {
      ortho.position.set(0, 40, 0.001)
      ortho.zoom = fitZoom
      ortho.lookAt(0, 0, 0)
    } else {
      perspective.position.set(...PERSPECTIVE_POSITION)
      perspective.lookAt(...PERSPECTIVE_TARGET)
    }
    camera.updateProjectionMatrix()
    set({ camera })
    // fitZoom is read only when the view is (re)entered, so resizing doesn't undo the user's zoom.
  }, [camera, viewKey])

  return floorPlan
    ? <OrbitControls key={`plan-${viewKey}`} camera={camera} makeDefault target={[0, 0, 0]} enableRotate={false} screenSpacePanning minZoom={fitZoom * 0.6} maxZoom={fitZoom * 4} />
    : <OrbitControls key={`3d-${viewKey}`} camera={camera} makeDefault target={PERSPECTIVE_TARGET} minDistance={7} maxDistance={32} maxPolarAngle={Math.PI / 2.08} />
}

function OfficeContents({ layout, floorPlan, viewKey, editing, selection, issues, onSelect }: OfficeSceneProps) {
  const isSelected = (kind: 'room' | 'furniture', id: string) => selection?.kind === kind && selection.id === id
  return <>
    <color attach="background" args={[floorPlan ? '#e9edf0' : '#dbe3e5']} />
    <ambientLight intensity={floorPlan ? 1.6 : 1.15} />
    <directionalLight position={[6, 13, 7]} intensity={floorPlan ? 0.5 : 2.2} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
    <pointLight position={[-6, 5, -3]} intensity={18} color="#ffdfb0" distance={18} />
    <Floor office={layout.office} floorPlan={floorPlan} />
    {layout.rooms.map((room) => <RoomMesh key={room.id} room={room} floorPlan={floorPlan} editing={editing} selected={isSelected('room', room.id)} invalid={issues.has(room.id)} onSelect={() => onSelect({ kind: 'room', id: room.id })} />)}
    {layout.furniture.map((item) => <FurnitureItem key={item.id} item={item} floorPlan={floorPlan} editing={editing} selected={isSelected('furniture', item.id)} invalid={issues.has(item.id)} onSelect={() => onSelect({ kind: 'furniture', id: item.id })} />)}
    <ContactShadows position={[0, -0.055, 0]} opacity={floorPlan ? 0.12 : 0.3} scale={30} blur={2.5} far={8} />
    {!floorPlan && <Environment preset="apartment" />}
    <ViewCameras office={layout.office} floorPlan={floorPlan} viewKey={viewKey} />
  </>
}

export default function OfficeScene(props: OfficeSceneProps) {
  // A click that hits no room or furniture clears the selection. Room labels live in the same DOM container,
  // so clicks on them also reach R3F as misses and must be ignored here.
  const onPointerMissed = (e: MouseEvent) => {
    if (!props.editing || (e.target as Element | null)?.closest?.('.room-label')) return
    props.onSelect(null)
  }
  return <Canvas shadows dpr={[1, 1.7]} gl={{ antialias: true }} onPointerMissed={onPointerMissed}>
    <OfficeContents {...props} />
  </Canvas>
}
