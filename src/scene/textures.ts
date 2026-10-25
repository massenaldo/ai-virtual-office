import * as THREE from 'three'
import type { FloorFinish } from './finishes'

const SIZE = 256

// Deterministic noise so the floors look the same on every load.
function random(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

type Painter = (ctx: CanvasRenderingContext2D, rand: () => number) => void

const speckle = (ctx: CanvasRenderingContext2D, rand: () => number, count: number, size: number, alpha: number, light: boolean) => {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = light ? `rgba(255,255,255,${rand() * alpha})` : `rgba(0,0,0,${rand() * alpha})`
    ctx.fillRect(rand() * SIZE, rand() * SIZE, size, size)
  }
}

const PAINTERS: Record<FloorFinish, Painter> = {
  // Polished concrete: soft mottled clouds plus fine aggregate.
  concrete: (ctx, rand) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, SIZE, SIZE)
    for (let i = 0; i < 70; i++) {
      const g = ctx.createRadialGradient(rand() * SIZE, rand() * SIZE, 0, rand() * SIZE, rand() * SIZE, 20 + rand() * 60)
      g.addColorStop(0, `rgba(0,0,0,${0.03 + rand() * 0.04})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, SIZE, SIZE)
    }
    speckle(ctx, rand, 1400, 1, 0.12, false)
    speckle(ctx, rand, 500, 1, 0.25, true)
  },
  // Carpet tiles: 4 × 4 tiles with alternating pile direction and fine fibre speckle.
  carpet: (ctx, rand) => {
    const tile = SIZE / 4
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#f4f4f4' : '#e8e8e8'
        ctx.fillRect(x * tile, y * tile, tile, tile)
      }
    }
    speckle(ctx, rand, 6000, 1, 0.18, false)
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * tile, 0); ctx.lineTo(i * tile, SIZE); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, i * tile); ctx.lineTo(SIZE, i * tile); ctx.stroke()
    }
  },
  // Oak planks: 6 planks across, staggered end joints, light grain lines.
  oak: (ctx, rand) => {
    const plank = SIZE / 6
    for (let i = 0; i < 6; i++) {
      const shade = 225 + Math.floor(rand() * 30)
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`
      ctx.fillRect(i * plank, 0, plank, SIZE)
      for (let g = 0; g < 14; g++) {
        ctx.strokeStyle = `rgba(0,0,0,${0.04 + rand() * 0.06})`
        ctx.lineWidth = rand() < 0.2 ? 1.5 : 0.7
        const x = i * plank + rand() * plank
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.bezierCurveTo(x + rand() * 4 - 2, SIZE * 0.33, x + rand() * 4 - 2, SIZE * 0.66, x + rand() * 3 - 1.5, SIZE)
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(0,0,0,0.18)'
      ctx.fillRect(i * plank, 0, 1, SIZE)
      ctx.fillRect(i * plank, (i % 2 ? 0.3 : 0.75) * SIZE, plank, 1)
    }
  },
  // Epoxy: smooth with faint flecks.
  epoxy: (ctx, rand) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, SIZE, SIZE)
    speckle(ctx, rand, 900, 1.5, 0.35, true)
    speckle(ctx, rand, 600, 1, 0.12, false)
  },
}

const SEEDS: Record<FloorFinish, number> = { concrete: 11, carpet: 23, oak: 37, epoxy: 41 }

/** Greyscale tileable texture tinted by the material colour; null outside the browser (tests, SSR). */
export function proceduralTexture(kind: FloorFinish): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  PAINTERS[kind](ctx, random(SEEDS[kind]))
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}
