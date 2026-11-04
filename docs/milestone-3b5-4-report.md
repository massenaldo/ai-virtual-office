# Milestone 3B.5.4 — real workforce integration: report

Date: 2026-11-04. Branch `feat/3b5-4-workforce-integration`, based on `main` at `b9f022c` (#65). Plan: `docs/superpowers/plans/2026-11-03-milestone-3b5-4-workforce-integration.md`; roadmap: `docs/milestone-3b5-planning.md` §10.

**What this stage is:** mock and Claude tasks run side by side. The person chooses the runtime per task, several agents work at once, and a finished Claude task shows its steps and an estimated cost. Most of the rest of the 3B.5.4 roadmap already existed from earlier stages (the concurrency limit, several agents at once, the activity feed, 3D status from `agent.status`); this stage verified them in the mixed setup and built what was missing: the per-task runtime, the cost, and the UI for both.

**What was not done:** still **no real model run** (no API key; the first real run remains yours, see `docs/first-real-run.md`). Everything with Claude ran against fake sessions, a scripted local API, or the real SDK with a dummy key (which reports a sign-in failure).

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npm test` | 109 files, 2297 tests pass, 10 skipped (the opt-in real-SDK file) |
| `VO_REAL_SDK=1 npx vitest run server/e2e/claudeRealSdk.test.ts` | 10 of 10 with the real SDK binary |
| `npx tsc -b`, `npm run build`, `npm run server:build` | clean / built / built |
| `npm run check:secrets`, `npm audit` | clean; 0 vulnerabilities |
| Live UI check (real browser, `ENABLE_CLAUDE_RUNTIME=yes`, `RUNTIME=mock`, dummy key) | badge "Local backend · mock + Claude"; Runtime select "Simulated (mock)" / "Claude", default mock; a mock task shows demo controls and the Simulated chip; a Claude task on the real SDK path is labelled "Claude runtime", shows "The Claude runtime could not sign in. Check the API key.", has no Simulated chip and no demo controls; no page errors |
| Built with subagent-driven development | 3 tasks + 2 fix rounds/waves, each task reviewed (Opus for the core refactor, the permission change and the whole branch; Sonnet for plumbing); a final whole-branch review and a scoped re-review of its fixes |

## What changed

- **Per-task runtime** (`server/taskManager.ts`, `server/app.ts`): `TaskManager` keeps a default provider and any extra ones; every run remembers its provider, so cancel, timeouts, approval answers, demo controls, activity labels, limits and the broad-write rule follow the task. `POST /api/agents/:id/tasks` takes an optional `runtime` (`mock` or `claude`; unknown → 400, not enabled → fixed sentence). `RUNTIME` stays the default. The claude provider exists only when `RUNTIME=claude` or `ENABLE_CLAUDE_RUNTIME=yes` (exact value), never merely because a key is present. `GET /api/health` keeps `runtime/available/reason` for the default and adds `runtimes` and `defaultRuntime`.
- **Safety follows the change:** the public gateway also refuses `ENABLE_CLAUDE_RUNTIME=yes` unless `VO_ALLOW_PUBLIC_CLAUDE=yes`; host-safety checks and the unbound-rule warning apply whenever Claude is registered; the Claude concurrency limit counts only Claude runs; broad write scopes stay off for Claude tasks unless `ALLOW_BROAD_WRITE_SCOPES=yes`; one `claudeEnabled(config)` helper replaces five copies of the predicate.
- **A real hole found and closed** (final review, reproduced): a simulated "Allow for this agent" approval from the mock demo created an agent-scoped Write rule that later let **real Claude writes through without approval** when broad scopes were on. Fixed twice over: mock approvals are once-only whenever Claude is registered, and every rule made from an approval now records the runtime of the task that made it and applies only to tasks of that runtime. Rules from before this change have no runtime and still apply to both: the server warns about them at start (they are not revoked automatically).
- **Cost** (`usage` on `completed`/`failed` events → a nullable `usage` on the task → the task card): "About $0.0123 (estimate) · 3 steps" from the SDK's own `num_turns` and `total_cost_usd`, validated as numbers on every boundary (events, saved state, SDK mapping); older saved state loads as before. A task that fails before it starts (key refused) shows no cost.
- **UI:** a Runtime select appears when the server has more than one runtime, an unavailable one disabled with its reason; the badge reads "mock + Claude"; Claude needs a workspace (no mock-flavoured blank option, disabled when none is configured); the demo controls show only when the server actually serves them; the "Mock runtime only" note no longer shows beside Claude; activities are labelled "Simulated" by the **task's** runtime, not the agent's, so real Claude work is never marked simulated.

## Rulings

1. Claude registers only on `RUNTIME=claude` or exact `ENABLE_CLAUDE_RUNTIME=yes`. If wrong, one more variable to set.
2. No queue for tasks over the Claude limit: refused with a message, as in 3B.5.2. If wrong, the person retries.
3. Cost is a per-task estimate only, with no running total. If wrong, spend across many small tasks is not visible in the app.
4. H1 fixed both by once-only mock approvals and by a runtime on every rule. If wrong, a schema field on rules that old rules lack.
5. All the review's Low items and the README gaps fixed in the same wave rather than parked.

## Limits

- No real model has run; cost and Claude behaviour with real tasks are unobserved.
- Rules made before this change have no runtime and apply to both runtimes (flagged at start, not revoked); rules created through `POST /api/permissions` stay runtime-less by design and keep triggering the start warning until revoked.
- No running total of spend; the cost is the SDK's estimate, not a bill.
- A client that does not name a runtime gets the default one, so an old browser tab can never start a Claude task (safe).
- Still no OS-level sandbox; file contents the model reads go to Anthropic; the SDK licence review is open; the prerequisites in `docs/milestone-3b5-prerequisites.md` that need a person (the first real run) are still open.
- Deferred minor: a few e2e tests could assert more (named in the ledger of the final re-review); the README does not describe every mock/Claude interaction beyond what is above.
