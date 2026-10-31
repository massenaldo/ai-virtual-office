# 3B.1 Stage C: Security Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and test the security boundaries a real runtime will plug into, while the backend still runs only the mock runtime:
- workspaces by id, with path containment that checks real paths;
- a tool catalogue and policy (`allow` / `deny` / `ask`) whose `ask` goes through the existing approval flow in the task manager;
- HTTP guards: a Host allowlist against DNS rebinding, an Origin allowlist, JSON-only state changes (including body-less routes), CORS, request ids and hardening headers;
- an append-only, size-capped JSON Lines audit log;
- secret redaction and leak tests;
- a documented, still unavailable `ClaudeAgentRuntimeProvider` boundary.

The browser UI is not changed in this stage.

**Architecture:**
- **Pure, tested decision modules, with thin wiring:**
  - `server/redact.ts`: `redactSecrets`, `scrub`, `redactingLogger`.
  - `server/workspaces.ts`: `resolveWorkspace`, `checkPathInWorkspace`.
  - `server/toolPolicy.ts`: `TOOL_CATALOGUE`, `decideToolUse`, `toolDeniedMessage`.
  - `server/http/guards.ts`: `createSecurityGuards`, `securityHeaders`.
  - `server/audit.ts`: `openAuditLog`.
- **`TaskManager` stays the only owner of lifecycle and timers.**
  - A runtime asks for tool permission only through `StartContext.requestToolApproval`, which is bound to one task.
  - The manager runs `decideToolUse`. An `ask` becomes the existing `waiting_for_approval` state, approval timer and `POST /api/tasks/:id/approval` endpoint.
  - The manager settles the runtime's promise exactly once: approved, denied, expired or cancelled.
- **The guards use the Stage B seams:**
  - `RouterOptions.guards`;
  - `responseHeaders`, which the router already applies before a handler writes its own response, so the SSE stream gets them too (`router.ts` line "A handler that writes its own response …");
  - a new `onRejected` callback for coded `HttpError`s.
- **Every audit record comes from one of three places:**
  - `TaskManagerOptions.onLifecycle`, extended to a full `LifecycleEvent`;
  - the guards' `onReject` and the router's `onRejected`;
  - `startServer`, which writes `config.startup`.
- **Shared model:** `AgentTask` gains `workspaceId: string | null`. Schema v2 is kept: a missing field reads as `null`, so no migration and no new storage key are needed.

**Tech Stack:** Node 24 (`node:http`, `node:fs` sync calls, `node:path`, `node:crypto` `randomBytes`), TypeScript 5.7, Vitest 5 in Node, and the existing `tsx`. **No new dependencies.** The Claude Agent SDK is not installed (Q1).

**Spec:** `plan.md` §3, §5, §6, §8 and §10, and `tasks.md` (decisions 8, 9 and 10, the Stage C checklist including the two Stage B review findings, and the Q1–Q5 answers). This builds on the merged Stages A (#21, `4efd382`) and B (#22, `3773c97`). Branch: `feat/security-foundation`, worked on in place (no sibling worktree folder).

## Global Constraints

- **No process execution, no SDK, no new dependencies.**
  - `server/noProcessExecution.test.ts` stays green.
  - `ClaudeAgentRuntimeProvider` stays unavailable.
  - `dist-server/index.js` still imports only `node:*`.
- **No permission bypass of any kind.**
  - No config variable, option, tool, catalogue entry or code path skips `decideToolUse` or human approval.
  - The strings `dangerously`, `bypassPermissions`/`bypass_permissions` and `skip-permissions`/`skip_permissions` must not appear in non-test sources. The one allowlisted line is the `REFUSED_ENV_PATTERN` line in `server/config.ts` (Task 6 guard test).
  - The Claude doc block says "a permission mode other than `default`" instead of naming bypass modes.
- **`HOST` stays loopback-only** (Ruling 3). `ALLOWED_ORIGINS` is the only new network setting.
- **The browser never sends paths or commands.**
  - It can send only `workspaceId`, a string id.
  - Absolute workspace paths never appear in responses, events, state, errors, health, audit records or logs written by request handling. `config.startup` and audit records carry ids only.
- **Errors** stay JSON `{ "error": string }`. Stack traces never appear in responses. Every reply (JSON, 204, SSE, guard rejections) carries `X-Request-Id`.
- **Imports are extensionless, with `import type` for types**, as in Stage B. The server modules take `now: () => string` and a `Logger` as injectable dependencies.
- **`src/` changes are limited to these:**
  - `types.ts`: `AgentTask.workspaceId`;
  - `operations.ts`: the `assignTask` option;
  - `storage.ts`: parse and serialize `workspaceId`;
  - `api.ts`: `CreateTaskBody.workspaceId`, `WorkspacesResponse`, `MUTATION_HEADERS`;
  - `workspaceId: null` added to the `AgentTask` literals in four test files.
  - `src/workforce/*` must keep passing `claudeRuntime.test.ts`'s guard: no `fetch(`, `apiKey`, `ANTHROPIC_` or `child_process`.
- **Server tests:** the same setup as Stage B (Vitest in Node, port 0, temp `DATA_DIR`, real `fetch`).
  - Node's `fetch` **silently drops a custom `Host` header** (checked locally on Node 24.14), so Host tests use the new `rawRequest` helper on `node:http`.
  - On macOS `os.tmpdir()` is a symlink (`/var/…` → `/private/var/…`), so tests compare against `realpathSync` paths.
- **New config variables** (all errors are collected; an empty string counts as unset, as before):

  | Variable | Default | Validation and error copy |
  |---|---|---|
  | `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma list, trimmed, empty items dropped. `none` → `[]`. At most 16. Per entry: `*` → `ALLOWED_ORIGINS must list exact origins; "*" is not allowed.`; `null` → `ALLOWED_ORIGINS must list exact origins; "null" is not allowed.`; unparsable → `ALLOWED_ORIGINS entry "<e>" is not a valid origin (expected something like http://localhost:5173).`; not http/https → `ALLOWED_ORIGINS entry "<e>" must use http or https.`; `new URL(e).origin !== e` → `ALLOWED_ORIGINS entry "<e>" must be an origin only, like <origin>.`; more than 16 → `ALLOWED_ORIGINS lists more than 16 origins.` |
  | `WORKSPACE_ROOT` | unset (no workspaces) | Absolute: `WORKSPACE_ROOT must be an absolute path (got "<v>").` Existing directory: `WORKSPACE_ROOT must be an existing directory (got "<v>").` Not `/` after realpath: `WORKSPACE_ROOT must not be the filesystem root.` Stored as its **realpath**. |
  | `WORKSPACES` | unset (none) | Needs the root: `WORKSPACES needs WORKSPACE_ROOT.` Format `id:relative/path,…`, trimmed, at most 32. See Task 2 for the per-entry copy. |
  | `ALLOWED_TOOLS` | `Read,Glob,Grep,Write,Edit` | Comma list, trimmed, de-duplicated, case-sensitive. `none` → `[]`. `*` or `all` → `ALLOWED_TOOLS must list tool names; "<v>" is not allowed.` Unknown → `ALLOWED_TOOLS has an unknown tool "<t>". Known tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, WebSearch.` |
  | `AUDIT_LOG_MAX_BYTES` | `5242880` | Integer from 65536 to 1073741824: `AUDIT_LOG_MAX_BYTES must be from 65536 to 1073741824 (got "<v>").` |
  | any variable matching `REFUSED_ENV_PATTERN` | not applicable | `<NAME> is not supported: this server has no way to skip permission checks. Remove it.` |

  - **Changed copy for `HOST`:** `HOST must be a loopback address (127.0.0.1, ::1 or localhost) (got "<v>"). Remote access needs TLS and authentication, which this server does not have yet.`
- **New error copy (status and exact `error`):**

  | Status | Copy | Where |
  |---|---|---|
  | 421 | `Host not allowed.` | Host guard |
  | 403 | `Origin not allowed.` | Origin guard (sent with no CORS headers) |
  | 415 | `Content-Type must be application/json.` | JSON-only guard (same copy as `body.ts`) |
  | 503 | `Too many open event streams (limit <n>).` | `GET /api/events` |
  | 400 | `"workspaceId" must be a string or null.` | `parseCreateTask` |
  | 400 | `"workspaceId" must be a workspace id: 1–32 lowercase letters, digits or hyphens.` | manager, `invalid_id` |
  | 422 | `Workspaces are not configured on this server.` | manager, `not_configured` |
  | 422 | `Unknown workspace "<id>".` | manager, `unknown` |
  | 422 | `Workspace "<id>" is not available.` | manager, `missing` and `escapes_root` (the audit record keeps the exact reason) |
  | 422 | `The claude runtime needs a workspace.` | manager (reachable today only with a fake `claude`-kind provider) |

- **Tool-gate messages** (returned to the runtime, and shown as `errorMessage` when the mock fails on them):
  - policy deny: `Tool "<tool>" denied by policy: <text>.`
  - human deny: `Denied by a human reviewer.`
  - expired: `No approval decision within <n> s` (the existing `APPROVAL_TIMEOUT_MESSAGE`)
  - cancelled: `The task is no longer running.`
- **Mock demo tool request:** tool `Write`, input `{ file_path: 'simulated.txt', content: 'Simulated content (nothing is written).' }` (39 bytes), so the summary is `Write simulated.txt (39 B)`. Nothing is written, ever.
- **Constants:**
  - `SUMMARY_MAX_CHARS = 200`
  - `AUDIT_DETAIL_MAX = 512`
  - `AUDIT_FIELD_MAX = 64`
  - `REJECTED_PER_MINUTE = 30`
  - `MAX_EVENT_STREAMS = 20`
  - `MAX_STREAM_BUFFER_BYTES = 1048576`
  - `PREFLIGHT_MAX_AGE_S = 600`
  - `MAX_PATH_CHARS = 4096`

## Review Focus

1. **DNS rebinding, or another local web page driving the API.**
   - A rebinding page (`Host: evil.example:8787`) reading `/api/state` or `/api/events` gets 421.
   - A cross-origin `text/plain` POST to the body-less cancel route gets 403 (Origin) or 415 (no Origin, wrong type), and the task is still active afterwards.
   - A preflight from a disallowed origin gets 403 with no CORS headers.
   - Tests: Task 4 `rejects a foreign Host header (DNS rebinding)`, `a cross-origin simple POST cannot reach a body-less route`, `refuses a preflight from another origin`.
2. **Escaping a workspace.**
   - Escape attempts: `..`, absolute paths, NUL, backslash, an over-long or empty id, a symlink inside the workspace pointing out, a dangling symlink used as a write target, and the workspace directory itself swapped for an outside symlink after startup.
   - Each one is rejected by the real-path check, not only the lexical check.
   - Tests: Task 2 `resolveWorkspace` and `checkPathInWorkspace` tests, especially `rejects a workspace swapped for an outside symlink after startup` and `refuses a write through a dangling symlink`.
3. **A tool request that never gets an answer, or outlives its task.**
   - Cancel, task timeout, approval timeout, agent removal, provider end and `dispose` while waiting each settle the runtime's promise exactly once (`cancelled` or `expired`) and leave no timers.
   - A second concurrent request is denied.
   - A decision after the release gets 409.
   - Tests: Task 3 `cancel, timeout, removal and dispose release a waiting request as cancelled`, `approval timeout resolves expired and fails the task`, `a second request while one is pending is denied`.
4. **Getting around the policy.**
   - Unknown or unlisted tools are denied.
   - Write, execute and network tools always ask, even when allowlisted.
   - `ALLOWED_TOOLS=*`, an unknown tool name, or an env variable that looks like a bypass makes the server refuse to start.
   - No bypass strings appear in the sources.
   - Tests: Task 3 `always asks for write, execute and network tools even when allowlisted`, Task 1 `refuses permission-bypass variables`, Task 6 `has no permission-bypass options`.
5. **Secret or path leakage.**
   - The API key value, request bodies and absolute workspace paths never reach responses, events, the state file, logs, the audit log or the bundles.
   - Audit floods can't wipe history unnoticed (rate limit plus one rotation).
   - Tests: Task 5 `never writes the API key, request bodies or workspace paths`, Task 1 `limits request.rejected records per minute`, and Task 7's `npm run check:secrets` with a canary key.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `server/redact.ts` | Create | `redactSecrets`, `scrub`, `redactingLogger`, `findSecretInConfig` |
| `server/audit.ts` | Create | `openAuditLog` (JSON Lines, 0o600, rotation, rejected-request rate limit), `nullAudit`, the `AuditRecord` types |
| `server/workspaces.ts` | Create | `WORKSPACE_ID_RE`, `parseWorkspaces` (config), `resolveWorkspace`, `checkPathInWorkspace` |
| `server/toolPolicy.ts` | Create | `TOOL_CATALOGUE`, `DEFAULT_ALLOWED_TOOLS`, `decideToolUse`, `sanitizeSummary`, `toolDeniedMessage` |
| `server/http/guards.ts` | Create | `createSecurityGuards` (Host, Origin, preflight, JSON-only) and `securityHeaders` |
| `server/config.ts` | Modify | New variables, `CONFIG_VARIABLES`, `REFUSED_ENV_PATTERN`, HOST copy, secret self-check in `loadConfig` |
| `server/log.ts` | Modify | `recordingLogger` for tests (the redacting wrapper lives in `redact.ts`) |
| `server/http/router.ts` | Modify | Request ids, `Guard` info parameter, 204 replies, `HttpError.code`, `onRejected` |
| `server/http/body.ts`, `server/http/inputs.ts` | Modify | Reject codes; `parseCreateTask` accepts `workspaceId` |
| `server/http/routes.ts` | Modify | `GET /api/workspaces`, request ids to the manager, health `audit` |
| `server/http/sse.ts` | Modify | Stream cap (503) and slow-client cut-off |
| `server/taskManager.ts` | Modify | Workspace at start, `requestToolApproval`, waiter release, `LifecycleEvent`, `CallOptions`, redaction in `cap()` |
| `server/runtime/types.ts` | Modify | `StartContext` additions, `ToolRequest`, `ToolGateResult` |
| `server/runtime/mockProvider.ts` | Modify | The demo approval goes through `ctx.requestToolApproval` |
| `server/runtime/claudeAgent.ts` | Modify | `claudeUnavailableReason`, the integration documentation block |
| `server/app.ts` | Modify | Audit, guards, security headers, redacting logger, `config.startup` |
| `server/index.ts` | Modify | Logs through `redactingLogger(consoleLogger)` |
| `server/test/helpers.ts` | Modify | `api()` sends JSON content type on every non-GET request; `rawRequest` |
| `server/test/workspaces.ts` | Create | `makeWorkspaceRoot` temp-dir fixture |
| `server/test/startContext.ts` | Create | `testStartContext` |
| `server/test/fakeProvider.ts` | Modify | Optional `kind` |
| `server/test/sseClient.ts` | Modify | `headers` option |
| `src/workforce/types.ts`, `operations.ts`, `storage.ts`, `api.ts` | Modify | `workspaceId` (Ruling 6) and wire types |
| `scripts/secretScan.ts` | Create | Pure `findSecretLeaks` over built files |
| `scripts/checkSecrets.ts` | Create | CLI that reads `dist/` and `dist-server/` and exits 1 on a leak |
| `package.json` | Modify | `"check:secrets": "tsx scripts/checkSecrets.ts"` |
| `.env.example` | Modify | The new variable names (names only) |
| `tasks.md` | Modify | Tick the Stage C boxes (Task 7) |

**New tests:**
- `server/redact.test.ts`, `server/audit.test.ts`, `server/workspaces.test.ts`, `server/toolPolicy.test.ts`;
- `server/http/guards.test.ts`, `server/auditWiring.test.ts`, `server/secrets.test.ts`;
- `scripts/secretScan.test.ts`.

**Modified tests:**
- server: `config.test.ts`, `taskManager.test.ts`, `http/routes.test.ts`, `http/router.test.ts`, `http/sse.test.ts`, `app.test.ts`, `runtime/mockProvider.test.ts`, `runtime/claudeAgent.test.ts`, `noProcessExecution.test.ts`;
- src: `storage.test.ts`, `operations.test.ts`, `runtime/mockRuntime.test.ts`, `runtime/claudeRuntime.test.ts`.

---

### Task 1: Redaction, audit log module and config groundwork

No behaviour changes elsewhere. Nothing is wired yet.

**Files:**
- Create: `server/redact.ts`, `server/audit.ts`
- Modify: `server/config.ts`, `server/log.ts`, `.env.example`
- Test: `server/redact.test.ts`, `server/audit.test.ts`; modify `server/config.test.ts`

**Interfaces:**
- **Consumes:** `Logger` (`server/log.ts`), `Env`/`parseConfig` (`server/config.ts`).
- **Produces (`server/redact.ts`):**
  ```ts
  export const REDACTED = '[REDACTED]'
  export function redactSecrets(text: string): string
  export function scrub(text: string, maxChars?: number): string        // redactSecrets, then cut to maxChars (default AUDIT_DETAIL_MAX = 512) as text.slice(0, maxChars - 1) + '…'
  export function redactingLogger(inner: Logger): Logger                 // msg → redactSecrets; err → redactSecrets(err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err))
  export function findSecretInConfig(config: unknown, secret: string | undefined): string | null   // null when secret is unset or shorter than 8 chars, or JSON.stringify(config) doesn't contain it
  ```
  - The patterns are applied in this order (verified locally on Node 24):
    ```ts
    [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
    [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
    [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
    [/\b([A-Za-z0-9_.-]*(?:key|secret|token|password|passwd)[A-Za-z0-9_.-]*)("?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi, '$1$2[REDACTED]'],
    ```
  - False positives such as `tokens: 12` → `tokens: [REDACTED]` are accepted and documented in the module comment.
- **`server/log.ts` adds:**
  ```ts
  export function recordingLogger(): Logger & { lines: string[] }   // pushes `${level} ${msg}${err === undefined ? '' : ' ' + String(err)}`
  ```
- **Produces (`server/audit.ts`):**
  ```ts
  export const AUDIT_FILE = 'audit.log'
  export const AUDIT_ROTATED_FILE = 'audit.log.1'
  export const AUDIT_DETAIL_MAX = 512
  export const AUDIT_FIELD_MAX = 64
  export const REJECTED_PER_MINUTE = 30
  export type AuditAction = 'config.startup' | 'task.start' | 'task.cancel' | 'task.force_cancelled' | 'task.timeout' | 'approval.requested' | 'approval.decided' | 'approval.timeout' | 'tool.allowed' | 'tool.denied' | 'tool.asked' | 'workspace.rejected' | 'request.rejected' | 'runtime.note'
  export type AuditActor = 'api' | 'system' | 'runtime'
  export type AuditInput = { action: AuditAction; actor: AuditActor; requestId?: string; taskId?: string; agentId?: string; workspaceId?: string; tool?: string; decision?: string; reason?: string; detail?: string }
  export type AuditRecord = { at: string; seq: number } & AuditInput
  export type AuditStatus = { ok: boolean; error: string | null }
  export type AuditLog = { write(entry: AuditInput): void; readonly status: AuditStatus; readonly filePath: string }
  export type AuditOptions = { dataDir: string; maxBytes: number; now: () => string; log: Logger; hide?: string[] }   // hide: absolute paths replaced by '<workspace-root>'
  export function openAuditLog(opts: AuditOptions): AuditLog
  export const nullAudit: AuditLog                                     // write is a no-op, status { ok: true, error: null }, filePath ''
  ```
- **Record format.** One `JSON.stringify` line per record, keys in exactly this order:
  - `at`, `seq`, `action`, `actor`, `requestId`, `taskId`, `agentId`, `workspaceId`, `tool`, `decision`, `reason`, `detail`;
  - undefined keys are omitted.
  - Every string field except `detail` is `scrub(value, AUDIT_FIELD_MAX)`. `detail` is `scrub(hidePaths(value), AUDIT_DETAIL_MAX)`, where `hidePaths` replaces each `hide` entry with `<workspace-root>`.
  - `seq` starts at 1 per process. `at` is `now()`.
- **Write rules:**
  1. `openAuditLog`:
     - `mkdirSync(dataDir, { recursive: true })`;
     - if `audit.log` exists: `chmodSync(path, 0o600)`, and `size = statSync(path).size`; otherwise `size = 0`;
     - an error here sets `status = { ok: false, error: code ?? 'open failed' }` and logs once with `log.error('Audit log unavailable: <code>')`. The error is never the message, because messages contain the absolute path.
  2. `write`:
     - build the line;
     - if `size > 0 && size + bytes > maxBytes`: `renameSync(audit.log, audit.log.1)` (replacing any older `.1`) and `size = 0`;
     - `appendFileSync(path, line, { mode: 0o600 })`, then `chmodSync(audit.log.1, 0o600)` after a rename;
     - `size += bytes`.
     - Any throw sets `status` to `{ ok: false, error: code }`, logs once for each distinct code, and **never throws to the caller**.
     - A later successful write sets `status` back to `{ ok: true, error: null }`.
  3. **Rejected-request rate limit:**
     - `request.rejected` records are counted in fixed 60-second windows (`Math.floor(Date.parse(now()) / 60000)`);
     - past `REJECTED_PER_MINUTE` in a window they are suppressed and counted;
     - the first `request.rejected` written in a later window is preceded by `{ action: 'request.rejected', actor: 'system', reason: 'suppressed', detail: '<n> rejected requests were not logged' }`;
     - other actions are never limited.
- **Example lines** (these are the shapes Tasks 5 and 7 check):
  ```
  {"at":"2026-10-31T09:00:00.000Z","seq":1,"action":"config.startup","actor":"system","detail":"runtime=mock host=127.0.0.1 port=8787 credentialsConfigured=true workspaces=sandbox allowedTools=Read,Glob,Grep,Write,Edit allowedOrigins=http://localhost:5173,http://127.0.0.1:5173"}
  {"at":"2026-10-31T09:00:01.000Z","seq":2,"action":"request.rejected","actor":"api","requestId":"3f9a1c0b7d22","reason":"origin","detail":"POST /api/tasks/task-1a2b3c4d/cancel"}
  {"at":"2026-10-31T09:00:02.000Z","seq":3,"action":"workspace.rejected","actor":"api","requestId":"9b0e44a1c3f0","agentId":"agent-demo-backend","workspaceId":"nope","reason":"unknown"}
  {"at":"2026-10-31T09:00:03.000Z","seq":4,"action":"task.start","actor":"api","requestId":"0c1d2e3f4a5b","taskId":"task-5e6f7a8b","agentId":"agent-demo-backend","workspaceId":"sandbox"}
  {"at":"2026-10-31T09:00:05.000Z","seq":5,"action":"tool.asked","actor":"runtime","taskId":"task-5e6f7a8b","agentId":"agent-demo-backend","workspaceId":"sandbox","tool":"Write","decision":"ask","reason":"needs_approval","detail":"Write simulated.txt (39 B)"}
  {"at":"2026-10-31T09:00:05.000Z","seq":6,"action":"approval.requested","actor":"runtime","taskId":"task-5e6f7a8b","agentId":"agent-demo-backend","workspaceId":"sandbox","tool":"Write","detail":"approvalId=approval-1f2e3d4c"}
  {"at":"2026-10-31T09:00:09.000Z","seq":7,"action":"approval.decided","actor":"api","requestId":"77aa88bb99cc","taskId":"task-5e6f7a8b","agentId":"agent-demo-backend","decision":"approve"}
  {"at":"2026-10-31T09:00:10.000Z","seq":8,"action":"tool.denied","actor":"runtime","taskId":"task-5e6f7a8b","agentId":"agent-demo-backend","workspaceId":"sandbox","tool":"Read","decision":"deny","reason":"outside_workspace"}
  ```
- **`server/config.ts` additions in this task:**
  ```ts
  export const CONFIG_VARIABLES: readonly string[]   // every env name parseConfig reads, in .env.example order; grows in Tasks 2–4
  export const REFUSED_ENV_PATTERN = /DANGEROUSLY|BYPASS_?PERMISSIONS|SKIP_?PERMISSIONS|PERMISSION_MODE/i
  // ServerConfig gains: auditLogMaxBytes: number
  ```
  - `parseConfig` adds one error per env key matching `REFUSED_ENV_PATTERN`, in `Object.keys(env)` order, **before** the other variables. It also adds `AUDIT_LOG_MAX_BYTES` and the new HOST copy.
  - `loadConfig`, after a successful parse: `findSecretInConfig(config, merged.ANTHROPIC_API_KEY)` → if non-null, return `{ ok: false, errors: ['Refusing to start: a secret value reached the server config.'] }`.
  - `CONFIG_VARIABLES` after Task 1: `HOST, PORT, DATA_DIR, RUNTIME, TASK_TIMEOUT_MS, CANCEL_GRACE_MS, APPROVAL_TIMEOUT_MS, MAX_MESSAGE_BYTES, MAX_TASK_OUTPUT_BYTES, EVENT_BUFFER_SIZE, AUDIT_LOG_MAX_BYTES, ANTHROPIC_API_KEY`.
- **`.env.example`:**
  - adds `AUDIT_LOG_MAX_BYTES=` with the comment `# Size at which data/audit.log is rotated to audit.log.1, in bytes. Default 5242880`;
  - changes the HOST comment to `# Address the backend listens on (loopback only in this milestone). Default 127.0.0.1`.

- [ ] **Step 1: Write the failing tests.**
  - `server/redact.test.ts`:
    - `redacts known secret shapes`, as a table of `[input, expected]`:
      - `'key sk-ant-api03-abcdefghijklmnop end'` → `'key [REDACTED] end'`;
      - `'Authorization: Bearer abc.def-123456'` → `'Authorization: Bearer [REDACTED]'`;
      - `'api_key=xyz123&x=1'` → `'api_key=[REDACTED]&x=1'`;
      - `'password: "hunter2"'` → `'password: [REDACTED]'`;
      - `'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijkl'` → `'ANTHROPIC_API_KEY=[REDACTED]'`;
      - `'{"apiKey":"abc"}'` → `'{"apiKey":[REDACTED]}'`;
      - `'sk-proj-abcdefghijklmnopqrstuvwxyz'` → `'[REDACTED]'`;
    - `leaves ordinary text alone`: `'Build the REST API'` and `'no secrets here'` are unchanged;
    - `scrub truncates after redacting`: `scrub('a'.repeat(600))` has length 512 and ends `'…'`; `scrub('x sk-ant-api03-abcdefghijk', 10)` is `'x [REDACT…'`;
    - `redactingLogger redacts messages and errors`:
      - with `inner = recordingLogger()`, `redactingLogger(inner).error('failed sk-ant-api03-abcdefghijk', new Error('Bearer abcdefghijkl'))`;
      - `inner.lines[0]` starts `'error failed [REDACTED]'`, contains `'Bearer [REDACTED]'`, and does not contain `'abcdefghijk'`;
    - `findSecretInConfig`: `({ a: 'x sk-ant-test-canary' }, 'sk-ant-test-canary')` → a non-null string; `({ a: 1 }, 'sk-ant-test-canary')` → `null`; `({ a: 'short' }, 'short')` → `null` (under 8 chars).
  - `server/audit.test.ts` (temp dir, `now = () => NOW`, `NOW = '2026-10-31T09:00:00.000Z'`, `recordingLogger`):
    - `appends JSON lines with seq, at and fixed key order`: write `{ action: 'task.start', actor: 'api', requestId: 'abc123abc123', taskId: 'task-1', agentId: 'agent-1', workspaceId: 'sandbox' }`, then `{ action: 'task.cancel', actor: 'system', taskId: 'task-1', agentId: 'agent-1' }`. The first line equals exactly `{"at":"2026-10-31T09:00:00.000Z","seq":1,"action":"task.start","actor":"api","requestId":"abc123abc123","taskId":"task-1","agentId":"agent-1","workspaceId":"sandbox"}`, and the second parses with `seq: 2`;
    - `creates the file with mode 0o600 and tightens an existing one`: a fresh file → `statSync(...).mode & 0o777 === 0o600`; a pre-created file with mode 0o644 → 0o600 after `openAuditLog`;
    - `rotates once at the size cap`: with `maxBytes: 400` and 20 writes, `readdirSync(dir).sort()` equals `['audit.log', 'audit.log.1']`, `audit.log` is ≤ 400 bytes, every line in both files parses, the seqs read `.1` then `.log` and rise strictly, and `.1` has mode 0o600;
    - `scrubs secrets and hidden paths and truncates`: with `hide: ['/srv/ws']`, `detail: 'path /srv/ws/a key sk-ant-api03-abcdefghijk'` → `'path <workspace-root>/a key [REDACTED]'`; a 100-char `taskId` → 64 chars ending `'…'`; a 2000-char `detail` → 512 chars;
    - `never throws when writing fails and logs once`: create a directory at `<dir>/audit.log` → `status` equals `{ ok: false, error: 'EISDIR' }`; two `write` calls don't throw; `logger.lines.filter((l) => l.startsWith('error')).length === 1`;
    - `limits request.rejected records per minute`: with a mutable `now`, 35 rejections at `NOW` give 30 lines; then one at `NOW + 61 s` gives a `suppressed` line (`detail: '5 rejected requests were not logged'`, `actor: 'system'`) followed by that rejection; a `task.start` written during the suppressed window is still written;
    - `nullAudit does nothing`.
  - `server/config.test.ts` (modified Stage B tests: `uses the defaults for an empty environment` and `treats empty strings as unset`, where `DEFAULTS` gains `auditLogMaxBytes: 5242880`; `reads every variable` adds `AUDIT_LOG_MAX_BYTES: '65536'`; `refuses a non-loopback HOST` gets the new copy; `NAMES` becomes `CONFIG_VARIABLES`). New:
    - `reads AUDIT_LOG_MAX_BYTES and enforces its range`: `'1000'` and `'abc'` both give the range copy; `'65536'` → `65536`;
    - `refuses permission-bypass variables`: `{ DANGEROUSLY_SKIP_PERMISSIONS: '1', CLAUDE_PERMISSION_MODE: 'x', BYPASS_PERMISSIONS: '' }` gives exactly three errors in that order, for example `'DANGEROUSLY_SKIP_PERMISSIONS is not supported: this server has no way to skip permission checks. Remove it.'` (an empty value is refused too);
    - `no config variable suggests a bypass`: no `CONFIG_VARIABLES` entry matches `/bypass|danger|skip|unsafe|yolo|permission/i`;
    - `.env.example lists exactly the config variables`: `readFileSync(new URL('../.env.example', import.meta.url), 'utf8')` lines matching `/^([A-Z0-9_]+)=/` → the name set equals `new Set([...CONFIG_VARIABLES, 'VITE_WORKFORCE_API_URL'])`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/redact.test.ts server/audit.test.ts server/config.test.ts`. Expected: FAIL (modules missing, new config fields missing).
- [ ] **Step 3: Implement** `redact.ts`, `audit.ts`, `recordingLogger`, and the config and `.env.example` changes to the signatures and rules above.
- [ ] **Step 4: Run them and confirm they pass.** Run `npx vitest run server && npx tsc -b`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** with `feat(server): add secret redaction and an append-only audit log`

---

### Task 2: Workspaces, containment and task workspace ids

**Files:**
- Create: `server/workspaces.ts`, `server/test/workspaces.ts`, `server/test/startContext.ts`
- Modify:
  - `server/config.ts`, `.env.example`, `server/http/inputs.ts`, `server/http/routes.ts`, `server/taskManager.ts`, `server/runtime/types.ts`, `server/test/fakeProvider.ts`;
  - `src/workforce/types.ts`, `src/workforce/operations.ts`, `src/workforce/storage.ts`, `src/workforce/api.ts`.
- Test:
  - new `server/workspaces.test.ts`;
  - modify `server/config.test.ts`, `server/taskManager.test.ts`, `server/http/routes.test.ts`, `server/runtime/mockProvider.test.ts`, `server/runtime/claudeAgent.test.ts`, `src/workforce/storage.test.ts`, `src/workforce/operations.test.ts`, `src/workforce/runtime/mockRuntime.test.ts`, `src/workforce/runtime/claudeRuntime.test.ts`.

**Interfaces:**
- **Produces (`server/workspaces.ts`):**
  ```ts
  export const WORKSPACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
  export const MAX_WORKSPACES = 32
  export const MAX_PATH_CHARS = 4096
  export type WorkspaceEntry = { id: string; relativePath: string }
  export type ResolvedWorkspace = { id: string; path: string }   // path: realpath, server-side only
  export type WorkspaceReason = 'not_configured' | 'invalid_id' | 'unknown' | 'missing' | 'escapes_root'
  export type WorkspaceConfig = { workspaceRoot: string | null; workspaces: WorkspaceEntry[] }
  export function parseWorkspaces(rootRaw: string | undefined, listRaw: string | undefined, dataDir: string): { workspaceRoot: string | null; workspaces: WorkspaceEntry[]; errors: string[] }
  export function resolveWorkspace(config: WorkspaceConfig, workspaceId: unknown): { ok: true; workspace: ResolvedWorkspace } | { ok: false; reason: WorkspaceReason }
  export type PathReason = 'invalid_path' | 'outside_workspace' | 'unsafe_symlink'
  export function checkPathInWorkspace(workspacePath: string, candidate: unknown): { ok: true; relative: string } | { ok: false; reason: PathReason }
  export function isInside(parent: string, child: string): boolean   // child === parent || child.startsWith(parent + path.sep)
  ```
- **`parseWorkspaces` rules** (called by `parseConfig`; errors are collected):
  1. Root unset and list unset → `{ null, [], [] }`. List set without root → `WORKSPACES needs WORKSPACE_ROOT.`
  2. **Root:**
     - `path.isAbsolute` → else the absolute-path copy;
     - `realpathSync` and `statSync().isDirectory()` → else `WORKSPACE_ROOT must be an existing directory (got "<v>").`;
     - realpath `'/'` → `WORKSPACE_ROOT must not be the filesystem root.`
  3. **Each entry** (split `,`, trim, skip empty):
     - no `:` → `WORKSPACES entry "<entry>" must look like id:relative/path.` (split on the **first** `:`);
     - bad id → `Workspace id "<id>" must be 1–32 lowercase letters, digits or hyphens, starting with a letter or digit.`;
     - a duplicate → `Workspace id "<id>" is listed twice.`;
     - an empty path, absolute (`/…`, `\…` or `C:…`) → `Workspace "<id>" path must be relative to WORKSPACE_ROOT (got "<p>").`;
     - NUL or `\` → `Workspace "<id>" path contains a forbidden character.`;
     - any `..` segment (split on `/`) → `Workspace "<id>" path must not contain "..".`;
     - `realpathSync(join(rootReal, p))` failing, or not a directory → `Workspace "<id>" must be an existing directory under WORKSPACE_ROOT (got "<p>").`;
     - realpath not `isInside(rootReal, …)` → `Workspace "<id>" resolves outside WORKSPACE_ROOT.`;
     - more than 32 entries → `WORKSPACES lists more than 32 workspaces.`
     - `.` is allowed (the whole root). A symlink that stays inside the root is allowed.
  4. **`DATA_DIR` must not be inside a workspace.**
     - The data dir's real location is the realpath of its deepest existing ancestor, joined with the rest.
     - If it is `isInside` any workspace realpath → `DATA_DIR must not be inside workspace "<id>".`
     - Otherwise an agent could edit `workforce.json` or `audit.log`.
- **`resolveWorkspace` rules** (re-checked on every call, **never cached**):
  1. `workspaceRoot === null` → `not_configured`.
  2. Not a string, or failing `WORKSPACE_ID_RE` → `invalid_id`. This covers `''`, `'../etc'`, `'/etc'`, NUL, backslash, uppercase, over 32 characters, spaces and a leading `-`.
  3. No matching entry → `unknown`.
  4. `rootNow = realpathSync(workspaceRoot)` and `real = realpathSync(join(rootNow, relativePath))`. A throw, or `real` not a directory → `missing`.
  5. `!isInside(rootNow, real)` → `escapes_root`.
  6. Otherwise `{ ok: true, workspace: { id, path: real } }`.
- **`checkPathInWorkspace` rules.** `workspacePath` must be a realpath, which `ResolvedWorkspace.path` is. The rules:
  1. Not a string, empty, over `MAX_PATH_CHARS`, containing `\0` or `\` → `invalid_path`. NUL is checked before any fs call, because Node throws `ERR_INVALID_ARG_VALUE` rather than `ENOENT` for it (checked locally).
  2. `abs = path.resolve(workspacePath, candidate)`, which accepts relative and absolute paths. `!isInside(workspacePath, abs)` → `outside_workspace`.
  3. **Walk up from `abs`:**
     - `realpathSync(cur)` succeeds → `isInside(workspacePath, real)` ? continue to step 4 : `outside_workspace`;
     - it throws `ENOENT`/`ENOTDIR` → if `lstatSync(cur)` succeeds, `cur` is a **dangling symlink** → `unsafe_symlink`; otherwise `cur = dirname(cur)` and repeat;
     - `ELOOP` → `unsafe_symlink`; any other error → `invalid_path`.
  4. `{ ok: true, relative: path.relative(workspacePath, abs) || '.' }`.
- **What is and isn't guaranteed (also written in the module comment):**
  - **Guaranteed:** at the moment of each check, the workspace's real path is inside the root's real path, and the candidate path, with every existing component's symlinks resolved, is inside the workspace. A dangling symlink is never accepted as a target.
  - **Not guaranteed:** time-of-check to time-of-use.
    - A process with write access to the root could swap a component between the check and the runtime's own file operation.
    - The checks are a policy, not a sandbox.
    - The task start and every tool decision re-check.
    - The future Claude provider must also follow the boundary documented in Task 6.
  - A path that names the workspace through an unresolved alias (for example `/var/…` instead of `/private/var/…`) fails the lexical step and is denied. That is deny-by-default, and documented.
- **`ServerConfig` gains** `workspaceRoot: string | null; workspaces: WorkspaceEntry[]`.
  - `CONFIG_VARIABLES` gains `WORKSPACE_ROOT` and `WORKSPACES` (after `DATA_DIR`).
  - `.env.example` gains:
    - `# Absolute folder that holds every workspace. Unset = no workspaces.` / `WORKSPACE_ROOT=`
    - `# Named workspaces under WORKSPACE_ROOT: id:relative/path, comma separated. Example: sandbox:projects/sandbox` / `WORKSPACES=`
- **Shared model (Ruling 6):**
  - `types.ts`: `AgentTask` gains `workspaceId: string | null` (placed after `runtime`).
  - `operations.ts`: `assignTask(…, opts: { runtime?; timeoutMs?; workspaceId?: string | null })` sets `workspaceId: opts.workspaceId ?? null`.
  - `storage.ts`:
    - `parseTask` reads `const workspaceId = v.workspaceId === undefined ? null : v.workspaceId` and rejects the task unless `isTextOrNull(workspaceId)`;
    - `serializeWorkforce` writes `workspaceId` right after `runtime`;
    - `migrateWorkforceV1` is unchanged, because the missing field parses as `null`.
  - `api.ts`:
    - `CreateTaskBody = { title: string; description?: string; workspaceId?: string | null }`;
    - `export type WorkspacesResponse = { workspaces: { id: string }[] }`;
    - `/** Send on every POST, PUT, PATCH and DELETE, even without a body: the server refuses state changes without it (Stage C). */ export const MUTATION_HEADERS = { 'Content-Type': 'application/json' } as const`.
- **`server/http/inputs.ts`:**
  ```ts
  export type CreateTaskRequest = TaskInput & { workspaceId: string | null }
  export function parseCreateTask(b: Record<string, unknown>): CreateTaskRequest   // keys title, description, workspaceId; workspaceId absent → null; not string/null → 400 '"workspaceId" must be a string or null.'
  ```
  - The `"workspaceId" is not supported yet.` copy is deleted.
- **`server/runtime/types.ts`:**
  - `StartContext = { agent: Agent; signal: AbortSignal; workspace: ResolvedWorkspace | null }`. Task 3 adds the rest.
- **`server/taskManager.ts` (only the shapes this task needs; Task 3 adds the tool actions):**
  ```ts
  export type ManagerError = { ok: false; code: 'not_found' | 'invalid' | 'conflict' | 'unavailable' | 'bad_request'; error: string }
  export type CallOptions = { requestId?: string }
  export type LifecycleAction = 'task.start' | 'task.cancel' | 'task.force_cancelled' | 'task.timeout' | 'approval.requested' | 'approval.decided' | 'approval.timeout' | 'tool.allowed' | 'tool.denied' | 'tool.asked' | 'workspace.rejected' | 'runtime.note'
  export type LifecycleEvent = { action: LifecycleAction; actor: 'api' | 'system' | 'runtime'; taskId: string | null; agentId: string; requestId?: string; workspaceId?: string; tool?: string; decision?: string; reason?: string; detail?: string }
  // TaskManagerOptions.onLifecycle?: (e: LifecycleEvent) => void
  // TaskManagerOptions.config gains Pick<ServerConfig, 'workspaceRoot' | 'workspaces'>
  startTask(agentId: string, input: TaskInput, opts?: CallOptions & { workspaceId?: string | null }): ManagerResult<{ task: AgentTask }>
  cancelTask(taskId: string, opts?: CallOptions): ManagerResult<{ task: AgentTask }>
  decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision, opts?: CallOptions): ManagerResult<{ task: AgentTask }>
  removeAgent(agentId: string, opts?: CallOptions): ManagerResult<{ cancelledTaskId: string | null }>
  ```
  - **`actor`:**
    - `task.start`, `task.cancel`, `approval.decided` and `workspace.rejected` use `opts.requestId ? 'api' : 'system'`;
    - the timer-driven actions use `'system'`;
    - `tool.*`, `approval.requested` and `runtime.note` use `'runtime'`.
  - `removeAgent`, when it cancels a task, now reports `task.cancel` with `detail: 'agent removed'`.
  - **`startTask` order:**
    1. unavailable;
    2. not found;
    3. invalid input;
    4. **workspace**, only when `workspaceId` is not null/undefined:
       - `resolveWorkspace(config, workspaceId)`;
       - on failure, report `workspace.rejected` (`taskId: null`, `reason`, and `workspaceId` only if it matches `WORKSPACE_ID_RE`);
       - return `bad_request` for `invalid_id`, otherwise `invalid`, with the copy from the Global Constraints table;
    5. `provider.kind === 'claude' && workspace === null` → `invalid` `The claude runtime needs a workspace.`;
    6. conflict.
  - Then `assignTask(…, { workspaceId: workspace?.id ?? null })`. The `Run` record gains `workspace: ResolvedWorkspace | null`. `task.start` reports `workspaceId`.
  - `launch` passes `{ agent, signal, workspace: run.workspace }`.
- **`server/http/routes.ts`:**
  - `STATUS` gains `bad_request: 400`;
  - `POST /api/agents/:id/tasks` passes `{ workspaceId }`;
  - new route `GET /api/workspaces` → 200 `{ workspaces: config.workspaces.map(({ id }) => ({ id })) }`.
  - **Justification:** Stage D's task form must offer a choice without hard-coding ids, and ids are all it needs. It is read-only and never returns paths.
- **Test fixtures:**
  ```ts
  // server/test/workspaces.ts
  export function makeWorkspaceRoot(ids?: string[]): { root: string; env: { WORKSPACE_ROOT: string; WORKSPACES: string }; path(id: string): string; cleanup(): void }
  // root = realpathSync(mkdtempSync(join(tmpdir(), 'vo-ws-'))); mkdir root/<id> for each id (default ['sandbox']); WORKSPACES = ids.map((id) => `${id}:${id}`).join(',')
  // server/test/startContext.ts
  export function testStartContext(agent: Agent, overrides?: Partial<StartContext>): StartContext   // { agent, signal: new AbortController().signal, workspace: null, ...overrides }; Task 3 adds defaults for the new fields
  // server/test/fakeProvider.ts
  constructor(opts: { kind?: TaskRuntime } = {})   // readonly kind: TaskRuntime (default 'mock')
  ```

- [ ] **Step 1: Write the failing tests.**
  - `server/workspaces.test.ts`, `resolveWorkspace` (fixture `makeWorkspaceRoot(['sandbox'])`, with the config built by `parseConfig({ DATA_DIR: tempDataDir(), ...ws.env })`):
    - `resolves a listed workspace to its real path`: `'sandbox'` → `{ ok: true, workspace: { id: 'sandbox', path: ws.path('sandbox') } }`;
    - `is not configured without a root`: `{ workspaceRoot: null, workspaces: [] }` → `not_configured`;
    - `rejects malformed ids`: each of `''`, `'../etc'`, `'/etc'`, `'a\0b'`, `'a\\b'`, `'Sandbox'`, `'a'.repeat(33)`, `'sand box'`, `'-a'`, `'.'`, `5` and `undefined` → `invalid_id`;
    - `rejects an unlisted id`: `'docs'` → `unknown`;
    - `rejects a workspace deleted after startup`: `rmSync(ws.path('sandbox'))` → `missing`;
    - `rejects a workspace swapped for an outside symlink after startup` (Review Focus 2): remove the dir, then `symlinkSync(outsideDir, join(root, 'sandbox'))` → `escapes_root`;
    - `follows a symlink that stays inside the root`: `alias:alias`, where `root/alias` links to `root/real` → `path === realpathSync(join(root, 'real'))`.
  - `server/workspaces.test.ts`, `checkPathInWorkspace` (workspace `W = ws.path('sandbox')` with `notes.md`, `sub/`, `link → <outside dir>`, `filelink → <outside>/secret.txt` and `dangling → <root>/nope`):
    - `accepts paths inside`:
      - `'notes.md'` → `{ ok: true, relative: 'notes.md' }`;
      - `join(W, 'notes.md')` → the same;
      - `'.'` → `relative: '.'`;
      - `'sub/new/deep.txt'` (missing) → `relative: 'sub/new/deep.txt'`;
    - `rejects paths outside`: `'../x'`, `'/etc/passwd'`, `'link'`, `'link/secret.txt'`, `'link/new.txt'` and `'filelink'` → `outside_workspace`;
    - `refuses a write through a dangling symlink` (Review Focus 2): `'dangling'` → `unsafe_symlink`;
    - `rejects invalid paths`: `''`, `'a\0b'`, `'a\\b'`, `'x'.repeat(4097)`, `5` and `null` → `invalid_path`.
  - `server/config.test.ts`. Modified: `DEFAULTS` gains `workspaceRoot: null, workspaces: []`. New:
    - `reads WORKSPACE_ROOT and WORKSPACES`: root realpath; `WORKSPACES: ' sandbox:sandbox , docs:team/docs '` (with `team/docs` created) → `[{ id: 'sandbox', relativePath: 'sandbox' }, { id: 'docs', relativePath: 'team/docs' }]`;
    - `refuses a bad WORKSPACE_ROOT`: `'rel/dir'`, a missing absolute dir, a file, and `'/'` each give their exact copy;
    - `refuses WORKSPACES without WORKSPACE_ROOT`;
    - `refuses bad workspace entries`, as a table with one exact message each: `'sandbox'`, `'Sandbox:sandbox'`, `'a:/etc'`, `'a:../x'`, `'a:sandbox/../../x'`, `'a:sand\\box'`, `'a:missing'`, `'a:notes.md'` (a file), `'a:link'` (outside symlink), `'sandbox:sandbox,sandbox:sandbox'`, and 33 valid entries;
    - `refuses DATA_DIR inside a workspace`: `DATA_DIR: join(ws.path('sandbox'), 'data')` → `DATA_DIR must not be inside workspace "sandbox".`
  - `server/taskManager.test.ts`. Modified: `BASE_CONFIG` gains `workspaceRoot: null, workspaces: []`; `make()` is unchanged otherwise. New:
    - `passes the resolved workspace to the provider`: with a workspace config, `startTask(FORGE, INPUT, { workspaceId: 'sandbox' })` → `fake.starts[0].ctx.workspace` equals `{ id: 'sandbox', path: ws.path('sandbox') }`, and the task has `workspaceId: 'sandbox'`;
    - `refuses an unknown workspace without creating a task`: `{ ok: false, code: 'invalid', error: 'Unknown workspace "nope".' }`; `store.state.tasks` is the same reference; the lifecycle events equal `[{ action: 'workspace.rejected', actor: 'system', taskId: null, agentId: FORGE, workspaceId: 'nope', reason: 'unknown' }]`;
    - `maps a malformed id to bad_request`: `'../x'` → `code: 'bad_request'` with the id copy, and the event has no `workspaceId` key;
    - `the claude runtime needs a workspace`: `new FakeProvider({ kind: 'claude' })` → `{ ok: false, code: 'invalid', error: 'The claude runtime needs a workspace.' }`;
    - `reports the actor from the request id`: `startTask(FORGE, INPUT, { requestId: 'r1' })` → `task.start` has `actor: 'api'` and `requestId: 'r1'`.
  - `server/http/routes.test.ts`. Modified Stage B test `rejects bad task requests`: the `workspaceId: 'sandbox'` line becomes 422 `Workspaces are not configured on this server.` New `describe('workspaces')` on a server with `makeWorkspaceRoot(['sandbox']).env`:
    - `lists workspace ids only`: `GET /api/workspaces` → `{ workspaces: [{ id: 'sandbox' }] }`, and the text doesn't contain `ws.root`;
    - `starts a task in a workspace`: 202 with `task.workspaceId: 'sandbox'`; `{ workspaceId: null }` → 202 with `workspaceId: null`;
    - `rejects bad workspaces with exact copy`: `'nope'` → 422 `Unknown workspace "nope".`; `'../etc'` → 400 (id copy); `5` → 400 `"workspaceId" must be a string or null.`; no task was created (the task count is unchanged);
    - `never exposes the workspace path`: after a run, `JSON.stringify` of `GET /api/state`, `GET /api/health` and `GET /api/workspaces` does not contain `ws.root`.
  - **src:**
    - `storage.test.ts`: `loads a v2 task without workspaceId as null`; `round-trips workspaceId` (`'sandbox'`); `rejects a non-string workspaceId` (`5` → `parseWorkforce` returns `null`);
    - `operations.test.ts`: `assignTask records a workspace id` (`'sandbox'`, and `null` by default).
  - **Type-only fixture updates** (add `workspaceId: null` to the `AgentTask` literals): `src/workforce/operations.test.ts` (the `task()` helper), `src/workforce/runtime/mockRuntime.test.ts`, `src/workforce/runtime/claudeRuntime.test.ts`. `server/runtime/mockProvider.test.ts` and `server/runtime/claudeAgent.test.ts` switch to `testStartContext(agent)`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/workspaces.test.ts server/config.test.ts server/taskManager.test.ts server/http/routes.test.ts src/workforce`. Expected: FAIL.
- [ ] **Step 3: Implement** to the rules above. `.env.example` gets the two names.
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test && npx tsc -b`. Expected: PASS, no type errors (the `AgentTask` literal errors are gone).
- [ ] **Step 5: Commit** with `feat(server): add workspace allowlist and task workspace ids`

---

### Task 3: Tool catalogue, policy and approvals through the task manager

**Files:**
- Create: `server/toolPolicy.ts`
- Modify: `server/config.ts`, `.env.example`, `server/runtime/types.ts`, `server/taskManager.ts`, `server/runtime/mockProvider.ts`, `server/app.ts` (pass the policy), `server/test/startContext.ts`
- Test: new `server/toolPolicy.test.ts`; modify `server/taskManager.test.ts`, `server/runtime/mockProvider.test.ts`, `server/http/routes.test.ts`, `server/config.test.ts`

**Interfaces:**
- **Produces (`server/toolPolicy.ts`):**
  ```ts
  export type ToolCategory = 'read' | 'write' | 'execute' | 'network'
  export type ToolSpec = { name: string; category: ToolCategory; description: string; pathArgs: readonly string[]; pathRequired: boolean; needsWorkspace: boolean }
  export const TOOL_CATALOGUE: readonly ToolSpec[]
  export const DEFAULT_ALLOWED_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Write', 'Edit']
  export const SUMMARY_MAX_CHARS = 200
  export type ToolPolicy = { readonly allowedTools: ReadonlySet<string> }
  export type DenyReason = 'unknown_tool' | 'not_allowed' | 'invalid_input' | 'invalid_path' | 'missing_path' | 'outside_workspace' | 'unsafe_symlink' | 'no_workspace' | 'approval_pending'
  export type ToolDecision = { decision: 'allow'; reason: 'read_only'; summary: string } | { decision: 'ask'; reason: 'needs_approval'; summary: string } | { decision: 'deny'; reason: DenyReason; summary: string }
  export function toolPolicyFrom(config: Pick<ServerConfig, 'allowedTools'>): ToolPolicy
  export function decideToolUse(policy: ToolPolicy, toolName: string, input: unknown, workspace: ResolvedWorkspace | null): ToolDecision
  export function sanitizeSummary(text: string): string   // redactSecrets → control chars to ' ' → collapse spaces → trim → max 200 (199 + '…')
  export function toolDeniedMessage(tool: string, reason: DenyReason): string   // `Tool "${scrub(tool, 64)}" denied by policy: ${DENY_TEXT[reason]}.`
  ```
- **The catalogue** (names match Claude Code's tool names so the future provider maps them one to one; any other name is unknown):

  | Name | Category | Description | Path args (required) | Needs workspace |
  |---|---|---|---|---|
  | `Read` | read | `Read a file inside the workspace` | `file_path` (yes) | yes |
  | `Glob` | read | `Find files by name pattern inside the workspace` | `path` (no) | yes |
  | `Grep` | read | `Search file contents inside the workspace` | `path` (no) | yes |
  | `Write` | write | `Create or overwrite a file inside the workspace` | `file_path` (yes) | no (Ruling 2) |
  | `Edit` | write | `Change part of a file inside the workspace` | `file_path` (yes) | no (Ruling 2) |
  | `Bash` | execute | `Run a shell command in the workspace` | none | yes |
  | `WebFetch` | network | `Fetch a web page` | none | no |
  | `WebSearch` | network | `Search the web` | none | no |

- **`DENY_TEXT`:**
  - `unknown_tool`: `unknown tool`
  - `not_allowed`: `not in ALLOWED_TOOLS`
  - `invalid_input`: `invalid input`
  - `invalid_path`: `invalid path`
  - `missing_path`: `a path is required`
  - `outside_workspace`: `path is outside the task workspace`
  - `unsafe_symlink`: `path goes through a broken symlink`
  - `no_workspace`: `the task has no workspace`
  - `approval_pending`: `another tool approval is already pending for this task`
- **`decideToolUse` order** (the first match wins; it has no side effects, only synchronous fs reads through `checkPathInWorkspace`):
  1. Not in the catalogue → `deny unknown_tool`.
  2. Not in `policy.allowedTools` → `deny not_allowed`.
  3. `input` not a plain object → `deny invalid_input`.
  4. **Required fields:**
     - `Glob`/`Grep` need `pattern` (a non-empty string);
     - `Write` needs `content` (a string);
     - `Edit` needs `old_string`/`new_string` (strings);
     - `Bash` needs `command` (a non-empty string, ≤ 10000 chars);
     - `WebFetch` needs `url`, parsed by `new URL` with an `http:`/`https:` protocol;
     - `WebSearch` needs `query` (a non-empty string).
     - A failure → `invalid_input`. A required path arg that is absent → `missing_path`.
  5. `needsWorkspace && workspace === null` → `deny no_workspace`.
  6. **For each path arg present:**
     - with a workspace → `checkPathInWorkspace(workspace.path, value)`, whose failure reason becomes the deny reason;
     - without a workspace (write tools only) → the value must be a string without NUL or `\`, not absolute, and with no `..` segment after `path.posix.normalize`, else `invalid_path`/`outside_workspace`; the displayed path is the normalized relative path.
  7. `category === 'read'` → `allow read_only`; otherwise → `ask needs_approval`. **Write, execute and network always ask**, even when allowlisted. Nothing in this module can return `allow` for them.
- **Summaries** (always through `sanitizeSummary`; `<rel>` is the relative path from `checkPathInWorkspace`, never absolute):
  - `Read <rel>`
  - `Find files matching <pattern> in <rel or .>`
  - `Search for <pattern> in <rel or .>`
  - `Write <rel> (<formatBytes(Buffer.byteLength(content))>)`
  - `Edit <rel>`
  - `Run command: <command>`
  - `Fetch <url.origin + url.pathname>` (drops credentials, query and hash)
  - `Search the web for <query>`
  - deny → `Tool "<scrub(toolName, 64)>"`, which never echoes the input.
- **`ServerConfig` gains** `allowedTools: string[]`. `CONFIG_VARIABLES` gains `ALLOWED_TOOLS` after `APPROVAL_TIMEOUT_MS`. `.env.example` gets:
  - `# Tools an agent may use, comma separated, from: Read, Glob, Grep, Write, Edit, Bash, WebFetch, WebSearch. Default Read,Glob,Grep,Write,Edit. Write, Edit, Bash, WebFetch and WebSearch always need a human approval. "none" allows no tools.`
  - `ALLOWED_TOOLS=`
- **`server/runtime/types.ts` (final `StartContext`):**
  ```ts
  export type ToolRequest = { tool: string; input: unknown }
  export type ToolGateResult =
    | { behavior: 'allow'; outcome: 'allowed' | 'approved' }
    | { behavior: 'deny'; outcome: 'denied_by_policy' | 'denied' | 'expired' | 'cancelled'; message: string }
  export type StartContext = {
    agent: Agent
    signal: AbortSignal
    /** The resolved workspace; path is a realpath and stays server-side. null when the task has none. */
    workspace: ResolvedWorkspace | null
    /** The policy in force. A provider may narrow it, never widen it. */
    tools: ToolPolicy
    /** The only way to get permission to use a tool. Bound to this task. Settles exactly once. */
    requestToolApproval: (request: ToolRequest) => Promise<ToolGateResult>
    /** Writes a runtime.note audit record for this task (scrubbed and truncated). */
    audit: (note: string) => void
  }
  ```
- **`server/taskManager.ts`:**
  ```ts
  // TaskManagerOptions gains: policy: ToolPolicy
  requestToolApproval(taskId: string, request: ToolRequest): Promise<ToolGateResult>   // not async: every state change happens before it returns
  // Run gains: toolWaiter: { approvalId: string; tool: string; resolve: (r: ToolGateResult) => void } | null
  ```
- **`requestToolApproval` steps:**
  1. No run, no task, or the task is not `running`/`waiting_for_approval` → resolve `{ behavior: 'deny', outcome: 'cancelled', message: 'The task is no longer running.' }`. No audit record.
  2. `d = decideToolUse(policy, request.tool, request.input, run.workspace)`.
  3. `allow` → report `tool.allowed` (`tool`, `decision: 'allow'`, `reason`, `detail: summary`) → resolve `{ behavior: 'allow', outcome: 'allowed' }`.
  4. `deny` → report `tool.denied` (`tool`, `decision: 'deny'`, `reason`; **no detail**) → resolve `{ behavior: 'deny', outcome: 'denied_by_policy', message: toolDeniedMessage(tool, reason) }`.
  5. `ask`, when the task is already `waiting_for_approval` or `run.toolWaiter` is set → treated as `deny approval_pending` (same report and resolve shape).
  6. **`ask`:**
     - report `tool.asked` (`decision: 'ask'`, `reason: 'needs_approval'`, `detail: summary`);
     - `approvalId = createId('approval')`;
     - create the promise, store `run.toolWaiter`;
     - `this.onEvent({ type: 'approval_requested', taskId, approvalId, tool: <catalogue name>, summary })`, so the existing path commits `waiting_for_approval` and arms the approval timer;
     - report `approval.requested` (`tool`, `detail: 'approvalId=<id>'`);
     - return the promise.
- **Settling a waiter** (a private `settleTool(run, result)` that nulls the waiter, then resolves; idempotent):
  - **`decideApproval`:**
    - after the commit and `clearApproval`, if `run.toolWaiter?.approvalId === approvalId` → settle `{ allow, approved }` on approve, or `{ deny, denied, 'Denied by a human reviewer.' }` on deny, and **don't** call `provider.respondToApproval`;
    - otherwise call it as in Stage B, for a provider that emitted `approval_requested` itself.
  - **`cancelTask`**, right after the `requestCancel` commit → `cancelled`.
  - **`onApprovalTimeout`** → `{ deny, expired, APPROVAL_TIMEOUT_MESSAGE(ms) }` **before** `finalize`.
  - **`finalize`**, which runs for task timeout, forced cancel, `removeAgent` and the provider ending the task → `cancelled`.
  - **`dispose`** → `cancelled` for every run.
  - After a deny, the task is back in `running`: Stage A's `decideApproval` operation sets `running`/`working`. That is the SDK's semantics (Ruling 1).
- **`cap()`:**
  - applies `redactSecrets` before truncating to `message.text`, `progress.message`, `failed.error` and `completed.summary`;
  - adds a case `approval_requested`, which runs `summary` through `sanitizeSummary`.
- **`launch` builds the full context:**
  ```ts
  { agent, signal, workspace: run.workspace, tools: policy,
    requestToolApproval: (r) => this.requestToolApproval(taskId, r),
    audit: (note) => this.report({ action: 'runtime.note', actor: 'runtime', taskId, agentId, detail: note }) }
  ```
- **`ServerMockProvider` demo path** (decision: the demo goes through the policy; the provider never sees the human decision directly):
  - The record keeps `ctx: StartContext` and `innerApprovalId: string | null`.
  - `onInner` **swallows** the inner `approval_requested` event (it only stores `innerApprovalId` and `pendingApprovalId`), because only this path triggers it.
  - **`requestApproval(taskId)`:**
    - if there is no record, the run isn't started, or `innerApprovalId` is set → no-op;
    - `this.inner.requestApproval(taskId)`, which pauses the simulated timers;
    - then `record.ctx.requestToolApproval({ tool: 'Write', input: MOCK_DEMO_WRITE }).then(onResult)`.
  - **`onResult`** clears both ids, then:
    - `allow` → `inner.respondToApproval(taskId, innerId, 'approve')`;
    - `denied` → `inner.respondToApproval(taskId, innerId, 'deny')`, which fails with `Approval denied (simulated)`;
    - `denied_by_policy` → `inner.forceError(taskId, result.message)`;
    - `expired`/`cancelled` → nothing (the manager has already ended the task and called `cancel`).
  - `export const MOCK_DEMO_WRITE = { file_path: 'simulated.txt', content: 'Simulated content (nothing is written).' }`. It is never written anywhere.
- **`testStartContext` defaults:**
  - `tools: { allowedTools: new Set(DEFAULT_ALLOWED_TOOLS) }`;
  - `requestToolApproval: () => Promise.resolve({ behavior: 'deny', outcome: 'cancelled', message: 'The task is no longer running.' })`;
  - `audit: () => {}`.
- **`app.ts`:** `new TaskManager({ …, policy: toolPolicyFrom(config) })`.

- [ ] **Step 1: Write the failing tests.**
  - `server/toolPolicy.test.ts`:
    - **Fixtures:** `makeWorkspaceRoot(['sandbox'])`, `W = { id: 'sandbox', path: ws.path('sandbox') }`, `notes.md` = `'hello'`, `link → <outside dir>`, `dangling → <root>/nope`, `ALL = { allowedTools: new Set(TOOL_CATALOGUE.map((t) => t.name)) }`.
    - `the catalogue is exactly the eight tools`: the names equal `['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch']` and every category is one of the four;
    - `denies an unknown tool`: `decideToolUse(ALL, 'Rm', {}, W)` equals `{ decision: 'deny', reason: 'unknown_tool', summary: 'Tool "Rm"' }`;
    - `denies a known tool that is not allowlisted`: `{ allowedTools: new Set(['Read']) }` with `Bash` → `not_allowed`;
    - `allows read-only tools inside the workspace`:
      - `Read { file_path: join(W.path, 'notes.md') }` → `{ decision: 'allow', reason: 'read_only', summary: 'Read notes.md' }`;
      - `Glob { pattern: '**/*.md' }` → `'Find files matching **/*.md in .'`;
      - `Grep { pattern: 'TODO', path: '.' }` → `'Search for TODO in .'`;
    - `always asks for write, execute and network tools even when allowlisted` (Review Focus 4):
      - `Write { file_path: 'notes.md', content: 'hello' }` → `{ decision: 'ask', reason: 'needs_approval', summary: 'Write notes.md (5 B)' }`;
      - `Edit { file_path: 'notes.md', old_string: 'h', new_string: 'H' }` → `'Edit notes.md'`;
      - `Bash { command: 'npm test' }` → `'Run command: npm test'`;
      - `WebFetch { url: 'https://user:pw@example.com/a?token=x#h', prompt: 'p' }` → `'Fetch https://example.com/a'`;
      - `WebSearch { query: 'vite ssr' }` → `'Search the web for vite ssr'`;
    - `denies paths outside the workspace`:
      - `Read '/etc/passwd'`, `Read '../x'` and `Read 'link/secret.txt'` → `outside_workspace`;
      - `Write { file_path: 'dangling', content: 'x' }` → `unsafe_symlink`;
      - `Read 'a\0b'`, `Read 'a\\b'` and `Read { file_path: 5 }` → `invalid_path`;
      - `Write { content: 'x' }` → `missing_path`;
    - `rejects malformed input`:
      - `Read` with `null`, `[]` or `'x'` → `invalid_input`;
      - `Bash { command: '' }` → `invalid_input`;
      - `WebFetch { url: 'file:///etc/passwd' }` and `{ url: 'javascript:1' }` → `invalid_input`;
    - `without a workspace`:
      - `Read`, `Glob { pattern: '*' }` and `Bash` → `no_workspace`;
      - `Write MOCK_DEMO_WRITE` → `{ decision: 'ask', summary: 'Write simulated.txt (39 B)' }`;
      - `Write { file_path: '/tmp/x', content: '' }` and `Write { file_path: 'a/../../x', content: '' }` → `outside_workspace`;
      - `WebSearch` → `ask`;
    - `summaries are scrubbed, single-line and capped`:
      - `Bash { command: 'echo 1\nexport API_KEY=abc123 && curl -H "Authorization: Bearer abcdefgh1234" x' }` → the summary has no `\n` and contains `API_KEY=[REDACTED]` and `Bearer [REDACTED]`;
      - `Bash { command: 'x'.repeat(500) }` → length 200, ending `'…'`;
    - `summaries never contain the workspace path`: no summary from the cases above contains `W.path` or `ws.root`;
    - `toolDeniedMessage`: `('Write', 'not_allowed')` → `'Tool "Write" denied by policy: not in ALLOWED_TOOLS.'`
  - `server/config.test.ts`: `DEFAULTS` gains `allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit']`. New:
    - `reads ALLOWED_TOOLS`: `' Bash, Read ,Bash'` → `['Bash', 'Read']`; `'none'` → `[]`;
    - `refuses wildcard and unknown tools`: `'*'`, `'all'` and `'Read,Foo'` each give their exact copy.
  - **`server/taskManager.test.ts`.**
    - **Modified Stage B tests:**
      - `make()` passes `policy: { allowedTools: new Set(DEFAULT_ALLOWED_TOOLS) }`;
      - `deny fails with the simulated message`: assert `r.ok && r.task.status === 'running'`, then `await tick()`, then the task is `failed` with `'Approval denied (simulated)'` and the timer count is 0;
      - `reports timeout, approval decisions and approval timeout`: the first expectation becomes `['task.start', 'tool.asked', 'approval.requested', 'approval.timeout']`;
      - `approval round trip`, `approval conflicts`, `a second decision for the same approval conflicts`, `approval timeout fails the task` and `deciding clears the approval timer` keep their assertions. Add `await tick()` after `decideApproval` where a later state is asserted.
    - **New `describe('tool approvals')`** with a `FakeProvider`, workspace `sandbox` containing `notes.md`, and `const ctx = () => fake.starts[0].ctx` after `startTask(FORGE, INPUT, { workspaceId: 'sandbox' })`, `tick()` and `fake.emit({ type: 'started', … })`:
      - `allows a read inside the workspace without asking`: resolves `{ behavior: 'allow', outcome: 'allowed' }`; the task stays `running`; the lifecycle includes `tool.allowed` with `actor: 'runtime'`;
      - `denies unknown, unlisted and outside tools without changing state`: `Rm` → `{ behavior: 'deny', outcome: 'denied_by_policy', message: 'Tool "Rm" denied by policy: unknown tool.' }`; `Bash` → `'… not in ALLOWED_TOOLS.'`; `Read '/etc/passwd'` → `'… path is outside the task workspace.'`; `store.state` is the same reference after each;
      - `asks for a write and waits for approval`: `Write { file_path: 'notes.md', content: 'hello' }` → the task is `waiting_for_approval`, with `pendingApproval` matching `{ tool: 'Write', summary: 'Write notes.md (5 B)' }` and the agent `waiting`; the promise is still pending after `tick()`; `decideApproval(…, 'approve')` → resolves `{ behavior: 'allow', outcome: 'approved' }`; `fake.responses` equals `[]`; the task is `running`;
      - `a human deny resolves denied and the task keeps running`: `{ behavior: 'deny', outcome: 'denied', message: 'Denied by a human reviewer.' }`; the task is `running`;
      - `approval timeout resolves expired and fails the task` (Review Focus 3): with `approvalTimeoutMs: 2000`, after 2000 ms → `{ behavior: 'deny', outcome: 'expired', message: 'No approval decision within 2 s' }`; the task is `failed`; the timer count is 0; a later `decideApproval` gives 409 `Task is not waiting for approval.`;
      - `cancel, timeout, removal and dispose release a waiting request as cancelled` (Review Focus 3): four cases, each starting from a pending `Write` request. `cancelTask`, the task timeout (`taskTimeoutMs: 1000`), `removeAgent(FORGE)` and `dispose()` each resolve `{ behavior: 'deny', outcome: 'cancelled', message: 'The task is no longer running.' }` exactly once (a `then` spy is called once after `tick()`), and the timer count is 0;
      - `a second request while one is pending is denied`: a second `Write` → `denied_by_policy` with `'… another tool approval is already pending for this task.'`; the first stays pending;
      - `a request for a task that is not running resolves cancelled`: an unknown task id, and a completed task;
      - `scrubs secrets from runtime output`: `fake.emit({ type: 'message', taskId, text: 'key sk-ant-api03-abcdefghijklmnop' })` → the activity message is `'key [REDACTED]'`;
      - `state never contains the workspace path`: after an ask with an absolute in-workspace path, `JSON.stringify(store.state)` doesn't contain `ws.root`.
  - **`server/runtime/mockProvider.test.ts`.** The modified Stage B test `requestApproval sets pendingApprovalId and deny ends failed` becomes:
    - `requestApproval asks through the context and deny ends failed`: `start` with `testStartContext(forge, { requestToolApproval })`, where the spy returns a promise the test resolves;
    - after `requestApproval`, the spy was called with `{ tool: 'Write', input: MOCK_DEMO_WRITE }`; `status.pendingApprovalId` matches `/^approval-/`; **no** `approval_requested` event was emitted;
    - resolve `{ behavior: 'deny', outcome: 'denied', message: 'x' }`, then `await vi.advanceTimersByTimeAsync(0)` → the result is `{ outcome: 'failed', error: 'Approval denied (simulated)' }`.
    - New:
      - `approve continues to completion`;
      - `a policy denial fails with its message`: `denied_by_policy` with message `M` → result `{ outcome: 'failed', error: M }`;
      - `expired or cancelled leave the run to the manager`: no event is emitted.
  - **`server/http/routes.test.ts`.** The modified Stage B test `approval via demo controls`:
    - the deny response is `200` with `task.status: 'running'`;
    - then `until(async () => (await task(id)).status === 'failed')` with `errorMessage: 'Approval denied (simulated)'`;
    - `pending.tool` stays `'Write'`; add `expect(pending.summary).toBe('Write simulated.txt (39 B)')`.
    - New:
      - `the demo tool request follows ALLOWED_TOOLS`: on a server with `ALLOWED_TOOLS: 'Read'`, the request is 202, then the task is `failed` with `errorMessage: 'Tool "Write" denied by policy: not in ALLOWED_TOOLS.'`;
      - `approving the demo write changes nothing on disk`: with a workspace, a task in `sandbox`, request, approve, wait for `completed` → `readdirSync(ws.path('sandbox'))` equals `[]`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/toolPolicy.test.ts server/taskManager.test.ts server/runtime server/http/routes.test.ts server/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `toolPolicy.ts`, the config variable, the `StartContext` types, the manager changes, the mock demo path and the `app.ts` policy wiring.
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test && npx tsc -b`. The SSE lifecycle tests (`server/lifecycle.test.ts` `approval → approve → completed` and `approval → deny → failed`) must still pass unchanged, because they wait on events.
- [ ] **Step 5: Commit** with `feat(server): add tool policy and route tool approvals through the task manager`

---

### Task 4: HTTP guards, CORS, request ids and stream limits

**Files:**
- Create: `server/http/guards.ts`
- Modify: `server/http/router.ts`, `server/http/body.ts`, `server/http/inputs.ts`, `server/http/routes.ts`, `server/http/sse.ts`, `server/config.ts`, `.env.example`, `server/app.ts`, `server/test/helpers.ts`, `server/test/sseClient.ts`
- Test: new `server/http/guards.test.ts`; modify `server/http/router.test.ts`, `server/http/sse.test.ts`, `server/app.test.ts`, `server/config.test.ts`

**Interfaces:**
- **`server/http/router.ts` changes:**
  ```ts
  export type RejectCode = 'host' | 'origin' | 'content_type' | 'body_too_large' | 'unknown_field' | 'stream_limit'
  export class HttpError extends Error { constructor(readonly status: number, message: string, readonly code?: RejectCode) }
  export type RequestContext = { req; res; url; params; body; requestId: string }
  export type Guard = (req: IncomingMessage, url: URL, info: { requestId: string }) => Reply | null
  export type RejectInfo = { status: number; code: RejectCode; method: string; path: string; requestId: string }   // path: url.pathname cut to 128 chars, no query
  export type RouterOptions = { routes; guards?; responseHeaders?; log; onRejected?: (r: RejectInfo) => void; newRequestId?: () => string }
  export const newRequestId = (): string => randomBytes(6).toString('hex')   // 12 lowercase hex chars; never taken from the client
  ```
  - The request id is created first. Every reply carries `x-request-id`: JSON replies, guard replies, 400 `Invalid URL.`, 404/405, 500, and the SSE response (added to the `setHeader` loop before handled replies).
  - `sendJson` with status `204` writes `writeHead(204, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })` and `end()`, with no body and no content type.
  - The catch path: an `HttpError` with a `code` → `onRejected?.({ … })`, then the reply as before. `path` is `'(invalid url)'` when the URL didn't parse.
- **Reject codes elsewhere:**
  - `body.ts`: 415 → `'content_type'`, 413 → `'body_too_large'`;
  - `inputs.ts`: `Unknown field` → `'unknown_field'`;
  - `sse.ts`: the stream cap → `'stream_limit'`.
- **Produces (`server/http/guards.ts`):**
  ```ts
  export const ALLOWED_HOST_NAMES = ['127.0.0.1', 'localhost', '[::1]'] as const
  export const PREFLIGHT_MAX_AGE_S = 600
  export const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE'
  export const CORS_HEADERS = 'Content-Type, Last-Event-ID'
  export type GuardOptions = { allowedOrigins: readonly string[]; onReject?: (r: RejectInfo) => void }
  export function createSecurityGuards(opts: GuardOptions): Guard[]       // [host, origin, preflight, jsonOnly], in this order
  export function securityHeaders(req: IncomingMessage, allowedOrigins: readonly string[]): Record<string, string>
  ```
  1. **Host:**
     - allowed iff `(req.headers.host ?? '').toLowerCase()` equals `${name}:${req.socket.localPort}` for one of `ALLOWED_HOST_NAMES`;
     - `localPort` is the port the connection actually arrived on, so it is correct with `PORT=0` (checked locally: `req.socket.localPort` equals the bound port; IPv6 clients send `[::1]:<port>`);
     - a missing Host, a Host without a port, or any other name → 421 `Host not allowed.` with `onReject({ code: 'host' })`.
     - This is what stops DNS rebinding: a rebinding page's same-origin GETs carry no `Origin` but always carry its own `Host`.
  2. **Origin:** if an `origin` header is present and not exactly (case-sensitively) in `allowedOrigins` → 403 `Origin not allowed.`, `code: 'origin'`. This applies to **every** method, including GET and SSE. `Origin: null` is rejected. A request with no `Origin` passes this guard.
  3. **Preflight:** `req.method === 'OPTIONS'`:
     - with an (allowed) Origin → `{ status: 204, body: null, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': CORS_METHODS, 'access-control-allow-headers': CORS_HEADERS, 'access-control-max-age': '600' } }`;
     - with no Origin → 204 with `allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS'`.
  4. **JSON-only:** a method in `POST`/`PUT`/`PATCH`/`DELETE` whose `content-type` (before `;`, trimmed, lowercased) isn't `application/json` → 415 `Content-Type must be application/json.`, `code: 'content_type'`.
     - This covers **body-less routes**: cancel, the three demo POSTs and `DELETE /api/agents/:id`. Their bodies are still never read.
     - A cross-origin "simple request" (`text/plain`, form types) is therefore refused, and a JSON one needs a preflight that the Origin guard denies.
- **`securityHeaders(req, origins)`** (applied to every reply through `responseHeaders`):
  - `referrer-policy: no-referrer`;
  - `cross-origin-resource-policy: same-origin` (CORP only affects no-cors loads such as `<script src>`; the UI's `fetch`/`EventSource` are CORS-mode and governed by CORS);
  - `content-security-policy: default-src 'none'; frame-ancestors 'none'`;
  - `vary: Origin`;
  - and, only when `req.headers.origin` is allowed, `access-control-allow-origin: <that origin>` and `access-control-expose-headers: X-Request-Id`.
  - **Never** `*`, and never `access-control-allow-credentials`.
- **Config:**
  - `ServerConfig.allowedOrigins: string[]`; `CONFIG_VARIABLES` gains `ALLOWED_ORIGINS` after `PORT`. The validation copy is in the Global Constraints table.
  - `.env.example` gets `# Exact browser origins allowed to call the API, comma separated. Default http://localhost:5173,http://127.0.0.1:5173. "none" allows no browser.` / `ALLOWED_ORIGINS=`.
  - The HOST rule is unchanged (Ruling 3).
- **`server/http/sse.ts`:**
  ```ts
  export const MAX_EVENT_STREAMS = 20
  export const MAX_STREAM_BUFFER_BYTES = 1048576
  export function eventsRoute(deps: { events; heartbeatMs; streams; now; log: Logger; maxStreams?: number; maxBufferBytes?: number }): Route
  ```
  - When `streams.size >= maxStreams`, the handler throws `HttpError(503, 'Too many open event streams (limit <n>).', 'stream_limit')` before `writeHead`.
  - Every write goes through a `send(text)` helper: `res.write(text)`, then if `res.writableLength > maxBufferBytes` → `log.warn('Closed a slow event stream (over 1 MB buffered).')`, `res.end()`, cleanup.
  - This closes the two Stage B minors: unbounded streams, and no backpressure handling.
  - The client reconnects with `Last-Event-ID` and gets a replay or `state.reset`.
- **`server/app.ts`:**
  ```ts
  // AppDeps gains: maxStreams?: number
  guards = [...createSecurityGuards({ allowedOrigins: config.allowedOrigins, onReject }), ...(deps.guards ?? [])]
  responseHeaders = (req) => ({ ...securityHeaders(req, config.allowedOrigins), ...(deps.responseHeaders?.(req) ?? {}) })
  ```
  - `onReject`/`onRejected` are no-ops until Task 5.
- **Routes:** every manager call passes `{ requestId: ctx.requestId }` (`startTask`, `cancelTask`, `decideApproval`, `removeAgent`).
- **`server/test/helpers.ts`:**
  ```ts
  // api(): sets 'content-type: application/json' for every method except GET and HEAD (explicit headers still win)
  export function rawRequest(baseUrl: string, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>   // node:http request, so Host can be set
  ```
- **`server/test/sseClient.ts`:** `openEventStream(baseUrl, opts: { lastEventId?; query?; headers?: Record<string, string> })`.

- [ ] **Step 1: Write the failing tests.**
  - `server/http/router.test.ts`. The Stage B tests are unchanged (they use no guards). New:
    - `adds a request id to every reply`: the 200 and 404 replies have `x-request-id` matching `/^[0-9a-f]{12}$/`, and the two differ;
    - `passes the request id to guards and handlers`: a guard records `info.requestId`, which equals the response header;
    - `a 204 reply has no body or content type`: a guard returns `{ status: 204, body: null }` → body `''`, no `content-type`;
    - `reports coded HttpErrors to onRejected`:
      - a route throwing `new HttpError(400, 'x', 'unknown_field')` → `onRejected` called once with `{ status: 400, code: 'unknown_field', method: 'POST', path: '/echo', requestId: <header> }`;
      - `text/plain` → `code: 'content_type'`; over 64 KB → `code: 'body_too_large'`;
      - an `HttpError` without a code → not called.
  - **`server/http/guards.test.ts`** (default test server unless noted; Host cases use `rawRequest`):
    - `rejects a foreign Host header (DNS rebinding)` (Review Focus 1): `GET /api/state` and `GET /api/events` with `Host: evil.example:<port>` → 421 `{ error: 'Host not allowed.' }`, with no `access-control-allow-origin` and with `x-request-id` present;
    - `accepts loopback names with the server port only`: `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` and `LOCALHOST:<port>` → 200; `localhost`, `localhost:1` and `127.0.0.1.:<port>` → 421;
    - `rejects a disallowed Origin on any method with no CORS headers`: `GET /api/state` with `Origin: http://evil.example` → 403 `Origin not allowed.` and no ACAO; the same for `Origin: null`, and for a JSON `POST /api/agents`;
    - `allows the configured origins with exact CORS headers`: `Origin: http://localhost:5173` → 200, `access-control-allow-origin: http://localhost:5173`, `vary` contains `Origin`, `access-control-expose-headers: X-Request-Id`, and no `access-control-allow-credentials`;
    - `answers a preflight for an allowed origin`: `OPTIONS /api/agents/agent-demo-backend/tasks` with `Origin: http://127.0.0.1:5173`, `Access-Control-Request-Method: POST` and `Access-Control-Request-Headers: content-type` → 204, the exact ACAO, `access-control-allow-methods: GET, POST, PUT, PATCH, DELETE`, `access-control-allow-headers: Content-Type, Last-Event-ID`, `access-control-max-age: 600`, and body `''`;
    - `refuses a preflight from another origin` (Review Focus 1): → 403 with no ACAO;
    - `a cross-origin simple POST cannot reach a body-less route` (Review Focus 1):
      - start a task;
      - `fetch POST /api/tasks/<id>/cancel` with `{ origin: 'http://evil.example', 'content-type': 'text/plain' }` → 403;
      - without Origin, with `text/plain` → 415 `Content-Type must be application/json.`;
      - with no content type → 415;
      - `GET /api/state` shows the task still active (not `cancelling`/`cancelled`);
      - then with `application/json` → 202;
    - `JSON-only covers DELETE and the demo routes`: `DELETE /api/agents/agent-demo-qa` and `POST /api/demo/agents/restore` without a content type → 415, and the agent still exists;
    - `GET needs no content type`;
    - `every reply carries a request id and the hardening headers`: on a 200, 404, 421, 415 and the SSE response, check `x-request-id`, `referrer-policy: no-referrer`, `cross-origin-resource-policy: same-origin`, `content-security-policy: default-src 'none'; frame-ancestors 'none'` and `x-content-type-options: nosniff`;
    - `honours a custom ALLOWED_ORIGINS`: with `ALLOWED_ORIGINS: 'http://app.local:3000'`, that origin → 200 with ACAO, and `http://localhost:5173` → 403;
    - `onReject reports guard rejections with a reason code`: `createSecurityGuards({ allowedOrigins: [...], onReject: spy })` mounted on a router test server → Host, Origin and content type give `spy` calls with `code` `'host'`, `'origin'` and `'content_type'`, `method` and `path: '/api/state'`, and **no body text** in any argument.
  - **`server/http/sse.test.ts`.** The modified Stage B test `carries the configured response headers` still passes (the deps headers are merged after the security headers). New:
    - `SSE gets CORS headers for an allowed origin`: `openEventStream(url, { headers: { origin: 'http://localhost:5173' } })` → the `response.headers` ACAO is `http://localhost:5173`;
    - `limits open event streams`: `startTestServer({}, { maxStreams: 2 })`, open 2 streams → a third `GET /api/events` gives 503 `Too many open event streams (limit 2).`; after closing one, a new stream opens (poll up to 500 ms);
    - `ends a stream whose buffer passes the limit`: call `eventsRoute({ …, maxBufferBytes: 10 }).handler` with a fake `req` (an EventEmitter with `headers: {}`) and a fake `res` (an EventEmitter with `writeHead`, `write → false`, `writableLength: 11`, `end: vi.fn()`) → `end` is called and `streams.size === 0`.
  - **`server/app.test.ts`.** The modified Stage B helper `call()` in `describe('restarts')` sends `content-type: application/json` for every non-GET method. The tests are otherwise unchanged.
  - **`server/config.test.ts`:** `DEFAULTS` gains `allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173']`. New:
    - `reads ALLOWED_ORIGINS`: `' http://a.local:3000 , https://b.example '` → two entries; `'none'` → `[]`;
    - `refuses bad origins`, a table with exact copy: `'*'`, `'null'`, `'localhost:5173'`, `'ftp://x.example'`, `'http://localhost:5173/'` (→ `… must be an origin only, like http://localhost:5173.`), and 17 valid origins.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/http server/app.test.ts server/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the router changes, `guards.ts`, the reject codes, the SSE limits, the config variable, the `app.ts` wiring and the helper changes.
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test && npx tsc -b`. Every Stage B route, SSE and lifecycle test passes, through the helper's content-type default.
- [ ] **Step 5: Commit** with `feat(server): add host, origin and JSON-only guards with CORS`

---

### Task 5: Audit wiring, health status and leak tests

**Files:**
- Modify: `server/app.ts`, `server/index.ts`, `server/http/routes.ts` (health)
- Test: new `server/auditWiring.test.ts`, `server/secrets.test.ts`; modify `server/app.test.ts`

**Interfaces:**
- **`server/app.ts`:**
  ```ts
  // AppDeps gains: audit?: AuditLog
  // App gains: audit: AuditLog
  const log = redactingLogger(deps.log ?? consoleLogger)
  const audit = deps.audit ?? openAuditLog({ dataDir: config.dataDir, maxBytes: config.auditLogMaxBytes, now, log, hide: config.workspaceRoot ? [config.workspaceRoot] : [] })
  // TaskManager onLifecycle: (e) => audit.write(toAuditInput(e))   — taskId null → omitted; every other field copied
  // guards onReject and router onRejected: (r) => audit.write({ action: 'request.rejected', actor: 'api', requestId: r.requestId, reason: r.code, detail: `${r.method} ${r.path}` })
  export function startupRecord(config: ServerConfig, port: number): AuditInput
  ```
  - `startupRecord` gives `{ action: 'config.startup', actor: 'system', detail: 'runtime=<r> host=<h> port=<port> credentialsConfigured=<bool> workspaces=<ids joined with "," or "none"> allowedTools=<list or "none"> allowedOrigins=<list or "none">' }`.
  - **Never** the root path, `DATA_DIR` or any key.
  - `startServer` writes it once, right after `createApp`, with the bound port.
  - The store opens before the audit log (the store creates `DATA_DIR`).
- **`index.ts`:** the startup banner and errors go through `redactingLogger(consoleLogger)`.
- **Health:** `GET /api/health` adds `audit: app.audit.status`, which is `{ ok: boolean; error: string | null }` with `error` an fs error code only. Nothing else is added: no file path, no record count.

- [ ] **Step 1: Write the failing tests.**
  - **`server/auditWiring.test.ts`.** `readAudit(s)` parses `<dataDir>/audit.log` lines. The servers use a workspace fixture where needed.
    - `writes config.startup with ids only`: with `makeWorkspaceRoot(['sandbox']).env` and `ANTHROPIC_API_KEY: 'sk-ant-test-canary-0123456789'`, the first record is `{ seq: 1, action: 'config.startup', actor: 'system' }`; its `detail` contains `workspaces=sandbox`, `port=<s.port>` and `credentialsConfigured=true`; it doesn't contain `ws.root` or the canary;
    - `audits a full task with a tool approval`:
      - `POST` a task with `workspaceId: 'sandbox'` (keep `x-request-id` as `R`), wait for `running`, demo request-approval, approve (keep `R2`), wait for `completed`;
      - the actions for that `taskId` in order are `['task.start', 'tool.asked', 'approval.requested', 'approval.decided']`;
      - `task.start` has `actor: 'api'`, `requestId: R` and `workspaceId: 'sandbox'`;
      - `tool.asked` has `actor: 'runtime'`, `tool: 'Write'` and `detail: 'Write simulated.txt (39 B)'`;
      - `approval.decided` has `decision: 'approve'` and `requestId: R2`;
    - `audits rejected requests without bodies`:
      - a `POST /api/agents` with `Origin: http://evil.example` and body `'{"name":"secret-body-canary"}'` → a record `{ action: 'request.rejected', reason: 'origin', detail: 'POST /api/agents' }`;
      - `{ title: 'x', cwd: '/etc/shadow' }` → `reason: 'unknown_field'`;
      - a `rawRequest` with a bad Host → `reason: 'host'`;
      - the file text doesn't contain `secret-body-canary` or `/etc/shadow`;
    - `audits workspace rejections`: `'nope'` → `{ action: 'workspace.rejected', actor: 'api', agentId: 'agent-demo-backend', workspaceId: 'nope', reason: 'unknown' }`; `'../x'` → `reason: 'invalid_id'` with no `workspaceId` key;
    - `audits cancel and timeouts`: a cancel → `task.cancel` with `actor: 'api'`; with `TASK_TIMEOUT_MS: '300'` and slow mock timings, a run → `task.timeout` with `actor: 'system'`;
    - `audits a policy denial`: on a server with `ALLOWED_TOOLS: 'Read'`, the demo request → `tool.denied` with `reason: 'not_allowed'`, and the record has no `detail`.
  - **`server/app.test.ts`.** The modified Stage B test `GET /api/health reports the mock runtime` adds `audit: { ok: true, error: null }` to the `toMatchObject`. New:
    - `health reports an unavailable audit log and the server keeps serving`: create `<dataDir>/audit.log` as a directory before start (pass `DATA_DIR` explicitly) → health `audit: { ok: false, error: 'EISDIR' }`, and `GET /api/state` gives 200.
  - **`server/secrets.test.ts`** (Review Focus 5). `CANARY = 'sk-ant-test-canary-0123456789'`, `startTestServer({ ANTHROPIC_API_KEY: CANARY, ...ws.env }, { log: rec })` with `rec = recordingLogger()`:
    - `never writes the API key, request bodies or workspace paths`:
      - run health, state, workspaces, a 415, a 403 Origin, a 421 Host, a bad workspace, and a full task with a demo approval in `sandbox`; collect every response body and header;
      - read `workforce.json` and `audit.log`;
      - assert none of these, nor `rec.lines.join('\n')`, contains `CANARY`;
      - assert none contains `ws.root`, except `rec.lines` (never asserted to contain it either; the server logs no paths in these flows);
      - health has `credentialsConfigured: true`;
    - `the redacting logger hides a key that reaches a log line`: `app.manager`'s provider fails with `new Error('auth failed for sk-ant-api03-abcdefghijk')` (a `FakeProvider` with `rejectStart`) → `rec.lines` contain `[REDACTED]` and not `sk-ant-api03-abcdefghijk`, and the task's `errorMessage` is `'Runtime failed to start: auth failed for [REDACTED]'`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/auditWiring.test.ts server/secrets.test.ts server/app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring, `startupRecord`, the health field and the `index.ts` logger.
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test && npx tsc -b`.
- [ ] **Step 5: Commit** with `feat(server): write lifecycle, tool and rejected-request records to the audit log`

---

### Task 6: Claude provider boundary and leak guards

**Files:**
- Create: `scripts/secretScan.ts`, `scripts/checkSecrets.ts`
- Modify: `server/runtime/claudeAgent.ts`, `package.json` (script only), `server/noProcessExecution.test.ts`
- Test: new `scripts/secretScan.test.ts`; modify `server/runtime/claudeAgent.test.ts`, `server/noProcessExecution.test.ts`

**Interfaces:**
- **`server/runtime/claudeAgent.ts`:**
  ```ts
  export const SDK_INSTALLED = false
  /** Order of checks for the future provider: SDK first, then credentials, then (until it exists) the integration itself. */
  export function claudeUnavailableReason(sdkInstalled: boolean, credentialsConfigured: boolean): string
  export class ClaudeAgentRuntimeProvider implements ServerRuntimeProvider {
    constructor(opts?: { credentialsConfigured?: boolean })   // availability: { available: false, reason: claudeUnavailableReason(SDK_INSTALLED, credentialsConfigured) }
  }
  ```
  - `claudeUnavailableReason` gives:
    - `(false, *)` → `'Claude Agent SDK not installed'`;
    - `(true, false)` → `'credentials not configured'`;
    - `(true, true)` → `'Claude Agent SDK integration is not implemented yet'`.
  - In 3B.1 the reason is therefore always `Claude Agent SDK not installed`.
  - `app.ts` passes `{ credentialsConfigured: config.credentialsConfigured }`.
- **The documentation block** at the top of `claudeAgent.ts`. Write it as numbered rules, and verify the SDK option names against the installed SDK version when the integration lands:
  1. **Availability:** check that the SDK is importable, then `credentialsConfigured`. Never read `ANTHROPIC_API_KEY` anywhere but the server environment, and pass it to the SDK only through its documented credential option or env, never into prompts, events or logs.
  2. **Workspace:**
     - `start` refuses a task with `ctx.workspace === null` (the manager already returns `The claude runtime needs a workspace.`);
     - the SDK's `cwd` is `ctx.workspace.path`, set by the server and never by the browser or the model;
     - additional directories are never added.
  3. **Permissions:**
     - every tool call goes through the SDK permission callback (`canUseTool`), which calls `ctx.requestToolApproval({ tool, input })`;
     - `{ behavior: 'allow' }` maps to the SDK allow result with the unchanged input; `deny` maps to the SDK deny result with `message`;
     - never pass an auto-approve tool list for write, execute or network tools, because SDK auto-approved tools skip the callback; pass every non-catalogue tool as disallowed;
     - the permission mode is `default`, and never any permission mode other than `default`;
     - load no user, project or local settings files (no inherited allow rules), no MCP servers, and no hooks that could approve.
  4. **Limits:** stream output only as `RuntimeEvent`s, so the manager's caps, redaction, timeouts and approval timer apply. Never write files or logs directly.
  5. **Termination:**
     - pass an `AbortController` linked to `ctx.signal` to the SDK;
     - on `cancel(taskId)`, abort and emit `cancelled` when the SDK confirms;
     - the manager forces `cancelled` after `CANCEL_GRACE_MS`, and the provider must ignore events after its own abort.
  6. **Process execution:** this file becomes the single reviewed exception to `noProcessExecution.test.ts`, only if the SDK requires spawning its CLI. That needs a separate PR that updates the guard's allowlist with justification.
  7. **Audit:** use `ctx.audit(note)` for session start and end and abnormal termination. Never put prompts, inputs or outputs in notes.
- **Produces (`scripts/secretScan.ts`, pure):**
  ```ts
  export type BuiltFile = { path: string; text: string }   // path relative to the repo, for example 'dist-server/index.js'
  export function findSecretLeaks(files: BuiltFile[], keyValue: string | undefined): string[]
  ```
  - Each problem is one string:
    - `<path>: contains the ANTHROPIC_API_KEY value` (only when `keyValue` has 8 or more chars);
    - `<path>: contains an sk-ant- key` (`/sk-ant-[A-Za-z0-9_-]{10,}/`);
    - `<path>: mentions ANTHROPIC_API_KEY (only dist-server/index.js and its source map may)`, for any file other than `dist-server/index.js` and `dist-server/index.js.map`.
- **`scripts/checkSecrets.ts`:**
  - reads every file under `dist/` and `dist-server/` with `readdirSync({ recursive: true })` and `readFileSync`;
  - if either directory is missing → prints `Run npm run build and npm run server:build first.` and exits 1;
  - the key comes from `mergeEnv(.env text or null, process.env).ANTHROPIC_API_KEY` (imported from `server/config`);
  - prints `No secrets found in dist/ or dist-server/ (<n> files checked).` and exits 0, or prints each problem and exits 1.
  - It uses no child processes. The build is run by the person or step that runs the check (Ruling 9).
  - `package.json`: `"check:secrets": "tsx scripts/checkSecrets.ts"`.
- **`server/noProcessExecution.test.ts` additions:**
  ```ts
  const BYPASS = [/dangerously/i, /bypass_?permissions/i, /skip[-_]?permissions/i]
  const BYPASS_ALLOWED: Record<string, RegExp> = { './config.ts': /REFUSED_ENV_PATTERN/ }   // a matching line is allowed only if it also matches this
  ```
  - The scan covers the same globbed sources, plus `package.json` and `.env.example` read with `readFileSync(new URL('../<file>', import.meta.url), 'utf8')`.

- [ ] **Step 1: Write the failing tests.**
  - `server/runtime/claudeAgent.test.ts`. The modified Stage B test `reports unavailable and refuses to start` is unchanged apart from `testStartContext`. New:
    - `orders the unavailable reasons`: the three combinations give the exact strings;
    - `stays not installed even with credentials`: `new ClaudeAgentRuntimeProvider({ credentialsConfigured: true }).availability` equals `{ available: false, reason: 'Claude Agent SDK not installed' }`;
    - `documents the boundary`: the raw source (`?raw` import) contains `requestToolApproval`, `ctx.workspace.path`, `canUseTool`, `AbortController` and `CANCEL_GRACE_MS`.
  - `server/noProcessExecution.test.ts`. The two Stage B tests are unchanged. New:
    - `has no permission-bypass options` (Review Focus 4): the offenders, as lines matching any `BYPASS` pattern that are not allowed by `BYPASS_ALLOWED`, equal `[]`. Also assert that `./runtime/claudeAgent.ts` is in the scanned set;
    - `keeps .env out of git`: the lines of `.gitignore` include `.env`, and `.env.example` has no non-empty value (`/^[A-Z0-9_]+=\S/m` doesn't match).
  - `scripts/secretScan.test.ts`:
    - `passes clean bundles`: `[{ path: 'dist/assets/index.js', text: 'x' }, { path: 'dist-server/index.js', text: 'process.env.ANTHROPIC_API_KEY' }]` with key `'sk-ant-canary-0123456789'` → `[]`;
    - `finds the key value anywhere`;
    - `finds sk-ant- keys`;
    - `flags the variable name outside the server bundle`: `dist/assets/index.js` containing `ANTHROPIC_API_KEY` → one problem with the exact copy;
    - `ignores a key shorter than 8 characters`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/runtime/claudeAgent.test.ts server/noProcessExecution.test.ts scripts/secretScan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the provider changes and documentation block (without the forbidden words), `secretScan.ts`, `checkSecrets.ts` and the npm script.
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test && npx tsc -b`, then `npm run build && npm run server:build && npm run check:secrets` → `No secrets found …`.
- [ ] **Step 5: Commit** with `feat(server): document the Claude provider boundary and add leak guards`

---

### Task 7: Verification and PR

Stage C changes no UI, so this task uses curl. Run every step for real and paste the output into the PR. Use a temp workspace root outside the repo: `export VR=$(mktemp -d) && mkdir -p $VR/sandbox`. Start each server from a clean `data/` (`rm -rf data`).

- [ ] **Step 1: Full checks.**
  - `npm test` → all pass (Stage B's count plus the new tests).
  - `npm run build` → passes, with only the existing chunk-size warning.
  - `npm run server:build` → `dist-server/index.js` imports only `node:*` (`grep -Eo 'from "[^"]+"' dist-server/index.js | sort -u`).
  - `npm audit` → 0 vulnerabilities.
  - `ANTHROPIC_API_KEY=sk-ant-verify-canary-0123456789 npm run build && ANTHROPIC_API_KEY=sk-ant-verify-canary-0123456789 npm run server:build && ANTHROPIC_API_KEY=sk-ant-verify-canary-0123456789 npm run check:secrets` → `No secrets found …`.
- [ ] **Step 2: Guards** (`ANTHROPIC_API_KEY=sk-ant-verify-canary-0123456789 WORKSPACE_ROOT=$VR WORKSPACES=sandbox:sandbox npm run server`):
  1. **Rebinding:** `curl -si -H 'Host: evil.example:8787' http://127.0.0.1:8787/api/state` → `421`, `{"error":"Host not allowed."}`. The same for `/api/events`.
  2. Start a task: `curl -s -X POST -H 'Content-Type: application/json' -d '{"title":"Guard test","workspaceId":"sandbox"}' http://127.0.0.1:8787/api/agents/agent-demo-backend/tasks` (note the id).
  3. **Cross-origin simple POST:** `curl -si -X POST -H 'Origin: http://evil.example' -H 'Content-Type: text/plain' http://127.0.0.1:8787/api/tasks/<id>/cancel` → 403 with no `access-control-allow-origin`. Without Origin: `curl -si -X POST http://127.0.0.1:8787/api/tasks/<id>/cancel` → 415. `GET /api/state` → the task is still active.
  4. **Preflight:** `curl -si -X OPTIONS -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' http://127.0.0.1:8787/api/tasks/<id>/cancel` → 204 with the exact CORS headers. With `Origin: http://evil.example` → 403.
  5. **Allowed origin:** `curl -si -H 'Origin: http://localhost:5173' http://127.0.0.1:8787/api/health` → ACAO `http://localhost:5173`, `vary: Origin`, `x-request-id`, `referrer-policy`, `cross-origin-resource-policy` and `content-security-policy`. The body has `audit: {"ok":true,"error":null}` and no path.
- [ ] **Step 3: Workspaces.**
  1. `curl -s http://127.0.0.1:8787/api/workspaces` → `{"workspaces":[{"id":"sandbox"}]}`.
  2. `workspaceId: "nope"` → 422 `Unknown workspace "nope".`; `"../etc"` → 400 (id copy); `5` → 400.
  3. Stop the server, `ln -s /etc $VR/evil`, then start with `WORKSPACES=sandbox:sandbox,evil:evil` → `Workspace "evil" resolves outside WORKSPACE_ROOT.` and exit 1. `rm $VR/evil`.
  4. `WORKSPACE_ROOT=relative` → refused; `DATA_DIR=$VR/sandbox/data` → `DATA_DIR must not be inside workspace "sandbox".`
- [ ] **Step 4: Tool approval flow on the mock.**
  1. Start a task in `sandbox`, wait for `running`, then `curl -s -X POST -H 'Content-Type: application/json' http://127.0.0.1:8787/api/demo/tasks/<id>/request-approval` → the state shows `waiting_for_approval` with `pendingApproval.tool: "Write"` and `summary: "Write simulated.txt (39 B)"`.
  2. Approve → `completed`. Then `ls -A $VR/sandbox` → empty (nothing written).
  3. Another task, deny → `failed` with `Approval denied (simulated)`.
  4. Restart with `ALLOWED_TOOLS=Read`, then the demo request → `failed` with `Tool "Write" denied by policy: not in ALLOWED_TOOLS.`
- [ ] **Step 5: Audit log.**
  - `head -3 data/audit.log` → `config.startup` with `workspaces=sandbox` and no path.
  - `grep -c '"action"' data/audit.log` > 0.
  - `grep -E 'request.rejected|workspace.rejected|tool.asked|approval.decided|tool.denied' data/audit.log | head`.
  - `grep -c 'sk-ant-verify-canary' data/audit.log data/workforce.json` → 0 and 0.
  - `grep -c "$VR" data/audit.log data/workforce.json` → 0 and 0.
  - `stat -f %Lp data/audit.log` → `600`.
- [ ] **Step 6: Config refusals.** Each of these prints `Server config is invalid:` with the exact line and exits 1:
  - `ALLOWED_ORIGINS='*'`;
  - `ALLOWED_ORIGINS=http://localhost:5173/`;
  - `ALLOWED_TOOLS=Foo`;
  - `ALLOWED_TOOLS='*'`;
  - `DANGEROUSLY_SKIP_PERMISSIONS=1`;
  - `HOST=0.0.0.0`;
  - `AUDIT_LOG_MAX_BYTES=10`.
- [ ] **Step 7: Regression.**
  - Stage B's Task 7 curl steps 2–13, with `-H 'Content-Type: application/json'` added to every `POST`/`DELETE`: the cancel, request-approval, force-error, restore and delete calls.
  - `RUNTIME=claude npm run server` → health `reason: "Claude Agent SDK not installed"`; a task gives 503.
  - `npm run dev` (and `/vo`) still start the frontend only, in browser mock mode.
- [ ] **Step 8: Hygiene.**
  - `git status` → `data/`, `dist-server/` and `.env` are ignored.
  - `grep -rnEi "dangerously|bypass_?permissions|skip[-_]?permissions" server src scripts --include=*.ts | grep -v '\.test\.ts' | grep -v REFUSED_ENV_PATTERN` → nothing.
  - `grep -rnE "child_process|spawn\(|execFile" server src scripts` → nothing.
- [ ] **Step 9: Tick the Stage C boxes in `tasks.md`.** Commit with `docs: record milestone 3B.1 stage C verification`. Push `feat/security-foundation` and open the PR into `main` with:
  - the check output;
  - the guard, env and error-copy tables;
  - the audit format;
  - the rulings;
  - the explicit line: **No Claude SDK is installed; the backend runs the mock runtime only. Workspace and tool checks are policy checks, not an OS sandbox.**

---

## Rulings

1. **A human "deny" no longer ends the task by itself.**
   - A deny resolves the tool request `denied` and the task returns to `running`. That is what the SDK does: the agent is told the tool was refused and carries on. Stage A's `decideApproval` operation already sets `running`.
   - The mock keeps the Stage A/B visible behaviour by failing its simulated run on a deny (`Approval denied (simulated)`). Because that now happens when a promise settles, the `POST /api/tasks/:id/approval` response for a deny shows `running`, and the failure follows a microtask later.
   - Stage B tests changed: `routes.test.ts` `approval via demo controls`, and `taskManager.test.ts` `deny fails with the simulated message`.
2. **`Write`/`Edit` on a task without a workspace give `ask` with a lexical-only path check.** `Read`/`Glob`/`Grep`/`Bash` without a workspace give `deny no_workspace`.
   - `allow` needs proven containment. `ask` grants nothing without a human.
   - The only runtime that can have a task without a workspace is the mock, whose demo never writes.
   - The manager refuses a `claude` task with no workspace (`The claude runtime needs a workspace.`), and the provider boundary repeats this rule.
   - Without this ruling the default backend (no `WORKSPACE_ROOT`) couldn't demo approvals in Stage D.
3. **`HOST` stays loopback-only.**
   - Stage B Ruling 11 said Stage C would relax it once `ALLOWED_ORIGINS` exists. But with no login, a non-loopback bind would let anyone on the network drive the API: the Host and Origin checks stop browsers, not curl.
   - The rule is lifted in the VPS milestone, together with TLS and authentication. Only the copy changes.
4. **Decision 8's "every state-changing request must come from an allowed Origin" can't apply to clients that send no Origin,** such as curl and the tests.
   - Rule: a request **with** an Origin must match the allowlist.
   - A request without one passes only with an allowed Host and, for a state change, `Content-Type: application/json`. Browsers always send Origin on cross-origin requests and on any POST/PUT/PATCH/DELETE.
   - This matches Q5 (no token). A startup token stays deferred to the VPS milestone.
5. **`decideToolUse` signature.** `tasks.md` has `decideToolUse(tool, input, policy)`. This plan uses `decideToolUse(policy, toolName, input, workspace)`, because path containment needs the task's workspace. It does synchronous filesystem reads (realpath) but has no side effects.
6. **Schema stays v2.** `workspaceId` is a field that may be missing on read (it parses as `null`) and is always written.
   - There is no migration and no new key. Stage A browsers ignore the unknown key in a file written by the server, because `parseTask` builds a fresh object.
   - Browser-created tasks get `null`. The browser UI is unchanged.
7. **Approval summaries are built by the server from the tool input, not by the provider,** so a runtime can't mislabel what a human approves.
   - The server mock's summary changes from `Simulated request to write a file` to `Write simulated.txt (39 B)`.
   - The browser-only mock (`src/workforce/runtime/mockRuntime.ts`) is unchanged.
8. **The audit actor `runtime` is added** to the brief's `api | system`, so tool decisions made by the runtime can be told apart from human API calls and timers.
9. **"A test checks that the built `dist/` doesn't contain it" (decision 8) is a script, not a Vitest test.**
   - `npm run check:secrets` reads already-built files. A test would have to build, which is slow and would need process execution in the test.
   - The pure scanner is unit-tested, and Task 7 runs the script after building with a canary key.
10. **`TaskManagerOptions.onLifecycle` changes shape** to the full `LifecycleEvent` (adding `actor`, `requestId`, `taskId: string | null`, and the tool and workspace fields). It is internal. Stage B tests that read only `e.action` keep working.
11. **One pending approval per task.**
    - The SDK may ask for tools in parallel. A second `ask` while one is pending is denied with `approval_pending` rather than queued.
    - The future provider may add a queue behind the same `requestToolApproval` contract. This is listed as a limit.
12. **`persistence.error` in `/api/health` (Stage B) may contain the absolute `DATA_DIR` path** inside an fs message. It is not a workspace path, so it is left as is. The new `audit.error` uses codes only. This is listed under Deferred.

## Deferred to Stage D / later

- **Stage D (frontend integration):**
  - `RemoteWorkforceController`, sending `MUTATION_HEADERS` on every POST/PUT/PATCH/DELETE, including cancel and the demo routes;
  - a workspace picker fed by `GET /api/workspaces`;
  - the approval UI showing `pendingApproval.tool` and `summary`, with Approve/Deny (a deny now leaves a real runtime's task running);
  - handling 421/403/415 as configuration errors in the connection status.
- **Next phase (real Claude execution):**
  - install the SDK and implement `ClaudeAgentRuntimeProvider` to the documented boundary;
  - a queue for concurrent tool approvals;
  - provider-side re-checks;
  - OS-level isolation (container or separate user) for real tool execution, since containment here is a policy check;
  - the process-execution exception, if the SDK needs it.
- **VPS milestone:**
  - TLS, authentication or a startup token (Q5);
  - per-user identity in audit records;
  - lifting the loopback-only `HOST` rule;
  - Host allowlist entries for the public hostname;
  - rate limiting beyond the stream cap and the audit rate limit.
- **Later:**
  - an audit log viewer and export;
  - more than one rotated file, or shipping logs off the box;
  - codes-only `persistence.error`;
  - per-workspace tool policies;
  - a richer catalogue (for example `NotebookEdit`, MCP tools), each with an explicit category.
- **Documented limits:**
  - the checks are not a sandbox (time-of-check to time-of-use);
  - one pending approval per task;
  - the audit log keeps at most two files (`AUDIT_LOG_MAX_BYTES` each);
  - redaction is pattern-based, with accepted false positives;
  - no login, with the API protected by loopback binding plus the Host, Origin and JSON-only guards.
