# Office Visuals — Stage A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the office a realistic architectural base (lighting with no downloads, real floor finishes, thick walls with baseboards, cutaway view without ceilings, and a fitted overview camera) while keeping the editor fully working.

**Architecture:** Pure, tested helpers decide the *what*:
- `finishes.ts`: which floor finish each room gets
- `architecture.ts`: wall and baseboard boxes for a room
- `camera.ts`: overview distance that fits the whole office

Two browser-only modules provide the *look*:
- `materials.ts`: shared material instances
- `textures.ts`: procedural canvas textures

`RoomMesh.tsx` and `OfficeScene.tsx` render from those. The layout schema and the editor are not touched.

**Tech Stack:** React 19, three 0.174, @react-three/fiber 9, @react-three/drei 10, Vitest. No new dependencies.

**Spec:** `plan.md` (Milestone 2 brief) and `tasks.md` (agreed decisions, Q1/Q1b/Q2 answers, Stage A list).

## Global Constraints

- No runtime network requests for assets: remove `Environment preset`; textures are generated in code (plan.md §7, decision 1).
- No new dependencies, no post-processing library (decision 2).
- The layout schema and storage format are unchanged; floor finish is derived from `room.department` (decision 3).
- Cutaway: no ceilings. No doors; each room's front (+Z) side stays open (Q1, Q1b).
- Palette (Q2): polished concrete open floor; warm-grey carpet tiles in team rooms; light oak floors in executive and meeting rooms; dark epoxy in the server room; warm-white walls; graphite baseboards; department colour only as a subtle accent in 3D (floor plan keeps full room colours).
- Editor behaviour is unchanged: the regression checklist in `tasks.md` must pass.
- Walls and glass never catch pointer events (`raycast={noRaycast}`), as today.
- One PR to `main` from `feat/office-visuals-stage-a`, with before/after screenshots from the same cameras.

## Review Focus

1. **Offline use:** the app must make no request to any non-local host at runtime. Pinned by `src/scene/noRemoteAssets.test.ts` (Task 4) and a network check in Task 5.
2. **Minimum-size rooms (2 × 2 m):** walls and baseboards must not invert or overlap. Pinned in Task 2.
3. **Narrow canvas (edit mode, aspect ≈ 1.3) and wide canvas (≈ 2.5):** the whole office must fit the overview. Pinned in Task 3.
4. **Selection outlines on the new darker/textured floors:** must stay clearly visible. Verified with a screenshot in Task 5 (outlines already draw with `depthTest={false}`).
5. **Moving or resizing a room:** walls, baseboards, floor and accent must follow immediately. These derive from room props only; verified in the Task 5 browser checklist.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/scene/finishes.ts` (+ test) | `FloorFinish` type, department → finish mapping |
| `src/scene/architecture.ts` (+ test) | Wall/glass/baseboard boxes for a room, in room-local coordinates |
| `src/scene/camera.ts` (+ test) | Overview direction/target and `fitOverviewDistance` |
| `src/scene/materials.ts` (+ test) | Lazily created shared materials; accent materials cached by colour |
| `src/scene/textures.ts` | Procedural `CanvasTexture`s (concrete, carpet, oak, epoxy); browser only |
| `src/scene/noRemoteAssets.test.ts` | Static guard: no remote URLs or Environment presets in `src/` |
| `src/scene/RoomMesh.tsx` | Renders floor finish, accent strip, walls, glass, baseboards; no ceiling |
| `src/scene/OfficeScene.tsx` | Lighting (Lightformers + sun with fitted shadow camera), concrete office floor, background, fitted overview, floor-plan room boundaries |

---

### Task 1: Floor finishes and shared materials

**Files:**
- Create: `src/scene/finishes.ts`, `src/scene/materials.ts`, `src/scene/textures.ts`
- Test: `src/scene/finishes.test.ts`, `src/scene/materials.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FloorFinish = 'concrete' | 'carpet' | 'oak' | 'epoxy'
  export function floorFinishFor(department: DepartmentId): FloorFinish // executive, meeting → oak; devops → epoxy; all others → carpet
  // materials.ts
  export type SharedMaterials = { concrete; carpet; oak; epoxy; wallPaint; wallCap; baseboard; glass; graphite } // all THREE.MeshStandardMaterial
  export function sharedMaterials(): SharedMaterials // created once, same object on every call
  export function floorMaterial(finish: FloorFinish): THREE.MeshStandardMaterial
  export function accentMaterial(color: string): THREE.MeshStandardMaterial // cached per colour
  // textures.ts
  export function proceduralTexture(kind: FloorFinish): THREE.CanvasTexture | null // null when `document` is undefined
  ```
- Values:
  - concrete `#cfcac3` (roughness 0.6)
  - carpet `#8d8a86` (roughness 0.95)
  - oak `#c49a6c` (roughness 0.55)
  - epoxy `#3b4046` (roughness 0.35)
  - wallPaint `#f1eee8` (0.9)
  - wallCap `#3a3d42` (0.8): the dark cut face on wall tops
  - baseboard `#2f3236` (0.6)
  - glass `#dfe9ec` (transparent, opacity 0.28, roughness 0.1, metalness 0.1, depthWrite false)
  - graphite `#2b2e33` (metalness 0.4, roughness 0.45)
  - Accent: room colour, roughness 0.7
- Textures: 256² canvases with `RepeatWrapping` and `SRGBColorSpace`, applied in `sharedMaterials()` only when `proceduralTexture` returns non-null:
  - concrete: soft mottled noise
  - carpet: fine square tile grid with speckle
  - oak: plank stripes with grain lines
  - epoxy: subtle speckle

- [ ] **Step 1: Write failing tests.** `finishes.test.ts`: `floorFinishFor('executive') === 'oak'`, `'meeting' → 'oak'`, `'devops' → 'epoxy'`, `'backend' → 'carpet'`, `'qa' → 'carpet'`. `materials.test.ts` (node, no DOM): `sharedMaterials() === sharedMaterials()`; `floorMaterial('oak') === sharedMaterials().oak`; `accentMaterial('#7898a7') === accentMaterial('#7898a7')` and `!== accentMaterial('#8daab7')`; `sharedMaterials().glass.transparent === true && .depthWrite === false`; `sharedMaterials().concrete.map === null` (no DOM, so no texture).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules with the values above.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scene): add floor finishes, shared materials and procedural textures`.

### Task 2: Wall and baseboard geometry

**Files:**
- Create: `src/scene/architecture.ts`
- Test: `src/scene/architecture.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const WALL_THICKNESS = 0.12
  export const GLASS_THICKNESS = 0.04
  export const BASEBOARD = { height: 0.08, depth: 0.015 }
  export type Box = { x: number; y: number; z: number; w: number; h: number; d: number } // centre + size, room-local
  export function roomWalls(room: Pick<Room, 'width' | 'depth' | 'wallHeight'>): { solid: Box[]; glass: Box[] }
  export function roomBaseboards(room: Pick<Room, 'width' | 'depth' | 'wallHeight'>): Box[]
  ```
- Layout:
  - Side walls (−X and +X) are solid, full depth, and sit *inside* the footprint. The outer face is on the footprint edge (a change from today's walls, which straddle the edge).
  - The back (−Z) is glass spanning between the side walls' inner faces.
  - The front (+Z) is open.
  - Baseboards run along both side walls' inner faces, from the glass to the open front.

- [ ] **Step 1: Write failing tests** for a 4.5 × 3.6 room (wallHeight 2.5) and a 2 × 2 room:
  - `solid.length === 2`, `glass.length === 1`
  - every box satisfies `|x| + w/2 <= width/2 + 1e-9` and `|z| + d/2 <= depth/2 + 1e-9`
  - solid walls have `h === 2.5` and `y === 1.25`
  - glass `w === width - 2 * WALL_THICKNESS` and `z === -depth/2 + GLASS_THICKNESS/2`
  - glass and solid boxes don't overlap (glass `x ± w/2` lies between the walls' inner faces)
  - `roomBaseboards` returns 2 boxes with `h === 0.08`, each touching its wall's inner face (`|x| + w/2 === width/2 - WALL_THICKNESS + BASEBOARD.depth` within 1e-9)
  - for the 2 × 2 room, all sizes are `> 0`
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scene): add room wall and baseboard geometry`.

### Task 3: Fitted overview camera

**Files:**
- Create: `src/scene/camera.ts`
- Test: `src/scene/camera.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const OVERVIEW_TARGET: [number, number, number] = [0, 0.4, 0]
  export const OVERVIEW_DIRECTION: THREE.Vector3 // normalize(15, 17, 19), the existing view angle
  export const OVERVIEW_FOV = 42
  export function fitOverviewDistance(office: OfficeSettings, aspect: number, fovDeg?: number, margin?: number): number // margin default 0.9
  ```
- Algorithm: binary search the distance in [5, 120] for 30 iterations. Place a `PerspectiveCamera(fov, aspect)` at `target + direction * d` and `lookAt(target)`. Project the 8 corners `(±w/2, {0, 2.5}, ±d/2)`. The distance fits when `max(|ndc.x|, |ndc.y|) <= margin`. Return the smallest distance that fits.

- [ ] **Step 1: Write failing tests:** for the default office at aspects 2.5, 1.4 and 0.8, every corner projects within ±0.9 (+1e-6) at the returned distance; at `0.95 ×` that distance, some corner exceeds 0.9 (the fit is tight); the result is finite.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scene): fit the overview camera to the office`.

### Task 4: Scene integration

**Files:**
- Modify: `src/scene/OfficeScene.tsx`, `src/scene/RoomMesh.tsx`
- Test: `src/scene/noRemoteAssets.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.

- [ ] **Step 1: Write the failing static test** `noRemoteAssets.test.ts`. It reads every `.ts`/`.tsx` file under `src/` with `node:fs` (excluding `*.test.ts`) and asserts none contains `preset=` or `https://` / `http://` (allow `http://localhost` / `127.0.0.1`).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, because `OfficeScene.tsx` contains `preset="apartment"`.
- [ ] **Step 3: Lighting and environment in `OfficeScene.tsx`:**
  - Replace `<Environment preset>` with `<Environment resolution={256}>` containing three `Lightformer`s: a large soft overhead panel (intensity 1.2), a warm side panel from −X (`#ffe7c7`, intensity 0.8), and a cool fill from +Z (`#dfe9ff`, intensity 0.4). Keep it in floor plan too, at lower intensity.
  - Sun: `directionalLight` at `[12, 18, 8]`, intensity 2.0 (3D) / 0.6 (plan), shadow map 2048, shadow camera `left/right/top/bottom = ±16`, `near 1`, `far 60`, `bias -0.0004`, `normalBias 0.02`.
  - Remove the point light. Ambient: 0.35 (3D) / 1.4 (plan).
  - Canvas `shadows="soft"` and `gl={{ antialias: true, toneMappingExposure: 0.95 }}`.
  - Background `#e6e3de` (3D) / `#eceae6` (plan).
- [ ] **Step 4: Office floor:** concrete material (`floorMaterial('concrete')`, texture repeat 6 × 5) in 3D. Keep the plain light floor in floor plan.
- [ ] **Step 5: Overview:** `ViewCameras` places the perspective camera at `OVERVIEW_TARGET + OVERVIEW_DIRECTION * fitOverviewDistance(office, size.width / size.height)` when the view is entered or Reset view is pressed. OrbitControls `maxDistance = max(32, 1.4 × fitted distance)`.
- [ ] **Step 6: `RoomMesh.tsx`:**
  - Floor slab uses `floorMaterial(floorFinishFor(room.department))` (opaque, height 0.02, top at y 0.025) in 3D. It keeps `room.color` at opacity 0.95 in floor plan.
  - Add a 0.06 m accent strip on the floor along the open front edge using `accentMaterial(room.color)`.
  - Walls come from `roomWalls`: `wallPaint` on the sides and `wallCap` on top (material array, top face index 2), plus glass and `roomBaseboards` with `baseboard`. Walls and baseboards cast shadows; floors receive them.
  - No ceiling.
  - Every new mesh uses `raycast={noRaycast}` except the floor slab, which keeps the select/drag handlers.
- [ ] **Step 7: Floor-plan boundaries:** in floor plan, draw a `FootprintOutline` (`#56616b`, lineWidth 1.2) for every room that has no highlight.
- [ ] **Step 8: Run** `npm test && npm run build`. Expected: PASS, with no remote URLs left.
- [ ] **Step 9: Commit** `feat(scene): realistic lighting, floors and cutaway walls`.

### Task 5: Verify, screenshot and open the PR

- [ ] **Step 1: Baseline screenshots — do this before Task 1**, while the code still matches `main`: 3D overview (full width), 3D overview in edit mode, floor plan, and one room close-up from the same camera positions used in Step 2.
- [ ] **Step 2: Same screenshots on the branch,** plus a close-up of one room. Expected: whole office visible in both 3D widths; no ceilings; walls with dark tops; concrete, carpet, oak and epoxy floors visible; soft shadows across the whole office.
- [ ] **Step 3: Network check:** read the page's network requests after load. Expected: only `127.0.0.1` / `localhost`.
- [ ] **Step 4: Editor regression checklist** from `tasks.md`, plus a selected room and a selected desk outline screenshot on the new floors. Expected: all pass, outlines clearly visible.
- [ ] **Step 5: Frame-rate sanity check:** drag a room for ~2 s in 3D. Expected: smooth, with no console errors.
- [ ] **Step 6:** Tick Stage A in `tasks.md`, then open the PR `feat(scene): Milestone 2 Stage A — architecture, lighting and floors` into `main` with the screenshots.
