**Design and audit only. Nothing here is implemented.** The Claude Agent SDK is not installed, no real Claude execution exists, and the mock runtime is the only runtime that runs. This supersedes the Docker route in `docs/sandbox-architecture.md` for the local-development phase: no Docker and no container runtime.

# Native host execution: audit, architecture and roadmap to Milestone 3B.5

Date: 2026-10-31. Audited on the tip of the 3B.1.2 stack (`docs/3b12-7-report`), read from the code; the earlier test counts were not re-run for this audit.

## 1. Current architecture audit

**Repository state.** PRs #33–#39 were each merged into the previous stage branch, so `main` received only #32 (plan and tasks). PR #40 lands the whole stack on `main`. Until it merges, `main` does not contain the code below.

**What holds up in the code**

| Area | Finding |
|---|---|
| Tool gate (`server/toolGate.ts`) | Frozen copy of the input; SHA-256 digest of task, workspace (id and real path), tool and input; after approval it re-checks that the task is live and the signal is not aborted, re-resolves the workspace, recomputes the digest and re-runs the policy, then calls `perform` with the signal and the checked relative paths. A change gives `stale_approval`. |
| Workspaces (`server/workspaces.ts`) | Explicit id allowlist under one real root, re-resolved on every check; no `..` anywhere; symlink escapes, dangling links and hard links (`nlink > 1`) refused; `DATA_DIR` may not sit inside a workspace. |
| Policy (`server/toolPolicy.ts`) | Closed tool catalogue and closed field list per tool; Write and Edit carry an exact bounded review; invisible and reordering characters refused in every approval summary. |
| Lifecycle (`server/taskManager.ts`) | Task timer, approval timer, cancel grace, one `AbortController` per run, `finalize` releases a pending tool call. |
| Auth | Constant-time bearer token, 0600 token file, loopback-only bind, only plain `/api/` forwarded by the dev proxy, one server per data folder. |
| Process guard | `server/noProcessExecution.test.ts` forbids `child_process`, spawn, exec, fork and worker threads, and permission-bypass option names. |

**Gaps the code shows**

1. **Read, Glob and Grep need no human approval** (`decision: 'allow'`) and nothing blocks sensitive files inside a workspace (`.env`, `.git/config`, key files). With a real model, what it reads goes to the API.
2. **Bash is not safe to enable.** The policy takes one free-text command string and asks a person. There is no program or argument policy, so "never execute arbitrary shell strings" is not met.
3. **`perform` has no safe file operations behind it.** `checkPathInWorkspace` checks path strings; a window remains between the check and the file access. The descriptor-based steps in `docs/gated-tools.md` are not built.
4. **Process lifecycle:** `server/index.ts` handles SIGINT and SIGTERM with no hard deadline; there is no SIGHUP, `uncaughtException` or `unhandledRejection` handler; a SIGKILL of the server would orphan any child; output caps exist for events, not for child-process output.
5. **Credentials:** the SDK would inherit the server's whole `process.env`.
6. **Browser login** still depends on the dev proxy (`Sec-Fetch-Site` is not authentication against other local programs; see `docs/browser-auth.md`).
7. **Audit:** `approval.decided` and `tool.*` records exist, but not the digest or a hash of the approved action.
8. **No separation between agents:** every agent may use every configured workspace.

## 2. Native host execution architecture

1. **One reviewed spawn point.** The SDK launches a native binary, so `noProcessExecution.test.ts` is changed to allow exactly one file, `server/runtime/claudeProcess.ts`, with a justification. It uses the SDK's `spawnClaudeCodeProcess` hook so the server controls the environment, the process group and the kill.
2. **Built-ins removed, not filtered.** `tools: []` removes every built-in tool, so the model only sees our in-process MCP tools (`vo_read`, `vo_glob`, `vo_grep`, `vo_write`, `vo_edit`, `vo_run`). Each handler calls `ctx.tools.use(request, perform)`, so the file or process action happens inside the gate.
3. **Defence in depth.** Also `disallowedTools` for built-ins, a `PreToolUse` hook that denies any tool outside our names (the one place that runs on every call, because auto-approved calls never reach `canUseTool`), a deny-all `canUseTool`, `permissionMode: 'default'`, `settingSources: []`, no `additionalDirectories`, empty `allowedTools`.
4. **File operations** (`server/fileOps.ts`): open the parent by descriptor and walk one component at a time with `O_NOFOLLOW`; `fstat` the descriptor and require a regular file with `nlink === 1` and a size cap; write a same-directory temp file, `fsync`, `rename`; check the abort signal before every step. A sensitive-path denylist applies to reads too (`.env*`, `.git/`, `*.pem`, `id_*`, `.ssh`, `.aws`, the data folder). Reads stay without a prompt but are capped, redacted and audited.
5. **Commands as `vo_run`, not a shell.** Input is `{ program, args[] }`, run with `shell: false`. Only programs in an explicit allowlist, each with its own argument grammar (first set: `git status|diff|log|show`, `ls`, the project's `npm test`). No pipes, redirects or substitution. The working directory is the workspace. The environment is a fixed allowlist (`PATH`, a throwaway `HOME`, `LANG`) with no API key and no `*_TOKEN`. Every run needs a person to approve the exact argv.
6. **Process supervisor** (`server/processSupervisor.ts`): each child leads its own process group; wall-clock timeout; stdout and stderr caps with truncation; on cancel SIGTERM to the group, then SIGKILL after the grace period; a registry of live children swept on shutdown and at start-up; handlers for `exit` and `error`; a hard shutdown deadline; SIGHUP, `uncaughtException` and `unhandledRejection` handlers.
7. **Credentials.** The server never passes `process.env` to the SDK. It builds an explicit `env` (which replaces the child's environment) holding only what the SDK needs. `ANTHROPIC_API_KEY` is read once into a `Secret`. The SDK docs recommend a credential-injecting proxy through `ANTHROPIC_BASE_URL` so the agent never sees the key; that is the target for a VPS.
8. **Approvals.** Keep the digest, the 409 on mismatch, the use-time re-check and `stale_approval`. Add the digest and a hash of the exact action to the `approval.decided` audit record.
9. **Authentication.** Build the session cookie from `docs/browser-auth.md` before real execution. The backend stays on loopback.
10. **Agent separation.** Optional per-agent workspace list; the default stays "all configured workspaces".

## 3. Limits of native execution, and mitigations

Without Docker there is no kernel isolation between the agent's tools and the rest of the machine. Everything above is policy on the host.

- The backend and every child run as the same user. A bug in `fileOps` or the argv policy is a bug with that user's file access.
- A child can read anything that user can, unless a policy blocks the program or the path.
- An allowlisted program can still reach the network.
- Descriptor-based operations narrow time of check to time of use for files; they do not help for programs.

| Native isolation option | Assessment |
|---|---|
| Dedicated macOS user running the child through `sudo -u` | The most practical: home, SSH keys and Keychain become unreachable. Needs one-time admin setup, a workspace that user can access and a sudoers rule. Optional and documented for local use; required on a VPS. |
| macOS Seatbelt profile (`sandbox-exec`) | Used by the SDK's own sandbox for its Bash. Apple marks the command-line tool deprecated, but it works today. A second layer for `vo_run`, never the only one. |
| SDK `sandbox` option | Covers the SDK's built-in Bash only, which this design removes. Does not apply to our own tools. |
| Linux (VPS) | bubblewrap, a dedicated user and systemd hardening (`ProtectHome`, `PrivateTmp`, `NoNewPrivileges`). Needed before any real use there. |

The SDK's secure-deployment guidance puts the isolation boundary around the SDK itself (sandbox-runtime, then hardened containers, then gVisor and Firecracker). Native host execution is the weakest tier it describes: acceptable for local development on files you accept the agent might touch, not for untrusted prompts or a shared machine.

## 4. Claude Agent SDK compatibility (as of 2026-10-31)

Sources are the official pages under `https://code.claude.com/docs/en/agent-sdk/` (`typescript`, `permissions`, `custom-tools`, `agent-loop`, `overview`, `secure-deployment`), `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest` and the package's GitHub `CHANGELOG.md`. The npmjs.com page itself returned 403. Re-check every item against the pinned version before relying on it.

- **Package and versions:** `@anthropic-ai/claude-agent-sdk`, latest 0.3.316; Node `>=18.14.0`; peers `zod ^4`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`. Pin an exact version.
- **Process:** spawns a native Claude Code binary from per-platform optional packages (`--omit=optional` installs none; then set `pathToClaudeCodeExecutable`). `spawnClaudeCodeProcess` supplies our own spawn.
- **Credentials:** `ANTHROPIC_API_KEY`; the SDK does not read `.env`. The `env` option replaces the child's environment; the default is all of `process.env`.
- **Custom tools:** `tool(name, description, zodShape, handler)` and `createSdkMcpServer(...)`, run in our process; names become `mcp__<server>__<tool>`; a throwing handler becomes an error result.
- **Permission order:** hooks, deny rules, ask rules, permission mode, allow rules, then `canUseTool`. Auto-approved tools never reach `canUseTool`. A `PreToolUse` hook runs on every call.
- **Removing built-ins:** `tools: []`; a bare `disallowedTools` name removes a tool from the model's context.
- **Defaults have moved between versions** (`permissionMode` in 0.3.286 and 0.3.302, `settingSources`, `env`): set all of them explicitly.
- **Stream mapping (inference, not a documented mapping):** before `system/init` queued; after it running; while our approval promise is pending waiting for approval; a `success` result completed; other result subtypes or a throw without a result failed; our own abort cancelled. A single-shot `query()` yields the error result and then throws, so wrap the loop in try/catch and do not stop at the first `result`.
- **Cancellation:** `abortController` closes stdin, waits about 2 seconds, then fires the spawn signal; `close()` ends the query. Whether the child or its process group is SIGKILLed is **unconfirmed**; unofficial sources report orphan risk. There is no built-in wall-clock timeout (use our timer, `maxTurns`, `maxBudgetUsd`). Because we own the spawn, the supervisor kills the group itself.
- **To verify in a test against the pinned version:** that no built-in tool is visible to the model with `tools: []`. Design point 2 depends on it.

## 5. Implementation stages

Each stage is one branch and one pull request. 3B.5 is the real runtime, as in the brief.

### Stage 0: land 3B.1.2 on `main`
- **Scope / files:** merge PR #40. No code change.
- **Depends on:** nothing. **Risk:** none.
- **Tests / acceptance:** on `main`: `npm test`, `npx tsc -b`, `npm run build`, `npm run check:secrets` pass.
- **Rollback:** revert the merge commit.

### 3B.2: safe file operations
- **Scope:** descriptor-based read, write and edit primitives and a sensitive-path denylist.
- **Files:** new `server/fileOps.ts`, `server/sensitivePaths.ts` and their tests; `server/toolPolicy.ts` (denylist for reads); `docs/gated-tools.md`.
- **Depends on:** 0. **Risk:** a bug is host file access as the user.
- **Tests:** symlink in the path, symlink swapped after the check, hard link, directory in place of a file, too large, abort before rename, two writers, each denylist entry.
- **Acceptance:** none of those tests reads or writes outside the workspace.
- **Rollback:** revert; nothing calls it yet.

### 3B.3: gated in-process tools
- **Scope:** `vo_read`, `vo_glob`, `vo_grep`, `vo_write`, `vo_edit` as handlers over `ctx.tools.use`.
- **Files:** new `server/tools/*.ts` and tests; `server/toolPolicy.ts` (names); `server/runtime/mockProvider.ts` (optional demo through them).
- **Depends on:** 3B.2. **Risk:** read output volume and secrets in read output.
- **Tests:** each tool through the real gate and task manager, stale approval, output cap, redaction.
- **Acceptance:** the digest check and the use-time re-check run before every file operation.
- **Rollback:** revert; the mock path is untouched.

### 3B.4: process supervisor and `vo_run`
- **Scope:** the supervisor, the program and argument policy, shutdown hardening.
- **Files:** new `server/processSupervisor.ts`, `server/runPolicy.ts` and tests; `server/noProcessExecution.test.ts` (allowlist for exactly one file, with justification); `server/index.ts` (signal and shutdown handlers); `server/config.ts` (program allowlist, environment allowlist).
- **Depends on:** 3B.3. **Risk:** the highest: it executes programs, and the guard change needs its own review.
- **Tests:** shell metacharacters never reach a shell; a program outside the allowlist is refused; timeout and cancel kill the group; output cap; orphan sweep; SIGKILL of the server; no secret in the child environment.
- **Acceptance:** no child outlives its task in any test.
- **Rollback:** revert, including the guard change.

### 3B.4b: browser login (parallel with 3B.4)
- **Scope:** session cookie pairing per `docs/browser-auth.md`.
- **Files:** `server/http/routes.ts`, `server/http/guards.ts`, `server/auth.ts`, `src/workforce/remote/client.ts`, `src/workforce/remote/sync.ts`, a connect screen under `src/workforce/ui/`.
- **Depends on:** 0. **Risk:** cookie scope and CSRF.
- **Tests:** cookie flags, rotation, wrong token, `localhost` versus `127.0.0.1`, JSON-only mutations still enforced.
- **Acceptance:** the app works without the dev proxy.
- **Rollback:** revert; the dev proxy remains.

### 3B.5: real Claude provider
- **Scope:** install the SDK pinned; the real provider, event mapping and explicit `env`.
- **Files:** `package.json`, `server/runtime/claudeAgent.ts`, new `server/runtime/claudeProcess.ts`, `server/config.ts`, `README.md`.
- **Depends on:** 3B.2 to 3B.4b and an independent security review. **Risk:** a real model, real cost, a real spawn.
- **Tests:** no built-in tool visible (against the pinned version), mapping and cancel tests with a fake SDK, one manual run in a scratch workspace.
- **Acceptance:** the provider cannot use a tool except through the gate.
- **Rollback:** set `RUNTIME=mock` and uninstall the SDK.

## 6. Blockers before Milestone 3B.5

1. 3B.1.2 on `main` (PR #40).
2. `fileOps` and the gated tools, so no file access happens outside the gate.
3. The sensitive-path denylist for reads.
4. The argument policy and process supervisor, or command execution stays off.
5. The one guarded spawn exception, in its own reviewed PR.
6. An explicit SDK `env`, so the server environment never reaches the agent.
7. Browser cookie login before any shared or remote use.
8. A test against the pinned SDK that built-ins are absent.
9. The digest and an action hash in the audit record.
10. A decision on the dedicated OS user: recommended optional and documented for local use, required on a VPS.

## 7. Constraints kept

No Docker or container runtime; no SDK installed; no real Claude execution; no unrestricted shell; no security control weakened; `MockRuntimeProvider` kept; the 3D office and layout editor untouched.
