# 3B.1 Stage A: Shared Lifecycle v2 and Storage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the shared workforce model to task lifecycle v2: starting, waiting for approval, cancelling, timeouts, and end reasons. Add approval requests to the browser mock with Approve / Deny, and migrate saved v1 data once under a new storage key. All of this stays in the browser, with no server yet.

**Architecture:**
- The model stays one set of pure modules in `src/workforce/`, which the Stage B server will import.
- `applyRuntimeEvent` stays the only place runtime events change state, now with order checks (an event that doesn't fit the task's current state is ignored).
- New pure operations cover what the runtime doesn't decide: `markStarting`, `requestCancel`, `decideApproval` and `timeOutTask`.
- Storage gains schema v2 under `ai-virtual-office:workforce:v2`, with a one-time migration from the untouched `:v1` key.

**Tech Stack:** TypeScript 5.7, React 19, Vitest 5. No new dependencies.

**Spec:** `plan.md` §4 and §7, and `tasks.md` (decisions 4 and 5, Stage A, and the Q1–Q5 answers).

## Global Constraints

- **Task statuses**, exactly: `queued`, `starting`, `running`, `waiting_for_approval`, `completed`, `failed`, `cancelling`, `cancelled`. **Agent statuses are unchanged**: `idle`, `thinking`, `working`, `waiting`, `error`, `completed`.
- **Agent-status mapping:**
  - queued → idle;
  - starting → thinking;
  - running → thinking or working (from progress), with `started` giving thinking;
  - waiting_for_approval → waiting;
  - cancelling → unchanged;
  - completed → completed;
  - failed → error;
  - cancelled → idle.
- **Active statuses:** `queued`, `starting`, `running`, `waiting_for_approval`, `cancelling`. Still one active task per agent.
- **Storage:**
  - new key `ai-virtual-office:workforce:v2` and backup key `ai-virtual-office:workforce:v2:backup`;
  - `ai-virtual-office:workforce:v1` is read only for the migration and is never written or removed;
  - `WORKFORCE_SCHEMA_VERSION = 2`.
- **Copy:**
  - mock approval summary: `Simulated request to write a file`, with tool `Write`;
  - deny result: `Approval denied (simulated)`;
  - timeout: `Timed out after <n> s`;
  - interrupted: `Interrupted by page reload (simulated run)` (unchanged).
- **Notice copy, by what happened to the unreadable data:**
  - `backup-created`: `Saved agents couldn't be loaded, so none are shown. The saved data was backed up.`
  - `backup-exists`: `Saved agents couldn't be loaded, so none are shown. An earlier backup already exists, so this data was not backed up and your next change replaces it.`
  - `left-in-place`: `Saved agents from the previous version couldn't be loaded, so none are shown. That data is left untouched.`
- Code style follows `src/workforce/`: pure functions, the same reference returned when nothing changed, one-line types.

## Review Focus

1. **A runtime event that arrives out of order:** a second `started`, `approval_requested` while not running, or `progress` while waiting. It must be ignored, returning the same state (Task 1 tests). This closes the deferred 3A minor about a second `started`.
2. **Saved v1 data with a task mid-run, or a `task-waiting` activity.** It migrates, then the reload recovery fails the run, and the result passes the v2 parser (Task 2 test).
3. **Approve or Deny clicked twice, or for a stale approval id.** The second click is a no-op (Task 1 and Task 3 tests).
4. **Cancel while a task is queued, starting, waiting for approval, or already cancelling.** It ends as `cancelled` exactly once, and the agent becomes idle (Task 1 and Task 3 tests).
5. **v1 data that is corrupt.** The v1 key is never written, there's no v2 backup, and the `left-in-place` notice shows (Task 2 test).

---

## File Structure

| File | Change |
|---|---|
| `src/workforce/types.ts` | Lifecycle v2 types, new task fields, new activity variants |
| `src/workforce/operations.ts` | v2 transitions, order checks, `markStarting`, `requestCancel`, `decideApproval`, `timeOutTask`, recovery v2 |
| `src/workforce/runtime/types.ts` | `RuntimeEvent` v2, `respondToApproval`, new demo controls |
| `src/workforce/storage.ts` | Schema v2, `:v2` keys, `migrateWorkforceV1`, `preserved` result |
| `src/workforce/runtime/mockRuntime.ts` | `requestApproval` / `respondToApproval` replace `forceWaiting` / `resume` |
| `src/workforce/runtime/claudeRuntime.ts` | `respondToApproval` no-op, comment updated |
| `src/workforce/controller.ts` | `startTask` via `markStarting`, cancel via `requestCancel`, `decideApproval`, new demo controls, `preserved` in the snapshot |
| `src/workforce/view.ts` | New task status labels |
| `src/workforce/ui/AgentDetail.tsx` | Approval card with Approve / Deny, and new demo buttons |
| `src/App.tsx`, `src/styles.css` | Notice copy by `preserved`; task-card styles for the new statuses |

---

### Task 1: Lifecycle v2 model and operations

**Files:**
- Modify: `src/workforce/types.ts`, `src/workforce/operations.ts`, `src/workforce/runtime/types.ts`
- Test: `src/workforce/operations.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export const WORKFORCE_SCHEMA_VERSION = 2
  export type TaskStatus = 'queued' | 'starting' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelling' | 'cancelled'
  export type TaskRuntime = 'mock' | 'claude'
  export type TaskEndReason = 'completed' | 'failed' | 'cancelled' | 'timeout'
  export type PendingApproval = { id: string; tool: string; summary: string; requestedAt: string }
  // AgentTask gains: timeoutMs: number | null; runtime: TaskRuntime; sessionId: string | null; endedReason: TaskEndReason | null; pendingApproval: PendingApproval | null
  // AgentActivity: remove 'task-waiting'; add
  //   { type: 'task-approval-requested'; approvalId: string } | { type: 'task-approval-decided'; approvalId: string; decision: ApprovalDecision }
  //   | { type: 'task-cancelling' } | { type: 'task-timed-out' } | { type: 'agent-message' }
  export type ApprovalDecision = 'approve' | 'deny'
  ```
- Produces (`runtime/types.ts`):
  ```ts
  export type RuntimeEvent =
    | { type: 'started'; taskId: string; executionId: string; sessionId?: string }
    | { type: 'progress'; taskId: string; step: 'thinking' | 'working'; message: string }
    | { type: 'message'; taskId: string; text: string }
    | { type: 'approval_requested'; taskId: string; approvalId: string; tool: string; summary: string }
    | { type: 'completed'; taskId: string; summary: string }
    | { type: 'failed'; taskId: string; error: string }
    | { type: 'cancelled'; taskId: string }
  // RuntimeProvider gains: respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): void
  export interface MockDemoControls { requestApproval(taskId: string): void; forceError(taskId: string, message?: string): void }
  ```
- Produces (`operations.ts`):
  ```ts
  export function assignTask(s, agentId, input: TaskInput, now: string, opts?: { runtime?: TaskRuntime; timeoutMs?: number | null }): OpResult<{ taskId: string }>  // defaults 'mock', null
  export function markStarting(s: WorkforceState, taskId: string, now: string): WorkforceState      // queued → starting only
  export function requestCancel(s: WorkforceState, taskId: string, now: string, source: ActivitySource): WorkforceState  // queued → cancelled; starting/running/waiting_for_approval → cancelling
  export function decideApproval(s: WorkforceState, taskId: string, approvalId: string, decision: ApprovalDecision, now: string, source: ActivitySource): WorkforceState  // waiting_for_approval with matching id → running
  export function timeOutTask(s: WorkforceState, taskId: string, now: string, source: ActivitySource): WorkforceState   // any active → failed, endedReason 'timeout'
  export function cancelTask(...)  // unchanged signature: forces any active task to cancelled (lost runtime, grace expiry)
  export const TIMEOUT_MESSAGE: (timeoutMs: number) => string   // `Timed out after ${Math.round(ms / 1000)} s`
  ```
- **Accepted states for each event in `applyRuntimeEvent`.** Anything else returns the same state.

  | Event | Accepted when the task is |
  |---|---|
  | `started` | `starting` |
  | `progress`, `message` | `running` |
  | `approval_requested` | `running` |
  | `completed`, `failed` | `running`, `waiting_for_approval` or `cancelling` |
  | `cancelled` | any active state |

- **What each end state sets:**
  - `completed` sets `endedReason: 'completed'`, `pendingApproval: null` and `completedAt`;
  - `failed` sets `endedReason: 'failed'`;
  - `cancelled` sets `endedReason: 'cancelled'`.
- **The `message` event** adds an `agent-message` activity and changes no status.
- **`decideApproval`** logs `task-approval-decided`, clears `pendingApproval`, sets the task to `running` and the agent to `working`.
- **`recoverInterruptedTasks`:** `starting`, `running` and `waiting_for_approval` become `failed` (interrupted), and `cancelling` becomes `cancelled`.

- [ ] **Step 1: Rewrite the lifecycle tests first** in `operations.test.ts`. Keep the Stage A agent tests, and replace the task and event blocks:
  - `assignTask creates a queued v2 task` asserts the new fields: `timeoutMs: null`, `runtime: 'mock'`, `sessionId: null`, `endedReason: null`, `pendingApproval: null`.
  - `markStarting moves queued to starting and the agent to thinking`; a second call returns the same state.
  - `walks starting → started → progress → approval → approve → completed`: check each status, the agent mapping, `executionId`/`sessionId`, the `pendingApproval` contents, the `task-approval-requested` and `task-approval-decided` activities, and `endedReason: 'completed'`.
  - `ignores out-of-order events` (Review Focus 1): `started` while running, `approval_requested` while waiting, and `progress` while waiting each return `toBe(state)`; so does `started` while queued, because there was no `markStarting`.
  - `decideApproval ignores a stale id and a second decision` (Review Focus 3).
  - `requestCancel per state` (Review Focus 4): queued → cancelled (agent idle, `endedReason` cancelled); running → cancelling (agent unchanged), then a `cancelled` event → cancelled; a second `requestCancel` while cancelling → same state; a finished task → same state.
  - `timeOutTask fails with timeout`: `{ status: 'failed', endedReason: 'timeout', errorMessage: 'Timed out after 600 s' }` for `timeoutMs` 600000, a `task-timed-out` activity, and the agent at error.
  - `a message event logs agent-message without status change`.
  - `recoverInterruptedTasks v2`: starting, running and waiting become failed (interrupted), cancelling becomes cancelled, and queued stays.
  - Keep `blocks a second active task` (now including `starting`, `waiting_for_approval` and `cancelling`), and the removal and validation tests.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/workforce/operations.test.ts`. Expected: FAIL (missing exports / old statuses).
- [ ] **Step 3: Implement** the types, the runtime types and the operations above. `transitionFor` keeps its shape, with each event carrying the accepted states from the table.
- [ ] **Step 4: Run them and confirm they pass** (the same file). Expected: PASS. Other workforce test files may fail until Tasks 2 and 3; that is expected.
- [ ] **Step 5: Commit** with `feat(workforce): add task lifecycle v2 with approvals, cancelling and timeouts`

---

### Task 2: Storage schema v2 and v1 migration

**Files:**
- Modify: `src/workforce/storage.ts`, `src/workforce/demo.ts` (only if a field default is needed)
- Test: `src/workforce/storage.test.ts`, `src/workforce/demo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const WORKFORCE_STORAGE_KEY = 'ai-virtual-office:workforce:v2'
  export const WORKFORCE_BACKUP_KEY = 'ai-virtual-office:workforce:v2:backup'
  export const WORKFORCE_V1_KEY = 'ai-virtual-office:workforce:v1'
  export type Preserved = 'backup-created' | 'backup-exists' | 'left-in-place'
  export type WorkforceLoadResult = { state: WorkforceState; seeded: boolean; migrated: boolean; problem: WorkforceLoadProblem | null; preserved: Preserved | null }
  /** v1 JSON → v2 shape (not yet validated): waiting → waiting_for_approval with a legacy pendingApproval, new task fields, task-waiting → task-approval-requested. */
  export function migrateWorkforceV1(raw: unknown): unknown
  ```
- **The parser validates the new fields:**
  - `timeoutMs` is null or a positive integer;
  - `runtime` is in `TaskRuntime`;
  - `endedReason` is null for active tasks and set for finished ones;
  - `pendingApproval` is non-null exactly when the status is `waiting_for_approval`;
  - activity `approvalId` and `decision` are validated.
- **The migration fills:**
  - `timeoutMs: null`, `runtime: 'mock'`, `sessionId: null`;
  - `endedReason` from the status (completed, failed or cancelled; otherwise null);
  - `pendingApproval` for a waiting task as `{ id: 'legacy-<taskId>', tool: 'unknown', summary: 'Waiting for input (from an earlier version)', requestedAt: startedAt ?? createdAt }`;
  - a legacy `task-waiting` activity becomes `task-approval-requested` with `approvalId: 'legacy-<taskId>'`.
- **Load order:**
  1. Read `:v2`, unchanged behaviour (with `preserved` = `backup-created` or `backup-exists` when it is unreadable).
  2. If `:v2` is missing, read `:v1`:
     - missing → demo seed;
     - valid after the migration → `migrated: true`, then recovery;
     - unreadable → empty state, `problem: 'corrupt'`, `preserved: 'left-in-place'`, and no write to any key.
  3. The save path, unchanged, writes only `:v2` and the `:v2` backup.

- [ ] **Step 1: Update the tests first.** The existing storage tests now use the v2 keys and `preserved`. New tests:
  - `migrates saved v1 data once and leaves the v1 key untouched`: a v1 JSON string built by hand (with a completed task and a running task) loads with `migrated: true`; the completed task has `endedReason: 'completed'` and the running one becomes failed (interrupted); the v1 string is byte-identical afterwards; there is no `:v2` write until `saveWorkforce`.
  - `migrates a waiting task and task-waiting activity` (Review Focus 2): the result parses, and recovery fails the task.
  - `corrupt v1 is left in place` (Review Focus 5): `problem: 'corrupt'`, `preserved: 'left-in-place'`, and `touched` contains no `setItem` calls.
  - `reports backup-exists when an earlier backup is present`.
  - `rejects v2 inconsistencies`: `pendingApproval` on a running task, a missing `pendingApproval` while waiting, `endedReason` on an active task, a missing `endedReason` on a finished one, and an unknown `runtime`.
  - `never touches the layout key`, and `seeds the demo once`, both still pass with the new keys.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/workforce/storage.test.ts src/workforce/demo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the v2 parse, the migration, the load order and `preserved`.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** with `feat(workforce): add storage schema v2 with a one-time v1 migration`

---

### Task 3: Mock runtime, controller and UI

**Files:**
- Modify: `src/workforce/runtime/mockRuntime.ts`, `src/workforce/runtime/claudeRuntime.ts`, `src/workforce/controller.ts`, `src/workforce/view.ts`, `src/workforce/ui/AgentDetail.tsx`, `src/App.tsx`, `src/styles.css`
- Test: `src/workforce/runtime/mockRuntime.test.ts`, `src/workforce/runtime/claudeRuntime.test.ts`, `src/workforce/controller.test.ts`, `src/workforce/view.test.ts`, `src/workforce/workforce.test.ts`

**Interfaces:**
- **Mock runtime:**
  - `requestApproval(taskId)` works only on a running, non-waiting run. It clears the timers and emits `approval_requested` with `approvalId: createId('approval')`, `tool: 'Write'` and `summary: 'Simulated request to write a file'`.
  - `respondToApproval(taskId, approvalId, decision)` acts only when the id matches the pending one. Approve emits `progress` working, then `completed` after `workingMs`. Deny emits `failed` with `Approval denied (simulated)`.
  - `forceWaiting` and `resume` are removed. The timings are unchanged.
- **Claude placeholder:** gets `respondToApproval` as a no-op.
- **Controller (`WorkforceController`):**
  - remove `forceWaiting` and `resume`; add `requestApproval(taskId)` and `decideApproval(taskId, approvalId, decision)`;
  - the snapshot gains `preserved: Preserved | null`;
  - `startTask` = `assignTask` → `markStarting` → `runtime.start`, and a refused start → `failed`;
  - `cancelTask(taskId)` = `requestCancel` → `runtime.cancel` → `ops.cancelTask` (forced end if the runtime didn't answer);
  - `decideApproval` = `ops.decideApproval` → `runtime.respondToApproval`.
- **View:** `TASK_STATUS_LABEL` adds Starting, Waiting for approval and Cancelling.
- **AgentDetail:**
  - when the task is `waiting_for_approval`, it shows an `.approval-card` reading `Approval needed` with the tool, the summary, and **Approve** (primary) / **Deny** (danger) buttons;
  - the demo controls become **Simulate approval request** (only while `running`) and **Simulate error**;
  - **Cancel task** stays for any active status except `cancelling`.
- **App:** the workforce notice uses the three `preserved` texts from Global Constraints. For `unsupported-version` the copy stays the same apart from the backup sentence, which follows `preserved`.
- **CSS:**
  - `.task-card.starting,.task-card.cancelling{border-color:#3d4f45}` and `.task-card.waiting_for_approval{border-color:#5a4a33}`;
  - `.approval-card` reuses the `.task-card` look with an amber border;
  - the old `.task-card.waiting` rule is removed.

- [ ] **Step 1: Update the tests first:**
  - `mockRuntime.test.ts`:
    - `requestApproval then approve completes after workingMs`;
    - `deny fails with the simulated message`;
    - `respondToApproval ignores a stale id and a second answer` (Review Focus 3);
    - `requestApproval does nothing unless running`;
    - remove the waiting/resume tests.
  - `controller.test.ts`:
    - `startTask goes queued → starting → running → completed`;
    - `approval round trip through the controller`;
    - `cancel during waiting_for_approval ends cancelled once` (Review Focus 4);
    - `snapshot carries preserved`;
    - a refused start and a lost runtime still behave as before.
  - `view.test.ts`: the label table.
  - `workforce.test.ts`: the end-to-end run uses `markStarting`, and the trail is `task-assigned`, `task-started`, `progress:thinking`, `progress:working`, `task-completed`.
  - `claudeRuntime.test.ts`: `respondToApproval` emits nothing.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/workforce`. Expected: FAIL.
- [ ] **Step 3: Implement** the runtime, controller, view, UI, App and CSS changes.
- [ ] **Step 4: Full check.** Run `npx tsc -b --noEmit && npm test && npm run build`. Expected: everything passes, with only the existing chunk-size warning.
- [ ] **Step 5: Commit** with `feat(workforce): add approval requests to the mock runtime and panel`

---

### Task 4: Browser regression and PR

- [ ] **Step 1: Browser checks** on `npm run dev`, with the console clean:
  1. First load with empty storage seeds the demo under `:v2`, and nothing is written until a change.
  2. **Migration:** put a v1 JSON with a completed task in `:v1` and reload. It shows the history, and `:v1` is unchanged after a change.
  3. **Run:** Starting/Thinking → Working → Completed.
  4. **Approval:** Simulate approval request → the Approval needed card → Approve → Completed. Again → Deny → Failed with `Approval denied (simulated)`.
  5. **Cancel** while queued is not reachable through the UI, so I'll cancel while running and while waiting for approval.
  6. **The 3A checks still pass:** markers change colour (waiting while an approval is pending), desk clicks, Focus desk, the editor, a reload mid-run gives failed (interrupted), and corrupt `:v2` shows the `backup-created` notice.
- [ ] **Step 2: Tick the Stage A boxes in `tasks.md`.** Rebase onto `main` once #20 is merged. Push and open the PR with the check results.
