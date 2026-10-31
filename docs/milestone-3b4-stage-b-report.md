# Milestone 3B.4 stage B: permissions in the tool gate — report

Date: 2026-11-01. Plan: `docs/superpowers/plans/2026-11-01-milestone-3b4-stage-b-gate-integration.md`. Spec: `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md`. Stage A report: `docs/milestone-3b4-stage-a-report.md`.

The permission rules now decide every tool request in the running server. Still true: the Claude Agent SDK is not installed, no real Claude execution exists, the mock runtime is the only runtime, and no tool performs real file access yet (that is stage E). Nothing in the frontend changed.

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npm test` | 76 files, 1121 tests pass (1063 before; +58) |
| `npx tsc -b` | clean |
| `npm run build` | built (the existing chunk-size warning only) |
| `npm run check:secrets` | no secrets found |

Two mutation checks were run to prove the new tests can fail: forcing `permitTool` open turned four tests red; making `settleAll` skip the queue turned the four terminal-path tests red.

## What changed

- **Gate (`server/toolGate.ts`):** a required `permit` dep runs last, after the live/signal check, the workspace and digest re-checks and the policy re-check, right before `perform`. A refusal gives the new `revoked` outcome. `actionHash(tool, input)` is a path-free SHA-256 of the exact action.
- **Manager (`server/taskManager.ts`):** after `decideToolUse` (validation and the `ALLOWED_TOOLS` ceiling, unchanged), `PermissionStore.evaluate` says allow, ask or deny. `permitTool` evaluates again at use time and spends a once-grant (`consumeOnce`) before `perform`. Task and once rules end with their task; removing an agent revokes its agent, task and once rules (never global).
- **Decisions:** `allow_once`, `allow_task`, `allow_agent`, `reject` (and the older `approve`/`deny`). The rule is created before the decision is recorded or the runtime answered; if it cannot be recorded the approval stays pending.
- **Queue:** concurrent asks in one task wait first-in-first-out (`MAX_QUEUED_APPROVALS = 8`, the ninth is refused). After each decision the next waiter is authorized again from scratch. Cancel, task or approval timeout, agent removal and dispose settle the pending request and every queued one.
- **App:** the store opens at start (`App.permissions`), grants, revokes and expiry are audited, expiry is noticed by a 30 s `unref`'d sweep cleared on close. Audit records now carry `digest` (12 characters), `actionHash` and `ruleId`.

## Security implications

- **Use-time authority.** A grant never replaces a check: validation, review building, workspace re-resolution and the digest all still run; `permit` is the last gate. A revoke, expiry or a spent once-grant between approval and `perform` stops the action (tested).
- **Fail closed.** `permit` refuses on any evaluation other than a clear allow, including an unreadable rule or a missing task.
- **No silent grant.** The approval timeout still fails the task; nothing is granted on timeout, restart or a corrupt rules file (tested).
- **Execute and network tools** can only be allowed once; the API-level refusal leaves the approval pending (tested). They are also denied by default and absent from the default ceiling.
- **Known limit.** `allow_task` and `allow_agent` on `Write`/`Edit` cover the whole workspace until stage E adds the sensitive-path denylist and safe file operations. An agent rule also spans every workspace and every later task of that agent until revoked. Nothing real is written yet, so the exposure is not live.
- **Two identical requests with one once-grant:** the second is denied as already used (`revoked`), never run twice. This is safe but not friendly; it does not re-prompt.
- **Reading is unprompted by default** as before; a deny or ask rule changes that.

## Rulings made during implementation

1. Reads keep `reason: 'read_only'` in `tool.allowed` (an existing test pins it); writes allowed by a rule use `permission:<source>`.
2. A human `approve` creates a once rule already in Task 2 (the plan placed grants in Task 3); without it the new `permit` would refuse every human-approved write.
3. Minimal app wiring happened in Task 2 because `TaskManager` requires the store; Task 5 added audit and the sweep.
4. The existing Bash approval test now lifts the default Bash deny and sets a global ask first, as a person would have to.
5. "Revoking an agent rule while a request is queued" became two re-evaluation tests (deny rule added, allow rule added while queued), because an allowed request never queues.
6. Two existing tests that expected a second concurrent request to be refused now expect it to wait; the property they guard (a first approval never covers a different action) is still asserted.

## Review

Author self-review only; no independent reviewer ran. Since this stage changes the live security gate, an independent review of `server/toolGate.ts` and `server/taskManager.ts` (`approveTool`, `permitTool`, `decideApproval`, `promote`, `settleAll`) is recommended before stage C builds on it.

## Remaining for stage C

HTTP API and `permission.changed` SSE for listing, creating and revoking rules and for history; revoking a running task's rules should abort that task (the signal exists, the endpoint does not); a path pattern choice when allowing for a task or agent. Later: session cookie (D), `fileOps` and denylist (E), UI (F), end-to-end report (G).
