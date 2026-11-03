# Milestone 3B.5.4: Real workforce integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Mock and Claude tasks run side by side: the person chooses the runtime per task, several agents work at once (the limit already exists), and a finished Claude task shows what it cost. Closes the roadmap of `docs/milestone-3b5-planning.md` §10 (3B.5.4); concurrency limits, activity feed, 3D status and agent registry integration already exist and are only verified.

**Architecture:** `TaskManager` keeps one default provider and may hold more; each run remembers its own provider, so cancel, approvals, demo controls, activity source and limits follow the task, not the process. The claude provider is registered only when `RUNTIME=claude` or the new explicit `ENABLE_CLAUDE_RUNTIME=yes`; `RUNTIME` stays the default for tasks that do not name one. Usage (steps and an estimated cost) rides on the `completed`/`failed` runtime events into a nullable `usage` on the task and is shown on the task card.

**Tech Stack:** TypeScript, Node, vitest, React; existing `server/taskManager.ts`, `server/app.ts`, `server/http/*`, `src/workforce/*`.

**Spec:** `docs/milestone-3b5-planning.md` §9 D8/D9 and §10 3B.5.4; risks R5 (cost not visible) there.

## Global Constraints

- The mock runtime and every existing mock behaviour stay as they are: a server started as today (`RUNTIME=mock`, no `ENABLE_CLAUDE_RUNTIME`) behaves exactly as before. Existing tests keep passing unless one pinned a single-provider assumption (change it deliberately and say so).
- Security rules of 3B.4 and 3B.5 do not weaken: Claude stays refused on a public address unless `VO_ALLOW_PUBLIC_CLAUDE=yes` — this now also covers `ENABLE_CLAUDE_RUNTIME=yes`; the host-safety checks (`server/hostSafety.ts`) apply whenever the claude provider is registered, not only when `RUNTIME=claude`; broad write scopes stay off for Claude tasks unless `ALLOW_BROAD_WRITE_SCOPES=yes`; the concurrency limit counts Claude tasks only.
- The browser is never an authority: the server validates the runtime a task names and answers with a fixed sentence.
- Fixed error sentences; no path, key or content in any message, log or event.
- No new dependency. No `child_process`, `exec(`, `spawn(`, `fork(`, `worker_threads` (a repo test scans `server/`, `src/`, `scripts/`).
- Match the codebase; conventional commits ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Verification at the end of each task: its own tests, `npx tsc -b`, `npx vitest run server/noProcessExecution.test.ts`; once at the end `npm test`.

## Review Focus

1. A task running on the wrong provider: cancel, approval answers, timeouts, restart recovery or demo controls routed to the other runtime. Task 1.
2. Claude becoming reachable where it was refused: a public address, a server that never enabled it, a task that names `claude` when it is unavailable. Task 1.
3. Cost shown wrongly or not at all (NaN, negative, huge, a failed task with spend), and old saved state without the field. Task 2.
4. The UI offering a runtime the server will refuse, or hiding a real choice. Task 3.

---

### Task 1: Per-task runtime in the server

**Files:** Modify `server/taskManager.ts`, `server/app.ts`, `server/config.ts`, `server/http/inputs.ts`, `server/http/routes.ts`, `server/hostSafety.ts`, `server/gateway/publicConfig.ts`, `src/workforce/api.ts`, `.env.example`; Test `server/taskManager.test.ts`, `server/config.test.ts`, `server/http/routes.test.ts`, `server/http/inputs.test.ts`, `server/hostSafety.test.ts`, `server/gateway/publicConfig.test.ts`, new `server/e2e/mixedRuntimes.test.ts`.

**Interfaces:**
- Config: `enableClaudeRuntime: boolean` in `ServerConfig` from `ENABLE_CLAUDE_RUNTIME` (only the exact value `yes` enables it; add to `CONFIG_VARIABLES`, `.env.example` with a one-line comment, the names test and fixtures).
- `TaskManagerOptions` keeps `provider` (the DEFAULT provider; its `kind` is the default runtime) and gains `extraProviders?: ServerRuntimeProvider[]` (at most one per kind; a duplicate kind throws at construction). Internally `providers: Map<TaskRuntime, ServerRuntimeProvider>`. Every `Run` stores its `provider`; replace every `this.provider.*` use that concerns a task by that task's provider, and `this.source` by `sourceFor(run.provider.kind)` (or `sourceFor(task.runtime)` where there is no run). Subscribe to every provider (the rule "only the mock may raise an approval on its own" is per provider kind). `dispose` disposes every provider.
- `startTask(agentId, input, opts: CallOptions & { workspaceId?: string | null; runtime?: TaskRuntime })`: `runtime` defaults to the default provider's kind; a kind that is not registered → `{ ok: false, code: 'invalid', error: 'The "<runtime>" runtime is not enabled on this server.' }`; the chosen provider's availability, the "needs a workspace" rule and the Claude-only concurrency limit (counting runs whose provider kind is `claude`) apply to the chosen runtime; `assignTask` records the chosen runtime on the task. Demo controls: `requestApproval`/`forceError` need the task's provider to be a demo provider, else `unavailable` with `Demo controls only work for mock tasks.`. `onceOnly`/broad-write logic uses the task's provider kind.
- `createApp` (`server/app.ts`): registers the mock provider always (`deps.mockTimings` as today) and the claude provider when `config.runtime === 'claude' || config.enableClaudeRuntime` (same construction as today). `deps.provider` (tests) still means "the default provider" and, if given, replaces the one for its kind; new `deps.claudeProvider` and `deps.mockProvider` replace the provider of that kind. The default is the provider of `config.runtime`. The permission boot warning for unbound write rules runs when the claude provider is registered.
- HTTP: `parseCreateTask` accepts an optional `runtime` (`'mock'` or `'claude'`; anything else → 400 `"runtime" must be "mock" or "claude".`) and passes it on. `GET /api/health` keeps `runtime`, `available`, `reason` (the default runtime) and adds `runtimes: RuntimeStatus[]` and `defaultRuntime`, with `export type RuntimeStatus = { kind: 'mock' | 'claude'; available: boolean; reason: string | null }` in `src/workforce/api.ts` (`HealthResponse` gets both fields; the browser's parse of health must tolerate their absence from an older server).
- `server/hostSafety.ts`: `HostFacts.runtime` becomes `claudeEnabled: boolean` (true when `config.runtime === 'claude' || config.enableClaudeRuntime`); every check that applied to `runtime === 'claude'` applies when `claudeEnabled`; update tests.
- `server/gateway/publicConfig.ts`: `ENABLE_CLAUDE_RUNTIME=yes` is refused on a public address exactly like `RUNTIME=claude`, unless `VO_ALLOW_PUBLIC_CLAUDE=yes`. Sentences: keep the existing one for `RUNTIME=claude`; add `ENABLE_CLAUDE_RUNTIME=yes is not allowed on a public address. Set VO_ALLOW_PUBLIC_CLAUDE=yes only after the security prerequisites in docs/milestone-3b5-prerequisites.md are met.` Also refuse when `.env`-style trimmed value is exactly `yes` only.

- [ ] Failing tests first. Unit (taskManager): two providers (a mock and a `FakeProvider({ kind: 'claude' })`), a task naming each runs on the right one (starts recorded per provider); cancel, approval answers (the manager must not call the other provider), timeout and force-cancel route per task; an unregistered runtime is refused with the sentence; an unavailable chosen provider refused with `unavailableMessage`; the concurrency limit counts only Claude runs and mock tasks never count; demo controls on a Claude task are refused; a duplicate provider kind throws; `dispose` disposes all. Config/inputs/health/hostSafety/publicConfig tests for the items above. e2e `server/e2e/mixedRuntimes.test.ts` (real server, the existing `server/test/claudeHarness.ts` fake claude session with `ENABLE_CLAUDE_RUNTIME=yes` and the default `RUNTIME=mock`): health lists both; a mock task (demo approval) and a Claude task run at the same time for two agents; each cancels independently; a Claude task naming no runtime uses the default (mock); naming `claude` when the server did not enable it is a 422/400 with the sentence; mock demo routes work on the mock task and are refused on the Claude task; restart recovery fails both kinds of interrupted tasks.
- [ ] Commit `feat(server): choose the runtime per task`.

### Task 2: Usage and cost on a finished task

**Files:** Modify `src/workforce/runtime/types.ts`, `src/workforce/types.ts`, `src/workforce/operations.ts`, `src/workforce/storage.ts`, `src/workforce/view.ts`, `src/workforce/ui/AgentDetail.tsx`, `server/runtime/claudeMessages.ts`, `server/runtime/claudeAgent.ts`, `server/taskManager.ts` (cap/pass-through only); Test the matching `*.test.ts(x)` files.

**Interfaces:**
- `RuntimeEvent` `completed` and `failed` gain an optional `usage?: { turns: number; costUsd: number }` (both finite, `turns` an integer ≥ 0, `costUsd` ≥ 0).
- `AgentTask` gains `usage: { turns: number; costUsd: number } | null` (null until a runtime reports it; mock tasks stay null). `applyRuntimeEvent` stores a valid usage on completed/failed and ignores an invalid one (null). `storage.ts` validates it on load (missing → null; wrong shape → the whole task is rejected exactly like other malformed fields; a negative, non-finite or absurd value (turns above 1000, cost above 1000) is rejected) and writes it.
- `claudeMessages.ts`: the `result` mapping puts `usage` on the `completed` and `failed` events from `num_turns` and `total_cost_usd` (numbers only; missing or invalid → no usage). Keep the audit note as is.
- `view.ts`: `formatUsage(usage: { turns: number; costUsd: number } | null): string | null` → `null` for null; otherwise `About $0.0123 (estimate) · 3 steps` (cost with up to 4 decimals, trailing zeros trimmed but at least 2 decimals, `$0.00` for 0, `less than $0.0001` for 0 < cost < 0.0001; `1 step` singular). `AgentDetail` shows it on the task card under the result when non-null.

- [ ] Failing tests first: operations (stored on completed and failed, invalid ignored, mock stays null, a second event does not overwrite a finished task), storage (round trip, missing field loads null, each malformed value rejected), `claudeMessages` (success and every failure subtype carry usage when the result has the numbers, none when absent or invalid), `formatUsage` table, `AgentDetail` markup (shown with a value, absent for null), claude provider test (the completed event carries usage), and one server e2e through the fake claude session (the task state and `/api/state` show the usage after completion; SSE patch carries it). Existing fixtures gain `usage: null`.
- [ ] Commit `feat: show the steps and estimated cost of a finished Claude task`.

### Task 3: Runtime choice in the UI, docs, verification

**Files:** Modify `src/workforce/api.ts` (only if not done), `src/workforce/remote/sync.ts`, `src/workforce/controller.ts`, `src/workforce/remote/commands.ts`, `src/workforce/view.ts`, `src/workforce/ui/AgentDetail.tsx`, `README.md`, `.env.example`; Test the matching tests, extend `src/workforce/ui/AgentDetail.test.tsx`, `src/workforce/remote/sync.test.ts`, `src/workforce/remote/commands.test.ts`, `src/workforce/view.test.ts`.

**Interfaces:**
- `RuntimeEnvironment` (`src/workforce/controller.ts`) keeps its shape and gains an optional `runtimes?: RuntimeStatus[]` and `defaultRuntime?` for the backend kind, filled from `/api/health` (absent from an older server → undefined, behaviour as today). `startTask(agentId, input, opts?: { workspaceId?: string | null; runtime?: 'mock' | 'claude' })` sends `runtime` in the body only when given.
- `TaskForm` (`AgentDetail.tsx`): when the backend reports more than one registered runtime, show a **Runtime** select listing each (default = `defaultRuntime`), an unavailable one disabled and labelled with its reason; choosing Claude shows the hint `The Claude agent works in the workspace you choose and needs one.` and keeps the Workspace select visible; the submit label is "Start task" for Claude and "Start simulated task" for mock; with one runtime nothing changes from today.
- `environmentBadge` (`view.ts`): with both runtimes registered the badge reads `Local backend · mock + Claude` (and, when Claude is registered but unavailable, `Local backend · mock + Claude (not available)`) with a title listing each; with a single runtime nothing changes.
- README: a short section "Mock and Claude side by side": `ENABLE_CLAUDE_RUNTIME=yes` registers Claude next to the default, `RUNTIME` is the default, per-task choice in the form, the public-address refusal covers it, cost shown on the task card is the SDK's estimate; `.env.example` entry already added in Task 1 (verify).

- [ ] Failing tests first (markup tests for the select, labels, disabled option, hint, single-runtime unchanged; sync parses health with and without the new fields; commands send `runtime` only when given; badge table).
- [ ] Commit `feat(web): choose mock or Claude per task`.

## Self-review

Spec coverage: per-task runtime and registry → Task 1; cost visibility (R5) → Task 2; UI choice and docs → Task 3; multiple agents, concurrency, activity feed, 3D status are verified by the Task 1 e2e and the controller's browser check. Queueing instead of refusing a task over the limit is deliberately not built (refuse with a clear message, as decided in 3B.5.2).
