import { useState, type ComponentType } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { FURNITURE_SPECS } from '../layout/catalog'
import type { Furniture, FurnitureType } from '../layout/types'
import FootprintOutline from './FootprintOutline'
import { highlightFor } from './highlight'
import { ChairModel, DeskModel, MeetingTableModel, MonitorModel, PlantModel } from './models'

const MODELS: Record<FurnitureType, ComponentType> = {
  desk: DeskModel,
  chair: ChairModel,
  monitor: MonitorModel,
  plant: PlantModel,
  'meeting-table': MeetingTableModel,
}

// Stacking order for floor-plan tiles so monitors and chairs stay visible on top of desks.
const PLAN_HEIGHT: Record<FurnitureType, number> = { desk: 0.06, 'meeting-table': 0.06, plant: 0.06, chair: 0.07, monitor: 0.08 }

function PlanTile({ type }: { type: FurnitureType }) {
  const spec = FURNITURE_SPECS[type]
  return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, PLAN_HEIGHT[type], 0]}>
    {type === 'plant' ? <circleGeometry args={[spec.width / 2, 24]} /> : <planeGeometry args={[spec.width, spec.depth]} />}
    <meshStandardMaterial color={spec.planColor} roughness={0.9} />
  </mesh>
}

export type FurnitureItemProps = { item: Furniture; floorPlan: boolean; editing: boolean; selected: boolean; invalid: boolean; onSelect(): void }

export default function FurnitureItem({ item, floorPlan, editing, selected, invalid, onSelect }: FurnitureItemProps) {
  const [hovered, setHovered] = useState(false)
  const Model = MODELS[item.type]
  const spec = FURNITURE_SPECS[item.type]
  const highlight = highlightFor({ editing, selected, hovered, invalid })
  const pointer = editing ? {
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect() },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(true) },
    onPointerOut: () => setHovered(false),
  } : {}
  return <group position={[item.x, 0, item.z]} rotation={[0, (item.rotation * Math.PI) / 180, 0]} {...pointer}>
    {floorPlan ? <PlanTile type={item.type} /> : <Model />}
    {highlight && <FootprintOutline width={spec.width} depth={spec.depth} color={highlight.color} lineWidth={highlight.width} y={PLAN_HEIGHT[item.type] + 0.02} />}
  </group>
}
