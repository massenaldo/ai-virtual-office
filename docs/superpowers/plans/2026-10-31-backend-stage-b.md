# 3B.1 Stage B: Backend Service Core (Mock Runtime) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local backend in `server/` that owns agents, tasks and activity, runs tasks through runtime contract v2 (mock runtime only), saves to one JSON file, serves a REST API, and pushes typed events over SSE with replay after a reconnect. The frontend is not changed in this stage. It keeps running browser-only mock mode.

**Architecture:**
- `server/` is plain Node + TypeScript on `node:http`. It imports the pure modules in `src/workforce/` (types, operations, storage parse/serialize, demo, mock runtime), so browser and server share one data model.
- **One writer.** `WorkforceStore` holds the only in-memory `WorkforceState`. Every change, whether from an HTTP request, a runtime event or a timer, is one synchronous step: read `store.state`, apply a pure operation, then `store.commit(next)`. Each commit writes the file atomically and appends the derived events to the log in the same tick.
- **Events come from state diffs, not from call sites.** `deriveEvents(before, after)` turns every commit into typed events that carry the authoritative changed records. `EventLog` gives them ids, keeps the last 500, and replays them after `Last-Event-ID`.
- **`TaskManager` owns the lifecycle around a `ServerRuntimeProvider`:** starting, duplicate-start refusal, task timeout, approval timeout, cancel grace period with forced end, and output caps.
- The HTTP layer is thin: a ~100-line router, JSON body parsing, strict input parsing that reuses `validateAgentInput`/`validateTaskInput`, and an SSE handler. It has a documented guard hook for Stage C.
- **Build:** `tsc -b` type-checks the server through a new `tsconfig.server.json`. A Vite SSR build bundles it to `dist-server/index.js`, which has no runtime dependencies. In development, `tsx` runs it.

**Tech Stack:** Node 24 (`node:http`, `node:fs`, `node:util` `parseEnv`), TypeScript 5.7, Vite 6 SSR build, Vitest 5 in the Node environment, and `tsx` as the only new dev dependency. No runtime dependencies are added.

**Spec:** `plan.md` §2, §3, §4, §6 and §8, and `tasks.md` (decisions 1–11, the Stage B checklist, and the Q1–Q5 answers). This builds on the merged Stage A (#21, `4efd382`).

## Global Constraints

- **No Express or other framework, and no child processes.** `child_process`, `exec(`, `spawn(` and `fork(` must not appear in `server/` or `src/`; a guard test enforces this (Task 1). No Claude SDK (Q1). `RUNTIME=claude` uses an unavailable stub.
- **Dependencies:** only `tsx` (devDependency, Q4). `dist-server/index.js` imports nothing but `node:*` built-ins.
- **Imports are extensionless**, like the rest of `src/` (for example `from './operations'`), with `moduleResolution: "bundler"` and `verbatimModuleSyntax`. Type-only imports use `import type`. See Ruling 1.
- **Binding:** `HOST` defaults to `127.0.0.1` and `PORT` to `8787`. In Stage B the config **refuses** any non-loopback `HOST`, because origin checks don't exist until Stage C.
- **No CORS headers, origin checks, audit log or workspaces in this stage.** The seams are listed in "Deferred to Stage C/D".
- **Errors** are always JSON `{ "error": string }` with the status codes in the Task 5 endpoint table. Stack traces never appear in responses.
- **Every JSON response** sends `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **`src/` changes are kept to three, and only where needed:**
  - the structural `KV` type in `storage.ts` (Ruling 2);
  - an optional message parameter on `recoverInterruptedTasks` (Ruling 3);
  - a new `src/workforce/api.ts` that holds the wire contract shared with Stage D.
  - `api.ts` must pass the existing guard tests: no `fetch(`, `apiKey`, `ANTHROPIC_`, and no non-local `http(s)://` text.
- **Code style** follows `src/workforce/`: pure functions where possible, one-line types, and the same reference returned when nothing changed. The server's own modules take `now: () => string` and a `Logger` as injectable dependencies.
- **Server tests:** Vitest in Node. Integration tests start the server on port 0 with a temp `DATA_DIR` and use real `fetch` and a small SSE stream reader. Unit tests that depend on timing use fake timers (`vi.useFakeTimers()` with `advanceTimersByTimeAsync`). Keep `test.fsModuleCache: false` in `vite.config.ts`.
- **Copy (exact):**
  - server-restart recovery: `Interrupted by a server restart`;
  - approval timeout: `No approval decision within <n> s`;
  - task timeout: the existing `Timed out after <n> s`;
  - unavailable runtime: `The claude runtime is not available: Claude Agent SDK not installed.`;
  - truncated message marker: `\n[message truncated at <size>]`;
  - output-limit marker: `\n[output limit reached at <size>; later messages are dropped]`;
  - `<size>` uses `formatBytes`: `16 B`, `32 KB`, `256 KB`.

## Review Focus

1. **Two start requests in the same tick, or a runtime event arriving between assign and start.** Exactly one run starts and `provider.start` is called once. The second request gets 409 `Forge already has an active task.` (Task 4 test `two startTask calls in the same tick start one run`, Task 6 test `duplicate start is rejected`).
2. **A runtime that never confirms a cancel or never finishes, or late events after a forced end.** Cancel is forced to `cancelled` after `CANCEL_GRACE_MS`, and a timeout ends the task as `failed`/`timeout`. A later `completed` or `cancelled` from the provider changes nothing, and the AbortSignal is aborted (Task 4 tests `times out a run that never ends`, `cancel waits for confirmation, then forces after the grace period`).
3. **Reconnect with a `Last-Event-ID` that is too old, from a previous boot, ahead of the server, or garbage.** The server sends `state.reset` instead of a partial replay. A valid id replays exactly the newer events in order (Task 3 `EventLog` tests, Task 6 `replays after Last-Event-ID` / `sends state.reset ...`).
4. **A crash during a write, or a corrupt or newer-version data file.** The rename leaves either the old file or the new one, never a partial file. A corrupt file is backed up once and never overwritten on load. Demo agents are seeded only when no file exists (Task 2 store tests).
5. **Events and state disagree.** Folding the derived events onto the earlier state with `applyWorkforceEvent` must reproduce the later state exactly, including agent removal and activity trimming. `GET /api/state` plus the replayed events must equal the final `GET /api/state` (Task 3 `invariant` test, Task 6 `snapshot plus events stays consistent`).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `tsconfig.server.json` | Create | Type-checks `server/` (Node types, no DOM) |
| `tsconfig.json` | Modify | Add the `tsconfig.server.json` reference |
| `tsconfig.node.json` | Modify | Include `vite.server.config.ts`; `resolveJsonModule` (because `scripts/devFull.ts` reaches `server/`) |
| `vite.server.config.ts` | Create | SSR build of `server/index.ts` to `dist-server/index.js` |
| `package.json`, `package-lock.json` | Modify | `tsx` dev dependency; scripts `server`, `server:build`, `server:start`, `dev:full` |
| `.gitignore` | Modify | Add `data/` and `dist-server/` (`.env` already ignored) |
| `.env.example` | Create | Variable names only |
| `scripts/devFull.ts` | Create | Backend plus Vite dev server in one process (no child processes) |
| `server/index.ts` | Create | Entry: env file, config, start, signals |
| `server/config.ts` | Create | `parseConfig`, `mergeEnv`, `formatConfigErrors` |
| `server/log.ts` | Create | `Logger` type, console logger, silent logger for tests |
| `server/app.ts` | Create | `createApp` / `startServer`: wires store, events, provider, manager, routes |
| `server/http/router.ts` | Create | Routes, params, 404/405, `HttpError`, JSON replies, guard hook |
| `server/http/body.ts` | Create | `readJsonBody` with 64 KB limit, 415 and 400 |
| `server/http/inputs.ts` | Create | Strict body parsers for each endpoint |
| `server/http/routes.ts` | Create | REST and demo endpoints |
| `server/http/sse.ts` | Create | `GET /api/events`: replay, reset, heartbeat, cleanup |
| `server/store.ts` | Create | File-backed `WorkforceStore` (atomic write, backup, seed, recovery) |
| `server/deriveEvents.ts` | Create | `deriveEvents(before, after)` |
| `server/eventLog.ts` | Create | `EventLog` ring buffer, ids, `since`, subscribe |
| `server/limits.ts` | Create | `truncateUtf8`, `formatBytes`, markers |
| `server/runtime/types.ts` | Create | Runtime contract v2 (`ServerRuntimeProvider`) |
| `server/runtime/mockProvider.ts` | Create | `ServerMockProvider`: adapter around `MockRuntimeProvider` adding status and result |
| `server/runtime/claudeAgent.ts` | Create | `ClaudeAgentRuntimeProvider` stub, always unavailable (Stage C fills in its documentation) |
| `server/taskManager.ts` | Create | Lifecycle, timers, caps, duplicate guard |
| `server/test/helpers.ts` | Create | `startTestServer`, `api()` JSON helper, temp dirs |
| `server/test/sseClient.ts` | Create | `openEventStream` fetch-based SSE reader |
| `server/test/fakeProvider.ts` | Create | Scriptable `ServerRuntimeProvider` for manager tests |
| `src/workforce/api.ts` | Create | Wire types (events, `StateResponse`, request bodies) and `applyWorkforceEvent` |
| `src/workforce/storage.ts` | Modify | Structural `KV` type (Ruling 2) |
| `src/workforce/operations.ts` | Modify | `recoverInterruptedTasks(s, now, message = INTERRUPTED_MESSAGE)` (Ruling 3) |
| `tasks.md` | Modify | Tick the Stage B boxes (Task 7) |

Tests sit beside their modules: `server/config.test.ts`, `server/http/router.test.ts`, `server/noProcessExecution.test.ts`, `server/store.test.ts`, `server/deriveEvents.test.ts`, `server/eventLog.test.ts`, `src/workforce/api.test.ts`, `server/limits.test.ts`, `server/runtime/mockProvider.test.ts`, `server/runtime/claudeAgent.test.ts`, `server/taskManager.test.ts`, `server/http/routes.test.ts`, `server/http/sse.test.ts`, `server/lifecycle.test.ts`.

---

### Task 1: Tooling, config and HTTP skeleton

**Files:**
- Create: `tsconfig.server.json`, `vite.server.config.ts`, `.env.example`, `scripts/devFull.ts`, `server/index.ts`, `server/config.ts`, `server/log.ts`, `server/app.ts` (health only for now), `server/http/router.ts`, `server/http/body.ts`, `server/test/helpers.ts`
- Modify: `tsconfig.json`, `tsconfig.node.json`, `package.json`, `package-lock.json`, `.gitignore`
- Test: `server/config.test.ts`, `server/http/router.test.ts`, `server/noProcessExecution.test.ts`

**Interfaces:**
- **`tsconfig.server.json`:**
  - `compilerOptions`: `tsBuildInfoFile: ./node_modules/.tmp/tsconfig.server.tsbuildinfo`, `target: ES2023`, `lib: ["ES2023"]` (**no DOM**), `types: ["node"]`, `module: ESNext`, `moduleResolution: bundler`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `moduleDetection: force`, `resolveJsonModule`, `noEmit`, `skipLibCheck`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`;
  - `include: ["server"]`.
  - The `src/workforce/*` and `src/layout/*` files that the server imports are type-checked again under this config without DOM. That is how `tsc -b` proves they are Node-safe (Ruling 2 covers the one DOM type).
  - `tsconfig.json` references it as a third entry. `npm run build` (`tsc -b && vite build`) therefore type-checks the server, and the frontend bundle is unchanged.
- **Node-safety check, already verified against the code:**
  - The server's import graph is `types`, `operations`, `storage`, `demo`, `runtime/types`, `runtime/mockRuntime`, `layout/catalog`, `layout/operations`, `layout/geometry` and `layout/types`.
  - It never touches `window`, `document` or `localStorage`.
  - `createId` uses the global `crypto.randomUUID()`. That global exists in Node 24 and is declared by `@types/node` 22 (`crypto.d.ts`, `var crypto`), so no shim is needed.
  - The only DOM name is the `Storage` type in `storage.ts` (Ruling 2). `controller.ts` also uses it, but the server never imports `controller.ts`.
- **`vite.server.config.ts`:**
  ```ts
  export default defineConfig({
    publicDir: false,
    ssr: { target: 'node', noExternal: true },
    build: { ssr: 'server/index.ts', outDir: 'dist-server', emptyOutDir: true, target: 'node22', minify: false, sourcemap: true,
      rollupOptions: { output: { format: 'es', entryFileNames: 'index.js' } } },
  })
  ```
  - `node:*` built-ins stay external automatically. Everything else (only our own `src/` code) is bundled.
  - The output is ESM, which `"type": "module"` makes Node load as such.
  - `tsconfig.node.json` adds it to `include`, plus `resolveJsonModule: true`.
- **Scripts:**
  ```json
  "server": "tsx server/index.ts",
  "server:build": "vite build --config vite.server.config.ts",
  "server:start": "node dist-server/index.js",
  "dev:full": "tsx watch --clear-screen=false scripts/devFull.ts"
  ```
  - `dev`, `build`, `preview` and `test` are unchanged, so `/vo` (`scripts/vo.sh`, `npm run dev`) stays frontend-only (Q3).
  - `server` runs without watch, so restarts are predictable for verification. `dev:full` watches.
- **`scripts/devFull.ts`:**
  1. Read the config the same way as `server/index.ts`, then `await startServer(config)`.
  2. Set `process.env.VITE_WORKFORCE_API_URL ??= \`http://${config.host}:${port}\``.
  3. Run `createServer({ configFile: 'vite.config.ts' })` from `vite`, then `listen()` and `printUrls()`.
  - On `SIGINT`/`SIGTERM` it closes both.
  - If Vite fails (for example `strictPort` on 5173), it closes the backend and exits 1 with `Port 5173 is in use (is npm run dev or /vo already running?).`
  - It is one process, so it needs no `concurrently` and no `child_process`, and works on any OS. `tsx watch` restarts it when `scripts/`, `server/` or the `src/workforce` files it imports change.
  - The UI ignores `VITE_WORKFORCE_API_URL` until Stage D.
- **`server/config.ts`:**
  ```ts
  export type RuntimeKind = 'mock' | 'claude'
  export type ServerConfig = { host: string; port: number; dataDir: string; runtime: RuntimeKind; taskTimeoutMs: number; cancelGraceMs: number; approvalTimeoutMs: number; maxMessageBytes: number; maxTaskOutputBytes: number; eventBufferSize: number; credentialsConfigured: boolean }
  export type Env = Record<string, string | undefined>
  export function parseConfig(env: Env, cwd?: string): { ok: true; config: ServerConfig } | { ok: false; errors: string[] }
  export function mergeEnv(fileText: string | null, env: Env): Env      // util.parseEnv(fileText); the real environment wins
  export function formatConfigErrors(errors: string[]): string        // 'Server config is invalid:\n- …\n- …'
  ```

  | Variable | Default | Rule and error copy |
  |---|---|---|
  | `HOST` | `127.0.0.1` | Must be `127.0.0.1`, `::1` or `localhost`: `HOST must be a loopback address (127.0.0.1, ::1 or localhost) until origin checks are added (got "0.0.0.0").` |
  | `PORT` | `8787` | Integer 0–65535 (0 = random, used by tests): `PORT must be an integer from 0 to 65535 (got "abc").` |
  | `DATA_DIR` | `data` | Resolved against `cwd` with `path.resolve` |
  | `RUNTIME` | `mock` | `RUNTIME must be "mock" or "claude" (got "gpt").` |
  | `TASK_TIMEOUT_MS` | `600000` | Positive integer: `TASK_TIMEOUT_MS must be a positive integer (got "0").` (same form for the other numeric variables below) |
  | `CANCEL_GRACE_MS` | `5000` | Positive integer |
  | `APPROVAL_TIMEOUT_MS` | `300000` | Positive integer |
  | `MAX_MESSAGE_BYTES` | `32768` | Positive integer; must be ≤ `MAX_TASK_OUTPUT_BYTES`: `MAX_MESSAGE_BYTES must not exceed MAX_TASK_OUTPUT_BYTES.` |
  | `MAX_TASK_OUTPUT_BYTES` | `262144` | Positive integer |
  | `EVENT_BUFFER_SIZE` | `500` | Positive integer |
  | `ANTHROPIC_API_KEY` | unset | Only `credentialsConfigured = value.trim() !== ''` is kept. The value is never stored in the config. |

  - An empty string counts as unset, so a copied `.env.example` gives the defaults.
  - All errors are collected, not just the first.
  - The heartbeat (15 s) and the body limit (64 KB) are constants (`HEARTBEAT_MS`, `MAX_BODY_BYTES`), not variables. Tests inject `heartbeatMs`.
- **`.env.example`** lists, with empty values and a one-line comment each: `HOST`, `PORT`, `DATA_DIR`, `RUNTIME`, `TASK_TIMEOUT_MS`, `CANCEL_GRACE_MS`, `APPROVAL_TIMEOUT_MS`, `MAX_MESSAGE_BYTES`, `MAX_TASK_OUTPUT_BYTES`, `EVENT_BUFFER_SIZE`, `ANTHROPIC_API_KEY` (read by the server only; not used until the Claude provider exists) and `VITE_WORKFORCE_API_URL` (frontend; used from Stage D).
- **`.gitignore`** adds `data/` and `dist-server/`.
- **`server/index.ts`:**
  - reads `.env` from the cwd if it exists (`readFileSync`, with `null` on `ENOENT`);
  - runs `parseConfig(mergeEnv(text, process.env))`;
  - on errors, prints `formatConfigErrors` to stderr and calls `process.exit(1)`;
  - otherwise runs `startServer(config)` and logs `AI Virtual Office backend listening on http://127.0.0.1:8787 (runtime: mock)`;
  - `SIGINT`/`SIGTERM` → `close()` → `process.exit(0)`.
- **`server/log.ts`:**
  ```ts
  export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void }
  export const consoleLogger: Logger; export const silentLogger: Logger
  ```
- **`server/http/router.ts`:**
  ```ts
  export class HttpError extends Error { constructor(readonly status: number, message: string) }
  export type Reply = { status: number; body: unknown; headers?: Record<string, string> } | { handled: true }   // handled: the handler wrote the response itself (SSE)
  export type RequestContext = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body: unknown }
  export type Route = { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; body?: 'json' | 'none'; handler: (ctx: RequestContext) => Reply | Promise<Reply> }   // path like '/api/agents/:id/desk'
  /** Stage C hook: runs before routing; a Reply short-circuits (origin allowlist, JSON-only). */
  export type Guard = (req: IncomingMessage, url: URL) => Reply | null
  export type RouterOptions = { routes: Route[]; guards?: Guard[]; responseHeaders?: (req: IncomingMessage) => Record<string, string>; log: Logger }
  export function createRouter(opts: RouterOptions): (req: IncomingMessage, res: ServerResponse) => void
  export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void
  ```
  - A path that matches with the wrong method → 405 `Method not allowed.` with an `Allow` header.
  - No match → 404 `Not found.`
  - `HttpError` → its status and message.
  - Anything else → 500 `Internal server error.`, logged with `log.error`.
  - Path params are `decodeURIComponent`d. A malformed escape → 400 `Invalid URL.`
- **`server/http/body.ts`:**
  ```ts
  export const MAX_BODY_BYTES = 65536
  export function readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>>
  ```
  - A `Content-Type` that isn't `application/json` (parameters such as `charset` allowed) → 415 `Content-Type must be application/json.`
  - A body over the limit → 413 `Request body is too large (limit 64 KB).` It stops reading and responds without waiting for the rest.
  - Bad JSON → 400 `Request body is not valid JSON.`
  - A non-object → 400 `Request body must be a JSON object.`
  - An empty body → `{}`.
  - A route with `body: 'none'` (or a GET/DELETE) never reads the body.
- **`server/app.ts`, initial version:**
  ```ts
  export type AppDeps = { now?: () => string; log?: Logger; guards?: Guard[]; responseHeaders?: (req: IncomingMessage) => Record<string, string> }   // grows in Tasks 4–6
  export type RunningServer = { url: string; port: number; close(): Promise<void> }
  export function startServer(config: ServerConfig, deps?: AppDeps): Promise<RunningServer>
  ```
  - It serves only `GET /api/health` → `{ ok: true, version, runtime, available, reason, credentialsConfigured }`.
  - `version` comes from `import pkg from '../package.json' with { type: 'json' }`. If tsx rejects the import attribute, fall back to a `SERVER_VERSION` constant and note it in the PR.
  - In Task 1 `available`/`reason` come from `config.runtime`: mock is available, and claude gives `Claude Agent SDK not installed`.
- **`server/test/helpers.ts`:**
  ```ts
  export function tempDataDir(): string                          // mkdtempSync(join(tmpdir(), 'vo-server-'))
  export function testConfig(env?: Env): ServerConfig            // parseConfig({ PORT: '0', DATA_DIR: tempDataDir(), ...env }) or throw
  export type TestServer = RunningServer & { dataDir: string; api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: any }> }
  export function startTestServer(env?: Env, deps?: AppDeps): Promise<TestServer>   // closes and rm -rf's in an afterEach registered by the caller
  ```

- [ ] **Step 1: Install the dev tool and wire the configs.** Run `npm install -D tsx`. Add `tsconfig.server.json`, the reference in `tsconfig.json`, the `tsconfig.node.json` changes, `vite.server.config.ts`, the scripts, `.gitignore` and `.env.example`. These are configuration only, so there is no test for this step.
- [ ] **Step 2: Write the failing tests.**
  - `server/config.test.ts`:
    - `uses the defaults for an empty environment`: `parseConfig({}, '/repo')` equals `{ ok: true, config: { host: '127.0.0.1', port: 8787, dataDir: '/repo/data', runtime: 'mock', taskTimeoutMs: 600000, cancelGraceMs: 5000, approvalTimeoutMs: 300000, maxMessageBytes: 32768, maxTaskOutputBytes: 262144, eventBufferSize: 500, credentialsConfigured: false } }`;
    - `treats empty strings as unset`: every variable `''` gives the same config;
    - `reads every variable`: values such as `PORT: '9000'`, `RUNTIME: 'claude'`, `DATA_DIR: 'tmp/x'` → `/repo/tmp/x`;
    - `collects every error with readable copy`: `{ PORT: 'abc', RUNTIME: 'gpt', TASK_TIMEOUT_MS: '0' }` gives exactly the three messages from the table, in variable order;
    - `refuses a non-loopback HOST`: `0.0.0.0` gives the HOST message; `localhost` and `::1` are accepted;
    - `rejects a message cap larger than the task cap`;
    - `keeps only a flag for the API key`: `{ ANTHROPIC_API_KEY: 'sk-test-123' }` gives `credentialsConfigured: true`, and `JSON.stringify(result)` does not contain `sk-test-123`;
    - `mergeEnv lets the real environment win`: `mergeEnv('PORT=9000\nHOST=localhost', { PORT: '8000' })` gives `PORT: '8000'` and `HOST: 'localhost'`; `mergeEnv(null, env)` returns a copy of `env`;
    - `formatConfigErrors` gives `'Server config is invalid:\n- A\n- B'`.
  - `server/http/router.test.ts`. Each case runs a real `http.createServer(createRouter(...))` on `127.0.0.1:0` with test routes:
    - an echo route `POST /echo` with `body: 'json'`;
    - `GET /items/:id`, which returns its params;
    - a route that throws `new Error('secret stack')`.
    - Cases:
      - `matches params`: `GET /items/a%20b` returns `{ id: 'a b' }`;
      - `404 for an unknown path`: `{ error: 'Not found.' }`, with `content-type` starting `application/json`, `cache-control: no-store` and `x-content-type-options: nosniff`;
      - `405 with Allow for a known path`: `DELETE /items/1` gives 405, `allow: GET` and `Method not allowed.`;
      - `415 without a JSON content type` (`text/plain`);
      - `413 for a body over 64 KB`, with the exact message;
      - `400 for invalid JSON` and `400 for a JSON array`, with the exact messages;
      - `echoes a valid JSON object`;
      - `500 hides the error`: the body is exactly `{ error: 'Internal server error.' }`, and the response text doesn't contain `secret stack`;
      - `a guard short-circuits every route`: a guard returning `{ status: 403, body: { error: 'Blocked.' } }` gives 403 on `GET /items/1`;
      - `responseHeaders are added to every reply`.
  - `server/app.test.ts` (one small file, extended in Task 5):
    - `GET /api/health reports the mock runtime`: 200, matching `{ ok: true, runtime: 'mock', available: true, reason: null, credentialsConfigured: false, version: '0.1.0' }`;
    - `binds 127.0.0.1 by default`: `startServer(testConfig())` gives a URL starting `http://127.0.0.1:`.
  - `server/noProcessExecution.test.ts`:
    - uses `/// <reference types="vite/client" />` and `import.meta.glob<string>(['./**/*.ts', '../src/**/*.{ts,tsx}', '../scripts/*.ts', '!./**/*.test.ts', '!../src/**/*.test.{ts,tsx}', '!../scripts/*.test.ts'], { query: '?raw', import: 'default', eager: true })`;
    - forbidden patterns: `/child_process/`, `/(?<![.\w])exec(Sync|File|FileSync)?\(/`, `/(?<![.\w])spawn(Sync)?\(/`, `/(?<![.\w])fork\(/`, `/worker_threads/`;
    - asserts the glob contains `./index.ts`, `../src/workforce/operations.ts` and `../scripts/devFull.ts`, and that the offenders list equals `[]`;
    - the negative lookbehind allows `re.exec(` and `.spawn` on other objects.
- [ ] **Step 3: Run them and confirm they fail.** Run `npx vitest run server`. Expected: FAIL (modules not found).
- [ ] **Step 4: Implement** `config.ts`, `log.ts`, `router.ts`, `body.ts`, the initial `app.ts`, `index.ts`, `scripts/devFull.ts` and `server/test/helpers.ts` to the signatures above.
- [ ] **Step 5: Run them and confirm they pass**, then check the build pipeline:
  - `npx vitest run server` → PASS.
  - `npx tsc -b` → no errors.
  - `npm run server:build && grep -Eo 'from "[^"]+"' dist-server/index.js | sort -u` → only `node:*` specifiers.
  - `PORT=8790 npm run server:start` → the banner line appears; `curl -s http://127.0.0.1:8790/api/health` → `{"ok":true,...}`. Stop it with Ctrl+C.
  - `PORT=abc npm run server` → `Server config is invalid:` and exit code 1.
- [ ] **Step 6: Commit** with `feat(server): add backend skeleton with typed config, router and build scripts`

---

### Task 2: File-backed workforce store

**Files:**
- Create: `server/store.ts`
- Modify: `src/workforce/storage.ts` (Ruling 2), `src/workforce/operations.ts` (Ruling 3)
- Test: `server/store.test.ts`, `src/workforce/operations.test.ts` (one added test)

**Interfaces:**
- Consumes: `parseWorkforce`, `serializeWorkforce` (`src/workforce/storage`), `createDemoWorkforce` (`demo`), `recoverInterruptedTasks`, `emptyWorkforce` (`operations`), `WORKFORCE_SCHEMA_VERSION`.
- Produces:
  ```ts
  export const WORKFORCE_FILE = 'workforce.json'
  export const WORKFORCE_BACKUP_FILE = 'workforce.backup.json'
  export const SERVER_RESTART_MESSAGE = 'Interrupted by a server restart'
  export type StoreLoad = { seeded: boolean; recovered: boolean; problem: 'corrupt' | 'unsupported-version' | null; preserved: 'backup-created' | 'backup-exists' | null }
  export type StoreOptions = { dataDir: string; now: () => string; log: Logger; onCommit?: (before: WorkforceState, after: WorkforceState) => void; writeFile?: (path: string, text: string) => void }   // writeFile: test seam, default writeFileAtomic
  export type WorkforceStore = { readonly state: WorkforceState; readonly load: StoreLoad; readonly saveError: string | null; readonly filePath: string; commit(next: WorkforceState): boolean }
  export function openWorkforceStore(opts: StoreOptions): WorkforceStore
  export function writeFileAtomic(path: string, text: string): void   // open tmp `${path}.tmp-${process.pid}` (mode 0o600) → write → fsync → close → rename
  ```
- `operations.ts`: `export function recoverInterruptedTasks(s: WorkforceState, now: string, message: string = INTERRUPTED_MESSAGE): WorkforceState`. Browser callers are unchanged.
- **Load rules for `openWorkforceStore`:**
  1. `mkdirSync(dataDir, { recursive: true })`.
  2. If the file is missing (`ENOENT`), use the demo seed, `seeded: true`, and **write it immediately**. The file then marks "first start done", so deleting every agent never reseeds.
  3. Any other read error (`EACCES`, `EISDIR`, …) throws `Couldn't read <path>: <code>`. `index.ts` prints it and exits 1.
  4. If the file parses, run `recoverInterruptedTasks(state, now(), SERVER_RESTART_MESSAGE)`. If that changed the state, set `recovered: true` and write.
  5. If it doesn't parse, start from `emptyWorkforce()`, with `problem` set to `'unsupported-version'` when `schemaVersion` is a number above 2, otherwise `'corrupt'`. The backup works like the browser's:
     - no backup yet → copy the file to `workforce.backup.json` and report `backup-created`;
     - an identical backup → `backup-created`;
     - a different backup → `backup-exists`.
     - The data file is **not written on load**; the first commit replaces it.
     - The log names both paths: `Workforce data in <file> couldn't be read (corrupt). It was backed up to <backup>. Starting with no agents.`, and for `backup-exists`: `… An earlier backup already exists at <backup>, so this file was not backed up and the next change replaces it.`
- **Commit rules:**
  - The same reference → `false`, with no write and no `onCommit`.
  - Otherwise: replace `state`, write `serializeWorkforce(next)` synchronously, set `saveError` (the error's message, or `null` on success), call `onCommit(before, after)`, and return `true`.
  - A failed write never throws to the caller. It is logged once for each distinct message.
- **Write strategy (decided):** a synchronous atomic write on every commit, with no debounce.
  - This gives a total order with the state, no flush or close semantics, and deterministic tests (fake timers don't touch synchronous fs).
  - A mock run commits about 8 times, and the file is at most about 150 KB (300 activities).
  - If streaming Claude output later makes this too frequent, coalescing can replace it behind the same `commit()` API. This is noted as a limit.
- **One writer, serialised by design.**
  - Node runs JavaScript on one thread.
  - Each change is read-op-commit with no `await` in between.
  - The only awaits in a request path (reading the body, `provider.start`) happen before the read or after the commit, and the code re-reads `store.state` after every await.

- [ ] **Step 1: Write the failing tests.**
  - In `server/store.test.ts`, with `NOW = '2026-10-31T09:00:00.000Z'`, `now = () => NOW`, a fresh temp dir and `silentLogger`:
    - `seeds the demo agents on first start and writes the file`: `load.seeded === true`; the agent ids equal `DEMO_AGENTS.map((a) => a.id)`; `parseWorkforce(JSON.parse(readFileSync(file)))` equals `store.state`;
    - `does not seed again when the file exists, even with no agents`: write `serializeWorkforce(emptyWorkforce())` → `seeded: false`, `agents: []`;
    - `creates a missing nested DATA_DIR`;
    - `commit writes atomically and leaves no temp file`: after `commit(createAgent(...).state)`, `readdirSync(dir)` equals `['workforce.json']`, the file contains the new agent, and its mode `& 0o777` is `0o600`;
    - `commit of the same reference does nothing`: returns `false`; a `writeFile` spy and an `onCommit` spy are not called;
    - `calls onCommit synchronously with before and after`;
    - `recovers interrupted tasks on load with the server message`: a file with a running task → the task is `failed` with `errorMessage: 'Interrupted by a server restart'` and `endedReason: 'failed'`; `load.recovered === true`; the file on disk shows the failed task;
    - `backs up a corrupt file once and starts empty` (Review Focus 4):
      - `'{not json'` → `problem: 'corrupt'`, `preserved: 'backup-created'`, the backup equals `'{not json'`, no agents, and `workforce.json` is still `'{not json'`;
      - reopening → `backup-created` again;
      - other corrupt text → `backup-exists`, with the backup unchanged;
    - `reports a newer schema as unsupported-version`: `{ schemaVersion: 3, agents: [], tasks: [], activities: [] }`;
    - `keeps working in memory when a write fails`: `writeFile` throws `new Error('disk full')` → `commit` returns `true`, `state` is the new state and `saveError === 'disk full'`; switching to a working writer and committing again → `saveError === null`;
    - `refuses to start when the file can't be read`: `workforce.json` is a directory → it throws with a message matching `/^Couldn't read .*workforce\.json: EISDIR/`.
  - `operations.test.ts`: `recoverInterruptedTasks uses a given message`: a running task becomes failed with `'Interrupted by a server restart'`, and the default stays `INTERRUPTED_MESSAGE`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/store.test.ts src/workforce/operations.test.ts`. Expected: FAIL (module missing; the message parameter is ignored).
- [ ] **Step 3: Implement** `server/store.ts`, the `recoverInterruptedTasks` parameter, and the structural `KV` type in `storage.ts` (`type KV = { getItem(key: string): string | null; setItem(key: string, value: string): void }`).
- [ ] **Step 4: Run them and confirm they pass.** Run `npx vitest run server src/workforce && npx tsc -b`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** with `feat(server): add atomic JSON file store for workforce state`

---

### Task 3: Event contract, derivation and replay log

**Files:**
- Create: `src/workforce/api.ts`, `server/deriveEvents.ts`, `server/eventLog.ts`
- Test: `src/workforce/api.test.ts`, `server/deriveEvents.test.ts`, `server/eventLog.test.ts`

**Interfaces:**
- **Produces (`src/workforce/api.ts`, shared with Stage D, pure and with no I/O):**
  ```ts
  export type WorkforceEventType = 'task.queued' | 'task.started' | 'agent.status_changed' | 'agent.message' | 'task.progress' | 'task.waiting_for_approval' | 'task.completed' | 'task.failed' | 'task.cancelled' | 'state.changed' | 'state.reset'
  /** The authoritative records an event carries: upsert agents and tasks by id, append activities (then keep the newest ACTIVITY_LIMIT), drop removed agents with their tasks and activities. */
  export type WorkforcePatch = { agents: Agent[]; tasks: AgentTask[]; activities: AgentActivity[]; removedAgentIds: string[] }
  export type ChangeEvent = { id: string; type: Exclude<WorkforceEventType, 'state.reset'>; at: string; agentId: string | null; taskId: string | null; patch: WorkforcePatch; from?: AgentStatus; to?: AgentStatus }   // from/to only on agent.status_changed
  export type ResetEvent = { id: string; type: 'state.reset'; at: string; reason: 'gap' }
  export type WorkforceEvent = ChangeEvent | ResetEvent
  export type StateResponse = { state: WorkforceState; lastEventId: string; loadProblem: 'corrupt' | 'unsupported-version' | null; preserved: 'backup-created' | 'backup-exists' | null; saveError: string | null }
  export type ErrorResponse = { error: string }
  export function parseEventId(id: string): { boot: string; seq: number } | null   // '<boot>:<seq>'
  /** Applies one change event's patch; state.reset returns the same state (the client reloads the snapshot). */
  export function applyWorkforceEvent(s: WorkforceState, e: WorkforceEvent): WorkforceState
  ```
  The request body types (`CreateAgentBody`, `PatchAgentBody`, `DeskBody`, `CreateTaskBody`, `ApprovalBody`) are also defined here so Stage D can import them. Task 5 parses them.
- **Event ids (decided):** `<bootId>:<seq>`.
  - `bootId` is the server start time in base36 (`Date.now().toString(36)`, injectable).
  - `seq` starts at 1 and rises with every event.
  - Before any event, `lastEventId` is `<bootId>:0`.
  - This keeps decision 6's monotonically increasing ids within a boot, and makes ids from a previous boot recognisable (Ruling 6).
- **Produces (`server/deriveEvents.ts`):**
  ```ts
  export type EventDraft = Omit<ChangeEvent, 'id' | 'at'>
  export function deriveEvents(before: WorkforceState, after: WorkforceState): EventDraft[]   // [] when before === after
  ```
- **Derivation, decided: diff the states rather than emit at each call site.**
  - Every path changes state through `store.commit`: HTTP operations, runtime events, timers, agent removal, demo restore. Deriving from the diff means no call site can forget an event, and an event can never disagree with the persisted state.
  - It is pure and directly testable.
  - It costs O(agents + tasks + activities) per commit, which is small (activities are capped at 300).
- **Derivation order inside one commit:**
  1. **Removed agents** (in `before`, missing from `after`) → one `state.changed` with `removedAgentIds`.
  2. **New activities** (ids not in `before.activities`), in order → one typed event each. Its patch carries that activity plus the `after` version of its agent and task (if they exist). The mapping:

     | Activity | Event |
     |---|---|
     | `task-assigned` | `task.queued` |
     | `task-started` | `task.started` |
     | `task-progress` | `task.progress` |
     | `agent-message` | `agent.message` |
     | `task-approval-requested` | `task.waiting_for_approval` |
     | `task-completed` | `task.completed` |
     | `task-failed`, `task-timed-out` | `task.failed` (`endedReason` in the patch tells timeout apart) |
     | `task-cancelled` | `task.cancelled` |
     | `agent-created`, `agent-updated`, `desk-assigned`, `desk-unassigned`, `task-approval-decided`, `task-cancelling` | `state.changed` |

  3. **Agents whose `status` changed** → `agent.status_changed` with `from`/`to` and the agent in the patch.
  4. **Residual:** any changed or new agent or task not already carried at its `after` value by an earlier event → one final `state.changed`. For example, `markStarting` changes the task to `starting` without logging an activity.
  - Because every carried record is its final value, folding the events in order onto `before` gives `after` (Review Focus 5).
- **Produces (`server/eventLog.ts`):**
  ```ts
  export type EventLogOptions = { capacity: number; now: () => string; bootId?: string }
  export class EventLog {
    constructor(opts: EventLogOptions)
    readonly bootId: string
    get lastEventId(): string
    append(drafts: EventDraft[]): ChangeEvent[]                 // stamps id and at, buffers (dropping the oldest past capacity), notifies
    since(lastEventId: string | null): { kind: 'replay'; events: ChangeEvent[] } | { kind: 'reset' }
    subscribe(listener: (e: ChangeEvent) => void): () => void   // a throwing listener is logged and doesn't stop the others
    listenerCount(): number
  }
  ```
- **`since` rules:**
  - `null` → replay `[]` (live only).
  - An unparsable id, a different boot, a `seq` above the current one, or `seq < oldestBufferedSeq - 1` → `reset`.
  - Otherwise → replay every buffered event with a higher `seq`.
  - `state.reset` is not stored in the buffer. The SSE handler builds it with `id = lastEventId` (Task 6).
- **Wiring (done in Task 5):** `openWorkforceStore({ onCommit: (b, a) => log.append(deriveEvents(b, a)) })`. Because the commit and the append happen in one synchronous call, any `store.state` read together with `log.lastEventId` in the same tick is consistent.

- [ ] **Step 1: Write the failing tests.**
  - `src/workforce/api.test.ts`:
    - `parseEventId reads boot and seq`: `'k3x9:42'` gives `{ boot: 'k3x9', seq: 42 }`; `'x'`, `'a:-1'` and `'a:1.5'` give `null`;
    - `applyWorkforceEvent upserts, appends and removes`: a patch with an updated agent replaces it by id, a new task is appended, an activity is appended, and `removedAgentIds` drops that agent, its tasks and its activities;
    - `keeps the newest ACTIVITY_LIMIT activities`;
    - `state.reset returns the same state` (`toBe`).
  - `server/deriveEvents.test.ts` (using `createDemoWorkforce(NOW)` and the pure operations):
    - `same reference yields no events`;
    - `createAgent yields one state.changed carrying the agent and its activity`;
    - `assignTask then markStarting`:
      - `assignTask` gives `task.queued` with `taskId` and the queued task in its patch;
      - `markStarting` gives `agent.status_changed` (`from: 'idle'`, `to: 'thinking'`), then a `state.changed` whose `patch.tasks[0].status` is `'starting'`;
    - `started and progress`: `started` gives `task.started` (the patch task is `running` with an `executionId`), with no status change since thinking → thinking; `progress` working gives `task.progress`, then `agent.status_changed` thinking → working;
    - `approval requested and decided`: `task.waiting_for_approval` with `patch.tasks[0].pendingApproval.tool === 'Write'` and the status changed to waiting; the decision gives `state.changed` and the status changed to working;
    - `timeOutTask yields task.failed with endedReason timeout`;
    - `removeAgent yields one state.changed with removedAgentIds`;
    - `invariant: folding derived events onto before gives after` (Review Focus 5):
      - script at least 15 steps covering every operation above, plus `requestCancel`/`cancelled`, `assignDesk`, `updateAgent`, `restoreDemoAgents`, and 305 `message` events, so activities trim past `ACTIVITY_LIMIT`;
      - after every step, assert `deriveEvents(b, a).map(stamp).reduce(applyWorkforceEvent, b)` `toEqual(a)`, where `stamp` adds a dummy `id`/`at`.
  - `server/eventLog.test.ts`, with `bootId: 'boot'`:
    - `starts at boot:0`;
    - `stamps increasing ids and at`: 3 drafts give `boot:1`, `boot:2`, `boot:3`, and `at === NOW`;
    - `since(null) replays nothing`;
    - `since(boot:2) after 5 events replays 3, 4, 5`;
    - `since(lastEventId) replays nothing`;
    - `drops the oldest past capacity`: with capacity 3 and 5 events, `since('boot:2')` replays `[3, 4, 5]` and `since('boot:1')` gives `reset`;
    - `resets for another boot, an id ahead, or garbage`: `'other:1'`, `'boot:9'` and `'nonsense'`;
    - `notifies subscribers in order and stops after unsubscribe`;
    - `a throwing listener doesn't stop the others`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/deriveEvents.test.ts server/eventLog.test.ts src/workforce/api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules to the signatures and rules above.
- [ ] **Step 4: Run them and confirm they pass.** Then run `npx vitest run src/workforce`, so the existing guard tests in `claudeRuntime.test.ts` and `src/scene/noRemoteAssets.test.ts` also pass with `api.ts` present.
- [ ] **Step 5: Commit** with `feat(server): add typed workforce events with a replay log`

---

### Task 4: Runtime contract v2, providers and task manager

**Files:**
- Create: `server/runtime/types.ts`, `server/runtime/mockProvider.ts`, `server/runtime/claudeAgent.ts`, `server/limits.ts`, `server/taskManager.ts`, `server/test/fakeProvider.ts`
- Test: `server/runtime/mockProvider.test.ts`, `server/runtime/claudeAgent.test.ts`, `server/limits.test.ts`, `server/taskManager.test.ts`

**Interfaces:**
- **Produces (`server/runtime/types.ts`).** The contract v2 types live server-side, so `src/workforce/runtime/types.ts` is not changed. They reuse its `RuntimeEvent` and `RuntimeAvailability`.
  ```ts
  export type StartContext = { agent: Agent; signal: AbortSignal }   // Stage C adds workspace and tool policy here
  export type StartOutcome = { ok: true; executionId: string; sessionId: string | null } | { ok: false; error: string }
  export type ExecutionStatus = { state: 'unknown' } | { state: 'running'; executionId: string; sessionId: string | null; pendingApprovalId: string | null } | { state: 'ended'; executionId: string; outcome: 'completed' | 'failed' | 'cancelled' }
  export type ExecutionResult = { outcome: 'completed'; summary: string } | { outcome: 'failed'; error: string } | { outcome: 'cancelled' }
  export interface ServerRuntimeProvider {
    readonly kind: TaskRuntime                       // 'mock' | 'claude'
    readonly availability: RuntimeAvailability
    start(task: AgentTask, ctx: StartContext): Promise<StartOutcome>
    cancel(taskId: string): void
    status(taskId: string): ExecutionStatus
    result(taskId: string): ExecutionResult | null   // null until ended
    respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): void
    subscribe(listener: (event: RuntimeEvent) => void): () => void
    dispose(): Promise<void>
  }
  export type DemoProvider = ServerRuntimeProvider & MockDemoControls
  export const sourceFor = (kind: TaskRuntime): ActivitySource => (kind === 'claude' ? 'real' : 'mock')
  ```
  - `start` is async, as a real SDK session start will be.
  - The task's `executionId`/`sessionId` still come only from the `started` event through `applyRuntimeEvent`, as today. `StartOutcome` feeds the manager's run record and the logs.
- **`ServerMockProvider`** (`mockProvider.ts`) implements `DemoProvider`:
  - `constructor(opts?: { timings?: typeof MOCK_TIMINGS })`.
  - It **wraps** a `MockRuntimeProvider` without changing it: it subscribes to the inner provider's events to keep a per-task record (`executionId`, pending approval, outcome, summary or error) and re-emits them.
  - `start` returns `Promise.resolve` of the inner result with `sessionId: null`.
  - `status`/`result` read the record. Ended records are kept for the last 200 tasks.
  - `requestApproval`/`forceError` delegate to the inner provider. `dispose` disposes it.
- **`ClaudeAgentRuntimeProvider`** (`claudeAgent.ts`):
  - `kind: 'claude'`, `availability: { available: false, reason: 'Claude Agent SDK not installed' }`;
  - `start` resolves `{ ok: false, error: <reason> }`; `status` gives `unknown`; `result` gives `null`; the rest are no-ops.
  - Stage C adds the documentation block and the credentials reason.
- **Produces (`server/limits.ts`):**
  ```ts
  export function formatBytes(n: number): string                                   // <1024 → `${n} B`, else `${Math.round(n / 1024)} KB`
  export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean }   // never splits a code point
  export const messageTruncatedMarker = (limit: number) => `\n[message truncated at ${formatBytes(limit)}]`
  export const outputLimitMarker = (limit: number) => `\n[output limit reached at ${formatBytes(limit)}; later messages are dropped]`
  ```
- **Produces (`server/taskManager.ts`):**
  ```ts
  export type ManagerError = { ok: false; code: 'not_found' | 'invalid' | 'conflict' | 'unavailable'; error: string }
  export type ManagerResult<T = {}> = ({ ok: true } & T) | ManagerError
  export type LifecycleAction = 'task.start' | 'task.cancel' | 'task.force_cancelled' | 'task.timeout' | 'approval.decided' | 'approval.timeout'
  export type TaskManagerOptions = { store: WorkforceStore; provider: ServerRuntimeProvider; config: Pick<ServerConfig, 'taskTimeoutMs' | 'cancelGraceMs' | 'approvalTimeoutMs' | 'maxMessageBytes' | 'maxTaskOutputBytes'>; now: () => string; log: Logger; onLifecycle?: (e: { action: LifecycleAction; taskId: string; agentId: string; detail?: string }) => void }   // onLifecycle: Stage C audit seam
  export const APPROVAL_TIMEOUT_MESSAGE = (ms: number) => `No approval decision within ${Math.round(ms / 1000)} s`
  export const unavailableMessage = (kind: TaskRuntime, reason: string) => `The ${kind} runtime is not available: ${reason}.`
  export class TaskManager {
    constructor(opts: TaskManagerOptions)
    startTask(agentId: string, input: TaskInput): ManagerResult<{ task: AgentTask }>          // sync; the provider start continues in the background
    cancelTask(taskId: string): ManagerResult<{ task: AgentTask }>
    decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision): ManagerResult<{ task: AgentTask }>
    removeAgent(agentId: string): ManagerResult<{ cancelledTaskId: string | null }>
    requestApproval(taskId: string): ManagerResult      // demo; 'unavailable' if the provider has no demo controls
    forceError(taskId: string): ManagerResult           // demo
    dispose(): Promise<void>                            // clears timers, aborts runs, unsubscribes, disposes the provider; state untouched
  }
  ```
- **Lifecycle rules** (`source = sourceFor(provider.kind)`, `now()` per step, `store.state` re-read after every await):
  - **`startTask` checks, in order:**
    1. provider unavailable → `unavailable` with `unavailableMessage(kind, reason)`, and **no task is created** (Ruling 9);
    2. no agent → `not_found` `Agent not found.`;
    3. `validateTaskInput` → `invalid` with its message;
    4. `activeTaskFor` → `conflict` `<name> already has an active task.`
  - **Then `startTask`:**
    - commit `assignTask(…, { runtime: provider.kind, timeoutMs: config.taskTimeoutMs })`;
    - commit `markStarting`;
    - create the run record `{ abort: AbortController, timers, outputBytes: 0, outputClosed: false }`;
    - arm the task timeout;
    - call `void launch(taskId)`;
    - return the task as it is in `starting`.
  - **`launch` is the duplicate guard.** It refuses unless the task is `starting`, no run has launched for it, and `provider.status(taskId).state !== 'running'`. It awaits `provider.start(task, { agent, signal })`:
    - `{ ok: false }` → apply `failed` with its error;
    - a rejection → apply `failed` with `Runtime failed to start: <message>`.
  - **Provider events** go through `onEvent`:
    1. cap them (below);
    2. commit `applyRuntimeEvent`;
    3. then compare the task status:
       - entered `waiting_for_approval` → arm the approval timer for that `approvalId`;
       - left it → clear the timer;
       - no longer active → finalize the run (clear every timer, delete the record).
    - Events for a task without a run, or that don't fit its state, change nothing (`applyRuntimeEvent` returns the same reference).
  - **Task timeout** (`taskTimeoutMs`, armed at start, covers `starting` through `waiting_for_approval`): commit `timeOutTask` → `provider.cancel(taskId)` → `abort()` → finalize → `onLifecycle('task.timeout')`.
  - **`cancelTask` responses:**
    - no task → `not_found` `Task not found.`;
    - not active → `conflict` `Task is not active.`;
    - already `cancelling` → ok, with no change (idempotent).
  - **`cancelTask` steps** (closes Stage A's deferred minor on the server; Ruling 10):
    1. commit `requestCancel` and clear the task timeout;
    2. if the task is now `cancelled` (it was `queued`), finalize;
    3. otherwise call `provider.cancel`. The mock confirms synchronously, so by the time this returns the task may already be `cancelled` and finalized;
    4. if the task is still `cancelling`, arm the grace timer (`cancelGraceMs`). When it fires: commit `ops.cancelTask`, then `abort()`, finalize, `log.warn('Runtime did not confirm cancel of <id> within <ms> ms; marked cancelled.')` and `onLifecycle('task.force_cancelled')`.
  - **`decideApproval`:**
    - no task → `not_found`;
    - not `waiting_for_approval` → `conflict` `Task is not waiting for approval.`;
    - a different `pendingApproval.id` → `conflict` `That approval is no longer pending.`;
    - otherwise: commit `ops.decideApproval`, clear the approval timer, call `provider.respondToApproval`, and return the task as it is after the provider's synchronous reaction. With the mock, a deny is already `failed`.
  - **Approval timeout** (`approvalTimeoutMs`, Ruling 4): if the task is still waiting on the same id, commit `applyRuntimeEvent({ type: 'failed', error: APPROVAL_TIMEOUT_MESSAGE(ms) })`, then `provider.cancel`, `abort()`, finalize and `onLifecycle('approval.timeout')`. The task timeout keeps running while it waits, since both are wall-clock.
  - **`removeAgent`:** no agent → `not_found`; otherwise commit `ops.removeAgent`. If it returned a `cancelledTaskId`: `provider.cancel`, `abort()`, finalize.
  - **Demo `requestApproval`/`forceError`:**
    - no task → `not_found`;
    - not `running` → `conflict` `Task is not running.`;
    - a provider without the controls → `unavailable` `Demo controls need RUNTIME=mock.`
- **Output caps** are applied in `onEvent` before `applyRuntimeEvent`:
  - **`message.text`:**
    1. cut to `maxMessageBytes` plus `messageTruncatedMarker`;
    2. then counted against the task budget `maxTaskOutputBytes`. A message that crosses the budget keeps only the part that fits, plus `outputLimitMarker`, and sets `outputClosed`;
    3. once `outputClosed`, later `message` events are dropped.
  - **`progress.message` and `failed.error`:** cut to `maxMessageBytes` only.
  - **`completed.summary`:** cut to `maxMessageBytes` and counted against the budget the same way.
  - Markers don't count toward the budget.

- [ ] **Step 1: Write the failing tests.**
  - **`server/limits.test.ts`:**
    - `formatBytes`: `16` → `'16 B'`, `32768` → `'32 KB'`, `262144` → `'256 KB'`;
    - `truncateUtf8 never splits a code point`: `truncateUtf8('héllo', 2)` gives `{ text: 'h', truncated: true }`; `truncateUtf8('abc', 3)` gives `{ text: 'abc', truncated: false }`.
  - **`server/runtime/mockProvider.test.ts`** (fake timers, timings `{ thinkingMs: 100, workingMs: 200 }`):
    - `start resolves an executionId and sessionId null`: matches `/^exec-/`;
    - `status runs then ends completed and result has the summary`: `{ outcome: 'completed', summary: 'Simulated result for "Build API". No AI was run.' }`;
    - `cancel ends cancelled`: status `ended`/`cancelled`, result `{ outcome: 'cancelled' }`;
    - `status is unknown for an unknown task and result is null`;
    - `requestApproval sets pendingApprovalId and deny ends failed`: result `{ outcome: 'failed', error: 'Approval denied (simulated)' }`;
    - `dispose emits nothing more`.
  - **`server/runtime/claudeAgent.test.ts`:** `reports unavailable and refuses to start`: `kind 'claude'`, the exact availability, `start` resolves `{ ok: false, error: 'Claude Agent SDK not installed' }`, status `unknown`, and no events.
  - **`server/taskManager.test.ts`.** Setup: fake timers; a store from `openWorkforceStore` on a temp dir with `writeFile: () => {}`; demo agent `agent-demo-backend` (Forge); and `FakeProvider` from `server/test/fakeProvider.ts`, which records `starts`, `cancels` and `responses`, exposes `emit(event)`, `resolveStart(outcome)` / `rejectStart(error)`, a `confirmCancel` flag (default `false`), and `lastSignal`. Cases:
    - `runs queued → starting → running → completed with the mock`:
      - right after `startTask`, the task is `starting` with `runtime: 'mock'` and `timeoutMs: 600000`, and the agent is `thinking`;
      - `advanceTimersByTimeAsync(0)` → `running`, with `executionId` matching `/^exec-/`;
      - `advanceTimersByTimeAsync(300)` → `completed`, `endedReason: 'completed'`, and `vi.getTimerCount() === 0`;
    - `two startTask calls in the same tick start one run` (Review Focus 1): the second gives `{ ok: false, code: 'conflict', error: 'Forge already has an active task.' }`, and `fake.starts.length === 1` after flushing;
    - `refuses when the provider is unavailable`: with `ClaudeAgentRuntimeProvider`, the result is `{ ok: false, code: 'unavailable', error: 'The claude runtime is not available: Claude Agent SDK not installed.' }` and `store.state.tasks` is unchanged;
    - `maps not found and invalid input`: an unknown agent gives `not_found`/`Agent not found.`; `{ title: ' ' }` gives `invalid`/`Title is required.`;
    - `a refused start fails the task`: `resolveStart({ ok: false, error: 'boom' })` → `failed`, `errorMessage: 'boom'`;
    - `a throwing start fails the task`: `rejectStart(new Error('crash'))` → `errorMessage: 'Runtime failed to start: crash'`;
    - `times out a run that never ends` (Review Focus 2):
      - with `taskTimeoutMs: 1000`, `advanceTimersByTimeAsync(1000)` → `failed`, `endedReason: 'timeout'`, `errorMessage: 'Timed out after 1 s'`;
      - `fake.cancels` equals `[taskId]` and `fake.lastSignal.aborted === true`;
      - a later `fake.emit({ type: 'completed', … })` leaves `store.state` the same reference;
    - `cancel waits for confirmation, then forces after the grace period` (Review Focus 2):
      - `cancelTask` → `cancelling`, with the agent status unchanged;
      - after 4999 ms it is still `cancelling`; after 1 more ms it is `cancelled`, `endedReason: 'cancelled'`, the signal is aborted, and the timer count is 0;
    - `cancel confirmed by the runtime ends at once`: with the mock, `cancelTask` returns a task already `cancelled`, and the timer count is 0;
    - `cancel errors and idempotence`: an unknown id gives `not_found`/`Task not found.`; a finished task gives `conflict`/`Task is not active.`; a second cancel while `cancelling` gives `ok`, and the state is the same reference;
    - `approval round trip`: with the mock, after `advanceTimersByTimeAsync(0)`, `requestApproval` → `waiting_for_approval`; `decideApproval(approve)` → `running` and the agent `working`; `advanceTimersByTimeAsync(200)` → `completed`;
    - `deny fails with the simulated message`;
    - `approval conflicts`: a stale id gives `That approval is no longer pending.`; a running task gives `Task is not waiting for approval.`;
    - `approval timeout fails the task`: with `approvalTimeoutMs: 2000`, after 2000 ms the task is `failed` with `errorMessage: 'No approval decision within 2 s'`, and `provider.cancel` was called;
    - `caps message size and task output`: with `maxMessageBytes: 16` and `maxTaskOutputBytes: 40`, the fake emits `started`, then `message` with `'abcdefghijklmnopqrst'`, then three times `'a'.repeat(16)`. The `agent-message` activities are exactly:
      1. `'abcdefghijklmnop\n[message truncated at 16 B]'`
      2. `'a'.repeat(16)`
      3. `'a'.repeat(8) + '\n[output limit reached at 40 B; later messages are dropped]'`
      - and a fifth message adds no activity;
    - `removeAgent stops its run`: with the mock running, `removeAgent` → `cancelledTaskId` set, the provider status is `ended`, and the timer count is 0;
    - `dispose clears timers and leaves state`: the timer count is 0 and the task is still `running` in `store.state`;
    - `reports lifecycle actions in order`: start → cancel → grace expiry gives `['task.start', 'task.cancel', 'task.force_cancelled']`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/limits.test.ts server/runtime server/taskManager.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the contract types, both providers, `limits.ts`, `fakeProvider.ts` and `TaskManager` to the rules above.
- [ ] **Step 4: Run them and confirm they pass.** Run `npx vitest run server && npx tsc -b`.
- [ ] **Step 5: Commit** with `feat(server): add runtime contract v2 and the task manager`

---

### Task 5: REST endpoints

**Files:**
- Create: `server/http/inputs.ts`, `server/http/routes.ts`
- Modify: `server/app.ts` (full wiring and health), `server/test/helpers.ts`
- Test: `server/http/routes.test.ts`, `server/app.test.ts`

**Interfaces:**
- **`server/app.ts` (final):**
  ```ts
  export type AppDeps = { now?: () => string; log?: Logger; bootId?: string; provider?: ServerRuntimeProvider; mockTimings?: typeof MOCK_TIMINGS; heartbeatMs?: number; guards?: Guard[]; responseHeaders?: (req: IncomingMessage) => Record<string, string> }
  export type App = { config: ServerConfig; store: WorkforceStore; events: EventLog; provider: ServerRuntimeProvider; manager: TaskManager; startedAt: string; handler: (req: IncomingMessage, res: ServerResponse) => void; closeStreams(): void }
  export function createApp(config: ServerConfig, deps?: AppDeps): App
  export type RunningServer = { url: string; port: number; app: App; close(): Promise<void> }   // close: closeStreams → manager.dispose → server.close + closeAllConnections
  ```
  - The provider comes from `deps.provider`, otherwise `config.runtime === 'mock' ? new ServerMockProvider({ timings: deps.mockTimings }) : new ClaudeAgentRuntimeProvider()`.
  - New agents get `runtimeMode: config.runtime === 'claude' ? 'real' : 'mock'`.
- **`server/http/inputs.ts`.** Each parser returns the typed body or throws `HttpError(400, …)`. Unknown keys are rejected, so `cwd`, `path` or `command` from a browser never pass.
  ```ts
  export function parseCreateAgent(b: Record<string, unknown>): AgentInput            // keys name, role, department (all strings)
  export function parsePatchAgent(b: Record<string, unknown>): Partial<AgentInput>    // same keys, each optional, at least one
  export function parseDesk(b: Record<string, unknown>): { deskId: string | null }    // non-empty string ≤ 64 chars, or null
  export function parseCreateTask(b: Record<string, unknown>): TaskInput              // title (string), description (optional string, default ''); workspaceId → 400
  export function parseApproval(b: Record<string, unknown>): { approvalId: string; decision: ApprovalDecision }
  ```
  - **400 copy:**
    - `Unknown field "<key>".`
    - `"<key>" must be a string.`
    - `Send at least one of "name", "role" or "department".`
    - `"deskId" must be a desk id or null.`
    - `"workspaceId" is not supported yet.`
    - `"approvalId" must be a non-empty string.`
    - `"decision" must be "approve" or "deny".`
  - Business validation stays with `validateAgentInput`/`validateTaskInput`, through the operations and the manager, and returns **422** with their messages.
- **Manager codes map to statuses:** `not_found` → 404, `invalid` → 422, `conflict` → 409, `unavailable` → 503.
- **Endpoints:**

  | Method and path | Body | Success | Errors |
  |---|---|---|---|
  | `GET /api/health` | none | 200 `{ ok: true, version, runtime, available, reason: string \| null, credentialsConfigured, persistence: { ok, error }, startedAt }` | none |
  | `GET /api/state` | none | 200 `StateResponse`: `store.state` and `events.lastEventId` read in the same tick, plus `load.problem`, `load.preserved` and `saveError` | none |
  | `GET /api/events` | none | 200 `text/event-stream` (Task 6) | none |
  | `POST /api/agents` | `{ name, role, department }` | 201 `{ agent }` | 400, 415, 422 (`Name is required.` …) |
  | `PATCH /api/agents/:id` | `{ name?, role?, department? }` | 200 `{ agent }` (unchanged values are a no-op, still 200) | 400, 404 `Agent not found.`, 422 |
  | `DELETE /api/agents/:id` | none | 200 `{ ok: true, cancelledTaskId }` | 404 |
  | `PUT /api/agents/:id/desk` | `{ deskId }` | 200 `{ agent }` | 400, 404, 409 `That desk is already assigned to <name>.` |
  | `POST /api/agents/:id/tasks` | `{ title, description? }` | 202 `{ task }` (status `starting`) | 400, 404, 409 `<name> already has an active task.`, 422, 503 |
  | `POST /api/tasks/:id/cancel` | none (`body: 'none'`) | 202 `{ task }` (`cancelling` or `cancelled`) | 404 `Task not found.`, 409 `Task is not active.` |
  | `POST /api/tasks/:id/approval` | `{ approvalId, decision }` | 200 `{ task }` | 400, 404, 409 |
  | `POST /api/demo/tasks/:id/request-approval` | none | 202 `{ ok: true }` | 404, 409 `Task is not running.` |
  | `POST /api/demo/tasks/:id/force-error` | none | 202 `{ ok: true }` | 404, 409 |
  | `POST /api/demo/agents/restore` | none | 200 `{ agents }` (`restoreDemoAgents`) | none |

  - The `/api/demo/*` routes are **only registered when `RUNTIME=mock`**, so otherwise they fall through to 404 `Not found.`
  - The server can't check that a desk id exists, because the layout lives in the browser. This is a documented limit, as in 3A (raw desk ids).
- **How the endpoints map onto `WorkforceController`,** so Stage D's `RemoteWorkforceController` stays a thin adapter:

  | Controller method | Endpoint |
  |---|---|
  | `getSnapshot` / `subscribe` | `GET /api/state` + `GET /api/events` |
  | `createAgent` / `updateAgent` / `removeAgent` / `assignDesk` | the agent endpoints |
  | `startTask` | `POST /api/agents/:id/tasks` |
  | `cancelTask` | `POST /api/tasks/:id/cancel` |
  | `decideApproval` | `POST /api/tasks/:id/approval` |
  | `requestApproval` / `forceError` / `restoreDemoAgents` | `/api/demo/*` |
  | `dismissLoadProblem` | client-local |

- [ ] **Step 1: Write the failing tests.**
  - `server/http/routes.test.ts` uses `startTestServer({}, { mockTimings: { thinkingMs: 60000, workingMs: 60000 } })`, so tasks stay running. Cases:
    - `GET /api/state returns the snapshot`: 200, 6 agents, `lastEventId` matches `/^[0-9a-z]+:0$/`, and `loadProblem`, `preserved` and `saveError` are all `null`;
    - `creates an agent`: `{ name: 'Nova', role: 'Researcher', department: 'backend' }` gives 201 with `agent.name: 'Nova'`, `status: 'idle'` and `runtimeMode: 'mock'`; a later `GET /api/state` contains it, and `lastEventId` has a seq ≥ 1;
    - `rejects invalid agents`:
      - `{ name: '', role: 'R', department: 'backend' }` gives 422 `Name is required.`;
      - an added `cwd: '/'` gives 400 `Unknown field "cwd".`;
      - `name: 5` gives 400 `"name" must be a string.`;
      - `text/plain` gives 415;
    - `patches an agent`: `PATCH /api/agents/agent-demo-qa { role: 'Lead tester' }` gives 200 with `agent.role: 'Lead tester'`; an unknown id gives 404 `Agent not found.`; `{}` gives 400;
    - `assigns desks`: `{ deskId: 'desk-03' }` for `agent-demo-qa` gives 409 `That desk is already assigned to Atlas.`; `{ deskId: null }` gives 200 with `deskId: null`; `{ deskId: 5 }` gives 400;
    - `deletes an agent`: 200 `{ ok: true, cancelledTaskId: null }`; a second delete gives 404;
    - `starts a task`: `POST /api/agents/agent-demo-backend/tasks { title: 'Build API', description: 'REST' }` gives 202 with `task.status: 'starting'`, `runtime: 'mock'` and `timeoutMs: 600000`;
    - `rejects bad task requests`:
      - a second start gives 409 `Forge already has an active task.`;
      - `{ title: '' }` on Pixel gives 422 `Title is required.`;
      - `{ title: 'x', workspaceId: 'sandbox' }` gives 400 `"workspaceId" is not supported yet.`;
      - `{ title: 'x', command: 'rm -rf /' }` gives 400 `Unknown field "command".`;
      - an unknown agent gives 404;
    - `cancels a task`: 202 with `task.status: 'cancelled'`; again gives 409 `Task is not active.`; an unknown id gives 404 `Task not found.`;
    - `approval via demo controls`:
      - start a task and wait until it is running (poll `GET /api/state`, up to 1 s);
      - `POST /api/demo/tasks/:id/request-approval` gives 202, and the state shows `waiting_for_approval` with `pendingApproval.tool: 'Write'`;
      - `{ approvalId: pending.id, decision: 'maybe' }` gives 400 `"decision" must be "approve" or "deny".`;
      - `deny` gives 200 with `task.status: 'failed'` and `errorMessage: 'Approval denied (simulated)'`;
      - a repeat gives 409 `Task is not waiting for approval.`;
    - `restores demo agents`: after deleting `agent-demo-qa`, `POST /api/demo/agents/restore` gives 200 and the agent is back;
    - `the claude runtime refuses tasks and hides demo routes`: on a server with `RUNTIME=claude`:
      - `/api/health` gives `available: false` and `reason: 'Claude Agent SDK not installed'`;
      - a task start gives 503 `The claude runtime is not available: Claude Agent SDK not installed.`;
      - `POST /api/demo/agents/restore` gives 404 `Not found.`
  - `server/app.test.ts`, added:
    - `health includes persistence and startedAt`: `persistence: { ok: true, error: null }`, and `startedAt` is an ISO time;
    - `state survives a restart`:
      1. start, delete all 6 demo agents, create `Nova`, then close;
      2. start again on the same `DATA_DIR`;
      3. the agents are exactly `['Nova']`, with no reseed (Review Focus 4);
    - `a task running at shutdown is failed on restart`: start a task, close, restart → `failed`, `errorMessage: 'Interrupted by a server restart'`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/http/routes.test.ts server/app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `inputs.ts`, `routes.ts` and the final `app.ts` wiring: the store's `onCommit` → `events.append(deriveEvents(...))`, the provider choice, the manager, and the routes.
- [ ] **Step 4: Run them and confirm they pass.** Run `npx vitest run server && npx tsc -b`.
- [ ] **Step 5: Commit** with `feat(server): add REST endpoints for agents, tasks and demo controls`

---

### Task 6: SSE stream and end-to-end lifecycle tests

**Files:**
- Create: `server/http/sse.ts`, `server/test/sseClient.ts`
- Modify: `server/http/routes.ts` (register `GET /api/events`)
- Test: `server/http/sse.test.ts`, `server/lifecycle.test.ts`

**Interfaces:**
- **Produces (`server/http/sse.ts`):**
  ```ts
  export const HEARTBEAT_MS = 15000
  export const RETRY_MS = 3000
  export function eventsRoute(deps: { events: EventLog; heartbeatMs: number; streams: Set<ServerResponse> }): Route
  export function formatSseFrame(e: WorkforceEvent): string   // `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
  ```
- **The `GET /api/events` handler:**
  - **Headers:** `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`. It writes `retry: 3000\n\n` at once.
  - **Resume point:** the `Last-Event-ID` header, or else the `?lastEventId=` query (Ruling 7), or else none.
  - **Replay vs reset, synchronously in one tick:**
    - `events.since(id)` → `replay` writes each event;
    - `reset` writes `formatSseFrame({ id: events.lastEventId, type: 'state.reset', at: now(), reason: 'gap' })`.
    - Then it subscribes for live events.
    - Because the replay and the subscription happen in the same tick, nothing is lost or duplicated in between.
  - **Heartbeat:** `: ping\n\n` every `heartbeatMs`.
  - **Cleanup** on `req` `close`/`res` `close`: unsubscribe, clear the interval, remove the stream from `streams`.
  - **Shutdown:** `App.closeStreams()` ends every stream, so `server.close()` resolves.
  - **Client recovery contract for Stage D** (documented in the module comment):
    1. `GET /api/state`;
    2. open `EventSource('/api/events?lastEventId=<snapshot.lastEventId>')`;
    3. apply only events whose seq is above the snapshot's;
    4. on `state.reset`, reload the snapshot.
- **Produces (`server/test/sseClient.ts`):**
  ```ts
  export type SseStream = { events: WorkforceEvent[]; comments: string[]; next(match?: (e: WorkforceEvent) => boolean, timeoutMs?: number): Promise<WorkforceEvent>; until(match: (e: WorkforceEvent) => boolean, timeoutMs?: number): Promise<WorkforceEvent[]>; close(): void }
  export function openEventStream(url: string, opts?: { lastEventId?: string; query?: string }): Promise<SseStream & { response: Response }>
  ```
  - It uses `fetch` with an `AbortController`, `response.body.getReader()` and a `TextDecoder`.
  - It splits frames on a blank line and parses `id`/`event`/`data` and `:` comments.
  - `next` resolves with the first event, at or after the cursor, that matches. It rejects after `timeoutMs` (default 2000) with `No matching event within <ms> ms; saw: <types>`.

- [ ] **Step 1: Write the failing tests.**
  - `server/http/sse.test.ts`:
    - `streams with SSE headers and a retry hint`: `content-type` is `text/event-stream; charset=utf-8`, `cache-control` is `no-cache, no-transform`, and the first chunk contains `retry: 3000`;
    - `sends heartbeats`: with `heartbeatMs: 50`, `comments` contains `' ping'` within 500 ms;
    - `delivers a change with matching id`: `POST /api/agents` (Nova) → an event `state.changed` whose frame `id` equals `data.id`, with `patch.agents[0].name: 'Nova'`;
    - `cleans up on disconnect`: after `close()`, `app.events.listenerCount()` returns to 0 (poll for up to 500 ms) and `streams.size === 0`;
    - `replays after Last-Event-ID, by header and by query` (Review Focus 3):
      - with mock timings `{ thinkingMs: 30, workingMs: 30 }`, run a task to `task.completed` on stream A and note the events after `task.started`;
      - stream B with the header `Last-Event-ID: <task.started id>`, and stream C with `?lastEventId=`, each first receive exactly those events in the same order (compare ids);
    - `sends state.reset for an id from another boot`: `lastEventId: 'other:1'` → the first event is `state.reset` with `reason: 'gap'` and `id === GET /api/state lastEventId`;
    - `sends state.reset when the id is older than the buffer`: with `EVENT_BUFFER_SIZE=3`, create 5 agents, then `lastEventId: '<boot>:1'` → `state.reset`;
    - `closing the server ends open streams`: `close()` resolves within 1 s with a stream still open.
  - `server/lifecycle.test.ts` (mock timings `{ thinkingMs: 50, workingMs: 100 }`, one stream per test opened with the snapshot's `lastEventId`). `typesFor(taskId)` filters events by `taskId`:
    - `start → completed`:
      - the event types contain, in order, `task.queued`, `task.started`, `task.progress` (thinking), `task.progress` (working) and `task.completed`;
      - an `agent.status_changed` with `to: 'completed'` follows;
      - the final `GET /api/state` task has `status: 'completed'`, `endedReason: 'completed'` and `resultSummary: 'Simulated result for "Build API". No AI was run.'`;
    - `approval → approve → completed`: after `task.started`, call `request-approval` → `task.waiting_for_approval` (with `patch.tasks[0].pendingApproval.id`) → approve → `task.completed`;
    - `approval → deny → failed`: `task.failed` with `patch.tasks[0].errorMessage: 'Approval denied (simulated)'`;
    - `cancel → cancelling → cancelled`: after `task.started`, cancel → a `state.changed` whose task is `cancelling`, then `task.cancelled` with `endedReason: 'cancelled'`, and the agent status changes to `idle`;
    - `timeout → failed with timeout`: with `TASK_TIMEOUT_MS=600` and timings `{ thinkingMs: 5000, workingMs: 5000 }` → `task.failed` with `endedReason: 'timeout'` and `errorMessage: 'Timed out after 1 s'`;
    - `duplicate start is rejected` (Review Focus 1): a second `POST` gives 409, and exactly one `task.started` appears for the agent;
    - `snapshot plus events stays consistent` (Review Focus 5):
      1. `s0 = GET /api/state`;
      2. open the stream at `s0.lastEventId`;
      3. run create agent, assign desk, task with approval, approve, complete, and delete another agent;
      4. wait for `task.completed`, then wait until the stream's last id equals a fresh `GET /api/state` `lastEventId`;
      5. `events.reduce(applyWorkforceEvent, s0.state)` must `toEqual` that state;
    - `the saved file matches the served state`: `parseWorkforce(JSON.parse(readFileSync(<dataDir>/workforce.json)))` `toEqual` `GET /api/state` `.state` after a completed run.
- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run server/http/sse.test.ts server/lifecycle.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sse.ts`, `sseClient.ts` and the route registration.
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test && npx tsc -b`. Expected: every test passes (311 existing plus the new server tests), with no type errors.
- [ ] **Step 5: Commit** with `feat(server): add SSE event stream with replay and lifecycle tests`

---

### Task 7: Verification and PR

Stage B changes no UI, so this task uses curl instead of a browser. Run every step for real and paste the output into the PR.

- [ ] **Step 1: Full checks.**
  - `npm test`: all pass.
  - `npm run build`: passes, with only the existing chunk-size warning, and `dist/` is unchanged in size.
  - `npm run server:build`: `dist-server/index.js` imports only `node:*`.
  - `npm audit`: 0 vulnerabilities.
- [ ] **Step 2: Backend alone** (`npm run server` in terminal 1, with `rm -rf data` first):
  1. The banner shows `http://127.0.0.1:8787 (runtime: mock)`, and `data/workforce.json` exists with 6 demo agents.
  2. `curl -s http://127.0.0.1:8787/api/health` → `ok`, `runtime: mock`, `available: true`, `credentialsConfigured: false`, `persistence.ok: true`.
  3. `curl -s http://127.0.0.1:8787/api/state | head -c 400` → the state and `lastEventId` `<boot>:0`.
  4. In terminal 2, run `curl -N http://127.0.0.1:8787/api/events` → `retry: 3000`, then `: ping` every 15 s.
  5. `curl -s -X POST -H 'Content-Type: application/json' -d '{"title":"Build API","description":"demo"}' http://127.0.0.1:8787/api/agents/agent-demo-backend/tasks` → 202 with the task `starting`. Terminal 2 shows `task.queued`, `task.started`, `task.progress` ×2, `agent.status_changed` and `task.completed` with increasing ids.
  6. Start another task, then `curl -X POST .../api/demo/tasks/<id>/request-approval` → `task.waiting_for_approval`; then `curl -X POST -H 'Content-Type: application/json' -d '{"approvalId":"<id>","decision":"approve"}' .../api/tasks/<id>/approval` → completed.
  7. Start a task and `curl -X POST .../api/tasks/<id>/cancel` → `cancelled`.
  8. **Reconnect:** `curl -N -H 'Last-Event-ID: <an id from step 5>' .../api/events` replays the later events. Running it with `Last-Event-ID: old:1` gives `event: state.reset`.
  9. **Errors:**
     - `-H 'Content-Type: text/plain'` → 415;
     - `{"title":"x","command":"ls"}` → 400 `Unknown field "command".`;
     - `GET /api/nope` → 404;
     - `PUT /api/state` → 405.
  10. **Persistence:**
      - Ctrl+C, run `npm run server` again, then `GET /api/state` → same agents and task history, with a new boot id in `lastEventId`, and no reseed.
      - Start a task with `TASK_TIMEOUT_MS=600000` and kill the server mid-run (Ctrl+C during thinking). After restart, the task is `failed` with `Interrupted by a server restart`.
  11. **Config:**
      - `PORT=abc npm run server` → the readable error and exit 1;
      - `HOST=0.0.0.0 npm run server` → refused;
      - `RUNTIME=claude npm run server` → health `available: false`, a task gives 503 with the exact message, and `/api/demo/agents/restore` gives 404;
      - `TASK_TIMEOUT_MS=3000 npm run server` → a task with an approval left pending ends `failed`, `Timed out after 3 s`.
  12. **Corrupt file:** stop the server, run `echo '{bad' > data/workforce.json` and start → the log names `data/workforce.backup.json`, and the state is empty until the first change.
  13. **Production server:** `npm run server:start` → the same health output.
- [ ] **Step 3: Dev workflows.**
  - `npm run dev:full` → the backend banner plus the Vite URLs. The page loads in browser mock mode as before (the UI ignores the variable until Stage D). Ctrl+C stops both.
  - `npm run dev` (and `/vo`) still start the frontend only.
- [ ] **Step 4: Hygiene.**
  - `git status` → `data/` and `dist-server/` are ignored, and `.env.example` is tracked.
  - `grep -rnE "child_process|spawn\(|execFile" server src scripts` → nothing.
  - `grep -rn "sk-" data/ dist-server/` → nothing.
- [ ] **Step 5: Tick the Stage B boxes in `tasks.md`.** Commit with `docs: record milestone 3B.1 stage B verification`. Push `feat/backend-service`, then open the PR into `main` with the check output, the endpoint and event tables, the rulings, and an explicit line: **No Claude SDK is installed; the backend runs the mock runtime only.**

---

## Rulings

1. **Import extensions.** The brief mentions a `.ts` import-extension convention, but `src/` imports are extensionless (`from './operations'`), and `allowImportingTsExtensions` is set but unused. The server follows the existing extensionless style, and tsx, Vite and Vitest all resolve it. No change to `src/`.
2. **The `Storage` DOM type blocks a no-DOM type-check.** `src/workforce/storage.ts` declares `type KV = Pick<Storage, 'getItem' | 'setItem'>`, and `Storage` exists only in the DOM lib, so `tsconfig.server.json` (no DOM) would fail on it. The smallest fix: replace it with the identical structural type `{ getItem(key: string): string | null; setItem(key: string, value: string): void }`. `controller.ts` keeps its own `Pick<Storage>`, since the server never imports it. Everything else in the server's import graph is Node-safe, and `crypto.randomUUID` is a Node 24 global, so no shims are needed.
3. **The recovery message says "page reload".** `recoverInterruptedTasks` hard-codes `Interrupted by page reload (simulated run)`, which is wrong after a server restart. The smallest fix: an optional `message` parameter (defaulting to the current constant). The server passes `Interrupted by a server restart`.
4. **The approval timeout is listed under Stage C in `tasks.md`,** but the task manager owns every lifecycle timer, so it is built in Stage B (`APPROVAL_TIMEOUT_MS`, default 5 min). Stage C only routes tool decisions (`decideToolUse` → `ask`) into this existing waiting state. A timed-out approval ends as `failed` (`No approval decision within <n> s`), not `timeout`, because `timeOutTask`'s copy is about the whole task.
5. **Decision 2's frontend URL needs CORS, which arrives in Stage C.** `VITE_WORKFORCE_API_URL=http://127.0.0.1:8787` is cross-origin from `:5173`. Stage B sends no CORS headers, so a page on another origin cannot read responses. That is not the same as being unreachable: a body-less POST is a CORS "simple request", and the server runs it (found in the final review). Stage C's guards close this (JSON-only on body-less routes, a Host-header allowlist); until then the exposure is limited by loopback binding, random task ids and the mock-only runtime. `dev:full` already sets the variable for Stage D.
6. **Event ids are `<bootId>:<seq>`, not a bare number.** A bare counter restarts at 1 after a restart and would make old ids look valid. The prefix keeps ids monotonic within a boot (decision 6) and turns any id from another boot into `state.reset`.
7. **`EventSource` can't send `Last-Event-ID` on its first connect.** So `GET /api/events?lastEventId=` is accepted as well, and the header wins when both are present. Without either, the stream is live-only.
8. **Contract v2 `start` is async,** as an SDK session start will be. The task's `executionId`/`sessionId` keep coming from the `started` event, so `applyRuntimeEvent` stays the only writer.
9. **`RUNTIME=claude` refuses tasks with 503 and creates nothing.** This differs from the browser controller, which creates the task and then fails it. Decision 2's wording, "refuses tasks with a clear message", is matched more closely by not creating the task.
10. **The deferred cancel minor is closed on the server only.** The browser controller still force-cancels right after `runtime.cancel`. That is harmless there, because the browser mock confirms synchronously, and Stage D replaces it with the remote controller in backend mode.
11. **`HOST` is loopback-only in Stage B,** which tightens decision 8 until the origin allowlist exists. Stage C relaxes the check together with `ALLOWED_ORIGINS`. `WORKSPACE_ROOT`, `WORKSPACES`, `ALLOWED_TOOLS` and `ALLOWED_ORIGINS` (decision 9) are Stage C variables.
12. **"No child_process anywhere" vs a combined dev command.** `dev:full` runs the backend and Vite's `createServer` API in one tsx process, so it needs no `concurrently`, no shell `&` and no `child_process`. The guard test also scans `scripts/`.

## Deferred to Stage C/D (seams left in place)

- **Stage C:**
  - **`Guard[]` and `responseHeaders` in `RouterOptions`/`AppDeps`** (empty in Stage B). These are for the origin allowlist, JSON-only state changes (clients should already send `Content-Type: application/json` with `{}` on body-less POSTs), CORS and OPTIONS preflight.
  - **The loopback-only `HOST` rule** in `parseConfig`, to relax once `ALLOWED_ORIGINS` exists.
  - **The `"workspaceId" is not supported yet.` 400** in `parseCreateTask`, to be replaced by `resolveWorkspace`. The resolved workspace is then passed as `StartContext.workspace`.
  - **`StartContext`**, which gets workspace and tool-policy fields; the provider interface is otherwise unchanged.
  - **`TaskManagerOptions.onLifecycle`**, to be written to `data/audit.log` as JSON Lines.
  - **`ClaudeAgentRuntimeProvider`** in `server/runtime/claudeAgent.ts`, which gets the documentation block, the credentials reason, and the permission callback that calls `decideToolUse`.
  - **`credentialsConfigured`** already comes from `ANTHROPIC_API_KEY`. The leak tests for `dist/`, responses and logs are Stage C.
- **Stage D:**
  - **`src/workforce/api.ts`**: wire types, `StateResponse` (`WorkforceSnapshot` plus `lastEventId`), the request body types and `applyWorkforceEvent`.
  - **The recovery contract** in `sse.ts`: snapshot, then `?lastEventId=`, then drop events at or below the snapshot seq, then reload on `state.reset`.
  - **The controller-to-endpoint table** in Task 5.
  - **`dev:full`**, which already sets `VITE_WORKFORCE_API_URL`.
- **Documented limits:**
  - one process and one writer;
  - a synchronous write per commit;
  - no task queue (a `queued` task left by a crash stays queued until cancelled);
  - the server can't validate desk ids;
  - activities are capped at 300 and tasks are uncapped (an open 3A limit).
