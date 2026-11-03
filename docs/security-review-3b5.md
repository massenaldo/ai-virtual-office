# Security review: Claude Agent runtime (3B.5), branch chore/3b5-prerequisites @ 1fb866f

## Verdict

The gate itself holds up. Every model tool call goes through `ctx.tools.use`. The approval is bound to an exact digest. The use-time re-check, the once-grant spend and the fail-closed paths work as intended. `fileOps` refuses symlinks, hard links, FIFOs and devices along the whole path. I found no way for an injected model to write outside the workspace, write different bytes from the ones a person approved for a single "allow once", skip the startup assertion, or make the child run code. The serious risk is in what an approval grants, not in how it is enforced. "Allow for this task" and "Allow for this agent" give unreviewed write access to every non-denylisted path in the workspace. The agent scope also applies in every workspace, in every later task, and across restarts. The denylist does not cover the many files that developer tooling later runs on its own (package.json scripts, husky hooks, `.claude/settings.json` hooks, CI workflows, `conftest.py`, `.yarnrc.yml`, and others). So one careless click on a harmless-looking change can become persistent code execution as the user. Secret redaction can be bypassed for PEM private-key bodies (Read with `offset`, Grep in content mode), and the bypass was reproduced. On case-insensitive file systems, the denylist and deny rules can be bypassed with Unicode case folding (verified on the JavaScript side; the macOS side is not verified). It is fine to enable writes with "allow once" only. The broader scopes need the fixes below first.

Counts: Critical 0, High 1, Medium 3, Low 4, Info 6.

---

## High

### H1. "Allow for task/agent" grants unreviewed, path-unbounded, cross-workspace writes, and those writes can make developer tooling run code
- **Where:** `server/taskManager.ts:327-336` (the grant has no `pathPattern` and no workspace); `server/permissions/engine.ts:24-30` (`appliesTo` has no workspace dimension, and `PermissionRule` has no workspace field); `server/taskManager.ts:378-385` (`promote` re-evaluates queued requests, so the new rule allows them without anyone seeing them); `src/workforce/view.ts:224-229` (the label says "Each call is still checked and recorded", which reads as if each call is still reviewed); `server/sensitivePaths.ts:6-8` (no execution-triggering names).
- **Attack:**
  1. A file in workspace `sandbox` contains an injection. The model asks for a harmless `vo_write notes.md` and, in the same turn, queues up to 8 more writes (the SDK runs them one at a time, but each reaches `approveTool` and waits in `toolQueue`).
  2. The approver clicks "Allow Write for Agent X on every task". The queued writes are then allowed with no prompt (`promote` -> `evaluate` -> agent allow).
  3. The writes go to `package.json` (a `"test"`/`"postinstall"` script), `.husky/pre-commit` (husky v9 runs it through `sh` even without the exec bit), `.claude/settings.json` (a `hooks` entry, run the next time the user opens Claude Code in that folder), `.github/workflows/*.yml`, `conftest.py`, `.yarnrc.yml` (`yarnPath:`), `.pnpmfile.cjs`, `Makefile`, or an existing executable `scripts/*.sh` (`writeTextFile` keeps its 0755 mode, `fileOps.ts:198`).
  4. A later task for the same agent in workspace `prod` also writes with no review, because the rule has no workspace binding and outlives restarts (`app.ts:92-96` keeps agent rules).
- **Impact:** Code runs as the user, or in CI with repository secrets, the next time normal tooling runs. The approver saw one harmless change. This defeats goal (b) "write something other than what the approver saw" for every write after the first, and goal (g) scope escalation.
- **Reproduced:** Yes, from code and existing tests. `server/permissions/gateIntegration.test.ts:227` and `:242` assert that later writes, and the next task, run with no prompt. By code: the agent rule has no workspace or path field.
- **Fix:**
  - Bind task and agent grants to the workspace id, and by default to the approved path (an exact path or its directory as a `pathPattern`), not to the whole tool.
  - Add an "execution-sensitive" path class that is always ask-once, whatever the rules say: `package.json`, `.husky/**`, `.claude/**`, `.mcp.json`, `CLAUDE.md`, `.vscode/**`, `.idea/**`, `.github/**`, `.gitlab-ci.yml`, `Makefile`, `*.mk`, `conftest.py`, `setup.py`, `pyproject.toml`, `.yarnrc*`, `.pnpmfile.cjs`, `*.sh`, and any file with an exec bit.
  - Do not let a new scope rule auto-allow requests that were already queued; re-prompt for them.
  - Reword the label to "later writes are NOT shown to you".

---

## Medium

### M1. Private-key redaction is bypassed by Read `offset` and by Grep content mode
- **Where:** `server/tools/gatedTools.ts:94-101` (lines are sliced before `redactSecrets`); `server/fileOps.ts:466` (each line is redacted on its own); `server/redact.ts:75-94` (a key block is found only through its `-----BEGIN … PRIVATE KEY-----` line).
- **Attack:**
  1. The workspace holds a private key in a file whose name is not on the denylist (`deploy_ident`, `certs/server.txt`, `tls/bundle`, `secrets.yaml` with a PEM block).
  2. The model calls `vo_read {file_path, offset: 2}`, or `vo_grep {pattern: "MII", output_mode: "content"}`.
  3. The base64 key body comes back without redaction. The model repeats it in its message or final answer (`taskManager.cap` uses `redactSecrets`, which does not match a base64 body without its header), or puts it in a `vo_write` (the `buildReview` check `redactSecrets(t) !== t` also passes).
- **Impact:** The secret ends up in task output, state, the event log, the UI and workspace files (goal f). Reads need no approval.
- **Reproduced:** Yes. A throwaway tsx script used the real `createGatedTools`, `readTextFile` and `grepFiles` on a temporary workspace. A full read returned `[REDACTED]`. `offset: 2` returned both body lines and the END line verbatim. Grep content returned `deploy_ident:2:MIIEvQ…` verbatim. (When the file was named `deploy_key`, Grep happened to redact, but only because the `key:` pattern matched the file name in `path:line:text`.)
- **Fix:** Run `redactPrivateKeys` (and the other patterns) on the whole decoded file before slicing by offset or limit and before splitting lines for Grep. Alternatively, refuse or skip any file that contains a `PRIVATE KEY-----` marker. Also add `-----END … PRIVATE KEY-----` as a trigger that redacts back to the previous blank line or the start of the text.

### M2. Unicode case folding bypasses the denylist and deny rules on case-insensitive file systems
- **Where:** `server/sensitivePaths.ts:11-12,28` and `server/permissions/pathPattern.ts:33,59` use `toLowerCase()`. `server/workspaces.ts:137` uses `realpathSync`, the JavaScript implementation, which keeps the caller's spelling and does not return the on-disk case.
- **Attack:**
  1. On macOS APFS (case-insensitive) or an ext4 `casefold` directory, the model reads `.ſsh/config` (U+017F LATIN SMALL LETTER LONG S), `credentialſ.json`, `.pgpaſſ`, or, against a user deny rule `secrets/**`, the path `ſecrets/x`.
  2. JavaScript `'ſ'.toLowerCase()` is still `ſ`, so `isSensitiveRelative` returns false and the deny pattern does not match. Case folding in the file system maps U+017F to `s` and opens the protected file.
  3. Reads are allowed by default, so no one is asked.
- **Impact:** The model reads names on the denylist and paths a person explicitly denied (goals a, c, e), but only on case-insensitive or case-folding file systems.
- **Reproduced:** Partly. The JavaScript side was confirmed with tsx: `isSensitiveRelative('.ſsh/config') === false`, and `matchesPathPattern('secrets/**', 'ſecrets/a', false) === false`. The file-system side was not tested: there is no APFS or casefold mount here. This relies on APFS and ext4 casefold using Unicode case folding, where U+017F folds to `s`. Confirm on a Mac.
- **Fix:**
  - Compare after full Unicode case folding plus NFKC, for example `s.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase()`, or a real case-fold table.
  - Better, refuse non-ASCII characters in the segments that the denylist checks.
  - Use `realpathSync.native` (it returns the canonical on-disk spelling on macOS), and run the sensitive and deny checks on that real spelling as well.

### M3. The workspace configuration can expose secrets and the server itself; the denylist is narrow
- **Where:** `server/workspaces.ts:80-101` (the only cross-check is "DATA_DIR not inside a workspace"; a workspace of `.` is allowed); `server/sensitivePaths.ts:6-8`.
- **Attack:**
  1. The operator sets `WORKSPACE_ROOT=$HOME` with `home:.`, or a workspace that contains the server repo, its `node_modules`, or another workspace. All of these are accepted. On this machine, `DATA_DIR=/data/workspace/.../data` is not under `/data/home`, so `home:.` passes.
  2. The model reads files that are not on the list with no approval: `~/.claude/.credentials.json` (the list has `credentials.json` exactly, not `.credentials.json`), `~/.config/gh/hosts.yml`, `~/.bash_history`, `*.tfstate`, `*.tfvars`, `.vault-token`, `.s3cfg`, `.boto`, `~/.config/gcloud/**`, `.azure/**`, `kubeconfig`, `secrets.y*ml`, or another workspace's files.
  3. With an approved write, it edits `server/*.ts` or `node_modules/@anthropic-ai/claude-agent-sdk/**`. The server runs that code on the next start or task.
- **Impact:** Credential disclosure and server code execution (goals d and e). This depends on configuration, but nothing warns or refuses.
- **Fix:**
  - Refuse workspaces that contain, or sit inside, `$HOME`, the server's own directory (`process.cwd()` and the package root), or another workspace.
  - Refuse `.` as a workspace path.
  - Widen the denylist: `.credentials.json`, `.config/gh`, `.config/gcloud`, `.azure`, `*.tfstate*`, `*.tfvars`, `.vault-token`, `.s3cfg`, `.boto`, `*history`, `kubeconfig`, `.claude/.credentials*`, `secrets.*`.

---

## Low

### L1. Grep is an oracle for secrets that redaction hides
- **Where:** `server/fileOps.ts:454-467`; reads and Grep are allowed by default (`permissions/defaults.ts`).
- **Attack:**
  1. `vo_read conf.txt` shows `TOKEN=[REDACTED]`.
  2. `vo_grep {pattern: "TOKEN=a"}`, then `"TOKEN=b"`, and so on in files_with_matches mode reveal one character per hit. Each turn can carry many parallel calls.
  3. A secret format that redaction does not know is not even hidden in the first place. Reproduced: `sk_live_51H…` (Stripe) comes back verbatim from `vo_read`, because the pattern only matches `sk-` with a hyphen.
- **Impact:** Redaction is only defense in depth: the model can recover secrets in the workspace, slowly. The real exfiltration channel is still a reviewed write or task output.
- **Reproduced:** The oracle response (`conf.txt` match) and the unredacted Stripe key were reproduced with tsx.
- **Fix:** Accept and document it, or skip files from Grep whose redacted text differs from the raw text. Add `sk_live_`, `rk_live_`, `xoxe`, `glpat-`, `npm_`, and `AWS_SECRET_ACCESS_KEY`-style patterns.

### L2. Synchronous file operations can block the event loop and freeze the whole server
- **Where:** `server/fileOps.ts:284` (2 s per call), `:316` (`readdirSync` reads the whole directory before any cap or deadline), `gatedTools.ts`.
- **Attack:** In each of up to `maxTurns` (12 by default, 100 at most) turns, the model sends many parallel `vo_grep` calls over a large tree, or one call against a directory with a huge number of entries. Each call blocks the Node event loop for up to about 2 s. They run back to back.
- **Impact:** The HTTP API, SSE, the Cancel button and the approval UI stop responding for minutes. Timers fire late. This is availability only (goal h).
- **Reproduced:** No. It follows from the code.
- **Fix:** Use a budget per task or per turn, not only per call. Allow one search at a time per task. Move Glob and Grep into a worker thread, or use `opendirSync` with an entry cap and a deadline check inside the loop.

### L3. The review does not show whether a write overwrites a file, or that it keeps the exec bit
- **Where:** `server/toolPolicy.ts:143`, `server/fileOps.ts:191-199`.
- **Attack:** `vo_write scripts/release.sh` with plausible content. The approver sees "Write scripts/release.sh (…)" and may think it creates a new file. In fact it replaces an existing 0755 script, which stays executable.
- **Fix:** Add `exists`, `currentBytes` and `mode` (or "executable") to the review, and show a diff for overwrites.

### L4. Audit history can be flushed
- **Where:** `server/audit.ts:91-94` (one rotation, 5 MiB by default).
- **Attack:** Every read writes about two records (`tool.allowed` and `permission.used`). A long task with `CLAUDE_MAX_TURNS=100` and parallel reads can push about 10 MiB, which rotates earlier records out.
- **Fix:** Cap tool records per task, or merge repeated allowed reads into one count record.

---

## Info
- **I1.** `TaskManager.hidePaths` (`taskManager.ts:522-533`) is applied to `review.path` and the summary, so a relative path that contains, for example, `/home/<user>` is shown changed (`x<home>/y`). This only affects the display; the digest still binds the real path. Review content is not passed through `hidePaths`, and `buildReview` rejects only the workspace path itself. The workspace root, the home folder or the data folder can still reach state through content.
- **I2.** The residual TOCTOU windows are documented in `fileOps.ts:102,206,233`. They need a concurrent same-user process that swaps directories. The model has no such ability. A dedicated OS user would not close them (see below), but `openat`/`renameat` through a native addon, or `O_PATH` plus `/proc/self/fd`, would.
- **I3.** All tasks share one `claude-config` directory (`claudeAgent.ts:147`). Concurrent sessions may race on `.claude.json`. Nothing the model can reach, since it is under the protected data folder.
- **I4.** The child's cwd is `DATA_DIR/claude-scratch/<id>`. With the default `DATA_DIR=./data`, that is inside the server's git repo, so any git or CLAUDE.md discovery by the CLI would walk up into the server repo. `settingSources: []` and a custom system prompt should prevent loading. Consider placing the scratch folder outside any repo, for example under `os.tmpdir()` with mode 0700.
- **I5.** Homoglyph paths (Cyrillic `а` in `src/аpp.ts`) pass the INVISIBLE check. A person could approve a "new" file believing it is the existing one. This is low impact.
- **I6.** Managed settings (`/etc/claude-code/managed-settings.json`) are not disabled by `settingSources: []`. Root could inject hooks. That is outside this threat model, but worth knowing.

---

## Checked and found sound
- **Gate ordering** (`toolGate.ts`): the input is deep-cloned and frozen before the digest. The digest binds the task, workspace id and real path, the tool and the input. After approval it checks again: liveness and abort, workspace re-resolution, digest equality, a full `decideToolUse`, then `permit`, then `track`. `perform` gets only the frozen input and the checked relative paths.
- **Once-grants:** the digest is required; `consumeOnce` is synchronous, so two identical parallel calls cannot both spend one grant (traced through `promote` -> `approveTool` and the microtask ordering: the second call is refused with `revoked`). Task and once rules end with the task and are reconciled at boot.
- **`decideApproval`:** the approval id and digest must both match. Broader scopes are refused for execute and network tools and for approvals without a waiter. The permission is recorded before the runtime is answered.
- **Cancel, timeouts, removing an agent:** `settleAll` releases the pending and queued requests. The approval timer fails the task. The `isLive` checks refuse tools before `started` (so calls before init are refused) and after the task has ended.
- **Path checks:** `..` is refused before `resolve`. NUL, backslash and length are checked. Symlinks are resolved for the containment check. Dangling symlinks and ELOOP are refused. `nlink > 1` is refused in the policy and in `fileOps`. The `fileOps` walk uses `lstat` and refuses any symlink component. The final open uses `O_NOFOLLOW|O_NONBLOCK`, checks dev and inode identity, and checks the parent's real path exactly. Writes use a temp file with `O_EXCL|O_NOFOLLOW`, re-verify the parent and the temp file, and never create parent directories. Mode is masked to 0777.
- **Glob and Grep:** no braces, extglobs or `..`. Symlinks are never followed. Sensitive and protected entries are pruned per entry. Caps on entries, matches, bytes and time. Names with control characters or line separators are dropped. Fixed-string search, so no ReDoS. `redactSecrets` timing on 64 KiB adversarial inputs was 0.3 to 2.3 ms.
- **Review integrity:** Bidi, zero-width, private-use, line and paragraph separators, C1 and lone surrogates are refused in the summary and the content. The CR character is marked visibly in the UI. Oversized or redaction-changing content is refused instead of being shown altered.
- **SDK lockdown:** `tools: []`, the allowedTools list, `dontAsk`, the deny `canUseTool`, the PreToolUse hook, `strictMcpConfig`, `settingSources: []`, and the init assertion (exact tools, exact server, connected, mode). A violation stops the session. A missing `protectedRoots` throws, so the provider fails closed.
- **Child environment:** only the key, HOME (the scratch folder), CLAUDE_CONFIG_DIR, PATH and the timeouts. No `API_TOKEN` or inherited secrets. SDK stderr is dropped. SDK errors become fixed sentences.
- **Output:** model text and the summary are cut, then redacted, then path-hidden, then capped per message and per task. The audit log carries ids and codes, plus scrubbed details.
- **Config:** a loopback host only. Env variables that name a permission bypass are refused. The key is held in `Secret` and self-checked against the serialized config. DATA_DIR inside a workspace is refused.

## Residual risk with writes enabled on a real workspace
Used with "allow once" only, a careful approver, and a workspace that is a plain project folder (not $HOME, not the server repo), the remaining risk is acceptable. A model can only cause what a person read in full, and the main residual is a person approving a malicious config change such as an npm script or a hook without noticing. With "allow task" or "allow agent", the risk is high: it is effectively "the model may plant code that you will run later", across workspaces (H1). Secrets in the workspace should be treated as readable by the model (M1, L1), so they also go to Anthropic's API and may reach task output.

**Would a dedicated unprivileged OS user change the outcome materially?** Only partly, and only if the whole server runs as that user. The file operations run in the server process (in-process MCP), not in the Claude child, so giving only the child its own user changes nothing. Running the server as a user that can reach only `WORKSPACE_ROOT` and its own `DATA_DIR` would turn M2, M3 and any future path-check bug from a home or credential disclosure into a workspace-only issue, and would protect `~/.claude`, the SSH keys and the server source. It does **not** reduce H1: the planted files are run later by the human (npm, git hooks, Claude Code, CI) under the human's own account or CI secrets. H1 needs the scope and path changes above, not process isolation.

---

## Status after the fixes

Fixed:
- **H1.** Workspace binding, a once-only class of files that tools run on their own (hidden names, `node_modules`, lock files, CI and container files and more), and the queue re-ask: `fix(server): changes to files that tools run are approved once; queued requests are asked again`, `fix(server): task and agent permissions from an approval belong to their workspace`. A final review found the class can never be complete, so a server default was added: for the Claude runtime a Write or Edit is approved one at a time unless the owner sets `ALLOW_BROAD_WRITE_SCOPES=yes`: `fix(server): hidden and tool-run files are once-only; broad write approvals are off unless ALLOW_BROAD_WRITE_SCOPES=yes`.
- **M1.** Whole-file redaction before slicing and searching, grep matches redacted text, PGP and PuTTY key blocks: `fix(server): redact whole files before slicing or searching, and more secret formats`, plus the follow-up that adds PGP, PuTTY and the pinning tests.
- **M2.** One Unicode fold (`foldName`) for the denylist, deny rules, protected roots and the once-only class: `fix(server): fold Unicode names, widen the denylist and check the workspace layout`.
- **M3.** Host checks (home, project, overlap, workspace root) on real paths, compared folded, and a wider denylist (now also `*.tfvars.json` and `*.auto.tfvars*`): the same commit and the follow-up.
- **L1.** New secret formats, anchored patterns, and grep matching redacted text only, so the content oracle is gone for every redacted format: `fix(server): redact whole files before slicing or searching, and more secret formats`.

Recorded and not fixed:
- **L2** (event loop blocked by parallel searches): needs worker threads or async file access, which the project rules forbid for now; the per-call caps bound the stall.
- **L3** (review does not show an overwrite): a display gap, not a bypass; the person sees the whole new content.
- **L4** (audit rotation can flush history): needs a retention design; the size is configurable.
- **I1 to I6:** informational; each is described above and none opens a path to a secret or an unreviewed write.

Notes for the owner:
- A permission rule binds a workspace id, not a folder. Revoke a workspace's rules before reusing its id for another folder.
- Agent rules granted before the upgrade stay unbound, so they apply in every workspace. The server logs a warning at each start with the count; review and revoke them in the permissions panel. With broad write scopes off (the default) they cannot allow a write without a fresh approval.
- **Project folder from the working directory** (final review L-3): the host checks take the application's own folder from `process.cwd()`, not from the package root, so a server started from another directory would not see that a workspace contains the project. Run the server from the project folder, as the scripts do.
