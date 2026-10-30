# Milestone 3A — AI Agent Workforce UI and Mock Runtime: Final Report

**Spec:** [`milestone-3a-plan.md`](milestones/milestone-3a-plan.md) · **Tasks:** [`milestone-3a-tasks.md`](milestones/milestone-3a-tasks.md) · **Date:** 2026-10-30

> **Runtime execution is simulated.** No real Claude, Claude Code or Agent SDK task execution has been implemented. The mock runtime steps a task through timed states in the browser and writes canned results that say "No AI was run". Nothing in this milestone calls an LLM, makes network requests, or launches processes. A test fails the build's test suite if `fetch(`, `child_process`, `XMLHttpRequest`, `new WebSocket`, `apiKey` or `ANTHROPIC_` appears in the non-test workforce code.

## Summary

The office now has a staff of AI agents you can manage. You can create agents, give each one a desk, assign a task, and watch a simulated run with live status and an activity timeline. Agents appear at their desks in the 3D office and the floor plan.

The milestone shipped as four pull requests, plus this report:

| PR | Stage | What |
|---|---|---|
| #15 | Pre-work | Vitest 4 → 5, which cleared the 3 dev-only `npm audit` advisories |
| #16 | A | Domain model, operations, storage, mock runtime, Claude placeholder (no UI) |
| #17 | B | Workforce panel: list, filters, create/edit/remove, desk picker, tasks, timeline |
| #18 | C | Status markers in 3D and floor plan, desk highlight, Focus desk, desk clicks, Assign view |
| this | D | Verification on dev and `vite preview`, `/vo`, README, this report |

The office layout, the editor, the 3D scene and `/vo` work as before.

## Files changed

The new code lives in `src/workforce/`, about 2,150 lines, roughly half of them tests. Changes to existing files are small and additive.

| File | Responsibility |
|---|---|
| `src/workforce/types.ts` | `Agent`, `AgentTask`, `AgentActivity` (a discriminated union by `type`), status unions, `RuntimeMode`, schema version, activity limit |
| `src/workforce/operations.ts` | Pure operations: create/update/remove agent, assign desk, assign/cancel task, `applyRuntimeEvent`, reload recovery, input validation |
| `src/workforce/demo.ts` | The six demo agents, the one-time seed, `restoreDemoAgents` |
| `src/workforce/storage.ts` | Versioned serialize/parse with reference checks, load with backup, save with backup |
| `src/workforce/runtime/types.ts` | `RuntimeProvider` interface, `RuntimeEvent`, demo controls |
| `src/workforce/runtime/mockRuntime.ts` | `MockRuntimeProvider`: timer-driven simulated runs |
| `src/workforce/runtime/claudeRuntime.ts` | `ClaudeRuntimeProvider` placeholder (always unavailable), with the server-side rule |
| `src/workforce/controller.ts` | Non-React state owner: one commit path for actions and runtime events, autosave |
| `src/workforce/useWorkforce.ts` | React hook around the controller (`useSyncExternalStore`, StrictMode-safe) |
| `src/workforce/view.ts` | Pure UI helpers: filters, desk options and status, markers, timeline, removal prompt, labels |
| `src/workforce/ui/*` | `WorkforcePanel`, `AgentList`, `AgentForm`, `AgentDetail`, `AssignDesk` |
| `src/scene/DeskMarkers.tsx` | DOM marker layer plus a per-frame tracker, like the room labels |
| `src/scene/{labels,highlight,camera}.ts` | `markerAnchor`, agent and desk-hover outline, `focusPose` |
| `src/scene/{FurnitureItem,OfficeScene}.tsx` | Optional props for markers, desk highlight, desk clicks and camera focus |
| `src/App.tsx` | Sidebar **AI Agents**, mode switching with edit mode, notices, panel view and focus state |
| `src/styles.css` | Panel and marker styles |
| `vite.config.ts` | `fsModuleCache: false`, because Vitest 5's on-disk cache kept `import.meta.glob` lists stale in the source-scanning tests |
| `README.md`, `tasks.md`, `docs/…` | Docs, plans, screenshots, this report |

## Architecture and data model

- **One immutable `WorkforceState`** holds `{ schemaVersion: 1, agents, tasks, activities }`. Every operation is a pure function that returns a new state, or the same reference when nothing changed.
- **Agent:** stable id, name, role, department (the layout's departments except Meeting), `deskId` (a desk's furniture id, or null), status, `currentTaskId` (the latest task), `runtimeMode` (`mock` | `real`), `demo` flag, timestamps.
  - Statuses: `idle`, `working`, `thinking`, `waiting`, `error`, `completed`.
- **Task:** stable id, agent id, title, description, status, timestamps (created, started, completed), result summary or error message, execution id.
  - Statuses: `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`.
- **Activity:** stable id, agent id, optional task id, `type`, message, timestamp, `source` (`mock` | `real`).
- **Rules:**
  - one agent per desk;
  - one active task (queued, running or waiting) per agent, with no queue;
  - removing an agent removes its tasks and activities and cancels its run.
- **The runtime boundary.** A `RuntimeProvider` can start a task, cancel it, report events (started, progress, waiting, completed, failed, cancelled), say whether it is available, and give an execution id. Providers only emit events.
  - `applyRuntimeEvent` is the single place events change state. Events for a missing or finished task are ignored, so late timers can't resurrect anything.
  - `MockRuntimeProvider` is the browser simulation: thinking 2 s, working 4 s, then completed, plus demo controls.
  - `ClaudeRuntimeProvider` only reports "Not available: requires a server-side runtime."
- **State ownership.** A non-React `WorkforceController` holds the current state. User actions and runtime events both commit through it, so neither overwrites the other. Each change is saved, and React reads the state through `useSyncExternalStore`.
- **The 3D scene never imports workforce types.** It receives plain `DeskMarker` data and optional callbacks. Markers are a DOM layer moved every frame, never take pointer events, and don't change any geometry.

## UI features

- **AI Agents** in the sidebar opens a Workforce panel beside the 3D office, with a **Mock mode** badge. Layout editing and the panel are mutually exclusive. Opening the panel with unsaved layout edits goes through the existing save / discard / keep-editing dialog.
- **Agent list:**
  - department and status filters;
  - empty states ("No agents yet…" and "No agents match these filters.");
  - **Demo**, desk and **Desk unavailable** chips;
  - **New agent** and **Restore demo agents**.
- **Create and edit:** name (up to 40 characters), role (up to 60) and department, with readable validation errors.
- **Remove:** removal asks for confirmation only when the agent has an active task or task history.
- **Desk picker:** free desks grouped by room, plus **No desk**. A desk missing from the layout shows **Workstation unavailable — desk-NN is no longer in the layout. Pick another desk.**
- **Agent detail:**
  - status;
  - current task card with start and end times and the result or error, labelled "Simulated run";
  - a task form;
  - **Cancel task**, plus demo buttons for **Simulate waiting**, **Resume** and **Simulate error**;
  - **Focus desk**;
  - an activity timeline with timestamps and **Simulated** labels on task events.
- **In the office:**
  - a status marker (colour plus name) above each assigned desk, in 3D and in the floor plan;
  - the selected agent's desk outlined in purple, with its marker ringed;
  - **Focus desk** moves the camera in 3D or pans in the floor plan, and **Reset view** returns to the overview;
  - with the panel open, clicking a desk opens its agent, and clicking a free desk opens **Assign Desk NN**. A press that moves more than 4 px is treated as orbiting, not a click.
- **Notices:** saved agents that can't be loaded (corrupt, or from a newer version), storage unavailable, or a save that failed.

## Persistence behaviour

- **Agent data:**
  - key `ai-virtual-office:workforce:v1`, saved automatically on every change, outside the layout's undo history;
  - the layout key `ai-virtual-office:layout:v1` is never read or written by workforce code;
  - loading never writes, so an untouched demo seed isn't saved until something changes.
- **Demo seed:** added only when no agent data is stored at all. Removing the demo agents doesn't bring them back on reload.
- **Validation:** strict. Any invalid record, duplicate id, broken reference, shared desk, or second active task rejects the whole stored value.
- **Recovery:** unreadable or newer-version data is copied to `ai-virtual-office:workforce:v1:backup` on load (if no backup exists yet), and the panel starts empty with a notice. A save also backs up an unreadable stored value first, and refuses to write if that backup fails.
- **Limits:** the newest 300 activity events are kept; tasks are not trimmed.
- **Reload:** running or waiting tasks become `failed` with "Interrupted by page reload (simulated run)". A queued task stays queued.
- **Deleted desks:** the agent keeps the desk reference and shows "Workstation unavailable", with no marker, until another desk is chosen. Reset layout restores default desk ids, so agents get their desks back.

## Tests and build

All of these were run on the merged `main` (`8b64a59`):

| Command | Result |
|---|---|
| `npm test` | **30 files, 311 tests passed** (203 before the milestone) |
| `npx tsc -b --noEmit` | No errors |
| `npm run build` | Passed. Main chunk 1,312.25 kB (gzip 370.97 kB); the only warning is the existing one about chunks over 500 kB |
| `npm audit` / `npm audit --omit=dev` | 0 vulnerabilities (3 dev-only advisories before #15) |

The workforce tests cover:
- operations and validation;
- every runtime event transition, including ignored late events;
- storage round-trips, every reference check, corrupt and newer data, backups, a quota error on save, and the activity cap;
- mock runtime timing with fake timers, cancel, waiting/resume, error, duplicate start, dispose and listener isolation;
- the controller: autosave, a stable snapshot, an event between two actions, a refused start, cancelling a task the runtime has lost, dispose without saving;
- the view helpers;
- end-to-end mock runs;
- the guard against network, process and credential calls.

## Verification (plan.md Phase 9)

Each check was run in Chrome against the merged `main`. Results are from that session, not inferred. Browser storage was empty before the run and was cleared afterwards. Real mouse clicks and drags were used for desk clicks and editor dragging; panel controls were driven by page scripts.

| # | Check | Dev server `127.0.0.1:5173` | `vite preview` `127.0.0.1:4173` |
|---|---|---|---|
| 1 | Application builds | `npm run build` passed | Served the fresh build |
| 2 | Layout editor works | Select, rotate, undo, redo, save; and in the Stage C pass, a click selects and a drag moves furniture with snap | Rotate, undo, redo, save |
| 3 | Agent create, edit, remove, desk assignment | Blank-name error; created Quill; edited the role; taken desks hidden; assigned Desk 04; removed Relay (no prompt) and Quill (prompt: "This deletes Quill and its task history."); restored the demo agents | Created Quill, assigned Desk 12 |
| 4 | Selection maps to the right workstation | Selected marker = Quill; stored `deskId` = `desk-04`; Focus desk centres that desk; a real click on Quill's desk opened Quill, and on Atlas's desk opened Atlas | — |
| 5 | Task creation and mock run | Thinking → Working → Completed, with the simulated result text; marker turned "working" | Thinking → Completed |
| 6 | Completion and error states consistent | Waiting: agent, task chip and marker all "waiting". Error: agent Error, task Failed, "Simulated error (demo control).", marker "error", stored agent/task consistent. Cancel: Idle / Cancelled | Error state and marker |
| 7 | Activity recorded | Stored order created → updated → desk-assigned → assigned → started → progress ×2 → completed → … → failed → … → cancelled; timeline newest first, simulated events labelled | — |
| 8 | Data survives a refresh | Layout "Saved" with the saved rotation; 7 markers; Quill on Desk 04 with the Cancelled task and 18 timeline entries | Layout rotation and Quill's tasks (completed, failed) survived |
| 9 | Malformed data doesn't crash | Corrupt layout and agent data: app loads, both notices show, agent backup written on load, layout backup written on the next save | Corrupt agent data: notice, backup `{bad`, app usable |
| 10 | Deleted desks | Deleted `desk-04` in the editor and saved: no marker, "Desk unavailable" chip, warning, Focus disabled, stored `deskId` kept; Reset layout brought the marker back | Also seen on real data via `/vo` (below) |
| 11 | Layout save, reload, undo, redo, reset | Saved rotation survived the reload; Reset → Unsaved, Undo → Saved, Redo → Unsaved, Save → default restored | Save, undo, redo |
| 12 | `/vo` still works | `scripts/vo.sh <session id>` started the server (HTTP 200), opened `http://localhost:5173/sessionID=<id>`; the app, panel, Mock badge and markers loaded; nothing was written to storage | — |

The console showed no errors or warnings in either environment. On `vite preview` it logged nothing at all.

On `/vo`, your own saved layout at `localhost:5173` has no `desk-07`. Forge correctly showed "Desk unavailable" with no marker, and the other five agents had markers.

## Known limitations

- **No real execution.** The runtime is a mock. `ClaudeRuntimeProvider` is a placeholder, and a real runtime must be server-side.
- **Storage scope:** agent data is per browser and per origin (`localhost` and `127.0.0.1` are separate), with no export or sync.
- **Tasks:** one task per agent, with no queue. Finished tasks are never trimmed, so stored data grows slowly. A task queued at the exact moment the page closes stays queued after a reload until it is cancelled.
- **Event order:** runtime events are not checked for order. For example, a second `started` resets the start time. The mock never sends one.
- **Floor plan outline:** the default room label sits over the centre-row desks and can hide the selected desk outline. The marker ring still shows which desk it is.
- **Accessibility:** desk clicks have no keyboard equivalent (the panel's desk picker covers it), and Focus desk isn't announced.
- **Clicks through walls:** in 3D, clicking a wall or glass in front of a desk opens that desk's agent.
- **Backups:** a backup is written only when none exists yet, the same as layout storage. A second, newer corruption isn't copied, but its notice still says the data "was backed up".
- **Minor UI points, carried over from the stage reviews:**
  - three or more notices overlap;
  - activity text shows raw desk ids ("desk-05");
  - older task results drop out of the 20-entry timeline;
  - the agent count shows in the collapsed narrow sidebar;
  - the panel can reopen an old agent or desk view if that id returns;
  - entering edit mode drops a half-filled agent form;
  - the canvas redraws once per agent change while the panel is open.
- **Bundle size:** the main bundle is 1.31 MB (three.js), not code-split.

## Scope boundaries respected

None of the following were built: Claude API or Agent SDK execution, shell execution, deployment, authentication, a database or job queue, multi-agent orchestration, and video features. No new runtime dependencies were added.
