# Milestone 3B.4 Stage B: Gate Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the permission rules from stage A decide every tool request, re-checked at the moment of use, with scoped approval decisions (once / task / agent) and a per-task queue for concurrent requests. Backend only.

**Architecture:** `TaskManager.approveTool` keeps `decideToolUse` for validation and the `ALLOWED_TOOLS` ceiling, then asks `PermissionStore.evaluate` whether to allow, ask or deny. A new `permit` hook in the tool gate runs last, after every existing use-time check and immediately before `perform`: it evaluates again and consumes a once-grant, so a revoked, expired or already-used rule stops the action. A human decision with a scope creates a rule first, then answers the runtime. Concurrent asks in one task wait in a bounded FIFO queue.

**Tech Stack:** TypeScript, vitest, the stage A modules in `server/permissions/`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md` (4.2, 4.3, 4.4, 4.5 audit). Stage A report: `docs/milestone-3b4-stage-a-report.md`.

## Global Constraints

- Branch `feat/3b4-b-gate-integration` from up-to-date `main`; conventional commits ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Order inside the gate stays: validate (policy, ceiling, workspace) → authorize → consume → perform. Fail closed: any error or unreadable rule means no `perform`.
- A grant never skips input validation, review building, workspace re-resolution or the digest. Execute and network tools can only be allowed once. `ALLOWED_TOOLS` stays a hard ceiling.
- The approval timeout still fails the task and never grants anything. Cancel, timeout, agent removal and shutdown settle every waiting request.
- Workforce state keeps `ApprovalDecision = 'approve' | 'deny'`; the new choices exist only at the server boundary. The legacy `approve` and `deny` stay accepted and mean `allow_once` and `reject`.
- Audit records carry ids and codes only: digest (12-character prefix), `actionHash` (SHA-256 of canonical `{tool, input}`, no workspace path), `ruleId`.
- No change to the frontend, `src/workforce/**`, `server/permissions/**` (stage A) or `noProcessExecution.test.ts`. No SDK, Docker or process execution. `MockRuntimeProvider` behaviour unchanged.
- Verification per task: `npx vitest run <files>`; at the end `npm test`, `npx tsc -b`, `npm run build`, `npm run check:secrets`.

## Review Focus

1. **Revoke between approval and perform:** a person allows once, the rule is revoked before the runtime continues, `perform` must not run. Also an agent grant revoked or expired between evaluation and use. Pinned in Tasks 1 and 2.
2. **Two identical requests and one once-grant:** the second must not run (it is denied as already used), never run twice. Pinned in Task 4.
3. **Allow for this task while others wait:** queued requests for the same tool are answered by the new rule without a second prompt; queued requests it does not cover get their own prompt in order. Pinned in Task 4.
4. **A grant that cannot be recorded:** a rule refused (execute tool at task scope, store limit) must leave the approval pending, not answer the runtime. Pinned in Task 3.
5. **Terminal events with a full queue:** cancel, approval timeout, agent removal and dispose settle the pending request and every queued one, none left hanging. Pinned in Task 4.

---

## File Structure

| File | Change |
|---|---|
| `server/toolGate.ts` | `permit` dep, `actionHash`, `revoked` outcome |
| `server/runtime/types.ts` | `GatedOutcome` gains `'revoked'` |
| `server/runtime/mockProvider.ts` | treat `revoked` like `stale_approval` |
| `server/toolPolicy.ts` | `DenyReason` gains `permission_denied` |
| `server/taskManager.ts` | rules decide, `permit`, scoped decisions, queue, cleanup, audit events |
| `server/http/inputs.ts`, `server/http/routes.ts` | accept the four choices |
| `server/app.ts` | open the store, audit mapping, expiry sweep |
| `server/audit.ts` | none (stage A added the fields) |
| tests | `toolGate.test.ts`, `taskManager.test.ts`, `toolGate.integration.test.ts`, `http/routes.test.ts`, new `server/permissions/gateIntegration.test.ts`, new `server/permissionsWiring.test.ts` |

---

### Task 1: Gate `permit` hook and the `revoked` outcome

**Files:**
- Modify: `server/toolGate.ts`, `server/runtime/types.ts`, `server/runtime/mockProvider.ts`
- Test: `server/toolGate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // toolGate.ts
  export function actionHash(tool: string, input: unknown): string   // sha256 hex of canonicalJson({ tool, input })
  // ToolGateDeps gains (required):
  permit(request: ToolRequest, digest: string, paths: ReadonlyArray<{ arg: string; relative: string }>): { ok: true } | { ok: false }
  // runtime/types.ts: GatedOutcome deny outcome union gains 'revoked'
  ```
- Gate behaviour: `permit` is called exactly once per allowed request, after the live/signal check, the workspace and digest re-checks and the policy re-check, immediately before `perform`, with the frozen input, the digest and the checked paths. `{ok:false}` returns `{behavior:'deny', outcome:'revoked', message:'The permission for tool "<tool>" was withdrawn or already used; it was not run.'}` and `perform` does not run. `permit` is not called when an earlier check refused.

- [ ] **Step 1: Write failing tests in `toolGate.test.ts`.** Add `permit: () => ({ ok: true })` to the deps factory the file already uses, then add:
  - `runs permit after the re-checks and before perform` (record call order with an array: `approve`, `permit`, `perform`; assert permit received the digest and the checked relative paths).
  - `does not perform when permit refuses` → outcome `revoked`, `perform` not called, message names the tool.
  - `does not call permit when the task is no longer live`, `...when the workspace changed`, `...when the policy re-check fails` (each: `permit` mock not called, outcome `cancelled` / `stale_approval` as before).
  - `permit is called once per allowed request`.
  - `actionHash` is stable across key order, differs for a different input, and contains no workspace path.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run server/toolGate.test.ts` (type errors and missing export).
- [ ] **Step 3: Implement** `actionHash`, the `permit` dep and the call in `createToolGate`, the `'revoked'` outcome in `GatedOutcome`, and in `ServerMockProvider.requestApproval` add `'revoked'` to the outcomes that force an error with `result.message`.
- [ ] **Step 4: Run, expect PASS** — same command, then `npx tsc -b` (it will flag other `createToolGate` callers; only `taskManager.ts` is one, fixed in Task 2, so temporarily satisfy it there with `permit: () => ({ ok: false })` so nothing runs, and note it for Task 2).
- [ ] **Step 5: Commit** — `feat(server): re-check permissions in the tool gate right before perform`.

---

### Task 2: Rules decide every request; permit, cleanup and audit in the manager

**Files:**
- Modify: `server/taskManager.ts`, `server/toolPolicy.ts`
- Test: `server/taskManager.test.ts` (adapt `make`), `server/toolGate.integration.test.ts` (adapt setup), create `server/permissions/gateIntegration.test.ts`

**Interfaces:**
- Consumes: `PermissionStore`, `PermissionQuery` (stage A); `actionHash` and the `permit` dep (Task 1).
- Produces:
  ```ts
  // TaskManagerOptions gains (required): permissions: PermissionStore
  // LifecycleAction gains: 'permission.granted' | 'permission.denied' | 'permission.revoked' | 'permission.expired' | 'permission.used'
  // LifecycleEvent gains optional: digest?: string; actionHash?: string; ruleId?: string
  // toolPolicy.ts: DenyReason gains 'permission_denied' (text: 'denied by a permission rule')
  ```
- Behaviour of `approveTool` after `decideToolUse` (a policy deny still wins, unchanged): build `PermissionQuery{agentId: task.agentId, taskId, tool, digest, paths: d.paths?.map(p => p.relative) ?? []}`, then `permissions.evaluate`:
  - `deny` → audit `permission.denied` (`ruleId`, `reason` = decision source) and `tool.denied` with reason `permission_denied`; answer `denied_by_policy` with `toolDeniedMessage(tool, 'permission_denied')`.
  - `allow` → audit `tool.allowed` with `reason: 'permission:<source>'`, `ruleId`; answer allowed with no prompt.
  - `ask` → the existing prompt path (summary, review, digest unchanged).
- `permit` implementation: evaluate again; `allow` → if `source === 'once'` call `consumeOnce(ruleId)` and refuse when it returns false; audit `permission.used` (`ruleId`, `digest` prefix, `actionHash`); anything else → audit `permission.denied` with `reason: 'revoked_or_changed'` and refuse.
- Cleanup: `finalize(taskId)` calls `permissions.endTask(taskId)`; `removeAgent` calls `permissions.revokeForAgent(agentId)` before cancelling. Each affected rule is audited as `permission.revoked` (`ruleId`, `reason: 'agent_removed'`) or by the store's `onChange` wiring in Task 5 (do not double-audit: Task 5 owns the store-level audit, so here only add the `permit`/`approveTool` events above).
- Existing `approval.requested`, `approval.decided`, `tool.asked` records gain `digest` (12-char prefix) and `actionHash`.

- [ ] **Step 1: Adapt the two existing constructions** (`make` in `taskManager.test.ts`, the `beforeEach` in `toolGate.integration.test.ts`) to pass `permissions: openPermissionStore({ dataDir: dir, now, log: silentLogger, writeFile: () => {} })`. Run both files: expect them to still pass once Task 2 is implemented, and fail to compile before.
- [ ] **Step 2: Write failing tests in `server/permissions/gateIntegration.test.ts`** (same setup, helpers and `FakeProvider` as `toolGate.integration.test.ts`; real manager, store, workspace on disk):
  - `a read is allowed by the default rules with no prompt` (`tool.allowed` event with reason `permission:global`).
  - `a write asks by default` (task `waiting_for_approval`).
  - `an agent allow rule lets a write run with no prompt; perform ran once; permission.used audited with ruleId and actionHash`.
  - `a global deny rule on Read stops it before perform` (`permission.denied`, outcome `denied_by_policy`).
  - `a deny pattern on secrets/** stops a Write to secrets/k but not to src/k`.
  - `revoke between the human approval and perform stops it`: start a Write, grant a once rule through `permissions.grant` with the pending digest, answer the prompt with legacy `approve`, revoke the once rule before awaiting the gate result → outcome `revoked`, `perform` not called.
  - `an agent grant revoked after evaluation stops the action`: evaluation allows (agent rule), revoke it inside a slow `approve`-free path by revoking synchronously before `await tick()` → `perform` not called (use the fake provider to call `ctx.tools.use` and revoke before the microtask continues).
  - `an expired rule stops the action` (advance fake time past `expiresAt` before the use-time check).
  - `ALLOWED_TOOLS is a ceiling`: with policy lacking `Write`, an agent allow rule on Write still denies (`not_allowed`).
  - `a once rule bound to another digest does not apply`.
  - `ending a task ends its task and once rules`; `removing an agent revokes its agent rules but not global ones`.
  - `an execute tool cannot be allowed by a rule the store refuses` is covered by stage A; here assert `Bash` with default rules denies.
- [ ] **Step 3: Run, expect FAIL** — `npx vitest run server/permissions/gateIntegration.test.ts`.
- [ ] **Step 4: Implement** the option, `approveTool` flow, `permit` dep (replace the Task 1 placeholder), `finalize`/`removeAgent` cleanup, the extra `LifecycleEvent` fields on the records named above, and `DenyReason`/`DENY_TEXT` for `permission_denied`.
- [ ] **Step 5: Run, expect PASS** — the new file plus `server/taskManager.test.ts`, `server/toolGate.integration.test.ts`, `server/toolPolicy.test.ts`, `server/toolGate.test.ts`.
- [ ] **Step 6: Commit** — `feat(server): let permission rules decide tool requests, re-checked at use time`.

---

### Task 3: Scoped approval decisions

**Files:**
- Modify: `server/taskManager.ts`, `server/http/inputs.ts`, `server/http/routes.ts`
- Test: `server/permissions/gateIntegration.test.ts`, `server/http/routes.test.ts`, `server/http/inputs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // taskManager.ts
  export type ApprovalChoice = ApprovalDecision | 'allow_once' | 'allow_task' | 'allow_agent' | 'reject'
  decideApproval(taskId: string, approvalId: string, decision: ApprovalChoice, opts?: CallOptions, digest?: string): ManagerResult<{ task: AgentTask }>
  // inputs.ts
  parseApproval(b): { approvalId: string; decision: ApprovalChoice; digest: string | undefined }   // error text: '"decision" must be "allow_once", "allow_task", "allow_agent", "reject", "approve" or "deny".'
  ```
- Mapping: `approve` → `allow_once`, `deny` → `reject`. The state records `approve` for any `allow_*` and `deny` for `reject`. For a pending tool request: `allow_once` grants a `once` rule (agent, task, tool, the pending digest); `allow_task` a `task` rule; `allow_agent` an `agent` rule (no path pattern); then the runtime is answered `approved`. The grant is made **before** the decision is recorded or the runtime answered. If it is refused: `scope_not_allowed_for_tool` → `{ok:false, code:'invalid', error:'That tool can only be allowed once.'}`; any other refusal → `{ok:false, code:'unavailable', error:'The permission could not be recorded.'}`; in both cases the approval stays pending. A scoped `allow_task`/`allow_agent` on an approval that is not a tool request (the mock's own approval) → `{ok:false, code:'invalid', error:'That approval can only be allowed once.'}`. Audit `approval.decided` gains `decision` = the choice, `ruleId`, `digest`, `actionHash`; the store's `granted` event is audited by Task 5.

- [ ] **Step 1: Write failing tests:**
  - gateIntegration: `allow_once` runs the action once, a second identical request asks again; `allow_task` makes a second Write in the same task run without a prompt and a Write in the next task ask again (task end ended the rule); `allow_agent` carries to the agent's next task; `reject` denies with outcome `denied` and creates no rule; legacy `approve`/`deny` behave as once/reject; `allow_task` on `Bash`-like execute request is refused with 'That tool can only be allowed once.' and the approval is still pending and can still be rejected; with `limits.maxActive: 0` the grant fails with 'The permission could not be recorded.' and the approval stays pending; a stale or wrong digest is still a 409 `That approval is no longer pending.`; deciding twice is a 409; `allow_agent` on the mock's own (non-tool) approval is refused.
  - `inputs.test.ts`: the four choices and the legacy two parse; anything else throws the new error text.
  - `routes.test.ts`: update the existing assertion at line 125 to the new error text; add `POST /api/tasks/:id/approval` with `allow_task` returning 200.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the choice type, parsing, route pass-through and the grant-before-record flow in `decideApproval`.
- [ ] **Step 4: Run, expect PASS** — the three test files plus `taskManager.test.ts`.
- [ ] **Step 5: Commit** — `feat(server): approve once, for the task or for the agent`.

---

### Task 4: Per-task queue for concurrent requests

**Files:**
- Modify: `server/taskManager.ts`
- Test: `server/permissions/gateIntegration.test.ts`, `server/taskManager.test.ts` (adjust the existing `approval_pending` expectation)

**Interfaces:**
- Produces: `export const MAX_QUEUED_APPROVALS = 8`. While a prompt (or the mock's own approval) is pending, further requests that need a prompt wait in a FIFO queue on the run; allowed and denied requests never queue. A queue of `MAX_QUEUED_APPROVALS` refuses further asks with the existing `approval_pending` denial. After any decision the next waiter is re-authorized from scratch (`decideToolUse` + `evaluate`): it may now be allowed (a new task or agent rule), denied (a deny rule or revoke), or asked next. Terminal paths (cancel, task or approval timeout, agent removal, `finalize`, `dispose`) settle the pending request **and every queued one** with the same cancelled or expired result.

- [ ] **Step 1: Write failing tests (gateIntegration):**
  - `a second write while one is pending waits instead of being denied` (second promise unresolved, task shows one pending approval).
  - `reject of the first does not deny the second; the second then asks`.
  - `allow_task for the first answers a queued write to another file without a second prompt`.
  - `allow_once for the first: a queued identical request is denied as used, never performed twice` (assert `perform` calls for the pair equal 1, second outcome `revoked`).
  - `a queued request for another tool still gets its own prompt`.
  - `revoking the agent rule while a request is queued makes it ask again`.
  - `the ninth ask is refused with approval_pending`.
  - `cancel, approval timeout, removing the agent and dispose each settle the pending and all queued requests` (four small tests; every promise resolves, none `allow`, `perform` never called).
  - `taskManager.test.ts`: change the existing "second tool call while one is pending" test to expect waiting, not denial.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the queue on `Run` (`toolQueue`), a `promote` step after every decision and after the mock-approval response, and `settleAll` for the terminal paths.
- [ ] **Step 4: Run, expect PASS** — gateIntegration, `taskManager.test.ts`, `toolGate.integration.test.ts`, `lifecycle.test.ts`.
- [ ] **Step 5: Commit** — `feat(server): queue concurrent tool approvals per task`.

---

### Task 5: Wire the store into the app; audit and expiry; real-backend test

**Files:**
- Modify: `server/app.ts`
- Create: `server/permissionsWiring.test.ts`

**Interfaces:**
- `App` gains `permissions: PermissionStore`; `AppDeps` gains `permissions?: PermissionStore` (test seam).
- `createApp` opens `openPermissionStore({ dataDir: config.dataDir, now, log, onChange })` after the workforce store (so `DATA_DIR` exists) and passes it to `TaskManager`. `onChange` writes `permission.granted|revoked|used|expired` ... with the mapping `used` → `permission.used` is written by `permit` already, so `onChange` audits only `granted`, `revoked`, `expired` (`ended` is not audited). Fields: `ruleId`, `tool`, `agentId`, `taskId` when present, `reason` = scope, `detail` = effect. A load problem is logged (already by the store) and `config.startup` is unchanged.
- An `unref`'d interval (30 s) calls `permissions.sweep()`; cleared in `close()` (extend `RunningServer.close`). `toAuditInput` passes the new `digest`, `actionHash`, `ruleId` keys.

- [ ] **Step 1: Write failing tests in `server/permissionsWiring.test.ts`** using the existing real-server helpers (`server/test/helpers.ts`, `server/e2e/realServer.test.ts` as the model; mock runtime with a workspace):
  - `permissions.json exists in DATA_DIR after start and holds the defaults`.
  - Through HTTP: a task asks for a Write (demo request-approval with a workspace), `POST /api/tasks/:id/approval` with `allow_task` and the digest returns 200, the audit log has `permission.granted` then `approval.decided` carrying `digest`, `actionHash` and `ruleId`; a second demo request in the same task runs with no prompt and the audit log has `permission.used`.
  - `revoking through the store makes the next request ask again` (`app.permissions.revoke(id)`; audit has `permission.revoked`).
  - `an expired rule is audited once by the sweep` (inject a clock; call the exposed sweep through `app.permissions.sweep()` and assert the audit line; assert the interval is cleared on close by a test using fake timers).
  - SSE: the event stream shows the task going `waiting_for_approval` then back to running after the decision (reuse `sseClient.ts`).
  - `a corrupt permissions.json at start does not allow more than the defaults`: write garbage before start; Write still asks, Bash still denied, the server starts.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the wiring, the audit mapping and the interval.
- [ ] **Step 4: Run, expect PASS** — the new file, `server/app.test.ts`, `server/auditWiring.test.ts`, `server/e2e/realServer.test.ts`.
- [ ] **Step 5: Commit** — `feat(server): open the permission store at start and audit grants, revokes and expiry`.

---

### Task 6: Verification, report and PR

**Files:** Create `docs/milestone-3b4-stage-b-report.md`.

- [ ] **Step 1: Full verification** — `npm test` (expect all of stage A's 1063 plus the new tests), `npx tsc -b`, `npm run build`, `npm run check:secrets`. `git diff --stat main` touches only the files named in the File Structure table plus the report.
- [ ] **Step 2: Write the report:** changed files; real test counts; security implications (use-time permit, once consumption, grant-before-answer, queue bounds, terminal settlement, ceiling intact, audit fields); the known limit that `allow_task` / `allow_agent` for Write and Edit cover the whole workspace until the sensitive-path denylist and safe file operations of stage E, and that nothing real is written yet because no tool performs file access; remaining blockers for stage C (API and SSE for rules, revoke endpoint that aborts a running task on revoke of its rules, history).
- [ ] **Step 3: Commit, push, open the PR** to `main` titled `feat(server): milestone 3B.4 stage B — permissions in the tool gate`, body ending `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Stop; the user merges.

---

## Self-Review

- **Spec coverage:** 4.2 (authorize + consume + perform order) → Tasks 1, 2; 4.3 (grant restrictions) → Tasks 2, 3; 4.4 (decision body, digest, duplicate, queue, revoke, no silent grant on timeout) → Tasks 3, 4; 4.5 audit digest/actionHash/`permission.*` → Tasks 2, 5. Still for later stages: HTTP rule API and `permission.changed` SSE (C), revoke aborting a running task (C), session cookie (D), `fileOps` and denylist (E), UI (F), end-to-end report (G).
- **Deviation to confirm, builder's call:** the audit of `granted`, `revoked` and `expired` lives in the app's `onChange` wiring (Task 5) while `permission.used` and `permission.denied` live in the manager, to avoid double records.
- **Type consistency:** `ApprovalChoice`, `permit`, `actionHash`, `MAX_QUEUED_APPROVALS` and the `revoked` outcome are each defined once and used unchanged downstream.
- **Proportion:** about two and a half times the stage's design text, signatures and test assertions only.
