# Milestone 3B.4 stage C: permission API and live events — report

Date: 2026-11-01. Plan: `docs/superpowers/plans/2026-11-01-milestone-3b4-stage-c-permission-api.md`. Earlier reports: `docs/milestone-3b4-stage-a-report.md`, `docs/milestone-3b4-stage-b-report.md`.

Backend only. The frontend is unchanged and keeps working: it does not subscribe to the new event and `applyWorkforceEvent` ignores it. Still true: no SDK, no real Claude execution, mock runtime only, no tool performs real file access yet (stage E).

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npm test` | 77 files, 1168 tests pass (1121 before; +47) |
| `npx tsc -b` | clean |
| `npm run build` | built (the existing chunk-size warning only) |
| `npm run check:secrets` | no secrets found |

**Known flake, not from this stage:** `server/redact.test.ts` "finds a JWT anywhere in a run of text and stays linear on hostile input" has a hard 250 ms budget and fails now and then when the whole suite runs in parallel. It also failed on clean `main` (1 of 4 full runs) and passes alone every time. It was not changed. Raising or relaxing its budget is a one-line follow-up if you want it.

## What changed

- **Routes** (all behind the existing Host, Origin, token and JSON-only guards): `GET /api/permissions` (active rules), `GET /api/permissions/history` (no longer in force, newest first, at most 200), `POST /api/permissions` (creates **global and agent rules only**; task and once rules still come only from approvals), `DELETE /api/permissions/:id`, `DELETE /api/agents/:id/permissions`.
- **Validation:** strict parsing (unknown keys are 400); the stage A `validateGrant` decides the rest, each refusal with its own fixed sentence; an unknown agent is 404; a full store is 409; revoking twice is 409; an unknown id is 404. An execute or network tool can never be allowed above once, so the API cannot create `allow Bash` for an agent or everyone.
- **Wire shape:** `PermissionRuleView` (the rule plus its current `state`; no digest, no server path) in `src/workforce/api.ts`.
- **Live events:** `permission.changed` (`granted`, `revoked`, `used`, `ended`, `expired`) goes through the same event log as workforce events: same id sequence, same buffer, same replay with `Last-Event-ID`.
- **Revoke reaches a running call:** each gated call now gets its own abort signal (it also aborts with the task's). Revoking a `task` or `once` rule aborts the calls that rule allowed that are still running; revoking an `agent` or `global` rule changes only what comes next (spec 4.4). `revokeAgentPermissions` does the same for all of an agent's task and once rules.

## Security implications

- The server is the only authority: the browser can only call these routes, which go through the same store, validation, audit and guards as everything else. Every grant and revoke made over HTTP is audited (`permission.granted`, `permission.revoked`).
- Nothing in the views can be used to forge an approval: no digest is exposed, and approvals still need the exact pending id and digest.
- A global `allow` for `Write` or `Edit` can now be created by a person over the API. That is the point of "Global Permission Settings", and it still passes through validation, review building, workspace checks and the use-time re-check. Until stage E it covers the whole workspace (no sensitive-path denylist yet), as noted in the stage B report.
- A revoked default (for example `default-bash`) stays revoked; with no rule, the request is denied by default. Nothing is ever allowed by the absence of a rule.
- Aborting an in-flight call is cooperative: it works only if the tool's `perform` honours the signal. The mock's does not need to; stage E's `fileOps` must (it checks the signal before every step).

## Rulings made during implementation

1. Revoke aborts in-flight calls only for task and once rules, as the spec says, and does not cancel the task. Cancelling the whole task on a revoke was rejected as too heavy.
2. `permit` now returns the allowing rule's id, and a new `track` step registers the call right after it with nothing in between, so a revoke cannot slip between the check and the registration.
3. `permission.changed` is not added to `WORKFORCE_EVENT_TYPES`; the existing frontend therefore never sees it. Stage F will opt in.
4. Revokes are audited as `api` (they only come from the API or from agent removal); expiry as `system`.
5. History is the rules no longer in force, not a log of decisions; decisions stay in the audit log, which is not exposed over HTTP.

## Review

Author self-review only; no independent reviewer ran. Worth a look before stage F builds on it: `trackCall` and `abortCallsOf` in `server/taskManager.ts` and the `track` step in `server/toolGate.ts`.

## Remaining for the next stages

- **D:** browser session cookie, so the app no longer needs the dev proxy for these routes.
- **E:** `fileOps`, sensitive-path denylist and the `vo_*` tools (they must honour the abort signal).
- **F (UI):** the requests waiting behind a pending approval are held in memory only and are **not visible** in state or over the API, so the pending list can show only the one pending approval per task until something exposes the queue (a small `queued` count or list on the task would do). Also path pattern choice when allowing for a task or agent.
- **G:** end-to-end test and report.
