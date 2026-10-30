# Milestone 3A — AI Agent Workforce UI and Mock Runtime: Tasks

**Spec:** [`milestone-3a-plan.md`](milestone-3a-plan.md) (Milestone 3A brief). This file is my working task list for that spec.
**Status:** Approved, 2026-10-30. Q1–Q4 answered (see "Decisions" at the end). Complete: all stages merged (#15–#19). See the [final report](../milestone-3a-report.md).
**Earlier milestones:** [`docs/milestones/milestone-2-tasks.md`](milestone-2-tasks.md) and [`milestone-2-plan.md`](milestone-2-plan.md).

## What this milestone is

The office gets a staff of **AI agents** you can manage. You can create agents, give them a desk, assign them a task, and watch a **simulated** run with status and an activity timeline. Agents show up at their desks in the 3D office. The runtime is a mock behind a clean interface, so a real Claude runtime can be plugged in later, on a server. Nothing in this milestone calls an LLM or runs processes, and the UI says so. The office layout, editor, 3D scene and `/vo` must keep working unchanged.

## Current state (from inspecting the code, 2026-10-26)

- **Branch and checks:** on `main` at #13. `npm test` passes: 22 files, 203 tests. `npm run build` passes.
- **App shell:** `src/App.tsx` is one page with no router.
  - The sidebar has **Office** (active) and a greyed-out **AI Agents · LATER** item, which is the natural entry point for this milestone.
  - The "Next milestone" card still says "Layout editor".
- **Layout model:** `src/layout/` (`types.ts`, `operations.ts`, `history.ts`, `storage.ts`)
  - `OfficeLayout` is schema v1, stored under `ai-virtual-office:layout:v1`, saved only when you click Save, with undo/redo history in `editorReducer`.
  - Furniture IDs are stable strings: `desk-01`…`desk-14` in the default office; new items get random IDs. A workstation is three separate items (desk, chair, monitor); the **desk** is the natural reference.
- **Selection:** clicking rooms and furniture in the scene only works in **edit mode**: pointer handlers are attached only when `editing` is on. Selection lives in the layout editor state.
- **Scene:** `src/scene/`
  - Renders on demand: `frameloop="demand"`.
  - Room labels are a DOM layer moved by `RoomLabelTracker` (no React re-renders), which is a good pattern for desk status markers.
  - The furniture footprint outline (`FootprintOutline`) can highlight a desk without changing its geometry.
- **Tests:** Vitest in a Node environment (no DOM). The existing code keeps logic in pure, tested modules, and components stay thin.
- **No agent code exists yet.**

### Pre-existing issues (recorded, not caused by this milestone)

- `npm run build` warns that the main chunk is over 500 kB (1,277 kB; mostly three.js).
- `npm audit`: 3 advisories, all in the **dev-only** test runner: Vitest's `@vitest/mocker` (moderate) and `tinypool` (2 critical). The fix is a major upgrade to Vitest 5 (see Q4).
- Deferred minors from earlier PRs, still open:
  - room rotation isn't shown in the room panel;
  - the old concrete floor material is unused;
  - one README line still says "polished concrete in open areas";
  - the stats overlay samples one frame late.

## How I'll work

- **One stage = one branch = one PR into `main`**, as before. You merge, then I delete the branch. I stop for your review after each PR. This follows your direction over plan.md's "do not stop after producing a plan".
- **Logic first, in pure tested modules** (the domain model, storage, and the runtime with fake timers); React components stay thin.
- **Each stage ends with** `npm test`, `npm run build`, the editor regression checklist (milestone 2), and browser checks of the new features, with screenshots in the PR.
- **No new runtime dependencies.** No backend.

## Decisions I propose (for your OK)

1. **Where it lives.** Clicking **AI Agents** in the sidebar opens a **Workforce panel beside the 3D office**, in the same scene card as edit mode's panels. That way the desks stay visible while you work with agents. Workforce mode and layout edit mode are separate modes; turning one on turns the other off (see Q1).
2. **Workstation = a desk's furniture ID.** Only `desk` items can be assigned, one agent per desk. The chair and monitor next to it aren't referenced.
3. **Separate storage.** Agents, tasks and activities are saved under their own key, `ai-virtual-office:workforce:v1`, with a schema version, validation and backup on bad data, like the layout. It never touches the layout's key.
4. **Agent changes save automatically**, instead of using the layout's Save button, and they are **not part of the layout's undo history** (see Q2).
5. **Missing desks.** If an agent's desk no longer exists in the current layout (deleted, or not in the default after Reset), the agent keeps the reference, shows "Workstation unavailable" and gets no marker. You can pick another desk. Nothing crashes, and nothing is deleted silently (see Q3).
6. **Demo agents.** Six demo agents are seeded **once**, only when no workforce data is saved yet: Project Management, Tech Lead, Backend, Frontend, QA and DevOps. Each sits at an existing default desk and is labelled **Demo**. Removing them doesn't bring them back on reload. There will be a "Restore demo agents" action.
7. **Statuses.**
   - Agent: `idle`, `working`, `thinking`, `waiting`, `error`, `completed`, as the spec requires.
   - Task: `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`.
   - One active task per agent. You can't start a second task while one is running; there is no queue.
8. **Mock runtime.**
   - `MockRuntimeProvider` runs timers in the browser. It steps a task through `thinking → working → completed` and writes activity events labelled *Simulated*.
   - Demo controls can force `waiting` and `error`.
   - Timers are cleaned up on unmount.
   - A task that was running when the page reloaded is marked `failed` with "Interrupted by page reload (simulated run)", so references stay consistent.
9. **Runtime boundary.**
   - A `RuntimeProvider` interface covers: start a task, a stream of task events, cancel, completion results, errors, and an execution or session ID.
   - `ClaudeRuntimeProvider` is a placeholder that only reports "not available: requires a server-side runtime". It has no API keys, no fetch, and no process execution.
10. **Status markers in 3D.** A small coloured status badge floats above each assigned desk: a DOM layer like the room labels, ignoring pointer events, and also shown in the floor plan. Selecting an agent highlights its desk with the existing outline and can focus the camera on it. In Workforce mode, clicking an assigned desk opens that agent.
11. **Activity history limit:** the most recent 300 events in total. Completed tasks are kept; there is no task-count limit in this milestone.

## Stage A — Domain model, storage and mock runtime (no UI)

- [x] Types in `src/workforce/types.ts`: `Agent`, `AgentTask`, `AgentActivity`, `AgentStatus`, `TaskStatus`, `RuntimeMode` (`mock` | `real`), `ActivitySource`. Use discriminated unions for activity events.
- [x] Pure operations in `src/workforce/operations.ts`: create, update, remove an agent; assign or unassign a desk (one agent per desk); assign a task, and block a second active task. Removing an agent cancels its active task.
- [x] Storage in `src/workforce/storage.ts`: separate versioned key, strict validation, backup of unreadable data, activity limit, reference checks (task ↔ agent, activity ↔ agent/task). Demo seed only when nothing is stored.
- [x] Runtime interface plus `MockRuntimeProvider` in `src/workforce/runtime/`: start, events, cancel, force waiting or error, complete; cleans up its timers; reload recovery.
- [x] `ClaudeRuntimeProvider` placeholder, with a comment block on the server-side-only rule (no credentials in the browser).
- [x] Tests for all of the above, using Vitest fake timers for the runtime.
- [x] PR

## Stage B — Workforce panel and task UI

- [x] The sidebar **AI Agents** item becomes active and opens the Workforce panel beside the 3D office. A visible **Mock mode** badge.
- [x] Agent list with department and status filters, and an empty state.
- [x] Create and edit an agent (name, role, department) with form validation. Remove with confirmation when the agent has an active task or history.
- [x] Desk picker listing free desks by room. Unassign. "Workstation unavailable" state.
- [x] Agent detail panel: current task, task form (title, description), start, cancel, demo controls (waiting / error), and an activity timeline with timestamps and *Simulated* labels.
- [x] "Restore demo agents" action. Update the "Next milestone" card.
- [x] PR with screenshots

## Stage C — Agents in the 3D office

- [x] Status markers above assigned desks in 3D and floor plan; they never take clicks.
- [x] Selecting an agent highlights its desk and offers "Focus" to move the camera to it.
- [x] In Workforce mode, clicking an assigned desk opens that agent; clicking a free desk offers to assign one.
- [x] Graceful handling of deleted desks, Reset layout, and unsaved layout changes. Edit mode, transforms, undo/redo, save, reset and floor-plan sync stay unchanged.
- [x] PR with screenshots

## Stage D — Verify, document, report

- [x] All 12 checks in plan.md Phase 9, run in the browser on the dev server and on `vite preview`, plus `/vo`.
- [x] Malformed workforce storage test in the browser: the app loads, shows a notice, and backs up the data.
- [x] README: Workforce section, mock-runtime disclaimer, storage keys, limitations.
- [x] Final report (plan.md "Final report"), including the explicit statement that execution is simulated.
- [x] PR

## Decisions (answered 2026-10-30)

- **Q1: Where the Workforce lives:** a panel beside the 3D office, opened from the sidebar's **AI Agents**. It can't be on at the same time as layout edit mode.
- **Q2: Saving agents:** saved automatically on every change, outside the layout's undo history.
- **Q3: Deleted desks:** the agent keeps the reference, flagged "Workstation unavailable".
- **Q4: Test-runner advisories:** upgrade Vitest to v5 in a small separate PR before Stage A.
- **Q5:** no changes requested; proposed decisions 1–11 stand.
