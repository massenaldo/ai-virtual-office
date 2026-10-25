# Office Layout Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the static 3D office prototype into a local-first layout editor whose rooms and furniture are typed data that can be edited, undone, saved to localStorage and restored.

**Architecture:** A pure `src/layout/` module owns the serializable `OfficeLayout` model, its geometry rules, its edit operations, its persistence and an undo/redo reducer. The pure logic is unit-tested with Vitest. `src/scene/` becomes a rendering of that data: the existing primitive meshes are extracted unchanged into model components, and it reports pointer intents (select, move, resize) upward. `src/editor/` holds the React UI (toolbar, outliner, properties, dialogs, shortcuts) and a `useLayoutEditor` hook that wires the reducer to storage. State uses `useReducer`, so no new state-management dependency is added.

**Tech Stack:** React 19, TypeScript 5.7 (strict), Vite 6, three 0.174, @react-three/fiber 9, @react-three/drei 10, lucide-react. Adds dev-only `vitest`.

**Spec:** `tasks.md`

## Phase 1 findings (current code)

- All layout data lives in `src/scene/OfficeScene.tsx`. `rooms: Room[]` (lines 6-18) holds `{name,x,z,w,d,color}`, where x/z are the **centre** of the footprint and walls are 2.5 tall. Furniture positions are inline literals in `OfficeContents` (lines 69-75): 8 back-row and 6 front-row desks, 11 plants and 1 meeting table.
- `Desk` (lines 27-36) bakes the monitor and chair into the desk group. In local coordinates the monitor is at z −0.18 and the chair seat at z +0.56 / back at z +0.73. `rotation={Math.PI}` is used for the front row.
- In floor-plan mode only the colours change and walls/furniture are hidden. The camera stays a perspective orbit, so it is not top-down. "Reset view" only sets `floorPlan=false`.
- Save (`App.tsx` `saveLayout`) writes only `{version, view, savedAt}` to `ai-virtual-office-layout`. No geometry is persisted.
- `App.tsx` `departments` (counts and colours) and the info cards ("10 planned spaces", "19 planned desks") are hard-coded and disagree with the scene, which has 14 desks.
- Some existing furniture sits outside every room: the meeting table at x −1.2 overflows MEETING ROOM (x −6.2…−1.6), and the front-row desks sit in the open floor. This is legitimate open-plan furniture (`roomId: null`), not an error.
- There are no tests or test runner. `npm run build` (`tsc -b && vite build`) passes on `main` with only a chunk-size warning.

## Global Constraints

- Keep the existing visual identity, dark dashboard UI and scene look. Do not replace the app with a starter template.
- Preserve `/vo` (`scripts/vo.sh`, `.claude/commands/vo.md`, Vite on `127.0.0.1:5173` `strictPort`).
- No new runtime dependencies. No state-management library. No external 3D asset downloads. Dev dependency `vitest` only.
- Storage key: `ai-virtual-office:layout:v1`. Do not delete or rewrite the legacy key `ai-virtual-office-layout`.
- Stable string IDs for every room and furniture item, never array indices.
- The scene renders layout data and is never the source of truth.
- History limit: 100 entries. One completed drag equals one undo entry.
- Coordinates: world metres. Footprint = centre `x`/`z` plus `width` (along X) and `depth` (along Z) on the floor plane. Vertical values (`wallHeight`, model heights) are separate and never mixed into footprint fields.
- Out of scope: AI agents, backend APIs, authentication, multiplayer, orchestration.
- Conventional commits on branch `feat/layout-editor`. Run `npm run build` and `npm test` before every commit.

## Review Focus

1. **Saved data that is corrupt or from a newer schema.** The app loads the default, shows a non-blocking notice, and must not destroy the raw saved value. The first Save after that copies it to `ai-virtual-office:layout:v1:backup` before overwriting. Owned by Task 4.
2. **Typing in a properties field.** Backspace/Delete and Cmd/Ctrl+Z inside `input`/`textarea`/`select`/contenteditable must edit the text, not delete the selected object or undo the layout. Owned by Task 8.
3. **Bad numeric input** (empty, `NaN`, negative, huge). The value is clamped or rejected and never stored as `NaN`/`Infinity`. Owned by Task 3.
4. **localStorage unavailable or quota exceeded.** The status shows "Save failed", the layout stays dirty, and nothing crashes. Owned by Task 4.
5. **Undo back to the saved state.** The status returns to "Saved", and redo makes it "Unsaved changes" again. Owned by Task 5.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/layout/types.ts` | `OfficeLayout`, `Room`, `Furniture`, `Rotation`, `DepartmentId`, `FurnitureType`, `Selection`, `LAYOUT_SCHEMA_VERSION` |
| `src/layout/catalog.ts` | Department metadata (label, colour), furniture footprints and floor-plan colours, room templates, dimension limits |
| `src/layout/defaultLayout.ts` | `createDefaultLayout()`: today's scene converted to data |
| `src/layout/geometry.ts` | Snapping, clamping, rotation, footprints, rect overlap, `roomAt` |
| `src/layout/validation.ts` | `findIssues()`: overlap and out-of-bounds warnings |
| `src/layout/operations.ts` | Pure edit functions (add/update/move/resize/rotate/duplicate/delete) |
| `src/layout/storage.ts` | Parse, migrate, load, save, serialize |
| `src/layout/history.ts` | `editorReducer`: present/past/future, drag grouping, dirty tracking, selection |
| `src/layout/*.test.ts` | Vitest unit tests for each module above |
| `src/scene/models.tsx` | `DeskModel`, `ChairModel`, `MonitorModel`, `PlantModel`, `MeetingTableModel` (geometry moved verbatim) |
| `src/scene/RoomMesh.tsx` | Data-driven `RoomBlock` plus hover/selected/invalid state |
| `src/scene/FurnitureItem.tsx` | Picks the model (3D) or footprint tile (floor plan), applies rotation, pointer handlers |
| `src/scene/FootprintOutline.tsx` | Floor rectangle outline for hover/selected/invalid feedback |
| `src/scene/ResizeHandles.tsx` | N/S/E/W edge handles on the selected room |
| `src/scene/useFloorDrag.ts` | Pointer → floor-plane drag with threshold, pointer capture and OrbitControls disable |
| `src/scene/OfficeScene.tsx` | Canvas, lights, cameras (perspective / orthographic top-down), grid, renders layout |
| `src/editor/useLayoutEditor.ts` | Reducer + storage + save status + intent handlers for App |
| `src/editor/shortcuts.ts` | `isTypingTarget()`, `matchShortcut()` (pure, tested) and `useEditorShortcuts()` |
| `src/editor/EditorToolbar.tsx` | Edit Layout, 3D View, Floor Plan, Undo, Redo, Snap, Save, Reset, status chip |
| `src/editor/OutlinerPanel.tsx` | Room list with nested furniture, room templates, furniture palette |
| `src/editor/PropertiesPanel.tsx` | Contextual numeric/text properties, actions, issue list |
| `src/editor/ConfirmDialog.tsx` | In-app modal for delete/reset/exit-with-unsaved-changes |
| `src/App.tsx` | Uses `useLayoutEditor`. Sidebar departments and info cards are derived from the layout |
| `src/styles.css` | Appended editor styles |

---

### Task 1: Test tooling, layout types, catalog, default layout

**Files:**
- Modify: `package.json` (add `"test": "vitest run"`, devDependency `vitest@^3.2.0`)
- Create: `src/layout/types.ts`, `src/layout/catalog.ts`, `src/layout/defaultLayout.ts`
- Test: `src/layout/defaultLayout.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LAYOUT_SCHEMA_VERSION = 1
  export type Rotation = 0 | 90 | 180 | 270
  export type DepartmentId = 'executive' | 'project-management' | 'tech-lead' | 'backend' | 'frontend' | 'data' | 'design' | 'qa' | 'meeting' | 'devops'
  export type FurnitureType = 'desk' | 'chair' | 'monitor' | 'plant' | 'meeting-table'
  export type Room = { id: string; name: string; department: DepartmentId; x: number; z: number; width: number; depth: number; wallHeight: number; color: string }
  export type Furniture = { id: string; type: FurnitureType; x: number; z: number; rotation: Rotation; roomId: string | null }
  export type OfficeSettings = { width: number; depth: number; gridSize: number }
  export type OfficeLayout = { schemaVersion: typeof LAYOUT_SCHEMA_VERSION; office: OfficeSettings; rooms: Room[]; furniture: Furniture[] }
  export type Selection = { kind: 'room' | 'furniture'; id: string } | null
  // catalog.ts
  export const DEPARTMENTS: Record<DepartmentId, { label: string; color: string }>
  export const FURNITURE_SPECS: Record<FurnitureType, { label: string; width: number; depth: number; planColor: string }>
  export type RoomTemplateId = 'office' | 'team-room' | 'meeting-room'
  export const ROOM_TEMPLATES: { id: RoomTemplateId; label: string; width: number; depth: number; department: DepartmentId }[]
  export const ROOM_LIMITS = { minWidth: 2, maxWidth: 12, minDepth: 2, maxDepth: 10 }
  export const DEFAULT_WALL_HEIGHT = 2.5
  // defaultLayout.ts
  export function createDefaultLayout(): OfficeLayout
  ```
- Values: office `{ width: 25, depth: 20, gridSize: 0.25 }` (matches the existing 25×20 floor plane). Footprints: desk 1.35×0.72, chair 0.48×0.48, monitor 0.48×0.1, plant 0.56×0.56, meeting-table 2.7×1.15. Templates: office 4.5×3.6 (`executive`), team-room 4.3×2.4 (`backend`), meeting-room 4.6×3.6 (`meeting`). Department colours are the room colours in `OfficeScene.tsx:8-17`.
- Default layout: the 10 rooms with IDs `room-ceo-office`, `room-project-management`, `room-tech-lead`, `room-backend`, `room-frontend`, `room-data`, `room-design`, `room-qa`, `room-meeting`, `room-devops`, and their existing names, positions, sizes and colours. Each of the 14 existing desks becomes `desk-NN` plus `chair-NN` (offset local z +0.56) plus `monitor-NN` (offset local z −0.18), with offsets rotated by the desk rotation (front row = 180). Also `plant-NN` ×11 and `meeting-table-01`. Hard-code each item's `roomId` (the room whose footprint contains its centre, `null` for open floor). Task 2's test `roomAt` cross-checks these. Compute chair/monitor positions with an inline 0°/180° offset (Task 2 adds the general `rotateOffset`).

- [ ] **Step 1: Install vitest and add the `test` script.** Run `npm i -D vitest@^3.2.0`. Expected: `package.json` lists it under devDependencies.
- [ ] **Step 2: Write the failing test** `src/layout/defaultLayout.test.ts`:
  ```ts
  const l = createDefaultLayout()
  expect(l.schemaVersion).toBe(1)
  expect(l.rooms).toHaveLength(10)
  const count = (t: FurnitureType) => l.furniture.filter((f) => f.type === t).length
  expect([count('desk'), count('chair'), count('monitor'), count('plant'), count('meeting-table')]).toEqual([14, 14, 14, 11, 1])
  const ids = [...l.rooms, ...l.furniture].map((o) => o.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(l.rooms.find((r) => r.id === 'room-ceo-office')).toMatchObject({ x: -7.1, z: -4.3, width: 4.5, depth: 3.6, wallHeight: 2.5 })
  expect(l.furniture.find((f) => f.id === 'desk-01')?.roomId).toBe('room-ceo-office')
  expect(createDefaultLayout()).not.toBe(l) // fresh object each call
  ```
- [ ] **Step 3: Run** `npm test`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement** `types.ts`, `catalog.ts` and `defaultLayout.ts` with the values above.
- [ ] **Step 5: Run** `npm test && npm run build`. Expected: PASS, build OK.
- [ ] **Step 6: Commit** `feat(layout): add typed office layout model and default layout` (stage `docs/` too).

### Task 2: Geometry and validation

**Files:**
- Create: `src/layout/geometry.ts`, `src/layout/validation.ts`
- Test: `src/layout/geometry.test.ts`, `src/layout/validation.test.ts`

**Interfaces:**
- Consumes: Task 1 types and catalog.
- Produces:
  ```ts
  export type Rect = { minX: number; maxX: number; minZ: number; maxZ: number }
  export function snap(value: number, grid: number): number
  export function rotateOffset(dx: number, dz: number, rotation: Rotation): { dx: number; dz: number }
  export function nextRotation(r: Rotation): Rotation // +90, wraps 270→0
  export function roomRect(room: Room): Rect
  export function furnitureRect(item: Furniture): Rect // 90/270 swap width/depth
  export function rectsOverlap(a: Rect, b: Rect, epsilon?: number): boolean // default 0.01; touching edges do not overlap
  export function roomAt(layout: OfficeLayout, x: number, z: number): string | null // smallest containing room
  export function clampRoom(next: Room, office: OfficeSettings, previous?: Room): Room // finite, dims in ROOM_LIMITS, footprint inside office, rounded to 0.01
  export function clampFurniture(next: Furniture, office: OfficeSettings, previous?: Furniture): Furniture
  // validation.ts
  export type Issue = { code: 'room-overlap' | 'furniture-overlap' | 'out-of-bounds'; otherId?: string; message: string }
  export function findIssues(layout: OfficeLayout): Map<string, Issue[]>
  ```
- Rules: monitors never conflict. A chair overlapping a desk is allowed. Every other pair of furniture overlapping is `furniture-overlap` on both items. Overlapping rooms are `room-overlap`. Anything not fully inside the office is `out-of-bounds`. These are warnings: edits are still allowed and Save still works.

- [ ] **Step 1: Write failing tests:** `snap(1.13, 0.25) === 1.25`; `rotateOffset(0, 0.56, 180)` → `{dx: 0, dz: -0.56}` (use `toBeCloseTo`); `nextRotation(270) === 0`; `furnitureRect` of a desk at rotation 90 has width 0.72 along X; `rectsOverlap` false for edge-touching rects; `roomAt(default, -7.4, -4.4) === 'room-ceo-office'`, `roomAt(default, 0, 7) === null`; every default furniture item has `roomId === roomAt(default, item.x, item.z)`; `clampRoom({...room, width: NaN})` keeps the previous width (pass previous room as fallback); `clampRoom` with width 50 → 12; `clampRoom` at x 100 → `x === 12.5 - width/2`; `findIssues(createDefaultLayout()).size === 0`; two desks at the same point produce `furniture-overlap` on both; desk + its chair produce no issue; desk + monitor produce no issue.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `clampRoom(next, office, previous?)`: replace any non-finite field with `previous`'s value (or the template minimum), then clamp. Same pattern for `clampFurniture`.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS. If `findIssues(default)` reports overlaps, fix the offsets in Task 1 data, not the rules.
- [ ] **Step 5: Commit** `feat(layout): add footprint geometry, clamping and placement validation`.

### Task 3: Pure edit operations

**Files:**
- Create: `src/layout/operations.ts`
- Test: `src/layout/operations.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (all return a **new** layout. Return the **same reference** when nothing changed so history can skip no-ops):
  ```ts
  export function createId(prefix: string): string // `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  export function addRoom(l: OfficeLayout, templateId: RoomTemplateId, at?: { x: number; z: number }): { layout: OfficeLayout; id: string }
  export function updateRoom(l: OfficeLayout, id: string, patch: Partial<Omit<Room, 'id'>>): OfficeLayout // clamps; moving x/z also moves furniture with roomId === id by the same delta
  export type Edge = 'n' | 's' | 'e' | 'w'
  export function resizeRoomEdge(l: OfficeLayout, id: string, edge: Edge, coordinate: number): OfficeLayout // moves one edge, opposite edge fixed, respects ROOM_LIMITS
  export function deleteRoom(l: OfficeLayout, id: string): OfficeLayout // also deletes furniture with roomId === id
  export function addFurniture(l: OfficeLayout, type: FurnitureType, at: { x: number; z: number }): { layout: OfficeLayout; id: string } // roomId = roomAt
  export function updateFurniture(l: OfficeLayout, id: string, patch: Partial<Omit<Furniture, 'id' | 'type'>>): OfficeLayout // clamps; recomputes roomId from new centre unless patch.roomId given
  export function rotateFurniture(l: OfficeLayout, id: string): OfficeLayout
  export function duplicateFurniture(l: OfficeLayout, id: string): { layout: OfficeLayout; id: string } // offset +0.5 x, +0.5 z, clamped
  export function deleteFurniture(l: OfficeLayout, id: string): OfficeLayout
  export function furnitureInRoom(l: OfficeLayout, roomId: string): Furniture[]
  ```
- Room deletion removes the room's furniture. The UI confirms when `furnitureInRoom(...).length > 0`, and the deletion is undoable.

- [ ] **Step 1: Write failing tests:** moving `room-ceo-office` by +1 x moves `desk-01` by +1 x and leaves `desk-03` unchanged; `updateRoom(l, id, { width: Number('') })` leaves width unchanged and is never `NaN` (Review Focus 3); `updateRoom(l, id, { width: -4 })` → width 2; `updateRoom(l, 'missing', {...}) === l`; `updateRoom(l, id, { x: room.x }) === l`; `resizeRoomEdge(l, id, 'e', room.x + room.width/2 + 1)` → width +1 and centre +0.5; resizing below minimum stops at `minWidth` with the opposite edge fixed; `deleteRoom` removes the room and its furniture; dragging `desk-01` to (0, 7) sets `roomId` to `null`; `rotateFurniture` 4 times returns to 0; `duplicateFurniture` gives a new unique id at +0.5/+0.5; `addRoom(l, 'meeting-room')` adds a 4.6×3.6 room with a unique id.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** using `clampRoom`/`clampFurniture`/`roomAt`.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(layout): add pure room and furniture edit operations`.

### Task 4: Persistence

**Files:**
- Create: `src/layout/storage.ts`
- Test: `src/layout/storage.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`clampRoom` is **not** used here. Parsing rejects; it does not repair).
- Produces:
  ```ts
  export const LAYOUT_STORAGE_KEY = 'ai-virtual-office:layout:v1'
  export const LAYOUT_BACKUP_KEY = 'ai-virtual-office:layout:v1:backup'
  type KV = Pick<Storage, 'getItem' | 'setItem'>
  export type LoadProblem = 'missing' | 'corrupt' | 'unsupported-version' | 'unavailable'
  export type LoadResult = { layout: OfficeLayout; savedJson: string | null; problem: LoadProblem | null }
  export function serializeLayout(l: OfficeLayout): string // JSON.stringify with fixed key order per object
  export function migrateLayout(raw: unknown): unknown // v1 passthrough; switch on schemaVersion for future versions
  export function parseLayout(raw: unknown): OfficeLayout | null // all fields present, correct types, finite numbers, known enums, unique ids, roomId refers to an existing room or null
  export function loadLayout(storage: KV | null): LoadResult
  export function saveLayout(storage: KV | null, l: OfficeLayout): { ok: true; json: string } | { ok: false; error: string }
  export function getBrowserStorage(): KV | null // try/catch around window.localStorage
  ```
- Load: `problem: null` means the saved layout was used and `savedJson` is the stored string. If anything else happens, return `createDefaultLayout()` with `savedJson: null`.
- Save: (1) `parseLayout(JSON.parse(serializeLayout(l)))` must succeed, or return `{ok:false}` without writing. (2) If the current stored value exists and fails `parseLayout(migrateLayout(...))` and no backup exists yet, copy it to `LAYOUT_BACKUP_KEY`. (3) Write. Any thrown error becomes `{ok:false, error}`.

- [ ] **Step 1: Write failing tests** with an in-memory `KV` fake: round trip `save` then `load` gives a deep-equal layout and `problem: null`; empty storage → `missing`; `'{not json'` → `corrupt`; `{...valid, schemaVersion: 2}` → `unsupported-version`; a layout with one room missing `width` → `corrupt`; `loadLayout(null)` → `unavailable`; a `setItem` that throws `QuotaExceededError` → `{ok:false}` (Review Focus 4); saving over a corrupt stored value writes the old raw string to the backup key first, and a second save does not overwrite the backup (Review Focus 1); `saveLayout` of a layout with a `NaN` coordinate → `{ok:false}` and storage unchanged; the legacy key `ai-virtual-office-layout` is never read or written.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(layout): persist versioned layouts to localStorage with safe loading`.

### Task 5: Editor reducer (undo/redo, drag grouping, dirty state)

**Files:**
- Create: `src/layout/history.ts`
- Test: `src/layout/history.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4 (`serializeLayout`).
- Produces:
  ```ts
  export const HISTORY_LIMIT = 100
  export type EditorState = { layout: OfficeLayout; past: OfficeLayout[]; future: OfficeLayout[]; dragOrigin: OfficeLayout | null; savedJson: string | null; selection: Selection }
  export type EditorAction =
    | { type: 'edit'; update: (l: OfficeLayout) => OfficeLayout; select?: Selection }
    | { type: 'drag-start' } | { type: 'drag-update'; update: (l: OfficeLayout) => OfficeLayout } | { type: 'drag-end' } | { type: 'drag-cancel' }
    | { type: 'undo' } | { type: 'redo' } | { type: 'select'; selection: Selection }
    | { type: 'saved'; json: string } | { type: 'replace'; layout: OfficeLayout } // replace = reset/discard, pushes history
  export function createEditorState(layout: OfficeLayout, savedJson: string | null): EditorState
  export function editorReducer(s: EditorState, a: EditorAction): EditorState
  export function isDirty(s: EditorState): boolean // serializeLayout(layout) !== savedJson
  export const canUndo = (s: EditorState) => s.past.length > 0 && !s.dragOrigin
  export const canRedo = (s: EditorState) => s.future.length > 0 && !s.dragOrigin
  ```
- `drag-update` applies `update` to `dragOrigin` (not to the accumulated layout) and does not touch history. `drag-end` pushes `dragOrigin` onto `past` only if the layout changed. `drag-cancel` restores `dragOrigin`. Undo/redo are ignored while dragging. After any layout change, clear `selection` if its id no longer exists.

- [ ] **Step 1: Write failing tests:** an `edit` that returns the same reference adds no history; 1 drag-start + 30 drag-updates + drag-end → `past.length === 1`; drag-cancel restores the original and `past` is unchanged; 101 edits → `past.length === 100`; edit → save (`saved` with `serializeLayout`) → `isDirty` false → undo → true → redo → false (Review Focus 5); a new edit after undo clears `future`; undo of `addRoom` while that room is selected → `selection === null`; `replace` is undoable.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(layout): add undo/redo editor reducer with grouped drags`.

### Task 6: Data-driven scene and true top-down floor plan

**Files:**
- Create: `src/scene/models.tsx`, `src/scene/RoomMesh.tsx`, `src/scene/FurnitureItem.tsx`
- Modify: `src/scene/OfficeScene.tsx` (remove the hard-coded `rooms` and literals), `src/App.tsx` (pass `createDefaultLayout()` temporarily)

**Interfaces:**
- Consumes: `OfficeLayout`, `FURNITURE_SPECS`.
- Produces:
  ```ts
  export type OfficeSceneProps = { layout: OfficeLayout; floorPlan: boolean; viewKey: number } // viewKey change remounts cameras = "Reset view"
  export function DeskModel(): JSX.Element // plus ChairModel, MonitorModel, PlantModel, MeetingTableModel. Origin = footprint centre on the floor, facing rotation 0
  ```
- Move the meshes verbatim from `Desk` (desktop + legs), the chair meshes (re-centred so the seat is at local z 0 and the back at z +0.17), the monitor meshes (re-centred at local z 0, y unchanged at 1.18), `Plant`, and the meeting-table group. Group rotation uses `rotation.y = rotation * Math.PI / 180`. Room walls use `room.wallHeight`.
- Floor plan: render furniture as flat tiles (`FURNITURE_SPECS[type].planColor`, footprint size, y 0.05) instead of hiding it. Use drei `OrthographicCamera makeDefault position={[0, 40, 0]} zoom={32}` and OrbitControls with `enableRotate={false}`. The 3D view keeps the existing perspective camera `[15,17,19]`, fov 42.

- [ ] **Step 1: Implement the extraction** and render purely from `layout`.
- [ ] **Step 2: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 3: Visual parity check.** Start the app with `./scripts/vo.sh` and screenshot the 3D view on `main` and on this branch. Expected: same rooms, desks, chairs, monitors, plants and table in the same places. In floor plan, the camera looks straight down and furniture tiles are visible. "Reset view" restores the default camera.
- [ ] **Step 4: Commit** `refactor(scene): render office from layout data with top-down floor plan`.

### Task 7: Editor state in App: toolbar, save status, persistence, undo/redo

**Files:**
- Create: `src/editor/useLayoutEditor.ts`, `src/editor/EditorToolbar.tsx`, `src/editor/ConfirmDialog.tsx`
- Modify: `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  ```ts
  export type SaveStatus = 'saved' | 'unsaved' | 'save-failed' | 'default'
  export function useLayoutEditor(): {
    state: EditorState; dispatch: Dispatch<EditorAction>; status: SaveStatus; loadProblem: LoadProblem | null
    save(): void; resetToDefault(): void; discardToSaved(): void
  }
  export function ConfirmDialog(props: { open: boolean; title: string; message: string; actions: { label: string; tone?: 'danger' | 'primary'; onClick(): void }[]; onClose(): void }): JSX.Element | null
  ```
- Status rules: `'save-failed'` if the last save failed and the layout is still dirty. `'default'` if `savedJson === null` and there are no edits (`past` is empty). Otherwise dirty → `'unsaved'`, clean → `'saved'`. Labels: "Saved", "Unsaved changes", "Save failed", "Default layout (not saved)".
- Initial state comes from `loadLayout(getBrowserStorage())` (lazy `useReducer` init, so it runs once and StrictMode-safe). A `corrupt`/`unsupported-version` problem shows a dismissible notice in the scene card: "Your saved layout couldn't be loaded, so the default layout is shown. The saved data is kept and backed up before your next save."
- Toolbar, in the existing `.scene-toolbar` and styled with the existing `.view-button`: Edit Layout (toggle), 3D View, Floor Plan, Undo, Redo, Snap (visible only when editing in floor plan), Reset (opens the layout reset confirm: "Replace the current layout with the default? You can undo this until you leave the page."), Save, plus the status chip. Keep camera reset as an icon button (`RotateCcw`, title "Reset view"). The page-heading Save button stays and calls the same `save()`, and its label shows the status.
- `App.tsx`: derive the sidebar department list (rooms grouped by `department`, count = desks with that `roomId`, colour = room colour) and the info cards (room count, desk count) from `state.layout`. Delete the hard-coded `departments` array.

- [ ] **Step 1: Implement** the hook, toolbar, dialog and App wiring. Add Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z via a temporary `keydown` listener (Task 8 replaces it).
- [ ] **Step 2: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 3: Manual check:** fresh profile shows "Default layout (not saved)". Save → "Saved", refresh → same. Set `localStorage['ai-virtual-office:layout:v1'] = '{bad'` in devtools and refresh → notice + default. Save → the backup key now contains `{bad`. Reset → confirm → default, then Undo restores the previous layout.
- [ ] **Step 4: Commit** `feat(editor): wire layout persistence, save status and undo/redo into app`.

### Task 8: Selection, outliner, properties panel, keyboard shortcuts

**Files:**
- Create: `src/editor/OutlinerPanel.tsx`, `src/editor/PropertiesPanel.tsx`, `src/editor/shortcuts.ts`, `src/scene/FootprintOutline.tsx`
- Test: `src/editor/shortcuts.test.ts`
- Modify: `src/scene/OfficeScene.tsx`, `src/scene/RoomMesh.tsx`, `src/scene/FurnitureItem.tsx`, `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: Tasks 3, 5, 7.
- Produces:
  ```ts
  // OfficeSceneProps gains:
  editing: boolean; selection: Selection; issues: Map<string, Issue[]>; onSelect(sel: Selection): void
  // shortcuts.ts
  export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean // INPUT, TEXTAREA, SELECT, contenteditable
  export type ShortcutAction = 'undo' | 'redo' | 'delete' | 'escape' | null
  export function matchShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; target: unknown }, editing: boolean): ShortcutAction
  export function useEditorShortcuts(editing: boolean, handlers: Record<Exclude<ShortcutAction, null>, () => void>): void // preventDefault on matched keys
  ```
- Layout while editing: the scene card becomes three columns (outliner 240px | canvas | properties 280px), and the canvas height grows to `clamp(560px, 70vh, 820px)`. Below 1000px the panels stack under the canvas. Outside edit mode the card is unchanged and selection is off (normal orbit/zoom/pan only).
- Outliner: rooms in layout order, each expandable to its furniture, plus an "Open floor" group (`roomId: null`). Clicking selects. Below the list: "Add room" (3 templates, placed at the office centre and selected) and the furniture palette (5 types, placed at the selected room's centre or the office centre, then selected).
- Properties. Room: name (text), department (select of `DEPARTMENTS`), X, Z, Width, Depth (number inputs, step 0.05, apply on blur/Enter via `updateRoom`), Delete (confirm if it contains furniture). Furniture: type (read-only), X, Z, rotation (select 0/90/180/270), room (select incl. "Open floor"), plus Rotate 90°, Duplicate and Delete buttons. Each object's `findIssues` messages are listed in red.
- Scene feedback: hover shows a light-blue outline, selected a `#4f8cff` outline, and items with issues a `#e5484d` outline (both room and furniture use `FootprintOutline`). Clicking empty floor clears the selection.

- [ ] **Step 1: Write failing tests** for `shortcuts.ts`: `matchShortcut({key:'z', metaKey:true, ...}, true) === 'undo'`; `key:'Z'` with shift+ctrl → `'redo'`; `'Backspace'` with an `INPUT` target → `null` (Review Focus 2); `'Delete'` while not editing → `null`; Cmd+Z with a `TEXTAREA` target → `null`; `'Escape'` → `'escape'`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `shortcuts.ts` (replacing the Task 7 listener), then the panels and scene selection.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Manual check:** select from the list and from the scene, rename a room (label updates in both views), change department, type `abc` or `-5` into Width (clamped, no NaN), add/duplicate/rotate/delete furniture, delete a room with furniture (confirm shown), Backspace inside the name field does not delete the room, every action can be undone.
- [ ] **Step 6: Commit** `feat(editor): add selection, outliner, properties panel and shortcuts`.

### Task 9: Direct manipulation: drag, resize, grid and snap

**Files:**
- Create: `src/scene/useFloorDrag.ts`, `src/scene/ResizeHandles.tsx`
- Modify: `src/scene/OfficeScene.tsx`, `src/scene/RoomMesh.tsx`, `src/scene/FurnitureItem.tsx`, `src/editor/useLayoutEditor.ts`, `src/App.tsx`

**Interfaces:**
- Consumes: Tasks 3, 5, 8.
- Produces:
  ```ts
  export type TransformIntent =
    | { kind: 'move'; target: NonNullable<Selection>; x: number; z: number } // target centre in world coords, grab offset already applied
    | { kind: 'resize'; roomId: string; edge: Edge; coordinate: number }
  // OfficeSceneProps gains:
  snap: boolean; onTransformStart(): void; onTransform(intent: TransformIntent): void; onTransformEnd(): void
  export function useFloorDrag(opts: { enabled: boolean; onStart(): void; onMove(point: { x: number; z: number }): void; onEnd(): void }): { onPointerDown(e: ThreeEvent<PointerEvent>): void }
  ```
- `useFloorDrag`: on pointerdown record the screen point and grab offset and call `setPointerCapture`. Start the drag only after 4px of movement, so a click is a select and not a history entry. Intersect `e.ray` with the plane y=0. Disable OrbitControls (`useThree((s) => s.controls)`) for the duration and re-enable on pointerup/pointercancel/lost capture. Escape during a drag dispatches `drag-cancel`.
- App maps intents to `drag-update` with `updateRoom`/`updateFurniture`/`resizeRoomEdge`, snapping `x/z/coordinate` with `snap(v, office.gridSize)` when snap is on. Snap defaults on and is shown in floor plan only. In 3D edit mode positions still snap when the toggle is on.
- Floor plan editing shows drei `<Grid>` with cell size `gridSize`, section size 1, under the rooms. The selected room shows 4 edge handles (small boxes at the edge midpoints, `ew-resize`/`ns-resize` cursor via `document.body.style.cursor`).
- While dragging, the moving object's outline turns red live whenever `findIssues` reports a problem with it, and the item stays where it is dropped (warn, do not block).

- [ ] **Step 1: Implement** the hook, handles, grid and intent mapping.
- [ ] **Step 2: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 3: Manual check:** in floor plan, drag a room (its furniture follows, snapped to 0.25), resize each edge (stops at 2 m), drag a desk into another room (properties show the new room), drop a desk onto another (red outline + issue listed). Release the pointer outside the canvas: the drag ends once and is one undo step. Press Escape mid-drag: it returns to the start. In 3D, dragging an object does not orbit, dragging empty space orbits. With editing off, nothing is draggable.
- [ ] **Step 4: Commit** `feat(editor): add drag-to-move, room resize handles and grid snapping`.

### Task 10: Exit-edit safety, final verification, docs

**Files:**
- Modify: `src/App.tsx`, `src/editor/useLayoutEditor.ts`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Leaving edit mode while `isDirty` opens `ConfirmDialog` "You have unsaved layout changes." with actions **Save and exit**, **Discard changes** (`discardToSaved()` = `replace` with the last saved layout or the default, undoable), and **Keep editing**. While dirty, add a `beforeunload` listener that calls `preventDefault()`.

- [ ] **Step 1: Implement** the exit dialog and `beforeunload`.
- [ ] **Step 2: Update `README.md`** "Current prototype" / "Next milestone" to describe the editor, the storage key and its limitations.
- [ ] **Step 3: Full verification (spec Phase 8):** `npm test`, `npm run build`, then the manual checks from Tasks 6–9 in one pass, plus: save, refresh, then restart via `./scripts/vo.sh` restores everything; `/vo` still opens the app when already running. Write down anything that wasn't verified.
- [ ] **Step 4: Commit** `feat(editor): guard unsaved changes on exit and document the layout editor`.
