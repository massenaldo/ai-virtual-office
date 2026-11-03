# Milestone 3B.5.1 — SDK integration foundation: report

Date: 2026-11-03. Branch `feat/3b5-1-sdk-foundation`, based on `main` at `d7c94ce` (#60). Plan: `docs/milestone-3b5-planning.md` §10 (3B.5.1) and §8.

**What this stage is:** the Claude Agent SDK is installed and a task can run on it, with the model able to **answer in text only**. It has no tools: it cannot read, write or run anything. File tools come in 3B.5.2 (read) and 3B.5.3 (write).

**What was not done:** no real model call. No Anthropic API key was available, so the only real-SDK runs used a dummy key and ended at the API's 401. Cost, a real answer and the model's behaviour are therefore unobserved. A first real run with a small budget is still to be done by a person who has a key (§6).

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npm test` | 96 files, 1615 tests pass (1546 before; +69) |
| New and changed suites alone (runtime, e2e, config, process guard) | 8 files, 132 tests pass |
| `npx tsc -b` | clean (the SDK's own `Options` type checks every option name we pass) |
| `npm run build`, `npm run server:build` | both built; `dist-server/index.js` has the SDK as an external dynamic import |
| `npm run check:secrets` | no secrets found (12 files) |
| `npm audit` | 0 vulnerabilities (95 packages added) |
| Built server, `RUNTIME=claude` | no key: `available: false, reason: credentials not configured`; with a key: `available: true`; the key is in no log line |
| Real SDK through our provider, dummy key | session started, init assertion passed, a real 401 became `The Claude runtime could not sign in. Check the API key.`, no process left behind |

`server/fileOps.test.ts` "stops the traversal at the entry cap" failed once in a full parallel run (6.4 s) and passed alone and in the later full runs; it is a timing-sensitive test that exists on `main` and was not changed.

## What was built

- **Dependency:** `@anthropic-ai/claude-agent-sdk` pinned to exactly `0.3.317`. Its peers (`zod ^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`) were installed by npm. The linux-x64 platform package holds the native Claude Code binary (about 317 MB); `node_modules` is now about 806 MB.
- **Server build** (`vite.server.config.ts`): the SDK is external, because it finds its binary relative to its own files. `npm run server:start` therefore needs `node_modules` next to `dist-server`.
- **Config** (`server/config.ts`): `anthropicApiKey` (a `Secret`: every printed form is `[REDACTED]`, read only through `reveal()`), `claude: { model, maxTurns, maxBudgetUsd }` from `CLAUDE_MODEL` (default: the Claude Code default), `CLAUDE_MAX_TURNS` (12, 1 to 100) and `CLAUDE_MAX_BUDGET_USD` (0.5, up to 100). The existing self-check that refuses a key in the config still passes.
- **Provider** (`server/runtime/claudeAgent.ts`, rewritten): one `query()` and one SDK session per task; availability is "SDK importable, then key present"; a test seam for the query function.
- **Message mapping** (`server/runtime/claudeMessages.ts`, pure): init to `started` (with the SDK's session id, stored in the existing `AgentTask.sessionId`); assistant text to `message`; result success to `completed`; every failure to one of eight **fixed sentences** (401/403 sign-in, 429 rate limit, turn limit, spending limit, execution error, generic); retries to `progress`; reasoning is never shown; an assistant message the API produced for an error is not shown as agent text; unknown message types are ignored; usage is reported to the audit log as numbers only.
- **Child environment** (`claudeEnv.ts`): the SDK replaces the child's environment with exactly seven variables (`ANTHROPIC_API_KEY`, `HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_RETRIES`, and `PATH` when set). No server token, no other credential, no inspector flag reaches it.
- **Prompts** (`claudePrompt.ts`): the task's title and description; a short custom system prompt that tells the model it has no tools.
- **UI honesty:** the badge shows "Local backend · Claude" when the runtime is available (it showed "(not available)" for every Claude runtime before); the button says "Start task" instead of "Start simulated task" and the demo controls (mock only) are hidden for a Claude task; the mock badge no longer says the SDK is not installed.
- **Docs:** `README.md`, `.env.example`, `docs/gated-tools.md` (a note that the planning document supersedes its SDK-options section).

## Security design as built

Layers, so that one failing does not run a tool: (1) `tools: []`, `allowedTools: []`, `mcpServers: {}`, `strictMcpConfig: true`; (2) **the session's own `init` message must show no tools, no MCP server and the `dontAsk` mode, or the task fails before it starts**; (3) `permissionMode: 'dontAsk'`, a `canUseTool` that denies, a `PreToolUse` hook that denies, and an assistant message that asks for a tool ends the task. The child's working directory is an empty per-task scratch folder under `DATA_DIR/claude-scratch/<taskId>` (mode 0700, removed when the session ends), never the workspace. `settingSources: []`, `persistSession: false`, auto memory off, the CLI's own state in `DATA_DIR/claude-config`. The child's stderr is discarded. Nothing the SDK says reaches a person except the model's own text (redacted and capped by the task manager) and the fixed sentences.

The provider never starts a process: the SDK does. `server/noProcessExecution.test.ts` is unchanged and passes.

## Answers to the planning document's open questions

| # | Question | Answer from this stage |
|---|---|---|
| 1 | Does `tools: []` remove every built-in in 0.3.317? | **For our option set, yes**: a real session reported `tools: []` and `mcp_servers: []` in `init`, including with the deny callback and hook set. The init assertion stays so a future version cannot change this silently |
| 3 | Does abort end the child, and does it exit when our process dies? | Abort at init: the child was gone within 3 s, and the SDK threw `Operation aborted`. After a normal end: 0 children. Killing the parent with SIGKILL left no child, **but that run was ended by the 401 within about 0.7 s, so this is not conclusive**; a long real run must repeat it |
| 6 | Does `dontAsk` with no `allowedTools` work? | Accepted by the binary; `init.permissionMode` was `dontAsk` |
| 2, 4, 5, 7 | MCP tool timeout, memory per child, result subtypes, `permissionPrompts` | Not needed without tools / not measured. 2 and 4 belong to 3B.5.2 |

Observed shape of a failed key (for the mapping): `init`, then an `assistant` message with `error: "authentication_failed"` and `api_error_status: 401`, then a `result` with `subtype: "success"` but `is_error: true`, then the generator **throws**. The provider handles this order (the throw after a result is ignored).

## Tests added

`claudeMessages` (24), `claudeEnv` (4), `claudePrompt` (4), `claudeAgent` (provider with a fake session: availability, the exact options, the happy path, init violations, key refused before init, a tool request, throw before and after a result, no result, start timeout, SDK cannot start, cancel, signal abort, cancel while starting, dispose, secrets), `server/e2e/claudeRuntime.test.ts` (7, through the real server and task manager: completion with the session id, two agents at once, cancel, task timeout, key refused with the key nowhere in state, audit, log or events, init violation, audit notes), config (key redaction and limits), UI (badge, button, demo controls). The fake session lives in `server/test/fakeClaudeSession.ts`.

## Limits, stated plainly

- **No model call was made.** Nothing here shows what the agent answers, what it costs or how it behaves on a real task.
- **No OS-level isolation.** The child runs as the server's user. With no tool in this stage there is nothing for it to use, but a defect in the SDK's binary would run with the server's privileges. The dedicated-OS-user advice in the planning document stands.
- **No concurrency limit yet** (3B.5.2): each running task is one child process.
- **The dependency footprint and licence.** The SDK's licence file points to Anthropic's legal agreements and the package uses API-key authentication only. The planning document's condition for a legal reading is not discharged by this stage.
- **A spend cap is an estimate** (`maxBudgetUsd` can be passed by a little); an Anthropic-side limit on the key is recommended in addition.
- **Only 401, 403 and 429 have their own sentence;** other API errors show the generic one. The detail is in the server log (which redacts).
- **No resume.** `persistSession: false`; a restart fails running tasks as before.
- `server:start` needs `node_modules`; the built server file alone is no longer self-contained.

## Rollback

Set `RUNTIME=mock` (the default). To remove the dependency, revert the commit that adds it; the provider then reports "Claude Agent SDK not installed" as before.

## Next: 3B.5.2

Read-only tools (`vo_read`, `vo_glob`, `vo_grep`) through `createSdkMcpServer` over `createGatedTools`, the extended init assertion, `MAX_CONCURRENT_TASKS`, the MCP tool timeout against the approval wait, and a first real run with a small budget.
