# Office Visuals — Stage D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure rendering cost, cut it where it's cheap to do so, then verify the whole milestone end to end (editor, production build, `/vo`) and write the README update and final report.

**Architecture:**
- **Measure first:** a `?stats` overlay reads `renderer.info` over each whole frame (shadow pass, ContactShadows and main pass) and shows draw calls, triangles and FPS. Baseline numbers are recorded before any optimization.
- **Fewer draw calls:** each room's walls, glass, frames, baseboards and details are merged into one geometry per material (from about 20 meshes per room to at most 9). Furniture keeps one mesh per material per item, because each item needs its own pointer events and drag.
- **No idle rendering:** `frameloop="demand"`. The canvas renders only when something changes: camera moves, layout or selection changes, hover, or resize.

**Tech Stack:** React 19, three 0.174, @react-three/fiber 9, drei 10, Vitest. No new rendering dependencies.

**Spec:** `plan.md` §7–§10 and `tasks.md` (Stage D list, decisions 2 and 5, the editor regression checklist).

## Global Constraints

- **No schema change.** Saved layouts load unchanged (`ai-virtual-office:layout:v1`).
- **Walls, glass, frames and details still never catch pointer events** (`raycast={noRaycast}` on every merged mesh).
- **Shadow casters:** only solid walls and larger furniture. Glass, frames, baseboards, details, monitors and small parts never cast shadows.
- **The stats overlay is opt-in** (`?stats` in the URL), never shown by default, and adds no dependency.
- **Do not claim a check passed unless you ran it** (plan.md §9). The numbers in the report are measured, not estimated.
- One PR to `main` from `feat/office-visuals-stage-d`, with the measurements and final screenshots.

## Review Focus

1. **Demand rendering going stale:** after a view switch, Reset view, undo/redo, Reset layout, or a window resize, the canvas must repaint right away without needing a mouse move. Pinned by the Task 3 browser checks, with an explicit `invalidate()` in `ViewCameras`.
2. **Room resize with merged geometry:** resizing a room rebuilds its merged geometry, and the old geometry is disposed (no leak, no stale walls). Pinned in Task 2 (an effect that disposes, and a browser check of a resize drag).
3. **Small and glass-sided rooms:** merging an empty list (for example a room with no baseboards or details) renders nothing instead of throwing. Pinned in Task 2 (`mergeBoxes([])` returns `null`).
4. **Wall caps keep their dark cut colour** after merging (top face vs. sides). Pinned in Task 2 (index counts per face set) plus a close-up screenshot.
5. **Stats sampling across frames:** FPS must not count idle time under demand rendering as dropped frames. The overlay shows the rendered-frame rate over the last second and "idle" when nothing rendered. Pinned in Task 1.

---

### Task 1: Render stats overlay and baseline numbers

**Files:**
- Create: `src/scene/renderStats.ts`, `src/scene/renderStats.test.ts`, `src/scene/RenderStats.tsx`
- Modify: `src/scene/OfficeScene.tsx` (mount the probe in the canvas and the overlay next to the label layer, only when `?stats` is set), `src/styles.css` (`.render-stats`: small monospace panel, top-right of `.canvas-wrap`, `pointer-events:none`)
- Create: `docs/milestone-2-report.md` (performance table, Before column filled in)

**Interfaces:**
- Produces:
  ```ts
  export type FrameSample = { calls: number; triangles: number; time: number } // time in ms (performance.now())
  export type StatsSummary = { calls: number; triangles: number; fps: number | null } // fps null = idle (no frame in the last second)
  export function createStatsWindow(windowMs?: number): { push(sample: FrameSample): void; summary(now: number): StatsSummary } // default 1000
  export function statsEnabled(search: string): boolean // true when the query string has a `stats` key
  ```
- `RenderStatsProbe` (inside `<Canvas>`): sets `gl.info.autoReset = false`. In `useFrame(cb, -1)` (negative priority, so R3F keeps rendering) it pushes the previous frame's `gl.info.render` totals, then calls `gl.info.reset()`. It writes the summary to a DOM element through a shared ref at most 4 times a second, with no React state (same pattern as `RoomLabelTracker`).

- [ ] **Step 1: Write the failing tests** in `renderStats.test.ts`:
  - `summary` with no samples → `{ calls: 0, triangles: 0, fps: null }`
  - 30 samples 33 ms apart, the last one at `now` → `fps` is 30 (±1), and `calls`/`triangles` equal the latest sample's
  - samples older than `windowMs` are dropped: the last sample is 1500 ms before `now` → `fps: null`
  - `statsEnabled('?stats')` and `statsEnabled('?a=1&stats=1')` → true; `statsEnabled('')` and `statsEnabled('?status')` → false
- [ ] **Step 2:** `npm test -- renderStats` → FAIL (module not found)
- [ ] **Step 3:** Implement `renderStats.ts`, then `RenderStats.tsx` (`RenderStatsProbe` plus `RenderStatsPanel`), and mount them in `OfficeScene` behind `statsEnabled(window.location.search)`
- [ ] **Step 4:** `npm test` → all pass (173 + new). `npm run build` → passes (only the existing chunk-size warning)
- [ ] **Step 5: Baseline:** run `npm run dev` and open `http://localhost:5173/?stats` with the default layout (Reset layout first). Record draw calls, triangles and FPS for: 3D overview idle, 3D overview while orbiting, edit mode while dragging a desk, and floor plan idle. Write them in the Before column of the table in `docs/milestone-2-report.md`. Note the machine and browser.
- [ ] **Step 6: Commit** `feat(scene): add opt-in render stats overlay` and `docs: record stage D performance baseline`

### Task 2: Merge room parts into one geometry per material

**Files:**
- Create: `src/scene/roomGeometry.ts`, `src/scene/roomGeometry.test.ts`
- Modify: `src/scene/RoomMesh.tsx` (replace the per-box `Part` meshes)

**Interfaces:**
- Consumes: `Box`, `roomWalls`, `roomBaseboards`, `roomDetails` from `architecture.ts` (unchanged)
- Produces:
  ```ts
  export type FaceSet = 'all' | 'top' | 'sides' // 'top' = the +Y face only (BoxGeometry group 2); 'sides' = every other face
  export function mergeBoxes(boxes: Box[], faces?: FaceSet): THREE.BufferGeometry | null // default 'all'; null for []
  ```
- Each box becomes a unit `BoxGeometry` scaled and translated. Unwanted face groups are dropped from the index, and the result is merged with `mergeGeometries` from `three/examples/jsm/utils/BufferGeometryUtils.js` (already used by `furnitureModels.ts`).
- `RoomMesh` builds, per room in one `useMemo` keyed on width/depth/wallHeight/department, at most these meshes: wall sides (`wallPaint`, `castShadow`), wall tops (`wallCap`), glass, graphite (frames + `art-frame` + `whiteboard-frame` + `whiteboard-tray`), baseboard, whiteboard, art canvas (`accentMaterial(room.color)`). Every one is `receiveShadow` with `raycast={noRaycast}`. A `useEffect` cleanup disposes all of them when they're rebuilt or unmounted. Delete `wallMaterials()`, `detailMaterial()` and `Part`.

- [ ] **Step 1: Write the failing tests** in `roomGeometry.test.ts`:
  - `mergeBoxes([])` → `null`
  - two boxes `{x:0,y:0.5,z:0,w:1,h:1,d:1}` and `{x:3,y:1,z:0,w:1,h:2,d:1}` → the bounding box is min `(-0.5, 0, -0.5)` and max `(3.5, 2, 0.5)`
  - for 3 boxes, the index count is 108 for `'all'`, 18 for `'top'` and 90 for `'sides'`
  - every normal in the `'top'` result is `(0, 1, 0)`
- [ ] **Step 2:** `npm test -- roomGeometry` → FAIL
- [ ] **Step 3:** Implement `mergeBoxes`, then rewrite the `RoomMesh` render as described above
- [ ] **Step 4:** `npm test` and `npm run build` → pass
- [ ] **Step 5: Browser check** (`?stats`): the default office looks identical to `docs/screenshots/milestone-2/stage-c-overview.jpg` and `stage-c-ceo-office.jpg` (dark wall caps, frames, whiteboard, art). Resizing a room in floor plan updates its walls live. Clicking furniture behind glass still selects it. Record the new draw calls in the report's After (Task 2) column.
- [ ] **Step 6: Commit** `perf(scene): merge room parts into one mesh per material`

### Task 3: Render on demand

**Files:**
- Modify: `src/scene/OfficeScene.tsx`

**Interfaces:**
- `<Canvas frameloop="demand" …>`. `ViewCameras` calls `invalidate()` (from `useThree`) at the end of its camera `useLayoutEffect`. Prop changes, OrbitControls, pointer hover and resize already invalidate through R3F and drei. ContactShadows keeps its default `frames`, so it re-renders only on rendered frames.

- [ ] **Step 1:** Make the change
- [ ] **Step 2:** `npm test` and `npm run build` → pass
- [ ] **Step 3: Browser checks** (`?stats`, dev server): idle shows "idle" (no frames). Each of the following repaints immediately, without moving the mouse: orbit, zoom, switching 3D/floor plan, Reset view, hover highlight, select, drag (furniture and room), resize handle, undo/redo via shortcut, Reset layout confirm, and a browser window resize. Room labels follow the camera. Record the FPS while dragging a desk and orbiting in the After (Task 3) column.
- [ ] **Step 4: Commit** `perf(scene): render frames on demand only`

### Task 4: Self-host the UI fonts *(only if the user agrees; see the handoff question)*

**Files:**
- Modify: `package.json` (add `@fontsource-variable/dm-sans` and `@fontsource-variable/manrope`, both under the SIL OFL 1.1), `src/main.tsx` (import both), `src/styles.css` (remove the Google Fonts `@import`, use the families `'DM Sans Variable'` and `'Manrope Variable'` with the current names as fallbacks)
- Modify: `src/scene/noRemoteAssets.test.ts` (also scan `../**/*.css` and `../../index.html`)

- [ ] **Step 1:** Extend the test → FAIL on `src/styles.css:1`
- [ ] **Step 2:** Install, import, edit the CSS → the test passes
- [ ] **Step 3:** `npm run build`: the font files are emitted into `dist/assets`. In the browser, the Network tab shows no request to `fonts.googleapis.com` or `fonts.gstatic.com`, and headings still render in Manrope
- [ ] **Step 4: Commit** `build(fonts): self-host DM Sans and Manrope`

If the user declines: skip this task, and list the runtime Google Fonts request under Known limitations in the README and the report.

### Task 5: Full verification, README and final report

**Files:**
- Modify: `README.md`, `docs/milestone-2-report.md`, `tasks.md` (tick Stage D)
- Create: `docs/screenshots/milestone-2/final-overview.jpg`, `final-close-up.jpg`, `final-floor-plan.jpg`, `final-edit-mode.jpg`

- [ ] **Step 1: Editor regression checklist** (`tasks.md`, every item) in 3D and in floor plan on the dev server. Note pass or fail per item in the report. Any failure is fixed in its own `fix(...)` commit before continuing.
- [ ] **Step 2: Production build:** `npm run build && npm run preview`, open `http://127.0.0.1:4173`, and repeat a smoke subset: load, orbit, edit, move, save, reload. Check that the console shows no errors and the Network tab shows no remote requests (apart from fonts if Task 4 was skipped).
- [ ] **Step 3: `/vo` end to end:** stop the dev server, run `./scripts/vo.sh` (cold start), confirm it starts and opens the page, then run it again (already-running path) and confirm it doesn't start a second server.
- [ ] **Step 4: Screenshots** with the same camera angles as the earlier stages (overview, close-up, floor plan, edit mode)
- [ ] **Step 5: README:** rewrite the Features bullet on visuals: in-code daylight (no HDR download), department floor finishes, cutaway walls with framed glass, the furniture set, plant variants, wall details. Add an "Assets and licences" section: all geometry and textures are procedural, there are no external models or textures, plus the font licence if Task 4 ran. Add `?stats`. Update Known limitations: furniture isn't instanced (one mesh per material per item); no real-time AO or post-processing; no doors or ceilings by design; the existing chunk-size warning.
- [ ] **Step 6: Final report** in `docs/milestone-2-report.md`, following plan.md §10: files changed per stage and why, visual improvements, dependencies and assets with their licences, build and test results (the actual output counts), the performance table, acceptance criteria 1–12 each with evidence, known limitations, and how to inspect locally.
- [ ] **Step 7:** Tick Stage D in `tasks.md`. Commit `docs: stage D verification, README and milestone 2 report`. Open the PR with the report summary, the performance table and the screenshots.
