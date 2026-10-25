import * as THREE from 'three'
import type { FloorFinish } from './finishes'
import { proceduralTexture } from './textures'

type ArchitectureKey = FloorFinish | 'wallPaint' | 'wallCap' | 'baseboard' | 'glass' | 'graphite'
type FurnitureKey = 'oakVeneer' | 'walnut' | 'fabric' | 'plastic' | 'screen' | 'chrome' | 'cabinetWhite' | 'terracotta' | 'foliage'
export type SharedMaterials = Record<ArchitectureKey | FurnitureKey, THREE.MeshStandardMaterial>
export type MaterialKey = keyof SharedMaterials

let shared: SharedMaterials | null = null
const accents = new Map<string, THREE.MeshStandardMaterial>()

function floor(finish: FloorFinish, color: string, roughness: number) {
  const material = new THREE.MeshStandardMaterial({ color, roughness })
  const map = proceduralTexture(finish)
  if (map) material.map = map
  return material
}

/**
 * One instance of every architectural material, shared by all rooms so materials never multiply with the layout.
 * Floor textures are greyscale and tinted by the material colour.
 */
export function sharedMaterials(): SharedMaterials {
  shared ??= {
    concrete: floor('concrete', '#cfcac3', 0.6),
    carpet: floor('carpet', '#8d8a86', 0.95),
    oak: floor('oak', '#c49a6c', 0.55),
    epoxy: floor('epoxy', '#3b4046', 0.35),
    wallPaint: new THREE.MeshStandardMaterial({ color: '#f1eee8', roughness: 0.9 }),
    wallCap: new THREE.MeshStandardMaterial({ color: '#3a3d42', roughness: 0.8 }),
    baseboard: new THREE.MeshStandardMaterial({ color: '#2f3236', roughness: 0.6 }),
    glass: new THREE.MeshStandardMaterial({ color: '#dfe9ec', transparent: true, opacity: 0.28, roughness: 0.1, metalness: 0.1, depthWrite: false }),
    graphite: new THREE.MeshStandardMaterial({ color: '#2b2e33', roughness: 0.45, metalness: 0.4 }),
    oakVeneer: new THREE.MeshStandardMaterial({ color: '#c49a6c', roughness: 0.5 }),
    walnut: new THREE.MeshStandardMaterial({ color: '#6b4a33', roughness: 0.45 }),
    fabric: new THREE.MeshStandardMaterial({ color: '#3b3f45', roughness: 0.95 }),
    plastic: new THREE.MeshStandardMaterial({ color: '#1c1e21', roughness: 0.5 }),
    screen: new THREE.MeshStandardMaterial({ color: '#0f1720', roughness: 0.2, emissive: '#24485a', emissiveIntensity: 0.55 }),
    chrome: new THREE.MeshStandardMaterial({ color: '#b9bdc2', roughness: 0.25, metalness: 0.85 }),
    cabinetWhite: new THREE.MeshStandardMaterial({ color: '#ecebe7', roughness: 0.6 }),
    terracotta: new THREE.MeshStandardMaterial({ color: '#a87955', roughness: 0.8 }),
    foliage: new THREE.MeshStandardMaterial({ color: '#5a7d5c', roughness: 0.9 }),
  }
  return shared
}

export function floorMaterial(finish: FloorFinish): THREE.MeshStandardMaterial {
  return sharedMaterials()[finish]
}

/** Department accent (floor inlay), cached so rooms with the same colour share one material. */
export function accentMaterial(color: string): THREE.MeshStandardMaterial {
  let material = accents.get(color)
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, roughness: 0.7 })
    accents.set(color, material)
  }
  return material
}
