# Milestone 3B.4 — closing report

Date: 2026-11-03. Replaces the status in `docs/milestone-3b4-final-report.md` (an audit written before stages D to G existed).

## Result

Stages A to G are merged or on the stage G branch. A person can review a pending approval, choose its scope, see and revoke every rule, and see changes live; the server is the only authority and every decision is audited. All of it is proven on the mock runtime. **No SDK and no real Claude execution exists yet.**

| Stage | What | Report |
|---|---|---|
| A | Permission engine and store | `milestone-3b4-stage-a-report.md` |
| B | Gate integration, digests, approvals | `milestone-3b4-stage-b-report.md` |
| C | HTTP API, `permission.changed` events | `milestone-3b4-stage-c-report.md` |
| D | Browser session cookie | `milestone-3b4-stage-d-report.md` |
| E | Gated file tools, `fileOps`, sensitive-path denylist | `milestone-3b4-stage-e-report.md` |
| F | Permission UI | `milestone-3b4-stage-f-report.md` |
| G | End-to-end test over the real server | `milestone-3b4-stage-g-report.md` |

Final verification: 90 files, 1529 tests pass; `tsc -b`, build, secrets check and `npm audit` clean.

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
- No real-browser check of the cookie pairing screen; no DOM test library (stage G ruling).
- Real SDK message mapping and real abort are untested.
- The queue behind a pending approval is not visible in the UI.

## Before 3B.5

Do B9 and the redact flake first; add the DOM or browser check for pairing when the UI starts driving real tools. Nothing else from 3B.4 blocks 3B.5.
