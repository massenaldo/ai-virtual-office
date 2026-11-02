**Status: implemented on the backend as plain handlers (stage E of 3B.4; `server/tools/gatedTools.ts`, `server/fileOps.ts`, `server/sensitivePaths.ts`). Still no SDK, no real Claude execution and no sandbox; the mock runtime writes nothing.** The design below is the original; "Deviations from the design" at the end records what was built differently.

# Gated in-process Write and Edit tools for the Claude Agent SDK

## Why the SDK's own Write and Edit are never used

The SDK runs its built-in `Write` and `Edit` after `canUseTool` returns. The tool gate (`server/toolGate.ts`) checks the action just before `perform`, but with a built-in tool the file access happens later, in code we do not control, from path strings. A symlink, a rename or a hard link can change in between. So for real execution the built-in `Write` and `Edit` are in `disallowedTools`, and the model gets two tools of ours whose handler **is** `perform`. The change then happens inside the gate, not after it.

## The two tools

Registered as in-process SDK MCP tools (no separate server process, nothing to spawn), named `vo_write` and `vo_edit`. Their inputs use Claude Code's field names, so `server/toolPolicy.ts` does not change and the approval summary and review payload (stage 5) are produced by the same code:

| Tool | Input | Policy name |
|---|---|---|
| `vo_write` | `{ file_path: string, content: string }` | `Write` |
| `vo_edit` | `{ file_path: string, old_string: string, new_string: string, replace_all?: boolean }` | `Edit` |

The handler calls `ctx.tools.use({ tool: 'Write' | 'Edit', input }, perform)` and returns the result to the model. `canUseTool` is not needed for these tools, because the gate is called from the handler itself; it stays as a deny-all for anything else.

## What `perform` does

`perform(action)` receives the deep-frozen input, the checked workspace and, once added, an abort signal (`GatedAction.signal`). It never uses the host path strings after the gate's check without re-opening them safely:

1. Resolve the target as `workspace.path` + the checked relative path. Open the **parent directory** by descriptor with `O_DIRECTORY | O_NOFOLLOW`, and walk down one component at a time (`openat`-style), refusing any symlink on the way. If the platform has no `openat`, resolve with `realpath` and require the result to stay inside the workspace, then open with `O_NOFOLLOW`.
2. For `vo_edit`, open the existing file with `O_RDONLY | O_NOFOLLOW`, then `fstat` the descriptor and require a regular file with `nlink === 1` (a hard link to a file outside the workspace is refused) and a size under the cap. Read from the descriptor.
3. For both, compute the new content in memory and enforce the size cap (the same as the review limit: 32 KiB per write in the first version).
4. Write to a temporary file in the **same directory** (created with `O_EXCL | O_NOFOLLOW`, mode 0600 or the existing file's mode), `fsync` it, then `rename` it over the target. The rename is atomic, so a reader never sees half a file and a swapped target cannot be written through.
5. Check the abort signal before every step above and again before the rename. A cancelled task never renames.
6. For `vo_edit`, require that `old_string` occurs exactly once (or that `replace_all` is true) in the content that was read; otherwise return an error and write nothing.

The remaining window is between step 2's `fstat` and step 4's `rename` (another process could replace the target). The rename replaces whatever is there, so the write can never go through a link; the worst case is that an unrelated change made in that window is overwritten, which is the same as any editor. Inside the sandbox (below) nothing else is running.

## What the agent gets back

A short text result: "Wrote N bytes to <relative path>." or "Edited <relative path>.", or an error from a fixed list (not approved, denied by policy, stale approval, file too large, not unique, not a regular file, path not allowed). Errors never contain a host path, the workspace root, the data folder or an operating-system message. Content the model sent is never echoed back.

## Changes to the SDK options

- `disallowedTools`: add `Write` and `Edit` to the existing list (everything outside the catalogue, plus `Bash`, `WebFetch`, `WebSearch` until the sandbox exists). `Read`, `Glob` and `Grep` also move to gated in-process tools in the same way before the sandbox is relied on, for the same two-step reason.
- `allowedTools`: only our `vo_*` tools, never the built-in names.
- Unchanged: `permissionMode: 'default'`, `settingSources: []`, no hooks that approve, no additional directories, no other MCP servers.

## How it combines with the sandbox

With the container from `docs/sandbox-architecture.md`, `perform` runs these steps inside the container (the workspace is mounted at `/workspace`, so a symlink out of it resolves to a harmless place there). The gate, the digest and the review stay on the host; only the file operations move. Without the sandbox, the steps above run on the host and are policy-grade only.

## 3B.2 checklist

- [ ] Add `signal` to `GatedAction` and cancel on it.
- [ ] A small file-operation module (`openat`-style walk, `nlink` check, same-directory temp file, `fsync`, `rename`) with tests for: symlink in the path, symlink swapped after the check, hard link to an outside file, file replaced by a directory, target too large, abort before rename, two writers.
- [ ] `vo_write` and `vo_edit` handlers that call `ctx.tools.use`, with the fixed result texts.
- [ ] Move `Read`, `Glob` and `Grep` behind the same pattern.
- [ ] Add the tool names to `disallowedTools` and `allowedTools` as above; check every option name against the installed SDK version.
- [ ] A test that the provider never passes a built-in `Write` or `Edit` to the SDK.
- [ ] Run the same steps inside the sandbox once it exists.

## As built (stage E)

`Read`, `Glob` and `Grep` moved behind the same pattern as `Write` and `Edit`: the handlers are `vo_read`, `vo_glob`, `vo_grep`, `vo_write` and `vo_edit`, all in `server/tools/gatedTools.ts`, each going only through `ctx.tools.use`. `vo_run` exists and always refuses.

### Deviations from the design

- **Grep is fixed-string only.** There is no regex: a model-supplied regex cannot be made safe against catastrophic backtracking in Node without running it in a worker.
- **No `openat`.** Node has none, so `server/fileOps.ts` checks each path component with `lstat` (no symlink, every parent a directory), opens the last component with `O_NOFOLLOW`, compares the descriptor with a fresh `lstat` by `dev` and `ino`, and requires the parent's `realpath` to equal the expected path exactly (strict equality, not just "inside the workspace").
- **`openInside` is read- and directory-only.** It refuses mutating flags. A write creates its temp file by path inside the verified parent (`O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600), then re-verifies the parent and the temp file (identity and `nlink === 1`) before `rename`.
- **Write caps.** Content and edit results over 32 KiB (`REVIEW_MAX_BYTES`) are refused before anything is created. Reads return at most 64 KiB. Glob returns at most 500 results, Grep at most 200 matches, 1 MiB per file and 32 MiB in total, and a traversal visits at most 10,000 entries.
- **Sensitive-path denylist** (`server/sensitivePaths.ts`), matched per path segment, case-insensitively: the names `.git`, `.ssh`, `.aws`, `.npmrc`, `.netrc`, `credentials.json`; any segment starting with `.env`, `id_rsa`, `id_dsa`, `id_ecdsa` or `id_ed25519`; any segment ending in `.pem`, `.key`, `.p12` or `.pfx`; plus protected absolute roots (for example the server data directory). The policy (`server/toolPolicy.ts`) applies it to both the lexical relative path and the resolved path, and `fileOps` applies it again while Glob and Grep traverse (sensitive entries are skipped and sensitive directories pruned). The glob-pattern check in the policy is only a heuristic; the traversal filter is the enforcement.
- **Redact before cutting.** Read and Grep redact secrets first and cut afterwards. Read reads a lookahead window of 8,192 bytes past the 64 KiB limit (73,728 bytes in all) so a secret that straddles the cut is matched whole; `offset` and `limit` apply within that window.
