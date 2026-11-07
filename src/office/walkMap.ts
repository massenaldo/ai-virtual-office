import { furnitureRect, roomRect, rotateOffset, type Rect } from '../layout/geometry'
import type { OfficeLayout, Room } from '../layout/types'

// Where characters can walk. Everything here is a pure function of the layout; the only memory is a cache of routes,
// which can never change an answer. It imports nothing from the scene, so the rules for walls are worked out again here.

export type Point = { x: number; z: number }
export type WalkMap = {
  /** A route from one point to another, first and last points included, or null when there is none. Do not change it. */
  route(from: Point, to: Point): Point[] | null
  /** The point itself when its cell is free, else the centre of the nearest free cell, or null. */
  nearestFree(point: Point): Point | null
  /** Whether the point is on a free cell. */
  isFree(point: Point): boolean
  /**
   * A number shared by every point that can walk to each other, or null for a point that can't join the floor at all.
   * Two points with different numbers have no route. Floors too large to label give every point the same number.
   */
  regionOf(point: Point): number | null
  /** The walls and furniture that block walking, for drawing and checking. */
  readonly obstacles: readonly Rect[]
}

/** Furniture people walk around. Chairs, monitors, the coffee machine and mats are left out so a character can reach a seat. */
const BLOCKING = new Set(['desk', 'meeting-table', 'dining-table', 'kitchen-counter', 'storage-cabinet', 'shelf', 'plant'])

// Side walls are solid (0.12 m) or glass (0.04 m) depending on the room; both stop people, so the thicker is assumed.
// The back is always glass.
const SIDE_WALL = 0.12
const BACK_WALL = 0.04
const OVERLAP = 0.01
const DEFAULT_GRID = 0.25
/** How far, in cells, a point in a blocked cell looks for a free one to step to. */
const HOP_RADIUS = 3
/** Bounds the search, so an enormous floor can't hang the page. */
const MAX_EXPANSIONS = 60_000
const MAX_CACHE = 4000
/** Floors with more cells than this are not labelled into regions. */
const MAX_LABELLED_CELLS = 1_000_000
/** A line must keep this far from blocked cells, which also stops it slipping between two cells that touch at a corner. */
const CLEARANCE = 0.05
const SAMPLE_STEP = 0.05

const norm = (degrees: number) => ((degrees % 360) + 360) % 360

/** The rig's heading for a direction on the floor: 0 faces -Z and a positive value turns toward -X. */
export function headingOf(dx: number, dz: number): number {
  return norm((Math.atan2(-dx, -dz) * 180) / Math.PI + 0)
}

export function routeLength(route: Point[]): number {
  let total = 0
  for (let i = 1; i < route.length; i++) total += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z)
  return total
}

/** The point `metres` along the route (clamped to its ends), and the heading it walks in there. */
export function pointAlong(route: Point[], metres: number): { x: number; z: number; heading: number } {
  if (route.length === 0) return { x: 0, z: 0, heading: 0 }
  let remaining = Math.max(0, Number.isFinite(metres) ? metres : 0)
  let heading = 0
  let lastDirection = false
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]
    const b = route[i]
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    if (length === 0) continue
    heading = headingOf(b.x - a.x, b.z - a.z)
    lastDirection = true
    if (remaining <= length) {
      const t = remaining / length
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading }
    }
    remaining -= length
  }
  const end = route[route.length - 1]
  return { x: end.x, z: end.z, heading: lastDirection ? heading : 0 }
}

function wallRects(room: Room): Rect[] {
  const turned = room.rotation % 180 !== 0
  const lw = turned ? room.depth : room.width
  const ld = turned ? room.width : room.depth
  // Room-local boxes [x0, x1, z0, z1]: left and right walls, and the back. The front (+Z) is open.
  const boxes: [number, number, number, number][] = [
    [-lw / 2, -lw / 2 + SIDE_WALL, -ld / 2, ld / 2],
    [lw / 2 - SIDE_WALL, lw / 2, -ld / 2, ld / 2],
    [-lw / 2, lw / 2, -ld / 2, -ld / 2 + BACK_WALL],
  ]
  return boxes.map(([x0, x1, z0, z1]) => {
    const corners = [rotateOffset(x0, z0, room.rotation), rotateOffset(x0, z1, room.rotation), rotateOffset(x1, z0, room.rotation), rotateOffset(x1, z1, room.rotation)]
    const xs = corners.map((c) => room.x + c.dx)
    const zs = corners.map((c) => room.z + c.dz)
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
  })
}

const finite = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.z)

/** Whether the open segment between the points passes through the inside of the rectangle. */
function segmentCrosses(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dz = b.z - a.z
  for (const [p, q] of [[-dx, a.x - r.minX], [dx, r.maxX - a.x], [-dz, a.z - r.minZ], [dz, r.maxZ - a.z]] as const) {
    if (p === 0) {
      if (q <= 0) return false
    } else {
      const t = q / p
      if (p < 0) {
        if (t > t1) return false
        if (t > t0) t0 = t
      } else {
        if (t < t0) return false
        if (t < t1) t1 = t
      }
    }
  }
  return t1 - t0 > 1e-9
}

type Heap = { f: number; g: number; key: number }[]
const before = (a: Heap[number], b: Heap[number]) => a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.key < b.key)))
function push(heap: Heap, item: Heap[number]) {
  heap.push(item)
  let i = heap.length - 1
  while (i > 0) {
    const parent = (i - 1) >> 1
    if (!before(heap[i], heap[parent])) break
    ;[heap[i], heap[parent]] = [heap[parent], heap[i]]
    i = parent
  }
}
function pop(heap: Heap): Heap[number] {
  const top = heap[0]
  const last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heap.length && before(heap[l], heap[m])) m = l
      if (r < heap.length && before(heap[r], heap[m])) m = r
      if (m === i) break
      ;[heap[i], heap[m]] = [heap[m], heap[i]]
      i = m
    }
  }
  return top
}

const NEIGHBOURS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

export function createWalkMap(layout: OfficeLayout): WalkMap {
  const grid = Number.isFinite(layout.office.gridSize) && layout.office.gridSize > 0 ? layout.office.gridSize : DEFAULT_GRID
  const originX = -layout.office.width / 2
  const originZ = -layout.office.depth / 2
  const cols = Math.max(0, Math.ceil(layout.office.width / grid))
  const rows = Math.max(0, Math.ceil(layout.office.depth / grid))
  const usable = Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0

  const obstacles: Rect[] = []
  for (const room of layout.rooms) {
    const r = roomRect(room)
    if (![r.minX, r.maxX, r.minZ, r.maxZ].every(Number.isFinite)) continue
    obstacles.push(...wallRects(room))
  }
  for (const f of layout.furniture) {
    if (!BLOCKING.has(f.type)) continue
    const r = furnitureRect(f)
    if ([r.minX, r.maxX, r.minZ, r.maxZ].every(Number.isFinite)) obstacles.push(r)
  }

  const blocked = new Set<number>()
  const keyOf = (col: number, row: number) => row * cols + col
  const colOf = (x: number) => Math.floor((x - originX) / grid)
  const rowOf = (z: number) => Math.floor((z - originZ) / grid)
  const centre = (col: number, row: number): Point => ({ x: originX + (col + 0.5) * grid, z: originZ + (row + 0.5) * grid })
  const inBounds = (col: number, row: number) => col >= 0 && row >= 0 && col < cols && row < rows
  const isBlockedCell = (col: number, row: number) => !inBounds(col, row) || blocked.has(keyOf(col, row))
  if (usable) {
    for (const r of obstacles) {
      const c0 = Math.max(0, Math.floor((r.minX + OVERLAP - originX) / grid))
      const c1 = Math.min(cols - 1, Math.ceil((r.maxX - OVERLAP - originX) / grid) - 1)
      const r0 = Math.max(0, Math.floor((r.minZ + OVERLAP - originZ) / grid))
      const r1 = Math.min(rows - 1, Math.ceil((r.maxZ - OVERLAP - originZ) / grid) - 1)
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) blocked.add(keyOf(col, row))
    }
  }

  const blockedAt = (x: number, z: number) => isBlockedCell(colOf(x), rowOf(z))
  const insideObstacle = (p: Point) => obstacles.some((r) => p.x > r.minX && p.x < r.maxX && p.z > r.minZ && p.z < r.maxZ)
  const exactClear = (a: Point, b: Point) => !obstacles.some((r) => segmentCrosses(a, b, r))

  /** A line that keeps CLEARANCE from every blocked cell. */
  function lineClear(a: Point, b: Point): boolean {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const length = Math.hypot(dx, dz)
    const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP))
    const nx = length > 0 ? (-dz / length) * CLEARANCE : 0
    const nz = length > 0 ? (dx / length) * CLEARANCE : 0
    for (let i = 0; i <= steps; i++) {
      const x = a.x + (dx * i) / steps
      const z = a.z + (dz * i) / steps
      if (blockedAt(x, z) || blockedAt(x + nx, z + nz) || blockedAt(x - nx, z - nz)) return false
    }
    return true
  }

  /** The nearest free cell, within HOP_RADIUS, that the point can step to without touching anything. */
  function hop(p: Point): { col: number; row: number } | null {
    if (insideObstacle(p)) return null
    const col0 = colOf(p.x)
    const row0 = rowOf(p.z)
    const found: { d: number; col: number; row: number }[] = []
    for (let dr = -HOP_RADIUS; dr <= HOP_RADIUS; dr++) {
      for (let dc = -HOP_RADIUS; dc <= HOP_RADIUS; dc++) {
        const col = col0 + dc
        const row = row0 + dr
        if (isBlockedCell(col, row)) continue
        const c = centre(col, row)
        found.push({ d: Math.hypot(c.x - p.x, c.z - p.z), col, row })
      }
    }
    found.sort((a, b) => a.d - b.d || a.row - b.row || a.col - b.col)
    for (const f of found) if (exactClear(p, centre(f.col, f.row))) return { col: f.col, row: f.row }
    return null
  }

  function search(startKey: number, goalKey: number): number[] | null {
    if (startKey === goalKey) return [startKey]
    const goalCol = goalKey % cols
    const goalRow = Math.floor(goalKey / cols)
    const heuristic = (col: number, row: number) => {
      const dx = Math.abs(col - goalCol)
      const dy = Math.abs(row - goalRow)
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
    }
    const best = new Map<number, number>([[startKey, 0]])
    const parent = new Map<number, number>()
    const closed = new Set<number>()
    const heap: Heap = []
    push(heap, { f: heuristic(startKey % cols, Math.floor(startKey / cols)), g: 0, key: startKey })
    let expansions = 0
    while (heap.length > 0) {
      const { g, key } = pop(heap)
      if (closed.has(key)) continue
      if (key === goalKey) {
        const path = [key]
        for (let k = key; parent.has(k);) {
          k = parent.get(k)!
          path.push(k)
        }
        return path.reverse()
      }
      closed.add(key)
      if (++expansions > MAX_EXPANSIONS) return null
      const col = key % cols
      const row = Math.floor(key / cols)
      for (const [dc, dr] of NEIGHBOURS) {
        const nc = col + dc
        const nr = row + dr
        if (isBlockedCell(nc, nr)) continue
        // No corner cutting: a diagonal step needs both cells it squeezes between.
        if (dc !== 0 && dr !== 0 && (isBlockedCell(col + dc, row) || isBlockedCell(col, row + dr))) continue
        const nk = keyOf(nc, nr)
        if (closed.has(nk)) continue
        const ng = g + (dc !== 0 && dr !== 0 ? Math.SQRT2 : 1)
        if (ng < (best.get(nk) ?? Infinity)) {
          best.set(nk, ng)
          parent.set(nk, key)
          push(heap, { f: ng + heuristic(nc, nr), g: ng, key: nk })
        }
      }
    }
    return null
  }

  function build(from: Point, to: Point): Point[] | null {
    if (!usable || !finite(from) || !finite(to)) return null
    const start = hop(from)
    const goal = hop(to)
    if (!start || !goal) return null
    const cells = search(keyOf(start.col, start.row), keyOf(goal.col, goal.row))
    if (!cells) return null
    const points: Point[] = [from, ...cells.map((k) => centre(k % cols, Math.floor(k / cols))), to]
    // Drop cell centres that sit on a straight run, then pull the line tight wherever it can see ahead.
    const corners: Point[] = [points[0]]
    for (let i = 1; i < points.length - 1; i++) {
      const a = corners[corners.length - 1]
      const b = points[i]
      const c = points[i + 1]
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)
      if (Math.abs(cross) > 1e-9 || i === 1) corners.push(b)
    }
    corners.push(points[points.length - 1])
    const route: Point[] = [corners[0]]
    let i = 0
    while (i < corners.length - 1) {
      let next = i + 1
      for (let j = corners.length - 1; j > i + 1; j--) {
        if (lineClear(corners[i], corners[j])) {
          next = j
          break
        }
      }
      route.push(corners[next])
      i = next
    }
    return route
  }

  let regions: Int32Array | null = null
  function label(): Int32Array {
    const ids = new Int32Array(cols * rows)
    let next = 0
    for (let start = 0; start < ids.length; start++) {
      if (ids[start] !== 0 || isBlockedCell(start % cols, Math.floor(start / cols))) continue
      next++
      ids[start] = next
      const stack = [start]
      while (stack.length > 0) {
        const key = stack.pop()!
        const col = key % cols
        const row = Math.floor(key / cols)
        for (const [dc, dr] of NEIGHBOURS) {
          const nc = col + dc
          const nr = row + dr
          if (isBlockedCell(nc, nr) || ids[keyOf(nc, nr)] !== 0) continue
          if (dc !== 0 && dr !== 0 && (isBlockedCell(col + dc, row) || isBlockedCell(col, row + dr))) continue
          ids[keyOf(nc, nr)] = next
          stack.push(keyOf(nc, nr))
        }
      }
    }
    return ids
  }

  const cache = new Map<string, Point[] | null>()
  return {
    obstacles,
    route(from, to) {
      const key = `${from.x},${from.z}>${to.x},${to.z}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const route = build(from, to)
      if (cache.size >= MAX_CACHE) cache.clear()
      cache.set(key, route)
      return route
    },
    regionOf(point) {
      if (!usable || !finite(point)) return null
      const cell = hop(point)
      if (!cell) return null
      if (cols * rows > MAX_LABELLED_CELLS) return 1
      regions ??= label()
      return regions[keyOf(cell.col, cell.row)]
    },
    isFree(point) {
      return usable && finite(point) && !blockedAt(point.x, point.z)
    },
    nearestFree(point) {
      if (!usable || !finite(point)) return null
      if (!blockedAt(point.x, point.z)) return { x: point.x, z: point.z }
      const col0 = colOf(point.x)
      const row0 = rowOf(point.z)
      let best: Point | null = null
      let bestD = Infinity
      for (let dr = -HOP_RADIUS * 2; dr <= HOP_RADIUS * 2; dr++) {
        for (let dc = -HOP_RADIUS * 2; dc <= HOP_RADIUS * 2; dc++) {
          if (isBlockedCell(col0 + dc, row0 + dr)) continue
          const c = centre(col0 + dc, row0 + dr)
          const d = Math.hypot(c.x - point.x, c.z - point.z)
          if (d < bestD) {
            bestD = d
            best = c
          }
        }
      }
      return best
    },
  }
}
