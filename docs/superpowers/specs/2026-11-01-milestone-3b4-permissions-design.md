# Milestone 3B.4: runtime permission management and gated tools — design

Date: 2026-11-01. Audited on `origin/main` at `5ed3ac5` (after #40 and #42). Baseline: `tsc -b` clean, 70 test files and 979 tests pass, `check:secrets` clean. Design only; nothing here is built.

## 1. Intent

Let a person grant, deny, change and revoke what each agent may do while it runs, from the Virtual Office UI, without restarting the agent or the app. The backend decides; the browser only asks. This milestone ends with a permission system and safe tools that Milestone 3B.5 can plug a real Claude runtime into. No Claude SDK, no real model, no Docker, no host process execution.

Success: a mock task asks to write a file, a person picks Allow once / this task / this agent / Reject, the choice is enforced and audited, revoking it stops the next action at once, and none of it can reach outside the approved workspace.

## 2. Goals, non-goals, anti-goals

**Goals**
- Scopes Global, Agent, Task, Once; decisions Allow, Deny, Ask, Revoke; optional expiry; expiry at task end; audit history.
- Live approval over SSE bound to the exact action digest; stale, duplicate and cancelled requests handled.
- Safe file operations and gated tools (`vo_read`, `vo_glob`, `vo_grep`, `vo_write`, `vo_edit`) behind the one gate.
- Browser session cookie so the app no longer relies on the dev proxy.
- UI for settings, requests, pending list, history, revoke, status.

**Non-goals**
- Installing or calling the Claude Agent SDK; the real provider (3B.5).
- A command executor. `Bash`/`vo_run` gets a schema and policy entry only; its executor does not exist and always denies. The supervisor and the spawn-guard exception are a later milestone.
- Network tools, multi-user accounts, remote/VPS deployment, TLS.

**Anti-goals (a failure even if it "works")**
- A grant that skips workspace checks, input validation, review building, the digest, auth or the gate.
- The browser able to write permission state directly, or the only enforcement living in the UI.
- Any silent grant on timeout, restart or error.
- Weakening an existing control, rewriting the app, or touching the 3D office or layout editor.

## 3. Findings from the audit that shape the design

1. Policy is a static `ALLOWED_TOOLS` env list; `toolPolicy.ts` states a write/execute/network tool can only be `ask`, never `allow`. Scoped grants deliberately relax this (see 4.3).
2. `taskManager.approveTool` allows one pending approval per task and denies a second with `approval_pending`.
3. `POST /api/tasks/:id/approval` takes `{approvalId, decision, digest}` only; no scope.
4. Audit records carry no digest or action hash.
5. Reads need no approval and no sensitive-path denylist exists.
6. `fileOps`, `vo_*` tools and the cookie flow are design only (`docs/gated-tools.md`, `docs/browser-auth.md`).
7. Local `main` is stale (3 behind); PRs #33–#39 landed as the single squash #40.

## 4. Design

### 4.1 Permission model (`server/permissions/`)

A **rule**: `{ id, scope: 'global'|'agent'|'task'|'once', agentId?, taskId?, tool, effect: 'allow'|'deny'|'ask', pathPattern?, digest?, createdAt, createdBy, expiresAt?, endsWithTask?, revokedAt?, usedAt?, reason? }`. `pathPattern` is workspace-relative, validated with the same `globInside` rules; it narrows, never widens.

**Evaluation** (pure, fail-closed — any error or unreadable store means `ask`/deny, never allow):
1. Drop rules that are revoked, expired, used (once), or belong to an ended task.
2. Any matching **deny** wins (any scope).
3. Otherwise the most specific matching **allow/ask**: once (exact digest) > task > agent > global.
4. Nothing matches: **default deny** — except the seeded global defaults below.

Seeded global defaults reproduce today's behaviour: Read/Glob/Grep allow, Write/Edit ask, Bash/WebFetch/WebSearch deny. `ALLOWED_TOOLS` stays as a hard ceiling: a tool outside it is `not_allowed` whatever a rule says.

**Persistence:** `DATA_DIR/permissions.json`, written atomically (same pattern as `store.ts`), separate from `workforce.json`; schema-versioned; a corrupt file loads as defaults-only plus a visible warning (never as allow-all). The permission store is server-only.

### 4.2 Where it plugs in

`decideToolUse` keeps doing validation, workspace checks and review building and returns what the tool *is* (category, summary, review, paths). A new `authorize(agent, task, tool, digest, decision)` turns that into allow / ask / deny using the rules. `approveTool` calls both. The **use-time re-check in `toolGate.ts` calls `authorize` again** after the human answer and before `perform`; a rule revoked or expired in between gives `stale_approval`-class denial (`revoked`). A **once** rule is consumed atomically (`usedAt` set under the store's single-writer commit) *before* `perform`; a second use fails. This is the TOCTOU boundary: validate → authorize → consume → perform, all in the gate.

### 4.3 Grants and the "writes always ask" invariant

An Agent or Task grant is `{tool, pathPattern?}`. Every call it covers still goes through full input validation, `buildReview` (a `not_reviewable` write is still denied), workspace re-resolution, the digest, and is audited **per use** (`permission.used`). Execute and network tools can be granted as **Once only**; the API refuses broader scopes for them. Nothing can create a global allow for a write tool from a task request.

### 4.4 Live approval

Decision body becomes `{approvalId, digest, decision: 'allow_once'|'allow_task'|'allow_agent'|'reject'}` (legacy `approve`/`deny` accepted and mapped to once/reject for the existing UI until stage F). Server checks: task waiting, approvalId matches, digest equals the pending one (else 409), not already decided (409). Grant creation, decision record and answer to the runtime happen in one commit.

**Concurrency:** requests from different tasks/agents are independent. Within one task, further tool calls are **queued first-in-first-out** (bounded, e.g. 8; overflow denies with `approval_pending`); one is shown at a time. Cancel, timeout, agent removal and shutdown settle every queued waiter with `cancelled`/`expired`. Approval timeout still fails the task and never grants anything.

**Revoke:** `DELETE /api/permissions/:id` (and "revoke all for agent"). Effective on the next `authorize`, including calls already queued. A tool already inside `perform` is aborted through the existing task `AbortSignal` only if the revoke targets the running task; otherwise it completes (documented limit).

### 4.5 API and events

`GET /api/permissions` (rules + effective defaults), `POST /api/permissions` (create global/agent rule), `DELETE /api/permissions/:id`, `GET /api/permissions/history`. All behind the existing guard chain; mutations JSON-only. SSE gains `permission.changed` (id, scope, tool, effect, state) so every open tab updates; request events reuse `approval_requested`. The browser mock gets a matching in-memory implementation so `npm run dev` still works.

**Audit:** new actions `permission.granted|denied|revoked|expired|used`; `approval.decided` and `tool.*` gain `digest` (12-char prefix as today) and a SHA-256 `actionHash` of the canonical action. Records still carry ids and reason codes only.

### 4.6 Gated tools (stage E)

- `server/sensitivePaths.ts`: denylist applied to **every** tool incl. reads (`.env*`, `.git/`, `*.pem`, `id_*`, `.ssh`, `.aws`, the data folder).
- `server/fileOps.ts`: per `docs/gated-tools.md` — descriptor-based parent open, `O_NOFOLLOW`, `fstat` regular file with `nlink === 1`, size caps, same-directory temp file + `fsync` + `rename`, abort checked before every step, errors from a fixed list with no host paths.
- `server/tools/*.ts`: `vo_read`, `vo_glob`, `vo_grep`, `vo_write`, `vo_edit` as plain handlers over `ctx.tools.use(request, perform)`; read output capped and redacted. `vo_run` is declared, always denies.
- The mock provider may demo through them; `MockRuntimeProvider` unchanged otherwise.
- No SDK types, no `child_process`; `noProcessExecution.test.ts` stays untouched.

### 4.7 Browser authentication (stage D)

Implement `docs/browser-auth.md` option B: `POST /api/session {token}` → `vo_session` cookie (HttpOnly, SameSite=Strict, Path=/api, hours, random id held in server memory); `DELETE /api/session`; the `auth` guard accepts the bearer token **or** a valid session; CORS credentials for exact origins only; `credentials: 'include'` / `withCredentials` in the client; a Connect screen. Sessions die on restart/rotation. The bearer header keeps working for programs. The dev proxy stays as a dev convenience and is documented as not authentication.

### 4.8 Frontend (stage F)

Reuse `ApprovalReview` and the `AgentDetail` approval block. Add: a permissions panel (Global and per-agent tabs), a request modal with the four choices, a pending list, a history list, revoke buttons, and a status chip in `AgentDetail`. States shown distinctly: Allowed, Denied, Approval required, Pending, Expired, Revoked. 3D scene and layout editor untouched. Colour is never the only signal.

## 5. Stages (one branch + PR each; Opus plans/reviews backend and security, Sonnet implements)

| | Stage | Branch | Done when |
|---|---|---|---|
| A | Engine, store, audit actions | `feat/3b4-a-permission-engine` | precedence, expiry, task-end, revoke, corrupt-file tests pass |
| B | Gate/manager integration, scoped decisions, queue | `feat/3b4-b-gate-integration` | revoke-during-task, stale digest, duplicate, cancel-while-waiting, concurrent tests via real manager |
| C | HTTP API + SSE + mock parity | `feat/3b4-c-permission-api` | route tests, guard order unchanged, SSE `permission.changed` |
| D | Session cookie | `feat/3b4-d-browser-session` | cookie flags, rotation, CSRF, localhost vs 127.0.0.1, works without proxy |
| E | fileOps, denylist, `vo_*` tools | `feat/3b4-e-gated-tools` | symlink/swap/hardlink/dir/size/abort/two-writer/denylist tests; workspace-escape attempts |
| F | Frontend | `feat/3b4-f-permission-ui` | component tests; existing UI tests still pass |
| G | End-to-end, review, report | `test/3b4-g-e2e-report` | real backend + SSE test, `docs/milestone-3b4-report.md` |

Every stage ends with `npm test`, `npx tsc -b`, `npm run build`, `npm run check:secrets`, then a report of changed files, security implications and blockers. A stage is not "done" unless implemented and tested.

## 6. Test matrix (mapped to the brief)

Global; agent-specific; task grant; allow once (second use fails); deny beats allow; expiry; task-end expiry; revoke during an active task; stale digest; concurrent requests (different tasks, and queued within a task); unauthorized tool (outside ceiling/catalogue); workspace escape (`..`, symlink, hard link, absolute); cancel while awaiting approval; timeout never grants; browser auth; corrupt permission file fails closed; real backend + SSE end to end.

## 7. Constraints kept

No Docker; no SDK; no real Claude; no host process execution; no control weakened (the write-ask rule is relaxed only by scoped, audited, per-use-validated grants); `MockRuntimeProvider`, layout editor and 3D office preserved; no rewrite.

## 8. Calls I made (check these)

1. Scoped grants as in 4.3, execute/network once-only.
2. Per-task FIFO queue, bound 8.
3. `Bash`/`vo_run`: schema and policy only, always denies.
4. Session cookie (stage D) before the UI (F).
5. Permission rules in their own `permissions.json`, not in `workforce.json`.
6. Legacy `approve`/`deny` kept until the new UI lands.
7. Per-agent workspace allowlist is **out** of this milestone (roadmap gap 8); an agent rule can still carry a `pathPattern`.

## 9. Open for the builder

Exact rule-store schema field types, queue bound, session lifetime, and `permission.changed` payload shape are the builder's to settle within the above.
