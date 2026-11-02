# Milestone 3B.4 stage D: browser session — report

Date: 2026-11-02. Plan: `docs/superpowers/plans/2026-11-02-milestone-3b4-stage-d-browser-session.md`. Audit: `docs/milestone-3b4-final-report.md`. Earlier reports: `docs/milestone-3b4-stage-e-report.md`. Design and as-built notes: `docs/browser-auth.md`.

The backend (sessions, pairing routes, guard, CORS credentials, stream shutdown) and the browser (credentials on every request and stream, a pairing screen) are done. Still true: no SDK, no real Claude execution, mock runtime only.

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `rtk proxy npm test` | 86 files, 1432 tests pass |
| `npx tsc -b` | clean (no errors) |
| `npm run build` | built (the existing chunk-size warning only) |
| `npm run server:build` | built (`dist-server/index.js`) |
| `npm run check:secrets` | no secrets found (12 files checked) |
| `npm audit` | 0 vulnerabilities |

During stage D one full run showed a single failing test that was not captured (which test failed was not recorded); the next run passed. Intermittent timing failures under parallel load were seen in earlier stages in `server/redact.test.ts` and `server/secrets.test.ts`, and one reappeared in `server/redact.test.ts` (the JWT linear-time check) during the final fix wave. The final runs passed 1432 of 1432. No real browser was run: the pairing form is covered by component tests that render to markup and by tests of its submit logic (the project has no DOM test environment; the refocus after a failed attempt is only checked against the component source).

## What changed

Commits on this branch (`git log --oneline main..HEAD`):

- `1b39132` docs: milestone 3B.4 stage D plan, browser session
- `47d03bb` feat(server): in-memory session store
- `b2eb8fe` feat(server): browser session cookie, pairing routes and CSRF guard
- `1539c7a` fix(server): throttle session audit, clear stale cookie, Retry-After
- `e89e584` test(server): browser session end to end
- `98d4c99` fix(server): end event streams when their session ends
- `4fe0ba1` feat(web): browser pairing screen and session credentials
- `536f077` docs: milestone 3B.4 stage D report
- `32efc99` fix(server): accept any valid session cookie, harden session end listeners
- `51deafa` fix(web): explain cross-host pairing, gate every view, reconnect on command 401
- (this commit) docs: correct SameSite claims, document pairing limits and host rules

Browser (`4fe0ba1`):

- `fetch` always sends `credentials: 'include'`; `ApiClient.pair(token)` posts `{ token }` to `/api/session`. A 401 from `pair` reads "That token was not accepted."; a 429 shows the server's text.
- The EventSource factory is `(url, { withCredentials }) => EventSourceLike`; sync passes `{ withCredentials: true }`.
- `needsPairing` is set when the snapshot GET returns 401, including after a stream error (the existing retry re-fetches the snapshot). A 401 starts no backoff timer. `RemoteSync.reconnect()` starts again; a successful snapshot clears the flag.
- `WorkforceController.pair?(token)` (backend only): client call, then `sync.reconnect()`, returns `{ ok: true }` or the error. Never stores the token. Browser mode has `needsPairing: false` and no `pair`.
- `PairingForm`: password input, `autocomplete="off"`, no spellcheck, disabled while submitting, cleared after every attempt, error in `form-error`. `WorkforcePanel` shows it instead of the offline error and the waiting hint only when `needsPairing` is true and the controller can pair.

## Security implications

- The token is typed once and exchanged for an HttpOnly cookie that page scripts cannot read; open pages hold no token, and the controller, client and sync keep none.
- The token lives only in the input's own value until submit; it is read and the field emptied before the request, and again after the answer. No `localStorage`, `sessionStorage` or React state ever holds it.
- The built UI text does not name the token file (`check:secrets` fails any frontend bundle that mentions it), so the form says "the token file in the backend's data folder".
- The dev proxy still strips `Cookie` and injects the bearer, so pairing is never needed in `dev:full`, and a direct-origin setup needs an allowed Origin (browsers add it) for cookie-only mutations.
- Event streams end when the session ends, so a logged-out or expired browser cannot keep receiving events.

## Residual limits

- Sessions are in memory: a backend restart drops all of them and the person pairs again. Lifetime 8 h; at most 20 sessions (the oldest is dropped).
- HTTP only: no `Secure` flag until TLS exists. Do not expose the backend beyond loopback before then.
- Pairing is limited to 10 failures per minute.
- Event streams end at logout or expiry; the browser notices on the next retry and shows the form.
- Cookie-only mutations need an allowed `Origin`.
- A local program holding the token can pair too (it is the bearer's secret). Same-user processes are out of scope without a sandbox.
- A session made on `127.0.0.1` is not valid on `localhost`. When the page host differs from the backend host the form says so and names both hosts; if pairing succeeds but the cookie is not kept, `pair` reports that.
- `SameSite=Strict` does not separate loopback ports (same host name, any port is same-site) and the cookie is host-only with `Path=/api`, so the browser sends it to any local web server on that host name under `/api/*`. Another local port's page is stopped by the Origin allowlist (every method; preflight refused 403), CORP and HttpOnly, not by SameSite. Another local web server that sees the cookie could replay the session id with a forged Origin for up to 8 h; use a dedicated host name or restart the backend. Later hardening: a narrower cookie path under a unique API prefix, or `__Host-` plus `Secure` once TLS exists.
- While the pairing limit is active even the correct token is refused (10 wrong tokens a minute from a local program locks pairing).
- A session can outlive a logout by the time a request body takes to upload.
- The dev proxy limitation stays: any local program that can reach port 5173 gets an authenticated path while it runs (`docs/browser-auth.md`).
- Not verified in a real browser (no DOM test environment; manual check is left for stage G).

## Audit blockers (`docs/milestone-3b4-final-report.md`)

- **B4:** closed for the backend (sessions, guard, CSRF layers, CORS credentials for exact origins) and for the browser (pairing, credentials, no token in the page). The dev proxy limitation remains, documented.

## What is left

- A logout control in the UI (stages F or G).
- Tighter end-to-end tests: the liveness check should match the cookie-paired event, a total-count logout check, and a multi-stream case.
- **F (UI):** pending-approval and queue visibility, path pattern choice, and opting in to `permission.changed`.
- **G:** end-to-end test (including a real-browser pairing check) and the closing 3B.4 report.
- Later, outside 3B.4: the SDK provider and the sandbox; TLS (and then the `Secure` cookie flag) before any remote deployment.
