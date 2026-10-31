# Milestone 3B.1.1 — Security Hardening & E2E Verification: Tasks

**Spec:** [`plan.md`](plan.md) (Milestone 3B.1.1 brief). This file is my working task list for that spec.
**Status:** Draft, 2026-10-31. Awaiting your answers to Q1–Q3 (see "Questions for you"). Nothing is implemented yet.
**Earlier milestones:** [`milestone-3b1-tasks.md`](docs/milestones/milestone-3b1-tasks.md) ([report](docs/milestone-3b1-report.md)), [`milestone-3a-tasks.md`](docs/milestones/milestone-3a-tasks.md) ([report](docs/milestone-3a-report.md)).

## What this milestone is

The 3B.1 audit said **READY WITH ISSUES**. This milestone closes those issues before any real Claude runtime is connected.

- It hardens what exists:
  - workspace checks;
  - secret redaction;
  - the tool gate, so a future provider can't run a tool except through it;
  - a local API token.
- It writes the Docker sandbox design down. It doesn't build the sandbox.
- It adds a real end-to-end test against the running server.
- It does **not** install the Claude Agent SDK or run anything real. The mock runtime stays, and stays the default.

## Current state (from inspecting the code, 2026-10-31)

- **Branch and checks:** `main` at #25 (3B.1 Stage E).
  - `npm test`: 58 files, 720 tests pass.
  - `tsc -b` is clean. `npm run build`, `server:build` and `check:secrets` pass. `npm audit` reports 0 vulnerabilities.
  - The SDK is not installed. `SDK_INSTALLED = false` in `server/runtime/claudeAgent.ts`.
- **Workspaces** (`server/workspaces.ts`):
  - `parseWorkspaces` stores `workspaceRoot` as a real path when the config loads.
  - `resolveWorkspace`, however, compares against `realpathSync(config.workspaceRoot)` **at call time**, not against the stored root. If the root is later swapped for a symlink, the check follows it.
  - `checkPathInWorkspace` treats `ENOTDIR` like `ENOENT` and walks up, so `file.txt/x` is accepted.
  - The header comment states that time of check to time of use is not guaranteed, and that "a runtime must re-check at use time". Nothing does that re-check yet.
- **Tool policy** (`server/toolPolicy.ts`):
  - `TOOL_CATALOGUE` marks `Write` and `Edit` as `needsWorkspace: false`. With no workspace, `decideToolUse` falls back to `lexicalPath`, a text-only check.
  - Write, execute and network tools can only ever be `ask`. A summary that redaction or the length cap would change is refused as `not_reviewable`.
- **Approval flow** (`server/taskManager.ts`):
  - `TaskManager.requestToolApproval(taskId, request)` calls `decideToolUse`. On `ask`, it stores a `toolWaiter { approvalId, tool, resolve }` and emits `approval_requested`.
  - `decideApproval` settles that waiter with `{ behavior: 'allow', outcome: 'approved' }`.
  - **The approval isn't bound to the action.** The result carries no input, digest or workspace. The provider gets back only "allowed", then does the work itself with whatever input it holds. Nothing re-checks the path at execution time. The provider also receives the workspace's real path (`StartContext.workspace.path`).
- **Runtime contract** (`server/runtime/types.ts`):
  - `StartContext` = `{ agent, signal, workspace, tools: ToolPolicy, requestToolApproval, audit }`.
  - `ServerMockProvider.requestApproval` (`server/runtime/mockProvider.ts`) calls `ctx.requestToolApproval({ tool: 'Write', input: MOCK_DEMO_WRITE })` and writes nothing.
  - The header of `claudeAgent.ts` describes the intended `canUseTool`, `permissionMode` and settings rules.
- **Redaction** (`server/redact.ts`): four patterns, which are `sk-ant-`, `sk-`, `Bearer` and `key|secret|token|password = value`.
  - Not covered: URL credentials (`https://u:p@host`), `ghp_` / `github_pat_`, `AKIA…`, `Basic …`, and `--password value`.
  - Redaction is applied in `TaskManager.cap` (messages, progress, errors, results), `sanitizeSummary`, the audit log, `redactingLogger` and `scrub`.
- **HTTP** (`server/http/guards.ts`, `router.ts`, `sse.ts`, `app.ts`):
  - Guards run in this order: Host (421), Origin (403), preflight, JSON-only (415).
  - **A request with no `Origin` passes the Origin guard** (curl, other local software). There is no authentication of any kind.
  - CORS never sends credentials.
  - `GET /api/events` takes `?lastEventId=` because `EventSource` can't send headers on its first connect.
- **Frontend** (`src/workforce/source.ts`, `remote/client.ts`, `remote/sync.ts`):
  - `resolveWorkforceSource` accepts only an `http(s)` origin. `client.ts` calls `fetch(baseUrl + path)` cross-origin.
  - `sync.ts` opens `new EventSource(\`${baseUrl}/api/events?lastEventId=…\`)`. **EventSource can't send an `Authorization` header.**
- **Dev workflow:**
  - `npm run dev` runs Vite only (browser mock). `/vo` (`scripts/vo.sh`) runs `VO_AUTO_EXIT=1 npm run dev` and checks health with `curl localhost:5173`.
  - `npm run dev:full` (`scripts/devFull.ts`) starts the backend and Vite **in one process**, and sets `VITE_WORKFORCE_API_URL` to the backend URL.
  - `vite.config.ts` has no proxy.
- **Tests:**
  - `server/test/helpers.ts` (`startTestServer` on `PORT=0` with a temp `DATA_DIR`, `api()`, `rawRequest`) and `server/test/sseClient.ts` (`openEventStream`) already drive a real `node:http` server with real `fetch` and SSE parsing.
  - `server/noProcessExecution.test.ts` scans non-test `.ts` files under `server/`, `src/` and `scripts/`.

### Existing code this milestone must not break

- The 3D office, layout editor, agent registry and desk assignments (browser-side, `ai-virtual-office:layout:v1`).
- Workforce UI, `useWorkforce`, both `WorkforceController` implementations, and storage schema v2.
- `MockRuntimeProvider`, `ServerMockProvider`, and the mock approval demo, in both browser and backend modes.
- The REST API, the SSE recovery contract (snapshot, `lastEventId`, `state.reset`), the task lifecycle v2, timeouts and cancel grace.
- The guards: Host, Origin, JSON-only, CORS and loopback binding. Also the audit log, `check:secrets` and the no-process-execution guard.
- `npm run dev` and `/vo` as browser-only, plus `dev:full`, `server`, `server:build` and `server:start`.

### Deferred minors carried from 3B.1 (not in this milestone unless listed in a stage)

- Stage C: the suppressed-count audit record is written in the next window; guard tests are text scans.
- All Stage D UI minors from the 3B.1 report.
- The build still warns about the >500 kB chunk.

## Strict scope restrictions (from plan.md)

- Do NOT install `@anthropic-ai/claude-agent-sdk`.
- Do NOT implement real Claude execution.
- Do NOT enable unrestricted Bash, Write, Edit, or Network access.
- Do NOT deploy to a VPS.
- Do NOT rewrite the 3D scene or layout editor.
- Do NOT remove MockRuntimeProvider.
- Do NOT claim Docker sandbox isolation is implemented if only its architecture has been documented.
- Do not start Milestone 3B.2 automatically.

## How I'll work

- **One stage = one branch = one PR into `main`.** Branches are `fix/3b11-a-workspace-redaction`, `feat/3b11-b-tool-gate`, `feat/3b11-c-api-token`, `docs/3b11-d-sandbox` and `test/3b11-e-e2e`. I stop for your review after each PR.
- **TDD:** every task lists the tests to write first. They must fail (RED) before the code makes them pass (GREEN).
- **Every task ends with** `npm test` and `npx tsc -b`. Stages that touch the server or frontend also run `npm run build` and `npm run server:build`.
- **No new dependencies.**

## Decisions I propose (for your OK)

1. **Workspace is mandatory for Write and Edit.** `needsWorkspace: true` and `lexicalPath` is removed. A Write or Edit with no workspace is denied `no_workspace`. What this does to the mock demo is Q3.
2. **One canonical root.** `resolveWorkspace` compares against the stored `config.workspaceRoot`, which is the real path from config time. If `realpathSync(root)` no longer equals the stored value, it fails as `escapes_root`. A path through a regular file (`ENOTDIR`) is `invalid_path`.
3. **Redaction stays one module.** New patterns go into `PATTERNS` in `server/redact.ts`, so every existing sink picks them up. "Basic" is redacted only when its base64 decodes to `user:pass`, so "Basic configuration" survives.
4. **Tool gate by construction, built on what exists.** No second policy:
   - A new `server/toolGate.ts` wraps `decideToolUse`, `resolveWorkspace` / `checkPathInWorkspace` and the manager's existing approval machinery (`toolWaiter`, approval timer, `decideApproval`).
   - `StartContext.requestToolApproval` is **replaced** by `ctx.tools: ToolGate` with one method, `use(request, perform)`.
   - The gate freezes a clone of the input and computes `digest = sha256(canonicalJson({ taskId, workspaceId, workspaceRealPath, tool, input }))`. It decides with the existing policy and asks a human on `ask`. The approval id is bound to that digest.
   - **Immediately before `perform`**, the gate re-resolves the workspace and re-runs `decideToolUse` on the frozen input (the use-time path check). It recomputes the digest and checks the task is still running and the approval unused.
   - Any mismatch is refused as `stale_approval`, audited, and `perform` isn't called. An approval is single-use.
   - `perform` receives only the frozen input and the checked paths.
   - `ToolGateResult` gains `stale_approval`. `ToolRequest` keeps its shape.
5. **The mock uses the same gate.** `ServerMockProvider` calls `ctx.tools.use({ tool: 'Write', input: MOCK_DEMO_WRITE }, () => simulated)`, where `perform` is a no-op that writes nothing.
6. **Claude SDK plug-in is documented, not built.** The header of `claudeAgent.ts` is rewritten (details in B3). The plan is `canUseTool` → `ctx.tools.use`, with `perform` returning the SDK's allow result with `updatedInput` set to the frozen input.
   - `permissionMode: 'default'`.
   - No auto-approve list. The `allowedTools` option is empty, because auto-approved tools skip `canUseTool`.
   - `disallowedTools` is everything outside the catalogue, plus `Bash`, `WebFetch` and `WebSearch` until the sandbox exists.
   - `settingSources: []`, no MCP servers except our own, no hooks that approve, and no `additionalDirectories`.
   - It also records the remaining gap honestly: SDK built-in tools execute *after* `canUseTool` returns. For 3B.2, the recommended step is to replace built-in `Write`/`Edit` with in-process SDK MCP tools whose handler *is* `perform`, so the write happens inside the gate, and to run everything else in the sandbox. Option names must be checked against the installed SDK version.
7. **Local API token (backend):**
   - `API_TOKEN` (server-only env, at least 32 characters) if set. Otherwise the server generates one at each start: `randomBytes(32)`, base64url.
   - A generated token is written atomically to `DATA_DIR/api-token` with mode 0600, so a separately started Vite proxy can read it. **Rotation = restart** (generated) or changing `API_TOKEN` (configured).
   - Checked with `timingSafeEqual` on SHA-256 digests.
   - **Every `/api/*` route needs `Authorization: Bearer <token>`, including `GET /api/state`, `/api/workspaces` and `/api/events`.** The only exceptions are `GET /api/health` (it carries no state) and `OPTIONS` preflight.
   - **No exception for a missing `Origin`.** Guard order: Host, Origin, preflight, **auth (401)**, JSON-only.
   - The token never appears in logs, responses, audit records, the startup record (`apiToken=configured|generated` only), snapshots or bundles.
   - `findSecretInConfig` and `check:secrets` also check for the token. An `API_TOKEN` under a `VITE_` name is refused at start.
   - The token is never accepted in a query string.
8. **How the browser authenticates.** See Q1. I recommend **Option A, the same-origin Vite proxy**.

### Q1 background: browser authentication options

The constraints:
- the token must never be in a bundle, URL, log or snapshot;
- `EventSource` can't set headers;
- `?token=` is out, because it leaks to history, logs and `Referer`.

| Option | How | Pros | Costs |
|---|---|---|---|
| **A. Vite dev proxy injects the header** (recommended) | The browser calls same-origin `/api/*` on :5173. Vite's proxy (server side, Node) adds `Authorization: Bearer …` and forwards to :8787. `VITE_WORKFORCE_API_URL=/` means "same origin". `dev:full` passes the token in memory. A separate `npm run dev` reads `DATA_DIR/api-token`. The proxy forwards only `/api/*`, removes any incoming `Authorization`/`Cookie`, keeps `Origin` (the backend still checks it), and requires `Sec-Fetch-Site: same-origin`. | The browser never sees the token. Plain `EventSource` and `fetch` keep working without CORS. Small change: `vite.config.ts`, `devFull.ts`, `source.ts`. No UI for pairing. | Works only where Vite runs (dev / `dev:full`). `vite preview` and a future VPS need the backend to serve the UI or Option B. Any local process that reaches :5173 gets an authenticated path. That is the same trust level as Vite already serving the source tree, and it is documented. |
| B. HttpOnly session cookie after a one-time exchange | The user pastes the token into a "Connect" form. `POST /api/session` (token in the JSON body) sets `vo_session`: HttpOnly, SameSite=Strict, Path=/api. Requests use `fetch(..., { credentials: 'include' })` and `new EventSource(url, { withCredentials: true })`, and CORS adds `Allow-Credentials` for exact origins. | Works with any way of serving the UI, including a later VPS. No proxy. JavaScript never holds the token after the paste. | A manual pairing step after each rotation, plus a new form, a session store, cookie parsing and CSRF reasoning. Cookies are per host name (`localhost` ≠ `127.0.0.1`). About two more tasks. |
| C. fetch-streamed SSE with a header | Replace `EventSource` with `fetch` plus a `ReadableStream` parser, sending `Authorization`. | Plain bearer auth everywhere. | JavaScript must hold the token, so it must come from somewhere the page can read (typed in, or kept in sessionStorage), where XSS or a snapshot can reach it. It also re-implements stream parsing and reconnects. Not recommended. |

**What happens to each workflow under A:**
- `npm run dev` / `/vo`: unchanged. Browser mock, no backend, no token, and the proxy isn't registered unless `VITE_WORKFORCE_API_URL=/`.
- `dev:full`: works with no setup. It generates the token and wires the proxy in-process.
- `npm run server` + `npm run dev` with `VITE_WORKFORCE_API_URL=/`: the proxy reads the token file.
- A direct `VITE_WORKFORCE_API_URL=http://127.0.0.1:8787` still parses, but gets 401. The UI shows "Not authorized — start with `npm run dev:full`" instead of silently weakening.
- README and `.env.example` document generation, storage (`DATA_DIR/api-token`, 0600, gitignored with `data/`) and rotation.

## Stage A — Workspace enforcement and redaction gaps

Branch: `fix/3b11-a-workspace-redaction`.

- [ ] **A1. Workspace enforcement.**
  - Files: `server/workspaces.ts`, `server/toolPolicy.ts`, `server/runtime/mockProvider.ts` (only the Q3 change), and their tests.
  - RED first:
    - in `workspaces.test.ts`: (a) a root replaced by a symlink after config, so `resolveWorkspace` fails `escapes_root`; (b) `file.txt/x` → `invalid_path`; (c) a symlink inside the workspace re-pointed outside *between two calls*, so the first check passes and the second fails; (d) a path renamed between calls.
    - in `toolPolicy.test.ts`: Write and Edit with `workspace = null` → `no_workspace`, and existing lexical-path cases removed or rewritten.
    - in `server/http/routes.test.ts`: `/api/workspaces`, `/api/state` and a 422 workspace error contain neither the root nor the workspace path.
    - in `mockProvider.test.ts`: the demo approval works with no workspace (per Q3) and with a workspace.
  - Verify: `npx vitest run server/workspaces.test.ts server/toolPolicy.test.ts server/runtime/mockProvider.test.ts server/http/routes.test.ts`, then `npm test` and `npx tsc -b`.
- [ ] **A2. Redaction patterns.**
  - Files: `server/redact.ts`, `server/redact.test.ts`, plus one sink test each in `taskManager.test.ts` and `audit.test.ts`.
  - Patterns:
    - URL `scheme://user:pass@` → `scheme://[REDACTED]@`;
    - `gh[pousr]_[A-Za-z0-9]{36,}` and `github_pat_…`;
    - `(AKIA|ASIA)[A-Z0-9]{16}`;
    - `Basic <base64>` when it decodes to something containing `:`;
    - `--password|--passwd|--pass|--token|--secret|--api-key` followed by `=` or a space, then the value;
    - existing `sk-` / `Bearer` kept.
  - RED first: positive cases for each pattern, plus negative cases that must stay untouched:
    - `https://example.com/@user`;
    - a 40-hex git SHA;
    - `AKIA` inside a normal word or with the wrong length;
    - "Basic configuration";
    - `--password-file ./secrets.txt` keeps the path;
    - `password_reset.md`.
    - Then one test per sink: a `ghp_` token in a mock message, in a failure error and in an audit detail comes out `[REDACTED]`.
    - Also check that a WebFetch/Bash summary containing a new pattern becomes `not_reviewable`, not a redacted ask.
  - Verify: `npx vitest run server/redact.test.ts server/taskManager.test.ts server/audit.test.ts`, then `npm test`.

## Stage B — Tool gate by construction

Branch: `feat/3b11-b-tool-gate`. It depends on A (workspace required, canonical root).

- [ ] **B1. `ToolGate` and digest-bound approval.**
  - Files: new `server/toolGate.ts` and `server/toolGate.test.ts`. Changes to `server/runtime/types.ts` (replace `requestToolApproval` with `tools: ToolGate`; the policy stays reachable only through the gate), `server/taskManager.ts` (`requestToolApproval` becomes private gate plumbing; `toolWaiter` stores the digest; `decideApproval` unchanged for the API), and `server/test/fakeProvider.ts`.
  - RED first:
    - `perform` is not called on deny, on human deny, on approval timeout or after cancel;
    - mutating the caller's input object after `use()` was called doesn't change what `perform` receives (frozen clone);
    - a symlink in the target path re-pointed outside the workspace *after approval, before perform* → `stale_approval`, audited, `perform` not called;
    - the workspace directory moved after approval → `stale_approval`;
    - an approval id can't be used twice;
    - a second `use()` while one is pending → `approval_pending` (existing behaviour kept);
    - read tools still `allow` without asking, but are re-checked at use;
    - a type-level test (`expectTypeOf<StartContext>()`) shows there is no `requestToolApproval` and no raw policy bypass.
    - Existing `taskManager.test.ts` approval tests must still pass, adapted only to the new context shape.
  - Verify: `npx vitest run server/toolGate.test.ts server/taskManager.test.ts`, then `npm test` and `npx tsc -b`.
- [ ] **B2. The mock goes through the gate.**
  - Files: `server/runtime/mockProvider.ts` and its tests, plus `server/http/routes.test.ts` (demo flow over HTTP).
  - RED first:
    - the demo approval goes through `ctx.tools.use` and its `perform` is a no-op;
    - approve → completed, deny → failed "Approval denied (simulated)";
    - an approval timeout and a cancel behave as today;
    - nothing is written in the workspace (check the directory listing in the test).
  - Verify: `npx vitest run server/runtime/mockProvider.test.ts server/http/routes.test.ts`, then `npm test`.
- [ ] **B3. Claude SDK integration doc block.**
  - Files: `server/runtime/claudeAgent.ts` (header only, per decision 6) and `claudeAgent.test.ts`.
  - The test asserts that the provider is still unavailable, that `SDK_INSTALLED === false`, and that no `@anthropic-ai` import exists in `package.json` or `server/`.
  - Verify: `npx vitest run server/runtime/claudeAgent.test.ts server/noProcessExecution.test.ts`, then `npm test`, `npx tsc -b`, `npm run build` and `npm run server:build`.

## Stage C — Local API token

Branch: `feat/3b11-c-api-token`. The design here assumes Q1 = A. Under B, C2 becomes a session endpoint plus a Connect form.

- [ ] **C1. Backend token and auth guard.**
  - Files: new `server/auth.ts` and `server/auth.test.ts`. Changes to `server/config.ts` (`API_TOKEN`, refused under a `VITE_` name, minimum length), `server/http/guards.ts` (auth guard, 401 plus `WWW-Authenticate: Bearer`, audited as `request.rejected reason=auth`), `server/app.ts` (resolve the token, write the token file, startup record), `server/redact.ts` (`findSecretInConfig` for the token), `scripts/checkSecrets.ts`, and `server/test/helpers.ts` / `sseClient.ts` (send the token by default, so existing tests stay meaningful).
  - RED first:
    - every route except `GET /api/health` and `OPTIONS` returns 401 with no token, with a wrong token, and **with no `Origin` header**;
    - `GET /api/events` with no token gets 401 before any stream bytes;
    - `?token=` in the query is ignored (still 401);
    - a generated token file has mode 0600 and a new value after a restart;
    - a configured short token is refused at start;
    - with a capturing logger and audit log, the token appears in no log line, audit record, response body or header;
    - the existing guard order tests still pass (bad Host still gives 421 before 401).
  - Verify: `npx vitest run server/auth.test.ts server/http server/config.test.ts`, then `npm test` and `npx tsc -b`.
- [ ] **C2. Browser path: same-origin proxy (Q1 = A).**
  - Files: new `scripts/apiProxy.ts` and `scripts/apiProxy.test.ts` (builds Vite `server.proxy` options). Changes to `vite.config.ts` (proxy only when `VITE_WORKFORCE_API_URL=/`; reads `DATA_DIR/api-token` per request), `scripts/devFull.ts` (in-memory token, sets `VITE_WORKFORCE_API_URL=/`), `src/workforce/source.ts` (accept `/` as same origin, `baseUrl: ''`), `src/workforce/remote/sync.ts` / `remoteController.ts` (401 → a clear "Not authorized" connection error), and `src/vite-env.d.ts` if needed.
  - RED first:
    - `apiProxy` adds `Authorization`, removes incoming `Authorization` and `Cookie`, refuses anything other than `Sec-Fetch-Site: same-origin` with 403, and forwards only `/api/*`;
    - `resolveWorkforceSource('/')` gives a same-origin backend;
    - `sync` opens `EventSource('/api/events?lastEventId=…')`;
    - a 401 from the snapshot shows the "Not authorized" state and does not fall back to the browser mock.
  - Verify: `npx vitest run scripts/apiProxy.test.ts src/workforce`, then `npm test`, `npm run build`, `npm run server:build` and `npm run check:secrets`. Also `grep -r "api-token\|Bearer " dist/` must find no token value.
  - Manual check: `npm run dev:full`, then the browser shows `Live`; `curl 127.0.0.1:8787/api/state` gives 401.
- [ ] **C3. Docs for the token.**
  - Files: `README.md` ("Backend" section: auth model, workflows table, generation, storage, rotation, what the proxy trusts) and `.env.example` (`API_TOKEN`, with a note that it must never be a `VITE_` variable).
  - Verify: `npm test` (the config test that checks `CONFIG_VARIABLES` against `.env.example` covers the new name).

## Stage D — Sandbox architecture (document only)

Branch: `docs/3b11-d-sandbox`.

- [ ] **D1. `docs/sandbox-architecture.md`.**
  - The first line states: **"Design only. Not implemented. No sandbox isolation is active."**
  - It covers plan.md Phase 2:
    - a non-root user;
    - only the selected workspace mounted (read-write) at a fixed path;
    - a read-only root filesystem with a tmpfs `/tmp`;
    - no Docker socket;
    - `--network none` by default;
    - CPU, memory, `--pids-limit`, output size and wall-clock limits;
    - `--rm`, plus labels and a start-up sweep for cleanup after a crash;
    - an explicit env allowlist;
    - no credentials in the image or the container filesystem.
  - It shows where the container sits relative to `ToolGate` (`perform` runs the action inside the container).
  - It lists technical blockers:
    - the model API call needs network while tools must not have it, so the agent loop and the tools need to be split, or egress allowed only to the API through a proxy;
    - how `ANTHROPIC_API_KEY` reaches the SDK without entering the tool container;
    - the server needs Docker Engine access (socket or CLI), which conflicts with `noProcessExecution.test.ts` and needs a reviewed exception;
    - Docker Desktop on macOS runs in a VM (bind-mount symlink semantics and performance);
    - Windows support;
    - mapping output caps to container logs;
    - the TOCTOU gap between `canUseTool` and SDK built-in tools.
  - It ends with an implementation checklist for 3B.2+.
  - The README links to it.
  - Verify: `npm test` (unchanged). I review the doc against plan.md Phase 2 line by line.

## Stage E — Real end-to-end test, compatibility, report

Branch: `test/3b11-e-e2e`.

- [ ] **E1. `server/e2e/realServer.test.ts`.**
  - It uses the real `startServer` (per Q2) on `PORT=0` with `parseConfig`, a temp `DATA_DIR` and a temp workspace, and drives it only through real `fetch` and `openEventStream`. No fakes, no direct manager calls.
  - Steps:
    1. `GET /api/health` without a token returns 200.
    2. `GET /api/state` without a token returns 401, and with the token returns 200.
    3. Open SSE with the token.
    4. Create a task (`POST /api/agents/:id/tasks`) and see `task.queued`, `task.started` and `agent.status_changed` events.
    5. Use the demo approval: `task.waiting_for_approval`, approve, then `task.completed`.
    6. Start a second task, cancel it, and see `task.cancelled`. The final `GET /api/state` agrees.
    7. Unauthorized mutation and SSE requests get 401, including one with no Origin.
    8. Workspace `../x` gets 400 and an unknown workspace gets 422.
    9. Close SSE, open it again with `Last-Event-ID`, and get only newer events. An old boot id gets `state.reset`.
  - RED: written before C is merged it fails on the 401 steps, so it is written at the start of E against `main` with A–C merged, and run once with the token header removed to confirm it fails.
  - Verify: `npx vitest run server/e2e`.
- [ ] **E2. Compatibility pass, README, report.**
  - Run and record:
    - `npm test`;
    - the new security tests;
    - E1;
    - `npx tsc -b`;
    - `npm run build`;
    - `npm run server:build`, then `npm run server:start` with a curl smoke test;
    - `npm run check:secrets`;
    - `npm audit`.
  - Then `/vo`: a browser-mock regression of the 3D office, editor and mock approval.
  - Then `dev:full`: Live badge, approve, deny, cancel, and a server restart going Offline then Live. This uses the Chrome browser tools if available; otherwise I say so in the report.
  - Then the README: auth, the gate, and the link to the sandbox doc.
  - Write the final report, `docs/milestone-3b11-report.md`, in the 10-point format from plan.md, including the verdict. It states plainly that the **Claude Agent SDK is not installed** and **sandbox isolation is not implemented**.
  - Update this file's Status line. Open the PR.

## Questions for you

- **Q1: How the browser authenticates (the hard one; background above).**
  - My recommendation: **A, the same-origin Vite proxy** that injects the header. The browser never holds the token, `EventSource` keeps working, and `/vo` is untouched.
  - What the alternative costs: B (HttpOnly session cookie) is the right shape for a later VPS. It adds a manual pairing step after each token rotation and roughly two more tasks (session endpoint, Connect form, CORS credentials). We can add it in the VPS milestone on top of the same token.
- **Q2: What "starts the actual backend server" means for the E2E test.**
  - My recommendation: call the real `startServer()` in the test process on an ephemeral port, with real sockets, real HTTP and real SSE. Then smoke-test the built `server:start` bundle by hand in E2.
  - What the alternative costs: spawning `node dist-server/index.js` from the test also covers `index.ts` and the bundle. It needs a build before the test, which is slower and flakier on process cleanup, and it adds a process-spawning test file to the guard's review.
- **Q3: The mock approval demo when a task has no workspace.**
  - Decision 1 makes Write need a workspace, and the default config has no workspaces, so today's demo button would be denied.
  - My recommendation: with a workspace, the demo goes through the gate as a simulated Write (nothing written). Without one, it falls back to the simulated run's own approval (no tool request, summary "Simulated approval — nothing runs"), the same as the browser mock. The button keeps working in the default setup.
  - What the alternative costs:
    - Requiring a workspace for the demo is purer, but breaks the demo in the default `dev:full` setup until you configure `WORKSPACE_ROOT`.
    - Auto-creating a demo workspace under `DATA_DIR` would contradict "DATA_DIR must not be inside a workspace".

## Decisions

Not answered yet.
