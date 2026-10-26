import { useLayoutEffect, useMemo, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, Grid, Lightformer, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { OfficeLayout, OfficeSettings, Selection } from '../layout/types'
import type { Issue } from '../layout/validation'
import type { TransformIntent } from '../editor/transform'
import { OVERVIEW_DIRECTION, OVERVIEW_FOV, fitOverview } from './camera'
import FurnitureItem from './FurnitureItem'
import { floorMaterial } from './materials'
import ResizeHandles from './ResizeHandles'
import { RoomLabelLayer, RoomLabelTracker, type LabelRegistry } from './RoomLabels'
import RoomMesh from './RoomMesh'
import { RenderStatsPanel, RenderStatsProbe } from './StatsOverlay'
import { statsEnabled } from './renderStats'
import { scaleFloorUvs } from './textures'

export type OfficeSceneProps = {
  layout: OfficeLayout
  floorPlan: boolean
  viewKey: number
  editing: boolean
  selection: Selection
  issues: Map<string, Issue[]>
  onSelect(selection: Selection): void
  onTransformStart(target: NonNullable<Selection>): void
  onTransform(intent: TransformIntent): void
  onTransformEnd(): void
}

const planFloorMaterial = new THREE.MeshStandardMaterial({ color: '#d8dce0', roughness: 0.9 })

/** Office floor at y = 0, the level furniture stands on: polished concrete in 3D, a plain sheet in floor plan. */
function Floor({ office, floorPlan }: { office: OfficeSettings; floorPlan: boolean }) {
  const geometry = useMemo(() => scaleFloorUvs(new THREE.PlaneGeometry(office.width, office.depth), office.width, office.depth, 'concrete'), [office.width, office.depth])
  return <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} geometry={geometry} material={floorPlan ? planFloorMaterial : floorMaterial('concrete')} />
}

/** Daylight from a large soft overhead panel, warm window light from −X and a cool bounce from +Z; built in code, no downloads. */
function StudioEnvironment({ floorPlan }: { floorPlan: boolean }) {
  return <Environment resolution={256} frames={1} environmentIntensity={floorPlan ? 0.6 : 1}>
    <Lightformer form="rect" intensity={1.6} color="#fff6ea" position={[0, 10, 0]} rotation-x={Math.PI / 2} scale={[24, 24, 1]} />
    <Lightformer form="rect" intensity={0.8} color="#ffe7c7" position={[-16, 5, 0]} rotation-y={Math.PI / 2} scale={[24, 6, 1]} />
    <Lightformer form="rect" intensity={0.4} color="#dfe9ff" position={[0, 5, 16]} rotation-y={Math.PI} scale={[24, 6, 1]} />
  </Environment>
}

const SHOW_STATS = typeof window !== 'undefined' && statsEnabled(window.location.search)

// Top-down view has no rotation, so the left button pans like a map.
const PLAN_MOUSE_BUTTONS = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }


/**
 * Owns both cameras and makes one the scene default. Switching view or bumping viewKey
 * puts the camera back at its start position: the 3D overview or a straight-down floor plan fitted to the office.
 */
function ViewCameras({ layout, floorPlan, viewKey }: { layout: OfficeLayout; floorPlan: boolean; viewKey: number }) {
  const office = layout.office
  const set = useThree((s) => s.set)
  const size = useThree((s) => s.size)
  const perspective = useMemo(() => new THREE.PerspectiveCamera(OVERVIEW_FOV, 1, 0.1, 1000), [])
  const ortho = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100), [])
  const camera = floorPlan ? ortho : perspective
  const fitZoom = Math.min(size.width / (office.width + 2), size.height / (office.depth + 2))
  // Framing is computed when the view is entered or reset, then frozen, so a resize never moves the orbit pivot.
  const overview = useMemo(() => fitOverview(layout, size.width / size.height), [floorPlan, viewKey])

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
      perspective.position.set(...overview.target).addScaledVector(OVERVIEW_DIRECTION, overview.distance)
      perspective.lookAt(...overview.target)
    }
    camera.updateProjectionMatrix()
    set({ camera })
    // fitZoom is read only when the view is (re)entered, so resizing doesn't undo the user's zoom.
  }, [camera, viewKey])

  return floorPlan
    ? <OrbitControls key={`plan-${viewKey}`} camera={camera} makeDefault target={[0, 0, 0]} enableRotate={false} mouseButtons={PLAN_MOUSE_BUTTONS} screenSpacePanning minZoom={fitZoom * 0.6} maxZoom={fitZoom * 4} />
    : <OrbitControls key={`3d-${viewKey}`} camera={camera} makeDefault target={overview.target} minDistance={7} maxDistance={Math.max(32, overview.distance * 1.4)} maxPolarAngle={Math.PI / 2.08} />
}

function OfficeContents({ layout, floorPlan, viewKey, editing, selection, issues, labels, onSelect, onTransformStart, onTransform, onTransformEnd }: OfficeSceneProps & { labels: LabelRegistry }) {
  const isSelected = (kind: 'room' | 'furniture', id: string) => selection?.kind === kind && selection.id === id
  const transform = { onTransformStart, onTransform, onTransformEnd }
  const selectedRoom = selection?.kind === 'room' ? layout.rooms.find((r) => r.id === selection.id) : undefined
  return <>
    <color attach="background" args={[floorPlan ? '#eceae6' : '#e6e3de']} />
    <ambientLight intensity={floorPlan ? 1.4 : 0.55} />
    {/* The shadow camera covers the whole 25 × 20 m office; three's default ±5 m box left most of it unshadowed. */}
    <directionalLight position={[12, 18, 8]} intensity={floorPlan ? 0.6 : 2} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048}
      shadow-camera-left={-16} shadow-camera-right={16} shadow-camera-top={16} shadow-camera-bottom={-16} shadow-camera-near={1} shadow-camera-far={60} shadow-bias={-0.0004} shadow-normalBias={0.02} />
    <Floor office={layout.office} floorPlan={floorPlan} />
    {layout.rooms.map((room) => <RoomMesh key={room.id} room={room} floorPlan={floorPlan} editing={editing} selected={isSelected('room', room.id)} invalid={issues.has(room.id)} onSelect={() => onSelect({ kind: 'room', id: room.id })} {...transform} />)}
    {layout.furniture.map((item) => <FurnitureItem key={item.id} item={item} floorPlan={floorPlan} editing={editing} selected={isSelected('furniture', item.id)} invalid={issues.has(item.id)} onSelect={() => onSelect({ kind: 'furniture', id: item.id })} {...transform} />)}
    {editing && floorPlan && <Grid position={[0, 0.045, 0]} args={[layout.office.width, layout.office.depth]} cellSize={layout.office.gridSize} cellThickness={0.6} cellColor="#9aa6b0" sectionSize={1} sectionThickness={1} sectionColor="#6f7d89" fadeDistance={200} raycast={() => null} />}
    {editing && floorPlan && selectedRoom && <ResizeHandles room={selectedRoom} {...transform} />}
    <ContactShadows position={[0, 0.03, 0]} opacity={floorPlan ? 0.12 : 0.3} scale={30} blur={2.5} far={8} />
    <StudioEnvironment floorPlan={floorPlan} />
    <ViewCameras layout={layout} floorPlan={floorPlan} viewKey={viewKey} />
    <RoomLabelTracker rooms={layout.rooms} floorPlan={floorPlan} registry={labels} />
  </>
}

export default function OfficeScene(props: OfficeSceneProps) {
  const labels = useRef<LabelRegistry>(new Map()).current
  const statsPanel = useRef<HTMLDivElement>(null)
  // A click that hits no room or furniture clears the selection.
  const onPointerMissed = () => {
    if (props.editing) props.onSelect(null)
  }
  return <>
  <Canvas shadows="soft" dpr={[1, 1.7]} gl={{ antialias: true }} onCreated={({ gl }) => { gl.toneMappingExposure = 0.95 }} onPointerMissed={onPointerMissed}>
    <OfficeContents {...props} labels={labels} />
    {SHOW_STATS && <RenderStatsProbe panel={statsPanel} />}
  </Canvas>
  {SHOW_STATS && <RenderStatsPanel panel={statsPanel} />}
  <RoomLabelLayer rooms={props.layout.rooms} editing={props.editing} selection={props.selection} registry={labels} onSelect={props.onSelect} />
  </>
}
