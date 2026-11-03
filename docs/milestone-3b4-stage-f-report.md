# Milestone 3B.4 stage F: permission UI — report

Date: 2026-11-03. Plan: `docs/superpowers/plans/2026-11-03-milestone-3b4-stage-f-permission-ui.md`. Audit: `docs/milestone-3b4-final-report.md` (blocker B5). Earlier reports: `docs/milestone-3b4-stage-c-report.md`, `docs/milestone-3b4-stage-e-report.md`.

Frontend only; no server file changed. Still true: no SDK, no real Claude execution, mock runtime only, and the mock demo still writes nothing.

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npx vitest run` | 90 files, 1523 tests pass |
| `npx tsc -b` | clean |
| `npm run build` | built |
| `npm run server:build` | built |
| `npm run check:secrets` | no secrets found (12 files checked) |
| `npm audit` | 0 vulnerabilities |
| Real browser (`dev:full`, Chromium, mock runtime, a temporary data folder) | see below; screenshots in `docs/screenshots/3b4-f/` |

## What changed

- **Commands and decision values** (`f1d210b`): `ApprovalChoice` (`approve`, `deny`, `allow_once`, `allow_task`, `allow_agent`, `reject`) is sent by `decideApproval`; the local mock maps any allow to approve and `reject` to deny. `createPermission`, `revokePermission` and `revokeAgentPermissions` are REST calls that hand the server's refusal text back to the caller. They exist in backend mode only.
- **Live permissions state** (`793e6a8`): `src/workforce/permissions.ts` holds the active list (oldest first) and history (newest first, 200 at most). `remote/sync.ts` loads both lists after every snapshot (first load, reconnect, `state.reset`) and applies `permission.changed` events, which it now subscribes to (the name is not in `WORKFORCE_EVENT_TYPES`, so before this stage the browser never received them). An event that arrives while the lists load is applied again on top of them. A failed or malformed list keeps the old lists and records one error. `permissions` is `null` in browser mode and when the backend address is misconfigured, and no request is made then.
- **Permissions panel** (`9f970b7`): Global and per-agent tabs, Active and History, a "Waiting for a decision" block, revoke and "revoke all for this agent" through the existing confirm dialog, the server's error shown on a refusal. Every state has a word and an icon.
- **Scoped approval** (`c1e8d7b`, then the Once-only fix): with a backend the approval card shows Once / This task / This agent, a sentence that says what the choice grants, Allow and Reject. The browser demo keeps Approve and Deny. A chip in the agent header shows "Approval required", the rule count, or nothing before the first load.

## Found in the browser, not by the unit tests

A simulated approval has no digest, and the server accepts only Once for it (`That approval can only be allowed once.`, `server/taskManager.ts`). The first version offered all three scopes for any file tool, so a person who picked "This task" got a 422. `allowedScopes(tool, digest)` now gives Once only when the digest is `null` or the tool is Bash, WebFetch or WebSearch, and the form says why. Tests cover both.

## Browser run

Done against the real backend and Vite dev server, two tabs:

- A deny rule created through the API appeared in both open tabs without a reload.
- A rule with `<img src=x onerror=alert(1)>` as its reason showed as text; no `img` element was created.
- Revoking from the confirm dialog in tab A moved the rule to History in tab B.
- A simulated approval: Allow (once) let the task continue; Reject failed the task with "Approval denied". Allow with "This task" on a simulated approval was refused by the server, which led to the fix above.
- At 360 px wide the tabs wrap (screenshot `08-narrow.png`; horizontal overflow was not measured); Tab moves focus onto a button.

## Security implications

- The browser remains no authority. It sends a choice; the server checks the digest, the scope and the tool's ceiling, and the UI shows the server's text unchanged.
- Rule text (`reason`, `pathPattern`, `tool`) is React text; a test and the browser run show markup stays text.
- Allow stays disabled until the full change is open, for every scope. Reject is never held back.
- The list bodies are validated before use; a malformed list is a failed load, never an empty list that would read as "no rules".

## Limits, stated plainly

- **A wider scope was not exercised end to end.** The mock demo requests no real tool, so there is no approval with a digest in a running app. Task and agent allows are covered by the component and view tests and by the server's own tests (stage B), not by a click in a real run.
- **No DOM test library is installed.** Component tests render to static markup. Clicks, focus movement, the confirm dialog flow, the busy state after a 409 and the radio reset on a new approval id are not simulated in a test; they follow from the code (`useBusy`, a choice keyed by approval id) and were checked by hand only where listed above.
- The confirm dialog does not return focus to the button that opened it (existing `ConfirmDialog` behaviour, unchanged).
- A history rule's order is the order events arrive in; after a reload it is the server's.
- The favicon request returns 404 in dev (unrelated, already so on `main`).

## What stage G still needs

An end-to-end test with the real backend and SSE (a `permission.changed` event through the real stream into the real sync), a decision on adding a DOM test library, and the final `docs/milestone-3b4-report.md`.
