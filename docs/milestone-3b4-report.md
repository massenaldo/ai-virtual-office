# Milestone 3B.4 — closing report

Date: 2026-11-03. Replaces the status in `docs/milestone-3b4-final-report.md` (an audit written before stages D to G existed).

## Result

Stages A to G are merged to `main` (#45, #47, #48, #51, #52, #55, #56, #57). A person can review a pending approval, choose its scope, see and revoke every rule, and see changes live; the server is the only authority and every decision is audited. All of it is proven on the mock runtime. **No SDK and no real Claude execution exists yet.**

| Stage | What | Report |
|---|---|---|
| A | Permission engine and store | `milestone-3b4-stage-a-report.md` |
| B | Gate integration, digests, approvals | `milestone-3b4-stage-b-report.md` |
| C | HTTP API, `permission.changed` events | `milestone-3b4-stage-c-report.md` |
| D | Browser session cookie | `milestone-3b4-stage-d-report.md` |
| E | Gated file tools, `fileOps`, sensitive-path denylist | `milestone-3b4-stage-e-report.md` |
| F | Permission UI | `milestone-3b4-stage-f-report.md` |
| G | End-to-end test over the real server | `milestone-3b4-stage-g-report.md` |

## Verification (real runs on `main` at `55cf913`)

| Check | Result |
|---|---|
| `npm test` | 90 files, 1529 tests pass (1168 after stage C, 1432 after stage D) |
| `npx tsc -b` | clean |
| `npm run build`, `npm run server:build` | both built (the existing chunk-size warning only) |
| `npm run check:secrets` | no secrets found (12 files checked) |
| `npm audit` | 0 vulnerabilities |
| Real server over HTTP and SSE | `server/e2e/realServer.test.ts`, 13 tests, including grant, scope, revoke, replay |
| Real browser (headless Chromium, `dev:full`) | permissions panel, approval card, live rule, revoke, hostile text inert; see `docs/screenshots/3b4-g/` |

The whole milestone changed 122 files (+8171, -201) since the stage A plan. Intermittent timing failures in `server/redact.test.ts` and `server/secrets.test.ts` were seen in earlier stages and did not appear in the final runs (B10 stays open).

## What a person can do now

Review a pending approval with its digest; allow it once, for the task or for the agent (task and agent only where the server accepts it); see every rule by scope and the history; add and revoke rules; see all of it change live in every open tab; pair a browser with a session cookie. Bash, WebFetch and WebSearch are denied by default and can never be allowed above once.

## Audit items

| # | Status |
|---|---|
| B1 gated file tools / `fileOps` | Closed by stage E |
| B2 sensitive-path denylist | Closed by stage E |
| B3 token and data folder readable by same-user processes | Mitigated (denylist, 0600, no Bash); residual same-user risk stays, see `native-host-execution.md` |
| B4 browser session | Closed for backend and browser by stage D; the dev proxy limitation stays documented |
| B5 permissions UI | Closed by stage F |
| B6 TOCTOU | Narrowed by stage E, not eliminated (no `openat`) |
| B7 abort of in-flight calls | Closed as "refused before start"; a call already running is not interrupted; not tested against a real SDK abort |
| B8 end-to-end with SSE | Closed by stage G |
| B9 stale task rules after a restart | **Open** (inert, may show stale entries) |
| B10 redact timing flake, no coverage tool, 1.3 MB chunk | **Open** |
| B11 Bash has no parsing | **Open**; Bash stays always denied |

## Known limits

- Native host execution has no OS sandbox. Path checks are policy, not isolation.
- The cookie pairing screen has no real-browser check (the dev proxy skips pairing); no DOM test library (stage G ruling). Narrow layout and keyboard-only use were not re-checked in stage G.
- **The task and agent scope choice is not reachable from the UI:** a task started in the UI has no workspace, so its approval has no digest and offers Once only. It works over the API and was seen in stage F screenshots. A workspace picker for tasks is needed.
- Real SDK message mapping and real abort are untested.
- The queue behind a pending approval is not visible in the UI.

## Before 3B.5

Do B9 and the redact flake first; add a workspace picker for tasks so the scope choice is usable; add a browser check for pairing without the proxy when the UI starts driving real tools. Nothing else from 3B.4 blocks 3B.5.
