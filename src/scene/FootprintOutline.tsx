import { Line } from '@react-three/drei'

/** Rectangle drawn on the floor around a footprint; ignores depth so it stays visible through models. */
export default function FootprintOutline({ width, depth, color, lineWidth, y = 0.06 }: { width: number; depth: number; color: string; lineWidth: number; y?: number }) {
  const w = width / 2
  const d = depth / 2
  return <Line points={[[-w, y, -d], [w, y, -d], [w, y, d], [-w, y, d], [-w, y, -d]]} color={color} lineWidth={lineWidth} depthTest={false} renderOrder={5} />
}
