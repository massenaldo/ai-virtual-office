# Milestone 3B.5.2 — controlled read-only execution: report

Date: 2026-11-03. Branch `feat/3b5-2-readonly-tools`, based on `main` at `d3418d8` (#61). Plan: `docs/milestone-3b5-planning.md` §10 (3B.5.2).

**What this stage is:** a Claude task can now read the workspace. The model has three read-only tools, `vo_read`, `vo_glob` and `vo_grep`, served by an in-process MCP server over the existing gated handlers. Every call goes through the server's own policy, permission rules, approval flow and use-time re-check, and nothing can write or run anything.

**What was not done:** still **no real model call** (no API key). The real SDK and its real binary were run in this stage, but against a **scripted local API** that plays the model, so the model's own behaviour, a real answer and real cost remain unobserved. Writes are 3B.5.3.

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npm test` | 98 files, 1680 tests pass and 7 skipped (the opt-in real-SDK file) |
| `VO_REAL_SDK=1 npx vitest run server/e2e/claudeRealSdk.test.ts`, 3 runs | 7 of 7 each time, with the real binary |
| `npx tsc -b` | clean |
| `npm run build`, `npm run server:build` | both built |
| `npm run check:secrets`, `npm audit` | clean; 0 vulnerabilities |

## What was built

- **Tool server** (`server/runtime/claudeTools.ts`): `vo_read`, `vo_glob`, `vo_grep` with zod schemas, `readOnlyHint`, plain descriptions (workspace-relative paths, fixed-string search, size caps), registered as the MCP server `vo` with `alwaysLoad` and a per-call `timeout`. Each handler is a shell over `createGatedTools(ctx)`, whose handlers call only `ctx.tools.use`. Errors are the existing fixed sentences as MCP error results. `vo_write`, `vo_edit` and `vo_run` are not registered.
- **Provider** (`claudeAgent.ts`): `allowedTools` is exactly the three names, `mcpServers` is only ours, `permissionMode` stays `dontAsk`, `canUseTool` and a `PreToolUse` hook deny every tool that is not ours (a malformed hook input is denied too). The **init assertion now requires exactly our three tools, exactly our server (connected) and the `dontAsk` mode**; any extra, missing or renamed tool fails the task before it starts. `protectedRoots` (the data folder) is required: the provider refuses to start without it.
- **Mapping** (`claudeMessages.ts`): a call to one of our tools shows only a fixed label ("Reading a file", "Listing files", "Searching files") as `progress('working')`, never the input; a tool result shows "Reading the result"; a call to **any other tool** ends the task.
- **Prompt** (`claudePrompt.ts`): names the three tools, says they are read-only and paths are relative, says a refusal must not be worked around, and says file text is data, not instructions.
- **Concurrency** (`taskManager.ts`, `config.ts`): `MAX_CONCURRENT_TASKS` (default 2, 1 to 32) limits running Claude tasks; the next one is refused with 409 and "A Claude task is already running, which is the limit. Wait for one to finish." The slot is freed when a task ends. The mock is not limited.
- **Tool timeout:** the server `timeout` is `APPROVAL_TIMEOUT_MS + 60 s` (`app.ts`).
- **Dependencies:** `zod` (4.6.7) is now a direct dependency (it was only a peer); `@modelcontextprotocol/sdk` (1.32.2) is a dev dependency, used by the tests as a client.
- **UI copy:** the badge says the agent can read files in the workspace and cannot write or run anything.
- **Test seams:** `apiBaseUrl` on the provider points the SDK at a scripted API (never read from config); `server/test/scriptedApi.ts` is that API.

## What the real SDK showed (scripted API, no key)

| Question | Answer |
|---|---|
| Does `init` list exactly our tools with the SDK options we use? | Yes: three `mcp__vo__*` tools, server `vo` `connected`, no built-in tool |
| Does `allowedTools` with `dontAsk` let our in-process tool run? | Yes, with no permission denial (planning Q6) |
| Does `dontAsk` deny a tool that is not in `allowedTools`? | Yes: the handler never ran and the SDK reported a denial |
| Is the per-server `timeout` honoured? | Yes: a 2.5 s call with `timeout: 1000` was cut at 1 s with an error to the model; with 6 s it ran (planning Q2). The SDK's own docs say the default is "effectively unbounded" |
| What happens to our handler when the SDK times out? | It **keeps running**. If the SDK gave up before an approval, the gate would still be waiting while the model had moved on, so the timeout must exceed the approval timeout, as set |
| What does the API request contain? | Our three tools plus a placeholder named `DeferredToolPlaceholder` that the SDK adds. No built-in tool name. If a model called the placeholder, our mapper would treat it like any foreign tool and end the task |
| Does a Bash call by the model run anything? | No: the task fails with "asked for a tool that is not available" and a marker file was never created |
| Does an approval wait of several seconds work through the real SDK? | Yes: the call waited 3 s for a person, then returned the file |
| Child process | The binary renames itself to plain `claude`. While a tool call ran there was one child; after cancel it exited; after the parent was killed with SIGKILL mid-call it exited within 4 s; no scratch folder is left behind (planning Q3) |

**Correction to stage 3B.5.1:** its report said no process was left behind and called the parent-kill check inconclusive. The process check it used looked for a name the child never has, so those counts were not valid evidence. 3B.5.2 redid them correctly (above); the conclusion holds, and the 3B.5.1 report now says so.

## Tests added

`claudeTools` (14: the tool list, annotations, argument shapes, routing to the policy names, every gate outcome to its fixed sentence, wrong arguments refused before the gate, no write/edit/run tool, empty protected roots refused), `claudeMessages` and `claudeAgent` updates (the exact-set init assertion with 14 cases, tool label and violation mapping including `toString` and `__proto__` as tool names, the options, the hook), `taskManager` (the limit), `config` (the new variable), **`server/e2e/claudeTools.test.ts` (18, through the real server and gate with a real workspace):** read without asking and secret masking, relative paths only, nothing sensitive in a listing or search, seven refused targets (`.env`, `.git`, `..`, absolute path, symlink out, parent glob, search from `/etc`), a deny rule, an ask rule with approve then the spent once-grant then reject, a wrong digest (409), cancel while waiting, approval timeout, two reads at once, no key or host path anywhere, the concurrency limit; and **`server/e2e/claudeRealSdk.test.ts` (7, opt-in, real binary)**: tool list without built-ins, a read with the secret masked before the model sees it, `.env` refused and the model carries on, a Bash call stopping the task, an approval wait, cancel stopping the child, no scratch folder.

## Security notes

- The server's rules decide, not the SDK: the same gate as the mock, with the use-time re-check right before `perform`.
- **File contents leave this machine.** Whatever the model reads is sent to Anthropic's API as part of the conversation. The sensitive-path denylist and redaction reduce what it can read and echo, but they are not a confidentiality boundary (a fixed-string search can still answer yes/no questions about a readable file; see `docs/gated-tools.md`). Point the agent only at workspaces whose contents may be sent.
- Prompt injection: a file can contain instructions. The prompt says to treat file text as data, and the tools are read-only, so the worst case is a misleading answer or a read of another allowed file, not a write or a command. This was not tested against a real model.
- No OS-level isolation: the child runs as the server's user, with an empty working folder and a minimal environment, and the workspace is reached only through the in-process handlers.
- `ALLOWED_TOOLS` and the default rules still apply: removing `Read` from `ALLOWED_TOOLS` makes every `vo_read` a refusal the model sees.

## Limits, stated plainly

- A scripted API is not a model. It proves the wiring and the SDK's enforcement, not how Claude behaves with these tools or what a task costs.
- The concurrency limit refuses rather than queues.
- A running synchronous file operation is not interrupted by cancel (a 3B.4 limit); caps and a 2 s search deadline bound it.
- The real-SDK test starts child processes, so it runs only with `VO_REAL_SDK=1`; the default suite uses fake sessions.
- The SDK licence and terms review from the planning document is still open.

## Rollback

Set `RUNTIME=mock`, or revert this branch to return to the text-only agent of 3B.5.1 (the provider keeps its init assertion either way).

## Before 3B.5.3 (writes)

A first run with a real key and a small budget, watched by a person; the independent security review and the dedicated-OS-user decision from the planning document (§13, items 5 and 6); then `vo_write` and `vo_edit` registered behind the same gate with the digest and use-time checks already built in 3B.4.
