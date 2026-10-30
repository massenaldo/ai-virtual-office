# Workforce Stage B: Panel and Task UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking **AI Agents** in the sidebar opens a Workforce panel beside the 3D office. There you can list, filter, create, edit and remove agents, assign desks, and run simulated tasks with an activity timeline. Everything is labelled mock.

**Architecture:**
- A non-React `WorkforceController` (`src/workforce/controller.ts`) owns the state. It also owns the runtime subscription and saves automatically. Every change goes through one `commit()`, which updates a single current-state variable synchronously, so runtime events and user actions can't overwrite each other.
- `useWorkforce` wraps the controller with `useSyncExternalStore`.
- Pure view helpers (`src/workforce/view.ts`) do the filtering, desk options, desk status, timeline and labels. The React components in `src/workforce/ui/` stay thin, like `src/editor/`.
- `App.tsx` gains a `workforce` mode. Turning it on leaves layout edit mode through the existing unsaved-changes flow, and turning edit mode on closes it.

**Tech Stack:** React 19, TypeScript 5.7, Vitest 5 (Node, fake timers), lucide-react. No new dependencies.

**Spec:** `plan.md` (Phases 3, 5, 8) and `tasks.md` (decisions 1–11, Stage B, and the Q1–Q2 answers). This builds on the merged Stage A (`src/workforce/`).

## Global Constraints

- Workforce mode and layout edit mode are never on at the same time (Q1). Agent changes save automatically and are not part of the layout's undo history (Q2).
- A visible **Mock mode** badge in the panel header. Every simulated activity shows a **Simulated** label. Demo agents show a **Demo** label.
- Only `desk` furniture can be assigned, one agent per desk. A desk the layout no longer has shows **Workstation unavailable** (Q3).
- Removing an agent asks for confirmation only when it has an active task or any task history. The confirmation goes through the existing `ConfirmDialog`.
- No `window.confirm` or `alert`. No new animations beyond a CSS dot.
- The layout editor, 3D scene, save, reset, undo/redo and floor plan behave exactly as before.
- Copy:
  - empty states `No agents yet. Create one or restore the demo agents.` and `No agents match these filters.`;
  - the notice for unreadable workforce data `Saved agents couldn't be loaded, so none are shown. The saved data was backed up.`;
  - for a newer version `Saved agents come from a newer version of the app, so none are shown. The saved data was backed up.`;
  - a save failure `Agent changes couldn't be saved: <error>`.
- Code style follows `src/editor/`: thin components, logic in tested pure modules, existing CSS classes (`editor-panel`, `panel-title`, `field`, `field-input`, `panel-button`) reused before adding new ones.

## Review Focus

1. **A runtime event arrives while the user is in the middle of an action.** It must not be lost or overwrite the action's result, because both go through `commit()` on the current state (Task 2 test: an event fires between assign and start).
2. **The user deletes or moves desks in the layout editor, or uses Reset layout, while agents hold desks.** The panel shows "Workstation unavailable" for the missing desk, the desk picker never offers a desk another agent holds, and nothing crashes (Task 1 tests).
3. **Starting a task on a `real` agent or with a runtime that refuses to start.** The task ends `failed` with the runtime's error instead of staying queued forever (Task 2 test).
4. **Workforce storage is unavailable or the save throws.** The panel still works in memory and shows the save error once; a later successful save clears it (Task 2 test).
5. **The page is closed or reloaded mid-run.** `dispose()` clears the timers; the reload recovery from Stage A marks the task failed. The controller does not save during `dispose` (Task 2 test).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/workforce/view.ts` | Pure UI helpers: filters, desk options and status, timeline, removal prompt, labels |
| `src/workforce/controller.ts` | State owner: load, commit and autosave, runtime wiring, actions |
| `src/workforce/useWorkforce.ts` | React hook around one controller per mount |
| `src/workforce/ui/WorkforcePanel.tsx` | Panel shell: header with the Mock badge, and list / detail / form views |
| `src/workforce/ui/AgentList.tsx` | Filters, list rows, empty states, New and Restore demo buttons |
| `src/workforce/ui/AgentForm.tsx` | Create and edit form with validation messages |
| `src/workforce/ui/AgentDetail.tsx` | Desk picker, current task, task form, run and demo controls, timeline |
| `src/styles.css` | Workforce panel styles, appended |
| `src/App.tsx` | Sidebar item, mode switching, panel slot, notices, Next milestone card |

---

### Task 1: View helpers

**Files:**
- Create: `src/workforce/view.ts`
- Test: `src/workforce/view.test.ts`

**Interfaces:**
- Consumes: `OfficeLayout` and `Furniture` (`src/layout/types`), `DEPARTMENTS` (`src/layout/catalog`), and the Stage A types plus `isActiveTask`.
- Produces:
  ```ts
  export type AgentFilter = { department: AgentDepartment | 'all'; status: AgentStatus | 'all' }
  export const AGENT_STATUS_LABEL: Record<AgentStatus, string>   // Idle, Working, Thinking, Waiting, Error, Completed
  export const TASK_STATUS_LABEL: Record<TaskStatus, string>     // Queued, Running, Waiting, Completed, Failed, Cancelled
  export const AGENT_DEPARTMENTS: AgentDepartment[]               // DEPARTMENTS keys without 'meeting', catalog order
  export function filterAgents(agents: Agent[], f: AgentFilter): Agent[]
  export type DeskOption = { id: string; label: string }          // label 'Desk 03' for desk-03, otherwise the id
  export type DeskGroup = { roomId: string | null; roomName: string; desks: DeskOption[] }
  /** Free desks plus the agent's own, grouped by room in layout order, then 'Open floor' last; empty groups omitted. */
  export function deskOptions(layout: OfficeLayout, s: WorkforceState, agentId: string): DeskGroup[]
  export type DeskStatus = { kind: 'none' } | { kind: 'assigned'; label: string; roomName: string } | { kind: 'unavailable'; deskId: string }
  export function deskStatus(layout: OfficeLayout, agent: Agent): DeskStatus
  export function agentTimeline(s: WorkforceState, agentId: string, limit?: number): AgentActivity[]   // newest first, default 20
  export function agentHistory(s: WorkforceState, agentId: string): AgentTask[]                         // newest first
  export function removalPrompt(s: WorkforceState, agentId: string): { title: string; message: string } | null
  export function formatTime(iso: string): string   // local HH:MM:SS (24h), via toLocaleTimeString with hour12: false
  ```
  `removalPrompt` copy:
  - title `Remove <name>?`;
  - message `<name> is running "<title>". Removing the agent cancels the task and deletes its history.` when it has an active task;
  - otherwise `This deletes <name> and its task history.` when it has any task;
  - otherwise `null`.

- [ ] **Step 1: Write the failing tests**
  - `filterAgents filters by department and status`: using `createDemoWorkforce(NOW)`, `{ department: 'qa', status: 'all' }` gives `['agent-demo-qa']`; `{ status: 'working' }` gives `[]`; `all/all` gives 6.
  - `deskOptions lists free desks by room plus the agent's own`: with the default layout and demo state, for `agent-demo-pm` the `room-project-management` group contains `desk-03` (its own) and `desk-04`; the `desk-05` held by Meridian appears nowhere; 'Open floor' is the last group; the CEO office group has desks `desk-01`, `desk-02`; and a desk label is `'Desk 03'`.
  - `deskOptions skips desks another agent holds even when that agent's desk is unavailable`: delete `desk-04` from the layout and it is gone from the options.
  - `deskStatus reports assigned, none and unavailable` (Review Focus 2): Atlas is assigned with `{ label: 'Desk 03', roomName: 'PROJECT MANAGEMENT' }`; a desk on the open floor has `roomName: 'Open floor'`; a layout without `desk-03` gives `{ kind: 'unavailable', deskId: 'desk-03' }`; `deskId: null` gives `none`.
  - `agentTimeline is newest first and limited`, and `agentHistory is newest first`.
  - `removalPrompt asks only when there is a task`: a fresh demo agent gives `null`; after `assignTask` the active message has the exact text; after `cancelTask` it gives the history message.
  - `formatTime gives HH:MM:SS`: matches `/^\d{2}:\d{2}:\d{2}$/`.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `npx vitest run src/workforce/view.test.ts`
  Expected: FAIL, because the module can't be found.

- [ ] **Step 3: Implement `view.ts`.** Room names come from `layout.rooms` (the stored `name`, uppercase in the default layout).

- [ ] **Step 4: Run them and confirm they pass**
  Run: `npx vitest run src/workforce/view.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit** with `feat(workforce): add view helpers for the workforce panel`

---

### Task 2: Workforce controller

**Files:**
- Create: `src/workforce/controller.ts`
- Test: `src/workforce/controller.test.ts`

**Interfaces:**
- Consumes: Stage A `loadWorkforce`, `saveWorkforce`, the operations, `restoreDemoAgents`, `RuntimeProvider`, `MockRuntimeProvider` and `MockDemoControls`.
- Produces:
  ```ts
  type KV = Pick<Storage, 'getItem' | 'setItem'>
  export type WorkforceSnapshot = { state: WorkforceState; loadProblem: 'corrupt' | 'unsupported-version' | 'unavailable' | null; saveError: string | null }
  export type ActionResult = { ok: true } | { ok: false; error: string }
  export type WorkforceController = {
    getSnapshot(): WorkforceSnapshot           // same object until something changes
    subscribe(listener: () => void): () => void
    createAgent(input: AgentInput): { ok: true; id: string } | { ok: false; error: string }
    updateAgent(id: string, patch: Partial<AgentInput>): ActionResult
    removeAgent(id: string): void              // runtime.cancel(cancelledTaskId) when there is one
    assignDesk(agentId: string, deskId: string | null): ActionResult
    startTask(agentId: string, input: TaskInput): ActionResult   // assignTask, then runtime.start; a start failure → 'failed' event with its error
    cancelTask(taskId: string): void           // runtime.cancel + cancelTask (Stage A), so an untracked task still ends
    forceWaiting(taskId: string): void; resume(taskId: string): void; forceError(taskId: string): void   // no-ops without demo controls
    restoreDemoAgents(): void
    dismissLoadProblem(): void
    dispose(): void                            // unsubscribes and disposes the runtime; no save
  }
  export function createWorkforceController(opts: { storage: KV | null; now?: () => string; runtime?: RuntimeProvider & Partial<MockDemoControls> }): WorkforceController
  ```
  - `now` defaults to `() => new Date().toISOString()`, and `runtime` defaults to `new MockRuntimeProvider()`.
  - Runtime events go through `applyRuntimeEvent(current, e, now(), runtime.mode)`.
  - `commit(next)`:
    - does nothing when `next === current`;
    - otherwise sets current, calls `saveWorkforce`, and sets `saveError` (cleared on success);
    - builds a new snapshot and notifies listeners.
  - Nothing is saved at construction, so an untouched demo seed or an unreadable value is not written until the first change.
  - `loadProblem` is kept only for `corrupt`, `unsupported-version` and `unavailable`.

- [ ] **Step 1: Write the failing tests** with a `memoryStorage` helper, a fixed `now`, and `vi.useFakeTimers()`:
  - `seeds the demo without saving until the first change`: `getSnapshot().state.agents` has length 6 and storage has no workforce key. After `createAgent(...)` the key exists and parses to 7 agents.
  - `snapshot is stable until a change`: `getSnapshot() === getSnapshot()`. A subscriber is called once per change, and not for a no-op `updateAgent` with the same values.
  - `startTask runs the simulated lifecycle and saves each step`: start on `agent-demo-backend`, advance 6000ms, and the task is `completed`. The saved JSON has the completed task.
  - `an event between actions is not lost` (Review Focus 1): start a task for Forge, advance 0ms (started fires), then `createAgent` for a new agent. Both the `running` task and the new agent are in the snapshot.
  - `a refused start fails the task` (Review Focus 3): with `runtime: new ClaudeRuntimeProvider()`, `startTask` returns `ok`, and the task is `failed` with `errorMessage === CLAUDE_UNAVAILABLE`. The agent is `error`, and a new `startTask` succeeds.
  - `startTask reports validation and active-task errors`: blank title gives `{ ok: false, error: 'Title is required.' }`.
  - `cancelTask ends a task the runtime lost`: with a stub runtime whose `start` succeeds but never emits and whose `cancel` does nothing, `startTask` then `cancelTask` leaves the task `cancelled` and the agent `idle`.
  - `removeAgent cancels its run`: start, remove, advance 10000ms; no task for that agent and `runtime.activeTaskIds()` is `[]`.
  - `demo controls drive waiting and error`: `forceWaiting` sets the agent to `waiting`, `resume` then 4000ms gives `completed`; `forceError` gives `error` with `MOCK_ERROR_MESSAGE`.
  - `surfaces and clears save errors` (Review Focus 4): storage whose `setItem` throws once gives a `saveError` of the thrown message, and the next successful change gives `null`. With `storage: null`, `loadProblem` is `'unavailable'` and actions still work in memory.
  - `dispose clears timers and does not save` (Review Focus 5): start a task, record `setItem` calls, `dispose()`, then `vi.getTimerCount() === 0` and no further `setItem`.
  - `restoreDemoAgents brings back removed demo agents`.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `npx vitest run src/workforce/controller.test.ts`
  Expected: FAIL, because the module can't be found.

- [ ] **Step 3: Implement `createWorkforceController`** as a closure (no class), with `let current` and `let snapshot`, as described above.

- [ ] **Step 4: Run them and confirm they pass**
  Run: `npx vitest run src/workforce/controller.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit** with `feat(workforce): add workforce controller with autosave and runtime wiring`

---

### Task 3: Panel UI

**Files:**
- Create: `src/workforce/useWorkforce.ts`, `src/workforce/ui/WorkforcePanel.tsx`, `src/workforce/ui/AgentList.tsx`, `src/workforce/ui/AgentForm.tsx`, `src/workforce/ui/AgentDetail.tsx`
- Modify: `src/styles.css` (append a `/* Workforce panel */` block)

**Interfaces:**
- Consumes: Tasks 1–2, plus `DialogRequest` (`src/editor/useEditorActions`) for the remove confirmation.
- Produces:
  ```ts
  // useWorkforce.ts
  export function useWorkforce(): WorkforceSnapshot & { actions: WorkforceController }   // one controller per mount (useState initializer), disposed in an effect cleanup
  // WorkforcePanel.tsx
  export type WorkforcePanelProps = { workforce: ReturnType<typeof useWorkforce>; layout: OfficeLayout; openDialog(d: DialogRequest): void }
  export default function WorkforcePanel(p: WorkforcePanelProps): JSX.Element
  ```
  - **Panel:** `<aside className="editor-panel workforce" aria-label="AI agents">`. The header reads `AI AGENTS` with a `Mock mode` badge (`.mock-badge`), and the tooltip says `Tasks are simulated in the browser. No AI is run.`
  - **Views, as local state:**
    - `list`;
    - `detail(agentId)`, which falls back to `list` if the agent is gone;
    - `create`;
    - `edit(agentId)`.
  - **AgentList:**
    - two `select.field-input` filters (All departments + `AGENT_DEPARTMENTS`, All statuses + statuses), then the rows;
    - each row shows a status dot (`.status-dot-<status>`), the name, the role, the department label, `Demo` and `No desk` / `Desk unavailable` chips, and the status label;
    - the buttons are `New agent` and `Restore demo agents`, the latter shown only when a demo id is missing;
    - the two empty-state messages.
  - **AgentForm:**
    - name and role `input.field-input` with `maxLength`, a department select, and Save / Cancel buttons;
    - shows the `validateAgentInput` error under the form on submit (`.form-error`, `role="alert"`);
    - on success it returns to detail.
  - **AgentDetail:**
    - **header:** name, role, department, the Demo chip, an Edit button, and a Remove button (`removalPrompt` → `openDialog` with a danger action, or remove directly);
    - **Workstation:** a desk `select` grouped with `<optgroup label={roomName}>` plus a `No desk` option; or a `.desk-warning` reading `Workstation unavailable — <deskId> is no longer in the layout. Pick another desk.`;
    - **Current task:** the title, the `TASK_STATUS_LABEL` value, the start time, the result or error, and a `Simulated run` note;
    - **while the task is active:** a Cancel task button and a `Demo controls` group with `Simulate waiting`, `Resume` (only when waiting) and `Simulate error`;
    - **when no task is active:** the task form with a title input, a description textarea and a `Start simulated task` button, with errors shown as in the agent form;
    - **Activity:** `agentTimeline`, each entry showing `formatTime`, the message and a `Simulated` chip when `source === 'mock'`; the empty text is `No activity yet.`

- [ ] **Step 1: Write `useWorkforce` and the four components** to the interface above.
- [ ] **Step 2: Append the styles.** `.scene-card.workforce .editor-body{grid-template-columns:minmax(0,1fr) 340px}`, with the same canvas height as editing, and the same `@media(max-width:1000px)` single-column fallback. Status dot colours:
  - idle `#8e9bad`;
  - thinking `#a89af5`;
  - working `#65c995`;
  - waiting `#e5b878`;
  - error `#ff8a8a`;
  - completed `#83c1df`.
- [ ] **Step 3: Type-check and build**
  Run: `npx tsc -b --noEmit && npm run build`
  Expected: no type errors. The build succeeds with only the existing chunk-size warning.
- [ ] **Step 4: Commit** with `feat(workforce): add the workforce panel components`

---

### Task 4: App integration

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: Task 3 (`useWorkforce`, `WorkforcePanel`).
- Produces: nothing new for later tasks. Stage C will add desk focus.

- [ ] **Step 1: Wire the mode.**
  - `const [workforce, setWorkforce] = useState(false)`.
  - The sidebar **Office** button becomes active when `!workforce` and closes the panel.
  - **AI Agents** becomes a `nav-item` button, active when `workforce`. It drops the `muted` class and the `LATER` chip, and moves under WORKSPACE.
  - Refactor `toggleEditing`'s leave branch into `requestLeaveEditing(then: () => void)`. Opening the workforce panel while editing calls it with `() => setWorkforce(true)`. Turning edit mode on calls `setWorkforce(false)`.
  - The scene card gets class `workforce` when it's on, and the panel renders in `editor-body` after `canvas-wrap`.
  - The scene title suffix is ` · AI agents`.
- [ ] **Step 2: Add notices and copy.**
  - Workforce `loadProblem` and `saveError` notices use the existing `.scene-notice` markup and the copy in Global Constraints. The load notice can be dismissed.
  - The Next milestone card reads `Agents in the 3D office`, with the text `Status markers at each desk, and desk-to-agent selection.`
  - The page subtitle stays the same.
- [ ] **Step 3: Type-check, test, build**
  Run: `npx tsc -b --noEmit && npm test && npm run build`
  Expected: all tests pass. The build succeeds with only the existing warning.
- [ ] **Step 4: Commit** with `feat(app): open the workforce panel from the sidebar`

---

### Task 5: Browser verification, screenshots and PR

**Files:**
- Create: `docs/screenshots/milestone-3a/stage-b-*.jpg`
- Modify: `tasks.md` (tick the Stage B boxes)

- [ ] **Step 1: Run the app** (`npm run dev`) and check in the browser, with the console free of errors:
  1. The first load shows six demo agents labelled Demo, and the Mock mode badge.
  2. The filters work, and both empty states show.
  3. Create an agent with a blank name to get the error, then a valid one. Edit it.
  4. Assign a free desk. The picker hides taken desks. Unassign it.
  5. Start a simulated task. Watch Thinking → Working → Completed, with the timeline showing Simulated chips.
  6. Simulate waiting, resume, simulate error, and cancel.
  7. Remove an agent that has history; the confirmation shows. Restore the demo agents.
  8. Reload mid-run; the task shows "Interrupted by page reload (simulated run)".
  9. While editing with unsaved changes, opening AI Agents shows the save/discard dialog. Entering edit mode closes the panel.
  10. Delete `desk-03` in edit mode and save; Atlas shows "Workstation unavailable". Reset the layout.
  11. Undo/redo, save, the floor plan and transforms still work.
  12. Write `{bad` into `ai-virtual-office:workforce:v1` and reload; the notice shows and the backup key holds `{bad`.
- [ ] **Step 2: Save the screenshots** (list, detail during a run, form error, unavailable desk) to `docs/screenshots/milestone-3a/`.
- [ ] **Step 3: Tick the Stage B boxes in `tasks.md`** except "PR". Commit with `docs: add stage B screenshots and tick tasks`.
- [ ] **Step 4: Push and open the PR to `main`** with the screenshots embedded, the check results, and the statement that execution is simulated.
