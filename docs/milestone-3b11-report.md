# Milestone 3B.1.1 — Security Hardening & E2E Verification: Final Report

**Brief:** [`plan.md`](../plan.md) · **Tasks:** [`tasks.md`](../tasks.md) · **Date:** 2026-10-31

> **The Claude Agent SDK is not installed or integrated, and no real agent execution exists.** The backend runs the mock runtime only. **Sandbox isolation is not implemented:** `docs/sandbox-architecture.md` is a design only, and Docker is not even installed on the machine this was built on. Every workspace, tool and token check described below is a policy check on the host, not isolation.

## 1. Verdict: READY WITH ISSUES

Every item the brief asked for is built and tested, the whole milestone had an independent security review, and its Critical finding (the dev server serving the token file) is fixed with a test that failed first. It is not READY because of the open items in section 10: most importantly, a real Claude runtime must not be switched on before the SDK's built-in tools are replaced by gated tools and the sandbox exists.

## 2. Files changed

Stages and PRs: A #27 (workspace, redaction), B #28 (tool gate), C #29 (API token, dev proxy), D #30 (sandbox design), E this PR (end-to-end test, review fixes, report).

- **New:** `server/toolGate.ts`, `server/auth.ts`, `scripts/apiProxy.ts`, `server/e2e/realServer.test.ts`, `docs/sandbox-architecture.md`, `docs/milestone-3b11-report.md`; tests `server/toolGate.test.ts`, `server/auth.test.ts`, `scripts/apiProxy.test.ts`, `scripts/viteServes.test.ts`.
- **Modified (server):** `workspaces.ts`, `toolPolicy.ts`, `redact.ts`, `taskManager.ts`, `config.ts`, `app.ts`, `audit.ts`, `http/guards.ts`, `http/router.ts`, `runtime/types.ts`, `runtime/mockProvider.ts`, `runtime/claudeAgent.ts` (documentation block only), `test/*` helpers.
- **Modified (frontend and scripts):** `src/workforce/source.ts`, `remote/client.ts`, `vite.config.ts`, `scripts/devFull.ts`, `scripts/secretScan.ts`, `scripts/checkSecrets.ts`.
- **Docs and config:** `README.md`, `.env.example`, `tasks.md`; the 3B.1 plan and tasks were archived under `docs/milestones/`.

## 3. Workspace validation

- `resolveWorkspace` compares against the real root stored at startup; a root swapped for a symlink fails `escapes_root`.
- A path through a regular file (`notes.md/x`) is refused; `..` anywhere in a path is refused.
- Write and Edit always need a workspace (`no_workspace`). The lexical-only fallback is gone.
- Paths and symlinks are judged on the file system as it is at each call; tests re-point a symlink and move or rename folders between two calls. No root or workspace path appears in state, workspace or error responses; approval summaries hide it as `<workspace>`.
- Mock demo without a workspace: the simulated run raises its own approval (the demo button still works in the default setup).

## 4. Redaction

Patterns in the one existing module (`server/redact.ts`): `scheme://user:pass@` URLs, `gh[pousr]_…` and `github_pat_…`, `AKIA`/`ASIA` keys, `Basic <base64>` (only when it decodes to printable `user:pass`), `--password|--passwd|--pass|--token|--secret|--api-key…` arguments, `curl -u` and `--user` credentials, plus the existing `sk-…`, Bearer and key/secret/token/password rules.
- **Tests:** positive cases for each; negative cases that must stay untouched (`https://example.com/@user`, `ssh://git@host`, git SHAs, short or embedded `AKIA`, "Basic configuration", `--password-file ./x`, `password_reset.md`, `curl -u admin`); a cost test on long near-matches; one test each for runtime messages, failures, the audit log and tool summaries (a command containing one becomes `not_reviewable`).
- **Not covered:** JWTs, Slack `xox…`, Google `AIza…`, PEM private keys, `-p <password>`, URLs whose password contains `@` or `/`.

## 5. Tool gate and how it constrains the Claude SDK

A runtime gets `ctx.tools.use(request, perform)` and nothing else: no policy, no approval id, no raw approval function. The gate takes a frozen deep copy of the input, asks the existing policy and approval flow, then, immediately before `perform`, checks that the task is still running, re-resolves the workspace, recomputes the digest of task, workspace (id and real path), tool and input, and re-runs the policy on the frozen input. Any difference is `stale_approval` (audited `tool.stale`) and `perform` does not run. `perform` receives only the frozen input and the checked workspace. Write and Edit approvals show the whole content or change, or nothing is asked. Only the mock may raise an approval of its own.
- **How the SDK plugs in** (documented in `server/runtime/claudeAgent.ts`): `canUseTool` calls `ctx.tools.use` and returns the SDK's allow result with `updatedInput` set to the frozen input; `permissionMode: 'default'`; empty auto-approve list; `disallowedTools` for everything outside the catalogue plus Bash, WebFetch and WebSearch until the sandbox exists; `settingSources: []`; no hooks that approve; no extra directories. Option names must be checked against the installed SDK.
- **Known gap:** the SDK's built-in Write and Edit run after `canUseTool` returns, so the use-time check and the file access are two steps. Close it in 3B.2 with in-process MCP tools whose handler is `perform`, plus the sandbox.

## 6. Authentication and frontend integration

- Every API route except `GET /api/health` needs `Authorization: Bearer <token>`, including the event stream and requests with no `Origin`. The token is `API_TOKEN` (32+ characters) or a fresh 256-bit value generated at each start into `data/api-token` (mode 0600, written through an exclusive temporary file). It is compared in constant time, never read from a URL, and kept out of logs, audit records, responses, state and the bundles (`check:secrets` looks for it). `VITE_`-style names for secrets are refused.
- **Browser:** `VITE_WORKFORCE_API_URL=/` means same origin. The Vite dev server's Node-side gate (`scripts/apiProxy.ts`) replaces `Authorization` and `Cookie`, adds the token and forwards `/api/*` for requests marked `Sec-Fetch-Site: same-origin`; `dev:full` sets it up. A 401 shows "Not authorized…" and never falls back to the browser mock. `npm run dev` and `/vo` stay browser-only.
- **Limits:** the proxy exists only where Vite runs. A local program that can reach port 5173 can send that header itself, so while the proxy runs the token protects against web pages and programs talking to the backend directly, not against other local programs. The Vite dev server is configured never to serve the `data/` folder and only for `localhost` and `127.0.0.1`.

## 7. Sandbox architecture and remaining work

`docs/sandbox-architecture.md` (design only): one non-root container per task, one mounted workspace, read-only root with tmpfs, no Docker socket, no network, CPU, memory, process, output and time limits, labelled cleanup with a start-up sweep, an environment allowlist, no stored credentials; `perform` runs the action inside it. Recommended split: the Claude session on the host, tools in the container through gated in-process tools. Ten blockers are listed (server access to Docker vs the no-process-execution guard, macOS VM semantics, Linux user ids, output caps, image supply, and testing only where Docker runs). Nothing is implemented; no container is started anywhere.

## 8. End-to-end test

`server/e2e/realServer.test.ts` starts the real server on a random port and uses only real HTTP and a real event stream: health open, state 401 then 200, unauthorized mutations and streams refused with and without an Origin (and `?token=` ignored), bad workspaces (400, 422), queued, started and status events, the demo approval through the gate to completed, cancel with the final state agreeing, resume from `Last-Event-ID` with only newer events, and `state.reset` for an old boot id. With the token removed, all 7 tests fail; with it, all pass. It does not go through the Vite proxy; that path was checked by hand and by `scripts/viteServes.test.ts` and `scripts/apiProxy.test.ts`.

## 9. Build, type, test and security checks (2026-10-31)

- `npm test`: 822 tests pass (63 files). `npx tsc -b`: clean.
- `npm run build`, `npm run server:build`: pass (the 500 kB main-chunk warning remains). `npm run check:secrets`: no secrets (12 files). `grep "api-token\|Bearer " dist/`: nothing. `npm audit`: 0 vulnerabilities.
- Built bundle smoke test (`node dist-server/index.js`): health 200, state without a token 401, with the token 200, token not in the log, token file mode 600.
- Browser, backend mode (`npm run server` plus `VITE_WORKFORCE_API_URL=/ npm run dev`): `Live`; approve to Completed; deny to Failed ("Approval denied (simulated)"); cancel to Cancelled; a server restart showed `Offline · last synced …`, then `Live`, the task Failed with "Interrupted by a server restart", the token rotated (the old one now gets 401), no duplicated activity, console clean.
- Browser, `/vo` mock mode: the 3D office renders, the editor and floor plan open, a mock task goes through approval to Completed, badge `Mock · browser`, no `/api` requests, console clean.
- Independent review: an Opus reviewer read the whole milestone for security. Findings and what was done are below.

**Review outcome.** Fixed, each with a test that failed first: the dev server served `data/api-token`, `audit.log` and `workforce.json` (Critical; now denied, and only `localhost`/`127.0.0.1` hosts are allowed); Write and Edit approvals did not show the whole action (now content shown or refused); a real runtime could raise an approval outside the gate (now only the mock may); glob patterns could escape through `{..,x}` (any `..` is refused); a planted `api-token.tmp` could be followed (now removed and opened exclusively); `curl -u` and unpadded Basic credentials were not redacted; Bash approval summaries could show host paths (now hidden). Rulings: the `Sec-Fetch-Site` weakness is documented, not fixed (the fix is a cookie pairing flow, out of this milestone's scope); the comments that overstated "never sees the workspace path" and "stops every other local program" were corrected.

## 10. Remaining blockers before Milestone 3B.2 and deferred findings

**Must be done before any real execution:**
1. Replace the SDK's built-in Write and Edit with gated in-process tools whose handler is `perform`, and implement the sandbox (blocker list in the design doc, starting with how the server may reach Docker without breaking the no-process-execution guard).
2. Decide how the browser authenticates beyond the dev proxy (cookie pairing) before anything leaves this machine, and whether to keep the token out of `ServerConfig` (it is held there in memory, so the config must never be logged or serialised).
3. A richer review screen for large writes: a change too long to show is currently refused rather than approved.

**Deferred minors:**
- The digest is recomputed and compared at use time but is not stored or shown at ask time; no protection between the final re-check and `perform` itself (path strings, not file descriptors; hard links inside a workspace); `GatedAction` has no abort signal.
- Two servers sharing one `DATA_DIR` overwrite each other's token; `GET /api/health` (open) can return a raw save-error message that contains the data directory path.
- More redaction shapes (JWT, `xox…`, `AIza…`, PEM, `-p`); a password containing `@` or `/` in a URL.
- The proxy's prefix edge cases (`/api` and `/apiX` reach the backend without a token and get 401; `/API/` and encoded forms are not proxied).
- Test gaps: the proxy against a real Vite server with SSE (checked manually only), a task-manager plus gate stale-approval integration test, the `readdirSync` assertion in the end-to-end test is vacuous (the mock's `perform` writes nothing).
- Stage D deferred minors from 3B.1 that are still open (see `docs/milestone-3b1-report.md`), and the sandbox design's own blockers.
