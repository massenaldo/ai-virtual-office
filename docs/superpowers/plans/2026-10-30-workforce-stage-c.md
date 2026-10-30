# Workforce Stage C: Agents in the 3D Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each assigned desk shows a small status marker in 3D and in the floor plan. Selecting an agent highlights its desk and offers **Focus desk**. In Workforce mode, clicking a desk opens its agent, or offers to assign one to a free desk.

**Architecture:**
- **Markers** are a DOM layer moved every frame by a tracker, exactly like `RoomLabelLayer`/`RoomLabelTracker`. They have `pointer-events: none`, so they never take clicks, and they don't touch furniture geometry.
- **The desk highlight** reuses `FootprintOutline` through a new `agent` flag in `highlightFor`.
- **Desk clicks** attach R3F `onClick` to `desk` furniture only, and only when an `onDeskClick` callback is passed (Workforce mode). Clicks that were really drags are ignored.
- **Focus** is a pure `focusPose` helper plus a `focus` request prop that `ViewCameras` applies to the camera and the OrbitControls target.
- **App** takes ownership of the panel's view state (`WorkforceView`), so a scene click can open an agent.

**Tech Stack:** React 19, three 0.174, @react-three/fiber 9, drei 10, Vitest 5. No new dependencies.

**Spec:** `plan.md` Phase 4 and `tasks.md` (decisions 2, 5 and 10, Stage C, and the Q1 and Q3 answers). This builds on the merged Stages A and B.

## Global Constraints

- Markers and click targets never change furniture geometry, and markers never intercept pointer events (`pointer-events: none` on the layer and the markers).
- **Edit mode is unchanged:** no markers, no agent highlight and no desk-click handler while `editing`. Selection, transforms, undo/redo, save, reset and the floor plan behave exactly as before.
- A marker appears only for an agent whose `deskId` is a `desk` that exists in the current layout. A missing desk gets no marker, and the panel keeps its "Workstation unavailable" state (Q3).
- **Marker colours** match the panel status dots:
  - idle `#8e9bad`;
  - thinking `#a89af5`;
  - working `#65c995`;
  - waiting `#e5b878`;
  - error `#ff8a8a`;
  - completed `#83c1df`.
- **Agent highlight colour:** `#a89af5`, outline width 3.
- No animation beyond what is already there. Rendering stays on demand (`frameloop="demand"`). A change in the marker set calls `invalidate()` once.
- A desk click that moved the pointer more than **4 px** (`e.delta > 4`) is a drag, not a click.
- Copy:
  - **Focus desk** button, or **Desk not in the layout** when the desk is unavailable;
  - assign view title `Assign <Desk label>`, with the hint `Pick an agent for this desk. An agent that already has a desk moves here.`, and the empty text `No agents yet. Create one first.`

## Review Focus

1. **The user drags to orbit and releases over a desk.** No agent opens: the click is ignored because `e.delta > 4` (Task 2 relies on R3F's `delta`; checked in the browser in Task 4).
2. **An agent's desk is deleted, or the layout is reset or edited, while the agent is selected.** The marker disappears, the highlight is gone, Focus is disabled, and nothing throws (Task 1 test for markers, Task 3 for the disabled Focus).
3. **The user switches to the floor plan while focused, or presses Reset view.** Focus pans the plan; Reset view returns to the overview (Task 1 test for the plan pose, browser check in Task 4).
4. **Markers stay in sync during a simulated run without React re-rendering the canvas.** Status changes re-render the DOM layer only; positions need no update (Task 4 browser check).
5. **In edit mode, the existing desk click selects furniture as before**, and the workforce click handler isn't attached (Task 2 code path, Task 4 regression check).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/workforce/view.ts` | Add `deskMarkers`, `deskClickTarget` and `assignableAgents` |
| `src/scene/labels.ts` | Add `markerAnchor` |
| `src/scene/highlight.ts` | Add the `agent` flag and the `HIGHLIGHT.agent` colour |
| `src/scene/camera.ts` | Add `focusPose` and `FOCUS_DISTANCE` |
| `src/scene/DeskMarkers.tsx` | `DeskMarkerLayer` (DOM) and `DeskMarkerTracker` (useFrame) |
| `src/scene/FurnitureItem.tsx` | Agent highlight and the Workforce desk click |
| `src/scene/OfficeScene.tsx` | New props `markers`, `highlightDeskId`, `onDeskClick` and `focus`, with focus applied in `ViewCameras` |
| `src/workforce/ui/WorkforcePanel.tsx` | Controlled `view` / `onViewChange`, the `assign` view, and Focus wiring |
| `src/workforce/ui/AgentDetail.tsx` | Focus desk button |
| `src/workforce/ui/AssignDesk.tsx` | Pick an agent for a free desk |
| `src/App.tsx` | Own the `WorkforceView` and focus request, and pass the scene props |
| `src/styles.css` | Marker layer styles |

---

### Task 1: Pure helpers

**Files:**
- Modify: `src/workforce/view.ts`, `src/scene/labels.ts`, `src/scene/highlight.ts`, `src/scene/camera.ts`
- Test: `src/workforce/view.test.ts`, `src/scene/labels.test.ts`, `src/scene/highlight.test.ts`, `src/scene/camera.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/scene/labels.ts — scene-side marker shape, no workforce imports
  export type DeskMarker = { id: string; label: string; status: string; x: number; z: number; selected: boolean }
  export const MARKER_HEIGHT = 1.45, PLAN_MARKER_HEIGHT = 0.35
  export function markerAnchor(m: Pick<DeskMarker, 'x' | 'z'>, floorPlan: boolean, out?: THREE.Vector3): THREE.Vector3
  // src/scene/highlight.ts
  export const HIGHLIGHT = { selected, hover, invalid, agent: '#a89af5' }
  export function highlightFor(s: { editing: boolean; selected: boolean; hovered: boolean; invalid: boolean; agent?: boolean; deskHover?: boolean }): { color: string; width: number } | null
  // src/scene/camera.ts
  export const FOCUS_DISTANCE = 9
  export function focusPose(point: { x: number; z: number }, floorPlan: boolean): { target: [number, number, number]; position: [number, number, number] }
  // src/workforce/view.ts
  export function deskMarkers(layout: OfficeLayout, s: WorkforceState, selectedAgentId: string | null): DeskMarker[]   // id = agent id, label = agent name, layout furniture order
  export function deskClickTarget(s: WorkforceState, deskId: string): { kind: 'open'; agentId: string } | { kind: 'assign'; deskId: string }
  export function assignableAgents(s: WorkforceState): Agent[]   // agents without a desk first, then the rest; stable within each group
  ```
- `highlightFor` behaviour:
  - When `editing`, the existing rules apply unchanged and `agent`/`deskHover` are ignored.
  - When not editing, `agent` gives `{ color: HIGHLIGHT.agent, width: 3 }`; otherwise `deskHover` gives `{ color: HIGHLIGHT.hover, width: 2 }`; otherwise `null`.
- `focusPose`:
  - 3D: `target = [x, 0.4, z]` and `position = target + OVERVIEW_DIRECTION * FOCUS_DISTANCE`.
  - Floor plan: `target = [x, 0, z]` and `position = [x, 40, z + 0.001]`, matching the existing plan camera.

- [ ] **Step 1: Write the failing tests**
  - `view.test.ts`:
    - `deskMarkers lists agents on existing desks`: for the demo state and default layout, there are 6 markers. Atlas's marker is `{ id: 'agent-demo-pm', label: 'Atlas', status: 'idle', x: -2.7, z: -4.4, selected: false }`. Passing `selectedAgentId: 'agent-demo-pm'` sets `selected: true` on that one only.
    - `deskMarkers skips missing desks and agents without one` (Review Focus 2): a layout without `desk-03` gives 5 markers. An agent with `deskId: null` and one with `deskId: 'chair-03'` get none.
    - `deskClickTarget opens the agent at a desk or offers to assign`: `desk-03` gives `{ kind: 'open', agentId: 'agent-demo-pm' }`, and `desk-04` gives `{ kind: 'assign', deskId: 'desk-04' }`.
    - `assignableAgents puts agents without a desk first`.
  - `labels.test.ts`: `markerAnchor floats above a desk in 3D and just above the floor in plan` gives `(1, 1.45, 2)` and `(1, 0.35, 2)`.
  - `highlight.test.ts`:
    - `agent highlight shows outside edit mode`;
    - `desk hover shows outside edit mode only without agent`;
    - `edit mode ignores the agent flags`: `{ editing: true, selected: false, hovered: false, invalid: false, agent: true }` gives `null`.
  - `camera.test.ts`: `focusPose aims at a point in 3D and plan`. In 3D the target is `[1, 0.4, 2]` and `position − target` has length `≈ 9` along `OVERVIEW_DIRECTION`. The plan position is `[1, 40, 2.001]`.
- [ ] **Step 2: Run them and confirm they fail**
  Run: `npx vitest run src/workforce/view.test.ts src/scene/labels.test.ts src/scene/highlight.test.ts src/scene/camera.test.ts`
  Expected: FAIL, because the new exports are missing.
- [ ] **Step 3: Implement the helpers** above.
- [ ] **Step 4: Run them and confirm they pass** (same command). Expected: PASS
- [ ] **Step 5: Commit** with `feat(scene): add desk marker, focus and agent highlight helpers`

---

### Task 2: Scene support

**Files:**
- Create: `src/scene/DeskMarkers.tsx`
- Modify: `src/scene/FurnitureItem.tsx`, `src/scene/OfficeScene.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: Task 1 (`DeskMarker`, `markerAnchor`, `screenPosition`, `highlightFor`, `focusPose`).
- Produces (new optional `OfficeScene` props; existing callers compile unchanged):
  ```ts
  markers?: DeskMarker[]                       // rendered only when !editing
  highlightDeskId?: string | null              // agent outline on that desk when !editing
  onDeskClick?: (deskId: string) => void       // attached to desk items only when !editing
  focus?: { x: number; z: number; key: number } | null   // apply focusPose whenever key changes
  ```
  - **`DeskMarkerLayer({ markers, registry })`:** a `div.desk-marker-layer` containing one `div.desk-marker.<status>` per marker, with a `.desk-marker-dot` and the name; a selected marker adds `.selected`. Same ref-registry pattern as `RoomLabelLayer`.
  - **`DeskMarkerTracker({ markers, floorPlan, registry })`:** positions the markers in `useFrame` with `screenPosition(markerAnchor(...))`. It calls `invalidate()` in an effect whenever the marker ids or positions change, so new markers get placed under on-demand rendering.
  - **FurnitureItem** gets new props `agentHighlight: boolean` and `onDeskClick?: () => void`.
    - When `!editing && onDeskClick`, it attaches `onClick` (ignored when `e.delta > 4`, otherwise `e.stopPropagation()` and the callback), `onPointerOver`/`onPointerOut` for `deskHover`, and sets `document.body.style.cursor = 'pointer'` while hovered.
    - On pointer out or unmount it resets the cursor to `''`.
    - The outline uses `highlightFor({ editing, selected, hovered, invalid, agent: agentHighlight, deskHover: hovered && !!onDeskClick })`.
  - **ViewCameras** gets `focus`. In a `useLayoutEffect` on `[focus?.key]`, when a focus is set it reads `controls` from `useThree` and sets `camera.position` and `controls.target` from `focusPose`, then calls `controls.update()` and `invalidate()`. In the floor plan it also keeps the current zoom. `viewKey` and the view switch still reset to the overview, because those effects already run on their own keys.
  - **CSS:**
    - `.desk-marker-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:9}`.
    - `.desk-marker{position:absolute;left:0;top:0;visibility:hidden;will-change:transform;pointer-events:none;display:flex;align-items:center;gap:5px;white-space:nowrap;font:600 9px 'DM Sans Variable',sans-serif;color:#25303b;background:#ffffffe6;border:1px solid #c3ccd0;border-radius:999px;padding:3px 7px 3px 5px;box-shadow:0 2px 6px #1d2a3522}`.
    - `.desk-marker.selected{border-color:#a89af5;box-shadow:0 0 0 2px #a89af566}`.
    - `.desk-marker-dot` is 7px round, with one colour rule per status from Global Constraints.

- [ ] **Step 1: Write `DeskMarkers.tsx` and the FurnitureItem, OfficeScene and CSS changes** to the interface above. `OfficeContents` passes `agentHighlight={!editing && item.id === highlightDeskId}`, and `onDeskClick` only for `item.type === 'desk' && !editing && props.onDeskClick`.
- [ ] **Step 2: Type-check, test and build**
  Run: `npx tsc -b --noEmit && npm test && npm run build`
  Expected: no type errors, all tests pass, and the build succeeds with only the existing chunk-size warning.
- [ ] **Step 3: Commit** with `feat(scene): show desk status markers, agent highlight, desk clicks and focus`

---

### Task 3: Panel and App wiring

**Files:**
- Create: `src/workforce/ui/AssignDesk.tsx`
- Modify: `src/workforce/ui/WorkforcePanel.tsx`, `src/workforce/ui/AgentDetail.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: Task 1 (`deskMarkers`, `deskClickTarget`, `assignableAgents`, `deskStatus`) and Task 2's props.
- Produces:
  ```ts
  // WorkforcePanel.tsx
  export type WorkforceView = { kind: 'list' } | { kind: 'create' } | { kind: 'detail' | 'edit'; agentId: string } | { kind: 'assign'; deskId: string }
  export type WorkforcePanelProps = { workforce: Workforce | null; layout: OfficeLayout; view: WorkforceView; onViewChange(v: WorkforceView): void; onFocusDesk(deskId: string): void; openDialog(d: DialogRequest): void }
  export function selectedAgentId(view: WorkforceView): string | null   // agentId for detail/edit, else null
  ```
  - **The panel** drops its local `useState` and uses `view`/`onViewChange`. A missing agent or a missing assign desk falls back to the list, as before.
  - **AgentDetail** gets `onFocusDesk()`. In the Workstation section it shows a `Focus desk` button (`LocateFixed` icon) when `deskStatus` is `assigned`. When it is `unavailable`, the button is disabled with the label `Desk not in the layout`. When there is no desk, no button.
  - **AssignDesk** (`{ state, layout, deskId, onAssign(agentId), onCancel }`):
    - shows the title and hint from Global Constraints and lists `assignableAgents` as `.agent-row` buttons with their current desk chip;
    - clicking calls `actions.assignDesk(agentId, deskId)` and then opens that agent's detail;
    - a failure shows `.form-error`;
    - an empty state;
    - Cancel goes back to the list.
  - **App:**
    - `const [agentView, setAgentView] = useState<WorkforceView>({ kind: 'list' })` and `const [focus, setFocus] = useState<{ x: number; z: number; key: number } | null>(null)`.
    - Scene props when `agentsOpen && !editing`:
      - `markers={deskMarkers(layout, wf.state, selectedAgentId(agentView))}`;
      - `highlightDeskId` = the selected agent's `deskId`, when `deskStatus` is assigned;
      - `onDeskClick={(id) => { const t = deskClickTarget(...); setAgentView(t.kind === 'open' ? { kind: 'detail', agentId: t.agentId } : t) }}`.
    - When the panel is closed and not editing, markers still show (with `selectedAgentId` null) but there is no click or highlight.
    - `onFocusDesk(deskId)` looks the desk up in `state.layout.furniture` and calls `setFocus({ x, z, key: Date.now() })`.
    - Closing the panel resets `agentView` to the list.
- [ ] **Step 1: Write the changes** to the interface above.
- [ ] **Step 2: Type-check, test and build**
  Run: `npx tsc -b --noEmit && npm test && npm run build`
  Expected: all pass, with only the existing warning.
- [ ] **Step 3: Commit** with `feat(workforce): link agents and desks between the panel and the 3D office`

---

### Task 4: Browser verification, screenshots and PR

**Files:**
- Create: `docs/screenshots/milestone-3a/stage-c-*.jpg`
- Modify: `tasks.md` (tick the Stage C boxes)

- [ ] **Step 1: Run `npm run dev` and check, with the console free of errors:**
  1. Markers appear above the six demo desks in 3D and in the floor plan, and follow orbit, zoom and pan.
  2. A marker's colour and status change live during a simulated run.
  3. Selecting an agent outlines its desk. **Focus desk** moves the camera in 3D and pans in the plan. **Reset view** returns to the overview.
  4. In Workforce mode, clicking Atlas's desk opens Atlas, and clicking a free desk opens Assign. Assigning moves the agent and its marker.
  5. Orbiting with a drag that ends over a desk opens nothing (Review Focus 1).
  6. Clicking a marker itself doesn't block the scene; the click goes through to the desk.
  7. Deleting an assigned desk in edit mode and saving: the marker and highlight are gone, and Focus is disabled. Reset layout brings them back.
  8. **Edit-mode regression:** no markers, desk click selects furniture, dragging moves furniture, rotate, undo/redo, save, reset, floor-plan sync.
  9. Without the panel open, markers still show, and clicking a desk does nothing.
- [ ] **Step 2: Save screenshots** (markers in 3D, markers in the floor plan, the focused desk with the panel) to `docs/screenshots/milestone-3a/`.
- [ ] **Step 3: Tick the Stage C boxes in `tasks.md`** except "PR". Commit with `docs: add stage C screenshots and tick tasks`.
- [ ] **Step 4: Push and open the PR to `main`** with the screenshots, the check results, and the statement that execution is simulated.
