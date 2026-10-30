# Milestone 3B.1 — Real Agent Runtime Foundation: Tasks

**Spec:** [`plan.md`](plan.md) (Milestone 3B.1 brief). This file is my working task list for that spec.
**Status:** Draft, 2026-10-31. Waiting for your answers to Q1–Q5 at the end before Stage A starts.
**Earlier milestones:** [`milestone-3a-tasks.md`](docs/milestones/milestone-3a-tasks.md) ([report](docs/milestone-3a-report.md)), and [`milestone-2-tasks.md`](docs/milestones/milestone-2-tasks.md).

## What this milestone is

The app gets a small **local backend**. It owns agents, tasks and activity, runs tasks through a runtime provider, and pushes live updates to the browser.

- In this milestone the backend still runs the **mock** runtime. No Claude is called, and the UI and reports say so.
- What it does build:
  - the server and its API;
  - the event stream;
  - a fuller task lifecycle, including approvals and timeouts;
  - the security boundaries a real runtime will need.
- `ClaudeAgentRuntimeProvider` (Claude Agent SDK for TypeScript) is prepared as an empty, server-side boundary only.
- The browser-only mock mode from 3A keeps working unchanged, and stays the default.

## Current state (from inspecting the code, 2026-10-31)

- **Branch and checks:** `main` at #19.
  - `npm test`: 30 files, 311 tests pass.
  - `npm run build`: passes. Main chunk 1,312 kB, with the existing >500 kB warning.
  - `npm audit`: 0 vulnerabilities.
  - Node 24.14, npm 11.9.
- **No backend exists.** The app is a Vite SPA.
  - `vite.config.ts` has one dev-only plugin, `voAutoExit`, used by `/vo`.
  - Scripts: `dev`, `build`, `preview`, `test`.
  - `tsc -b` covers `tsconfig.app.json` (`src/`) and `tsconfig.node.json` (`vite.config.ts`, `scripts/*.ts`).
- **No Claude/Anthropic package is installed.**
- **Workforce code (`src/workforce/`, from 3A) is pure TypeScript, so it can be reused on a server:**
  - `types.ts`: `Agent`, `AgentTask`, `AgentActivity` (union by `type`).
    - Task statuses: `queued | running | waiting | completed | failed | cancelled`.
    - Agent statuses: `idle | thinking | working | waiting | error | completed`.
  - `operations.ts`: pure operations, plus `applyRuntimeEvent`, the single place runtime events change state.
  - `storage.ts`: strict parse with reference checks; `localStorage` key `ai-virtual-office:workforce:v1`, schema v1.
  - `runtime/types.ts`: `RuntimeProvider` with start, cancel, subscribe, availability and `executionId`, but no status or result query and no approvals. `MockRuntimeProvider` uses timers and works in Node too. `ClaudeRuntimeProvider` is a placeholder.
  - `controller.ts`: the `WorkforceController` interface the UI uses: `getSnapshot`, `subscribe` and actions. **A remote implementation can replace the local one without touching components.**
  - Components use only `useWorkforce()` and `view.ts`. Nothing in React touches a runtime directly.
- **The layout stays in the browser** (`ai-virtual-office:layout:v1`). Agents refer to desks by furniture ID.

### Existing issues to carry (recorded, not caused by this milestone)

- The 3A report's limitations list is still open: no task queue, unbounded task history, raw desk ids in text, notice overlap, and the misleading "was backed up" notice wording.
- The build warns about chunk size (three.js, no code-splitting).

## How I'll work

- **One stage = one branch = one PR into `main`**, as before. I stop for your review after each PR.
- **Logic first, in pure tested modules:** lifecycle, policy, config, event log. The HTTP layer and React stay thin.
- **Server tests:** Vitest in Node, starting the server on a random port with a temp data directory, and using real `fetch` and SSE parsing.
- **Each stage ends with** `npm test`, `npm run build`, and browser checks where the UI changes.
- **Minimal dependencies.** The server uses Node's built-in `http` (no Express). See Q4 for the one dev tool.

## Decisions I propose (for your OK)

1. **Backend shape.**
   - A `server/` folder in this repo: Node + TypeScript, `node:http`, a REST API for commands and queries, and SSE at `GET /api/events` for live updates.
   - It imports the shared, pure modules from `src/workforce/`, so there is one data model.
   - It is built to `dist-server/` with Vite's SSR build, so there is no new bundler.
   - It has its own `tsconfig.server.json` in `tsc -b`.
2. **Two runtime environments, chosen by config, never mixed silently.**
   - **Mock (browser)**, the default: `VITE_WORKFORCE_API_URL` is empty, and 3A's local controller and `localStorage` are used as today.
   - **Local backend**: `VITE_WORKFORCE_API_URL=http://127.0.0.1:8787`. The UI uses a `RemoteWorkforceController` with the same `WorkforceController` interface.
   - On the server, `RUNTIME=mock` (default) or `RUNTIME=claude`. Claude reports unavailable and refuses tasks with a clear message.
   - The panel shows an explicit indicator: **Mock · browser**, **Local backend · mock runtime**, or **Local backend · Claude (not available)**, plus the connection state.
   - If the backend is unreachable, the UI shows **Offline** and doesn't switch to browser mock on its own, so two sets of agents never mix (see Q2).
3. **Server persistence:**
   - one JSON file, `data/workforce.json` (gitignored, path from `DATA_DIR`);
   - written atomically (temp file plus rename), and validated with the existing strict parser on load;
   - an unreadable file is backed up and the server starts empty;
   - demo agents are seeded on the first start only.
   - Documented limits: one process, one writer, no history beyond the caps. No database, Redis, Docker or queue.
4. **Task lifecycle v2, shared by browser and server.**
   - Task statuses: `queued`, `starting`, `running`, `waiting_for_approval`, `completed`, `failed`, `cancelling`, `cancelled`.
   - Agent statuses are unchanged, mapped as follows:

     | Task status | Agent status |
     |---|---|
     | queued | idle |
     | starting | thinking |
     | running | thinking / working (from progress) |
     | waiting_for_approval | waiting |
     | cancelling | unchanged |
     | completed | completed |
     | failed | error |
     | cancelled | idle |

   - Still one active task per agent. The server also refuses a second start for a task that is already starting or running (no duplicate execution).
   - Tasks gain `timeoutMs`, `runtime` (`mock` | `claude`), `sessionId` and `endedReason` (`completed | failed | cancelled | timeout`).
   - **Storage moves to schema v2** under a new key, `ai-virtual-office:workforce:v2`. Saved v1 data is migrated once (`waiting` becomes `waiting_for_approval`), and the old v1 key is left untouched as a natural backup.
5. **Runtime contract v2 (server side):**
   - `start(task, context) → { executionId, sessionId? }`;
   - `events` (`started`, `progress`, `message`, `approval_requested`, `completed`, `failed`, `cancelled`);
   - `cancel(taskId)`;
   - `status(taskId)`;
   - `result(taskId)`;
   - `respondToApproval(taskId, approvalId, decision)`;
   - `dispose()`.
   - The **task manager** owns the lifecycle around the provider:
     - it moves a task from `starting` to `running`;
     - it enforces timeouts, ending the task as `failed`/timeout after `TASK_TIMEOUT_MS`;
     - it handles `cancelling` (ask the provider, wait a grace period, then force-stop and mark `cancelled`);
     - it caps output size.
   - The mock runtime gains a demo control to request approval, replacing "Simulate waiting", so the approval flow is testable without Claude.
6. **Events:**
   - **Envelope:** typed SSE events `task.queued`, `task.started`, `task.progress`, `agent.message`, `agent.status_changed`, `task.waiting_for_approval`, `task.completed`, `task.failed` and `task.cancelled`, plus `state.changed` for agent and desk edits.
   - **Ids:** a monotonically increasing `id`.
   - **Replay:** the server keeps the last 500 events and replays everything after `Last-Event-ID`.
   - **Recovery:**
     - on every connect, the client first loads `GET /api/state`, which returns the full snapshot and the `lastEventId`, then applies only newer events;
     - if the gap is too old, the server sends `state.reset` and the client reloads the snapshot;
     - so a reconnect never depends on transient events alone.
   - A heartbeat comment every 15 s.
7. **API (local, no user accounts):**
   - `GET /api/health`: runtime, availability, version, and `credentialsConfigured: boolean`. Never the value.
   - `GET /api/state` and `GET /api/events`.
   - Agents: `POST /api/agents`, `PATCH /api/agents/:id`, `DELETE /api/agents/:id`, `PUT /api/agents/:id/desk`.
   - Tasks: `POST /api/agents/:id/tasks` (title, description, optional `workspaceId`), `POST /api/tasks/:id/cancel`, `POST /api/tasks/:id/approval` (`{ approvalId, decision }`).
   - Mock-only demo controls under `/api/demo/*`, which return 404 unless `RUNTIME=mock`.
   - Request bodies are validated with the existing input validators, and errors are JSON with readable messages.
8. **Security foundation.** It is built and tested now, even though the mock doesn't need it yet, so the Claude provider plugs into it.
   - **Workspaces by id only.**
     - The server config lists named workspaces under one `WORKSPACE_ROOT`, for example `WORKSPACES=sandbox:projects/sandbox`.
     - The browser can only send a `workspaceId`; paths and commands from the browser are rejected outright.
     - `resolveWorkspace` rejects absolute paths, `..`, NUL bytes, and symlinks that escape the root (it checks the real path).
   - **Tools.** An explicit `ALLOWED_TOOLS` list, checked against a known catalogue. A pure `decideToolUse(tool, input, policy) → allow | deny | ask`:
     - tools that write or execute (shell, file writes, network fetch) are **always `ask`**, which means human approval;
     - anything not allowlisted is `deny`;
     - there is no bypass mode, and no `dangerously-skip-permissions` or equivalent.
   - **No process execution in this milestone.** A test fails if `child_process`, `exec(` or `spawn(` appears in `server/` or `src/`. The future Claude provider file will be the single, reviewed exception.
   - **Credentials:**
     - `ANTHROPIC_API_KEY` is read only by the server from the environment (`.env`, gitignored; `.env.example` lists the names only);
     - it never appears in responses, events, logs or the browser bundle;
     - a test checks that the built `dist/` doesn't contain it.
   - **Limits:** a task timeout (default 10 min), message and result size caps (default 32 KB per message, 256 KB per task, with a truncation marker), and safe termination via `AbortController` and a grace period.
   - **Audit log:** JSON Lines in `data/audit.log`, with time, action, task/agent ids, decision and reason. It records task start, cancel, timeout, approvals, denied tools and rejected paths or origins, and never secrets.
   - **Local exposure:**
     - the server binds `127.0.0.1` by default;
     - CORS allows only the configured frontend origin;
     - every state-changing request must come from an allowed `Origin` and use `Content-Type: application/json`, which blocks other local web pages from driving the API.
9. **Config** is a typed `server/config.ts` parsed from the environment and validated at start; the server refuses to start with a readable message on bad values. It covers:
   - `HOST`, `PORT` (8787), `ALLOWED_ORIGINS`;
   - `DATA_DIR`, `WORKSPACE_ROOT`, `WORKSPACES`;
   - `RUNTIME`, `TASK_TIMEOUT_MS`, `ALLOWED_TOOLS`;
   - output limits;
   - `ANTHROPIC_API_KEY`.
   - The frontend only gets `VITE_WORKFORCE_API_URL`. The same variables work for a later VPS setup, but deployment isn't built.
10. **`ClaudeAgentRuntimeProvider`** lives in `server/runtime/claudeAgent.ts`.
    - It implements contract v2 and reports `available: false`, with the reason "Claude Agent SDK not installed" or "credentials not configured".
    - It has a comment block on how the SDK's permission callback must call `decideToolUse`, and how workspaces and limits apply.
    - The SDK is not installed (see Q1).
11. **Frontend integration:**
    - `RemoteWorkforceController` uses `fetch` for commands and `EventSource` for events, with the snapshot-plus-replay recovery from decision 6.
    - New statuses and the approval request appear in the existing agent detail as **Approve** and **Deny**, which only show for a pending approval.
    - New status labels and marker colours, plus the indicator and connection state from decision 2.
    - The 3D markers, desks, layout editor and panel structure stay as they are.

## Stage A — Shared lifecycle v2 and storage migration (browser only, no server)

- [x] `TaskStatus` v2, new task fields, the agent-status mapping, and the new activity types (approval requested / decided, cancelling, timeout).
- [x] `applyRuntimeEvent` and the operations updated for v2: starting, cancelling, approvals, timeout end, and no duplicate start.
- [x] Storage schema v2, the `:v2` key, and a one-time v1 → v2 migration, with the v1 key kept. Also fix the "was backed up" notice wording (an open 3A minor).
- [x] The mock runtime: approval request demo control, plus Approve / Deny in the agent detail (still browser-only).
- [x] Tests (migration, mapping, every transition, duplicate start), a browser regression of 3A's checks, and a PR.

## Stage B — Backend service core (mock runtime)

- [ ] `server/` with `node:http`, a small router, JSON errors, typed `config.ts`, `.env.example`, `tsconfig.server.json`, and scripts `server` / `server:build` / `dev:full` (see Q3).
- [ ] JSON file store (atomic write, validation, backup, demo seed) and runtime contract v2 with the server-side mock provider.
- [ ] Task manager: queued → starting → running, timeouts, cancelling → cancelled with a grace period, output caps, and no duplicate execution.
- [ ] REST endpoints from decision 7, and SSE with ids, a 500-event replay buffer, `state.reset`, and a heartbeat.
- [ ] HTTP integration tests (state, commands, the full mock lifecycle, cancel, timeout, reconnect with `Last-Event-ID`) and a PR.

## Stage C — Security foundation

- [ ] Workspaces by id plus `resolveWorkspace` (traversal, absolute paths, symlink escape, NUL), with rejections audited.
- [ ] Tool catalogue plus `decideToolUse` (allow / deny / ask), with no bypass mode. Approvals go through the task manager (`waiting_for_approval`, approve / deny endpoint, and a timeout while waiting).
- [ ] Origin allowlist, JSON-only state changes, CORS, and binding to `127.0.0.1`. Credential handling (server env only, `credentialsConfigured` flag, tests that the bundle and responses carry no key).
- [ ] Structured audit log (JSON Lines) and a guard test against process execution and credential leaks.
- [ ] `ClaudeAgentRuntimeProvider` boundary (unavailable, documented integration points) and a PR.

## Stage D — Frontend integration

- [ ] `RemoteWorkforceController` (REST and SSE, snapshot plus replay recovery, reconnect with backoff, offline state) behind `useWorkforce`, chosen by `VITE_WORKFORCE_API_URL`.
- [ ] Runtime environment indicator and connection status in the panel. New lifecycle labels and marker colours. Approve / Deny wired to the API.
- [ ] Browser checks in both modes, including killing and restarting the server mid-run. Screenshots and a PR.

## Stage E — Verify, document, report

- [ ] All 10 checks in plan.md §9, actually run: backend alone, frontend ↔ backend, browser mock, state consistency, SSE reconnection, bad workspace paths, unauthorised commands and origins, cancellation and timeout, 3D office and editor regression, build and tests. Also `/vo`.
- [ ] README: architecture, how to run each mode, env variables, API and events, security boundaries, persistence limits.
- [ ] Final report (plan.md "Final report"), stating explicitly that the Claude Agent SDK is **not installed or integrated** (unless Q1 changes that) and that no real agent execution exists.
- [ ] PR

## Questions for you

- **Q1: Claude Agent SDK package.**
  - My recommendation is not to install `@anthropic-ai/claude-agent-sdk` in 3B.1. The provider stays a typed boundary that reports "not installed", and we add and test the SDK in the next phase, where it will actually run.
  - The other option is to install it now, but uncalled.
- **Q2: Where agents live in backend mode.**
  - My recommendation: the server's JSON file is the only source of truth, and it starts with its own demo agents. The browser's mock agents stay separate and aren't imported.
  - Alternatively I can add a one-time "Import agents from this browser" action.
- **Q3: Dev workflow and `/vo`.**
  - My recommendation:
    - `npm run dev` stays frontend-only (browser mock), so `/vo` is unchanged;
    - a new `npm run dev:full` starts the backend and the frontend in local backend mode;
    - `npm run server` starts the backend alone.
  - Alternatively `/vo` could start the backend too.
- **Q4: One dev dependency.** I'd add `tsx` (dev only) to run the TypeScript server in development with watch. The production server is built with Vite's SSR build, so there are no runtime dependencies. The alternative, without `tsx`, is a `tsc --watch` plus `node --watch` pair, which is slower and has more moving parts.
- **Q5: Local API protection.**
  - My recommendation for 3B.1: `127.0.0.1` binding, plus the `Origin` allowlist and JSON-only rule from decision 8, with no login, as the spec says.
  - Option: also require a random token created at server start and shown in the terminal. That would be stronger against other software on the same machine, but adds a setup step. I'd save it for the VPS milestone.
