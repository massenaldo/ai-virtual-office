// Furniture geometry from the original prototype. Each model's origin is its footprint centre on the floor, facing rotation 0.

export function DeskModel() {
  return <group>
    <mesh castShadow position={[0, 0.78, 0]}><boxGeometry args={[1.35, 0.09, 0.72]} /><meshStandardMaterial color="#b78d61" roughness={0.48} /></mesh>
    {([-0.55, 0.55] as const).map((x) => <mesh key={x} castShadow position={[x, 0.38, 0]}><boxGeometry args={[0.07, 0.75, 0.62]} /><meshStandardMaterial color="#454c54" metalness={0.25} roughness={0.55} /></mesh>)}
  </group>
}

export function MonitorModel() {
  return <group>
    <mesh castShadow position={[0, 1.18, 0]}><boxGeometry args={[0.48, 0.32, 0.055]} /><meshStandardMaterial color="#222a33" metalness={0.2} roughness={0.25} /></mesh>
    <mesh position={[0, 1.18, 0.035]}><planeGeometry args={[0.42, 0.25]} /><meshStandardMaterial color="#5e9eaa" emissive="#183d4a" emissiveIntensity={0.35} /></mesh>
  </group>
}

export function ChairModel() {
  return <group>
    <mesh castShadow position={[0, 0.38, 0]}><boxGeometry args={[0.48, 0.08, 0.48]} /><meshStandardMaterial color="#303842" roughness={0.8} /></mesh>
    <mesh castShadow position={[0, 0.64, 0.17]}><boxGeometry args={[0.48, 0.48, 0.08]} /><meshStandardMaterial color="#303842" roughness={0.8} /></mesh>
  </group>
}

export function PlantModel() {
  return <group>
    <mesh castShadow position={[0, 0.22, 0]}><cylinderGeometry args={[0.22, 0.28, 0.42, 16]} /><meshStandardMaterial color="#a87955" roughness={0.8} /></mesh>
    <mesh castShadow position={[0, 0.78, 0]}><sphereGeometry args={[0.48, 10, 8]} /><meshStandardMaterial color="#53775d" roughness={0.9} /></mesh>
    <mesh castShadow position={[0.2, 1.0, 0.05]} scale={[0.7, 0.8, 0.7]}><sphereGeometry args={[0.35, 10, 8]} /><meshStandardMaterial color="#6e9270" roughness={0.9} /></mesh>
  </group>
}

export function MeetingTableModel() {
  return <group>
    <mesh castShadow position={[0, 0.48, 0]}><boxGeometry args={[2.7, 0.12, 1.15]} /><meshStandardMaterial color="#b88e61" roughness={0.5} /></mesh>
    {[-0.9, 0, 0.9].map((x) => <mesh key={x} castShadow position={[x, 0.22, 0]}><cylinderGeometry args={[0.045, 0.045, 0.45, 8]} /><meshStandardMaterial color="#454c54" /></mesh>)}
  </group>
}
