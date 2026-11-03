# Milestone 3B.4 — Final Audit and Completion Report

> **Superseded status:** this is the audit as of 2026-11-02, before stages D to G. For the current state see `docs/milestone-3b4-report.md`.

Date: 2026-11-02. Audited commit: `a942801` on `main` (PR #48 merged). Read-only audit: no source, configuration or dependency was changed, and no host command, SDK or Claude agent was run.

## 1. Executive summary

**Milestone 3B.4 is not complete.** Stages **A, B and C** (permission engine, gate integration, HTTP API and live events) are merged, tested and sound. Stages **D (browser session cookie), E (real gated tools and file operations), F (frontend) and G (end-to-end and report)** from the design (`docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md` §5) were **never started**. This audit therefore describes a backend permission system that is real and enforced, with no real tool behind it and no UI on top of it.

| Area | Verdict |
|---|---|
| Permission engine, store, precedence, expiry, revoke | Implemented, enforced by the backend, well tested |
| Approval workflow in the backend | Implemented and enforced (digest, stale, duplicate, queue, timeout, cancel) |
| Frontend permission UI | **Missing** (the browser never calls `/api/permissions`, ignores `permission.changed`, and cannot send `allow_task` or `allow_agent`) |
| Gated tools Read/Grep/Glob/Write/Edit/Bash | **Policy only. No tool performs any file access or command.** Nothing to attack, nothing real to protect yet |
| Browser authentication | Dev-proxy token injection only. The designed cookie session (stage D) is **documented, not built** |
| Real Claude runtime | **Not present.** `SDK_INSTALLED = false`, provider always unavailable. Mock runtime only |
| 3B.5 readiness | **NOT READY** (see §10) |

All automated checks pass (1168 tests, both builds, secret scan, `npm audit`: 0 vulnerabilities).

## 2. Git and merge verification

| Item | Result |
|---|---|
| Branch / HEAD at audit start | `main` / `a942801` (clean, in sync with `origin/main`) |
| Working tree | Clean. Ignored only: `.superpowers/`, `.vitest/`, `.vo-server.log`, `data/`, `dist-server/`, `dist/`, `node_modules/`. No tracked build artifacts |
| Unrelated changes | None |

Milestone 3B.4 commits, verified with `gh pr list --state merged` and `git log`:

| PR | Commit | Content | Merged |
|---|---|---|---|
| #43 | `9226126` | Design, audit and stage plan | 2026-10-31 |
| #44 | `4773c28` | Stage A plan | 2026-10-31 |
| #45 | `140270a` | **Stage A** permission engine | 2026-10-31 |
| #46 | `92acd6e` | Stage B plan | 2026-10-31 |
| #47 | `8051e8d` | **Stage B** permissions in the tool gate | 2026-10-31 |
| #48 | `a942801` | **Stage C** permission API and live events | 2026-11-02 |

Stage reports exist for A, B and C (`docs/milestone-3b4-stage-{a,b,c}-report.md`). No PR, branch or plan exists for stages D–G. Intended changes for A–C are all merged; the intended changes for D–G do not exist.

## 3. Test and build results

All run on `a942801`, working directory the repository root, using scripts from `package.json`.

| Check | Command | Result |
|---|---|---|
| Full test suite | `npm test` (`vitest run`) | **77 files, 1168 tests passed, 0 failed, 0 skipped**, 4.66 s |
| Backend tests | included in the above (`server/**`) | pass |
| Frontend tests | included in the above (`src/**`, `scripts/**`) | pass. The project has one Vitest run; there is no separate frontend script |
| Permission and runtime integration | `server/permissions/*.test.ts`, `server/permissionsWiring.test.ts`, `server/toolGate.integration.test.ts`, `server/runtime/*.test.ts` | pass (inside the full run) |
| Real HTTP/SSE end to end | `server/e2e/realServer.test.ts` (7 tests) | pass. It covers health, auth, workspaces, SSE, demo approval, cancel, resume. **It does not exercise `/api/permissions` or `permission.changed`**; those are tested over a real listening server in `server/http/permissionsRoutes.test.ts` and `sse.test.ts` |
| TypeScript, server | `npx tsc -p tsconfig.server.json --noEmit` | no errors |
| TypeScript + frontend build | `npm run build` (`tsc -b && vite build`) | built in 2.57 s. Warning: main chunk 1,332 kB (over 500 kB, pre-existing) |
| Backend production build | `npm run server:build` | built, `dist-server/index.js` 146.82 kB |
| Secret scan | `npm run check:secrets` | no secrets in `dist/` or `dist-server/` (12 files) |
| Dependency audit | `npm audit` | **found 0 vulnerabilities** |
| Coverage | not available | no coverage provider is configured; not run |

Not executed: a coverage run (no tool configured), and a manual browser run (out of scope for a read-only audit). Known flake noted by the stage C report: `server/redact.test.ts` has a hard 250 ms budget and can fail under parallel load; it passed here.

## 4. Dynamic permission audit

Code: `server/permissions/{types,engine,defaults,pathPattern,storage,store,view}.ts`; manager wiring in `server/taskManager.ts` (`approveTool`, `permitTool`, `trackCall`, `abortCallsOf`, `revokePermission`, `revokeAgentPermissions`).

| Requirement | Finding | Evidence |
|---|---|---|
| Global policies | Yes. Seeded defaults: Read/Glob/Grep allow; Write/Edit ask; Bash/WebFetch/WebSearch deny (`defaults.ts`) | `engine.test.ts`, `store.test.ts` |
| Agent-specific | Yes, scope `agent`, with optional `pathPattern` | `engine.test.ts` |
| Task-specific | Yes, scope `task`; ended by `endTask` when the task finalizes (`taskManager.ts:248`) | `store.test.ts`, `gateIntegration.test.ts` |
| Allow once | Yes. Bound to the exact action digest, consumed by `consumeOnce` (synchronous, so one winner) | `gateIntegration.test.ts` |
| Allow for task / agent | Yes through `decideApproval` choices `allow_task`, `allow_agent`; execute and network tools can only be allowed once (`validateGrant`) | `permissionsWiring.test.ts` |
| Deny / Ask / Revoke | Yes. Deny beats everything; at equal scope Ask beats Allow | `engine.test.ts` |
| Expiry | Yes. Evaluated lazily at every decision (`ruleState`), plus a sweep timer that emits `expired` events (`app.ts:130`) | `engine.test.ts`, `store.test.ts` |
| Revocation during an active task | Yes. The next use is refused at `permitTool`; a call already running is aborted if its rule is `task` or `once` scope | `gateIntegration.test.ts`, `permissionsRoutes.test.ts` |
| Precedence | `deny rule` > `once` > `task` > `agent` > `global` > default deny. An unexpected error is a deny | `engine.ts:evaluate` |
| Default deny | Yes: no matching rule gives deny (`source: 'default'`); a corrupt rules file falls back to defaults, never allow-all | `engine.test.ts`, `storage.test.ts` |
| Persistence and restart | `permissions.json` (atomic write) is reloaded on start; corrupt or newer-version files are backed up and the defaults are used. Memory changes first, so a failed save never leaves a revoked rule in force | `storage.test.ts`, `store.test.ts` |

**Can permissions change while an agent runs, without a restart?** Yes, on the backend. Rules live in memory, are evaluated at the approval step and again immediately before `perform`, and `POST/DELETE /api/permissions` take effect at once. Verified by tests through the real manager. **No browser can do this today** (no UI), only an authenticated API client.

Limitations:

1. Revoking an `agent` or `global` rule does not abort a call that is already executing; it only stops the next one (`taskManager.ts:abortCallsOf`, by design). Aborting is cooperative and needs the tool's `perform` to honour the signal; no real `perform` exists yet.
2. Rules for ended tasks stay in `permissions.json` as history (inert, because a task or once rule needs the same task id). Tasks interrupted by a crash do not run `endTask` on restart; their rules are harmless but not marked ended.
3. The per-agent **workspace allowlist** is explicitly out of scope (design §8.7), so agent permissions cannot be scoped to a workspace except by `pathPattern`.
4. `PermissionRule.createdBy` is a label, not an identity; there is a single local operator.

## 5. Live approval workflow audit

| Step | Where | Real or simulated |
|---|---|---|
| 1. Agent requests a restricted action | `ctx.tools.use()` (`toolGate.ts`) | **Real gate.** Only the mock provider calls it, with a fixed demo Write (`MOCK_DEMO_WRITE`) |
| 2. Backend creates the request | `approveTool` sets `run.toolWaiter`, emits `approval_requested`, task becomes `waiting_for_approval` | Real |
| 3. Frontend receives it by SSE | State events through `/api/events`; the existing approval panel shows it | Real transport; UI only knows the legacy approve/deny |
| 4. User reviews exact action | `ToolReviewBody` (full content, or old/new strings) bound to the digest; unreviewable content (invisible characters, secrets, oversize) is refused outright | Real |
| 5. Decision | `POST /api/tasks/:id/approval` with `approvalId`, `digest`, decision | Real; the **browser only sends approve/deny**, not scoped choices |
| 6. Backend validates | `decideApproval`: pending id and digest must match, else 409; the permission rule is recorded before the runtime is answered, and if it cannot be recorded the approval stays pending | Real |
| 7. Resume or reject | `settleTool` resolves the runtime's promise; the gate re-checks workspace, digest, policy and rules, then runs `perform` | Real gate; `perform` is a no-op for the mock |

| Property | Finding | Tests |
|---|---|---|
| Digest integrity | SHA-256 over canonical JSON of task, workspace id, workspace real path, tool, input (deep-frozen copy) | `toolGate.test.ts` |
| Stale approval | Digest recomputed at use time; any change returns `stale_approval` and audits `tool.stale` | `toolGate.integration.test.ts` |
| Duplicate approval | A second decision gets 409 (`That approval is no longer pending`); once-grants are consumed once | `permissionsWiring.test.ts` |
| Concurrent requests | One prompt per task; others queue FIFO, bound `MAX_QUEUED_APPROVALS` (8), then `approval_pending` deny. After each decision queued requests are re-authorised from scratch (`promote`) | `gateIntegration.test.ts` |
| Timeout | `approvalTimeoutMs` (300 s default) ends the wait as `expired` | `taskManager.test.ts` |
| Cancel while waiting | `settleAll` resolves pending and queued requests as cancelled | `taskManager.test.ts` |
| Revocation during task | See §4 | `gateIntegration.test.ts` |
| Audit | `tool.asked/allowed/denied/stale`, `approval.requested/decided/timeout`, `permission.granted/denied/revoked/expired/used`, with 12-character digest prefix and `actionHash`, never the input | `audit.test.ts`, `auditWiring.test.ts` |
| SSE reconnection | `Last-Event-ID` or `?lastEventId` replay; otherwise `state.reset`. A pending approval is part of the state snapshot, so it is recovered | `sse.test.ts`, `e2e/realServer.test.ts` |

The task state allows only one pending approval. Recovery of pending requests after a **server restart** is not supported: running tasks do not survive one.

## 6. Gated tool security audit

Honest framing: the tool catalogue (`server/toolPolicy.ts:TOOL_CATALOGUE`) is a **policy and approval layer**. There is no `server/fileOps.ts`, no `server/sensitivePaths.ts` and no `server/tools/` directory (stage E). No code in the repository reads, writes, searches or executes anything on behalf of a tool; `noProcessExecution.test.ts` forbids `child_process`, `exec`, `spawn`, `fork` and `worker_threads` in all non-test sources, and passes.

| Tool | Implementation | Backend authorization | Policy actually used | Workspace validation | Approval | Path traversal | Symlink | Audit | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Read | **Policy only** (no file read) | Yes (`approveTool`, `permitTool`) | global allow (default) | Yes (`checkPathInWorkspace`) | None by default | Yes (rejects `..`, absolute, outside) | Yes (`unsafe_symlink`; hard links `unsafe_link`) | Yes | `toolPolicy.test.ts`, `workspaces.test.ts` |
| Glob | Policy only | Yes | global allow | Yes; glob must not start with `/` or `~` or contain `..` or `\` | None | Yes | Yes | Yes | `toolPolicy.test.ts` |
| Grep | Policy only | Yes | global allow | Same as Glob | None | Yes | Yes | Yes | `toolPolicy.test.ts` |
| Write | Policy only (no write) | Yes | global ask, with full-content review | Yes | Required by default; can be allowed once, per task, per agent, or globally | Yes | Yes | Yes | `toolPolicy.test.ts`, `gateIntegration.test.ts` |
| Edit | Policy only | Yes | global ask, with old/new string review | Yes | As Write | Yes | Yes | Yes | same |
| Bash | **Policy only; never runs** | Yes | global **deny**; an allow rule is only valid as once-scope | N/A (no workspace path argument) | Needs a human to revoke the default deny, then approve once per exact command | N/A | N/A | Yes | `toolPolicy.test.ts`, `engine.test.ts` |

Specific questions:

- **Could built-in SDK Write/Edit bypass the gate?** Not today, because no SDK exists. The risk is real for 3B.5: SDK built-ins run after `canUseTool` returns. `server/runtime/claudeAgent.ts` documents this as a "KNOWN GAP", and `docs/gated-tools.md` (design only) prescribes disallowing built-ins and offering in-process `vo_*` tools. **Nothing implements it.**
- **Can Bash execute arbitrary host commands?** No. Nothing spawns a process (enforced by `noProcessExecution.test.ts`). A command is only validated (non-empty, at most 10,000 characters) and shown to a person; there is no command allowlist or argument parsing, because there is no executor.
- **User-controlled arguments bypassing validation?** Unknown input fields are refused (`ALLOWED_FIELDS`), glob patterns are checked for `..`, absolute and home paths, and summary text containing invisible or bidi characters is refused. No tested bypass was found.
- **Can filesystem operations escape workspaces?** There are no operations. The path check itself is strong: lexical check, `realpath` of the deepest existing ancestor, dangling-symlink rejection, `..` rejected outright, hard-link rejection.
- **Revalidated immediately before execution?** Yes: `createToolGate.use` re-resolves the workspace, recomputes the digest, re-runs `decideToolUse`, then `permitTool` re-evaluates the rules and spends a once-grant, then `track` registers the call. There is nothing between `permit` and `track`.
- **TOCTOU?** Still present and documented (`server/workspaces.ts` header): the checks are at one moment and a real `perform` would open the path later. The fix (descriptor-based `openat`-style walk with `O_NOFOLLOW`, `fstat`, `nlink === 1`) is designed but unbuilt.
- **Can revoked permissions still authorize later actions?** No: `permitTool` re-evaluates at use time and refuses with `revoked_or_changed`. A used once-grant cannot be reused (`already_used`).
- **Sensitive-path denylist** (`.env*`, `.git/`, `*.pem`, `.ssh`, the data folder) planned for every tool including reads: **not implemented.** A global Read allow can read any file inside an approved workspace, including `.env`, once a real Read exists.

## 7. Browser and API authentication audit

| Control | Status | Evidence |
|---|---|---|
| Backend bearer token (256-bit, `data/api-token`, mode 0600, constant-time compare) | **Implemented** | `server/auth.ts`, `auth.test.ts` |
| Host and Origin allowlists, JSON-only mutations, preflight, in that order | **Implemented** | `server/http/guards.ts`, `guards.test.ts` |
| Every route except `GET /api/health` needs the token, including SSE and requests with no Origin | **Implemented** | `guards.ts`, `e2e/realServer.test.ts` |
| Token never in URLs, logs, audit, responses or bundles | **Implemented and scanned** | `secret.test.ts`, `disclosure.test.ts`, `check:secrets` (passes) |
| Binds to loopback only | **Implemented** | `config.test.ts` |
| Vite proxy injects the token; `data/` and `api-token*` are not served | **Implemented** | `vite.config.ts`, `scripts/apiProxy.ts`, `scripts/viteProxy.test.ts`, `scripts/viteServes.test.ts` |
| Session cookie (`vo_session`, HttpOnly, SameSite=Strict), session expiry and logout | **Documented only** (`docs/browser-auth.md` option B). `grep` finds no session code. Stage D not built |
| CSRF | No cookies exist, so classic CSRF does not apply. The existing layers are Origin allowlist, JSON-only and the bearer header |
| Direct API access without a token | Refused with 401 (tested) |
| Another local process | **Not stopped at the proxy.** Any local program that can reach port 5173 can send `Sec-Fetch-Site: same-origin` and be given an authenticated path. `docs/browser-auth.md` states this plainly. Direct access to port 8787 does need the token, which sits in a 0600 file readable by the same OS user, so a same-user process can read it. This is a limitation of native execution with no sandbox |
| Production serving | `server:start` plus a static `dist/` has **no way for a browser to authenticate** without the dev proxy, so the UI cannot be used outside `dev:full` |

## 8. Security regression audit (vs 3B.1.1 and 3B.1.2)

| Control | Verdict | Note |
|---|---|---|
| Workspace allowlist | Intact | `workspaces.ts` unchanged by A–C in behaviour |
| Canonical path validation | Intact; **re-run at use time** by the gate |
| Secret redaction | Intact; Write/Edit review is refused if redaction would change the text |
| API authentication | Intact; new `/api/permissions*` routes sit behind the same guard list |
| Tool allowlist (`ALLOWED_TOOLS`) | Intact and now a **ceiling** above permission rules, so an allow rule cannot enable a tool outside it |
| Approval digest | Strengthened: decisions must name the digest; once-grants bind to it |
| Audit log protection | Intact (append-only, 0600, rotation, no inputs or absolute paths); six new actions |
| Output size limits | Intact in the manager; N/A for tools (none exist) |
| Task timeout, cancellation | Intact; per-call abort signals are chained to the task signal |
| Error information disclosure | Intact: fixed sentences per grant error; views omit digest and server paths (`view.ts`) |

**Weakening that is by design:** a person can now create a **global allow for Write/Edit**, removing the per-action prompt for every agent. It is still subject to policy, review building, workspace checks and the use-time re-check, but with no real tools it is currently inert.

**New attack surface:** `POST/DELETE /api/permissions` and `/api/agents/:id/permissions`. Anyone holding the API token can grant allow rules; this is the intended single-operator model. With the dev-proxy limitation above, a local process able to reach port 5173 can therefore grant itself permissions. This is a realistic concern the moment a real tool exists.

## 9. Mock runtime vs real runtime

| Fact | Status |
|---|---|
| Default runtime | `ServerMockProvider` wrapping `MockRuntimeProvider` (`RUNTIME=mock`) |
| Works with the mock | Task lifecycle, SSE, approvals through the **real** gate and permission engine (demo Write to `simulated.txt`; `perform` is a no-op), revocation, timeouts, cancel |
| Backend-only, not connected to any agent that can act | Permission API, scoped grants, `permission.changed` events, tool policy for all six tools |
| Frontend simulations | The browser's own `MockRuntimeProvider` and `LocalWorkforceController`; the existing approval panel |
| Host command or filesystem execution possible? | **No.** `noProcessExecution.test.ts` passes; no file-access code exists beyond read-only path checks and the state/audit/permissions/token files |
| Claude Agent SDK installed? | **No.** Not in `package.json` or the lockfile; `SDK_INSTALLED = false` in `server/runtime/claudeAgent.ts` |
| Real Claude execution integrated? | **No.** `ClaudeAgentRuntimeProvider.start` always returns failure ("Claude Agent SDK not installed"). `src/workforce/runtime/claudeRuntime.ts` is a browser-side unavailable stub |

## 10. 3B.5 readiness assessment

**Overall verdict: NOT READY.**

| Area | Rating | Reason |
|---|---|---|
| 1. Provider integration | READY WITH ISSUES | The `ServerRuntimeProvider` contract, `StartContext`, event stream, status/result and the gate are in place; `claudeAgent.ts` documents the rules. Needs the single reviewed exception for process spawn |
| 2. SDK compatibility | NOT READY | SDK absent; option names in `claudeAgent.ts` are intent only and unverified against a real version |
| 3. Custom tool integration | NOT READY | No `vo_*` tools, `fileOps` or denylist (stage E) |
| 4. Permission callback and approval | READY | `ctx.tools.use` maps cleanly onto `canUseTool` and in-process tool handlers; revocation, queueing and digests are tested |
| 5. Streaming events | READY WITH ISSUES | Event pipeline, caps and redaction exist; mapping real SDK message types is untested |
| 6. Cancellation and timeout | READY WITH ISSUES | Manager timers and grace period exist; no real process or session has been aborted yet |
| 7. Native host security | NOT READY | See issues B1 to B3 |
| 8. Browser authentication | NOT READY | Dev proxy only; no cookie session |
| 9. Test coverage and reliability | READY WITH ISSUES | Strong (1168 tests), but there is no coverage measurement, no real-tool tests, and one timing-sensitive flake |

### Issues

| # | Severity | Issue | Where | Reproduction or consequence | Recommended resolution | Blocks 3B.5 |
|---|---|---|---|---|---|---|
| B1 | **Critical** | Gated file tools and `fileOps` do not exist; the SDK's built-in Write/Edit/Read would run after `canUseTool` | `docs/gated-tools.md` (design), `claudeAgent.ts` "KNOWN GAP" | An SDK session using built-ins can touch files after the gate approves, bypassing the use-time check | Build stage E: descriptor-based `fileOps`, `vo_*` tools whose handler **is** `perform`, disallow every SDK built-in | **Yes** |
| B2 | **High** | No sensitive-path denylist; a global Read allow would expose `.env`, `.git/`, keys and `data/` inside a workspace | planned `server/sensitivePaths.ts`, absent | After B1, `Read` of `.env` in an approved workspace is allowed by default | Implement the denylist for every tool including reads, plus tests | **Yes** |
| B3 | **High** | Native execution has no sandbox: a same-user process or the model's session can read `data/api-token` and `permissions.json` | `server/auth.ts`, `docs/native-host-execution.md` | An agent allowed to read the data folder (no denylist) or any same-user program can obtain the token and grant itself permissions | Denylist for the data directory (B2), keep Bash always denied, move the token out of any agent-readable workspace, document the residual same-user risk | **Yes** (document and mitigate) |
| B4 | **High** | No browser session (stage D); production serving cannot authenticate, and any local program reaching the dev proxy is authenticated | `docs/browser-auth.md`, `scripts/apiProxy.ts` | `curl -H 'Sec-Fetch-Site: same-origin' http://127.0.0.1:5173/api/...` gets the injected token | Build the cookie session before allowing any real write; keep the proxy for dev only | **Yes** for real writes |
| B5 | **High** | No frontend for permissions or scoped decisions (stage F) | `src/workforce/remote/commands.ts` sends only approve/deny; no `/api/permissions` caller | A person cannot review, grant, scope or revoke permissions in the product; only a token-holding API client can | Build stage F | No for a backend spike; **Yes** for a usable 3B.5 |
| B6 | **Medium** | TOCTOU between gate check and file access remains | `server/workspaces.ts` header | A same-user process swaps a directory for a symlink after the check | Resolved by B1's descriptor-based operations and use-time checks | Yes (part of B1) |
| B7 | **Medium** | Real SDK abort of an in-flight call is untested; revoke-abort depends on `perform` honouring the signal | `taskManager.ts:abortCallsOf` | A tool that ignores `signal` keeps running after a revoke | Require and test `signal` handling in every `vo_*` handler | Yes (part of B1) |
| B8 | **Medium** | End-to-end test does not cover permissions over the real server with SSE (stage G) | `server/e2e/realServer.test.ts` | None of the 7 tests grants or revokes a permission | Add a real server test: grant, revoke, `permission.changed` over SSE, replay | No |
| B9 | **Medium** | Tasks interrupted by a restart never run `endTask`; per-task rules stay "active" in the file | `taskManager.ts:248`, `store.ts` | Inert, but the Global/Agent view may show stale entries | Mark task and once rules ended on startup for tasks not running | No |
| B10 | **Low** | `redact.test.ts` timing flake; no coverage tool; 1.3 MB single frontend chunk | `server/redact.test.ts`, `vite.config.ts` | Intermittent CI failure; slow first load | Raise the budget or use a work-count assertion; add `@vitest/coverage-v8` in a separate PR; code-split | No |
| B11 | **Low** | `Bash` has no command parsing or allowlist | `toolPolicy.ts` | Not exploitable now (never runs). A once-approval on arbitrary shell text is a human judgement | Keep `Bash` and `vo_run` always denied in 3B.5; design a restricted runner separately | No |

**Native host execution limits (no Docker, as decided):** there is no OS-level isolation. Workspace and path checks are policy, not a sandbox. A same-user process, or anything the model can be made to read or run, shares the user's privileges, the API token and the data directory. The mitigations are: no Bash, a denylist, descriptor-based file operations, loopback binding, the token file at 0600, and one reviewed process-spawn exception at most.

## 11. Known limitations and blockers

1. Stages D, E, F, G of 3B.4 are not built. This is the main finding, and the reason the milestone cannot be called complete.
2. No real tool performs any operation; everything verified is policy, approval and audit.
3. No browser UI for permissions; browsers send only approve/deny.
4. The dev proxy is not authentication against local programs.
5. No coverage measurement.
6. The Claude runtime is a stub that always reports unavailable.

## 12. Recommended next steps

**Mandatory blockers before 3B.5** (in order, one branch and PR each, as the design prescribes):

1. **Stage E** `feat/3b4-e-gated-tools`: `sensitivePaths.ts` (applied to every tool, including the data folder), `fileOps.ts` (descriptor walk, `O_NOFOLLOW`, `fstat` regular file with `nlink === 1`, size caps, atomic temp-file rename, abort checked before every step), `vo_read/glob/grep/write/edit`, `vo_run` always denying. Tests: symlink swap, hard link, directory, size, abort, two writers, denylist, workspace-escape attempts. `noProcessExecution.test.ts` stays untouched.
2. **Stage D** `feat/3b4-d-browser-session`: implement `docs/browser-auth.md` option B (cookie, expiry, logout, rotation on restart, credentials for exact origins only, works without the proxy).
3. **Stage F** `feat/3b4-f-permission-ui`: permissions panel, four-choice request modal, pending/history lists, revoke, status chips. Needed so a person, not an API client, controls permissions.
4. **Stage G** `test/3b4-g-e2e-report`: real-server test of grant, revoke and `permission.changed` over SSE, then the closing report.

**Recommended hardening:** startup reconciliation of rules whose task is gone (B9); require `signal` handling in every tool handler (B7); fix the redact timing flake; add coverage reporting.

**Optional:** code-split the frontend bundle; show the audit log read-only in the UI.

**Deferrable:** per-agent workspace allowlist (design §8.7); a restricted Bash runner; VPS/TLS deployment; Docker, which is not required.

**3B.5 plan (do not start until the blockers are closed):**

1. 3B.5a: add the SDK as a dependency in its own PR, verify option names against the installed version, and update the guard allowlist for the single spawn exception with a written justification.
2. 3B.5b: `ClaudeAgentRuntimeProvider` with `permissionMode: 'default'`, `settingSources: []`, every SDK built-in disallowed, only the in-process `vo_*` tools, `cwd` set to `ctx.workspace.path`, and credentials read from the server environment only.
3. 3B.5c: map SDK messages to `RuntimeEvent` with caps and redaction; abort and cancel wiring.
4. 3B.5d: a controlled, read-only task first, then Write behind approval, then an end-to-end review.

---

Audit commands run: `git log`, `gh pr list --state merged`, `npm test`, `npx tsc -p tsconfig.server.json --noEmit`, `npm run build`, `npm run server:build`, `npm run check:secrets`, `npm audit`, plus file reads and `grep`. No source file was modified.
