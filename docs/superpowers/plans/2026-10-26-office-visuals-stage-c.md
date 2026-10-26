# Office Visuals — Stage C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Framed glass partitions, leafy plants in two sizes, a few restrained details (wall art, a meeting-room whiteboard), and a default office that uses the new furniture with the meeting table fully inside its room.

**Architecture:** Everything stays derived from existing data:
- **Partition style** comes from `room.department` (`partitionStyle`).
- **Plant size** comes from a hash of the item id (`plantVariant`).
- **Details** come from the room's shape and department (`roomDetails`).

Pure, tested functions in `finishes.ts`, `architecture.ts` and `furnitureModels.ts` produce the boxes and parts; `RoomMesh` and `FurnitureItem` render them. The schema stays v1.

**Tech Stack:** React 19, three 0.174, @react-three/fiber 9, Vitest. No new dependencies.

**Spec:** `plan.md` §3–§7 and `tasks.md` (Stage C list, Q1b: no doors, decisions 3/5/6).

## Global Constraints

- No doors (Q1b). Each room's front (+Z) stays open. No ceilings.
- **Walls, glass, frames and details never catch pointer events** (`noRaycast`), and details never sit where furniture is placed (they hang on wall faces at y ≥ 0.9).
- **No schema change:** partition style, plant variant and details are derived. No remote assets, no new dependencies.
- **Changing the default office only affects Reset layout or a fresh profile;** saved layouts are untouched (decision 6).
- **Shared geometry and materials:** frames, art and whiteboards reuse the unit box and shared materials.
- One PR to `main` from `feat/office-visuals-stage-c` with before/after screenshots.

## Review Focus

1. **Small rooms (2 × 2 m) with glass sides:** mullion spacing must not produce zero or negative widths. Pinned in Task 1.
2. **Details on narrow walls:** art and whiteboard shrink to fit the wall depth (or are skipped below 1.2 m) and never stick out of the room. Pinned in Task 2.
3. **Plant variant stability:** the same id always gets the same size, so it doesn't flicker across renders or reloads. Pinned in Task 3.
4. **Default office:** zero overlap issues, every furniture `roomId` matches `roomAt`, and the meeting table plus all meeting chairs lie fully inside the meeting room. Pinned in Task 5.
5. **Selection through glass:** furniture behind framed glass stays clickable. Verified in Task 6.

---

### Task 1: Partition styles and glass frames

**Files:**
- Modify: `src/scene/finishes.ts`, `src/scene/architecture.ts`
- Test: `src/scene/finishes.test.ts`, `src/scene/architecture.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Side = 'solid' | 'glass'
  export type PartitionStyle = { left: Side; right: Side }       // back is always glass, front always open
  export function partitionStyle(department: DepartmentId): PartitionStyle // executive, meeting → { left: 'solid', right: 'glass' }; others → both solid
  // architecture.ts
  export const FRAME = { width: 0.05, depth: 0.06, maxSpan: 1.5 }
  export function roomWalls(room: RoomShape, style?: PartitionStyle): { solid: Box[]; glass: Box[]; frames: Box[] } // style default: both solid
  export function roomBaseboards(room: RoomShape, style?: PartitionStyle): Box[] // only along solid sides
  ```
- Glass sides are `GLASS_THICKNESS` thick, on the footprint edge, full depth. The back glass spans between the side walls' inner faces (solid = `WALL_THICKNESS`, glass = `GLASS_THICKNESS`).
- **Frames:** each glass pane gets a top rail and a bottom rail (height `FRAME.width`, the pane's full length, depth `FRAME.depth`), plus vertical mullions at both ends and evenly spaced so that no gap exceeds `FRAME.maxSpan`.
- Every frame box stays inside the footprint.

- [ ] **Step 1: Failing tests:**
  - `partitionStyle('meeting')` → `{ left: 'solid', right: 'glass' }`; `partitionStyle('backend')` → both solid
  - `roomWalls(4.6 × 3.6, meeting style)`: `solid.length === 1`, `glass.length === 2`
  - frames: every box is inside the footprint, every width/height/depth is > 0, and there are ≥ 4 mullions on the 4.6 m back pane
  - the gap between neighbouring mullions is ≤ 1.5 m
  - a 2 × 2 glass room still produces positive sizes
  - `roomBaseboards` with meeting style returns 1 board (the solid side only)
  - default style keeps the Stage A results (2 solid, 1 glass)
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scene): framed glass partitions for executive and meeting rooms`.

### Task 2: Restrained room details

**Files:**
- Modify: `src/scene/architecture.ts`
- Test: `src/scene/architecture.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DetailKind = 'art-frame' | 'art-canvas' | 'whiteboard' | 'whiteboard-frame' | 'whiteboard-tray'
  export function roomDetails(room: RoomShape & Pick<Room, 'department'>, style: PartitionStyle): { kind: DetailKind; box: Box }[]
  ```
- **Where they go:** on the inner face of the **left solid wall** only.
  - executive → framed art: canvas 0.9 × 0.6, frame 2 cm proud, centred at y 1.5
  - meeting → whiteboard: 1.6 × 0.9 board, graphite frame, a tray below, centred at y 1.35
  - everything else → none
- **Narrow walls:** width shrinks to `min(nominal, depth − 0.6)`; the detail is skipped when that is < 0.6.
- **Thickness:** all boxes are ≤ 4 cm thick and sit inside the room footprint.

- [ ] **Step 1: Failing tests:**
  - executive 4.5 × 3.6 gives 2 boxes (frame and canvas) at `x ≈ −width/2 + WALL_THICKNESS + depth/2`
  - meeting gives 3 boxes
  - backend gives none
  - executive with a right-only solid style gives none
  - a meeting room with depth 1.0 gives none
  - every box sits inside the footprint, with `minY ≥ 0.9`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scene): add wall art and meeting-room whiteboard`.

### Task 3: Leafy plants in two sizes

**Files:**
- Modify: `src/scene/furnitureModels.ts`, `src/scene/materials.ts`
- Test: `src/scene/furnitureModels.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PlantVariant = 0 | 1 // 0 = bushy (~1.0 m), 1 = tall (~1.45 m)
  export function plantVariant(id: string): PlantVariant // stable string hash, mod 2
  export function modelParts(type: FurnitureType, variant?: number): ModelPart[] // variant only matters for plants; cached per (type, variant)
  ```
- **Plant model:**
  - a matte charcoal planter (new material `planter` `#3a3c3f`, roughness 0.85): a tapered cylinder, radius 0.2 → 0.16, 0.42 tall (0.36 for bushy), with a soil disc (`terracotta` is reused for the soil)
  - foliage (`foliage`, plus a second shade `foliageLight` `#7a9a6c`): 14–18 leaves, each a flattened, elongated sphere tilted outward and rotated around the stem at golden-angle steps, from a deterministic seed per variant
  - everything stays within the 0.56 footprint
  - at most 4 parts
- **Variant is purely visual:** the same id always gives the same variant.

- [ ] **Step 1: Failing tests:**
  - `plantVariant('plant-01') === plantVariant('plant-01')`; across `plant-01…plant-11` both variants occur
  - for each variant: ≤ 4 parts, bounding box inside the footprint (+0.01), the variant-0 maximum height is within [0.9, 1.15] and variant-1 within [1.35, 1.6]
  - `modelParts('plant', 0) !== modelParts('plant', 1)`; `modelParts('desk', 1) === modelParts('desk')`
  - the existing per-type footprint and height tests still pass
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scene): leafy plants in two sizes`.

### Task 4: Render partitions, frames, details and plant variants

**Files:**
- Modify: `src/scene/RoomMesh.tsx`, `src/scene/FurnitureItem.tsx`, `src/scene/materials.ts`

**Interfaces:**
- `RoomMesh`:
  - `const style = partitionStyle(room.department)`; pass it to `roomWalls`, `roomBaseboards` and `roomDetails`
  - frames use `graphite`
  - details: `art-frame` / `whiteboard-frame` / `whiteboard-tray` use `graphite`, `art-canvas` uses `accentMaterial(room.color)`, `whiteboard` uses the new `whiteboard` material (`#f6f6f3`, roughness 0.25)
  - every part keeps `raycast={noRaycast}`
- `FurnitureItem`: `modelParts(item.type, item.type === 'plant' ? plantVariant(item.id) : 0)`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 3: Browser check:** the CEO office and meeting room show framed glass on their right and back; the art and whiteboard are visible; plants come in two heights; no console errors.
- [ ] **Step 4: Commit** `feat(scene): render glass frames, room details and plant variants`.

### Task 5: Default office with the new furniture

**Files:**
- Modify: `src/layout/defaultLayout.ts`
- Test: `src/layout/defaultLayout.test.ts`

**Interfaces:**
- **Meeting table:** `meeting-table-01` moves to the centre of `room-meeting`, (−3.9, 2.2), with `roomId: 'room-meeting'`.
- **Meeting chairs:** six, `meeting-chair-01…06`, at x ∈ {−4.8, −3.9, −3.0}:
  - three at z 1.42, rotation 180
  - three at z 2.98, rotation 0
  - all `roomId: 'room-meeting'`
- **Storage:**
  - `storage-cabinet-01` at (−9.0, −5.4), rotation 90, in `room-ceo-office`
  - `shelf-01` at (−4.0, −5.3), rotation 90, in `room-project-management`
- Rooms, desks and plants are unchanged.

- [ ] **Step 1: Failing tests:**
  - counts: 14 desks, 14 chairs, 14 monitors, 11 plants, 1 meeting table, 6 meeting chairs, 1 storage cabinet, 1 shelf
  - the meeting table and all 6 meeting chairs lie fully inside `room-meeting` (`furnitureRect` within `roomRect`)
  - the existing `findIssues(default).size === 0` and `roomId === roomAt` tests stay green
- [ ] **Step 2: Run** `npm test`. Expected: FAIL on counts and containment.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(layout): furnish the default meeting room and add storage`.

### Task 6: Verify, screenshot and open the PR

- [ ] **Step 1: Baseline screenshots before Task 4** (overview, close-up, floor plan).
- [ ] **Step 2: After screenshots:** the same views, plus close-ups of the meeting room (framed glass, whiteboard, table and chairs) and the CEO office (art, cabinet), taken with a temporary camera hook that is removed before committing.
- [ ] **Step 3: Editor regression checklist,** plus selecting a meeting chair behind the glass and Reset layout bringing in the new default.
- [ ] **Step 4:** Tick Stage C in `tasks.md`, then open PR `feat(scene): milestone 2 stage C — glass, plants and details` into `main`.
