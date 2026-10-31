# Milestone 3B.4 Stage C: Permission API and Live Events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The browser (stage F) can list, create, revoke and review permissions over HTTP and see every change live over SSE; revoking a running task's permission aborts the call in flight. Backend only.

**Architecture:** A path-free `PermissionRuleView` is the wire shape. `EventLog` gains `appendPermission`, so `permission.changed` events share ids, replay and the buffer with workforce events but are not applied to workforce state. Routes call the store through two new manager methods that also abort in-flight calls. The tool gate gives each call its own abort signal, registered by the rule that allowed it.

**Spec:** `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md` (4.4 revoke, 4.5 API and events). Stage B report: `docs/milestone-3b4-stage-b-report.md`.

## Global Constraints

- Branch `feat/3b4-c-permission-api`; conventional commits with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Every route sits behind the existing guard chain (Host, Origin, auth, JSON-only). The browser cannot write permission state except through these routes; the server remains the only authority.
- The API creates only `global` and `agent` rules (`task` and `once` come from approvals). Validation is the stage A `validateGrant`; execute and network tools can never be allowed above `once`.
- Revoking a `task` or `once` rule aborts the calls it allowed that are still running; revoking an `agent` or `global` rule affects future requests only (spec 4.4).
- Wire shapes carry no digest and no absolute path. The existing frontend must not change behaviour: `WORKFORCE_EVENT_TYPES` stays as is and `applyWorkforceEvent` ignores the new event.
- No frontend, SDK, Docker or process execution. `MockRuntimeProvider` unchanged.
- Verification at the end: `npm test` (use `rtk proxy npm test` to see the summary), `npx tsc -b`, `npm run build`, `npm run check:secrets`.

## Review Focus

1. **Revoke during a running call:** a task or once rule revoked while `perform` runs aborts that call's signal; an agent rule revoked does not. Task 1.
2. **Hostile input to the create route:** unknown keys, `task`/`once` scope, an unknown agent, a bad pattern, a past expiry, an execute tool allowed for an agent. Task 2.
3. **Revoking twice or a missing id** answers 409 and 404 and never throws. Task 2.
4. **A client that never heard of `permission.changed`** keeps working: unknown event names are ignored by the existing sync and by `applyWorkforceEvent`. Task 3.
5. **Replay:** a client resuming with `Last-Event-ID` receives missed permission events in order with workforce events. Task 3.

---

### Task 1: Per-call abort in the gate; `revokePermission` and `revokeAgentPermissions` in the manager

**Files:** Modify `server/toolGate.ts`, `server/taskManager.ts`; Test `server/toolGate.test.ts`, `server/permissions/gateIntegration.test.ts`.

**Interfaces:**
- `ToolGateDeps.permit` ok-result becomes `{ ok: true; ruleId: string | null }`; new dep `track(ruleId: string | null): { signal: AbortSignal; end(): void }`. The gate calls `permit` then `track` with no await between, passes `signal` from `track` to `perform` (it aborts when the task signal does too), and calls `end()` in a `finally`.
- `TaskManager.revokePermission(id: string): ManagerResult<{ rule: PermissionRule }>` (`not_found` → code `not_found`; inactive → code `conflict`) and `revokeAgentPermissions(agentId: string): ManagerResult<{ revoked: PermissionRule[] }>` (`not_found` when the agent does not exist). Both abort in-flight calls of revoked rules whose scope is `task` or `once`.

- [ ] Write failing tests: gate passes the tracked signal to `perform`, calls `end` after success and after a throw, calls `track` once per performed call with the allowing rule id; integration: a task-rule revoke during a pending `perform` aborts its signal, an agent-rule revoke does not, `revokeAgentPermissions` aborts task/once calls of that agent only, double revoke gives `conflict`, unknown id `not_found`.
- [ ] Run, expect FAIL. Implement. Run, expect PASS (`server/toolGate.test.ts`, `server/permissions/gateIntegration.test.ts`, `server/taskManager.test.ts`, `server/toolGate.integration.test.ts`).
- [ ] Commit `feat(server): abort a running tool call when its task permission is revoked`.

### Task 2: Wire types, view, routes

**Files:** Modify `src/workforce/api.ts`, `server/http/inputs.ts`, `server/http/routes.ts`, `server/app.ts`; Create `server/permissions/view.ts`; Test `server/http/permissionsRoutes.test.ts`, `server/http/inputs.test.ts`.

**Interfaces:**
- `src/workforce/api.ts`: `PermissionRuleView`, `PermissionChangeKind`, `PermissionChangedEvent`, `PermissionsResponse`, `PermissionResponse`, `CreatePermissionBody` (shapes in the design; no digest).
- `toRuleView(rule: PermissionRule, now: string): PermissionRuleView` (adds `state`).
- Routes: `GET /api/permissions` (active rules, oldest first), `GET /api/permissions/history` (inactive, newest first, at most 200), `POST /api/permissions` (201 `{rule}`), `DELETE /api/permissions/:id` (200 `{rule}`), `DELETE /api/agents/:id/permissions` (200 `{revoked: PermissionRuleView[]}`).
- `parseCreatePermission(b)`: only keys `scope effect tool agentId pathPattern expiresAt reason`; `scope` must be `global` or `agent`; wrong types are 400. Grant errors: 422 with a fixed sentence per `GrantError`, store `limit` is 409 `Too many active permissions.`; unknown agent for an agent rule is 404 `Agent not found.`.

- [ ] Write failing route tests through `startTestServer` (defaults listed as 8 active; create global and agent rules; every refusal in Review Focus 2; revoke a default; revoke twice 409; unknown id 404; history shows the revoked rule with state `revoked`; `DELETE` agent permissions; no token 401; POST without JSON content type 415; unknown field 400). Add input-parser tests.
- [ ] Run, expect FAIL. Implement. Run, expect PASS.
- [ ] Commit `feat(server): list, create and revoke permissions over HTTP`.

### Task 3: `permission.changed` events

**Files:** Modify `server/eventLog.ts`, `server/app.ts`, `src/workforce/api.ts`; Test `server/eventLog.test.ts`, `src/workforce/api.test.ts`, `server/http/sse.test.ts`, `server/permissionsWiring.test.ts`.

**Interfaces:** `EventLog.appendPermission(kind: PermissionChangeKind, rule: PermissionRuleView): PermissionChangedEvent` (same id sequence, buffer, replay and listeners). `applyWorkforceEvent` returns the state unchanged for `permission.changed`. `createApp` appends one event per store `onChange` (granted, revoked, used, ended, expired). Audit of revokes is attributed to `api`.

- [ ] Write failing tests: ids are consecutive across both event kinds; replay after an id includes later permission events; SSE frame `event: permission.changed` carries `kind` and the view with its state; `applyWorkforceEvent` ignores it; over HTTP a POST then a DELETE produce `granted` and `revoked` frames; a wiring test resumes with `lastEventId` and receives the missed ones in order.
- [ ] Run, expect FAIL. Implement. Run, expect PASS, including `src/workforce/remote/sync.test.ts` unchanged.
- [ ] Commit `feat(server): stream permission changes over SSE`.

### Task 4: Verify, report, PR

- [ ] Full verification (commands above) and `git diff --stat main`.
- [ ] Write `docs/milestone-3b4-stage-c-report.md` (changed files, real counts, security implications, rulings, what stage F still needs, including the queue of waiting approvals being invisible to the UI).
- [ ] Push and open the PR `feat(server): milestone 3B.4 stage C — permission API and live events`; the user merges.
