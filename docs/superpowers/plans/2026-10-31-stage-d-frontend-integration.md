# 3B.1 Stage D: Frontend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing workforce UI to the Stage B/C backend through a `RemoteWorkforceController` (REST for commands, SSE for events, snapshot plus replay recovery, reconnect with backoff, an explicit Offline state), chosen by `VITE_WORKFORCE_API_URL`. Add the runtime indicator, connection status, lifecycle labels and marker colours, and Approve / Deny over the API. The browser-only mock stays the default and works as before.

**Architecture:**
- `WorkforceController` stays the only thing React sees. Its snapshot gains `environment`, `connection`, `lastSyncedAt` and `commandError`; the local controller fills them with constants (`browser`, `local`).
- The remote side is three small units in `src/workforce/remote/`: `client.ts` (fetch wrapper, error messages, mutation headers), `sync.ts` (snapshot → EventSource → apply events, cursor/dedup, `state.reset`, backoff, dispose), `commands.ts` (one REST call per action). `remoteController.ts` composes them into a `WorkforceController`.
- `source.ts` reads `VITE_WORKFORCE_API_URL` once: empty → local controller; valid origin → remote; anything else → a remote controller in `misconfigured` state that never connects. Never a silent fallback to browser mock.
- The server is the source of truth. The browser applies server events only; the one local write is inserting a newly created agent if no event has delivered it yet, so the panel can open it.

**Tech Stack:** TypeScript 5.7, React 19, Vite 6, Vitest 5 (Node environment). Browser `fetch` and `EventSource`, injected so tests use fakes. **No new dependencies.**

**Spec:** `plan.md` §6, §7, §9 and `tasks.md` (decisions 2, 6, 7, 8; "Frontend integration" item 11; Stage D; Decisions Q1–Q5). Server contract: `server/http/routes.ts`, `server/http/sse.ts` (recovery comment at the top), `server/eventLog.ts`, `src/workforce/api.ts`.

## Global Constraints

- Work on the existing branch `feat/frontend-remote-workforce`; one PR into `main`. Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No changes under `server/`.** Nothing in this plan needs one (checked: CORS allows `Content-Type, Last-Event-ID`, the default `ALLOWED_ORIGINS` includes `http://127.0.0.1:5173`, `?lastEventId=` exists for the first connect). If an implementer finds one is needed, stop and flag it in the PR.
- No new runtime or dev dependencies. No component-testing library: UI files are covered by `tsc -b` and the browser checks in Task 9; all logic lives in pure, tested modules.
- `VITE_WORKFORCE_API_URL` empty or unset → browser mock, identical behaviour to today (same storage keys, same mock runtime). Example backend value: `http://127.0.0.1:8787`.
- Every POST/PUT/PATCH/DELETE sends `MUTATION_HEADERS` from `src/workforce/api.ts`, even with no body. GET requests send no `Content-Type`.
- Event stream URL: `${baseUrl}/api/events?lastEventId=${encodeURIComponent(snapshot.lastEventId)}`.
- Reconnect delay: `min(1000 * 2 ** attempt, 30000)` ms — 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 30 s… Reset to attempt 0 when a stream opens. Retry forever.
- **Copy (exact):**
  - Badge: `Mock · browser` / `Local backend · mock runtime` / `Local backend · Claude (not available)` / `Local backend` (runtime not known yet).
  - Badge titles: browser `Tasks are simulated in the browser. No AI is run.`; backend mock `Tasks run on the local backend's mock runtime. No Claude SDK is installed and no AI is run.`; backend claude: the health `reason`, or `Claude Agent SDK not installed`, followed by ` Tasks are refused.`
  - Note under the header in backend mode with runtime mock: `Mock runtime only; no Claude SDK.`
  - Connection: `Connecting…`, `Reconnecting…`, `Live`, `Offline · retrying`, `Offline · last synced HH:MM:SS · retrying`, `Not configured`.
  - Network error: `Can't reach the backend at <baseUrl>.` Non-JSON error body: `Request failed (<status>).` Server JSON errors (`{ error }`) are shown exactly as sent, including guard errors such as `Origin not allowed.` and `Content-Type must be application/json.`
  - Config error: `VITE_WORKFORCE_API_URL must be an http(s) origin such as http://127.0.0.1:8787 (got "<value>").`
- `resultSummary` and `errorMessage` from the server are rendered as plain React text, unchanged (no prefix, no rewording).
- `src/` must keep passing `src/scene/noRemoteAssets.test.ts` (only localhost / 127.0.0.1 URLs in source) and `server/noProcessExecution.test.ts`.

## Review Focus

1. **Duplicate or stale events after a reconnect.** A replayed or re-sent event whose seq is not above the cursor must change nothing; an event from another boot must trigger a full resync, never a merge (Task 3 tests `ignores an event that is not newer than the cursor`, `resyncs when an event comes from another boot`).
2. **Server restart mid-run (new boot id).** The client must replace its state with the new snapshot (the running task shows `Interrupted by a server restart`), open the stream at the new `<boot>:<seq>`, and not loop on `state.reset` (Task 4 `replaces state from the new snapshot after a server restart`, Task 3 `backs off after repeated resets`).
3. **Create-then-open race.** `POST /api/agents` can resolve before its SSE event arrives; the panel must still open the new agent, and a newer copy already delivered by an event must not be overwritten by the older response (Task 5 `createAgent shows the agent before its event arrives`, `createAgent never overwrites a newer agent from an event`).
4. **4xx from guards and the task manager** (403 origin, 415 content type, 409 conflict, 404 demo route on `RUNTIME=claude`, 503 stream limit). The user sees the server's message where they acted; nothing throws; a stream refused with 503 falls into the normal backoff (Task 2 `returns the server error message as-is`, Task 4 `goes offline when the stream errors and keeps the last state`).
5. **Unmount cleanup under StrictMode.** Dispose while the snapshot request is in flight, while a stream is open, and while a retry is scheduled: no EventSource is left open, no timer fires, and no late response publishes (Task 4 `dispose closes the stream, cancels the retry and ignores late responses`).

---

## File Structure

| File | Change |
|---|---|
| `src/workforce/api.ts` | Add `WORKFORCE_EVENT_TYPES`, `HealthResponse`, `AgentResponse` |
| `src/workforce/controller.ts` | Snapshot fields, `Awaitable`, `cancelTask`/`decideApproval` return `ActionResult`, `dismissCommandError` |
| `src/workforce/remote/client.ts` (new) | `createApiClient`: GET/mutations, error messages |
| `src/workforce/remote/sync.ts` (new) | Snapshot + stream lifecycle, cursor, reset, backoff, dispose |
| `src/workforce/remote/commands.ts` (new) | Actions → REST routes |
| `src/workforce/remote/remoteController.ts` (new) | Composes the three into a `WorkforceController` |
| `src/workforce/remote/fakes.ts` (new) | `FakeEventSource`, `createFakeBackend` for tests only (never imported by the app) |
| `src/workforce/source.ts` (new) | `resolveWorkforceSource`, `createControllerFor` |
| `src/workforce/useWorkforce.ts` | Use `createControllerFor` |
| `src/vite-env.d.ts` (new) | `ImportMetaEnv` with `VITE_WORKFORCE_API_URL` |
| `src/workforce/view.ts` | `environmentBadge`, `environmentNote`, `connectionLabel`, `agentStatusText`, `markerPhase`, `TASK_RUNTIME_LABEL`; `deskMarkers` adds `phase` |
| `src/scene/labels.ts`, `src/scene/DeskMarkers.tsx` | `DeskMarker.phase`, `phase-<status>` class |
| `src/styles.css` | Badge variants, connection pill, marker phase colours |
| `src/workforce/ui/WorkforcePanel.tsx`, `AgentDetail.tsx`, `AgentForm.tsx`, `AssignDesk.tsx`, `AgentList.tsx`, `src/App.tsx` | Indicator, async actions with busy state, approval pending, command-error notice |
| `.env.example`, `scripts/devFull.ts` | Comments only ("used from Stage D" → current) |
| `tasks.md`, `docs/screenshots/milestone-3b1/stage-d-*.jpg` | Tick Stage D, screenshots |

---

### Task 1: Wire types and the extended controller snapshot

**Files:**
- Modify: `src/workforce/api.ts`, `src/workforce/controller.ts`; call sites in `src/workforce/ui/WorkforcePanel.tsx`, `AgentDetail.tsx`, `AgentForm.tsx`, `AssignDesk.tsx`
- Test: `src/workforce/api.test.ts`, `src/workforce/controller.test.ts`

**Interfaces:**
- Produces (api.ts):
  - `export const WORKFORCE_EVENT_TYPES = [...] as const satisfies readonly WorkforceEventType[]` — all 11 types, in the order of the `WorkforceEventType` union.
  - `export type HealthResponse = { ok: true; version: string; runtime: 'mock' | 'claude'; available: boolean; reason: string | null; credentialsConfigured: boolean; startedAt: string }` (the subset of `/api/health` the browser reads).
  - `export type AgentResponse = { agent: Agent }` (POST/PATCH agents, PUT desk).
- Produces (controller.ts):
  - `export type Awaitable<T> = T | Promise<T>`
  - `export type RuntimeEnvironment = { kind: 'browser' } | { kind: 'backend'; runtime: 'mock' | 'claude' | null; available: boolean | null; reason: string | null }`
  - `export type ConnectionStatus = 'local' | 'connecting' | 'live' | 'offline' | 'misconfigured'`
  - `WorkforceSnapshot` adds `environment: RuntimeEnvironment; connection: ConnectionStatus; lastSyncedAt: string | null; commandError: string | null`.
  - `WorkforceController` changes: `createAgent(...): Awaitable<{ ok: true; id: string } | { ok: false; error: string }>`; `updateAgent`, `assignDesk`, `startTask`, `cancelTask`, `decideApproval` return `Awaitable<ActionResult>`; new `dismissCommandError(): void`. `removeAgent`, `requestApproval`, `forceError`, `restoreDemoAgents` stay `void` (their failures go to `commandError`).

- [ ] **Step 1: Write the failing tests**

```ts
// api.test.ts
it('WORKFORCE_EVENT_TYPES lists every event type once', () => {
  expect(new Set(WORKFORCE_EVENT_TYPES).size).toBe(11)
  expect(WORKFORCE_EVENT_TYPES).toContain('state.reset')
  expect(WORKFORCE_EVENT_TYPES).toContain('task.waiting_for_approval')
})
// controller.test.ts
it('a local controller reports the browser environment and a local connection', () => {
  const c = createWorkforceController({ storage: memoryStorage() })
  expect(c.getSnapshot()).toMatchObject({ environment: { kind: 'browser' }, connection: 'local', lastSyncedAt: null, commandError: null })
})
it('local cancelTask and decideApproval return ok', () => { /* start a task, cancel → toEqual({ ok: true }); approval path → toEqual({ ok: true }) */ })
it('local dismissCommandError is a no-op', () => { const before = c.getSnapshot(); c.dismissCommandError(); expect(c.getSnapshot()).toBe(before) })
```
Use the helpers already in `controller.test.ts` for storage and task setup.

- [ ] **Step 2: Run** `npx vitest run src/workforce/api.test.ts src/workforce/controller.test.ts` — Expected: FAIL (`WORKFORCE_EVENT_TYPES` not exported, snapshot lacks `environment`).
- [ ] **Step 3: Implement** the types above. Local controller: initial snapshot adds `environment: { kind: 'browser' }, connection: 'local', lastSyncedAt: null, commandError: null`; `cancelTask`/`decideApproval` end with `return { ok: true }`; `dismissCommandError: () => {}`. Because the results are now `Awaitable`, update the call sites so `tsc -b` passes: `AgentFormProps.onSubmit`, `AssignDeskProps.onAssign` and `TaskForm`'s `onStart` return `Awaitable<string | null>` and their handlers `await` it; WorkforcePanel's `onSubmit`/`onAssign` callbacks and AgentDetail's `start`/`pickDesk` become `async` and `await` the action. No other UI change here (busy states and the indicator come in Task 8). Mock-mode behaviour is unchanged.
- [ ] **Step 4: Run** `npx vitest run src/workforce && npx tsc -b` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(workforce): extend the controller snapshot for remote mode`

---

### Task 2: API client

**Files:**
- Create: `src/workforce/remote/client.ts`, `src/workforce/remote/fakes.ts`
- Test: `src/workforce/remote/client.test.ts`

**Interfaces:**
- Produces (client.ts):
  - `export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number | null; error: string }` (`status: null` = network failure or abort).
  - `export type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'`
  - `export type ApiClient = { baseUrl: string; get<T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>>; send<T>(method: MutationMethod, path: string, body?: unknown): Promise<ApiResult<T>> }`
  - `export function createApiClient(opts: { baseUrl: string; fetch?: typeof fetch }): ApiClient` — `fetch` defaults to `globalThis.fetch.bind(globalThis)`.
- Produces (fakes.ts, tests only):
  - `export type FakeCall = { method: string; url: string; headers: Record<string, string>; body: string | undefined }`
  - `export function createFakeBackend(opts: { baseUrl: string; state: StateResponse; health?: HealthResponse }): { fetch: typeof fetch; calls: FakeCall[]; down: boolean; setState(s: StateResponse): void; respond(method: string, path: string, status: number, body: unknown): void; hold(path: string): () => void }` — serves `GET /api/state` and `GET /api/health`; `respond` sets the reply for a mutation route (default `200 {}`); `down = true` makes every call reject with `new TypeError('Failed to fetch')`; `hold(path)` makes the next request to `path` wait until the returned release function is called; it honours `init.signal` by rejecting with an `AbortError` `DOMException`.
  - `export class FakeEventSource { static instances: FakeEventSource[]; static reset(): void; url: string; closed: boolean; constructor(url: string); addEventListener(type: string, fn: (e: { data?: string }) => void): void; close(): void; open(): void; fail(): void; emit(e: WorkforceEvent): void; emitRaw(type: string, data: string): void }` — `emit` dispatches to listeners of `e.type` with `data: JSON.stringify(e)`; nothing dispatches after `close()`.

- [ ] **Step 1: Write the failing tests** (`client.test.ts`, base `http://127.0.0.1:8787`)

```ts
it('GET carries no Content-Type and returns the JSON body', async () => { /* get('/api/state') → ok, body equals fake state; calls[0].headers has no content-type */ })
it('sends mutations with MUTATION_HEADERS and a JSON body', async () => { /* send('PUT','/api/agents/a1/desk',{deskId:'desk-01'}) → headers['content-type']==='application/json', body '{"deskId":"desk-01"}' */ })
it('sends MUTATION_HEADERS on a body-less mutation', async () => { /* send('POST','/api/tasks/t1/cancel') → content-type set, body undefined */ })
it('returns the server error message as-is', async () => {
  backend.respond('POST', '/api/agents', 403, { error: 'Origin not allowed.' })
  expect(await client.send('POST', '/api/agents', {})).toEqual({ ok: false, status: 403, error: 'Origin not allowed.' })
})
it('falls back to "Request failed (<status>)." for a non-JSON error body', async () => { /* 502 'Bad gateway' text → error 'Request failed (502).' */ })
it("reports a network failure as Can't reach the backend", async () => {
  backend.down = true
  expect(await client.get('/api/state')).toEqual({ ok: false, status: null, error: "Can't reach the backend at http://127.0.0.1:8787." })
})
```

- [ ] **Step 2: Run** `npx vitest run src/workforce/remote/client.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `createApiClient` and the fakes. URL = `baseUrl + path`. Never throws: every rejection becomes `ApiResult` (an `AbortError` too, with the same network message; callers ignore results after abort).
- [ ] **Step 4: Run** the test file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workforce): add the backend API client`

---

### Task 3: Sync — snapshot, stream, events, reset

**Files:**
- Create: `src/workforce/remote/sync.ts`
- Test: `src/workforce/remote/sync.test.ts`

**Interfaces:**
- Consumes: `ApiClient` (Task 2), `StateResponse`, `HealthResponse`, `WORKFORCE_EVENT_TYPES`, `parseEventId`, `applyWorkforceEvent` (api.ts), `emptyWorkforce` (operations.ts), snapshot types (Task 1).
- Produces:
  - `export type EventSourceLike = { addEventListener(type: string, listener: (event: { data?: string }) => void): void; close(): void }`
  - `export type SyncSnapshot = Pick<WorkforceSnapshot, 'state' | 'loadProblem' | 'preserved' | 'saveError' | 'environment' | 'connection' | 'lastSyncedAt'>`
  - `export type RemoteSync = { getSnapshot(): SyncSnapshot; subscribe(listener: () => void): () => void; insertAgentIfAbsent(agent: Agent): void; dispose(): void }`
  - `export function createRemoteSync(opts: { client: ApiClient; createEventSource: (url: string) => EventSourceLike; now?: () => string }): RemoteSync` — starts connecting immediately.
  - `export function reconnectDelay(attempt: number): number`

Behaviour (decisions the tests pin):
- Initial snapshot: `state: emptyWorkforce()`, `loadProblem: null`, `preserved: null`, `saveError: null`, `environment: { kind: 'backend', runtime: null, available: null, reason: null }`, `connection: 'connecting'`, `lastSyncedAt: null`.
- One connect = close any old stream → `GET /api/state` and (in parallel, non-blocking) `GET /api/health` → replace `state`/`loadProblem`/`preserved`/`saveError`, set cursor from `lastEventId`, `lastSyncedAt = now()` → open the stream (Global Constraints URL) → `open` sets `connection: 'live'`.
- Each connect has a generation number; every async result and stream callback from an older generation is dropped.
- Change event: parse `data`; malformed JSON or unparsable id → resync. Boot ≠ cursor boot → resync. Seq ≤ cursor seq → ignore (no publish). Otherwise `applyWorkforceEvent`, advance cursor, `lastSyncedAt = now()`, reset the reset-streak, publish.
- `state.reset` → resync: first one immediately, each further consecutive one (no change event applied in between) after `reconnectDelay(streak - 2)`. During a resync `connection` is `'connecting'`.
- `insertAgentIfAbsent(agent)` adds the agent only if no agent with that id exists; otherwise does nothing.

- [ ] **Step 1: Write the failing tests** (fake timers; `const flush = () => vi.advanceTimersByTimeAsync(0)`; fake state with `lastEventId: 'b1:5'`)

```ts
it('starts connecting with an empty state', () => { /* getSnapshot(): agents [], connection 'connecting', lastSyncedAt null, environment.runtime null */ })
it('loads the snapshot, then opens the stream at its lastEventId', async () => {
  await flush()
  expect(backend.calls[0]).toMatchObject({ method: 'GET', url: 'http://127.0.0.1:8787/api/state' })
  expect(FakeEventSource.instances[0].url).toBe('http://127.0.0.1:8787/api/events?lastEventId=b1%3A5')
  expect(sync.getSnapshot().state).toEqual(fakeState.state)
  expect(sync.getSnapshot().connection).toBe('connecting')
  FakeEventSource.instances[0].open()
  expect(sync.getSnapshot()).toMatchObject({ connection: 'live', lastSyncedAt: NOW })
})
it('reads the runtime from /api/health', async () => { /* environment toEqual { kind:'backend', runtime:'mock', available:true, reason:null } */ })
it('a failing /api/health does not block the connection', async () => { /* health 500 → stream still opens, runtime stays null */ })
it('applies change events in order', async () => { /* emit b1:6 task.queued with a new task in patch → state.tasks contains it */ })
it('ignores an event that is not newer than the cursor', async () => {
  /* emit b1:6, then b1:6 again and b1:4 → state reference unchanged after the first; listener called once */
})
it('resyncs when an event comes from another boot', async () => { /* emit id 'b2:1' → old source closed, GET /api/state called again */ })
it('reloads the snapshot on state.reset', async () => { /* setState(lastEventId 'b1:40'), emit reset → second source url ends lastEventId=b1%3A40, first closed */ })
it('backs off after repeated resets', async () => {
  /* reset #1 → immediate refetch; reset #2 with no change event between → no refetch at 999 ms, refetch at 1000 ms */
})
it('resyncs on a malformed event frame', async () => { /* emitRaw('task.progress', '{oops') → GET /api/state again */ })
it('insertAgentIfAbsent adds a missing agent and leaves an existing one alone', async () => { /* … */ })
it('reconnectDelay doubles from 1 s and caps at 30 s', () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
})
```

- [ ] **Step 2: Run** `npx vitest run src/workforce/remote/sync.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `createRemoteSync` and `reconnectDelay`. Register listeners for every name in `WORKFORCE_EVENT_TYPES` plus `open` and `error` (error handling is Task 4; in this task `error` may call the same `fail()` that Task 4 tests). Use the global `setTimeout`/`clearTimeout`.
- [ ] **Step 4: Run** the test file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workforce): sync workforce state from the backend snapshot and event stream`

---

### Task 4: Sync — offline, backoff, restart, dispose

**Files:**
- Modify: `src/workforce/remote/sync.ts`
- Test: `src/workforce/remote/sync.test.ts`

**Interfaces:**
- Consumes/Produces: unchanged from Task 3.

Behaviour:
- A failed `GET /api/state` or a stream `error` → close the stream, `connection: 'offline'` (state and `lastSyncedAt` kept), schedule a connect after `reconnectDelay(attempt)`, then `attempt += 1`. A stream `open` sets `attempt = 0`. The browser's own EventSource auto-retry is never used (the source is closed in the `error` handler).
- `dispose()`: bump the generation, abort the in-flight fetches (`AbortController` per connect, passed to `client.get`), close the stream, clear the retry timer, clear listeners. Nothing publishes afterwards.

- [ ] **Step 1: Write the failing tests**

```ts
it('goes offline when the stream errors and keeps the last state', async () => {
  /* open, then instances[0].fail() → instances[0].closed true, connection 'offline', state toBe previous state */
})
it('retries with backoff while the backend is down', async () => {
  /* backend.down = true before start → GET count 1; +1000 ms → 2; +2000 ms → 3; +4000 ms → 4; connection 'offline' between attempts */
})
it('resets the backoff after a stream opens', async () => {
  /* fail twice (delays 1 s, 2 s), succeed + open, fail again → next retry after 1000 ms, not 4000 ms */
})
it('replaces state from the new snapshot after a server restart', async () => {
  /* live on b1:5 → fail() → setState(new state with a failed task 'Interrupted by a server restart', lastEventId 'b2:0') → +1000 ms
     → state equals the new state; new source url ends lastEventId=b2%3A0; a later emit with id 'b1:6' triggers a resync, not a merge */
})
it('dispose closes the stream, cancels the retry and ignores late responses', async () => {
  /* case 1: hold('/api/state'), dispose, release → no EventSource created, listener never called
     case 2: open stream, dispose → instances[0].closed true
     case 3: backend.down, dispose during backoff, advance 60 s → no further calls */
})
```

- [ ] **Step 2: Run** `npx vitest run src/workforce/remote/sync.test.ts` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the failure path, backoff counter and `dispose` as above.
- [ ] **Step 4: Run** the test file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workforce): reconnect to the backend with backoff and clean up on dispose`

---

### Task 5: Commands and the remote controller

**Files:**
- Create: `src/workforce/remote/commands.ts`, `src/workforce/remote/remoteController.ts`
- Test: `src/workforce/remote/commands.test.ts`, `src/workforce/remote/remoteController.test.ts`

**Interfaces:**
- Consumes: `ApiClient`, `createRemoteSync`, `EventSourceLike`, `AgentResponse`, `CreateAgentBody`, `PatchAgentBody`, `DeskBody`, `CreateTaskBody`, `ApprovalBody`.
- Produces:
  - `export type RemoteCommands = Pick<WorkforceController, 'createAgent' | 'updateAgent' | 'removeAgent' | 'assignDesk' | 'startTask' | 'cancelTask' | 'decideApproval' | 'requestApproval' | 'forceError' | 'restoreDemoAgents'>`
  - `export function createRemoteCommands(deps: { client: ApiClient; insertAgent(agent: Agent): void; reportError(message: string | null): void }): RemoteCommands`
  - `export type RemoteControllerOptions = { baseUrl: string; fetch?: typeof fetch; createEventSource?: (url: string) => EventSourceLike; now?: () => string; configError?: string }` — `createEventSource` defaults to `(url) => new EventSource(url)`.
  - `export function createRemoteWorkforceController(opts: RemoteControllerOptions): WorkforceController`

Route table (ids through `encodeURIComponent`):

| Action | Request |
|---|---|
| `createAgent(input)` | `POST /api/agents` body `input` → `201 { agent }` → `insertAgent(agent)`, return `{ ok: true, id: agent.id }` |
| `updateAgent(id, patch)` | `PATCH /api/agents/:id` body `patch` |
| `removeAgent(id)` | `DELETE /api/agents/:id` |
| `assignDesk(agentId, deskId)` | `PUT /api/agents/:id/desk` body `{ deskId }` |
| `startTask(agentId, input)` | `POST /api/agents/:id/tasks` body `{ title, description }` |
| `cancelTask(taskId)` | `POST /api/tasks/:id/cancel` |
| `decideApproval(taskId, approvalId, decision)` | `POST /api/tasks/:id/approval` body `{ approvalId, decision }` |
| `requestApproval(taskId)` | `POST /api/demo/tasks/:id/request-approval` |
| `forceError(taskId)` | `POST /api/demo/tasks/:id/force-error` |
| `restoreDemoAgents()` | `POST /api/demo/agents/restore` |

- `ActionResult`-returning actions return `{ ok: false, error }` with the client's message and do **not** call `reportError`. The four `void` actions call `reportError(error)` on failure. Any successful action calls `reportError(null)`.
- Response bodies other than `createAgent`'s are ignored: state changes arrive as events.
- Controller: `getSnapshot()` = sync snapshot + `commandError` (with `loadProblem` forced to `null` once `dismissLoadProblem()` has been called, for the controller's lifetime); `dismissCommandError()` sets it to `null`; snapshot objects are new only when something changed (required by `useSyncExternalStore`). With `configError`: no sync is created, no fetch is made, the snapshot is `connection: 'misconfigured'`, `commandError: configError`, empty state, and every command returns/reports `configError`.

- [ ] **Step 1: Write the failing tests**

```ts
// commands.test.ts
it.each(ROUTES)('$action sends $method $path', async ({ call, method, path, body }) => {
  await call(commands)
  expect(backend.calls.at(-1)).toMatchObject({ method, url: `http://127.0.0.1:8787${path}`, headers: { 'content-type': 'application/json' }, body })
}) // one row per line of the route table, e.g. decideApproval('t1','ap1','deny') → '{"approvalId":"ap1","decision":"deny"}'
it('createAgent returns the server id and inserts the returned agent', async () => { /* respond 201 { agent } → { ok: true, id: agent.id }; insertAgent called with agent */ })
it('startTask returns the server message for a 409', async () => { /* respond 409 { error: 'Agent already has an active task.' } → { ok: false, error: same }; reportError not called */ })
it('a failing void command reports its error and a success clears it', async () => { /* restoreDemoAgents 404 { error: 'Not found.' } → reportError('Not found.'); then removeAgent 200 → reportError(null) */ })
// remoteController.test.ts
it('createAgent shows the agent before its event arrives', async () => { /* live; createAgent → getSnapshot().state.agents has id */ })
it('createAgent never overwrites a newer agent from an event', async () => {
  /* hold POST /api/agents; emit state.changed carrying agent a9 renamed 'Newer'; release with { agent: a9 named 'Older' } → name stays 'Newer' */
})
it('void command errors show in commandError until dismissed', async () => { /* forceError 404 → commandError 'Not found.'; dismissCommandError → null */ })
it('dismissLoadProblem keeps the notice hidden after a resync', async () => { /* state with loadProblem 'corrupt'; dismiss; reset → still null */ })
it('with a config error it never connects and shows the error', () => { /* fetch spy never called; connection 'misconfigured'; startTask → { ok:false, error: configError } */ })
it('dispose disposes the sync', async () => { /* open stream, dispose → source closed */ })
```

- [ ] **Step 2: Run** `npx vitest run src/workforce/remote` — Expected: new tests FAIL (modules missing).
- [ ] **Step 3: Implement** `createRemoteCommands` and `createRemoteWorkforceController`.
- [ ] **Step 4: Run** `npx vitest run src/workforce/remote && npx tsc -b` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workforce): add RemoteWorkforceController with REST commands`

---

### Task 6: Choose the controller from `VITE_WORKFORCE_API_URL`

**Files:**
- Create: `src/workforce/source.ts`, `src/vite-env.d.ts`
- Modify: `src/workforce/useWorkforce.ts`, `.env.example` (VITE line comment → `Frontend only. Empty = browser mock (default). Set to the backend origin, e.g. http://127.0.0.1:8787, to use the local backend.`), `scripts/devFull.ts` (replace the comment `The UI ignores this until Stage D connects it.` with `Points the UI at this backend unless already set.`)
- Test: `src/workforce/source.test.ts`

**Interfaces:**
- Produces:
  - `export type WorkforceSource = { kind: 'browser' } | { kind: 'backend'; baseUrl: string } | { kind: 'invalid'; error: string }`
  - `export function resolveWorkforceSource(raw: string | undefined): WorkforceSource` — trims; empty → browser; `new URL(raw)` with protocol `http:`/`https:` and no path beyond `/`, no query or hash → backend with `baseUrl = url.origin`; otherwise invalid with the config-error copy.
  - `export function createControllerFor(source: WorkforceSource, deps: { storage: Pick<Storage, 'getItem' | 'setItem'> | null; fetch?: typeof fetch; createEventSource?: (url: string) => EventSourceLike }): WorkforceController` — browser → `createWorkforceController({ storage })`; backend → `createRemoteWorkforceController({ baseUrl, fetch, createEventSource })`; invalid → `createRemoteWorkforceController({ baseUrl: '', configError: error })`.
  - `src/vite-env.d.ts`: `/// <reference types="vite/client" />` plus `interface ImportMetaEnv { readonly VITE_WORKFORCE_API_URL?: string }`.
  - `useWorkforce`: the effect calls `createControllerFor(resolveWorkforceSource(import.meta.env.VITE_WORKFORCE_API_URL), { storage: getBrowserStorage() })`; nothing else changes.

- [ ] **Step 1: Write the failing tests**

```ts
it('an empty or missing value selects the browser mock', () => {
  for (const raw of [undefined, '', '   ']) expect(resolveWorkforceSource(raw)).toEqual({ kind: 'browser' })
})
it('an http(s) origin selects the backend, without a trailing slash', () => {
  expect(resolveWorkforceSource('http://127.0.0.1:8787/')).toEqual({ kind: 'backend', baseUrl: 'http://127.0.0.1:8787' })
})
it('other values are invalid with a readable error', () => {
  for (const raw of ['nope', 'ftp://127.0.0.1:8787', 'http://127.0.0.1:8787/api'])
    expect(resolveWorkforceSource(raw)).toEqual({ kind: 'invalid', error: `VITE_WORKFORCE_API_URL must be an http(s) origin such as http://127.0.0.1:8787 (got "${raw}").` })
})
it('the browser source gives the local controller', () => { /* environment { kind:'browser' }, connection 'local' */ })
it('the backend source never touches browser storage', () => { /* spy storage; fake fetch + FakeEventSource; getItem/setItem never called; environment.kind 'backend' */ })
it('an invalid source gives a misconfigured controller, not the browser mock', () => { /* connection 'misconfigured', state.agents [] */ })
```

- [ ] **Step 2: Run** `npx vitest run src/workforce/source.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `source.ts`, `vite-env.d.ts`, the `useWorkforce` change and the two comment edits.
- [ ] **Step 4: Run** `npm test && npx tsc -b` — Expected: all tests pass (including `noRemoteAssets` and `noProcessExecution`), no type errors.
- [ ] **Step 5: Commit** `feat(workforce): select browser mock or local backend from VITE_WORKFORCE_API_URL`

---

### Task 7: View helpers, lifecycle labels and marker colours

**Files:**
- Modify: `src/workforce/view.ts`, `src/scene/labels.ts`, `src/scene/DeskMarkers.tsx`, `src/styles.css`
- Test: `src/workforce/view.test.ts`

**Interfaces:**
- Consumes: `RuntimeEnvironment`, `ConnectionStatus`, `WorkforceSnapshot` (Task 1), `activeTaskFor` (operations.ts).
- Produces (view.ts):
  - `export function environmentBadge(env: RuntimeEnvironment): { label: string; title: string; tone: 'browser' | 'backend' | 'unavailable' }` — copy from Global Constraints; `tone` is `unavailable` for runtime `claude` or `available === false`.
  - `export function environmentNote(env: RuntimeEnvironment): string | null` — `'Mock runtime only; no Claude SDK.'` for backend + runtime `mock`, else `null`.
  - `export function connectionLabel(s: Pick<WorkforceSnapshot, 'connection' | 'lastSyncedAt'>): string | null` — local → `null`; connecting → `Connecting…` (or `Reconnecting…` when `lastSyncedAt !== null`); live → `Live`; offline → `Offline · retrying` or `Offline · last synced ${formatTime(lastSyncedAt)} · retrying`; misconfigured → `Not configured`.
  - `export type MarkerPhase = 'queued' | 'starting' | 'waiting_for_approval' | 'cancelling'`
  - `export function markerPhase(task: AgentTask | undefined): MarkerPhase | null` — the task's status when it is one of those four, else `null` (running / ended statuses are already distinct through the agent status colour).
  - `export function agentStatusText(s: WorkforceState, agent: Agent): string` — `TASK_STATUS_LABEL[phase]` when the agent's active task has a phase, else `AGENT_STATUS_LABEL[agent.status]`.
  - `export const TASK_RUNTIME_LABEL: Record<TaskRuntime, string> = { mock: 'Simulated run', claude: 'Claude runtime' }`
  - `deskMarkers` sets `phase: markerPhase(activeTaskFor(s, agent.id))` on each marker.
- Produces (scene): `DeskMarker` gains `phase: string | null`; `DeskMarkerLayer` appends ` phase-${m.phase}` to the class when set.
- CSS (exact selectors; colours reuse the existing palette):
  - `.desk-marker.phase-queued .desk-marker-dot{box-shadow:0 0 0 2px #8e9bad55}`
  - `.desk-marker.phase-starting .desk-marker-dot{background:#a89af5;animation:marker-pulse 1.2s ease-in-out infinite}`
  - `.desk-marker.phase-waiting_for_approval{border-color:#e5b878}` and `.desk-marker.phase-waiting_for_approval .desk-marker-dot{background:#e5b878;animation:marker-pulse 1.2s ease-in-out infinite}`
  - `.desk-marker.phase-cancelling .desk-marker-dot{background:transparent;border:1.5px solid #8e9bad}`
  - `@keyframes marker-pulse{50%{opacity:.35}}` and `@media (prefers-reduced-motion:reduce){.desk-marker .desk-marker-dot{animation:none}}`
  - `.task-card.cancelled{opacity:.8}`; badge tones `.mock-badge.backend{color:#83c1df;background:#1d2b36;border-color:#2f4a5c}`, `.mock-badge.unavailable{color:#ff8a8a;background:#2e1c1e;border-color:#5c2629}`; `.connection-pill` (plus `.live`, `.offline`, `.misconfigured`) styled like `.agent-chip` with dot colours `#65c995` / `#ff8a8a` / `#ff8a8a`.

- [ ] **Step 1: Write the failing tests**

```ts
it('environmentBadge names each environment', () => {
  expect(environmentBadge({ kind: 'browser' })).toEqual({ label: 'Mock · browser', title: 'Tasks are simulated in the browser. No AI is run.', tone: 'browser' })
  expect(environmentBadge({ kind: 'backend', runtime: 'mock', available: true, reason: null }).label).toBe('Local backend · mock runtime')
  expect(environmentBadge({ kind: 'backend', runtime: 'claude', available: false, reason: 'Claude Agent SDK not installed' })).toEqual({ label: 'Local backend · Claude (not available)', title: 'Claude Agent SDK not installed. Tasks are refused.', tone: 'unavailable' })
  expect(environmentBadge({ kind: 'backend', runtime: null, available: null, reason: null }).label).toBe('Local backend')
})
it('environmentNote says mock runtime only for the backend mock', () => { /* backend mock → 'Mock runtime only; no Claude SDK.'; browser → null; claude → null */ })
it('connectionLabel covers every connection status', () => { /* six cases incl. `Offline · last synced ${formatTime(T)} · retrying` */ })
it('agentStatusText prefers the lifecycle phase', () => { /* waiting_for_approval → 'Waiting for approval'; cancelling → 'Cancelling'; starting → 'Starting'; running+working → 'Working'; no task → agent label */ })
it('deskMarkers carry the active task phase', () => { /* waiting task → phase 'waiting_for_approval'; completed task → null */ })
it('styles define a marker rule for every phase', () => {
  // import css from '../styles.css?raw'
  for (const p of ['queued', 'starting', 'waiting_for_approval', 'cancelling']) expect(css).toContain(`.desk-marker.phase-${p}`)
})
```

- [ ] **Step 2: Run** `npx vitest run src/workforce/view.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the marker field and class, and the CSS.
- [ ] **Step 4: Run** `npx vitest run src/workforce src/scene && npx tsc -b` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(workforce): lifecycle labels, marker phase colours and runtime indicator helpers`

---

### Task 8: Panel UI — indicator, connection, async actions, approvals

**Files:**
- Modify: `src/workforce/ui/WorkforcePanel.tsx`, `src/workforce/ui/AgentDetail.tsx`, `src/workforce/ui/AgentForm.tsx`, `src/workforce/ui/AssignDesk.tsx`, `src/workforce/ui/AgentList.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: Task 1 controller types and the `Awaitable` prop types it introduced, Task 7 view helpers.
- Produces: no new exports.

Changes:
- **Header** (`WorkforcePanel`): `AI agents`, then `<span className={`mock-badge ${tone}`} title={title}>{label}</span>` from `environmentBadge`, then `<span className={`connection-pill ${connection}`} role="status">{connectionLabel}</span>` when non-null; below it a `panel-hint` with `environmentNote` when non-null. The header shows in the loading state too (`workforce === null` → keep `Loading agents…`). When `connection` is not `local`/`live` and `lastSyncedAt === null`, render `<p className="panel-hint">Waiting for the local backend…</p>` instead of the agent list (so an empty pre-connect state never offers "Restore demo agents").
- **Forms** (AgentForm, AssignDesk, TaskForm): hold a `busy` flag that disables the submit button (or agent rows) while the awaited callback is pending, and ignore a resolution after unmount (a ref cleared in an effect cleanup).
- **AgentList**: the row status uses `agentStatusText(state, a)`.
- **AgentDetail**:
  - `Approve` / `Deny` call `await actions.decideApproval(...)`; both buttons are disabled while one is pending; a failure shows `<p className="form-error" role="alert">{error}</p>` inside the approval card. Same pattern for `Cancel task` (inline error under the button).
  - The task card's `· Simulated run` becomes `· {TASK_RUNTIME_LABEL[task.runtime]}`; `resultSummary` and `errorMessage` stay rendered exactly as received.
  - Demo controls are unchanged (in backend mode they call the `/api/demo/*` routes through the controller).
- **App.tsx**: next to the existing `saveError` notice, `{workforce?.commandError && <div className="scene-notice error" role="alert"><AlertTriangle size={15}/><span>{workforce.commandError}</span><button className="notice-close" onClick={workforce.actions.dismissCommandError} aria-label="Dismiss"><X size={14}/></button></div>}`.

- [ ] **Step 1: Implement** the changes above (UI only; the logic is tested in Tasks 1–7).
- [ ] **Step 2: Run** `npm test && npm run build` — Expected: all tests pass; build passes (the existing >500 kB chunk warning is expected).
- [ ] **Step 3: Smoke check** `npm run dev`, open `http://127.0.0.1:5173`, AI Agents: badge `Mock · browser`, no connection pill, create an agent, start a task, console clean.
- [ ] **Step 4: Commit** `feat(workforce): runtime indicator, connection status and API-backed actions in the panel`

---

### Task 9: Browser verification in both modes, screenshots, PR

Keep it proportionate: one pass per mode, one kill/restart. Use the Chrome tools (or the `run` skill) and read console and network logs rather than many screenshots.

- [ ] **Step 1: Browser mock** (`npm run dev`): badge `Mock · browser`; start a task → Starting/Thinking → Working → Completed with `Simulated result for "<title>". No AI was run.`; Simulate approval request → marker turns amber (`phase-waiting_for_approval`) → Approve → Completed; the layout editor opens and closes; no request to `127.0.0.1:8787` in the network log; console clean.
- [ ] **Step 2: Local backend** (`npm run dev:full`): badge `Local backend · mock runtime`, note `Mock runtime only; no Claude SDK.`, pill `Live`. Network: `GET /api/state`, then `GET /api/events?lastEventId=<boot>:<n>`. Then:
  1. Create an agent → the detail opens immediately.
  2. Start a task → Starting → Running → Completed, summary text exactly as the server sent it.
  3. Simulate approval request → Approve → Completed; again → Deny → Failed with the server's message.
  4. Cancel a running task → Cancelling → Cancelled.
  5. A second tab shows the same agents and the change from step 1 without reload.
- [ ] **Step 3: Kill and restart mid-run.** Run the backend and frontend separately so the backend can be stopped alone: terminal 1 `npm run server`, terminal 2 `VITE_WORKFORCE_API_URL=http://127.0.0.1:8787 npm run dev` (tmux panes). Start a task, then Ctrl-C the server while it is Running:
  - the pill shows `Offline · last synced HH:MM:SS · retrying`, the last state stays visible, the UI does **not** switch to `Mock · browser`;
  - an action shows `Can't reach the backend at http://127.0.0.1:8787.`;
  - restart `npm run server` → within 30 s the pill is `Live`, the task shows Failed `Interrupted by a server restart`, the stream URL carries the new boot id, and the activity list has no duplicated entries.
- [ ] **Step 4: Screenshots** (JPEG, into `docs/screenshots/milestone-3b1/`): `stage-d-backend-live.jpg` (badge, note, Live), `stage-d-approval.jpg` (approval card over the backend), `stage-d-offline.jpg` (Offline pill after the kill).
- [ ] **Step 5: Final checks** `npm test`, `npm run build`, `npm run check:secrets` — all pass; record the test counts.
- [ ] **Step 6: Tick the three Stage D boxes in `tasks.md`**, update its Status line (Stage D in review), commit `docs: record stage D checks and screenshots`.
- [ ] **Step 7: PR** — push `feat/frontend-remote-workforce` and open a PR into `main` titled `feat(workforce): milestone 3B.1 stage D — frontend integration with the local backend`. Body: summary, what changed per task, the check results from Steps 1–5 with the screenshots, the statement "The backend runs the mock runtime only; the Claude Agent SDK is not installed or integrated, and no AI is run", the Review Focus list from this plan, and the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Non-goals (this stage)

- Workspace picker in the task form (`workspaceId` stays unset; the API accepts it optionally).
- Stall detection beyond the browser's own connection error (the server's 15 s heartbeat keeps proxies open; a silent half-open socket after laptop sleep recovers on the next error).
- Optimistic updates for any command other than the created agent.
- Any server change, README or final report (Stage E).
