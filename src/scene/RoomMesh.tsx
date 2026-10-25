import { Html } from '@react-three/drei'
import type { Room } from '../layout/types'

export default function RoomMesh({ room, floorPlan }: { room: Room; floorPlan: boolean }) {
  const h = room.wallHeight
  return <group position={[room.x, 0, room.z]}>
    <mesh receiveShadow position={[0, 0.015, 0]}><boxGeometry args={[room.width, 0.04, room.depth]} /><meshStandardMaterial color={room.color} roughness={0.9} transparent opacity={floorPlan ? 0.95 : 0.45} /></mesh>
    {!floorPlan && <>
      {([-room.width / 2, room.width / 2] as const).map((x) => <mesh key={x} castShadow position={[x, h / 2, 0]}><boxGeometry args={[0.09, h, room.depth]} /><meshStandardMaterial color="#d4d8d9" roughness={0.3} metalness={0.1} /></mesh>)}
      <mesh castShadow position={[0, h / 2, -room.depth / 2]}><boxGeometry args={[room.width, h, 0.08]} /><meshStandardMaterial color="#d9e6e8" transparent opacity={0.38} roughness={0.18} metalness={0.15} /></mesh>
      <mesh castShadow position={[0, h - 0.02, 0]}><boxGeometry args={[room.width, 0.08, room.depth]} /><meshStandardMaterial color="#d2d4d2" roughness={0.5} /></mesh>
    </>}
    <Html position={[0, floorPlan ? 0.3 : h + 0.22, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
      <div className="room-label">{room.name}</div>
    </Html>
  </group>
}
