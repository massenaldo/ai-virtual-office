# Milestone 3B.4 Stage D: Browser Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser can authenticate to the backend without the dev proxy: pair once with the API token, get an HttpOnly session cookie, and use it for requests and the event stream. Closes audit blocker B4 for the backend and adds the pairing screen.

**Architecture:** An in-memory `SessionStore` issues random session ids (only their SHA-256 is kept) with a lifetime. `POST /api/session {token}` checks the token and sets `vo_session`; the `auth` guard accepts the bearer token or a valid session; cookie-authenticated state changes must carry an allowed `Origin`. The browser client sends credentials and the event stream uses `withCredentials`; a 401 shows a pairing form. The bearer token and the dev proxy keep working unchanged.

**Tech Stack:** TypeScript, Node `http`/`crypto`, React, Vitest. No new dependency.

**Spec:** `docs/browser-auth.md` (option B, "The cookie design"), `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md` §4.7, audit blocker B4 in `docs/milestone-3b4-final-report.md`.

## Global Constraints

- Branch `feat/3b4-d-browser-session`; conventional commits ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Cookie: name `vo_session`, `HttpOnly`, `SameSite=Strict`, `Path=/api`, `Max-Age` equal to the session lifetime (`SESSION_TTL_MS = 8 h`), `Secure` added when the request's `Origin` is `https:`. The cookie holds only the random id, never the token.
- The token is read from the pairing body only (never a URL), compared in constant time, and never logged, audited, echoed or put in a response. A wrong or missing token gives 401 `Unauthorized.` with the same body as any other 401.
- Guard order stays Host, Origin, preflight, auth, JSON-only. `POST /api/session` is the only route besides `GET /api/health` that skips the auth guard; it still passes Host, Origin and JSON-only.
- CORS: `access-control-allow-credentials: true` only together with an exact allowed `Origin`, never `*`. `ALLOWED_ORIGINS` rules unchanged.
- A request authenticated **only** by cookie that uses POST, PUT, PATCH or DELETE must carry an `Origin` header that is in the allowlist (a missing `Origin` is refused 403 with the existing `origin` reject code). Bearer-authenticated requests are unchanged.
- Sessions live in memory: a server restart ends them all. At most `MAX_SESSIONS = 20`; creating one more drops the oldest. Failed pairings are limited to `PAIRING_FAILURES_PER_MINUTE = 10`, then 429 `Too many attempts.` until the minute rolls over.
- No SDK, no Docker, no process execution; `MockRuntimeProvider` unchanged; the dev proxy (`scripts/apiProxy.ts`) is not changed and still strips `Cookie` and injects the bearer token.
- Verification at the end: `rtk proxy npm test`, `npx tsc -b`, `npm run build`, `npm run server:build`, `npm run check:secrets`, `npm audit`.

## Review Focus

1. **Cookie sent cross-site or from a hostile page:** a request from an origin not in `ALLOWED_ORIGINS`, or with no `Origin` on a cookie-only mutation, never changes state. Task 2.
2. **Session id handling:** ids are 256-bit random, only hashes are stored, an expired or logged-out id is refused, and the 21st session drops the oldest. Task 1.
3. **Pairing brute force and leakage:** wrong tokens are rate limited; the token and the session id appear in no log line, audit record, response body or error. Task 2.
4. **`localhost` vs `127.0.0.1`:** a session made on one host is not valid on the other (cookies are per host); the UI states which address to use instead of looping on the pairing form. Tasks 3, 4.
5. **Event stream:** `/api/events` accepts the cookie, and a stream opened with an expired session is refused 401 and the client shows the pairing form rather than reconnecting forever. Tasks 2, 4.

---

### Task 1: SessionStore

**Files:**
- Create: `server/session.ts`, `server/session.test.ts`

**Interfaces:**
- Produces:
  - `SESSION_TTL_MS = 28_800_000`, `MAX_SESSIONS = 20`, `SESSION_COOKIE = 'vo_session'`
  - `createSessionStore(opts: { now: () => number }): SessionStore`
  - `SessionStore = { create(): { id: string; expiresAt: number }; valid(id: string | undefined): boolean; destroy(id: string | undefined): boolean; readonly size: number }`
  - `sessionIdFromCookie(header: string | undefined): string | undefined` — parses a `Cookie` header, returns the `vo_session` value or undefined (tolerates spaces, other cookies, duplicate names → first wins, values over 128 characters → undefined).

- [ ] **Step 1: Write failing tests:** `create` returns a 43-character base64url id and each call differs; `valid` is true until `expiresAt` and false at and after it; `destroy` makes `valid` false and returns true once then false; the 21st `create` drops the oldest (`valid(first)` false, `size` 20); an unknown or `undefined` id is invalid; only hashes are stored (`JSON.stringify` of the store internals, exposed through a test-only `debugKeys()` or by inspecting that `valid` of the id's hash string is false); `sessionIdFromCookie('a=1; vo_session=abc; b=2')` is `'abc'`, `'vo_session=x; vo_session=y'` is `'x'`, a missing header or a 129-character value is `undefined`.
- [ ] **Step 2: Run** `rtk proxy npx vitest run server/session.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the module: ids from `randomBytes(32).toString('base64url')`; the map keyed by `createHash('sha256').update(id).digest('hex')`; purge expired entries lazily in `create` and `valid`.
- [ ] **Step 4: Run the tests** — expect PASS; commit `feat(server): in-memory session store`.

### Task 2: Pairing routes, cookie auth and CSRF guard

**Files:**
- Modify: `server/http/guards.ts` (`GuardOptions`, `createSecurityGuards`, `securityHeaders`, preflight), `server/http/routes.ts` (or a new `server/http/sessionRoutes.ts` imported by it), `server/http/router.ts` (`RejectCode` if a new code is needed), `server/audit.ts` (`AuditAction`), `server/app.ts` (create the store, pass it to guards and routes), `server/http/guards.test.ts`
- Create: `server/http/sessionRoutes.ts`, `server/http/sessionRoutes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`SessionStore`, `SESSION_COOKIE`, `sessionIdFromCookie`, `SESSION_TTL_MS`), `tokenMatches` from `server/auth.ts`.
- Produces: `GuardOptions` gains `sessions: SessionStore`; `AuditAction` gains `'session.created' | 'session.ended' | 'session.rejected'` (records carry `requestId` and a reason code only); routes `POST /api/session` (body `{ token: string }`, unknown keys → 400; 200 `{ ok: true, expiresAt: string }` + `Set-Cookie`; 401 / 429 as in the constraints) and `DELETE /api/session` (needs auth; 204 + `Set-Cookie: vo_session=; Max-Age=0; …`).

- [ ] **Step 1: Write failing tests** against the real server helpers used by `server/http/routes.test.ts`: correct token → 200 and a `Set-Cookie` with exactly the attributes in the constraints (`HttpOnly`, `SameSite=Strict`, `Path=/api`, `Max-Age=28800`, no `Secure` over `http:`, `Secure` when the request `Origin` is `https:`); the cookie value is not the token; the response body contains no token and no id; wrong token, missing token and a non-string token → 401 `Unauthorized.` with no `Set-Cookie`; unknown body key → 400; the 11th wrong attempt within a minute → 429 and a correct token is still refused until the minute passes (injected clock); `GET /api/state` with the cookie and no `Authorization` → 200; with a destroyed or expired id → 401; `POST /api/tasks/.../cancel`-style mutation with cookie only and **no** `Origin` → 403; with an `Origin` outside the allowlist → 403; with an allowed `Origin` → success; the same mutation with the bearer token and no `Origin` still works; `DELETE /api/session` with the cookie → 204, clears the cookie, and the same cookie is then 401; `GET /api/events` with the cookie opens a stream and with a bad id → 401; preflight and normal replies for an allowed `Origin` carry `access-control-allow-credentials: true`, and never for a disallowed one; the audit log has `session.created` and `session.ended` records and neither the token nor the session id appears anywhere in the audit file or in captured log output.
- [ ] **Step 2: Run** the new tests — expect FAIL.
- [ ] **Step 3: Implement.** In `guards.ts`, the `auth` guard accepts `tokenMatches` **or** `sessions.valid(sessionIdFromCookie(req.headers.cookie))`; remember which one succeeded so a new guard step (before `jsonOnly`) can refuse a cookie-only mutation without an allowed `Origin`. `POST /api/session` is exempt from the auth guard like `/api/health`. The failure counter is a fixed-window counter held in `sessionRoutes.ts`. The handler uses `tokenMatches`-style constant-time comparison on the body token. `securityHeaders` adds `access-control-allow-credentials: true` next to the existing `access-control-allow-origin` for allowed origins only; the preflight reply does too. Set-Cookie goes out through the router's `headers` reply field.
- [ ] **Step 4: Run** the new tests and `rtk proxy npm test` — expect PASS; commit `feat(server): browser session cookie, pairing routes and CSRF guard`.

### Task 3: Real-server end-to-end test of the session flow

**Files:**
- Modify: `server/e2e/realServer.test.ts` (new `describe` block) or create `server/e2e/session.test.ts`

**Interfaces:**
- Consumes: `startServer` as the existing e2e test does; Task 2 routes.

- [ ] **Step 1: Write the tests** over real HTTP (and the existing SSE test client): pair, then `GET /api/state` and an SSE stream using only the cookie; `POST` a mutation with the cookie and an allowed `Origin`; logout ends the stream's ability to reconnect (a new stream with the old cookie is 401); a second `startServer` run (restart) rejects the first run's cookie; a pairing from `Host: localhost:<port>` sets a cookie that a request to `127.0.0.1:<port>` does not carry — assert this by the cookie's lack of a `Domain` attribute (host-only) rather than by emulating a browser; hostile `Origin` (`http://evil.example`) on pairing → 403 and no `Set-Cookie`; `GET /api/health` still needs nothing.
- [ ] **Step 2: Run** — expect PASS (fix only what real HTTP reveals, in the owning module with its own test); commit `test(server): browser session end to end`.

### Task 4: Browser client, pairing screen and docs

**Files:**
- Modify: `src/workforce/remote/client.ts` (`credentials: 'include'`, a `pair(token)` call), `src/workforce/remote/sync.ts` and `remoteController.ts` (`withCredentials: true` on the EventSource, a `needsPairing` flag from a 401, a `reconnect()` after pairing), `src/workforce/controller.ts` (`WorkforceController.pair?(token: string): Promise<{ ok: true } | { ok: false; error: string }>` and `WorkforceSnapshot.needsPairing: boolean`, false in browser mode), `src/workforce/ui/WorkforcePanel.tsx` plus a new `src/workforce/ui/PairingForm.tsx` and its test, the client/sync/controller tests, `docs/browser-auth.md`, `README.md`, `.env.example` if it mentions the token flow
- Create: `src/workforce/ui/PairingForm.tsx`, `src/workforce/ui/PairingForm.test.tsx`, `docs/milestone-3b4-stage-d-report.md`

**Interfaces:**
- Consumes: Task 2 `POST /api/session`.
- Produces: `ApiClient.pair(token: string): Promise<ApiResult<{ ok: true; expiresAt: string }>>`; `needsPairing` set when a snapshot load or the event stream returns 401 and cleared after a successful pairing; `PairingForm` (props `{ onPair(token: string): Promise<{ ok: boolean; error?: string }> }`): a password-type input, a submit button, shows the server's fixed error text, clears the field after every attempt, never stores the token (no `localStorage`, no state outside the input's own value during submit), and tells the person to open the app at the same address they used to start the backend (`127.0.0.1` vs `localhost`).

- [ ] **Step 1: Write failing tests:** `client.test.ts` — requests are sent with `credentials: 'include'`; `pair` posts `{ token }` as JSON with `MUTATION_HEADERS`; a 401 from `get` still yields `NOT_AUTHORIZED`. `sync.test.ts` — the EventSource factory is called with `withCredentials: true` (change the factory type to `(url: string, opts: { withCredentials: boolean }) => EventSourceLike`; the default builds `new EventSource(url, opts)`); a 401 on the snapshot sets `needsPairing: true` and does not enter the reconnect backoff; `reconnect()` after pairing loads the snapshot again and clears the flag. `remoteController.test.ts` — `pair` calls the client then reconnects, and returns the server's error text on failure. `PairingForm.test.tsx` — submitting calls `onPair` with the typed value, the input is `type="password"`, the field is empty after a failed attempt and the error text is shown, no `localStorage`/`sessionStorage` write happens (spy on `Storage.prototype.setItem`). `WorkforcePanel` renders the form only when `needsPairing` is true and the old "Not authorized" hint is gone from that case.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the code above following the signatures; the proxy path (`baseUrl === ''`) keeps working: with the proxy a 401 cannot happen, so `needsPairing` stays false.
- [ ] **Step 4: Docs.** `docs/browser-auth.md`: replace "The cookie flow is not built" with the built design, keep the proxy section, state the real limits (sessions in memory and lost on restart, HTTP only so no `Secure` flag until TLS, a local program holding the token can pair too, same-user processes out of scope). `README.md`: how to pair. `docs/milestone-3b4-stage-d-report.md` in the format of `docs/milestone-3b4-stage-e-report.md` with real verification results, audit blocker B4 status (closed for the backend and the browser; the proxy limitation stays documented), and what is left (stages F and G).
- [ ] **Step 5: Run** the full verification list from Global Constraints; commit `feat(web): browser pairing screen and session credentials` and `docs: milestone 3B.4 stage D report`.

## Self-review notes

- **Spec coverage:** `docs/browser-auth.md` pairing, cookie attributes, rotation by restart, logout, CSRF layers, localhost vs 127.0.0.1, bearer kept, browser-code changes (credentials, `withCredentials`, Connect screen) and CORS credentials for exact origins are all covered (Tasks 2, 4); "works without the proxy" is proved by Task 3.
- **Decisions to confirm:** the 8-hour lifetime and 20-session cap; cookie-only mutations require an allowed `Origin`; failed-pairing limit of 10 per minute; `Secure` only when the request `Origin` is `https:` (no TLS exists yet); the pairing input holds the token only during submit.
- **Types:** `SessionStore`, `SESSION_COOKIE` and `sessionIdFromCookie` are defined once (Task 1) and only consumed later; `needsPairing` and `pair` are defined once in Task 4.
