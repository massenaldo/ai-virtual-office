import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { markerAnchor, markerText, screenPosition, type DeskMarker } from './labels'
import type { PresenceSource } from './presenceTypes'

/** Marker elements by marker id, shared between the DOM layer and the tracker that moves them. */
export type MarkerRegistry = Map<string, HTMLDivElement>

const anchor = new THREE.Vector3()
const spot = { x: 0, z: 0, seated: true }

/**
 * Status markers as plain DOM over the canvas, like the room labels. They never take pointer events, so the desk below stays
 * clickable. Each has its text, which the tracker rewrites while the agent is away from its desk, and a chat bubble of three dots
 * (no words) that is shown only while it chats.
 */
export function DeskMarkerLayer({ markers, registry }: { markers: DeskMarker[]; registry: MarkerRegistry }) {
  return <div className="desk-marker-layer" aria-hidden="true">
    {markers.map((m) => <div key={m.id} ref={(el) => { if (el) registry.set(m.id, el); else registry.delete(m.id) }} className={`desk-marker ${m.status}${m.selected ? ' selected' : ''}${m.phase ? ` phase-${m.phase}` : ''}`}>
      <span className="desk-marker-dot"/><span className="desk-marker-text">{m.label}</span>
      <span className="chat-bubble" hidden><i/><i/><i/></span>
    </div>)}
  </div>
}

type Written = { text: string; bubble: boolean }

/**
 * Moves each marker to its character on screen every frame, without React state updates. Position and label come from the same
 * source as the character, so the label follows it. The text and the bubble are written to the DOM only when they change.
 */
export function DeskMarkerTracker({ markers, presence, floorPlan, registry }: { markers: DeskMarker[]; presence: PresenceSource; floorPlan: boolean; registry: MarkerRegistry }) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  const written = useRef(new Map<string, Written>())
  // Rendering is on demand, so a new or moved marker needs one frame to be placed.
  const placement = markers.map((m) => `${m.id}:${m.x}:${m.z}`).join('|')
  useEffect(() => invalidate(), [placement, invalidate])
  // New markers come with their own text from React, so forget what was written over the old ones.
  useEffect(() => { written.current.clear() }, [markers])
  useFrame(() => {
    for (const m of markers) {
      const el = registry.get(m.id)
      if (!el) continue
      const p = presence(m.id)
      spot.x = p ? p.x : m.x
      spot.z = p ? p.z : m.z
      spot.seated = p ? p.pose === 'sit' : m.seated
      const text = markerText(m.label, p ? p.label : null, m.phase, m.held)
      const bubble = !!p?.bubble
      const last = written.current.get(m.id)
      if (!last || last.text !== text || last.bubble !== bubble) {
        const textEl = el.children[1] as HTMLElement | undefined
        const bubbleEl = el.children[2] as HTMLElement | undefined
        if (textEl && (!last || last.text !== text)) textEl.textContent = text
        if (bubbleEl && (!last || last.bubble !== bubble)) bubbleEl.hidden = !bubble
        written.current.set(m.id, { text, bubble })
      }
      const px = screenPosition(markerAnchor(spot, floorPlan, anchor), camera, size)
      el.style.transform = `translate3d(${px.x}px, ${px.y}px, 0) translate(-50%, -100%)`
      el.style.visibility = px.visible ? 'visible' : 'hidden'
    }
  })
  return null
}
