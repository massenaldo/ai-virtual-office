# Milestone 3B.1.2 — Final Security Hardening: Tasks

**Spec:** [`plan.md`](plan.md) (Milestone 3B.1.2 brief). This file is my working task list for that spec.
**Status:** Approved for execution, 2026-10-31. The decisions below are applied as written; no stage has started.
**Earlier milestones:** [`milestone-3b11-tasks.md`](docs/milestones/milestone-3b11-tasks.md) ([report](docs/milestone-3b11-report.md)), [`milestone-3b1-tasks.md`](docs/milestones/milestone-3b1-tasks.md) ([report](docs/milestone-3b1-report.md)).

**Note on the brief:** `plan.md` stops mid-word in Phase 6 ("Digest visibility at approval time. - Hard"). I read Phase 6 as the deferred findings in section 10 of `docs/milestone-3b11-report.md`:
- the digest is not visible at approval time;
- nothing protects the gap between the final re-check and `perform` (path strings, not file descriptors; hard links inside a workspace);
- `GatedAction` has no abort signal;
- plus the open items listed there.

I also assume the same scope restrictions as 3B.1.1, and a final report in the same 10-point format.

## What this milestone is

3B.1.1 ended **READY WITH ISSUES**. This milestone closes the remaining high-priority security and reliability gaps before any real Claude runtime is connected.

- It fixes what leaks:
  - the open health route can return a raw save error that contains the data directory path;
  - error paths that echo internal messages.
- It proves what is claimed:
  - stale-approval tests through the real `TaskManager`;
  - a test of the dev proxy and SSE through a real Vite server.
- It closes known gaps:
  - `/api` prefix edge cases;
  - two servers sharing one `DATA_DIR`;
  - six missing redaction shapes;
  - hard links;
  - a missing abort signal.
- It builds the large Write/Edit review screen, so a change too long for the 200-character summary is shown in full and approved by digest, not refused.
- It writes down two designs it does not build: the gated in-process Write/Edit tool for the SDK, and long-term browser authentication.
- It does **not** install the Claude Agent SDK or run anything real. The mock runtime stays, and stays the default.

## Current state (from inspecting the code, 2026-10-31)

- **Branch and checks:** `main` at `1938776` (#31, 3B.1.1 Stage E). `npx vitest run`: **822 tests pass in 63 files**. The SDK is not installed (`SDK_INSTALLED = false`).
- **Health and state** (`server/http/routes.ts`):
  - `GET /api/health` is the only route the auth guard skips (`server/http/guards.ts`, `auth`: `GET` plus `/api/health`).
  - It returns `persistence: { ok, error: store.saveError }` and `audit: deps.audit.status`.
  - `GET /api/state` (authenticated) returns `saveError: store.saveError` in `StateResponse` (`src/workforce/api.ts`). `src/App.tsx` shows it as "Agent changes couldn't be saved: …".
- **Save errors** (`server/store.ts`, `openWorkforceStore` → `save`): `saveError = error.message`. A Node fs message contains the absolute path, e.g. `EACCES: permission denied, open '/…/data/workforce.json.tmp-123'`. The log line also includes `filePath`. That is fine for the local log, but the message reaches both routes.
- **Audit status** (`server/audit.ts`, `fail`): already code-only (`status = { ok: false, error: code }`, with `'write failed'` as fallback). The code is not checked against a list, though.
- **Other error paths:**
  - `router.ts`: unhandled errors become a generic 500. `HttpError` messages are our own text. 400 "Invalid URL.", 404 and 405 are fixed strings. The log line includes `req.url`.
  - `taskManager.ts` `launch()`: puts `Runtime failed to start: ${error.message}` into the task's `errorMessage`. `cap()` hides only the workspace and root paths, not `DATA_DIR`, the home directory or the cwd.
  - `store.ts`: throws `Couldn't read <path>` at startup. This goes to local stderr only.
- **Tool gate** (`server/toolGate.ts`, `createToolGate`):
  - It freezes a clone of the input and computes `actionDigest({ taskId, workspaceId, workspacePath, tool, input })`. It calls `deps.approve(request, digest)`, then re-checks liveness, the workspace, the digest and `decideToolUse` before `perform`.
  - **But `TaskManager.launch` wires `approve: (request) => this.approveTool(taskId, request)` and drops the digest.** `toolWaiter` is `{ approvalId, tool, resolve }`, and `PendingApproval` (`src/workforce/types.ts`) is `{ id, tool, summary, requestedAt }`. So the digest is never stored or shown, and the reviewer cannot see what they are bound to.
  - `GatedAction` = `{ tool, input, workspace }`: no signal, no checked paths.
  - The existing tests are `server/toolGate.test.ts`, which tests the gate with stub deps, not through `TaskManager`.
- **Approval** (`TaskManager.decideApproval`): checks the task, its status and that `pendingApproval.id === approvalId`, then settles the waiter. The body is `{ approvalId, decision }` (`parseApproval`).
- **Summaries** (`server/toolPolicy.ts`):
  - `SUMMARY_MAX_CHARS = 200`.
  - Write and Edit summaries embed the whole JSON-escaped content.
  - Any ask whose flattened summary is longer than 200 characters, or which redaction would change, is denied `not_reviewable`.
  - `cap()` passes summaries through `sanitizeSummary` and `hidePaths`.
  - The approval card (`src/workforce/ui/AgentDetail.tsx`) shows `pendingApproval.tool` and `summary` in a `<p>`.
- **Workspace checks** (`server/workspaces.ts`, `checkPathInWorkspace`) resolve real paths but never look at `nlink`. A hard link inside the workspace to a file elsewhere on the same volume passes.
- **Auth and proxy** (`server/auth.ts`, `scripts/apiProxy.ts`, `vite.config.ts`):
  - `createApiGate` acts only when `path.startsWith('/api/')`. The Vite proxy key is the string `'/api'`, a plain prefix.
  - So `/api` and `/apiX` are forwarded **without** the token (backend 401). `/API/state` and `/%61pi/state` are not proxied at all.
  - `tokenReader` reads `DATA_DIR/api-token` on every request.
  - `resolveApiToken` writes a fresh token at each start. A second server on the same `DATA_DIR` silently replaces the first one's token, and both also write `workforce.json` and `audit.log`.
  - `ServerConfig.apiToken` holds the configured token as a plain string ("never log or serialise the config").
- **Proxy tests:** `scripts/apiProxy.test.ts` (unit, fake req/res) and `scripts/viteServes.test.ts` (real Vite, no backend, no proxy). Nothing exercises the proxy or SSE through a real Vite server.
- **Redaction** (`server/redact.ts`, `PATTERNS`):
  - Covered: URL `user:pass@`, `gh*_`, `github_pat_`, `AKIA`/`ASIA`, `-u`/`--user`, Basic, `--password` and similar flags, `sk-ant-`, `sk-`, Bearer, and `key=value`.
  - Not covered: JWT, `xox…`, `AIza…`, PEM private keys, `-p<password>`, and URL passwords containing `@` or `/`. The userinfo pattern stops at the first `/` or `@`.
  - `scrub` cuts to `maxChars + 256` **before** redacting, so a PEM block can arrive without its END line.
- **E2E** (`server/e2e/realServer.test.ts`): 7 tests on the real `startServer`. The `readdirSync(ws.path('sandbox'))` check is vacuous, because the mock's `perform` (`() => 'simulated'`) never writes.
- **Test helpers** (`server/test/helpers.ts`): `startTestServer`, `testConfig` (`API_TOKEN = TEST_TOKEN`), `rawRequest`, `tempDataDir`; `server/test/sseClient.ts` (`openEventStream`); `server/test/fakeProvider.ts`.

### Existing code this milestone must not break

- The 3D office, layout editor, agent registry and desk assignments.
- Workforce UI, `useWorkforce`, both controllers, and storage schema v2.
- `MockRuntimeProvider`, `ServerMockProvider`, and the mock approval demo in browser and backend modes, with and without a workspace.
- The REST API, SSE recovery (snapshot, `lastEventId`, `state.reset`), the task lifecycle, timeouts and cancel grace.
- The guards (Host, Origin, auth, JSON-only, CORS, loopback). Also the token rules, the dev proxy, the audit log, `check:secrets` and `noProcessExecution.test.ts`.
- `npm run dev` and `/vo` as browser-only, plus `dev:full`, `server`, `server:build`, `server:start`, and the E2E test.

## Strict scope restrictions

- Do NOT install `@anthropic-ai/claude-agent-sdk`.
- Do NOT implement real Claude execution.
- Do NOT enable unrestricted Bash, Write, Edit or Network access. The gated Write/Edit tool is **designed in a doc only**, and `perform` in the mock still writes nothing.
- Do NOT deploy to a VPS.
- Do NOT rewrite the 3D scene or layout editor.
- Do NOT remove `MockRuntimeProvider`.
- Do NOT claim a sandbox exists. `docs/sandbox-architecture.md` stays design-only.
- Do not build the browser session-cookie flow. It is documented only (Stage 3).
- Do not start Milestone 3B.2 automatically.

## How I'll work

- **One stage = one branch = one PR into `main`**, using an in-place feature branch in this folder with no sibling worktree folders. Branches:
  - `fix/3b12-1-info-disclosure`
  - `test/3b12-2-tool-gate-integration`
  - `fix/3b12-3-auth-proxy`
  - `feat/3b12-4-redaction`
  - `feat/3b12-5-write-review`
  - `fix/3b12-6-reliability`
  - `docs/3b12-7-report`
- **Order and stacking:** Stage 5 depends on Stage 2 (the digest on `PendingApproval`). Stage 6 depends on Stage 2 (`GatedAction`). If a dependency is not merged yet, the branch is stacked on it. Stages 1, 3 and 4 are independent. Stage 7 runs once 1 to 6 are merged.
- **Conventional commits.** After each PR I stop for your merge.
- **TDD:** every task lists the tests to write first. They must fail (RED) before the code makes them pass (GREEN), and I record the RED run in the PR.
- **Every task ends with** `npx vitest run <its files>`, then `npm test` and `npx tsc -b`. Stages that touch the server or frontend also run `npm run build`, `npm run server:build` and `npm run check:secrets`.
- **Model split:** Sonnet implements each task. Opus does the security review in Stage 7, and reviews the Stage 3 and Stage 5 PRs before merge.
- **No new dependencies.**

## Decisions I propose (applied as written)

1. **Errors leave the process as codes, never messages.**
   - `store.saveError` becomes `SaveErrorCode | null`. `SaveErrorCode` is a closed list: `EACCES | EPERM | ENOSPC | EROFS | EISDIR | ENOENT | EMFILE | EIO | write_failed`, and anything else maps to `write_failed`.
   - `GET /api/health` returns `persistence: { ok, error: code }`. `audit.status.error` uses the same allowlist.
   - `GET /api/state` returns `saveError` as a fixed human sentence chosen by code, e.g. "Permission denied (EACCES).", with no path. `src/App.tsx` keeps showing it.
   - The full message, with path, goes only to the server log.
   - The health route keeps its other fields. They are configuration facts the UI needs (`runtime`, `available`, `reason`, `credentialsConfigured`, `startedAt`, `version`), and none holds a path or secret.
   - *Alternative:* move persistence and audit status behind auth. This costs a second health shape and a UI change for little gain, because a code is not sensitive.
2. **Runtime start failures are generic in state.**
   - `launch()` stores "Runtime failed to start." and logs the error itself.
   - `cap()` additionally hides `DATA_DIR`, `process.cwd()` and the home directory as `<data-dir>`, `<cwd>` and `<home>`, as a backstop for any later message.
   - *Alternative:* a generic absolute-path regex. It would also mangle legitimate relative output, and it gives a false sense of completeness.
3. **The digest is part of the approval.**
   - `approve(request, digest)` is wired through. `toolWaiter` stores the digest, and the waiter is settled only for that digest.
   - `PendingApproval` gains `digest: string | null`. It is null for the mock's own simulated approval.
   - `POST /api/tasks/:id/approval` takes an optional `digest`. When the pending approval has one, the body must carry the same value, or the response is 409 "That approval is no longer pending." The UI always sends it.
   - The approval card shows the first 12 hex characters, with the full value in a tooltip.
   - This is Stage 2, because Stage 5 needs it.
   - *Alternative:* keep binding by approval id only. The id is already unique per action, but the human would still not be able to see or confirm what they approved, which is the finding.
4. **Large Write/Edit review = a separate, bounded `review` payload on the pending approval** (Stage 5).
   - `PendingApproval` gains `review: ToolReview | null`, where `ToolReview` is `{ workspaceId, path, bytes, lines, digest }` plus `{ kind: 'write', content }` or `{ kind: 'edit', oldString, newString, replaceAll }`.
   - `path` is workspace-relative. The content is exactly the frozen input, never truncated, never reformatted.
   - The summary becomes a short line that always fits the 200-character cap: `Write <path> (1.2 kB, 40 lines): review the full content`.
   - **`REVIEW_MAX_BYTES = 32768`** (the default `MAX_MESSAGE_BYTES`) applies to the UTF-8 size of all displayed fields together. Above it the request is denied `not_reviewable`, as today. It is a fixed constant, not configurable.
   - Also denied `not_reviewable`:
     - content that redaction would change (a secret would be shown and persisted);
     - content with control characters other than `\t`, `\n` and `\r`;
     - content with C1 controls;
     - content with bidi overrides or isolates (U+202A–U+202E, U+2066–U+2069), because what is shown would not be what is written ("Trojan Source").
   - The review travels in state and events like the rest of `PendingApproval`, and is persisted in `workforce.json` (mode 0600) only while pending. A restart fails the task, so it never outlives the approval. `storage.ts` validates its shape and size on load.
   - Bash, WebFetch and WebSearch keep the 200-character summary rule. No review payload.
   - *Alternatives:*
     - Serving the review from an authenticated `GET /api/tasks/:id/approvals/:approvalId/review` kept only in memory. It keeps Write content out of `workforce.json` and the event buffer, but costs a route, a fetch-and-retry in the UI and a mock-browser variant.
     - A real file diff against the current file. The file is not covered by the digest and can change after review, so it would show something that is not bound.
     - Both are recorded for 3B.2.
5. **UI review pane.**
   - When `review` is set, the approval card shows the workspace id, target path, size, digest and a scrollable monospace pane: the full content with line numbers for Write, or "Replace" / "With" blocks plus the "all occurrences" flag for Edit.
   - Whitespace is visible (tabs and trailing spaces marked).
   - **Approve is disabled until the pane has been opened.** Deny always works.
6. **Proxy prefix: exact `/api/` only.**
   - The Vite proxy key becomes the regex `'^/api/'`.
   - `createApiGate` decodes and lowercases the path once. Any path whose decoded, lowercased form starts with `/api` (`/api`, `/apiX`, `/API/…`, `/%61pi/…`, `/api%2F…`, `//api/…`) but is not literally `/api/…` gets a 404 from the gate and never reaches the backend.
   - *Alternative:* forward variants with the token. That widens what the token authorises for no user benefit.
7. **One server per `DATA_DIR`.**
   - At start the server creates `DATA_DIR/server.lock` with `wx`, mode 0600, holding `{ pid, startedAt }`.
   - If the lock exists and `process.kill(pid, 0)` says the process is alive, start is refused: "Another server is using DATA_DIR (pid N)." This happens before the token is written.
   - A lock whose pid is dead is replaced and logged.
   - The lock is removed on `close()`.
   - `noProcessExecution.test.ts` is unaffected, because a signal-0 check is not process execution.
   - `dev:full` and `server` print the same refusal.
   - *Alternative:* a per-process token file name (`api-token.<pid>`). Two servers would then still corrupt `workforce.json` and `audit.log`, and the proxy would not know which file to read.
8. **The token value is wrapped.**
   - `ServerConfig.apiToken` becomes `Secret | null`. `Secret.toJSON()`, `toString()` and `util.inspect` all return `[REDACTED]`, and `.reveal()` is used only in `auth.ts` and `app.ts`.
   - `findSecretInConfig` stays as a second line of defence.
   - *Alternative:* split `parseConfig` into `{ config, secrets }`. It is cleaner, but touches every `testConfig` call site for the same guarantee.
9. **Long-term browser auth is documented, not built** (`docs/browser-auth.md`):
   - The dev proxy stays the local-dev path.
   - Before anything is served beyond this machine, an HttpOnly, `SameSite=Strict`, `Path=/api` session cookie is issued after a one-time pairing (the token pasted once into a Connect form, `POST /api/session`), with the backend serving the UI same-origin.
   - The doc states plainly that `Sec-Fetch-Site` is **not** authentication against local programs.
10. **New redaction rules stay in `server/redact.ts`.**
    - **JWT:** `eyJ…` three-part base64url, each part at least 8 characters.
    - **Slack:** `xox[abposr]-…` and `xapp-…`.
    - **Google:** `AIza` followed by exactly 35 characters `[0-9A-Za-z_-]`.
    - **PEM:** private keys go through a small linear scanner function, not a lazy regex. It redacts from `-----BEGIN … PRIVATE KEY-----` to the matching END line, **or to the end of the text when the END line is missing**, because `scrub` may have cut it.
    - **`-p`:** only the attached form after `mysql`, `mysqldump`, `mariadb` or `mysqladmin` (`-pSECRET`), and `sshpass -p VALUE`. `ssh -p 22`, `mkdir -p`, `docker run -p 8080:80`, `cp -p` and `pg_dump -p 5432` are untouched.
    - **URL userinfo:** the password may contain `@` and `/`. The userinfo runs to the last `@` that is followed by a host and then `/`, `?`, `#`, whitespace or the end. A password that would contain `/` is rejected as a credential when the part before the first `/` is all digits (a port), so `https://host:8080/a/@scope/pkg` survives. An empty user (`redis://:p@ss@host`) is covered.
11. **Hard links and the final gap.**
    - `checkPathInWorkspace` gains an `existing file with nlink > 1` → `unsafe_link` deny reason, applied to Read, Write and Edit targets at ask time and at the use-time re-check. The deny text is "path is a hard link".
    - `GatedAction` gains `signal: AbortSignal` (the task's) and `paths: { arg, relative }[]`. The gate refuses `cancelled` if the signal is already aborted just before `perform`.
    - The remaining gap (path strings, not descriptors) is closed by contract in the gated-tool doc: open with `O_NOFOLLOW`, `fstat` and compare `dev`/`ino`/`nlink`, write to a temp file in the same directory and `rename`.
    - Nothing writes real files in this milestone.
12. **The gated in-process Write/Edit tool is a doc** (`docs/gated-tools.md`), linked from the header of `server/runtime/claudeAgent.ts` and from the README.
    - SDK built-in `Write` and `Edit` go in `disallowedTools` and are never used.
    - Our MCP tools `vo_write` and `vo_edit` have a handler that *is* `ctx.tools.use(request, perform)`, with the real fs work inside `perform`.

## Stage 1 — Information disclosure

Branch: `fix/3b12-1-info-disclosure`.

- [x] **1.1 Safe persistence and audit status.** (Decision 1)
  - Files: `server/store.ts` (`SaveErrorCode`, `saveErrorCode(error)`, `saveErrorText(code)`), `server/audit.ts` (allowlisted code), `server/http/routes.ts` (health and state), `src/workforce/api.ts` (types only; `saveError` stays `string | null`), and the tests `server/store.test.ts`, `server/http/routes.test.ts` and `server/audit.test.ts`.
  - RED first:
    - Using the existing `writeFile` test seam, make it throw a real-shaped fs error, e.g. `Object.assign(new Error(\`EACCES: permission denied, open '${dataDir}/workforce.json.tmp-1'\`), { code: 'EACCES' })`.
    - Assert that `store.saveError === 'EACCES'`.
    - Assert that `GET /api/health` without a token has `persistence: { ok: false, error: 'EACCES' }` and that its body text contains neither `dataDir` nor `tmpdir()` nor `/`-rooted paths.
    - Assert that `GET /api/state` `saveError` is "Permission denied (EACCES)." with no path.
    - An unknown code (`EWEIRD`) and an error without a code both give `write_failed`.
    - The audit log failing with `EISDIR` gives `audit: { ok: false, error: 'EISDIR' }`.
    - The server log line still has the full message.
  - Verify: `npx vitest run server/store.test.ts server/audit.test.ts server/http/routes.test.ts`, then `npm test` and `npx tsc -b`.
- [x] **1.2 Disclosure sweep of every unauthenticated response and error path.** (Decision 2)
  - Files: new `server/http/disclosure.test.ts`; `server/taskManager.ts` (`launch()` catch, `hidePaths` extra labels; the manager gets `dataDir` through `config`), `server/http/router.ts` (log `pathOf(req)`, never the query string), and `server/taskManager.test.ts`.
  - RED first:
    - A table-driven test against a real `startTestServer` with a workspace. For each response it asserts that the body and headers contain no `dataDir`, workspace root, `process.cwd()`, `os.homedir()`, `TEST_TOKEN`, `"stack"`, `at ` frames or `Error:`. The responses are:
      - `GET /api/health`;
      - `OPTIONS` preflight;
      - 401 (no token, wrong token);
      - 404 and 405;
      - 421 (bad Host);
      - 403 (bad Origin);
      - 415;
      - 400 (bad URL, bad JSON, `../x` workspace);
      - 413;
      - 422 (unknown workspace);
      - 409;
      - and a forced 500 (a route dep that throws an `Error` with a path).
    - `taskManager.test.ts`: a provider whose `start` throws `new Error(\`ENOENT: open '${dataDir}/x'\`)` gives task `errorMessage === 'Runtime failed to start.'`, and the log has the original. A runtime `failed` event containing `dataDir` or `homedir()` comes out as `<data-dir>` or `<home>`.
    - The router logs `GET /api/state` without `?lastEventId=…`.
  - Verify: `npx vitest run server/http/disclosure.test.ts server/taskManager.test.ts server/http`, then `npm test` and `npx tsc -b`.

## Stage 2 — Tool gate reliability

Branch: `test/3b12-2-tool-gate-integration`.

- [x] **2.1 The digest travels with the approval.** (Decision 3)
  - Files:
    - `server/taskManager.ts`: `approveTool(taskId, request, digest)`; `toolWaiter: { approvalId, tool, digest, resolve }`; `decideApproval(taskId, approvalId, decision, opts, digest?)`.
    - `server/http/inputs.ts`: `parseApproval` accepts optional `digest`, 64 lowercase hex characters.
    - `server/http/routes.ts`.
    - `src/workforce/types.ts`: `PendingApproval.digest: string | null`.
    - `src/workforce/runtime/types.ts`: `approval_requested` carries `digest?`.
    - `src/workforce/operations.ts`.
    - `src/workforce/storage.ts`: serialise and parse `digest`. An old file without it parses as `null`. No schema bump.
    - The browser mock sets `digest: null`.
    - `src/workforce/remote/commands.ts` sends `digest`.
    - `src/workforce/ui/AgentDetail.tsx`: short digest with a tooltip.
  - RED first:
    - The `approval_requested` state for a gated Write has `pendingApproval.digest === actionDigest(...)` for that task, workspace, tool and input.
    - Approving with a wrong digest gives 409, `perform` is not called, and the task stays waiting.
    - Approving with no digest when one is pending gives 409.
    - The mock's own approval (no workspace) has `digest: null` and approves with no digest.
    - A storage round trip keeps `digest`, and a v2 file without the field loads.
    - The UI test shows the 12-character prefix.
  - Verify: `npx vitest run server/taskManager.test.ts server/http src/workforce`, then `npm test`, `npx tsc -b` and `npm run build`.
- [x] **2.2 Stale-approval integration tests through the real `TaskManager`.**
  - Files: new `server/toolGate.integration.test.ts` (real `TaskManager`, real store in a temp `DATA_DIR`, real workspace from `server/test/workspaces.ts`, and `server/test/fakeProvider.ts` extended with a `useTool(taskId, request, perform)` hook that records `perform` calls). Fixes go in `toolGate.ts` or `taskManager.ts` only if a test exposes a gap.
  - RED first (each must assert `perform` was **never** called, the outcome, and the audit record `tool.stale`, `tool.denied` or none):
    - **Task state:**
      - approve, then `cancelTask` in the same tick before the gate resumes → `cancelled`;
      - the task times out while waiting → `expired`;
      - the agent is removed → `cancelled`;
      - the approval timer fires after approve → no double settle.
    - **Workspace:**
      - the workspace directory is renamed between ask and approve → `stale_approval` ("workspace unavailable");
      - the workspace is replaced by a symlink to another folder → `stale_approval`;
      - the target's parent becomes a symlink outside → `stale_approval` ("path or policy check failed").
    - **Tool name and input:**
      - the caller mutates `request.tool` and `request.input` after `use()` → `perform` receives the original frozen values and the digest is unchanged;
      - a second `use()` for a different input while one is pending → `approval_pending`, and the first approval still only performs the first input.
    - **Binding:**
      - task B's `approvalId` posted to task A → 409;
      - the same approval id approved twice → the second is 409 and `perform` runs once;
      - an approval decided after its task finished → 409.
  - If a case finds a real gap, the fix goes in this branch with that test as the RED.
  - Verify: `npx vitest run server/toolGate.integration.test.ts server/toolGate.test.ts server/taskManager.test.ts`, then `npm test` and `npx tsc -b`.
- [x] **2.3 Doc: the gated in-process Write/Edit tool.** (Decisions 11 and 12)
  - Files: new `docs/gated-tools.md`, the header of `server/runtime/claudeAgent.ts` (a pointer only), and `server/runtime/claudeAgent.test.ts`.
  - The doc covers:
    - why SDK built-in `Write` and `Edit` are never used (they execute after `canUseTool` returns);
    - the `vo_write` and `vo_edit` MCP tool schemas (Claude Code field names, so `toolPolicy` is unchanged);
    - handler = `ctx.tools.use`;
    - `perform` steps: re-open by descriptor with `O_NOFOLLOW`, `fstat` `dev`/`ino`/`nlink` check, temp file in the same directory, `fsync`, `rename`, and the size cap;
    - honouring `action.signal`;
    - what the agent gets back, including errors without host paths;
    - `disallowedTools` additions;
    - how it combines with the sandbox design;
    - a 3B.2 checklist.
  - The first line says "Design only. Not implemented."
  - RED first: extend `claudeAgent.test.ts` to assert that the header links `docs/gated-tools.md`, that `docs/gated-tools.md` exists and starts with "Design only", and (existing checks) that `SDK_INSTALLED === false` and there is no `@anthropic-ai` import in `package.json` or `server/`.
  - Verify: `npx vitest run server/runtime/claudeAgent.test.ts server/noProcessExecution.test.ts`, then `npm test`.

## Stage 3 — Authentication and proxy reliability

Branch: `fix/3b12-3-auth-proxy`. Opus reviews the PR before merge.

- [x] **3.1 `/api` prefix edge cases.** (Decision 6)
  - Files: `scripts/apiProxy.ts` (`createApiGate` canonical-path check; proxy key `'^/api/'`) and `scripts/apiProxy.test.ts`.
  - RED first:
    - `/api`, `/apiX`, `/api?x=1`, `/API/state`, `/Api/state`, `/%61pi/state`, `/api%2Fstate`, `/%2Fapi/state` and `//api/state` each get 404 from the gate, `next()` is not called, and no `authorization` header is set;
    - `/api/state` and `/api/events?lastEventId=…` still pass with the token;
    - `/`, `/src/main.tsx` and `/@vite/client` are untouched;
    - `apiProxyFor(...).proxy` has exactly the key `'^/api/'`.
  - Verify: `npx vitest run scripts/apiProxy.test.ts`, then `npm test`.
- [x] **3.2 A real Vite server, the real backend and SSE, in one automated test.**
  - Files: new `scripts/viteProxy.test.ts`.
    - It starts `startServer` on `PORT=0` with a temp `DATA_DIR` and a generated token.
    - Then Vite `createServer({ configFile: 'vite.config.ts', server: { port: 0 } })`, with `VITE_WORKFORCE_API_URL=/`, `PORT` and `DATA_DIR` set in `process.env` before creation and restored after.
    - It uses `node:http` requests (so `Sec-Fetch-Site` can be set) and `openEventStream` pointed at Vite.
  - RED first: written against the merged 3.1 behaviour, then run once against `main`'s `apiProxy.ts` to confirm the prefix cases fail. Assertions:
    - same-origin `GET /api/state` through Vite → 200;
    - without `Sec-Fetch-Site` → 403;
    - an incoming `Authorization: Bearer attacker` is replaced;
    - every 3.1 variant gets a non-2xx response and never produces a backend `request.rejected reason=auth` audit record;
    - SSE through Vite: create a task through Vite, receive `task.queued` and `task.started`;
    - reconnect with `Last-Event-ID` and receive only newer events;
    - the stream stays open across one heartbeat;
    - no response body or header contains the token;
    - `data/api-token` is still not served (as in `viteServes.test.ts`).
  - Verify: `npx vitest run scripts/viteProxy.test.ts scripts/viteServes.test.ts`, then `npm test`.
- [x] **3.3 One server per `DATA_DIR`, and the token kept out of config text.** (Decisions 7 and 8)
  - Files: new `server/dataDirLock.ts` and `server/dataDirLock.test.ts`; `server/app.ts` (lock before `resolveApiToken`, release in `close()`); `server/config.ts` and new `server/secret.ts` (`Secret`); `server/auth.ts`; `server/index.ts`; `scripts/devFull.ts` (clear message); `server/test/helpers.ts` if needed.
  - RED first:
    - a second `startServer` on the same `DATA_DIR` rejects with "Another server is using DATA_DIR", and the first server's token file and token are unchanged and still accepted;
    - a lock holding a dead pid is replaced;
    - `close()` removes the lock, so a restart on the same `DATA_DIR` works (existing restart tests stay green);
    - the lock file has mode 0600;
    - `JSON.stringify(config)`, `String(config.apiToken)` and `util.inspect(config)` show `[REDACTED]`, never the value;
    - with a capturing logger and audit log, a full E2E-style run (start, 401, 200, SSE, error paths, the second-server refusal) never prints the token;
    - after `npm run build`, `grep -r` for the test token and `api-token` in `dist/` finds nothing (this extends `check:secrets`).
  - Verify: `npx vitest run server/dataDirLock.test.ts server/auth.test.ts server/config.test.ts server/app.test.ts server/e2e`, then `npm test`, `npx tsc -b`, `npm run build`, `npm run server:build` and `npm run check:secrets`.
- [x] **3.4 Doc: long-term browser authentication.** (Decision 9)
  - Files: new `docs/browser-auth.md` and a README link.
  - The doc covers:
    - the threat model: other local programs, web pages, the LAN, and a future VPS;
    - what the dev proxy protects and what it does not, with a clear statement that `Sec-Fetch-Site` is not authentication against local programs;
    - Options A, B and C from the 3B.1.1 Q1 table, with the decision: cookie pairing before anything leaves the machine;
    - the cookie design (HttpOnly, `SameSite=Strict`, `Path=/api`, rotation, logout, CSRF reasoning, `localhost` vs `127.0.0.1`);
    - what changes in `client.ts` and `sync.ts` (`credentials: 'include'`, `withCredentials`);
    - the rule that the token is never in URLs, logs, bundles or errors, and where each rule is enforced and tested.
  - The first line says "Decision record. The cookie flow is not built."
  - Verify: `npm test` (unchanged). I check the doc against plan.md Phase 3 items 4 and 5 line by line.

## Stage 4 — Secret redaction

Branch: `feat/3b12-4-redaction`.

- [x] **4.1 JWT, Slack, Google, PEM, `-p` and URL passwords with `@` or `/`.** (Decision 10)
  - Files: `server/redact.ts` (new `PATTERNS` entries, `redactPrivateKeys` scanner run first in `redactSecrets`, and a replacement for the URL userinfo rule) and `server/redact.test.ts`. Plus one sink test each in `server/taskManager.test.ts` (runtime message), `server/audit.test.ts` (detail) and `server/toolPolicy.test.ts` (a Bash command containing a JWT → `not_reviewable`).
  - RED first, positive cases:
    - a real-shaped JWT;
    - a JWT in `Authorization: Bearer` (no double marker issue);
    - `xoxb-…`, `xoxp-…`, `xapp-1-…`;
    - `AIza` + 35 characters;
    - RSA, EC, OPENSSH and `ENCRYPTED PRIVATE KEY` blocks, including the whole multi-line body;
    - a PEM block with no END line;
    - a PEM block cut by `scrub(…, 100)`;
    - `mysql -uroot -pS3cret db`;
    - `sshpass -p 'x y' ssh h`;
    - `https://u:p@ss@host/x`;
    - `postgres://u:pa/ss@db:5432/app`;
    - `redis://:p@ss@host:6379`.
  - RED first, negative cases (must stay untouched):
    - `eyJ` alone and a two-part `a.b`;
    - `xox` in prose;
    - `AIza` with 34 characters;
    - `-----BEGIN CERTIFICATE-----` and `BEGIN PUBLIC KEY`;
    - `ssh -p 22 host`, `mkdir -p a/b`, `docker run -p 8080:80`, `cp -p`, `pg_dump -p 5432`;
    - `https://host:8080/a/@scope/pkg`, `http://localhost:5173/@vite/client`, `https://example.com/@user`, `ssh://git@host`;
    - every existing negative.
  - RED first, cost tests (each under 50 ms on a 100 kB input):
    - 10,000 `-----BEGIN RSA PRIVATE KEY-----` lines with no END;
    - a 100 kB `https://a:` followed by `@`-free text;
    - 100 kB of `eyJ.` repeats;
    - 100 kB of `xox-`.
  - Verify: `npx vitest run server/redact.test.ts server/taskManager.test.ts server/audit.test.ts server/toolPolicy.test.ts`, then `npm test` and `npm run check:secrets`.

## Stage 5 — Large Write/Edit review

Branch: `feat/3b12-5-write-review`. It depends on 2.1. Opus reviews the PR before merge.

- [x] **5.1 Server: the bounded `review` payload.** (Decision 4)
  - Files:
    - `server/toolPolicy.ts`: `buildReview(tool, input, rel, workspaceId)`, `REVIEW_MAX_BYTES`, `reviewable(text)` (control, C1 and bidi check plus the redaction check). The Write/Edit summary becomes the short line. `decideToolUse` returns `review` on `ask` for Write and Edit.
    - `server/taskManager.ts`: `approveTool` puts `review` (with the digest) on `approval_requested`; `cap()` applies `hidePaths` to `path` only and never cuts content.
    - `src/workforce/types.ts` (`ToolReview`, `PendingApproval.review`), `src/workforce/runtime/types.ts`, `src/workforce/operations.ts`.
    - `src/workforce/storage.ts`: validates `review` (shape, kind, sizes at most `REVIEW_MAX_BYTES`, digest equal to `pendingApproval.digest`); an invalid review makes the record invalid, following the existing parse rules.
    - Tests in `server/toolPolicy.test.ts`, `server/taskManager.test.ts`, `server/toolGate.integration.test.ts` and `src/workforce/storage.test.ts`.
  - RED first:
    - a 5 kB multi-line Write is now `ask` (it was `not_reviewable`), its summary is 200 characters or fewer, and `review.content === input.content` byte for byte (tabs, CRLF, trailing spaces, emoji);
    - an Edit has `oldString`, `newString` and `replaceAll`;
    - exactly `REVIEW_MAX_BYTES` → `ask`, and one byte more → `not_reviewable`;
    - content with `‮`, `⁦`, `\u0007`, `\u0085`, or an `sk-ant-…` key → `not_reviewable`;
    - `review.path` is relative and contains no workspace path;
    - `review.digest === pendingApproval.digest === actionDigest(…)`;
    - changing one byte of the input after approval → `stale_approval` (via 2.2's harness);
    - the review survives a `workforce.json` round trip, and an oversized or mismatched review on load is rejected;
    - Bash with a long command is still `not_reviewable`.
  - Verify: `npx vitest run server/toolPolicy.test.ts server/taskManager.test.ts server/toolGate.integration.test.ts src/workforce/storage.test.ts`, then `npm test` and `npx tsc -b`.
- [x] **5.2 UI: the review pane.** (Decision 5)
  - Files: new `src/workforce/ui/ApprovalReview.tsx` (and its test), `src/workforce/ui/AgentDetail.tsx` (renders it; Approve is disabled until it has been opened; sends `digest`), `src/workforce/view.ts` (`formatReviewLines`, whitespace markers), its CSS, and `src/workforce/view.test.ts`.
  - RED first:
    - with a Write review, the pane shows the workspace id, path, size, digest prefix and every line, numbered (a 2,000-line file renders all 2,000 lines, with no ellipsis);
    - Approve is disabled until "Show full change" is opened, and Deny is always enabled;
    - an Edit shows "Replace" and "With" blocks and the all-occurrences flag;
    - tabs and trailing spaces are marked;
    - content containing `<script>` renders as text;
    - with no review (the mock demo, Bash) the card is unchanged;
    - approving posts `{ approvalId, decision, digest }`.
  - Manual check (Chrome tools if available, otherwise noted in the report): with `WORKSPACE_ROOT` set, the `dev:full` mock demo's gated Write shows the pane, and approve and deny both work. Without a workspace, the card is unchanged. No test-only provider is wired into the app; the large-file cases are covered at the Vitest level.
  - Verify: `npx vitest run src/workforce`, then `npm test`, `npx tsc -b` and `npm run build`.

## Stage 6 — Deferred reliability items

Branch: `fix/3b12-6-reliability`. It depends on 2.1 and 2.2.

- [ ] **6.1 Hard links, the abort signal and checked paths on `GatedAction`.** (Decision 11)
  - Files: `server/workspaces.ts` (`nlink > 1` → `unsafe_link` for an existing regular file), `server/toolPolicy.ts` (`DenyReason` plus text), `server/runtime/types.ts` (`GatedAction.signal`, `GatedAction.paths`), `server/toolGate.ts` (`deps.signal`; refuse `cancelled` if aborted just before `perform`), `server/taskManager.ts` (passes `run.abort.signal`), `server/runtime/mockProvider.ts` (unchanged behaviour), and the tests.
  - RED first:
    - `fs.linkSync(outside, ws/inside.txt)`: Read, Write and Edit of `inside.txt` are each denied `unsafe_link`;
    - a link created after approval → `stale_approval` at use time;
    - a file with `nlink === 1` is still fine;
    - `perform` receives `action.signal`, and it is aborted when the task is cancelled during an async `perform`;
    - the signal aborted between approval and `perform` → `cancelled`, and `perform` is not called;
    - `action.paths` lists `{ arg: 'file_path', relative }` with no absolute path;
    - an `expectTypeOf<GatedAction>()` check.
  - Verify: `npx vitest run server/workspaces.test.ts server/toolPolicy.test.ts server/toolGate.test.ts server/toolGate.integration.test.ts server/runtime/mockProvider.test.ts`, then `npm test` and `npx tsc -b`.
- [ ] **6.2 Open items: E2E gap and audit suppression record.**
  - Files: `server/e2e/realServer.test.ts`, `server/audit.ts` and `server/audit.test.ts`.
  - E2E: replace the vacuous `readdirSync` check with real assertions on `audit.log`:
    - `tool.asked` for `Write` with the summary's relative path;
    - `approval.decided`;
    - no `tool.stale`;
    - `pendingApproval.digest` is a 64-character hex value in the `task.waiting_for_approval` patch;
    - the approval is posted with that digest.
    - Keep the directory check, labelled "the mock's perform writes nothing".
  - Audit: the suppressed-count record is written at the first audit write of any action in a new window and on `close()`, not only at the next rejected request.
  - RED first:
    - the new E2E assertions fail against the current mock (no digest);
    - a test with 31 rejections followed by a `task.start` in the next window shows the `suppressed` record before `task.start`.
  - Verify: `npx vitest run server/e2e server/audit.test.ts server/auditWiring.test.ts`, then `npm test`.

## Stage 7 — Verification, security review, docs and report

Branch: `docs/3b12-7-report`, stacked on the last merged stage.

- [ ] **7.1 Full verification and Opus security review.**
  - Run and record:
    - `npm test` (count and files compared with 822/63);
    - `npx tsc -b`;
    - `npm run build`;
    - `npm run server:build`, then `node dist-server/index.js` with a curl smoke test (health has no path; a second instance on the same `DATA_DIR` is refused; state 401 then 200);
    - `npm run check:secrets`;
    - `grep -r "api-token\|Bearer " dist/`;
    - `npm audit`.
  - Browser checks:
    - `/vo` (mock: 3D office, editor, mock approval);
    - `dev:full` (Live, approve with digest shown, deny, cancel, restart Offline then Live).
    - These use the Chrome tools if available; otherwise I say so in the report.
  - Then an **Opus security review** of the whole milestone diff (`git diff 1938776..HEAD`), focused on disclosure, the gate and digest binding, the review payload (truncation, rendering, Trojan Source), proxy canonicalisation, the lock, and redaction ReDoS.
  - Each Critical or High finding is fixed in this branch with a RED test first. Medium and lower findings are fixed or ruled on in the report.
  - Verify: all of the above green after the fixes.
- [ ] **7.2 README, report and status.**
  - Files: `README.md` and new `docs/milestone-3b12-report.md`.
  - README changes:
    - the health shape;
    - the single-server lock;
    - the review screen and digest;
    - the new redaction shapes;
    - links to `docs/gated-tools.md` and `docs/browser-auth.md`;
    - "Known limitations" updated.
  - The report uses the same 10 sections as `docs/milestone-3b11-report.md`: verdict, files changed, then one section each for disclosure, the gate and digest, auth and proxy, redaction, large-write review, reliability, checks and review outcome, and remaining blockers and deferred findings.
  - Its banner states that **the Claude Agent SDK is not installed, no real execution exists, and sandbox isolation is not implemented**.
  - Archive `plan.md` and this file under `docs/milestones/` as `milestone-3b12-plan.md` and `milestone-3b12-tasks.md`, matching 3B.1.1. Update this Status line. Open the PR.
  - Verify: `npm test`. Check that the README and report links resolve (`ls` each linked path).

## Questions (answered by the recommendations; applied as written)

- **Q1: Where does the large-write review content live?**
  - Recommendation: on `PendingApproval.review`, bounded at 32 KiB and refused above that (decision 4).
  - What the alternative costs: an authenticated in-memory review endpoint keeps content out of `workforce.json` and the event buffer, but adds a route, a UI fetch with retry, and a browser-mock variant.
- **Q2: How are two servers on one `DATA_DIR` handled?**
  - Recommendation: a lock file with a liveness check, refusing the second server (decision 7).
  - What the alternative costs: per-process token files still let two servers corrupt `workforce.json` and `audit.log`.
- **Q3: Does health hide status codes behind auth?**
  - Recommendation: no. Allowlisted codes only, never messages (decision 1).
  - What the alternative costs: a second health shape and a UI change, for codes that are not sensitive.
- **Q4: Which `-p` forms are redacted?**
  - Recommendation: only the attached MySQL-family form and `sshpass -p` (decision 10).
  - What the alternative costs: redacting every `-p VALUE` hides ports, `mkdir -p` targets and Docker port maps in every log and summary, and makes those Bash summaries `not_reviewable`.

## Decisions

Applied 2026-10-31 as written above (no open questions): Q1 review payload on `PendingApproval`, Q2 `DATA_DIR` lock file, Q3 allowlisted codes in open health, Q4 narrow `-p` rule.
