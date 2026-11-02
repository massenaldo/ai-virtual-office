# Milestone 3B.4 Stage E: Gated File Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the six catalogue tools real, safe bodies on the backend: five file tools (`Read`, `Glob`, `Grep`, `Write`, `Edit`) that perform their file access inside the gate's `perform`, plus a `Bash` stub that never runs anything. A sensitive-path denylist covers every tool. Backend only, no SDK, no real Claude.

**Architecture:** `server/sensitivePaths.ts` is checked by `decideToolUse`, so it applies at ask time and again at use time. `server/fileOps.ts` holds the filesystem operations, each taking the checked workspace path, a relative path and an `AbortSignal`, and returning a fixed error code instead of an operating-system message. `server/tools/gatedTools.ts` turns a `StartContext` into one handler per tool, each a thin call to `ctx.tools.use(request, perform)` whose result is a short fixed text. Node has no `openat`, so safety comes from per-component `lstat`, `O_NOFOLLOW`, an `fstat`/`lstat` identity comparison, same-directory temp file and `rename`; the residual window is documented, not hidden.

**Tech Stack:** TypeScript, Node `fs`, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md` §4.6; `docs/gated-tools.md`; audit blockers B1, B2, B6, B7 in `docs/milestone-3b4-final-report.md`.

## Global Constraints

- Branch `feat/3b4-e-gated-tools`; conventional commits ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- No `child_process`, `exec`, `spawn`, `fork` or `worker_threads` anywhere; `server/noProcessExecution.test.ts` is not edited and must pass.
- No SDK, no Docker, no real Claude. `MockRuntimeProvider` and `ServerMockProvider` unchanged: the mock's demo `perform` stays a no-op, so nothing on the mock path writes a file.
- The tools are reached **only** through `ToolGate.use`. The handlers never see the policy, a rule or an approval id. `perform` re-derives every path from `action.workspace.path` plus `action.paths[].relative`, never from the input strings.
- Errors returned to a caller come from the fixed list `FileOpError` / `ToolErrorCode`. They never contain a host path, the workspace root, the data folder, an operating-system message or content the model sent.
- Tool output is redacted with `redactSecrets` and capped. Defaults: `FILE_READ_MAX_BYTES = 65536`, writes capped at `REVIEW_MAX_BYTES` (`src/workforce/types`), `GLOB_MAX_RESULTS = 500`, `GREP_MAX_MATCHES = 200`, `GREP_MAX_FILE_BYTES = 1048576`, `TRAVERSAL_MAX_ENTRIES = 10000`.
- Every file operation checks `signal.aborted` before each step and throws/returns `aborted`; a cancelled write never renames.
- Verification at the end: `rtk proxy npm test`, `npx tsc -b`, `npm run build`, `npm run server:build`, `npm run check:secrets`, `npm audit`.

## Review Focus

1. **Symlink swapped after the check:** a directory or file replaced by a symlink to outside the workspace between `decideToolUse` and `perform` writes nothing outside. Tasks 2, 3.
2. **Hard link to an outside file:** `Write` and `Edit` on a file with `nlink > 1` are refused and the outside file is untouched. Task 3.
3. **Sensitive files reached indirectly:** `Glob`/`Grep` with no path, a `glob` filter or a symlinked directory never list or search `.env*`, `.git/`, keys, or the data folder. Tasks 1, 4.
4. **Huge or binary input:** a 10 GB file, a binary file, a 100k-entry tree and a pattern with regex metacharacters (`(a+)+$`) return a capped result or a fixed error quickly, never hang or exhaust memory. Task 4.
5. **Approved `Bash` still does nothing:** even with a once-grant and a human approval, the handler returns `not_supported` and no process starts. Task 5.

---

### Task 1: Sensitive-path denylist in the policy

**Files:**
- Create: `server/sensitivePaths.ts`, `server/sensitivePaths.test.ts`
- Modify: `server/toolPolicy.ts` (`DenyReason`, `DENY_TEXT`, `ToolPolicy`, `toolPolicyFrom`, `decideToolUse`), `server/toolPolicy.test.ts`

**Interfaces:**
- Produces: `isSensitiveRelative(relative: string): boolean`; `isProtectedAbsolute(absolute: string, roots: readonly string[]): boolean`; `ToolPolicy` gains `protectedRoots: readonly string[]`; `DenyReason` gains `'sensitive_path'` (text `'the path is protected'`); `toolPolicyFrom(config: Pick<ServerConfig, 'allowedTools' | 'dataDir'>)` puts the real path of `dataDir` in `protectedRoots`.

- [ ] **Step 1: Write failing tests** in `sensitivePaths.test.ts`: `isSensitiveRelative` is true for `.env`, `.env.local`, `sub/.ENV`, `.git/config`, `a/.git`, `key.pem`, `id_rsa`, `id_ed25519.pub`, `.ssh/config`, `.aws/credentials`, `.npmrc`, `.netrc`, `credentials.json`; false for `src/env.ts`, `environment.md`, `gitignore.txt`, `a/b.txt`. Matching is per segment and case-insensitive (macOS). `isProtectedAbsolute('/x/data/api-token', ['/x/data'])` is true, `'/x/database'` is false.
- [ ] **Step 2: Run** `rtk proxy npx vitest run server/sensitivePaths.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the two functions with a fixed segment list and extension list (`.pem`, `.key`, `.p12`, `.pfx`) and `isInside` from `server/workspaces.ts`.
- [ ] **Step 4: Write failing tests** in `toolPolicy.test.ts`: for each of Read, Write, Edit, Glob (`path`), Grep (`path`), a `file_path`/`path` of `.env`, `.git/HEAD`, or a path inside `protectedRoots` gives `{ decision: 'deny', reason: 'sensitive_path' }`; a Glob `pattern` or Grep `glob` that starts with `.env` or contains a `.git/` segment is also denied; a normal path is unaffected.
- [ ] **Step 5: Implement** in `decideToolUse`: after `checkPathInWorkspace` succeeds, deny when `isSensitiveRelative(checked.relative)` or `isProtectedAbsolute(join(workspace.path, checked.relative), policy.protectedRoots)`; apply the relative check to `glob`/`pattern` text too. Update every existing `ToolPolicy` construction (tests, `taskManager`, `app.ts`) for the new field.
- [ ] **Step 6: Run** `rtk proxy npm test` — expect all pass, then commit `feat(server): refuse sensitive paths in every tool`.

### Task 2: fileOps foundation — safe open and read

**Files:**
- Create: `server/fileOps.ts`, `server/fileOps.test.ts`

**Interfaces:**
- Produces:
  - `type FileOpError = 'not_found' | 'not_a_file' | 'not_a_directory' | 'unsafe_path' | 'too_large' | 'not_text' | 'not_unique' | 'no_match' | 'conflict' | 'aborted' | 'failed'`
  - `class FileOpFailure extends Error { constructor(readonly code: FileOpError) }` (message is the code, never a path).
  - `openInside(workspacePath: string, relative: string, flags: number, signal: AbortSignal): number` — returns a file descriptor.
  - `readTextFile(workspacePath: string, relative: string, signal: AbortSignal): { text: string; truncated: boolean; bytes: number }`
  - constants listed under Global Constraints.

- [ ] **Step 1: Write failing tests** (real temp directory, `mkdtempSync`): reads a normal file; truncates at `FILE_READ_MAX_BYTES` and sets `truncated`; a missing file is `not_found`; a directory is `not_a_file`; a file containing a NUL byte is `not_text`; a symlink as the final component is `unsafe_path`; a symlinked directory component is `unsafe_path`; a hard-linked file (`nlink > 1`) is `unsafe_path`; an aborted signal is `aborted` before any open; **swap test:** replace a directory component with a symlink to an outside folder after `relative` is chosen and before the open (done by a test hook parameter `beforeOpen?: () => void` on `openInside`) and expect `unsafe_path` with the outside file unread.
- [ ] **Step 2: Run** `rtk proxy npx vitest run server/fileOps.test.ts` — expect FAIL.
- [ ] **Step 3: Implement `openInside`.** Walk `relative` component by component from `workspacePath` using `lstatSync`; every directory component must be a real directory (not a symlink); open the final component with `O_NOFOLLOW`; then `fstatSync` the descriptor and `lstatSync` the path again and require equal `dev` and `ino`; require the real path of the parent to stay inside the workspace (`isInside`). Any violation closes the descriptor and throws `FileOpFailure('unsafe_path')`. Map `ENOENT`, `EISDIR`, `ELOOP`, anything else to the codes above; no raw error escapes.
- [ ] **Step 4: Implement `readTextFile`:** open read-only, `fstat` must be a regular file with `nlink === 1`, read at most `FILE_READ_MAX_BYTES + 1` bytes from the descriptor, reject NUL in the read bytes, decode UTF-8, always close the descriptor in `finally`.
- [ ] **Step 5: Run the tests** — expect PASS; commit `feat(server): safe workspace file open and read`.

### Task 3: fileOps — atomic write and edit

**Files:**
- Modify: `server/fileOps.ts`, `server/fileOps.test.ts`

**Interfaces:**
- Consumes: Task 2 (`openInside`, `FileOpFailure`, `FileOpError`).
- Produces:
  - `writeTextFile(workspacePath: string, relative: string, content: string, signal: AbortSignal): { bytes: number; created: boolean }`
  - `editTextFile(workspacePath: string, relative: string, oldString: string, newString: string, replaceAll: boolean, signal: AbortSignal): { replacements: number }`

- [ ] **Step 1: Write failing tests:** write creates a file (and missing parent directories are **not** created: `not_found`); overwrite keeps the existing file mode; content over `REVIEW_MAX_BYTES` is `too_large` and nothing is written; no `.tmp` file is left after success, failure or abort; **abort before rename** (a `signal` aborted by a test hook between temp write and rename) leaves the original content and no temp file; hard-linked target is `unsafe_path` and the outside inode keeps its content; target replaced by a directory is `not_a_file`; symlink swapped into the parent after the check writes nothing outside (same hook as Task 2); two concurrent writes to one file leave one complete winner, never a mix; edit with a unique `old_string` replaces it; with zero matches is `no_match`; with two matches and `replaceAll: false` is `not_unique` and leaves the file unchanged; `replaceAll: true` replaces all and reports the count; an empty `old_string` is `no_match`; the result file is exactly the new content.
- [ ] **Step 2: Run** the file's tests — expect FAIL.
- [ ] **Step 3: Implement `writeTextFile`:** open the parent directory safely (reuse the `openInside` walk on the parent), create the temp file in that directory with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600 or the existing target's mode, write, `fsync`, check `signal.aborted`, re-verify the parent is still the same directory (`dev`/`ino`) and inside the workspace, then `renameSync` over the target; remove the temp file in `finally` on any failure. `editTextFile` reads through `readTextFile`'s checks (a file over the cap is `too_large`, not truncated), counts occurrences, then calls the same write path.
- [ ] **Step 4: Run the tests** — expect PASS; commit `feat(server): atomic workspace write and edit`.

### Task 4: fileOps — bounded Glob and Grep

**Files:**
- Modify: `server/fileOps.ts`, `server/fileOps.test.ts`

**Interfaces:**
- Consumes: Task 1 (`isSensitiveRelative`), Task 2 (`readTextFile`-style safe open), `matchesPathPattern` and `isValidPathPattern` from `server/permissions/pathPattern`.
- Produces:
  - `globFiles(workspacePath: string, baseRelative: string, pattern: string, signal: AbortSignal, protectedRoots: readonly string[]): { paths: string[]; truncated: boolean }`
  - `grepFiles(workspacePath: string, baseRelative: string, pattern: string, opts: { glob?: string; ignoreCase: boolean; mode: 'content' | 'files_with_matches' }, signal: AbortSignal, protectedRoots: readonly string[]): { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }`

- [ ] **Step 1: Write failing tests:** glob `**/*.ts` returns sorted workspace-relative paths; `.env`, `.git/**`, key files and the protected root are never returned even when the pattern names them; a symlinked file or directory is skipped, never followed; results stop at `GLOB_MAX_RESULTS` with `truncated: true`; traversal stops at `TRAVERSAL_MAX_ENTRIES`; an invalid glob (`isValidPathPattern` false) throws `FileOpFailure('unsafe_path')`; abort mid-walk throws `aborted`. Grep: the pattern is matched as a **fixed string**, so `(a+)+$` finds only that literal text and returns in under 100 ms on a 1 MB file of `a`s; `ignoreCase` works; binary files (NUL in the first 8 KiB) and files over `GREP_MAX_FILE_BYTES` are skipped; matches stop at `GREP_MAX_MATCHES`; each match line is cut to 200 characters; sensitive files are skipped.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** an iterative walk with `readdirSync(..., { withFileTypes: true })` that skips symlinks (`dirent.isSymbolicLink()`), sensitive names and protected roots, counts entries against the cap, and checks the signal per directory. Grep opens files through the safe-open helper. The fixed-string decision is deliberate: the SDK's regex Grep is not reproduced, because a model-supplied regular expression cannot be made safe in Node without a worker (forbidden); the tool's description says so.
- [ ] **Step 4: Run the tests** — expect PASS; commit `feat(server): bounded workspace glob and grep`.

### Task 5: Gated tool handlers

**Files:**
- Create: `server/tools/gatedTools.ts`, `server/tools/gatedTools.test.ts`

**Interfaces:**
- Consumes: `StartContext`, `ToolGate`, `GatedOutcome`, `GatedAction` (`server/runtime/types`); all fileOps functions; `redactSecrets`; `truncateUtf8`.
- Produces:
  - `type ToolErrorCode = FileOpError | 'denied' | 'denied_by_policy' | 'expired' | 'cancelled' | 'stale_approval' | 'revoked' | 'invalid_input' | 'not_supported'`
  - `type ToolResult = { ok: true; text: string } | { ok: false; error: ToolErrorCode; text: string }`
  - `createGatedTools(ctx: Pick<StartContext, 'tools'>, opts: { protectedRoots: readonly string[] }): Record<'vo_read' | 'vo_glob' | 'vo_grep' | 'vo_write' | 'vo_edit' | 'vo_run', (input: unknown) => Promise<ToolResult>>`
  - `RESULT_TEXT: Record<ToolErrorCode, string>` — the only error sentences ever returned.

- [ ] **Step 1: Write failing tests** with a fake `ToolGate` (calls `perform` immediately, or returns a chosen denial): `vo_write` success text is `Wrote N bytes to <relative>.`; `vo_edit` success is `Edited <relative>.`; each gate denial outcome maps to its `RESULT_TEXT` entry; a `FileOpFailure` inside `perform` maps to its code; a non-`FileOpFailure` exception becomes `failed`; **no result text ever contains the workspace path or any input content** (assert on a path and a marker string for every tool and every error); `vo_read` output is redacted (a planted `sk-…`-style secret becomes `[REDACTED]`) and capped; `vo_run` with the gate approving still returns `{ ok: false, error: 'not_supported' }` and `perform` never touches the filesystem; the tool name sent to the gate is the policy name (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash`).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** each handler as `gate.use({ tool, input }, perform)` where `perform(action)` uses `action.workspace.path`, `action.paths[0]?.relative` (or `'.'` for Glob/Grep with no path) and `action.signal`, never the raw input path. `vo_read` returns `redactSecrets(text)` plus a truncation marker; `vo_glob`/`vo_grep` return newline-joined results, redacted and capped.
- [ ] **Step 4: Run** the tests — expect PASS; commit `feat(server): gated file tool handlers`.

### Task 6: Integration through the real manager

**Files:**
- Create: `server/tools/gatedTools.integration.test.ts`
- Modify: `server/test/fakeProvider.ts` only if it needs to expose its `StartContext` (additive)

**Interfaces:**
- Consumes: `createGatedTools`, the real `TaskManager`/`startContext` helpers in `server/test/*`, a temp workspace root.

- [ ] **Step 1: Write the tests** (real manager, fake provider, temp workspace): Write is `ask` → task waits → approve once → file exists with the exact content; deny → no file; `allow_task` then a second Write needs no prompt; revoking the task rule while a slow write is in progress aborts it and leaves no temp file or partial file; Write over `.env` and over a path inside the data folder is `denied_by_policy` before any prompt; a symlink `ws/link -> /outside` makes `vo_write` of `link/x` fail with no file outside; a stale approval (the target directory swapped for a symlink between approval and `perform`) is refused; the audit log contains `tool.*` and `permission.*` records but **no file content and no absolute path**; `vo_read` of an allowed file needs no prompt and is audited; a once-approved `vo_run` runs nothing.
- [ ] **Step 2: Run** — expect PASS (the units already exist); fix only what real integration reveals, in the owning module with its own test.
- [ ] **Step 3: Commit** `test(server): gated file tools through the real manager`.

### Task 7: Documentation and report

**Files:**
- Modify: `docs/gated-tools.md` (status line: implemented on the backend; fixed-string Grep and the `Read`/`Glob`/`Grep` move recorded), `server/runtime/claudeAgent.ts` (update the KNOWN GAP comment: the tools exist; the provider must register only `vo_*` tools and disallow built-ins), `README.md` (one paragraph)
- Create: `docs/milestone-3b4-stage-e-report.md`

- [ ] **Step 1:** Write the report in the format of the stage C report: verification table with real results, what changed, security implications, residual limits (no `openat`, the window between `fstat` and `rename`, same-user processes, fixed-string Grep, mock does not write), and what is left (stages D, F, G).
- [ ] **Step 2:** Run the full verification list from Global Constraints and paste real results.
- [ ] **Step 3:** Commit `docs: milestone 3B.4 stage E report`, push, open the PR against `main`.

## Self-review notes

- **Spec coverage:** §4.6 denylist (Task 1), `fileOps` with `O_NOFOLLOW`, `fstat`, `nlink`, size caps, temp file, `fsync`, `rename`, abort checks (Tasks 2, 3), `vo_*` handlers with capped, redacted output and `vo_run` that always refuses (Task 5), mock may demo (decided: it stays a no-op; Task 6 proves the path with a fake provider), `noProcessExecution` untouched (Global Constraints).
- **Deviations to confirm:** Grep is fixed-string, not regex; the mock demo does not write; per-component `lstat` plus identity comparison stands in for `openat`, which Node lacks.
- **Types:** `FileOpError`, `FileOpFailure`, `ToolErrorCode` and `ToolResult` are defined once (Tasks 2 and 5); later tasks only consume them.
