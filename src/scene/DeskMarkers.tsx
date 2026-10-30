import { useEffect } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { markerAnchor, screenPosition, type DeskMarker } from './labels'

/** Marker elements by marker id, shared between the DOM layer and the tracker that moves them. */
export type MarkerRegistry = Map<string, HTMLDivElement>

const anchor = new THREE.Vector3()

/** Status markers as plain DOM over the canvas, like the room labels. They never take pointer events, so the desk below stays clickable. */
export function DeskMarkerLayer({ markers, registry }: { markers: DeskMarker[]; registry: MarkerRegistry }) {
  return <div className="desk-marker-layer" aria-hidden="true">
    {markers.map((m) => <div key={m.id} ref={(el) => { if (el) registry.set(m.id, el); else registry.delete(m.id) }} className={`desk-marker ${m.status}${m.selected ? ' selected' : ''}`}>
      <span className="desk-marker-dot"/>{m.label}
    </div>)}
  </div>
}

/** Moves each marker to its desk on screen every frame, without React state updates. */
export function DeskMarkerTracker({ markers, floorPlan, registry }: { markers: DeskMarker[]; floorPlan: boolean; registry: MarkerRegistry }) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  // Rendering is on demand, so a new or moved marker needs one frame to be placed.
  const placement = markers.map((m) => `${m.id}:${m.x}:${m.z}`).join('|')
  useEffect(() => invalidate(), [placement, invalidate])
  useFrame(() => {
    for (const m of markers) {
      const el = registry.get(m.id)
      if (!el) continue
      const p = screenPosition(markerAnchor(m, floorPlan, anchor), camera, size)
      el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -100%)`
      el.style.visibility = p.visible ? 'visible' : 'hidden'
    }
  })
  return null
}
