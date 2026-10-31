**Decision record. The cookie flow is not built.**

# How the browser authenticates to the backend, long term

## What we protect against

| Who | What they could do | Stopped today by |
|---|---|---|
| A web page in the same browser (any site) | Call the API from JavaScript | Host and Origin checks, JSON-only mutations, the bearer token. A page cannot read `data/api-token` (the Vite dev server refuses to serve `data/`) |
| Another program on this machine that talks to the backend directly | Call `127.0.0.1:8787` | The bearer token (401 without it) and the 0600 token file |
| Another program on this machine that can reach the **dev proxy** (port 5173) | Send `Sec-Fetch-Site: same-origin` itself and be given the token | **Nothing.** See below |
| Another machine on the LAN | Connect | The backend binds to loopback only and refuses any other `HOST` |
| A future VPS deployment | All of the above plus the internet | Not designed yet; needs TLS and the cookie flow below |

## What the dev proxy is, and is not

The dev proxy (`scripts/apiProxy.ts`) adds the token on the server side so the page never holds it. It lets a request through only when the browser says it is same-origin (`Sec-Fetch-Site: same-origin`).

**`Sec-Fetch-Site` is not authentication.** Browsers set it and page code cannot change it, but any other program can send whatever header it likes. So while the proxy runs, any local program that can reach port 5173 gets an authenticated path to the backend. The proxy protects against web pages and against programs that go to the backend directly; it does not protect against other local programs, and it must not be described as doing so. It is a development convenience, acceptable because Vite already serves the whole source tree to anyone who can reach that port.

## The options

| Option | How | Verdict |
|---|---|---|
| A. Dev proxy injects the header (today) | The browser calls same-origin `/api/*`; Node adds the token | Fine for local development. Not authentication against local programs. Exists only where Vite runs |
| **B. HttpOnly session cookie after a one-time pairing (decision)** | The person pastes the token once; the server answers with a cookie the page's JavaScript cannot read; the browser sends it on every request, including `EventSource` | Works with any way of serving the UI, proves the person holds the token, and JavaScript never keeps it |
| C. Token in JavaScript, header on every request, fetch-streamed events | Replace `EventSource` with `fetch` and a stream parser | Rejected: the page must hold the token (reachable by any script on the page), and we would re-implement stream parsing and reconnects |

**Decision: B, before anything leaves this machine.** The dev proxy stays for local development; the cookie flow is what a VPS or any shared machine needs. Nothing about B is built yet.

## The cookie design

- **Pairing:** `POST /api/session` with `{ "token": "…" }` in the JSON body (never in a URL). On success the server sets `vo_session`; the token itself is not stored in the cookie. The cookie holds a random session id, kept in server memory with an expiry.
- **Cookie attributes:** `HttpOnly`, `SameSite=Strict`, `Path=/api`, `Secure` once there is TLS, a lifetime of hours, not days.
- **Rotation and logout:** restarting the server (generated token) or changing `API_TOKEN` drops every session. `DELETE /api/session` ends one. A new pairing is needed after each rotation.
- **CSRF:** `SameSite=Strict` stops cross-site requests from carrying the cookie; the existing JSON-only rule and the Origin allowlist stay as a second and third layer. State-changing routes keep requiring `Content-Type: application/json`.
- **`localhost` vs `127.0.0.1`:** cookies belong to a host name, so a session made on one does not exist on the other. The UI should say which address to use, and the Origin allowlist already lists both.
- **The bearer token keeps working** for programs (`curl -H "Authorization: Bearer …"`), unchanged.

## What changes in the browser code

`src/workforce/remote/client.ts`: `fetch(..., { credentials: 'include' })`; `sync.ts`: `new EventSource(url, { withCredentials: true })`; CORS answers with `Access-Control-Allow-Credentials: true` for exact origins only (never `*`); a "Connect" screen replaces the "Not authorized" hint, with the pairing form. `source.ts` accepts a full backend origin again, because no proxy is needed.

## The rule: the token is never in a URL, a log, a bundle or an error

| Where it must not appear | Enforced by | Tested in |
|---|---|---|
| URLs and query strings | the token is read from the `Authorization` header only; the router logs paths without query strings | `server/auth.test.ts` (`?token=` ignored), `server/http/disclosure.test.ts` (no query in logs) |
| Logs and audit records | `Secret` and `ApiToken` print as `[REDACTED]` or their source only; the audit log records `auth=configured\|generated`; the redacting logger | `server/secret.test.ts`, `server/auth.test.ts` (never leaks) |
| Frontend bundles | no `VITE_` secret variable is accepted; `check:secrets` looks for the token value and the `api-token` file name outside the server bundle | `server/config.test.ts`, `scripts/secretScan.test.ts` |
| Error messages and responses | errors leave as codes or fixed sentences; the token file and data folder are never served | `server/http/disclosure.test.ts`, `scripts/viteServes.test.ts`, `scripts/viteProxy.test.ts` |
