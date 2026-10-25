import type { ComponentType } from 'react'
import { FURNITURE_SPECS } from '../layout/catalog'
import type { Furniture, FurnitureType } from '../layout/types'
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

export default function FurnitureItem({ item, floorPlan }: { item: Furniture; floorPlan: boolean }) {
  const Model = MODELS[item.type]
  return <group position={[item.x, 0, item.z]} rotation={[0, (item.rotation * Math.PI) / 180, 0]}>
    {floorPlan ? <PlanTile type={item.type} /> : <Model />}
  </group>
}
