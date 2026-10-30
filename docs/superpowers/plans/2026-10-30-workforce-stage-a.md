# Workforce Stage A: Domain Model, Storage and Mock Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested, UI-free workforce core: typed agents, tasks and activities, pure operations, versioned storage with a one-time demo seed, a timer-driven `MockRuntimeProvider`, and a `ClaudeRuntimeProvider` placeholder.

**Architecture:**
- Everything lives in `src/workforce/`. It is pure TypeScript like `src/layout/`, and it never imports React or three.
- State is one immutable `WorkforceState` value. Each operation returns a new state, or the **same reference** when nothing changed.
- A runtime provider only emits `RuntimeEvent`s. The only thing that turns those events into task, agent and activity changes is `applyRuntimeEvent`. So stale or late events are ignored in one place.
- Storage mirrors `src/layout/storage.ts`, under its own key.

**Tech Stack:** TypeScript 5.7, Vitest 5 (Node environment, fake timers). No new dependencies.

**Spec:** `plan.md` (Phases 2, 5, 6, 7) and `tasks.md` (decisions 1–11, Stage A, and the Q1–Q5 answers).

## Global Constraints

- No React, DOM, `fetch`, `child_process` or LLM calls anywhere in `src/workforce/`. No new dependencies.
- Agent statuses are exactly `idle`, `working`, `thinking`, `waiting`, `error`, `completed`. Task statuses are exactly `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`. Runtime modes are `mock` | `real`.
- One active task per agent (`queued`/`running`/`waiting`). No queue, no concurrency.
- One agent per desk. Only a furniture ID is stored as `deskId`. A desk missing from the layout is **kept**, not deleted (Q3).
- Storage key `ai-virtual-office:workforce:v1`, backup key `ai-virtual-office:workforce:v1:backup`. The layout key `ai-virtual-office:layout:v1` is never read or written.
- Activity history is capped at the **300** most recent events. Tasks are not capped.
- Demo agents are seeded only when nothing is stored. They have `demo: true`, and their activities are `source: 'mock'`.
- Reload recovery text, exactly: `Interrupted by page reload (simulated run)`.
- Claude placeholder text, exactly: `Not available: requires a server-side runtime.`
- Timestamps are ISO strings. Every operation that writes a time takes `now: string`, so tests are deterministic.
- IDs come from `createId(prefix, taken)` in `src/layout/operations.ts`, with the prefixes `agent`, `task`, `activity` and `exec`.
- Code style follows `src/layout/`: one-line types, terse doc comments only where the reason isn't obvious, no semicolons, and single quotes.

## Review Focus

1. **A late runtime event arrives after the agent was removed or the task was cancelled.** It must be ignored, returning the same state, and never resurrect the task or the agent (Task 2 test).
2. **Stored workforce JSON is corrupt or from a newer version.** The app falls back to an empty workforce with a `problem`. The raw text is copied to the backup key once, and a second load doesn't overwrite that backup (Task 3 test).
3. **`localStorage.setItem` throws (quota or private mode).** `saveWorkforce` returns `{ ok: false, error }` and doesn't throw (Task 3 test).
4. **The user calls start twice, or cancels or forces an error on a finished task.** Each is a no-op with no duplicate timers or events (Task 4 test).
5. **A name or title is only whitespace, or too long.** It is rejected with a readable error, and valid names are stored trimmed (Task 1 and Task 2 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/workforce/types.ts` | Domain types, status unions, schema version |
| `src/workforce/operations.ts` | Pure agent and task operations, input validation, activity cap, `applyRuntimeEvent`, reload recovery |
| `src/workforce/demo.ts` | The six demo agents, `createDemoWorkforce`, `restoreDemoAgents` |
| `src/workforce/storage.ts` | Serialize, strict parse with reference checks, load, save, backup |
| `src/workforce/runtime/types.ts` | `RuntimeEvent`, `RuntimeProvider`, `MockDemoControls` |
| `src/workforce/runtime/mockRuntime.ts` | `MockRuntimeProvider` (timers) |
| `src/workforce/runtime/claudeRuntime.ts` | `ClaudeRuntimeProvider` placeholder |

Each `.ts` file except the two type files gets a `*.test.ts` next to it.

---

### Task 1: Types and agent operations

**Files:**
- Create: `src/workforce/types.ts`, `src/workforce/operations.ts`
- Test: `src/workforce/operations.test.ts`

**Interfaces:**
- Consumes: `createId` from `src/layout/operations.ts`, `DepartmentId` from `src/layout/types.ts`, and `DEPARTMENTS` from `src/layout/catalog.ts`.
- Produces (`types.ts`):
  ```ts
  export const WORKFORCE_SCHEMA_VERSION = 1
  export const ACTIVITY_LIMIT = 300
  export type AgentStatus = 'idle' | 'working' | 'thinking' | 'waiting' | 'error' | 'completed'
  export type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  export type RuntimeMode = 'mock' | 'real'
  export type ActivitySource = 'mock' | 'real'
  export type AgentDepartment = Exclude<DepartmentId, 'meeting'>
  /** currentTaskId points at the agent's latest task (active or finished), or null when it has none. */
  export type Agent = { id: string; name: string; role: string; department: AgentDepartment; deskId: string | null; status: AgentStatus; currentTaskId: string | null; runtimeMode: RuntimeMode; demo: boolean; createdAt: string; lastActivityAt: string | null }
  export type AgentTask = { id: string; agentId: string; title: string; description: string; status: TaskStatus; createdAt: string; startedAt: string | null; completedAt: string | null; resultSummary: string | null; errorMessage: string | null; executionId: string | null }
  type ActivityBase = { id: string; agentId: string; taskId: string | null; message: string; timestamp: string; source: ActivitySource }
  export type AgentActivity = ActivityBase & (
    | { type: 'agent-created' } | { type: 'agent-updated' }
    | { type: 'desk-assigned'; deskId: string } | { type: 'desk-unassigned' }
    | { type: 'task-assigned' } | { type: 'task-started' } | { type: 'task-progress'; step: 'thinking' | 'working' }
    | { type: 'task-waiting' } | { type: 'task-completed' } | { type: 'task-failed' } | { type: 'task-cancelled' })
  export type ActivityType = AgentActivity['type']
  export type WorkforceState = { schemaVersion: typeof WORKFORCE_SCHEMA_VERSION; agents: Agent[]; tasks: AgentTask[]; activities: AgentActivity[] }
  ```
- Produces (`operations.ts`):
  ```ts
  export type AgentInput = { name: string; role: string; department: AgentDepartment }
  export type OpResult<T = {}> = ({ ok: true; state: WorkforceState } & T) | { ok: false; error: string }
  export const NAME_MAX = 40, ROLE_MAX = 60
  export function emptyWorkforce(): WorkforceState
  export function validateAgentInput(input: AgentInput): string | null      // null = valid
  export function createAgent(s: WorkforceState, input: AgentInput, now: string, opts?: { runtimeMode?: RuntimeMode }): OpResult<{ id: string }>
  export function updateAgent(s: WorkforceState, id: string, patch: Partial<AgentInput>, now: string): OpResult
  export function removeAgent(s: WorkforceState, id: string): { state: WorkforceState; cancelledTaskId: string | null }
  export function assignDesk(s: WorkforceState, agentId: string, deskId: string | null, now: string): OpResult
  export function agentAtDesk(s: WorkforceState, deskId: string): Agent | undefined
  export function addActivity(s: WorkforceState, entry: Omit<AgentActivity, 'id'>): WorkforceState   // assigns id, caps at ACTIVITY_LIMIT, sets agent.lastActivityAt
  export function isActiveTask(t: AgentTask): boolean
  ```
  Validation error copy: `Name is required.`, `Name must be 40 characters or fewer.`, `Role is required.`, `Role must be 60 characters or fewer.`, `Choose a department.`, `Agent not found.`, and `That desk is already assigned to <name>.`

- [ ] **Step 1: Write the failing tests** in `src/workforce/operations.test.ts`, using `const NOW = '2026-10-30T09:00:00.000Z'`:
  - `createAgent trims and stores a new idle agent`: input `{ name: '  Nova ', role: ' Planner ', department: 'project-management' }`, then `ok`, `agents[0]` matches `{ name: 'Nova', role: 'Planner', status: 'idle', deskId: null, currentTaskId: null, runtimeMode: 'mock', demo: false, createdAt: NOW }`, and one activity `{ type: 'agent-created', agentId: id, source: 'mock' }`.
  - `rejects whitespace-only and over-long names`: `'   '` returns `{ ok: false, error: 'Name is required.' }`, and `'x'.repeat(41)` returns `'Name must be 40 characters or fewer.'`. The role and department (`'meeting'`) cases are the same.
  - `updateAgent changes fields and logs agent-updated`. An unknown id gives `'Agent not found.'`, and a patch that changes nothing returns `ok` with the **same state reference** and no new activity.
  - `assignDesk enforces one agent per desk`: A takes `desk-03`, then B taking `desk-03` gives the error `That desk is already assigned to A.` (using A's name). Re-assigning A to `desk-03` returns the same state, and `null` logs `desk-unassigned`.
  - `removeAgent drops the agent with its tasks and activities and reports the active task`: build a state literal with one `running` task for the agent, then `cancelledTaskId` equals that task id, and no task or activity with that `agentId` remains. An unknown id returns the same state and `null`.
  - `addActivity keeps only the newest 300`: add 305 activities, then `length === 300`, the first remaining message is #6, and `agent.lastActivityAt` equals the last timestamp.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `npx vitest run src/workforce/operations.test.ts`
  Expected: FAIL, because the module can't be found.

- [ ] **Step 3: Implement `types.ts` and the operations above.** Use `sameFields`-style no-op detection like `src/layout/operations.ts`. The activity message for `agent-created` is `Agent "<name>" created`, and for demo agents it is set in Task 3.

- [ ] **Step 4: Run them and confirm they pass**
  Run: `npx vitest run src/workforce/operations.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/workforce/types.ts src/workforce/operations.ts src/workforce/operations.test.ts
  git commit -m "feat(workforce): add agent domain types and operations"
  ```

---

### Task 2: Task operations and runtime events

**Files:**
- Create: `src/workforce/runtime/types.ts`
- Modify: `src/workforce/operations.ts`
- Test: `src/workforce/operations.test.ts` (new `describe` blocks)

**Interfaces:**
- Consumes: Task 1.
- Produces (`runtime/types.ts`):
  ```ts
  export type RuntimeEvent =
    | { type: 'started'; taskId: string; executionId: string }
    | { type: 'progress'; taskId: string; step: 'thinking' | 'working'; message: string }
    | { type: 'waiting'; taskId: string; message: string }
    | { type: 'completed'; taskId: string; summary: string }
    | { type: 'failed'; taskId: string; error: string }
    | { type: 'cancelled'; taskId: string }
  export type StartResult = { ok: true; executionId: string } | { ok: false; error: string }
  export type RuntimeAvailability = { available: true } | { available: false; reason: string }
  /** Execution boundary. A real provider must run server-side; the browser only ever sees these events. */
  export interface RuntimeProvider {
    readonly mode: RuntimeMode
    readonly availability: RuntimeAvailability
    start(task: AgentTask, agent: Agent): StartResult
    cancel(taskId: string): void
    subscribe(listener: (event: RuntimeEvent) => void): () => void
    dispose(): void
  }
  export interface MockDemoControls { forceWaiting(taskId: string): void; resume(taskId: string): void; forceError(taskId: string, message?: string): void }
  ```
- Produces (`operations.ts`):
  ```ts
  export type TaskInput = { title: string; description: string }
  export const TITLE_MAX = 80, DESCRIPTION_MAX = 1000
  export const INTERRUPTED_MESSAGE = 'Interrupted by page reload (simulated run)'
  export function validateTaskInput(input: TaskInput): string | null
  export function assignTask(s: WorkforceState, agentId: string, input: TaskInput, now: string): OpResult<{ taskId: string }>
  export function activeTaskFor(s: WorkforceState, agentId: string): AgentTask | undefined
  export function applyRuntimeEvent(s: WorkforceState, event: RuntimeEvent, now: string, source: ActivitySource): WorkforceState
  export function recoverInterruptedTasks(s: WorkforceState, now: string): WorkforceState
  ```
  Error copy: `Title is required.`, `Title must be 80 characters or fewer.`, `Description must be 1000 characters or fewer.`, and `<name> already has an active task.`

  `applyRuntimeEvent` transitions. An event whose task is missing or not active is ignored and returns the same state.

  | Event | Task | Agent status | Activity type |
  |---|---|---|---|
  | `started` | `running`, `startedAt=now`, `executionId` | `thinking` | `task-started` |
  | `progress` | stays or becomes `running` | `step` | `task-progress` |
  | `waiting` | `waiting` | `waiting` | `task-waiting` |
  | `completed` | `completed`, `completedAt`, `resultSummary` | `completed` | `task-completed` |
  | `failed` | `failed`, `completedAt`, `errorMessage` | `error` | `task-failed` |
  | `cancelled` | `cancelled`, `completedAt` | `idle` | `task-cancelled` |

  `recoverInterruptedTasks` turns every `running`/`waiting` task into `failed` with `INTERRUPTED_MESSAGE` and sets its agent to `error`. A `queued` task is left as it is, because it never started.

- [ ] **Step 1: Write the failing tests**
  - `assignTask creates a queued task and points the agent at it`: the task matches `{ status: 'queued', title: 'Draft sprint plan', startedAt: null, executionId: null }`, `agent.currentTaskId === taskId`, the agent status stays `idle`, and a `task-assigned` activity is added.
  - `assignTask blocks a second active task`: the second call gives `{ ok: false, error: 'Nova already has an active task.' }`. After that task becomes `completed` through `applyRuntimeEvent`, a new `assignTask` succeeds.
  - `rejects blank or over-long titles`: `'  '` gives `'Title is required.'`, and 81 characters gives the length error.
  - `applyRuntimeEvent walks started → progress working → completed`: assert each row of the table above, including `executionId`, `resultSummary`, `completedAt`, and `source` on the activities.
  - `failed sets the agent to error` and `cancelled returns the agent to idle`.
  - `ignores events for unknown, finished or removed tasks` (Review Focus 1): `completed` after `cancelled`, `progress` for a removed agent's task, and an unknown taskId each return `toBe(sameState)`.
  - `recoverInterruptedTasks fails running and waiting tasks only`: running and waiting become `failed` with `errorMessage === 'Interrupted by page reload (simulated run)'` and the agent is `error`, while queued stays `queued`. With no active tasks it returns the same reference.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `npx vitest run src/workforce/operations.test.ts`
  Expected: FAIL, because `assignTask` is not exported.

- [ ] **Step 3: Implement it.** Put `runtime/types.ts` in place first. Every transition writes its activity through `addActivity`, using the event's `message`/`summary`/`error` text where there is one. For `started`, the message is `Started "<title>"`.

- [ ] **Step 4: Run them and confirm they pass**
  Run: `npx vitest run src/workforce/operations.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/workforce/runtime/types.ts src/workforce/operations.ts src/workforce/operations.test.ts
  git commit -m "feat(workforce): add task lifecycle and runtime event handling"
  ```

---

### Task 3: Demo seed and storage

**Files:**
- Create: `src/workforce/demo.ts`, `src/workforce/storage.ts`
- Test: `src/workforce/demo.test.ts`, `src/workforce/storage.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`emptyWorkforce`, `agentAtDesk`, `isActiveTask`, `recoverInterruptedTasks`, `ACTIVITY_LIMIT`).
- Produces (`demo.ts`):
  ```ts
  export const DEMO_AGENTS: readonly Omit<Agent, 'createdAt' | 'lastActivityAt'>[]
  export function createDemoWorkforce(now: string): WorkforceState
  /** Re-adds missing demo agents by id; a demo agent whose desk is taken comes back unassigned. */
  export function restoreDemoAgents(s: WorkforceState, now: string): WorkforceState
  ```
  The six demo agents all have `status: 'idle'`, `currentTaskId: null`, `runtimeMode: 'mock'` and `demo: true`:

  | id | name | role | department | deskId |
  |---|---|---|---|---|
  | `agent-demo-pm` | Atlas | Delivery planner | project-management | desk-03 |
  | `agent-demo-lead` | Meridian | Architecture lead | tech-lead | desk-05 |
  | `agent-demo-backend` | Forge | API engineer | backend | desk-07 |
  | `agent-demo-frontend` | Pixel | Interface engineer | frontend | desk-11 |
  | `agent-demo-qa` | Sentry | Test engineer | qa | desk-13 |
  | `agent-demo-devops` | Relay | Release engineer | devops | desk-09 |

  Each one gets one `agent-created` activity, `source: 'mock'`, with the message `Demo agent added (mock data)`.
- Produces (`storage.ts`):
  ```ts
  export const WORKFORCE_STORAGE_KEY = 'ai-virtual-office:workforce:v1'
  export const WORKFORCE_BACKUP_KEY = 'ai-virtual-office:workforce:v1:backup'
  type KV = Pick<Storage, 'getItem' | 'setItem'>
  export type WorkforceLoadProblem = 'corrupt' | 'unsupported-version' | 'unavailable'
  export type WorkforceLoadResult = { state: WorkforceState; seeded: boolean; problem: WorkforceLoadProblem | null }
  export function serializeWorkforce(s: WorkforceState): string          // fixed key order, activities capped at ACTIVITY_LIMIT
  export function parseWorkforce(raw: unknown): WorkforceState | null     // strict; rejects the whole state on any error
  export function loadWorkforce(storage: KV | null, now: string): WorkforceLoadResult
  export function saveWorkforce(storage: KV | null, s: WorkforceState): { ok: true } | { ok: false; error: string }
  ```
  - `parseWorkforce` rejects: unknown status/department/mode/activity type; non-ISO-string timestamps (`typeof !== 'string'` or `Number.isNaN(Date.parse(v))`); duplicate IDs across agents, tasks and activities; a `task.agentId` that doesn't exist; a `currentTaskId` that doesn't exist or belongs to another agent; an activity whose `agentId` or non-null `taskId` doesn't exist; two agents with the same `deskId`; and an agent with more than one active task.
  - `loadWorkforce` behaviour:
    - no storage: empty state, `'unavailable'`, nothing seeded;
    - key missing: `createDemoWorkforce(now)`, `seeded: true`;
    - unreadable or newer `schemaVersion`: empty state with the problem, the raw text copied to `WORKFORCE_BACKUP_KEY` **only if** no backup exists yet (try/catch around it);
    - valid: `recoverInterruptedTasks(parsed, now)`.
  - `saveWorkforce`: `Browser storage is not available.` when there is no storage, and a caught `setItem` error message otherwise.

- [ ] **Step 1: Write the failing tests.** Reuse the `memoryStorage` helper pattern from `src/layout/storage.test.ts`.
  - `demo.test.ts`:
    - `seeds six labelled demo agents on distinct default desks`: every `deskId` is a `desk` in `createDefaultLayout().furniture`, the IDs are unique, all have `demo: true`, and there are 6 activities with `source: 'mock'`.
    - `restoreDemoAgents re-adds only missing demo agents`: remove `agent-demo-qa` and give a user agent `desk-13`; after restoring, `agent-demo-qa` is back with `deskId: null`, there are still 7 agents total, and running it again returns the same reference.
  - `storage.test.ts`:
    - `seeds the demo once when nothing is stored`: `seeded: true` and 6 agents. After `saveWorkforce`, removing every agent, and saving again, the next load gives 0 agents and `seeded: false`.
    - `round-trips a state with tasks and activities` (`toEqual`).
    - `never touches the layout key`: `touched` never contains `'ai-virtual-office:layout:v1'` across load and save.
    - `backs up corrupt data once and starts empty` (Review Focus 2): store `'{not json'`, load gives `problem: 'corrupt'`, 0 agents, and the backup equals `'{not json'`. Store `'{"other":1}'`, load again, and the backup is still `'{not json'`.
    - `treats a newer schemaVersion as unsupported-version` (with a backup).
    - `rejects broken references`: one case each for a `task.agentId` that doesn't exist, an activity `taskId` that doesn't exist, a duplicate `deskId`, two active tasks for one agent, and an invalid status; each makes `parseWorkforce` return `null`.
    - `recovers interrupted tasks on load`: a stored running task comes back `failed` with `INTERRUPTED_MESSAGE`.
    - `caps activities at 300 when saving`.
    - `returns an error when setItem throws` (Review Focus 3): `setItem` throws `new Error('QuotaExceededError')`, and the result is `{ ok: false, error: 'QuotaExceededError' }`.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `npx vitest run src/workforce/demo.test.ts src/workforce/storage.test.ts`
  Expected: FAIL, because the modules can't be found.

- [ ] **Step 3: Implement `demo.ts` and `storage.ts`.** Follow `src/layout/storage.ts`'s structure: `isObject`/`isText` guards, one `parseX` per record, then cross-reference checks. `migrateWorkforce` is not needed until v2 exists (YAGNI).

- [ ] **Step 4: Run them and confirm they pass**
  Run: `npx vitest run src/workforce/demo.test.ts src/workforce/storage.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/workforce/demo.ts src/workforce/demo.test.ts src/workforce/storage.ts src/workforce/storage.test.ts
  git commit -m "feat(workforce): add demo seed and versioned workforce storage"
  ```

---

### Task 4: Mock runtime provider

**Files:**
- Create: `src/workforce/runtime/mockRuntime.ts`
- Test: `src/workforce/runtime/mockRuntime.test.ts`

**Interfaces:**
- Consumes: `RuntimeProvider`, `MockDemoControls`, `RuntimeEvent` (Task 2) and `createId`.
- Produces:
  ```ts
  export const MOCK_TIMINGS = { thinkingMs: 2000, workingMs: 4000 }
  export const MOCK_ERROR_MESSAGE = 'Simulated error (demo control).'
  export class MockRuntimeProvider implements RuntimeProvider, MockDemoControls {
    constructor(opts?: { timings?: typeof MOCK_TIMINGS })
    readonly mode: 'mock'; readonly availability: { available: true }
    activeTaskIds(): string[]   // for tests and the UI
  }
  ```
  The schedule, starting from `start` at t=0:
  - At 0ms (on a timer, never synchronously): `started`, then `progress` with `thinking` and the message `Thinking (simulated)`.
  - At `thinkingMs`: `progress` with `working` and the message `Working (simulated)`.
  - At `thinkingMs + workingMs`: `completed`, with the summary `Simulated result for "<title>". No AI was run.`
  - `forceWaiting` clears the pending timers and emits `waiting` (`Waiting for input (simulated)`) synchronously.
  - `resume` emits `progress` `working` and schedules `completed` after `workingMs`.
  - `forceError` clears the timers and emits `failed` with `message ?? MOCK_ERROR_MESSAGE`.
  - `cancel` clears the timers and emits `cancelled`.
  - All four are no-ops for a task the provider isn't running.
  - `start` on a task it is already running returns `{ ok: false, error: 'Task is already running.' }`.
  - `dispose` clears every timer and listener, and emits nothing.
  - A listener that throws must not stop the other listeners (wrap each call).

- [ ] **Step 1: Write the failing tests** using `vi.useFakeTimers()`, collecting events into an array through `subscribe`:
  - `runs the full simulated lifecycle`: right after `start` there are 0 events; after `advanceTimersByTime(0)` there is `started` (with the returned `executionId`) plus thinking; at 2000 there is working; at 6000 there is `completed` with the exact summary; then `activeTaskIds()` is `[]`.
  - `cancel stops pending timers`: cancel at 1000, then advancing 10000 emits nothing after `cancelled`.
  - `forceWaiting then resume completes after workingMs`.
  - `forceError emits failed with the default message`.
  - `ignores duplicate start and controls on finished tasks` (Review Focus 4): the second `start` gives the error, and after completion `cancel`/`forceError`/`forceWaiting` emit nothing.
  - `dispose clears timers`: `vi.getTimerCount() === 0` and no events afterwards.
  - `unsubscribe stops delivery to that listener only`.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `npx vitest run src/workforce/runtime/mockRuntime.test.ts`
  Expected: FAIL, because the module can't be found.

- [ ] **Step 3: Implement `MockRuntimeProvider`.** Keep a `Map<taskId, { title: string; timers: ReturnType<typeof setTimeout>[] }>` and a `Set` of listeners. Use `createId('exec')` for the `executionId`.

- [ ] **Step 4: Run them and confirm they pass**
  Run: `npx vitest run src/workforce/runtime/mockRuntime.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/workforce/runtime/mockRuntime.ts src/workforce/runtime/mockRuntime.test.ts
  git commit -m "feat(workforce): add timer-driven mock runtime provider"
  ```

---

### Task 5: Claude placeholder, end-to-end check, and PR

**Files:**
- Create: `src/workforce/runtime/claudeRuntime.ts`, `src/workforce/runtime/claudeRuntime.test.ts`, `src/workforce/workforce.test.ts`
- Modify: `tasks.md` (tick the Stage A boxes)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```ts
  export const CLAUDE_UNAVAILABLE = 'Not available: requires a server-side runtime.'
  export class ClaudeRuntimeProvider implements RuntimeProvider   // mode 'real', availability { available: false, reason: CLAUDE_UNAVAILABLE }
  ```
  - `start` returns `{ ok: false, error: CLAUDE_UNAVAILABLE }`. `cancel` and `dispose` do nothing. `subscribe` returns a no-op unsubscribe.
  - A top-of-file comment states the rule: a real runtime runs on a server. The browser never holds Anthropic credentials, API keys, shell access or process execution, and only receives `RuntimeEvent`s, for example over SSE or WebSocket.

- [ ] **Step 1: Write the failing tests**
  - `claudeRuntime.test.ts`: `reports unavailable and never starts`. Check `availability`, the `start` result, and that the source file contains none of `fetch(`, `child_process` or `apiKey`. Read it with `readFileSync` the way `src/scene/noRemoteAssets.test.ts` reads files.
  - `workforce.test.ts`: `mock runtime events drive state end to end`, with fake timers. Start from `createDemoWorkforce(NOW)`, then `assignTask` to `agent-demo-backend`, `provider.start`, and subscribe with `state = applyRuntimeEvent(state, e, NOW, 'mock')`. Advance 6000ms. The task is `completed`, the agent status is `completed`, the activities run from `task-assigned` to `task-completed` in order, all with `source: 'mock'`, and `parseWorkforce(JSON.parse(serializeWorkforce(state)))` is not null.
  - `workforce.test.ts`: `removing an agent mid-run leaves no dangling references`. Start a run, call `removeAgent`, then `provider.cancel(cancelledTaskId)`. Advance timers; the state is unchanged by the later events and `parseWorkforce` round-trips.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `npx vitest run src/workforce`
  Expected: FAIL, because `claudeRuntime` can't be found.

- [ ] **Step 3: Implement `ClaudeRuntimeProvider`** and tick the Stage A boxes in `tasks.md`, all except "PR".

- [ ] **Step 4: Run the full check**
  - Run: `npm test && npm run build`
  - Expected: every test passes (more than the earlier 203 tests). The build succeeds, with only the existing chunk-size warning.
  - Run: `grep -rnE "fetch\(|child_process|anthropic" src/workforce`
  - Expected: matches only in comments and in the test that asserts their absence.

- [ ] **Step 5: Commit, push and open the PR**
  ```bash
  git add src/workforce tasks.md
  git commit -m "feat(workforce): add Claude runtime placeholder and end-to-end tests"
  git push -u origin feat/workforce-domain-runtime
  gh pr create --base main --title "feat(workforce): milestone 3A stage A — domain model, storage and mock runtime" --body "<summary, test counts, 'execution is simulated' statement>"
  ```
