# Holding Tasks During Breaks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task given during lunch or prayer waits for the break to end, shows why and until when, stays cancellable, can be started at once with "Start now", and always starts or fails visibly.

**Architecture:** The server decides. `TaskManager` asks a pure schedule function whether the agent is on a holding break. If so, the task stays `queued` with a stored `hold` and no run, timer or provider call exists. A one-second check starts held tasks through the same path as any other task once no break holds them.

**Tech Stack:** TypeScript, React 19, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-office-presence-daily-life-design.md`, sections 4, 6.5, 6.6 and 8. This is slice 6 of section 7, the last slice of M3C.2. Do not start M4.

## Global Constraints

- **No runtime session, API call or timeout exists for a held task.** `provider.start` and the task timer happen only when it really starts. Timeout counts from the real start.
- A held task must never be dropped: it is cancelled by a person, starts, or fails visibly.
- A held task after a server restart fails with exactly: `The server restarted while this task was waiting. Start it again.` It never resumes on its own.
- Only events with `holds: true` hold a task (lunch, Friday, prayer). Coffee and chat do not. Outside those, a task starts at once, as today.
- `OFFICE_ROUTINE=off` disables holding. The browser-only demo never holds: its tasks start at once.
- Hold times are office time (`officeClockInfo(...).nowMs`, which follows `VO_DEV_CLOCK`). Task, audit and timeout times stay real.
- Prayer copy stays respectful and uses the schedule's own labels (`Praying`, `On lunch`, `Friday prayer and lunch`).
- Error text never names server paths.
- Tests and screenshots use a temporary `DATA_DIR` and the mock runtime, never the real `data/`. The repo is public.
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch: `feat/tasks-wait-during-breaks`, already checked out. Do not push or open a PR.

## Review Focus

1. Two Claude tasks held with a limit of 1 when the break ends: one starts, the other stays held and says why, then starts within a check of the slot freeing. Neither is lost.
2. "Takes prayer breaks" turned off during a hold: the task starts at the next check instead of waiting for the old time.
3. A hold that runs into the next break (prayer then lunch back to back, or a late check at high `VO_DEV_CLOCK` speed): the task keeps waiting and shows the new label and time. It must not start in between.
4. A task cancelled, or its agent removed, while held: nothing ever starts later, and the character does not jump or replay a walk.
5. Workspace removed or runtime unavailable during a hold: the task fails visibly with a fixed sentence and no paths, and the agent shows the error.

---

### Task 1: The shared model

**Files:**
- Modify: `src/office/schedule.ts`, `src/workforce/types.ts`, `src/workforce/operations.ts`, `src/workforce/storage.ts`, and every test fixture that builds a full `AgentTask` (`hold: null`)
- Test: `src/office/schedule.test.ts`, `src/workforce/operations.test.ts`, `src/workforce/storage.test.ts`

**Interfaces:**
- Produces in `schedule.ts`: `holdAt(agent: { id: string; takesPrayerBreaks: boolean }, nowMs: number): { label: string; untilMs: number } | null`. Finds the `holds` event covering `nowMs` (`startMs <= nowMs < endMs`) on that Jakarta day. `label` is that event's. `untilMs` extends through following holding events that start at or before the current end.
- Produces in `types.ts`: `export type TaskHold = { label: string; /** Office time, ms. */ untilMs: number; /** Why it is still waiting after its break, or null. */ blockedBy: string | null }`, and `hold: TaskHold | null` on `AgentTask` (required, like `pendingApproval`).
- Produces in `operations.ts`:
  - `HELD_RESTART_MESSAGE`, the exact sentence above.
  - `assignTask` opts gains `hold?: TaskHold | null`, stored on the task. A held task's activity message is `Assigned "<title>"; it starts after the break`.
  - `setTaskHold(s, taskId, hold: TaskHold): WorkforceState`: changes a queued held task's hold, with no activity. Returns `s` unchanged if the task is not queued and held, or the hold is equal by value.
  - `failHeldTask(s, taskId, now, message): WorkforceState`: queued and held → failed through the existing `failed` transition. Otherwise returns `s`.
- Changes: the `failed` and `cancelled` transitions set `hold: null`. `markStarting` clears `hold`, and when the task was held sets `startedAt: now`, so the walk home is timed from the release and not from `createdAt` (the `started` event overwrites it). `recoverInterruptedTasks` fails a queued task with a hold using `HELD_RESTART_MESSAGE`, whatever `message` it was given. A queued task with no hold stays. `clearAgentError` no longer treats a held task as blocking.
- `parseTask`: missing `hold` means null (no schema bump, as with `usage`). Rejects the state if `hold` is set on a non-queued task, `untilMs` is not finite, `label` is not non-empty text, or `blockedBy` is not text or null.

- [ ] **Step 1: Write the failing tests**

`schedule.test.ts`, with a fixed agent and day, reading times from `daySchedule` so offsets do not matter:
- `holdAt` is null during coffee, just before a lunch, and exactly at a holding event's `endMs` when nothing follows.
- During lunch it returns `{ label: 'On lunch', untilMs: lunch.endMs }`.
- During a prayer whose end meets the next holding event's start, `untilMs` is the later event's end and `label` is `Praying`. Find such a pair across dates in the test, or build the assertion from the day that has one.
- With `takesPrayerBreaks: false`, null during a prayer time.
- A Friday at 12:00 Jakarta returns `{ label: 'Friday prayer and lunch', untilMs: <13:00 Jakarta> }` for an agent with prayer breaks.

`operations.test.ts`:
- `assignTask` with a hold stores it, stays `queued`, and leaves the agent's status alone.
- `markStarting` on a held task clears `hold`, sets `startedAt`. On an unheld task `startedAt` stays null.
- Cancelling a held task through `requestCancel` gives `cancelled`, `hold: null`, agent `idle`.
- `failHeldTask` gives `failed`, the message, `hold: null`, agent `error`, and returns the same reference for an unheld task.
- `setTaskHold` returns the same reference for an equal hold.
- `recoverInterruptedTasks` fails a held task with `HELD_RESTART_MESSAGE` and leaves an unheld queued task alone.
- `clearAgentError` clears an agent in `error` that has a held task, and still refuses with a non-held active task.

`storage.test.ts`: an old saved task with no `hold` loads as null; a valid hold round-trips; each invalid case above rejects.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run src/office/schedule.test.ts src/workforce/operations.test.ts src/workforce/storage.test.ts`
Expected: FAIL on the missing `holdAt`, `setTaskHold` and `failHeldTask`.

- [ ] **Step 3: Implement it, and add `hold: null` to the fixtures**

- [ ] **Step 4: Verify**

Run: `npx vitest run && npx tsc -b`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit** `feat(workforce): tasks can record a break they are waiting for`

---

### Task 2: The server holds, releases and starts now

**Files:**
- Modify: `server/taskManager.ts`, `server/app.ts`, `server/http/routes.ts`, `server/audit.ts`, `server/test/helpers.ts`, and tests that need the routine on
- Test: `server/taskManager.test.ts`, `server/http/routes.test.ts`, `server/store.test.ts`, `server/officeRoutine.test.ts`

**Interfaces:**
- Consumes: `holdAt`, `TaskHold`, `setTaskHold`, `failHeldTask`, `HELD_RESTART_MESSAGE` from Task 1.
- Produces in `TaskManagerOptions`: `officeNow?: () => number`. Absent means no holding.
- Produces on `TaskManager`:
  - `releaseHeldTasks(): void`. For each queued held task, oldest first, with a try/catch per task that logs and carries on: `holdAt` says on break → `setTaskHold` with the new label and time and `blockedBy: null`; otherwise start it as below.
  - `startHeldTask(taskId, opts: CallOptions = {}): ManagerResult<{ task: AgentTask }>`, for "Start now". Not found → `not_found`. Not queued and held → `conflict`, `That task is not waiting for a break.`
- Produces in `server/app.ts`: `HOLD_CHECK_MS = 1000`. `startServer` runs `app.manager.releaseHeldTasks()` on an unref'd interval, like the permission sweep, and clears it in `close`.
- Produces in routes: `POST /api/tasks/:id/start-now`, `body: 'none'`, status 202, same shape as cancel.
- Produces in audit: new action `task.held` in `LifecycleAction` and `AuditAction`.

**How starting works.** Split the end of `startTask` (markStarting, `Run`, timer, report, `launch`) into one private method both paths use, so a held task goes through the same duplicate guard. Before it, a held task re-checks and handles what can change while waiting:
- Agent gone → nothing to do (`removeAgent` already dropped the task).
- Provider not registered or unavailable → `failHeldTask` with the existing `unavailableMessage`, or for an unregistered one, `The "<kind>" runtime is not enabled on this server.`
- `workspaceId` no longer resolves → `failHeldTask` with `WORKSPACE_COPY`, reporting `workspace.rejected`.
- Claude limit reached → stays held. `releaseHeldTasks` sets `blockedBy: 'Waiting for a free Claude slot. It starts as soon as one finishes.'`, and `startHeldTask` returns the same `conflict` text `startTask` gives, leaving the task held. Extract that text into one helper.

A hard failure is still `{ ok: true, task }` from `startHeldTask`: the failed task is the visible result.

**In `startTask`:** after the existing active-task check, compute `const hold = this.officeNow ? holdAt(agent, this.officeNow()) : null`. The Claude limit check runs only when not holding, since a held task uses no slot. With a hold, call `assignTask` with `{ ...hold, blockedBy: null }`, commit, report `task.held` (`detail` naming the until time), return `{ ok: true, task }`, and do not call `markStarting`. All earlier validation stays first, so a bad request is refused during a break too.

**Wiring in `server/app.ts`:** take `const officeRealNow = deps.officeNow ?? Date.now` and `const officeBootMs = officeRealNow()` once, and pass both to `createRoutes` (add `officeBootMs?: number` to its deps; it falls back to its current behaviour), so the manager and `/api/state` share one clock. Pass `officeNow: config.officeRoutine ? () => officeClockInfo(config, officeRealNow, officeBootMs).nowMs : undefined`.

**Tests stay deterministic:** `testConfig` defaults `OFFICE_ROUTINE: 'off'`, so existing suites never hold at random wall-clock times. Tests that assert `routine: true` pass `OFFICE_ROUTINE: 'on'` explicitly.

- [ ] **Step 1: Write the failing tests**

`taskManager.test.ts`, with an injected `officeNow` variable and a day and agent whose lunch window comes from `daySchedule`:
- `held during lunch: stays queued, records the hold, provider never started, no run`: `fake.starts` is empty and no timer fires. Advance real timers past `taskTimeoutMs`: the task is still queued.
- `releases when the break ends and counts the timeout from then`: move `officeNow` past lunch, call `releaseHeldTasks`, `fake.starts` has the task once. A second call does not start it again. The timeout fires `taskTimeoutMs` after release, not after creation.
- `coffee does not hold`, and `no officeNow means no holding`.
- `a bad request during a break is still refused` (missing workspace on claude, duplicate active task).
- `a held task does not count against the Claude limit`, and `the agent's second task during a hold is a conflict`.
- `cancel a held task`: cancelled, `provider.cancel` never needed, and a later `releaseHeldTasks` starts nothing.
- `remove an agent with a held task`: gone, and a later release starts nothing.
- `Start now`: starts through the normal path once, `task.start` reported with actor `api`. A second call is `conflict`. On a running task, `conflict`. Unknown id, `not_found`.
- `Start now at the Claude limit`: `conflict`, still held.
- Review Focus 1: limit 1, two held Claude tasks, break ends, `releaseHeldTasks`: first runs, second stays queued with the `blockedBy` sentence. Finish the first, call again: second starts, and `blockedBy` was never lost as a dropped task.
- Review Focus 2: prayer setting off during a prayer hold: the next `releaseHeldTasks` starts it.
- Review Focus 3: `officeNow` moved into a later holding event: still queued, hold updated to that label and time.
- Review Focus 5: workspace unconfigured during a hold, provider unavailable during a hold: `failed`, fixed sentence, agent `error`, `fake.starts` empty.
- `one bad task does not stop the others in a check`.

`store.test.ts`: a data file with a held task reopens as `failed` with `HELD_RESTART_MESSAGE`, agent `error`.

`routes.test.ts`: over HTTP with `OFFICE_ROUTINE: 'on'` and an injected `officeNow` at a lunch time: `POST /api/agents/:id/tasks` gives 202 with `task.hold` set; `POST /api/tasks/:id/start-now` gives 202 and the task leaves `queued`; again gives 409; an unauthenticated call gives 401. `OFFICE_ROUTINE: 'off'` at the same time starts at once. The SSE/state patch carries `hold` to `/api/state`.

`officeRoutine.test.ts`: a task given during a hold with a provider registered: `provider.starts` stays empty until release.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run server/taskManager.test.ts server/http/routes.test.ts server/store.test.ts server/officeRoutine.test.ts`
Expected: FAIL on the missing `releaseHeldTasks`, `startHeldTask` and route.

- [ ] **Step 3: Implement it**

- [ ] **Step 4: Verify**

Run: `npx vitest run && npx tsc -b`
Expected: all pass, including `server/noProcessExecution.test.ts`.

- [ ] **Step 5: Commit** `feat(office): hold a task during lunch and prayer, with Start now on the server`

---

### Task 3: The browser shows it

**Files:**
- Modify: `src/workforce/controller.ts`, `src/workforce/remote/commands.ts`, `src/workforce/view.ts`, `src/scene/labels.ts`, `src/scene/DeskMarkers.tsx`, `src/workforce/ui/AgentDetail.tsx`, `src/styles.css` only if an existing class does not fit, plus any fake or controller that must implement the new action
- Test: `src/workforce/view.test.ts`, `src/workforce/ui/AgentDetail.test.tsx`, `src/workforce/remote/commands.test.ts`, the labels test, `src/workforce/controller.test.ts`

**Interfaces:**
- Consumes: `AgentTask.hold` from Task 1; `POST /api/tasks/:id/start-now` from Task 2.
- Produces in `controller.ts`: `startHeldTask(taskId: string): Awaitable<ActionResult>`. The local controller returns `{ ok: false, error: 'Only the server holds tasks during breaks.' }`, because a browser-only task is never held.
- Produces in `commands.ts`: `startHeldTask: (taskId) => result('POST', '/api/tasks/<id>/start-now')`, added to `RemoteCommands`.
- Produces in `view.ts`: `heldTaskText(hold: TaskHold): string`. `blockedBy` when set, otherwise `<label> · starts around <HH:MM>`, for example `On lunch · starts around 13:00`, in Jakarta time from `untilMs` (reuse `clockText`).
- Changes in `view.ts`:
  - `agentStatusText` returns `heldTaskText` for a held task.
  - `markerPhase` returns null for a held task, so the marker shows the break.
  - `DeskMarker` gains `held: string | null`, and `deskMarkers` fills it.
  - `markerText(name, presenceLabel, phase, held = null)` returns `<name> · <held>` when `held` is set, ahead of the presence label. `DeskMarkers.tsx` passes it.
  - `removalPrompt` says `<name> has "<title>" waiting for a break. Removing the agent cancels the task and deletes its history.` for a held task.
  - `routineAgents`: a held task gives `activeSince: null`, so the agent keeps living its break. A task with `startedAt === null` never counts towards `busyUntil`, so cancelling a held task does not make the character jump or walk again.
- Changes in `AgentDetail.tsx`: when `task.hold`, the task card shows `heldTaskText` in `role="status"`, and a `Start now` button (primary, with a busy guard, errors in the existing `actionError`) sits beside `Cancel task`.

- [ ] **Step 1: Write the failing tests**

- `view.test.ts`: `heldTaskText` gives `On lunch · starts around 13:00` for a known `untilMs`, including a viewer whose timezone differs (the text stays Jakarta), and the `blockedBy` text when set. `agentStatusText` and `deskMarkers` use it. `routineAgents` gives `activeSince: null` for a held task and the release time for a held-then-started task, and a cancelled held task leaves `busyUntil` unchanged. `removalPrompt` copy.
- labels test: `markerText('Massen', 'On lunch', null, 'On lunch · starts around 13:00')` is `Massen · On lunch · starts around 13:00`.
- `AgentDetail.test.tsx`: held task shows the text and `Start now`; clicking calls `startHeldTask` with the task id; a refusal shows its error; `Cancel task` is still there; an unheld running task has no `Start now`.
- `commands.test.ts`: add the row `{ action: 'startHeldTask', call: (c) => c.startHeldTask('t1'), method: 'POST', path: '/api/tasks/t1/start-now' }`.
- `controller.test.ts`: the browser-only `startTask` never holds, and `startHeldTask` returns the sentence above.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run src/workforce src/scene`
Expected: FAIL on the missing `heldTaskText` and `startHeldTask`.

- [ ] **Step 3: Implement it**

- [ ] **Step 4: Verify**

Run: `npx vitest run && npx tsc -b && npx vite build`
Expected: all pass, and the build succeeds.

- [ ] **Step 5: Docs**

- `README.md`: in the daily routine section, explain that a task given during lunch or prayer waits and how it shows; "Start now" and cancel; the restart rule. Update the `OFFICE_ROUTINE` row: `off` also means tasks are never held. Remove anything saying tasks start at once during breaks.
- `MASTER-ROADMAP.md`: line 44 and the M3C.2 section: status `IN PROGRESS: all slices built, owner's review pending`. Tick the "waits until the break ends" criterion and the others this work and slices 4 and 5 satisfy, marking walking and prayer as done with full prayer movements deferred. Do not mark the milestone complete: the owner's review is still open. Do not touch M4.

- [ ] **Step 6: Commit** `feat(office): show a waiting task with Start now, and document holding`

---

### Task 4: Browser check and PR (the coordinator, not the implementer)

Run on a temporary `DATA_DIR` with the mock runtime and `VO_DEV_CLOCK` at about `×60`, starting a few minutes before lunch, never the real `data/`.

- [ ] Give a task during lunch: the card and label read `On lunch · starts around …`, and the character stays at lunch.
- [ ] Let the break end: the task starts and the character walks home.
- [ ] Give another during a break and press **Start now**: it starts at once.
- [ ] Give another and press **Cancel task**: it ends and the character carries on with no jump.
- [ ] Restart the server with a task held: it shows the restart sentence.
- [ ] Save a screenshot to `docs/screenshots/holding-tasks/`, mock data only.
- [ ] Open the PR against `main`, and ask the owner to watch a task wait out a break, as section 8 of the spec requires.
