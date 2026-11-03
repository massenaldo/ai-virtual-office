# Milestone 3B.5 — Real Claude Agent Runtime: planning

Status: planning only. Nothing in this document is implemented. No dependency was installed, no source file changed, no agent run.

Tags used throughout: **[V]** verified fact (read in this repository's code, or in the official documentation on the date below), **[P]** proposed design, **[A]** assumption, **[Q]** open question that must be answered before or during implementation.

## 1. Executive summary

The repository is ready for a real runtime in the way that matters most: the tool gate, permission engine, approval digests, gated file tools, workspace policy, audit log, redaction, browser session and restart recovery all exist on `main`, are tested (1546 tests) and were re-verified for this audit. A real provider has exactly one job: turn the SDK's messages into the existing `RuntimeEvent`s and route every tool use through `ctx.tools.use`.

What the research changed:

1. **The Agent SDK is not an HTTP client; it launches a native Claude Code binary as a child process** and talks to it over stdin/stdout [V]. "In-process" therefore means: our tool handlers run in the backend process, the model loop runs in a child. The binary is ~331 MB unpacked for linux-x64 [V], and our server build currently bundles everything (`noExternal: true`), which cannot carry it.
2. **The enforcement point should be the tool handler, not the SDK's `canUseTool`.** The SDK auto-approves before `canUseTool` in several cases, and its permission model is a second, different policy engine. The existing placeholder comment in `server/runtime/claudeAgent.ts` proposes `canUseTool → ctx.tools.use`; this plan replaces that with *our MCP handlers call `ctx.tools.use`, and the SDK is configured to have nothing else to approve* (§8). The tool gate stays authoritative and its use-time re-check stays adjacent to `perform`.
3. **The child process needs no access to the workspace at all**, because every file operation is an in-process gated tool. Giving it an empty scratch directory as `cwd` (instead of the workspace, as the placeholder comment says) is cheap defence in depth.
4. **There is no OS-level isolation today** and the SDK's own guidance says so for permission gates ("a permission gate, not a sandbox") [V]. Without Docker, the minimum credible mitigation is a dedicated unprivileged OS user plus an explicit minimal child environment, with `@anthropic-ai/sandbox-runtime` (bubblewrap) as a later hardening step that needs our own `spawnClaudeCodeProcess` and therefore a reviewed exception to `noProcessExecution.test.ts`.
5. **Gaps in our own architecture** that block "multiple real agents": the runtime is chosen once per process (`RUNTIME`), there is no global concurrency or spend limit, and `RuntimeEvent` carries no usage/cost.

**Verdict: READY WITH CONDITIONS.** Conditions are listed in §13. 3B.5.1 and 3B.5.2 (read-only) can start as soon as the dependency decision and the build change are accepted; 3B.5.3 (writes) must not start before the §13 security items are met.

## 2. Repository state and audited commit

| Item | Result |
|---|---|
| Audited commit | `377294f3d0347d87d22f935f7239160f340fe76b`, branch `main`, == `origin/main` |
| Working tree at start | clean (the previous branch was `fix/3b4-final-blockers`, already merged) |
| 3B.4 final-blockers (B9, B10, workspace picker) | **Merged**: `377294f fix: milestone 3B.4 final blockers (B9, B10, workspace picker) (#59)`; #45, #47, #48, #51, #52, #55, #56, #57, #58 are also in `main` |
| Final checks on merged main | **Run for this audit**, on `377294f`: `npm test` 92 files / 1546 tests pass; `npx tsc -b` clean; `npm run build` and `npm run server:build` built; `npm run check:secrets` clean (12 files); `npm audit` 0 vulnerabilities |
| Reports read | `docs/milestone-3b4-report.md`, `docs/milestone-3b4-final-blockers-report.md`, `docs/gated-tools.md`, `docs/native-host-execution.md`, `docs/sandbox-architecture.md` |

Nothing in this document depends on an unmerged branch. This planning document itself is the only file added, on branch `docs/3b5-planning` (not committed).

## 3. Existing architecture audit

Every row was checked against the code, not the reports.

### 3.1 Runtime and task lifecycle

| Subsystem | Files | Responsibility [V] | Reuse | Extend / gap |
|---|---|---|---|---|
| Runtime contract (server) | `server/runtime/types.ts` | `ServerRuntimeProvider { kind, availability, start(task, ctx), cancel, status, result, respondToApproval, subscribe, dispose }`; `StartContext { agent, signal, workspace, tools: ToolGate, audit }`; `StartOutcome { executionId, sessionId }` | As is | `RuntimeEvent` has no usage/cost field (§12 R5) |
| Events | `src/workforce/runtime/types.ts` | `started`, `progress('thinking'\|'working')`, `message`, `approval_requested`, `completed`, `failed`, `cancelled` | As is: enough for text streaming, status and results | No event for a tool call's *name*; use `progress` text |
| Mock | `server/runtime/mockProvider.ts` wrapping `src/workforce/runtime/mockRuntime.ts` | Simulated run; its demo write goes through the real gate | Unchanged, stays the default | Demo controls only exist for it (`isDemo`) |
| Claude placeholder | `server/runtime/claudeAgent.ts`, `src/workforce/runtime/claudeRuntime.ts` | Always unavailable (`SDK_INSTALLED = false`); a long comment states rules for the future provider | Replace the class, keep `claudeUnavailableReason` ordering | Comment contradicts §8 on `canUseTool` and `cwd` |
| Selection | `server/config.ts`, `server/app.ts` | One provider per process, from `RUNTIME=mock\|claude` | | Per-task choice does not exist (§9 D9) |
| Task manager | `server/taskManager.ts` (579 lines) | Start, duplicate guard, task/approval timers, cancel with grace, output caps and redaction, path hiding, tool approval queue (max 8), permission use/abort-on-revoke | All of it | No global concurrency limit; one active task per agent only (`activeTaskFor`) |
| State transitions | `src/workforce/operations.ts` | `applyRuntimeEvent`, `markStarting`, `requestCancel`, `timeOutTask`, `recoverInterruptedTasks` | As is | |
| Task shape | `src/workforce/types.ts` | `AgentTask` has `runtime`, `workspaceId`, `sessionId`, `executionId`, `endedReason`, `pendingApproval` | As is | Prompt = `title` + `description` (no separate prompt field) |

### 3.2 Permissions and security

| Subsystem | Files | Responsibility [V] |
|---|---|---|
| Permission store/engine | `server/permissions/{store,engine,defaults,types,storage,pathPattern}.ts` | Scopes global/agent/task/once; deny beats allow; most specific scope wins; defaults Read/Glob/Grep allow, Write/Edit ask, Bash/WebFetch/WebSearch deny; expiry computed per request; boot `reconcile` (B9) |
| Tool gate | `server/toolGate.ts` | `createToolGate().use(request, perform)`: freeze input, compute digest (task, workspace id + path, tool, input), ask the manager, **re-check at use time** (task live, workspace re-resolved and digest equal, policy re-run, permission rules asked again, once-grant consumed), track the call for revoke-abort, then run `perform` |
| Policy | `server/toolPolicy.ts` | Tool catalogue (Read, Glob, Grep, Write, Edit, Bash, WebFetch, WebSearch), argument validation, path checks, review building, summaries |
| File operations | `server/fileOps.ts`, `server/workspaces.ts`, `server/sensitivePaths.ts` | `lstat` walk, `O_NOFOLLOW`, descriptor identity compare, strict real-path equality, temp-file + rename for writes, caps, deadlines, denylist, protected roots (data dir) |
| Gated tools | `server/tools/gatedTools.ts` | `vo_read/glob/grep/write/edit` handlers, each only via `ctx.tools.use`; `vo_run` always refuses; fixed-sentence errors; bounded redacted output |
| Approvals | `taskManager.decideApproval`, `/api/tasks/:id/approval` | Digest must match; `allow_once/task/agent`; permission recorded before the runtime is answered; scopes beyond once need a digest |
| Auth | `server/auth.ts`, `server/session.ts`, `server/http/guards.ts` | Token file 0600, cookie session, Host/Origin/CSRF guards |
| Audit and redaction | `server/audit.ts`, `server/redact.ts` | Lifecycle, tool, permission, approval records with digest prefix and action hash; redacting logger; output caps |
| Workspace picker | `src/workforce/ui/AgentDetail.tsx`, `src/workforce/remote/sync.ts` | Registered ids only; server validates and binds to the digest |
| Restart recovery | `server/store.ts`, `server/permissions/store.ts` | Interrupted tasks fail; task/once rules end; orphaned agent rules revoked |
| Process-execution guard | `server/noProcessExecution.test.ts` | Fails if any non-test source under `server/`, `src/`, `scripts/` contains `child_process`, `exec(`, `spawn(`, `fork(` or `worker_threads`; also forbids "bypass permissions" strings |

### 3.3 Communication and frontend

| Subsystem | Files | Notes [V] |
|---|---|---|
| REST | `server/http/routes.ts` | health, state, workspaces, agents CRUD, desk, tasks (create/cancel), approval, permissions CRUD, session, demo routes |
| SSE | `server/eventLog.ts`, `server/http/sse.ts` | One id sequence, bounded buffer, `Last-Event-ID` replay, `state.reset` on a gap or foreign boot, heartbeat, streams closed when a session ends |
| Client | `src/workforce/remote/{client,sync,commands,remoteController}.ts` | Snapshot + stream + backoff; commands are plain REST; `workspaces` and `permissions` live in the snapshot |
| UI | `src/workforce/ui/*` | Agent list/detail/form, task form with workspace select, approval card (Once / This task / This agent only with a digest and a review), permissions panel, pairing form |
| 3D | `src/scene/DeskMarkers.tsx` fed from `src/workforce/view.ts` | Status markers come from `agent.status`; no scene code imports workforce types |

### 3.4 Architectural gaps found (not just "to extend")

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| G1 | Server bundle cannot contain the SDK | `vite.server.config.ts`: `ssr.noExternal: true`, comment "only imports are node:* built-ins" | The SDK and its native binary must stay in `node_modules`; `server:start` needs them at runtime; build config and deploy notes change |
| G2 | One runtime per process | `config.runtime`, one `provider` in `createApp` | Mock demo and real tasks cannot coexist |
| G3 | No concurrency or spend limits | `TaskManager` limits only one task per agent; no agent count limit in `operations.ts` | N agents = N child processes and N model loops |
| G4 | No usage or cost in events | `RuntimeEvent` | Cannot show or cap spend in the UI |
| G5 | Approval waits inside a tool call | `approveTool` waits up to `APPROVAL_TIMEOUT_MS` (5 min default) | The SDK's MCP tool-call timeout may fire first [Q] |
| G6 | The placeholder's rules are partly outdated | `claudeAgent.ts` comment items 2 and 3 | Replaced by §8 |
| G7 | Prompt construction does not exist | `AgentTask` has title + description only | A system prompt and a prompt builder are new work |
| G8 | Transcripts on disk | SDK persists sessions under `~/.claude/projects` unless disabled [V] | Unredacted file contents could land outside the data folder |

## 4. Verified existing capabilities (summary)

Verified by code and by the green suite on `377294f`: a mock task goes through the real gate and approval flow; Write/Edit are gated with digests and use-time re-checks; reads are denylisted and redacted; revoke aborts in-flight calls of task/once rules; cancel has a grace timer; timeout and approval timeout fail the task; restart ends task rules; events replay over SSE; a browser can pair, pick a workspace, scope an approval and revoke. **Not verified anywhere:** any behaviour against the real SDK, real abort of a real child process, real message mapping, real cost.

## 5. Official Claude Agent SDK research

Consulted 2026-11-03. The documentation has moved: the repository's earlier notes cite `code.claude.com/docs/en/agent-sdk/`; the pages now resolve at `https://platform.claude.com/docs/en/agent-sdk/` (site title "Claude Code Docs"), and the README still links `docs.claude.com`. The TypeScript package is `@anthropic-ai/claude-agent-sdk`; the registry shows **0.3.317** as `latest` (the 3B.1.2 notes saw 0.3.316). Sources: the pages `overview`, `typescript`, `permissions`, `hooks`, `custom-tools`, `sessions`, `mcp`, `secure-deployment`, `streaming-vs-single-mode`, `agent-loop`, `claude-code-features` under that base URL; `https://github.com/anthropics/claude-agent-sdk-typescript` (README); `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest`.

| # | Capability | What the SDK supports [V] | Limitation / caveat | Maps to our architecture | Source |
|---|---|---|---|---|---|
| 1 | Install, Node | `npm install @anthropic-ai/claude-agent-sdk`; `engines.node >=18.14.0`; peers `zod ^4`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`; bundles a native Claude Code binary as an optional per-platform dependency (`@anthropic-ai/claude-agent-sdk-linux-x64` is ~331 MB unpacked); `pathToClaudeCodeExecutable` if optionals are skipped. License field says "SEE LICENSE IN README.md"; use is under Anthropic's Commercial Terms; claude.ai login may not be offered to third parties, API-key auth only | Repo runs Node 22 (compatible). `zod` is not a dependency of this repo today | New dependencies (§13) | `overview`, `typescript`, registry |
| 2 | Main API | `query({ prompt, options }): Query`, an `AsyncGenerator<SDKMessage>` with control methods (`interrupt`, `close`, `setPermissionMode`, `mcpServerStatus`, …); prompt is a string or an async iterable (streaming input) | `interrupt()` only in streaming-input mode. `startup()`/`prewarm()` pre-spawn a process (alpha for `prewarm`) | One `query()` per task | `typescript` |
| 3 | Messages | `SDKMessage` union of ~40 types; the ones we need: `system/init` (carries `session_id`, `tools`, `mcp_servers`, `permissionMode`, `cwd`), `assistant` (content blocks: text, tool_use, thinking), `user` (tool results), `result` (`success` or `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`; carries `total_cost_usd`, `usage`, `num_turns`, `permission_denials`, `session_id`), `stream_event` (only with `includePartialMessages`), `system/api_retry`, `permission_denied`, rate-limit | Many subtypes, version-dependent; unknown types must be ignored, not fatal | Mapping table in §7.3 | `typescript` |
| 4 | Custom tools | `tool(name, description, zodShape, handler, annotations)` + `createSdkMcpServer({ name, tools, timeout })`; runs **in our process**; names become `mcp__<server>__<tool>`; handler returns `{ content, isError }`; `readOnlyHint` allows parallel calls; per-server `timeout` (≥1000 ms, SDK ≥0.3.248) replaces `MCP_TOOL_TIMEOUT` | Handler throws become error results; schema must be convertible to JSON Schema; zod 4 required | `vo_*` handlers wrap `createGatedTools` | `custom-tools`, `typescript` |
| 5 | Permissions | Evaluation order: hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`. Modes: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk` (deny anything not pre-approved, never prompts), `auto` (a model classifier). `canUseTool(toolName, input, {signal, toolUseID, …})` returns `allow` (with `updatedInput`) or `deny`; **it is not called for calls auto-approved by `allowedTools`, rules or the mode.** SDK emits a warning `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` for such configurations | Two policy engines would coexist; defaults of `permissionMode` and `settingSources` have changed between SDK versions (our own 3B.1.2 notes) | §8: handler is authoritative; SDK set to deny everything else | `permissions`, `typescript` |
| 6 | Hooks | `PreToolUse` runs before every other step and **a deny applies in every mode, even `bypassPermissions`**; sees `tool_name`, `tool_input`, `mcp_server` provenance | Callback hooks only in code we write; shell-command hooks come from settings files (disabled by `settingSources: []`) | Defence in depth: a `PreToolUse` hook that denies every tool not on our allowlist | `hooks`, `permissions` |
| 7 | Working directory | `cwd` option; `additionalDirectories`; `settingSources` (`user`/`project`/`local`, `[]` disables); **inputs read regardless of `settingSources`**: managed policy settings, `~/.claude.json`, auto memory under `~/.claude/projects/<project>/memory/`, claude.ai MCP connectors, sandbox credential entries. Docs: "Do not rely on default `query()` options for multi-tenant isolation" | Disable with `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `strictMcpConfig: true` | `cwd` = server scratch dir (§8.2); explicit `env` | `claude-code-features`, `typescript` |
| 8 | Allowed/disallowed tools | `tools: string[]` selects the built-ins available (`[]` removes them from the model's context); `disallowedTools` bare name removes a tool, scoped rule denies calls in every mode; `allowedTools` auto-approves and does **not** restrict; `toolAliases` can map a built-in name to an MCP tool | The `init` message lists the tools the session really has: usable as a start-up assertion | §8.4 | `custom-tools`, `permissions`, `typescript` |
| 9 | Sessions | `session_id` in `system/init` and every `result`; `resume`, `continue`, `forkSession`, `sessionId` (we may choose the UUID), `persistSession: false` (TypeScript only) keeps the session in memory only; transcripts otherwise under `~/.claude/projects/<encoded-cwd>/*.jsonl` or `$CLAUDE_CONFIG_DIR/projects/` | Sessions persist the conversation, not the filesystem. Resume needs the transcript on the same host | §9 D1, D2 | `sessions` |
| 10 | Cancellation | `abortController` option; `query.close()`; `interrupt()` (streaming input only) | **[Q]** The earlier repository note says abort closes stdin and signals the child after ~2 s and that SIGKILL of the child group is unconfirmed; this was not re-verified from the docs reachable here. No built-in wall-clock timeout (use `maxTurns`, `maxBudgetUsd`, our timers) | §7.7; must be tested against the pinned version | `typescript`, `agent-loop`, repo note |
| 11 | Process lifecycle | The SDK spawns the binary itself; `spawnClaudeCodeProcess(options)` lets the host supply the spawn (VMs, containers, remote); `env` **replaces** the child's environment (default all of `process.env`); `stderr` callback; API timeouts via env (`API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_RETRIES`, stream watchdog) | Our own spawn would hit `noProcessExecution.test.ts` | §9 D3, D10 | `typescript` |
| 12 | Output, errors, usage | `result` carries `result` text, `is_error`, `stop_reason`, `total_cost_usd` (client-side estimate), `usage`, `modelUsage`, `permission_denials`, `num_turns`; `maxTurns`, `maxBudgetUsd` (estimate "can pass this value"); `outputFormat` for structured output | A single-shot `query()` can yield an error `result` and then throw; wrap in try/catch | §7.3, §7.6 | `typescript`, `agent-loop`, `cost-tracking` |
| 13 | MCP | In-process (`createSdkMcpServer`), stdio, SSE and HTTP servers; `strictMcpConfig: true` ignores `.mcp.json`, user settings, plugin servers and claude.ai connectors; tool permission goes through the same permission flow (rule `mcp__server__tool`; deny `mcp__*` supported) | An MCP tool is a second route to the filesystem if a non-gated server is ever configured | Only our in-process server is ever passed; `strictMcpConfig: true` | `mcp`, `typescript` |
| 14 | Security guidance | Prompt injection and model error are the stated threat; "a permission gate, not a sandbox"; isolation options: `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, no Docker), containers, gVisor, VMs; credentials via a proxy outside the boundary (`ANTHROPIC_BASE_URL`); same-host-kernel and no-TLS-inspection caveats | None of these is on by default | §8.7, §9 D10 | `secure-deployment` |

## 6. Proposed target architecture [P]

```
React UI
  ↓ REST + SSE (unchanged)
RemoteWorkforceController (unchanged)
  ↓
Backend HTTP (unchanged routes; task create gains an optional runtime choice in 3B.5.4)
  ↓
TaskManager (extended: concurrency limit, spend caps, usage reporting)
  ↓ StartContext { agent, signal, workspace, tools: ToolGate, audit }
ClaudeAgentRuntimeProvider  ── server/runtime/claudeAgent.ts (rewritten)
  │   ├─ claudeSession.ts   one query() per task: options, abort, message loop
  │   ├─ claudeMessages.ts  pure SDK message → RuntimeEvent mapping
  │   └─ claudeTools.ts     createSdkMcpServer(vo_*) wrapping createGatedTools(ctx)
  ↓ stdio
Claude Agent SDK → bundled Claude Code binary (child process, empty cwd, minimal env, no built-in tools)
  ↓ MCP over the in-process transport
Gated tools (server/tools/gatedTools.ts) → ctx.tools.use → ToolGate → PermissionStore + policy + approval
  ↓ perform (fileOps, descriptor-checked)
Approved workspace
```

What stays untouched: `MockRuntimeProvider` and `ServerMockProvider`, the permission engine, the gate, `fileOps`, the policy, the audit log, the event log and routes, the 3D scene and layout editor. What the provider must not do: touch the policy, an approval id, a workspace path (other than through the gate), the data folder, or any log directly.

## 7. End-to-end execution flow [P]

Owner column: **UI** browser, **API** HTTP layer, **TM** `TaskManager`, **GATE** `toolGate` + engine, **PROV** the Claude provider, **SDK** the library and child, **FS** `fileOps`.

### 7.1 Create a task, choose agent and workspace

1. UI: person picks an agent and a workspace in the task form (exists) and posts `POST /api/agents/:id/tasks`. **API/TM** validate the agent, input, workspace (registered id only; `resolveWorkspace`), and (claude runtime) require a workspace (exists). New in 3B.5.2: refuse when `MAX_CONCURRENT_TASKS` is reached. TM assigns the task as `starting`, arms the task timer, audits `task.start`.
2. TM calls `provider.start(task, ctx)` in the background (`launch`, exists).

### 7.2 Start a Claude session

3. **PROV**: check availability (SDK importable, credentials present). Build the prompt from title + description; build options (§8.6); create the in-process MCP server over `createGatedTools(ctx, { protectedRoots })`; create an `AbortController` linked to `ctx.signal`; create a per-task scratch dir (0700, under `DATA_DIR`); call `query()`.
4. **SDK** spawns the child. The first message is `system/init`: **PROV asserts** `tools` equals exactly our five names and `mcp_servers` is exactly ours and `permissionMode` is as set; any difference aborts the session and fails the task (`runtime.note` audit, fixed error text). On success PROV emits `started { executionId, sessionId = session_id }`.

### 7.3 Streaming messages and status

5. **PROV** maps messages (pure function, unit-tested with recorded fixtures):

| SDK message | RuntimeEvent | Notes |
|---|---|---|
| `system/init` | `started` | after the assertion in step 4 |
| `assistant` text block | `message { text }` | TM redacts, hides paths, caps |
| `assistant` tool_use block | `progress('working', "Using <tool label>")` | label from our own table, never the raw input |
| `assistant` thinking | none (initially) | not shown; avoid leaking reasoning |
| `user` (tool result) | `progress('thinking')` | the model is reading the result |
| `system/api_retry`, rate-limit | `progress('thinking', fixed text)` | |
| `permission_denied` | `ctx.audit` note | should not occur; if it does it is a configuration bug |
| `result` success, not `is_error` | `completed { summary: result }` | usage goes to audit (§12 R5) |
| `result` error subtypes / `is_error` | `failed { error: fixed sentence per subtype }` | detail to the server log only |
| generator throws | `failed { error: 'Runtime error.' }` | message to the server log, redacted |
| any unknown type | ignored | forward-compatible |

6. **TM** (existing) turns events into task, agent and activity changes; **API** broadcasts them over SSE; **UI** and the 3D markers read `agent.status` (`thinking`/`working`/`waiting`/`error`/`completed`). No change to the frontend contract.

### 7.4 Tool use and approval

7. The model calls `mcp__vo__vo_write`. The **SDK** passes the call to our in-process handler (no SDK approval step: the tool is pre-approved, §8.3). The handler validates input shape (before any approval is spent), then calls `ctx.tools.use({ tool: 'Write', input }, perform)`.
8. **GATE** freezes the input, computes the digest, asks **TM.approveTool**: policy → permission engine → allow / deny / ask. For ask, TM moves the task to `waiting_for_approval`, emits `approval_requested` with digest and review, arms the approval timer, audits `tool.asked` / `approval.requested`. The handler's promise stays pending (the SDK is waiting for the tool result).
9. **UI** shows the review; the person chooses a scope and posts the decision with the digest. **TM.decideApproval** checks id and digest, records the permission, resolves the gate's promise.
10. **GATE** re-checks at use time (task live, workspace re-resolved and digest equal, policy re-run, permission rules asked again, once-grant spent), registers the call for revoke-abort, then runs `perform` in **FS** (`writeTextFile`). The handler returns `{ content: [{ type: 'text', text }] }` or `{ isError: true, content: <fixed sentence> }`. A rejection or stale approval returns a fixed sentence the model can read; it never gets the digest, paths or an OS message (existing `RESULT_TEXT`).

### 7.5 Reject, cancel, timeout

11. Reject: gate returns `denied`; handler returns the fixed "not approved" error; the model may continue or give up. The task stays `running`.
12. Cancel (`POST /api/tasks/:id/cancel`): TM settles waiting tool requests with `cancelled`, marks `cancelling`, calls `provider.cancel(taskId)`. **PROV**: abort the controller, `query.close()`, wait for the generator to end, emit `cancelled`; ignore events after its own abort. TM's grace timer force-cancels (`CANCEL_GRACE_MS`) and aborts `run.abort`. A revoked task/once rule aborts only the call it allowed (existing).
13. Timeout: TM's task timer fails the task, calls `provider.cancel`, aborts. `maxTurns` and `maxBudgetUsd` are additional caps in the SDK (§12 R5).

### 7.6 SDK errors, completion

14. Errors map per §7.3; auth or credit errors surface as a fixed "The Claude runtime reported an error." plus an audit note; the real message is in the redacted server log. Completion: `result` success → `completed`; TM finalizes, ends the task's rules, closes the run. PROV disposes the query and deletes the scratch dir.

### 7.7 Backend restart

15. Existing behaviour is kept: interrupted tasks fail ("Interrupted by a server restart"), task/once rules end (B9). **No resume** in 3B.5: `persistSession: false`, so there is nothing to resume; any child process of the dead server must have exited when its stdin closed **[A]** (§12 R6: test). Agent and global rules persist as designed.

## 8. Permission and security integration design [P]

### 8.1 Principle

The backend permission engine is authoritative. The SDK is configured so it has **no tool except our five, every one pre-approved, and a deny-everything backstop for anything else**. The decision, the approval, the digest and the use-time re-check all happen in `ctx.tools.use`, in our process, adjacent to `perform`.

### 8.2 Child process

- `cwd`: a per-task empty scratch directory under `DATA_DIR/claude-scratch/<taskId>` (0700), **not** the workspace. The model learns workspace paths only through gated tool results. This replaces item 2 of the placeholder comment ("working directory is `ctx.workspace.path`").
- `env`: an explicit allowlist: `PATH`, `HOME` (pointing at the scratch parent), `ANTHROPIC_API_KEY` (from config only), `CLAUDE_CONFIG_DIR` (a server-owned dir under `DATA_DIR`, which is already a protected root), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, API timeout variables. Nothing from `process.env` is inherited (`env` replaces it).
- Credentials never enter prompts, events or logs; the existing redactor and `findSecretInConfig` apply; the API key is read from the server environment only.

### 8.3 SDK options (exact intent; each name re-verified against the pinned version at implementation)

`tools: []`; `mcpServers: { vo: createSdkMcpServer({ name: 'vo', tools, timeout: approvalTimeoutMs + margin }) }`; `strictMcpConfig: true`; `allowedTools: ['mcp__vo__vo_read', 'mcp__vo__vo_glob', 'mcp__vo__vo_grep', 'mcp__vo__vo_write', 'mcp__vo__vo_edit']` (pre-approved **because the handler is the gate**); `permissionMode: 'dontAsk'` (nothing else can ask or be approved); `canUseTool` returning deny with a fixed message (backstop; it should never be called); a `PreToolUse` hook that denies any tool name outside the five (a hook deny wins in every mode); `settingSources: []`; no `plugins`, `skills`, `agents`, `additionalDirectories`; `persistSession: false`; `maxTurns`, `maxBudgetUsd` from config; `systemPrompt` a short custom string (not the `claude_code` preset, which describes built-in tools); `includePartialMessages: false` initially; `abortController` linked to `ctx.signal`.

`vo_run` is **not registered**. Bash, WebFetch and WebSearch stay unavailable in all of 3B.5.

### 8.4 Keeping built-ins out (layers)

1. Availability: `tools: []` and a bare-name `disallowedTools` list as a second layer. 2. Start-up assertion on `system/init.tools` (fail closed). 3. `dontAsk` plus `PreToolUse` allowlist. 4. `cwd` is empty. 5. A pinned-version integration test that lists the model-visible tools. **[Q]** Whether `tools: []` hides *every* built-in in 0.3.317 (earlier repo notes flag this as untested): the assertion in 2 exists precisely so a surprise stops the task instead of running it.

### 8.5 Per-tool design

| Tool (model name → gate name) | Input schema (zod) | Validation | Scope / approval | Audit | Errors | Symlink and TOCTOU |
|---|---|---|---|---|---|---|
| `vo_read` → `Read` | `file_path: string`, `offset?`, `limit?` (positive ints) | shape before the gate; policy: workspace-relative, no `..`, denylist | default allow (global rule); may be scoped | `tool.allowed` + `permission.used` | fixed sentences (`RESULT_TEXT`) | `lstat` walk, `O_NOFOLLOW`, descriptor identity, strict real-path equality (stage E) |
| `vo_glob` → `Glob` | `pattern`, `path?` (directory) | as above, entries with control characters skipped | default allow | same | same | traversal re-checks each directory; 2 s deadline; 500 results |
| `vo_grep` → `Grep` | `pattern` (fixed string), `path?`, `glob?`, `-i?`, `output_mode?` | unsupported options refused before the gate | default allow | same | same | 1 MiB per file, 200 matches; redact-then-cut |
| `vo_write` → `Write` | `file_path`, `content` (≤ 32 KiB) | policy builds the review (whole content) | default **ask**; once / task / agent need the digest | `tool.asked`, `approval.requested/decided` with 12-char digest prefix and `actionHash`, `permission.used` | `stale_approval`, `revoked`, `conflict` | temp file `O_EXCL`, re-verify parent and `nlink`, rename; **residual race between the final check and the rename** (no `openat`) |
| `vo_edit` → `Edit` | `file_path`, `old_string`, `new_string`, `replace_all?` | same as write | same as write | same | `no_match`/`not_unique` | same; the outcome is a yes/no oracle on file content |
| `vo_run` | not registered | | | | | |

### 8.6 Policy checks vs. OS isolation (explicit)

Workspace validation, the denylist, `fileOps` and the digest are **application-level policy**. They stop the model from using the *tools we expose* outside the approved workspace. They do not constrain a child process, a same-user process, or a kernel bug; the child runs with the server user's privileges and could read anything that user can read if it ever had a tool that did (§8.4 is what prevents that). **There is no sandbox in this design, and none may be claimed.** See §8.7 for the minimum mitigation.

### 8.7 Conflicts and the minimum OS-level mitigation

Conflict: the SDK's permission model (rules, modes, `canUseTool`, a model-based `auto` mode) overlaps ours and can approve before `canUseTool` runs. Recommendation: use none of the SDK's approval features; use only its *deny* features and our handler gate.

Minimum mitigation without Docker, in order of value: (1) run the server (hence the child) as a **dedicated unprivileged OS user** whose home contains nothing but the data folder and who cannot read other users' files; (2) the explicit minimal `env`; (3) `CLAUDE_CONFIG_DIR` and the scratch dir inside the 0700 data folder; (4) an optional later step: `@anthropic-ai/sandbox-runtime` (bubblewrap) around the child via `spawnClaudeCodeProcess`, with filesystem limited to the scratch dir and network limited to the Anthropic API host. (4) requires our own spawn, therefore a separate reviewed PR that adds a justified allowlist entry to `noProcessExecution.test.ts`. Default spawn (3B.5.1 to 3B.5.3) needs no exception **[A]**: the guard scans our source text and we never call a spawn function.

## 9. Architectural decisions

| # | Decision | Options and trade-offs | **Recommendation** |
|---|---|---|---|
| D1 | Session per task or per agent | Per agent keeps context across tasks but couples tasks, retains transcripts and breaks "one task = one audit trail"; per task is isolated and matches `AgentTask` | **One `query()` and one SDK session per task.** `persistSession: false`; no resume in 3B.5 |
| D2 | Session id mapping | Our `executionId` vs. SDK `session_id` | `executionId` = our own id; `sessionId` = SDK `session_id` from `system/init`, stored in the existing `AgentTask.sessionId`, in `started`, and in audit notes; task and agent ids are never sent to the SDK |
| D3 | In process or worker | A worker would isolate the SDK from the server, but tool handlers must run in the process that owns the gate; the SDK already runs its loop in a child | **SDK in the backend process** (child binary already out of process), handlers in-process. A supervising worker process is not justified before a sandbox exists |
| D4 | Stream into SSE | Forward SDK messages vs. map | **Map to `RuntimeEvent` in a pure function**; TM's caps, redaction and path hiding apply; nothing raw reaches SSE |
| D5 | SDK permission callbacks → approval flow | `canUseTool → ctx.tools.use` (placeholder plan) vs. gate in the handler | **Gate in the handler** (§8.1); `canUseTool` is a deny backstop |
| D6 | Prevent built-ins bypass | | The §8.4 layers; fail closed on the init assertion |
| D7 | Cancellation and cleanup | | Abort + `close()` + wait; TM grace timer; `dispose()` closes all queries; integration test for orphaned children (§12 R6) |
| D8 | Concurrency and resources | Reject vs. queue | **`MAX_CONCURRENT_TASKS` (default 2), reject with a clear error** (the `queued` state exists but is unused); `maxTurns`, `maxBudgetUsd`, task timeout; measure child memory before choosing defaults |
| D9 | Mock/real selection | Per process (today) vs. per task | **Keep per-process for 3B.5.1 to 3B.5.3. In 3B.5.4 add a provider registry and a per-task runtime** validated against availability; mock stays the default and keeps its demo controls |
| D10 | Minimum OS mitigation | §8.7 | Dedicated OS user + explicit env now; sandbox-runtime later behind its own PR |

## 10. Sub-milestone roadmap [P]

### 3B.5.1 — SDK integration foundation (no tools, no workspace access)

- **Scope:** dependency decision, build change, provider skeleton, message mapping, session lifecycle, error mapping, cancel. The model has **no tools** (an empty MCP server list, `tools: []`): it can only answer text.
- **Depends on:** §13 conditions 1 to 4.
- **Create/modify:** `package.json` (+lockfile; pin exact SDK, add peers), `vite.server.config.ts` (externalise the SDK and its native packages), `server/runtime/claudeAgent.ts` (rewrite), new `claudeSession.ts`, `claudeMessages.ts`, `claudePrompt.ts`, `claudeEnv.ts`, `server/config.ts` (`CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`, `CLAUDE_MAX_BUDGET_USD`), `README.md`, `.env.example`, `server/runtime/claudeAgent.test.ts` (rewrite), `server/noProcessExecution.test.ts` unchanged.
- **Steps:** (1) install pinned SDK in a branch; (2) availability check = importable + key present; (3) `claudeMessages.ts` with fixtures, TDD; (4) `claudeSession.ts` with an injected `query` function so tests use a fake; (5) provider; (6) init assertion; (7) cancel and dispose; (8) docs.
- **Tests:** fake-`query` unit tests for every row of §7.3, abort, throw-after-result, unknown message types, init assertion failure, no key in any event or log (canary), server start without SDK present stays "unavailable"; **one manual run** against the real SDK in a scratch workspace with a tiny budget, recorded in the report.
- **Acceptance:** a task with `RUNTIME=claude` and a key answers a prompt and completes; cancel and timeout end it within the grace period; no tool is visible in `init`; all 3B.4 tests still pass; mock unchanged.
- **Risks:** real cost; dependency size and licence; docs moved; child process hygiene. **Rollback:** `RUNTIME=mock`; revert the dependency commit.

### 3B.5.2 — Controlled read-only execution

- **Scope:** expose `vo_read`, `vo_glob`, `vo_grep` only; workspace enforcement and permission callbacks via the gate; approval/rejection paths (reads are default-allow, but a deny rule or a revoke must work); cancel and timeout while a tool runs; `MAX_CONCURRENT_TASKS`.
- **Create/modify:** `claudeTools.ts`, `claudeAgent.ts`, `taskManager.ts` (limit), `config.ts`, tests: `claudeTools.test.ts`, extend `gatedTools.integration.test.ts` with an SDK-shaped call path, a real-server e2e with a fake `query`.
- **Steps:** zod schemas mirroring handler validation; wrap handlers; `PreToolUse` hook and `canUseTool` backstop; start-up assertion extended to the three tools; scratch cwd; env allowlist; server `timeout` ≥ approval timeout.
- **Tests:** denylisted read (`.env`) through the SDK path is refused; symlink and `..` attempts; a deny rule stops a read mid-task; revoke aborts; handler waits on an approval longer than the default MCP timeout **[Q]**; an attempt to call `Bash` or `Write` by name is denied and audited; injected prompt in a file cannot widen scope (the tool set is fixed).
- **Acceptance:** an agent summarises a file in a scratch workspace using only gated reads; every read appears in the audit log with `tool.allowed`; no host path in any event.
- **Risks:** prompt injection from file content reaching the model; redaction is not confidentiality (`docs/gated-tools.md`); large outputs. **Rollback:** unregister the tools (flag), back to 3B.5.1.

### 3B.5.3 — Gated write execution

- **Scope:** `vo_write` and `vo_edit` with server-side approval, digest validation, path and symlink protection, regression tests.
- **Depends on:** 3B.5.2 accepted, an independent security review, §13 conditions 5 and 6.
- **Create/modify:** `claudeTools.ts` (two tools), tests only otherwise; docs update of `gated-tools.md`.
- **Tests:** an approval for one input cannot authorize a changed input (digest); approval-then-symlink-swap refused (`stale_approval`); once-grant spent exactly once under two parallel calls; a revoked task rule aborts the call; two writers conflict; content cap; a model that retries with altered input is asked again; audit contains digest prefix and action hash, never content; every earlier 3B.4 security test unchanged.
- **Acceptance:** a person approves a write in the UI and exactly that file content appears in the scratch workspace; reject and revoke leave the file untouched; no write without an approval record.
- **Risks:** the final-check-to-rename race (residual, documented), content oracles, a model editing files that other tools read. **Rollback:** unregister the two tools.

### 3B.5.4 — Real workforce integration

- **Scope:** agent registry integration, real activity feed, 3D status mapping verification, multiple agents, limits.
- **Create/modify:** provider registry and per-task runtime in `app.ts`, `taskManager.ts`, `routes.ts`, `api.ts`, `commands.ts`, `AgentDetail.tsx` (runtime select, runtime label); usage/cost reporting (an additive optional field on `completed`, or audit-only, decided at 3B.5.4 start); `view.ts` labels; docs.
- **Tests:** two agents run two real tasks concurrently within the limit; the third is refused cleanly; mock and real tasks coexist; a cost cap ends a task; SSE replay across a gap with real events; restart with two running tasks leaves no orphan child (R6) and no active task rules.
- **Acceptance:** from the UI, two agents work in two workspaces, status markers follow, approvals are scoped, a restart is clean.
- **Risks:** resource exhaustion, cost, a registry change touching the manager. **Rollback:** per-process `RUNTIME` as before.

## 11. File-level implementation plan (summary)

| File | 3B.5.1 | 3B.5.2 | 3B.5.3 | 3B.5.4 |
|---|---|---|---|---|
| `package.json`, lockfile | add SDK + peers | | | |
| `vite.server.config.ts` | externalise SDK | | | |
| `server/runtime/claudeAgent.ts` | rewrite | tools | | registry |
| `server/runtime/claudeSession.ts` (new) | query loop, abort | tool list | | |
| `server/runtime/claudeMessages.ts` (new) | mapping | | | usage |
| `server/runtime/claudeTools.ts` (new) | empty | read tools | write tools | |
| `server/runtime/claudeEnv.ts`, `claudePrompt.ts` (new) | env, prompt | | | |
| `server/config.ts`, `.env.example`, `README.md` | model, caps | concurrency | | runtime list |
| `server/taskManager.ts` | | concurrency limit | | multi-provider |
| `server/app.ts`, `server/http/routes.ts` | | | | registry, runtime on create |
| `src/workforce/*` | | | | runtime select, labels, usage |
| `docs/gated-tools.md`, `docs/native-host-execution.md`, new report per stage | each | each | each | each |
| **Never modified** | `mockProvider.ts`, `mockRuntime.ts`, `src/scene/*`, `src/editor/*`, permission engine internals | | | |

## 12. Test and acceptance criteria; risks

### 12.1 Cross-cutting tests (every sub-milestone)

All existing suites stay green; `noProcessExecution.test.ts` unchanged until a sandbox PR; a **canary secret** (the existing `CANARY` pattern) never appears in any SSE event, audit line, log line or response; the init-assertion test; fake-`query` tests are the default, one real-SDK smoke test is gated behind an explicit env flag and never runs in CI by default.

### 12.2 Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Prompt injection through file content or task text steers the model | High | Fixed tool set; reads default-allow but denylisted; writes always shown in full; digest binding; no network tools |
| R2 | A built-in tool is still visible/usable | High | §8.4 layers, fail-closed assertion, pinned-version test |
| R3 | Child process runs as the server user with no OS isolation | High | §8.7; documented as a limit; no claim of a sandbox |
| R4 | Transcripts or memory written outside the data folder | Medium | `persistSession: false`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| R5 | Cost runaway; no usage in events | Medium | `maxTurns`, `maxBudgetUsd` (estimate may overshoot), concurrency limit, audit of `total_cost_usd` |
| R6 | Orphaned child processes after cancel, crash or restart | Medium | Test on the pinned version; supervise on `dispose`; **[Q]** group kill behaviour unconfirmed |
| R7 | MCP tool-call timeout shorter than an approval wait | Medium | `createSdkMcpServer({ timeout })`; test with a 6-minute simulated wait |
| R8 | SDK defaults change between versions | Medium | Pin exactly; set every option explicitly; changelog review on upgrade |
| R9 | Dependency size (~331 MB binary), licence and terms | Medium | Decide before install (§13); API-key auth only |
| R10 | Final-check-to-rename race in writes (no `openat`) | Low–Medium | Documented stage E limit; unchanged |
| R11 | Event-loop stall from synchronous `fileOps` under real load | Low–Medium | Existing caps and deadlines; measure in 3B.5.2 |

### 12.3 Open questions

1. Does `tools: []` remove every built-in in 0.3.317, including task/agent/skill tools? 2. Default MCP tool-call timeout and whether `createSdkMcpServer({ timeout })` covers a long wait. 3. Does abort or `close()` terminate the child promptly, and does it exit when our process dies? 4. Memory and start-up time per child (decides `MAX_CONCURRENT_TASKS`). 5. Which `result` subtypes and `api_error_status` values we should map to user-facing copy. 6. Does `permissionMode: 'dontAsk'` plus `allowedTools` auto-approve in-process MCP tools exactly as documented? 7. Whether `permissionPrompts: 'none'` (CLI ≥ 2.1.259) is available in the bundled binary. 8. Legal reading of the SDK licence for this product.

### 12.4 Assumptions

The bundled binary's behaviour matches the docs for the pinned version; the child exits when stdin closes; the default spawn does not trigger the process-execution guard; zod 4 can be added without conflicting with the existing toolchain; the host has a writable `DATA_DIR` on a local disk.

## 13. Prerequisites before implementation

1. **Decision:** accept the dependency footprint (SDK, `zod ^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, ~331 MB platform binary) and the licence/terms review (§12.3 Q8). Pin the exact version.
2. **Build:** externalise the SDK in `vite.server.config.ts` and document that `server:start` needs `node_modules` (G1).
3. **API key handling:** a key provisioned only on the backend host; policy for spend limits (an Anthropic-side limit is recommended in addition to `maxBudgetUsd`).
4. **Update the placeholder guidance** in `claudeAgent.ts` and `docs/gated-tools.md` to §8 (handler gate, empty cwd) in the 3B.5.1 PR, so docs and code agree.
5. **OS user:** decide whether the server runs under a dedicated unprivileged user for any run that touches real files (recommended before 3B.5.3; required on any shared machine).
6. **Independent security review** of §8 before 3B.5.3 (writes).
7. Answers to open questions 1 to 3 by a pinned-version test in 3B.5.1.

Not prerequisites: Docker; a worker process; the optional sandbox-runtime step; B11 (Bash stays off).

## 14. Final readiness verdict

**READY WITH CONDITIONS.**

- Verified and sufficient: the gate, permission engine, gated tools, policy, audit, restart recovery, event system and UI contract (§3, §4).
- Conditions: §13 items 1 to 4 before any code; item 7 inside 3B.5.1; items 5 and 6 before 3B.5.3.
- Not claimed: no real Claude agent is operational; nothing was run against the SDK; no sandbox exists; workspace validation is policy, not isolation.
