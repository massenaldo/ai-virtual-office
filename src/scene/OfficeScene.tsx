import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows, Environment, Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

type Room = { name: string; x: number; z: number; w: number; d: number; color: string }
const rooms: Room[] = [
  { name: 'CEO OFFICE', x: -7.1, z: -4.3, w: 4.5, d: 3.6, color: '#9c7c59' },
  { name: 'PROJECT MANAGEMENT', x: -2.1, z: -4.3, w: 4.4, d: 3.6, color: '#a8b7a0' },
  { name: 'TECH LEAD', x: 2.5, z: -4.3, w: 3.7, d: 3.6, color: '#8ca9b5' },
  { name: 'BACKEND ENGINEERING', x: 7.0, z: -5.0, w: 4.3, d: 2.4, color: '#7898a7' },
  { name: 'FRONTEND ENGINEERING', x: 7.0, z: -2.2, w: 4.3, d: 2.4, color: '#8daab7' },
  { name: 'DATA & DATABASE', x: 7.0, z: 0.6, w: 4.3, d: 2.4, color: '#6f8f9b' },
  { name: 'UI/UX DESIGN', x: 7.0, z: 3.4, w: 4.3, d: 2.4, color: '#c4a58b' },
  { name: 'QA TESTING', x: 7.0, z: 6.2, w: 4.3, d: 2.4, color: '#b5a5a0' },
  { name: 'MEETING ROOM', x: -3.9, z: 2.2, w: 4.6, d: 3.6, color: '#b99b72' },
  { name: 'DEVOPS / SERVER ROOM', x: -8.0, z: 5.5, w: 3.8, d: 3.0, color: '#596a78' },
]

function Floor({ floorPlan }: { floorPlan: boolean }) {
  const floorMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: floorPlan ? '#d8dce0' : '#b8a58d', roughness: 0.78 }), [floorPlan])
  return <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.08, 0]} material={floorMaterial}>
    <planeGeometry args={[25, 20]} />
  </mesh>
}

function Desk({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  return <group position={position} rotation={[0, rotation, 0]}>
    <mesh castShadow position={[0, 0.78, 0]}><boxGeometry args={[1.35, 0.09, 0.72]} /><meshStandardMaterial color="#b78d61" roughness={0.48} /></mesh>
    {([-0.55, 0.55] as const).map((x) => <mesh key={x} castShadow position={[x, 0.38, 0]}><boxGeometry args={[0.07, 0.75, 0.62]} /><meshStandardMaterial color="#454c54" metalness={0.25} roughness={0.55} /></mesh>)}
    <mesh castShadow position={[0, 1.18, -0.18]}><boxGeometry args={[0.48, 0.32, 0.055]} /><meshStandardMaterial color="#222a33" metalness={0.2} roughness={0.25} /></mesh>
    <mesh position={[0, 1.18, -0.145]}><planeGeometry args={[0.42, 0.25]} /><meshStandardMaterial color="#5e9eaa" emissive="#183d4a" emissiveIntensity={0.35} /></mesh>
    <mesh castShadow position={[0, 0.38, 0.56]}><boxGeometry args={[0.48, 0.08, 0.48]} /><meshStandardMaterial color="#303842" roughness={0.8} /></mesh>
    <mesh castShadow position={[0, 0.64, 0.73]}><boxGeometry args={[0.48, 0.48, 0.08]} /><meshStandardMaterial color="#303842" roughness={0.8} /></mesh>
  </group>
}

function Plant({ position }: { position: [number, number, number] }) {
  return <group position={position}>
    <mesh castShadow position={[0, 0.22, 0]}><cylinderGeometry args={[0.22, 0.28, 0.42, 16]} /><meshStandardMaterial color="#a87955" roughness={0.8} /></mesh>
    <mesh castShadow position={[0, 0.78, 0]}><sphereGeometry args={[0.48, 10, 8]} /><meshStandardMaterial color="#53775d" roughness={0.9} /></mesh>
    <mesh castShadow position={[0.2, 1.0, 0.05]} scale={[0.7, 0.8, 0.7]}><sphereGeometry args={[0.35, 10, 8]} /><meshStandardMaterial color="#6e9270" roughness={0.9} /></mesh>
  </group>
}

function RoomBlock({ room, floorPlan }: { room: Room; floorPlan: boolean }) {
  return <group position={[room.x, 0, room.z]}>
    <mesh receiveShadow position={[0, 0.015, 0]}><boxGeometry args={[room.w, 0.04, room.d]} /><meshStandardMaterial color={room.color} roughness={0.9} transparent opacity={floorPlan ? 0.95 : 0.45} /></mesh>
    {!floorPlan && <>
      {([-room.w / 2, room.w / 2] as const).map((x) => <mesh key={x} castShadow position={[x, 1.25, 0]}><boxGeometry args={[0.09, 2.5, room.d]} /><meshStandardMaterial color="#d4d8d9" roughness={0.3} metalness={0.1} /></mesh>)}
      <mesh castShadow position={[0, 1.25, -room.d / 2]}><boxGeometry args={[room.w, 2.5, 0.08]} /><meshStandardMaterial color="#d9e6e8" transparent opacity={0.38} roughness={0.18} metalness={0.15} /></mesh>
      <mesh castShadow position={[0, 2.48, 0]}><boxGeometry args={[room.w, 0.08, room.d]} /><meshStandardMaterial color="#d2d4d2" roughness={0.5} /></mesh>
    </>}
    <Html position={[0, floorPlan ? 0.3 : 2.72, 0]} center distanceFactor={floorPlan ? 15 : 19} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
      <div className="room-label">{room.name}</div>
    </Html>
  </group>
}

function OfficeContents({ floorPlan }: { floorPlan: boolean }) {
  return <>
    <color attach="background" args={[floorPlan ? '#e9edf0' : '#dbe3e5']} />
    <ambientLight intensity={floorPlan ? 1.6 : 1.15} />
    <directionalLight position={[6, 13, 7]} intensity={floorPlan ? 0.5 : 2.2} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
    <pointLight position={[-6, 5, -3]} intensity={18} color="#ffdfb0" distance={18} />
    <Floor floorPlan={floorPlan} />
    {rooms.map((room) => <RoomBlock key={room.name} room={room} floorPlan={floorPlan} />)}
    {!floorPlan && <>
      {[-7.4, -5.7, -2.7, -1.2, 1.7, 3.1, 6.2, 7.6].map((x, i) => <Desk key={i} position={[x, 0, i < 6 ? -4.4 : -4.9]} />)}
      {[-7.5, -5.8, -2.8, -1.2, 1.6, 3.0].map((x, i) => <Desk key={`front-${i}`} position={[x, 0, i < 4 ? -1.8 : 1.4]} rotation={Math.PI} />)}
      {([[-8.7, 0, -7.8], [-4.5, 0, -7.8], [0, 0, -7.8], [4.5, 0, -7.8], [10.3, 0, -5.9], [10.3, 0, -3.1], [10.3, 0, -0.3], [10.3, 0, 2.5], [10.3, 0, 5.3], [-9.8, 0, 7.5], [1.2, 0, 7.5]] as [number, number, number][]).map((p, i) => <Plant key={i} position={p} />)}
      <group position={[-1.2, 0, 3.4]}>
        <mesh castShadow position={[0, 0.48, 0]}><boxGeometry args={[2.7, 0.12, 1.15]} /><meshStandardMaterial color="#b88e61" roughness={0.5} /></mesh>
        {[-0.9, 0, 0.9].map((x) => <mesh key={x} castShadow position={[x, 0.22, 0]}><cylinderGeometry args={[0.045, 0.045, 0.45, 8]} /><meshStandardMaterial color="#454c54" /></mesh>)}
      </group>
    </>}
    <ContactShadows position={[0, -0.055, 0]} opacity={floorPlan ? 0.12 : 0.3} scale={30} blur={2.5} far={8} />
    {!floorPlan && <Environment preset="apartment" />}
    <OrbitControls makeDefault target={[0, 0.4, 0]} minDistance={7} maxDistance={32} maxPolarAngle={Math.PI / 2.08} />
  </>
}

export default function OfficeScene({ floorPlan }: { floorPlan: boolean }) {
  return <Canvas shadows dpr={[1, 1.7]} camera={{ position: [15, 17, 19], fov: 42 }} gl={{ antialias: true }}>
    <OfficeContents floorPlan={floorPlan} />
  </Canvas>
}
