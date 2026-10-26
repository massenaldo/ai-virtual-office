# Room Rotation and Tower Floor Slab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A selected room can be turned in 90° steps, with its shell and furniture following. The office stands on a warm-concrete tower floor slab with a visible edge.

**Architecture:**
- `Room` gains `rotation: Rotation`. `width` and `depth` stay the world-space footprint, so all footprint code (rects, overlap, `roomAt`, resize, snapping, labels, floor-plan tiles, outlines) is unchanged.
- A pure `rotateRoom` operation swaps the footprint, steps the rotation, clamps the room, and carries the room's furniture around the centre.
- `RoomMesh` builds the shell with the local (unrotated) size inside an inner group turned by `rotation`. Outlines stay world-aligned.
- The office floor becomes a box slab with a warm-concrete top and a darker edge.

**Tech Stack:** React 19, three 0.174, @react-three/fiber 9, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-room-rotation-and-floor-slab-design.md`

## Global Constraints

- Rotation is quarter turns only, using `nextRotation` / `rotateOffset` from `src/layout/geometry.ts` (the furniture convention).
- **Schema stays v1.** A saved room without `rotation` loads as 0. Any value outside 0/90/180/270 rejects the layout, like furniture. Old saves must not show "Unsaved changes" on load.
- Room size limits become **12 × 12 m** (`ROOM_LIMITS.maxDepth: 12`). Rooms are still capped by the office size.
- A turn never resizes a room. It may slide the room back inside the office. Overlap after a turn is a warning, not a block. One turn is one undo step.
- Furniture keeps its `roomId` on a turn. Four turns restore room and furniture exactly when no clamping happened.
- Walls, glass, frames and details never catch pointer events. Render on demand stays (`frameloop="demand"`).
- The slab is fixed warm concrete (spec option B), in 3D only. Floor plan keeps its plain sheet.
- One PR from `feat/room-rotation-floor-slab` with before/after screenshots. Conventional commits.

## Review Focus

1. **Old saved layouts:** loading a v1 save with no room `rotation` gives rotation 0 everywhere, an unchanged picture, and status "Saved" (not "Unsaved changes"). Pinned in Task 1.
2. **Rotating near the office edge:** the room slides inside and its furniture moves with it, keeping the same arrangement relative to the room. Pinned in Task 2.
3. **Selection and handles on a rotated room:** the outline, resize handles and overlap warnings match the swapped footprint in both views, and furniture inside stays clickable. Pinned by the Task 3 `localSize` tests plus a browser check.
4. **Undo/redo of a turn:** one undo restores room and furniture together; redo re-applies. Pinned in Task 2 (operation purity) plus a browser check.
5. **Glass-sided rooms turned 90°/270°:** frames, glass and details stay inside the footprint. Pinned in Task 3.

---

### Task 1: Room rotation in the layout model, storage and limits

**Files:**
- Modify: `src/layout/types.ts` (`Room` gets `rotation: Rotation`), `src/layout/catalog.ts` (`maxDepth: 12`), `src/layout/storage.ts`, `src/layout/defaultLayout.ts`, `src/layout/operations.ts` (`addRoom`: `rotation: 0`), `README.md` ("2–12 m wide and 2–12 m deep")
- Test: `src/layout/storage.test.ts`, `src/layout/geometry.test.ts`, plus any test building `Room` literals (add `rotation: 0`; `npx tsc -b` lists them)

**Interfaces:**
- Produces: `Room = { …; rotation: Rotation }`. `serializeLayout` writes `rotation` after `color`. `parseRoom` accepts a missing `rotation` as 0 and rejects other non-quarter values. `loadLayout` returns `savedJson = serializeLayout(layout)` (normalized) instead of the raw stored text, so `isDirty` is false right after loading any valid save.

- [ ] **Step 1: Before screenshots.** On `main`'s code (before any change), run `npm run dev` and open `http://127.0.0.1:5173/` (empty storage, so the default layout shows). Save the 3D overview, the floor plan, and a close-up of the meeting room to `docs/screenshots/room-rotation/before-overview.jpg`, `before-floor-plan.jpg` and `before-meeting-room.jpg`.
- [ ] **Step 2: Write failing tests** in `storage.test.ts`:
  - `round-trips room rotation`: serialize then parse a layout whose first room has `rotation: 90` → the parsed room has `rotation: 90`
  - `treats a missing room rotation as 0`: a stored v1 JSON with `rotation` deleted from every room → loads, and every room has `rotation: 0`
  - `rejects a room rotation that is not a quarter turn`: `rotation: 45` → `parseLayout` returns `null`
  - `an old save without room rotation loads clean`: `loadLayout` on that JSON → `isDirty(createEditorState(result.layout, result.savedJson))` is `false`

  And in `geometry.test.ts`: `clampRoom allows rooms up to 12 m deep`: depth 12 stays 12, depth 13 becomes 12 (office 25 × 20).
- [ ] **Step 3:** `npm test -- storage geometry` → FAIL
- [ ] **Step 4:** Implement as described in Interfaces. Add `rotation: 0` to `createDefaultLayout` rooms and `addRoom`. Fix the `Room` literals in tests.
- [ ] **Step 5:** `npm test` → all pass. `npm run build` → passes.
- [ ] **Step 6: Commit** `feat(layout): add room rotation to the saved layout` (include the before screenshots)

### Task 2: Rotate room operation and button

**Files:**
- Modify: `src/layout/operations.ts`, `src/editor/useEditorActions.ts`, `src/editor/PropertiesPanel.tsx`, `src/App.tsx` (wire the prop)
- Test: `src/layout/operations.test.ts`

**Interfaces:**
- Consumes: `Room.rotation` (Task 1), `nextRotation`, `rotateOffset`, `clampRoom`, `clampFurniture`
- Produces:
  ```ts
  export function rotateRoom(l: OfficeLayout, id: string): OfficeLayout // unknown id → same layout object
  ```
  Algorithm (from the spec):
  1. `next = clampRoom({ ...prev, width: prev.depth, depth: prev.width, rotation: nextRotation(prev.rotation) }, l.office, prev)`
  2. for each `f` with `f.roomId === id`: `o = rotateOffset(f.x - prev.x, f.z - prev.z, 90)`, then `clampFurniture({ ...f, x: next.x + o.dx, z: next.z + o.dz, rotation: nextRotation(f.rotation) }, l.office, f)`
- Editor action: `rotateRoom: (id: string) => dispatch({ type: 'edit', update: (l) => rotateRoom(l, id) })`
- `PropertiesPanel` prop: `onRotateRoom(id: string): void`. The room's `panel-actions` gets `<button className="panel-button" onClick={() => p.onRotateRoom(room.id)}><RotateCw size={13}/> Rotate 90°</button>` before **Delete room**.

- [ ] **Step 1: Write failing tests** in `operations.test.ts` (use `createDefaultLayout()`):
  - `rotateRoom swaps the footprint and steps the rotation`: CEO office 4.5 × 3.6 at rotation 0 → 3.6 × 4.5, rotation 90, same centre
  - `rotateRoom carries the room's furniture around its centre`: each CEO-office item ends at `centre + rotateOffset(oldOffset, 90)` (toBeCloseTo, 2 digits), with `nextRotation(old)` and the same `roomId`
  - `rotateRoom leaves other rooms and open-floor furniture untouched`: deep-equal for everything not in the room
  - `four turns restore the room and its furniture`: four `rotateRoom` calls on the CEO office → deep-equal to the start
  - `rotateRoom slides a room back inside the office`: a 6 × 2 room at z = −9 (office depth 20) → after the turn it is 2 × 6 with `z === -7`, and its furniture keeps its offset from the new centre
  - `rotateRoom with an unknown id returns the same layout`: `toBe(l)`
- [ ] **Step 2:** `npm test -- operations` → FAIL
- [ ] **Step 3:** Implement `rotateRoom`, the action, the button and the `App.tsx` wiring
- [ ] **Step 4:** `npm test` and `npm run build` → pass
- [ ] **Step 5: Commit** `feat(editor): rotate a selected room in 90° steps`

### Task 3: Render the rotated room shell

**Files:**
- Modify: `src/scene/architecture.ts`, `src/scene/RoomMesh.tsx`
- Test: `src/scene/architecture.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function localSize(room: Pick<Room, 'width' | 'depth' | 'rotation'>): { width: number; depth: number } // 90/270 swap back
  ```
- `RoomMesh`:
  - The outer `<group position>` keeps the world-aligned `FootprintOutline`, using `room.width` / `room.depth`.
  - A new inner `<group rotation={[0, rotation * π / 180, 0]}>` holds the floor mesh (with its pointer and drag handlers), the accent strip, and `mergedRoomParts`. All of them are built from `localSize(room)`, not `room.width` / `room.depth`.
  - The memo deps include `room.rotation`. The floor-plan floor tile stays world-aligned, in the outer group.

- [ ] **Step 1: Write failing tests** in `architecture.test.ts`:
  - `localSize swaps width and depth for quarter turns`: 4 × 2 at 0 and 180 → 4 × 2; at 90 and 270 → 2 × 4
  - `walls of a rotated glass room stay inside its footprint`: for a meeting room 4.6 × 3.6 at each rotation, build `roomWalls(localSize(room), partitionStyle('meeting'))` and turn every box's centre by the room rotation (`rotateOffset`, swapping w/d for 90/270). Every resulting box lies within ±width/2, ±depth/2 of the world footprint (epsilon 1e-6).
- [ ] **Step 2:** `npm test -- architecture` → FAIL
- [ ] **Step 3:** Implement `localSize` and the `RoomMesh` change
- [ ] **Step 4:** `npm test` and `npm run build` → pass
- [ ] **Step 5: Browser check** (`127.0.0.1:5173`, edit mode): rotate the meeting room 4 times. The shell, the glass side, the whiteboard, the open front and all 7 items turn together. After each turn the outline and resize handles match the walls in floor plan. Furniture inside stays clickable through glass. Undo restores the turn in one step; redo re-applies. Save, reload, and the rotation is kept. A save made before this branch loads with status "Saved".
- [ ] **Step 6: Commit** `feat(scene): turn the room shell with its rotation`

### Task 4: Tower floor slab

**Files:**
- Modify: `src/scene/materials.ts` (`slabTop`, `slabEdge` in `sharedMaterials`), `src/scene/OfficeScene.tsx` (`Floor`)
- Test: `src/scene/materials.test.ts`

**Interfaces:**
- `SLAB_THICKNESS = 0.3`, exported from `OfficeScene.tsx` or `materials.ts`.
- In 3D, `Floor` renders `BoxGeometry(office.width, SLAB_THICKNESS, office.depth)` at `y = −SLAB_THICKNESS / 2`. Its UVs are scaled with `scaleFloorUvs(…, 'concrete')`. Materials, in box face order +X, −X, +Y, −Y, +Z, −Z: `[slabEdge, slabEdge, slabTop, slabEdge, slabEdge, slabEdge]`. It receives shadows. The floor plan keeps the existing plane with `planFloorMaterial`.
- Starting colours from the spec: top `#b9b3aa` with the concrete texture, edge `#8f8a83`. Tune them in the browser so the slab reads clearly darker than the `#e6e3de` background without clashing with the room floors.

- [ ] **Step 1: Write failing tests** in `materials.test.ts`:
  - `the slab top is clearly darker than the 3D background`: HSL lightness of `slabTop.color` < lightness of `#e6e3de` − 0.08
  - `the slab edge is darker than its top`: `slabEdge` lightness < `slabTop` lightness
- [ ] **Step 2:** `npm test -- materials` → FAIL
- [ ] **Step 3:** Implement the materials and `Floor`
- [ ] **Step 4:** `npm test` and `npm run build` → pass
- [ ] **Step 5: Browser check:** the overview shows a distinct concrete storey with a visible edge. Room floors, the accent strips and selection outlines stay readable on it. The floor plan is unchanged. `?stats` still reads idle when nothing moves.
- [ ] **Step 6: Commit** `feat(scene): stand the office on a tower floor slab`

### Task 5: Verify, screenshots and PR

**Files:**
- Modify: `README.md` (Features: rotate room; the tower floor slab)
- Create: `docs/screenshots/room-rotation/after-overview.jpg`, `after-floor-plan.jpg`, `after-meeting-room.jpg`, `rotated-meeting-room.jpg`

- [ ] **Step 1:** Run the editor regression checklist from `tasks.md` in 3D and floor plan on `127.0.0.1:5173`, plus rotating a room in both views. Fix any failure in its own `fix(...)` commit.
- [ ] **Step 2:** `npm run build && npm run preview`: smoke test (load, rotate a room, save, reload) with no console errors and no remote requests.
- [ ] **Step 3:** Take the after screenshots at the Task 1 angles, plus the meeting room turned 90°. Clear the test origin's storage afterwards.
- [ ] **Step 4:** Update the README Features list. Commit `docs: room rotation and floor slab screenshots and README`. Open the PR with before/after screenshots and the test plan.
