# Milestone 3B.4 — final blockers report

Date: 2026-11-03. Branch `fix/3b4-final-blockers`, based on `main` at `f9c16b6` (#58). Scope: B9, B10 and the task workspace picker, nothing else. No SDK, no real Claude execution, no Docker, no Bash change; the 3D office, layout editor and `MockRuntimeProvider` are untouched.

## Audit (before changing anything)

`main` was clean at `f9c16b6`. PRs #45, #47, #48, #51, #52, #55, #56 and #57 are all in its history (checked with `git log`, one commit each). Findings from reading the code, not from the closing report:

- Permissions: `server/permissions/store.ts` holds the rules; `TaskManager.finalize` calls `permissions.endTask` only when a task ends in this process.
- Restart: `server/store.ts` runs `recoverInterruptedTasks` at load, which fails interrupted tasks in the workforce state and does nothing to permissions.
- Redaction tests: `server/redact.test.ts` asserted fixed wall-clock budgets (50, 250 and 500 ms).
- Task creation: the backend already validated `workspaceId` (400 malformed, 422 unregistered), stored it on the task and bound it into the action digest; `GET /api/workspaces` returned ids. The UI never sent a workspace.

## 1. B9 — stale task rules after a restart

**Root cause.** A task's rules end only in `finalize`, in the process that ran it. A restart marks the task failed through state recovery, but nobody ended its `task` and `once` rules, so `permissions.json` kept them active. They were inert in practice (the task is dead and its id is never reused) but not fail-closed, and the Global and Agent views showed them as active. Reproduced first: the new restart test failed with the rule still active after a restart.

**Resolution.** `PermissionStore.reconcile({ liveTaskIds, agentIds })` (`server/permissions/store.ts`), called from `createApp` before the task manager exists:

- ends every active `task` and `once` rule whose task is not live. At boot nothing is live, so all of them end;
- revokes every active agent, task and once rule of an agent that is not in the workforce state;
- keeps global rules and agent rules of existing agents, which the spec says outlive a restart;
- writes the file, emits `permission.changed` and audits each ended rule as `permission.ended` (actor `system`, reason `restart`, with the agent and task ids). Revoked orphans use the existing `permission.revoked`.

Expired rules need no action: a rule's state is computed from its expiry at every request. History is untouched: the rules stay in the file as ended or revoked, and the earlier `permission.granted` audit records remain.

**Tests.** Four store tests (ends orphaned task and once rules, keeps agent and global rules, keeps a live task's rules, revokes rules of a missing agent, idempotent) and one integration test through the real server: grant `allow_task` and an agent rule, close the server, start a new one on the same data folder, and check the task rule is gone from `/api/permissions` and in history as `ended`, the agent rule remains, the task is `failed`, `evaluate` no longer allows the dead task's Write, and the audit holds `permission.ended` and the original `permission.granted`.

## 2. B10 — intermittent redaction test failures

**Root cause.** Wall-clock assertions on a single run. `server/redact.test.ts` required, for example, 250 ms for four hostile inputs and 50 ms for others, so any slowdown of the machine failed a correct, linear scan. Reproduced: with every core busy the JWT test failed 2 of 6 runs (291 ms and 252 ms against 250). `server/secrets.test.ts` has no timing assertion in a redaction path; its only timing dependence is a 1.5 s polling deadline in a test that starts a real server. It did not fail in 12 runs under the same load, so that failure from stage D was **not reproduced**; the deadline was made a hang guard (20 s: a condition that holds still returns at the next 10 ms poll) as a precaution.

**Resolution.** `server/test/scaling.ts` (`measureScaling`) replaces the budgets with a check on how the cost grows. It grows the input until the smaller run takes at least 4 ms, then times an input 8 times larger and requires the cost to grow by less than 40 times (linear is 8, quadratic is 64). It measures process CPU time, not the wall clock, and keeps the fastest of five runs. `server/test/scaling.test.ts` proves the helper tells linear from quadratic. Every hostile input from the old tests is kept and a regression to quadratic time still fails. The redaction correctness assertions are unchanged.

**Limits found while tuning.** First attempt (ratio limit 8, wall clock) still failed under load, and so did CPU time with a limit of 23: under full CPU contention the 'many urls' case grows 23 to 27 times for 8 times the input (GC and cache pressure), while idle it is linear. The limit of 40 sits above that and below 64, which means a mild superlinear regression (about n^1.5) would not be caught; only a quadratic one would. The helper's comment says so.

**Stability.** Redact, secrets and scaling files, 10 runs idle: 84 of 84 each time. 15 runs with four busy loops on four cores: 0 failures (before: 3 of 10 with an earlier version and 2 of 6 originally). The whole suite twice under the same load: 1546 of 1546 both times.

## 3. Workspace picker

**What exists on the server (unchanged):** workspaces come only from `WORKSPACE_ROOT` and `WORKSPACES`; `POST /api/agents/:id/tasks` accepts `workspaceId`, refuses an unregistered one (422) or a malformed one (400) and starts no task; the id is stored on the task and in the audit; the approval digest covers the task, the workspace id and path, the tool and the input; a decision whose digest is not the pending one is refused (409); task and agent allows need a digest, so without a workspace only Once is accepted.

**What was added (frontend):**
- `GET /api/workspaces` is loaded with each snapshot (`sync.ts`) and kept as `workspaces: string[] | null` on the snapshot; `null` in browser mode, `[]` if the call fails or is malformed.
- The task form (`AgentDetail.tsx`, `TaskForm`) shows a **Workspace** select (default "No workspace", then each id) only when there is at least one. `startTask(agentId, input, { workspaceId })` sends it; the remote command omits the field when none is chosen.
- The task card shows `Workspace <id>`.
- The approval card is unchanged: it already offers Once, This task and This agent only for an approval that has a digest and a review. A workspace is what gives the approval one.
- Browser mode and `MockRuntimeProvider` behave as before (no select, no request).

**No frontend authorization.** The list is a convenience; the browser cannot register a workspace. New server tests (`server/workspacePicker.test.ts`) check that only ids and never paths are listed, that an unregistered id is refused with no task created, that two tasks in two workspaces get different digests and reviews naming their own workspace, that one task's digest cannot decide another's approval (409, no rule created), and that without a workspace the digest is null and `allow_task` and `allow_agent` are refused with no rule created.

**Browser check** (headless Chromium via `playwright-core`, `npm run dev:full`, two workspaces; screenshots in `docs/screenshots/3b4-final/`): the form listed the two workspaces; after choosing one the card showed the workspace; the simulated approval offered Once, This task and This agent; Allow for This task (after opening the change) created a rule that the permissions panel lists as `Write · Allowed · One task · Pixel`. Console: only the known favicon 404. Not checked: keyboard use, narrow layout, pairing without the proxy.

## 4. Changed files

Code and tests (20 files, +345 / -50, excluding docs):

- Server: `server/app.ts`, `server/audit.ts`, `server/permissions/store.ts`
- Server tests: `server/permissions/store.test.ts`, `server/permissionsWiring.test.ts`, `server/redact.test.ts`, `server/secrets.test.ts`, `server/test/scaling.ts` (new), `server/test/scaling.test.ts` (new), `server/workspacePicker.test.ts` (new)
- Frontend: `src/workforce/controller.ts`, `src/workforce/remote/commands.ts`, `src/workforce/remote/remoteController.ts`, `src/workforce/remote/sync.ts`, `src/workforce/ui/AgentDetail.tsx`
- Frontend tests: `src/workforce/controller.test.ts`, `src/workforce/remote/commands.test.ts`, `src/workforce/remote/sync.test.ts`, `src/workforce/ui/AgentDetail.test.tsx`, `src/workforce/ui/PairingForm.test.tsx`
- Docs: this report, `docs/screenshots/3b4-final/` (3 screenshots)

## 5. Tests and builds (real runs, branch tip `a9c3faa` plus this report)

| Check | Result |
|---|---|
| `npm test` | 92 files, 1546 tests pass (1529 before; +17) |
| `npm test` with four busy loops, twice | 1546 of 1546 both times |
| Permission recovery (`store.test.ts`, `permissionsWiring.test.ts`) | 22 and 10 pass |
| Redact, secrets, scaling, 10 repeats | 84 of 84 each time |
| Workspace picker (`workspacePicker.test.ts`, plus the frontend tests above) | 4 pass; frontend 569 pass |
| Real HTTP/SSE e2e (`server/e2e/realServer.test.ts`) | 13 of 13 |
| `npx tsc -b` | clean |
| `npm run build`, `npm run server:build` | both built (the existing chunk-size warning only) |
| `npm run check:secrets` | no secrets found (12 files checked) |
| `npm audit` | 0 vulnerabilities |

## 6. Latest verified Git HEAD

The branch is `main` at `f9c16b6` plus four commits (tip `a9c3faa`, then this report). All checks above ran on that tree. They were **not** run on a merged `main`, which does not exist yet: re-run the table's first, tsc, build and audit rows on `main` after merging.

## 7. Remaining security limitations

- Native host execution has no OS sandbox; path and workspace checks are policy, not isolation. Same-user processes share the token and data folder (see `docs/native-host-execution.md`).
- Rules revoked at boot because their agent is gone are audited with actor `api` (the store's generic revoke path), not `system`.
- The expiry sweep reports each expired rule once per process, so an old expired rule is audited as `permission.expired` again after every restart. Harmless to enforcement, noisy in the audit log; not fixed (out of scope).
- The workspace list is loaded when the browser connects, not live: a workspace added to the server config appears after a reload. The server checks every id regardless.
- The cookie pairing screen still has no real-browser check; there is no DOM test library.
- Revoke aborts an in-flight call only if the tool honours the signal, and a running file operation is not interrupted (stage E limit).
- Bash stays always denied; WebFetch and WebSearch stay denied by default.
- B11 (no Bash command parsing), the single 1.3 MB frontend chunk and the missing coverage tool are untouched.

## 8. Readiness for Milestone 3B.5

**Ready to plan, with two conditions.** B9, B10 and the workspace picker are closed, so none of the mandatory pre-runtime issues from the closing report remain, and a person can now reach every scope choice from the UI. Before the first real runtime: (1) merge this branch and re-run the final checks on `main`; (2) decide whether to fix the repeated `permission.expired` audit entries, since a real runtime will make the audit log matter more. The remaining items (real SDK abort and message mapping, the pairing browser check, B11) belong to 3B.5 itself.
