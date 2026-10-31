# Milestone 3B.1 — Real Agent Runtime Foundation: Final Report

**Brief:** [`milestone-3b1-plan.md`](milestones/milestone-3b1-plan.md) · **Tasks:** [`milestone-3b1-tasks.md`](milestones/milestone-3b1-tasks.md) · **Date:** 2026-10-31

> **The Claude Agent SDK is not installed or integrated, and no real agent execution exists.** The backend runs the mock runtime only: it steps a task through timed states and writes canned results that say "No AI was run". `RUNTIME=claude` starts a provider that reports "Claude Agent SDK not installed" and refuses tasks. Workspace and tool checks are policy checks, not an OS sandbox.

## Summary

The app now has a small local backend. It owns agents, tasks and activity, runs tasks through a runtime provider, and pushes live updates to the browser. The browser-only mock from 3A still works unchanged and is still the default.

| PR | Stage | What |
|---|---|---|
| #21 | A | Lifecycle v2 (starting, waiting for approval, cancelling), runtime provider contract |
| #22 | B | Backend core: store, event log, task manager, REST and SSE, mock runtime only |
| #23 | C | Security foundation: guards, workspaces, tool policy, audit log, redaction, secret scan |
| #24 | D | `RemoteWorkforceController`, runtime badge, connection status, approvals over the API |
| this | E | Verification, README, this report |

## Architecture

- **Shared model** in `src/workforce/` (types, pure operations, storage, wire types in `api.ts`), reused by the server. The server bundle imports only `node:` modules.
- **Server** (`server/`, `node:http`, no framework, no child processes): `WorkforceStore` (atomic JSON, restart recovery), `deriveEvents` (state diff to typed events), `EventLog` (ids `<boot>:<seq>`, 500-event buffer), `TaskManager` (timers, duplicate guard, cancel grace, approval timeout, output caps, tool policy), router with guards, SSE endpoint, audit log.
- **Frontend:** `WorkforceController` has two implementations behind `useWorkforce`. `RemoteWorkforceController` is made of `client.ts` (fetch wrapper), `sync.ts` (snapshot, stream, cursor, resync, backoff, dispose) and `commands.ts` (one REST call per action). `source.ts` picks the controller from `VITE_WORKFORCE_API_URL`.
- **Runtime boundary:** `ServerRuntimeProvider`; `MockRuntimeProvider` runs; `ClaudeAgentRuntimeProvider` is a documented, unavailable boundary.

## Files

About 92 files changed since 3A (`+7,897 / −247` in `server/`, `scripts/` and `src/`, roughly half tests). New: everything under `server/` (including `http/`, `runtime/`), `scripts/devFull.ts`, `scripts/secretScan.ts`, `scripts/checkSecrets.ts`, `src/workforce/remote/*`, `src/workforce/source.ts`, `src/workforce/ui/useBusy.ts`, `src/vite-env.d.ts`. Modified: the workforce model and controller, `view.ts`, the panel components, `App.tsx`, `styles.css`, `package.json`, `.env.example`, `README.md`.

## API and events

Endpoints, event types, ids and the recovery contract are listed in the README ("Backend"). Summary: `GET /api/health|state|workspaces|events`; `POST /api/agents`, `PATCH|DELETE /api/agents/:id`, `PUT /api/agents/:id/desk`, `POST /api/agents/:id/tasks`, `POST /api/tasks/:id/cancel|approval`; mock-only `POST /api/demo/...`. Events: `task.queued`, `task.started`, `agent.status_changed`, `agent.message`, `task.progress`, `task.waiting_for_approval`, `task.completed`, `task.failed`, `task.cancelled`, `state.changed`, `state.reset`.

## Security boundaries

Loopback binding; Host (421) and Origin (403) allowlists; JSON-only mutations (415); CORS only for allowed origins; workspaces by id with symlink-aware path checks that refuse `..`; tool policy where write, execute and network tools always need a human approval showing the whole action, with no bypass mode; secret redaction on every output path; audit log without bodies; `check:secrets` on the bundles. No login or token yet (planned for the VPS milestone). The browser never holds credentials.

## Persistence

`data/workforce.json`, atomic writes, mode 0600, backup of an unreadable file, demo agents seeded once. Tasks running at shutdown become failed with "Interrupted by a server restart". Events are in memory only. `data/audit.log` rotates at 5 MB.

## Verification (plan §9), actually run on 2026-10-31

| # | Check | Result |
|---|---|---|
| 1 | Backend starts independently | `npm run server` and a scripted run: `GET /api/health` 200, runtime `mock`, persistence and audit ok. File modes 600 |
| 2 | Frontend connects to backend | Browser, Stage D: badge `Local backend · mock runtime`, pill `Live`, `GET /api/state` then the event stream |
| 3 | Mock runtime still works | Browser mock: Running → Waiting for approval → Approve → Completed; backend mock the same |
| 4 | State consistent | Create agent, task, approval, cancel, restart: UI and server agree; no duplicated activity entries after a restart |
| 5 | SSE and reconnection | Replay from the boot start returned 11 events; an old boot id gets `state.reset` first; browser went Offline then Live after a server restart |
| 6 | Invalid workspace paths | Unknown workspace id 422; `../x` 400 |
| 7 | Unauthorised requests | Bad Origin 403; no Content-Type 415; bad Host 421; unknown field 400; wrong approval id 409 |
| 8 | Cancellation and timeout | Cancel: running → cancelled. `TASK_TIMEOUT_MS=1500`: failed "Timed out after 2 s". Deny: failed "Approval denied (simulated)". Restart: failed "Interrupted by a server restart" |
| 9 | 3D office and editor | Via `/vo`: canvas renders, Edit layout, floor plan and AI Agents open, console clean |
| 10 | Build and tests | 720 tests pass (58 files); `tsc -b` clean; `npm run build`, `server:build`, `check:secrets` (12 files) pass; `npm audit` 0 vulnerabilities |

Notes: a first scripted run printed a 400 for the deny call because of a glitch in my script; the re-run returned 200 and the task failed as expected. Not run end to end in the browser: Deny and Cancel against the backend, a second tab, and `npm run dev:full` itself (the unit tests cover the logic; Stage D used separate server and UI panes). The build still warns about the 500 kB main chunk (three.js).

## Deferred minors from the reviews

- Stage C: workspace compared against the root's real path at call time; redaction misses URL credentials and some token formats; the suppressed-count audit record is written in the next window; Write and Edit don't require a workspace; `file.txt/x` accepted; guard tests are text scans.
- Stage D: no runtime badge while loading; "Reconnecting…" on a first connect; some copy outside the plan; shared action error not cleared on task change; buttons re-enable before the event arrives; desk select has no busy guard; reset streak resets only on a change event; possible ghost agent; no timeout on the snapshot request; `saveError` and `loadProblem` refresh only on resync; "Start simulated task" wording under `RUNTIME=claude`.

## Remaining work before real Claude execution

1. Install and integrate the Claude Agent SDK behind `ClaudeAgentRuntimeProvider`, following the rules in its header (permission callback, `cwd` from the server, no auto-approve for write, execute or network tools, no settings files or hooks). Check the SDK option names against the installed version.
2. An OS-level sandbox for any real write or command execution, since the current checks are policy only.
3. A startup token or login before leaving the local machine, then the VPS milestone.
4. The deferred minors above, starting with the Stage C path and redaction items.
