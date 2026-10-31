**Design only. Not implemented.** No SDK is installed and no real tool runs. This is what 3B.2 must build before any real write.

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
