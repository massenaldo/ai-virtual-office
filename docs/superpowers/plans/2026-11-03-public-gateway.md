# Public gateway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Let the owner open the virtual office from a browser through an InstaBox published HTTPS port, behind a password, without weakening the backend's loopback-only guard.

**Architecture:** A small gateway process listens on `0.0.0.0:3000`. It checks one password (HTTP Basic, from `VO_PASSWORD`), serves the built frontend from `dist/`, and proxies `/api/*` (including the server-sent-events stream) to the backend that stays on `127.0.0.1:8787`, adding the backend's API token itself. The backend, its guards and its auth are not changed. One entry script starts the backend and the gateway in the same process (no child process: `server/noProcessExecution.test.ts` forbids it).

**Tech Stack:** Node 22 `node:http` only (no framework, no new dependency), TypeScript, vitest, the existing `startServer`.

**Spec:** the owner's request in this session (no document): make the app reachable via an InstaBox published port; bind 0.0.0.0:3000; no hardcoded localhost; password from an env var `VO_PASSWORD`, required; README with tmux start, port to publish and env vars; verify live updates still work; never publish the port; ask before any big refactor.

## Global Constraints

- The backend (`server/app.ts`, `server/http/*`, `server/config.ts`) is **not modified**. Its loopback-only `HOST` rule and its Host/Origin/auth guards stay exactly as they are.
- `VO_PASSWORD` is **required**: the entry script refuses to start without it, and with fewer than 12 characters. It is read from the environment only and is never logged, never in a response, never committed. `.env.example` lists the name with an empty value.
- Listens on `PUBLIC_HOST` (default `0.0.0.0`) and `PUBLIC_PORT` (default `3000`).
- Every request except a password check needs the password, including static files, `/api/health` and the SSE stream. The comparison is constant-time. A missing or wrong password gets `401` with `WWW-Authenticate: Basic realm="Virtual Office", charset="UTF-8"`.
- Repeated wrong passwords are throttled (see Task 1). The password and the `Authorization` header never reach a log line.
- `/api/*` requests must carry `Sec-Fetch-Site: same-origin` (as the dev proxy requires), else `403`; plain `curl` needs the header. Path variants that read as the API after decoding or case folding but are not the plain form are `404` and never forwarded (reuse `classifyPath` from `scripts/apiProxy.ts` by import; do not copy it).
- Forwarding to the backend: drop the client's `Authorization`, `Cookie`, `Origin`, `Referer` and every `X-Forwarded-*`/`Forwarded` header; set `Host` to `127.0.0.1:<backend port>`; set `Authorization: Bearer <token>` from `readToken()`; keep the method, path, query, `Content-Type`, `Last-Event-ID` and the body. Responses stream through without buffering and are never compressed; `Cache-Control: no-store` on every gateway response.
- Frontend URLs: the built app must call same-origin `/api` (`VITE_WORKFORCE_API_URL=/` at build time). No `localhost`, `127.0.0.1` or `ws://` URL in any code this plan adds, except the backend target inside the gateway's own config.
- `RUNTIME=claude` is refused by the entry script unless `VO_ALLOW_PUBLIC_CLAUDE=yes` is set: a public URL with real model spend and file writes is not allowed by default while the 3B.5.3 prerequisites (real-key run, independent review, OS-user decision) are open.
- No new dependency. No code that spawns a process or uses `child_process`, `exec(`, `spawn(`, `fork(` or `worker_threads` (`server/noProcessExecution.test.ts` scans `server/` and `scripts/`).
- Match the codebase: no framework, short comments that say why, fixed error sentences, conventional commits ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Verification at the end of each task: its own tests, `npx tsc -b`, and `npx vitest run server/noProcessExecution.test.ts`.

## Review Focus

1. **Password bypass:** a request that skips the check through a path trick, an HTTP method, a header, a static-file route or the proxy. Task 1 and 2.
2. **Token leakage:** the backend API token appearing in any response, header or log, or the client's own `Authorization` reaching the backend. Task 2.
3. **Path traversal:** reading outside `dist/` through `..`, encoded dots or slashes, backslashes or a NUL byte. Task 1.
4. **Cross-site use of cached Basic credentials:** a state-changing or data-reading `/api` request from another site. Task 2.
5. **SSE through the gateway:** events arrive as they happen, `Last-Event-ID` is forwarded, and a client that disconnects closes the upstream request. Task 2.

---

### Task 1: Gateway core — password, throttle, static files

**Files:** Create `server/gateway/auth.ts`, `server/gateway/static.ts`, `server/gateway/gateway.ts`; Test `server/gateway/auth.test.ts`, `server/gateway/static.test.ts`, `server/gateway/gateway.test.ts`.

**Interfaces:**
- Produces `createPasswordCheck(opts: { password: string; now?: () => number; failureLimit?: number; windowMs?: number; lockoutMs?: number }): { check(authorizationHeader: string | undefined): { ok: true } | { ok: false; status: 401 | 429; retryAfterS?: number } }`. Defaults: 8 failures within 5 minutes lock every attempt (even a right password) for 5 minutes with `429` and `Retry-After`. Counting is global, not per address. A malformed header counts as a failure. The username is ignored; only the password is compared, with `crypto.timingSafeEqual` over SHA-256 digests.
- Produces `createStaticHandler(opts: { root: string }): (req: IncomingMessage, res: ServerResponse) => boolean` that serves `GET`/`HEAD` for files under `root` (resolve with `realpath` and require the real path to stay inside the real root), maps `/` to `index.html`, falls back to `index.html` for a path with no file extension that does not exist (single-page app), sets `Content-Type` from a fixed extension table (html, js, css, json, svg, png, jpg, ico, woff2, txt, map), `X-Content-Type-Options: nosniff`, and returns `false` when it did not answer. Any `..`, encoded `%2e`/`%2f`/`%5c`, backslash or NUL in the path is `404`.
- Produces `createGateway(opts: { password: string; staticDir: string; backend: { host: string; port: number }; readToken(): string | null; now?: () => number; log?: Logger }): { handler(req, res): void; close(): void }`. This task wires: password check first for every request; static files; and for any `/api` path (plain or variant) a `502` JSON `{ "error": "The API is not connected." }` until Task 2 replaces it. Every response has `Cache-Control: no-store`.
- Produces `startGateway(opts: GatewayOptions & { host: string; port: number }): Promise<{ url: string; port: number; close(): Promise<void> }>`.

- [ ] Write failing tests first for each unit, then implement. Tests must cover: right password passes; wrong, empty, missing, non-Basic, malformed base64 and a username-only header fail with 401; the username is ignored; 8 failures lock out, a right password during lockout is 429 with `Retry-After`, and the lock lifts after `lockoutMs` (use the injected clock); the password never appears in a response body or header; `GET /`, `/assets/x.js`, a missing file with and without an extension; `HEAD`; `POST /` is `405`; traversal attempts (`/../package.json`, `/%2e%2e/package.json`, `/..%2fpackage.json`, `/a\..\b`, `/%00`, a symlink inside `root` pointing outside) never return outside content; content types; the check runs before static files and before `/api`.
- [ ] Commit `feat(gateway): password check, throttle and static files`.

### Task 2: Proxy to the backend, including the event stream

**Files:** Create `server/gateway/proxy.ts`; Modify `server/gateway/gateway.ts`; Test `server/gateway/proxy.test.ts`, extend `server/gateway/gateway.test.ts`.

**Interfaces:**
- Consumes Task 1's `createGateway` and `GatewayOptions`; consumes `classifyPath` from `scripts/apiProxy.ts` (export it if it is not exported already; do not change its behaviour).
- Produces `createApiProxy(opts: { backend: { host: string; port: number }; readToken(): string | null; log?: Logger }): (req: IncomingMessage, res: ServerResponse) => void`, used by the gateway for `/api` after the password check. Rules as in Global Constraints. `classifyPath` `variant` → `404` `{ "error": "Not found." }`; not `same-origin` → `403` `{ "error": "The gateway only serves requests from this app." }`; token unavailable → `503` `{ "error": "The backend token is not available. Is the backend running?" }`; backend unreachable → `502` `{ "error": "The backend is not reachable." }` (never the system error text). Request bodies are limited to 1 MiB (`413`). Use `node:http` `request` with `agent: false`-style single-use connections; abort the upstream request when the client closes; destroy the client response when the upstream errors mid-stream. For `text/event-stream` responses: write headers at once, `flushHeaders()`, no buffering, `X-Accel-Buffering: no`.
- [ ] Tests (a real backend from `startTestServer` in `server/test/helpers.ts`, and a plain stub upstream for header checks): the client's `Authorization`, `Cookie`, `Origin`, `X-Forwarded-For` and `Forwarded` never reach the upstream, the injected bearer does, `Host` is rewritten; the token never appears in any response header or body or log line; missing `Sec-Fetch-Site`, `cross-site`, `same-site` and `none` are 403 on `GET`, `POST`, `DELETE` and the event stream; `/API/state`, `/%61pi/state`, `//api/state`, `/api/../x` are 404 and never reach the upstream; GET `/api/state` and POST `/api/agents` work end to end with the password; **the event stream through the gateway delivers an event within a second of it happening and replays from `Last-Event-ID`**; closing the client closes the upstream (the backend's stream count drops); 502/503/413 cases; password still required for every one of these.
- [ ] Commit `feat(gateway): proxy the API and the event stream to the backend`.

### Task 3: Entry script, npm scripts, config, README

**Files:** Create `server/gateway/publicConfig.ts`, `scripts/publicServer.ts`; Modify `package.json`, `.env.example`, `README.md`; Test `server/gateway/publicConfig.test.ts`.

**Interfaces:**
- Produces `readPublicConfig(env: Record<string, string | undefined>): { ok: true; host: string; port: number; password: string; allowClaude: boolean } | { ok: false; errors: string[] }`. Errors, with these exact sentences: `VO_PASSWORD is required. Set it to a password of at least 12 characters.`; `VO_PASSWORD must be at least 12 characters.`; `PUBLIC_PORT must be an integer from 1 to 65535 (got "<value>").`; `PUBLIC_HOST must be a host name or address with no spaces.`; `RUNTIME=claude is not allowed on a public address. Set VO_ALLOW_PUBLIC_CLAUDE=yes only after the security prerequisites in docs/milestone-3b5-3-report.md are met.` Defaults `0.0.0.0` and `3000`. Whitespace around values is trimmed; the password itself is not trimmed.
- `scripts/publicServer.ts`: reads `.env` the way `loadConfig` does (use `loadConfig` for the backend's own config and `mergeEnv`/`readPublicConfig` for the rest), refuses to start (exit 1, errors printed, password never printed) on any error or when `dist/index.html` does not exist (message: `The frontend is not built. Run npm run build:public first.`); starts the backend in-process with `startServer(parsed.config)` (the backend keeps its loopback `HOST`), then `startGateway` with `readToken` like `tokenReader` in `scripts/apiProxy.ts` (import it), `staticDir: dist`, backend = the running backend's host and port; prints the public listen address and that the backend stays on loopback; closes both on SIGINT/SIGTERM.
- `package.json` scripts: `"build:public": "VITE_WORKFORCE_API_URL=/ tsc -b && VITE_WORKFORCE_API_URL=/ vite build"` and `"start:public": "tsx scripts/publicServer.ts"`.
- README: a new section "Open it from a browser (InstaBox)": steps (build, set the env vars, run in tmux with `tmux new -s vo`, then `npm run start:public`, detach with Ctrl-b d), the port to publish in the InstaBox dashboard (3000), the env vars (`VO_PASSWORD`, `PUBLIC_PORT`, `PUBLIC_HOST`, plus `WORKSPACE_ROOT`/`WORKSPACES`, `DATA_DIR`), the browser flow (a username/password prompt: any username, the password), what the gateway does and does not protect, that `RUNTIME=claude` is refused publicly by default and why, that live updates use server-sent events through the same URL, and the throttle behaviour. `.env.example`: `VO_PASSWORD=`, `PUBLIC_HOST=`, `PUBLIC_PORT=`, `VO_ALLOW_PUBLIC_CLAUDE=` with one-line comments. `server/config.test.ts` checks `.env.example` names against `CONFIG_VARIABLES` + `VITE_WORKFORCE_API_URL`: extend that test's expected set with the four new names rather than adding them to `CONFIG_VARIABLES` (they are not backend settings).
- [ ] Tests for `readPublicConfig` (every error sentence, the defaults, trimming, the password not trimmed, `RUNTIME=claude` with and without the flag, a 12-character password accepted, an 11-character one refused). `npm run build:public` must succeed and `dist/` must contain no `localhost` or `127.0.0.1` string that the app calls (check with grep and report what it finds).
- [ ] Commit `feat(gateway): entry script, public scripts and README`.

## Self-review

Spec coverage: bind 0.0.0.0:3000 and scripts → Task 3; no localhost assumptions, relative URLs → Global Constraints + Task 3 build; password from env, required → Tasks 1 and 3; README with tmux, port, env vars → Task 3; live updates verified → Task 2 tests and the controller's live check. Allowed-origins and Next.js `allowedDevOrigins` are not applicable (Vite and a Node backend; the gateway strips `Origin` and rewrites `Host` instead).
