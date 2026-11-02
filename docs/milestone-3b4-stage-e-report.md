# Milestone 3B.4 stage E: gated file tools — report

Date: 2026-11-02. Plan: `docs/superpowers/plans/2026-11-02-milestone-3b4-stage-e-gated-tools.md`. Audit: `docs/milestone-3b4-final-report.md`. Earlier reports: `docs/milestone-3b4-stage-c-report.md`. Design and as-built notes: `docs/gated-tools.md`.

Backend only. The frontend is unchanged. Still true: no SDK, no real Claude execution, mock runtime only, and the mock demo still writes nothing. The new handlers are exercised by tests (a fake provider through the real task manager), not by any running agent.

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `rtk proxy npm test` | 81 files, 1321 tests pass |
| `npx tsc -b` | clean (no errors) |
| `npm run build` | built (the existing chunk-size warning only) |
| `npm run server:build` | built (`dist-server/index.js`) |
| `npm run check:secrets` | no secrets found (12 files checked) |
| `npm audit` | 0 vulnerabilities |

Intermittent timing failures were observed under parallel load in `server/redact.test.ts` (hard 250 ms budget, noted in the stage C report) and once in `server/secrets.test.ts`; both pass alone and in a clean full run. Neither was changed. The existing `server/runtime/claudeAgent.test.ts` assertion that the gated-tools doc starts with "Design only" was updated to the new status line.

## What changed

- **Sensitive-path denylist** (`940ea64`, `87977f6`): `server/sensitivePaths.ts` and the policy in `server/toolPolicy.ts`. Segments named `.git`, `.ssh`, `.aws`, `.npmrc`, `.netrc`, `credentials.json`, starting with `.env`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, or ending in `.pem`, `.key`, `.p12`, `.pfx`, plus protected absolute roots, are refused (`sensitive_path`) on both the lexical and the resolved path. `checkPathInWorkspace` in `server/workspaces.ts` now returns `real`. The policy checks `checked.relative` and `checked.real` with case folding; NFC normalisation applies to protected roots only.
- **Safe open and read** (`a8814a1`, `d2ee129`): `server/fileOps.ts` `openInside` and `readTextFile`: per-component `lstat`, `O_NOFOLLOW`, dev/ino identity, strict `realpath` equality; read- and directory-only; hardened against FIFOs, mutating flags and parent swaps.
- **Atomic write and edit** (`942130e`, `3d89a9f`): `writeTextFile` and `editTextFile`: temp file in the verified parent, `fsync`, `rename`; 32 KiB cap; existing mode kept (never setuid/setgid/sticky), new files 0600; hard-link and special-mode hardening; the temp file is removed unless renamed.
- **Glob and Grep** (`50ed0d8`, `2ec16ff`): bounded traversal (500 glob results, 200 grep matches, 1 MiB per file, 32 MiB total, 10,000 entries), symlinks skipped, sensitive entries skipped and sensitive directories pruned, directories verified before listing. Grep is fixed-string only.
- **Gated tool handlers** (`00e4a55`, `9530163`): `server/tools/gatedTools.ts`: `vo_read`, `vo_glob`, `vo_grep`, `vo_write`, `vo_edit`, and `vo_run`, which always refuses. Fixed result sentences, no host path or OS message returned; redaction happens before any cut; input is validated before the gate.
- **Integration tests** (`f5f65c0`, `483866f`): the handlers through the real manager, including stale approval, symlink outcomes and revoke-abort via a test seam.
- **Final review fixes**: deny rules with a path pattern now also match a search that starts at a parent folder (engine); Glob and Grep have a 2 s wall-clock deadline and Grep redacts a bounded window; `createGatedTools` throws on empty `protectedRoots`; `vo_grep` refuses options it does not implement; entry names with control characters are skipped; seven more denylist names.
- **Docs and comment** (this commit): `docs/gated-tools.md`, `README.md`, and the KNOWN GAP comment in `server/runtime/claudeAgent.ts` (comment only; `SDK_INSTALLED` stays false).

## Security implications

- A tool call now has one place where the approved action meets the file access: the handler's `perform` receives the gate's checked workspace and relative path and reopens the file safely, rather than trusting a path string after the check.
- The denylist is enforced in the policy (lexical and resolved path) and again in Glob and Grep traversal, so a sensitive file is neither readable by name nor listed or matched through a broad pattern.
- Output is redacted before it is cut and capped; errors are fixed codes. No path, workspace root, data folder or OS message is returned, and model-sent content is not echoed.
- Every `fileOps` call takes the task's abort signal. File operations are synchronous and run to completion: cancel, revoke and timeout are honoured before a call starts and refuse every later call. A call already running is bounded only by the caps and the wall-clock deadline (`SEARCH_MAX_MS`, 2,000 ms, for Glob and Grep), and the `checkAborted` calls inside the loops are reachable only from test seams.
- Without a sandbox these are policy-grade checks against a same-user race, not a security boundary (see the limits).

## Residual limits

- Node has no `openat`: a swap-and-swap-back of a directory between open and the post-open checks is undetected (reads only; marked `// RESIDUAL:` in `fileOps.ts`).
- Writes: there are windows between the last parent/temp check and the create or rename; a hard link made to the temp file after the last check is not detected; a same-user process can rename the parent so the hidden temp file moves with it; edit is read-modify-write with no compare-and-swap, so a change between the read and the rename is overwritten.
- Glob and Grep: `readdir` is by path (Node has no fd-based readdir); the listing is re-checked by `lstat` dev/ino afterwards, and a swap-and-restore between `readdir` and `lstat` is undetected (names only; contents are reopened safely). A single directory is read whole before the entry cap applies. Truncated glob results are the first N in traversal order, not the N lowest paths.
- Redaction: the patterns use `\b`, so a key glued directly to word characters is not matched (existing `redact.ts` behaviour). A secret straddling the 73,728-byte Read window edge could be cut mid-token. Grep now redacts only the first 200 characters of a matched line plus a 4,096-character lookahead, so the redaction cost no longer grows with line length.
- Redaction is NOT a confidentiality boundary against the agent. A fixed-string Grep (`files_with_matches`) and the `vo_edit` outcomes (`no_match` versus `not_unique` versus success) are yes/no oracles on file content; only the sensitive-path denylist keeps secrets from the agent.
- Event-loop stall (residual for the SDK stage): because file operations are synchronous, one call blocks the event loop for its whole duration. The final review measured about 2.85 s for one Grep over 32 files of 1 MiB single-line redactable text before the window fix; after it, the same case measures about 13 ms. The worst case is now bounded by the caps and `SEARCH_MAX_MS` (2 s) for Glob and Grep, and by the 64 KiB read and 32 KiB write caps elsewhere; a slow disk can still exceed the deadline inside a single read. Running the file operations off the main thread is for the SDK stage.
- New files are mode 0600 regardless of the umask. A rewrite goes through `rename`, which drops extended attributes and ACLs and gives the file the server user's ownership.
- A once-approved `vo_run` is prompted for and consumed but never runs (`not_supported`); `permission.used` is audited even though nothing ran.
- `vo_grep` accepts the Claude Code option names in the policy but implements only `pattern`, `path`, `glob`, `output_mode` and `-i`; `type`, `-n`, `-A`, `-B`, `-C`, `head_limit` and `multiline` are refused with `invalid_input` before the gate. Glob and Grep take a directory path only.
- The glob-pattern check in the policy is a heuristic; the traversal filter is the real enforcement.
- The denylist is a fixed list (it now also covers `.gnupg`, `.kube`, `.docker`, `.pypirc`, `.git-credentials`, `.pgpass` and `.htpasswd`); other credential files are not covered.
- Grep is fixed-string. Read `offset` and `limit` apply within the 73,728-byte lookahead window, before the final 64 KiB cut.
- No SDK and no real Claude; the mock demo still writes nothing. Same-user processes are out of scope without a sandbox (native host execution, no Docker).

## Audit blockers (`docs/milestone-3b4-final-report.md`)

- **B1, B2:** closed on the backend for the file tools.
- **B6:** narrowed, not eliminated: descriptor and identity checks shrink the race windows, but no `openat` means they remain (see limits).
- **B7:** closed for the file tools in the sense of "refused before start", not interruption mid-call: every `fileOps` call takes the abort signal and a cancelled, revoked or timed-out task refuses every later call; a call already running is not interrupted (revoke-abort is tested through the real manager with a test seam).

## What is left

- **D:** browser session cookie, so the app no longer needs the dev proxy for the permission routes.
- **F (UI):** pending-approval and queue visibility, path pattern choice, and opting in to `permission.changed`.
- **G:** end-to-end test and the closing 3B.4 report.
- Later, outside 3B.4: the SDK provider (register only the `vo_*` tools, disallow every built-in, verify option names against the installed SDK) and the sandbox.
