# Milestone 3B.4 stage G: end-to-end permissions test and closing report

Date: 2026-11-03. Plan: `docs/superpowers/plans/2026-11-03-milestone-3b4-stage-g-e2e-report.md`. Closes audit item B8.

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npm test` | 90 files, 1529 tests pass |
| `npx vitest run server/e2e/realServer.test.ts` x3 | 13 of 13 pass each time |
| `npx tsc -b` | clean |
| `npm run build` | built (the existing chunk-size warning only) |
| `npm run check:secrets` | no secrets found (12 files checked) |
| `npm audit` | 0 vulnerabilities |

## What changed

Tests only, in `server/e2e/realServer.test.ts` (6 new tests, 7 to 13). The real server on a real port, driven only by HTTP and a real event stream:

- A global grant and its revoke arrive as `permission.changed` `granted` then `revoked`, in order; the rule in each event equals what `/api/permissions` and `/api/permissions/history` return; revoking twice is 409.
- `allow` for `Bash` (global or agent) is refused and creates no rule; an unknown agent is 404.
- `allow_task` creates a task rule; the same task's next Write is not asked; revoking the rule makes the next Write ask again.
- `allow_once` is granted, then used, then in history.
- No `permission.changed` payload contains a digest or a 64-hex string.
- A client that missed a revoke and a grant gets both in order with `Last-Event-ID`; an unknown boot gets `state.reset`.

No production code changed; the tests found no defect.

## Rulings

1. **No DOM test library.** It would add a dependency and configuration for a gap the stage F screenshots and component tests cover. Revisit at 3B.5, when the UI starts to drive real tools.
2. **Task rules emit no `used` event;** only `once` rules do. The first draft of the test assumed otherwise; the server and the spec agree, the test was wrong.

## Limits

- **No browser run in this stage.** Playwright is not installed here. The last real-browser check is stage F's (`docs/screenshots/3b4-f/`). The cookie pairing screen (stage D) has only component tests and has not been clicked through in a browser.
- Revoking a task rule while the task is still running was checked only in the quick window the mock's 1.5 s of work allows.
- Everything still runs on the mock runtime; no real tool touches a file.
