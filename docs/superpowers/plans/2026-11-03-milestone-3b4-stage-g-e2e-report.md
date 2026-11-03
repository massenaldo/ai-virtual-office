# Milestone 3B.4 Stage G: End-to-end permissions test and closing report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Prove, through the real server on a real port and a real event stream, that a person can grant, scope, use and revoke permissions and that `permission.changed` reaches every client; check the app once in a real browser; close milestone 3B.4 with its report. Closes audit item B8. No production code changes unless a test finds a bug.

**Architecture:** Extend `server/e2e/realServer.test.ts` (same style: only HTTP and SSE, no calls into the task manager) with a second `describe`. Then a manual browser check against `npm run dev:full`, then docs.

**Spec:** `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md` (4.4, 4.5, 4.8). Audit: `docs/milestone-3b4-final-report.md` (B8). Stage F report: `docs/milestone-3b4-stage-f-report.md`.

## Global Constraints

- Branch `test/3b4-g-e2e-report`; conventional commits with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- No new dependency (so no DOM test library: decision recorded in the report). No change to `src/` or `server/` outside tests unless a test exposes a defect, which then gets its own `fix:` commit.
- Verification at the end: `npm test`, `npx tsc -b`, `npm run build`, `npm run check:secrets`.

## Review Focus

1. **Event/REST agreement:** the rule in a `permission.changed` event equals the rule `GET /api/permissions` or `/history` returns afterwards. Task 1.
2. **Scope reaches the next call:** an `allow_task` approval lets the same task's next Write through without asking, and a revoke makes it ask again. Task 1.
3. **Ceiling holds over HTTP:** `POST /api/permissions` for `allow` on `Bash` is refused and creates no rule. Task 1.
4. **Replay across a gap:** a client that missed grant and revoke gets both in order on resume, and an unknown boot gets `state.reset`. Task 1.
5. **No secrets on the wire:** no `permission.changed` payload contains a digest. Task 1.

---

### Task 1: Real-server permission test

**Files:** Modify `server/e2e/realServer.test.ts`.

**Interfaces:** Reuses `call`, `state`, `open`, `seqOf`, `types`, `FORGE`, `PM` and the demo approval route `POST /api/demo/tasks/:id/request-approval` already in the file. Adds a local `permEvents(events)` filter returning `PermissionChangedEvent[]`.

- [ ] **Step 1:** Add `describe('permissions, end to end')` with a fresh `open()` stream, and tests, each asserting the REST view agrees with the event:
  - `grants and revokes a global rule: granted then revoked arrive in order; the rule is in /api/permissions, then in /api/permissions/history with state 'revoked'`.
  - `refuses allow for Bash with 4xx and creates no rule, and an unknown agent is 404`.
  - `allow_task: a Write approval with allow_task creates a task rule (event granted, scope 'task'); a second demo Write in the same task needs no approval (event 'used'); DELETE the rule; a third asks again (task.waiting_for_approval)`.
  - `allow_once: the rule is granted then used, and appears in history`.
  - `no permission.changed payload contains a digest` over every event collected.
- [ ] **Step 2:** Add `replays missed permission events with Last-Event-ID in order, and an unknown boot gets state.reset` (grant, close stream, revoke, resume from the grant's id, expect `['revoked']`).
- [ ] **Step 3:** Run `npx vitest run server/e2e/realServer.test.ts` three times; expect all pass each time (flake check).
- [ ] **Step 4:** Commit `test(e2e): permissions over the real server and event stream`.

### Task 2: Real-browser check

**Files:** Create `docs/screenshots/3b4-g/*.png`.

- [ ] **Step 1:** Run `npm run dev:full`; with Playwright (headless) open the app, pair, start a task, request the demo approval, screenshot the approval card with scope choices, choose "this task", screenshot the permissions panel, revoke the rule, screenshot again. If any step fails, record it as a finding and fix with a `fix:` commit if small.
- [ ] **Step 2:** Commit `docs: stage G browser screenshots`.

### Task 3: Closing report

**Files:** Create `docs/milestone-3b4-report.md`, `docs/milestone-3b4-stage-g-report.md`; Modify `docs/milestone-3b4-final-report.md` (status note at top pointing to the closing report).

- [ ] **Step 1:** Run the four verification commands; record real counts.
- [ ] **Step 2:** Stage G report: tests added, browser result, decision "no DOM test library now" (reason: new dependency and config for a gap the browser check and component tests cover; revisit at 3B.5), limits.
- [ ] **Step 3:** Closing report: stages A to G summary, audit blockers B1 to B8 status (closed/open), residual limits (native host, no sandbox, B9 to B11 open), what 3B.5 may start on.
- [ ] **Step 4:** Commit `docs: milestone 3B.4 closing report`.

### Task 4: PR

- [ ] Push and open PR against `main` with a summary and the verification table.

## Self-review

Spec 4.4 (scopes, revoke, queue) → Task 1; 4.5 (events, audit, digest-free) → Task 1; 4.8 UI → Task 2; B8 → Task 1. Review Focus items each map to a Task 1 test.
