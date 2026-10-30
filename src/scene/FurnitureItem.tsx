import { useEffect, useState } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { FURNITURE_SPECS } from '../layout/catalog'
import type { Furniture, FurnitureType, Selection } from '../layout/types'
import type { TransformIntent } from '../editor/transform'
import FootprintOutline from './FootprintOutline'
import { modelParts, plantVariant } from './furnitureModels'
import { highlightFor } from './highlight'
import { sharedMaterials } from './materials'
import { useFloorDrag } from './useFloorDrag'

// Stacking order for floor-plan tiles so monitors and chairs stay visible on top of desks and tables.
const PLAN_HEIGHT: Record<FurnitureType, number> = { desk: 0.06, 'meeting-table': 0.06, plant: 0.06, 'storage-cabinet': 0.06, shelf: 0.06, chair: 0.07, 'meeting-chair': 0.07, monitor: 0.08 }

function PlanTile({ type }: { type: FurnitureType }) {
  const spec = FURNITURE_SPECS[type]
  return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, PLAN_HEIGHT[type], 0]}>
    {type === 'plant' ? <circleGeometry args={[spec.width / 2, 24]} /> : <planeGeometry args={[spec.width, spec.depth]} />}
    <meshStandardMaterial color={spec.planColor} roughness={0.9} />
  </mesh>
}

/** Shared, merged model geometry: one mesh per material, reused by every item of this type. */
function Model({ type, variant }: { type: FurnitureType; variant: number }) {
  const materials = sharedMaterials()
  return <>{modelParts(type, variant).map((part) => <mesh key={part.material} geometry={part.geometry} material={materials[part.material]} castShadow={part.castShadow} receiveShadow />)}</>
}

export type FurnitureItemProps = {
  item: Furniture
  floorPlan: boolean
  editing: boolean
  selected: boolean
  invalid: boolean
  onSelect(): void
  onTransformStart(target: NonNullable<Selection>): void
  onTransform(intent: TransformIntent): void
  onTransformEnd(): void
  /** Outline the desk of the selected agent (outside edit mode). */
  agentHighlight?: boolean
  /** Workforce mode: clicking this desk opens or assigns its agent. Never passed in edit mode. */
  onDeskClick?: () => void
}

/** A press that moved further than this many pixels was an orbit or pan, not a click. */
const CLICK_SLOP = 4

export default function FurnitureItem({ item, floorPlan, editing, selected, invalid, onSelect, onTransformStart, onTransform, onTransformEnd, agentHighlight = false, onDeskClick }: FurnitureItemProps) {
  const [hovered, setHovered] = useState(false)
  const target = { kind: 'furniture' as const, id: item.id }
  const drag = useFloorDrag({
    enabled: editing,
    origin: () => ({ x: item.x, z: item.z }),
    onStart: () => onTransformStart(target),
    onMove: (p) => onTransform({ kind: 'move', target, x: p.x, z: p.z }),
    onEnd: onTransformEnd,
  })
  const spec = FURNITURE_SPECS[item.type]
  const deskClick = !editing && onDeskClick ? onDeskClick : undefined
  const highlight = highlightFor({ editing, selected, hovered, invalid, agent: agentHighlight, deskHover: hovered && !!deskClick })
  // The pointer cursor belongs to a hovered clickable desk; reset it when the desk stops being clickable or unmounts.
  useEffect(() => {
    if (!deskClick || !hovered) return
    document.body.style.cursor = 'pointer'
    return () => { document.body.style.cursor = '' }
  }, [deskClick, hovered])
  const pointer = editing ? {
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect() },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(true) },
    onPointerOut: () => setHovered(false),
  } : deskClick ? {
    onClick: (e: ThreeEvent<MouseEvent>) => { if (e.delta > CLICK_SLOP) return; e.stopPropagation(); deskClick() },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(true) },
    onPointerOut: () => setHovered(false),
  } : {}
  return <group position={[item.x, 0, item.z]} rotation={[0, (item.rotation * Math.PI) / 180, 0]} {...pointer} {...drag}>
    {floorPlan ? <PlanTile type={item.type} /> : <Model type={item.type} variant={item.type === 'plant' ? plantVariant(item.id) : 0} />}
    {highlight && <FootprintOutline width={spec.width} depth={spec.depth} color={highlight.color} lineWidth={highlight.width} y={PLAN_HEIGHT[item.type] + 0.02} />}
  </group>
}
