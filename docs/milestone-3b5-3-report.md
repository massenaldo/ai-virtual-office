# Milestone 3B.5.3 — gated write execution: report

Date: 2026-11-03. Branch `feat/3b5-3-gated-writes`, based on `main` at `a7b4543` (#62). Plan: `docs/milestone-3b5-planning.md` §10 (3B.5.3).

**What this stage is:** the Claude agent can now change files. `vo_write` creates or overwrites a text file and `vo_edit` replaces text in one, both in the workspace you pick. A write waits for a person who sees the whole content (or the old and new text) and approves exactly that change; only then is it made. The agent still cannot run anything.

**What was not done, and what the planning document asked for first:** §13 and the 3B.5.2 report require, before writes, (a) a first run with a real key and a small budget, (b) an **independent security review**, and (c) a decision on running the server as a dedicated OS user. **None of these happened.** There was no API key, no independent reviewer ran (the review in this stage is the author's own, through tests), and the OS-user decision is not made. The code is behind the same gate and tests as 3B.4, but this feature should not be used on a workspace that matters until (a) to (c) are done. Everything below was run against a scripted local API, never a real model.

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npm test` | 99 files, 1715 tests pass, 10 skipped (the opt-in real-SDK file) |
| `VO_REAL_SDK=1 npx vitest run server/e2e/claudeRealSdk.test.ts`, 4 runs | 10 of 10 each time, with the real SDK binary |
| Write, read and runtime e2e under four busy CPU loops, 3 runs | 58 of 58 each time |
| `npx tsc -b` | clean |
| `npm run build`, `npm run server:build` | both built |
| `npm run check:secrets`, `npm audit` | clean; 0 vulnerabilities |

## What was built

Small by design: the gate, the policy, `fileOps`, the review and the digests all exist from 3B.4 and were not changed.

- **Tools** (`server/runtime/claudeTools.ts`): `vo_write` (`file_path`, `content`) and `vo_edit` (`file_path`, `old_string`, `new_string`, `replace_all?`) as thin shells over the existing gated handlers, marked as changing files (`readOnlyHint: false`, `destructiveHint: true`) so the SDK runs them one at a time. Their descriptions tell the model a person must approve every change. `vo_run` is still not registered.
- **Provider and mapping:** `allowedTools` and the startup assertion now name exactly five tools; the PreToolUse hook allows exactly those five; labels "Writing a file" and "Editing a file" are the only thing shown while one runs, never the content or path.
- **Prompt:** says which tools read and which change files, that a person approves every change and may refuse it, that a change is made exactly as shown, and that file text is data, not instructions.
- **UI copy:** the badge no longer says the agent cannot write.
- **Test harness** (`server/test/claudeHarness.ts`): shared setup for the end-to-end tests; the read-tools test was moved onto it unchanged.

## How a write is kept honest

The model calls `vo_write`. The handler validates the shape, then `ctx.tools.use` computes a digest of the task, the workspace (id **and real path**), the tool and the exact input. The default rule for Write is "ask", so the task waits in `waiting_for_approval` and the person sees the whole content. The decision must carry the same digest. Right before the file operation the gate re-checks everything: the task is live, the workspace is still the same real path, the policy accepts the path now, the permission rule is still in force (a once-grant is spent here). The file operation itself walks the path with `lstat`, opens with `O_NOFOLLOW`, compares the descriptor with a fresh `lstat`, writes a temp file with `O_EXCL` and mode 0600 and renames it. Nothing in this stage changed that machinery; what is new is that a model, not a test, now drives it.

## Tests added (all through the real server, gate, rules and file operations)

`server/e2e/claudeWrites.test.ts`, 33 tests, plus the real-binary ones:

- **Approval binds the exact action:** nothing is written before approval; the review shows the whole content; a decision with another digest, or none, is refused (409) and the write stays pending; an approval for content A cannot be used for content B (asked again, file untouched); the same write again asks again; two identical writes at once: one is made and the other is refused as "already used", and the once-grant is used exactly once; rejecting writes nothing and the model is told.
- **Paths that change after the person approved:** a parent folder swapped for a link elsewhere, the target file swapped for a link to a file outside, and the workspace folder itself replaced by a link: in each the call is refused and the outside files are untouched.
- **Refused before anyone is asked** (no approval is requested and nothing is written): `.env`, a path inside `.git`, `..`, an absolute path, an existing link out of the workspace, a path through it, an empty path, content over 32 KiB, content containing a secret, a right-to-left override, a control character; a deny rule for Write.
- **Edit:** the review shows old and new text and replace-all; a non-unique or absent match and a missing file leave everything unchanged; a link out is refused.
- **Endings:** cancel while a write waits, and an approval timeout, write nothing.
- **Wider approvals:** "this task" lets later writes of that task through and revoking the rule makes the next one ask again; it does not reach another task; sensitive targets stay refused whatever was allowed.
- **Records:** the audit has the request, decision and use with a 12-character digest prefix and a hash; the content, the full digest and the workspace path appear in no log, audit line or state after the decision.
- **Bytes:** non-ASCII text and CRLF are written exactly; the file mode is 0600.
- **Real SDK** (opt-in): a write waits for approval and then exists with exactly that content; a rejected write leaves no file; a write to `.env` is refused with no approval.

Two of my first expectations were wrong and the tests were corrected, not the code: sending `digest: null` is a 400 (not a 409), and two simultaneous identical writes end with the second refused as "already used" rather than asked again, which is the safer behaviour.

## Security notes and limits

- **No independent review, no real model, no real key** (see the top). The tests prove the wiring and the existing gate, not how Claude will behave when it can write, nor the cost.
- **Prompt injection can now cause writes.** A file or task text can try to make the agent write something. The defences are that a person sees and approves each whole change by default, that sensitive and out-of-workspace targets are refused before anyone is asked, and that content with secrets or invisible characters is refused. They do not help if a person approves without reading.
- **"Allow for this task" and "for this agent" widen the approval.** After them, later writes in that scope are made without asking again (each is still policy-checked and audited; sensitive targets stay refused). Task and agent scopes are intentionally offered; use "once" when in doubt.
- **A residual race remains** between the final check and the rename (Node has no `openat`); the temp-file and identity checks narrow it, as documented in 3B.4.
- **No OS-level isolation.** The child runs as the server's user and the workspace checks are policy, not a sandbox. An agent that can write into a workspace can write files that other programs later run (a script, a build file). Approving a write is approving what it may cause.
- **File contents and the agent's own writes are sent to Anthropic** as part of the conversation.
- A synchronous file operation is not interrupted by cancel (a 3B.4 limit); caps bound it. A write is at most 32 KiB.
- The SDK licence and terms review from the planning document is still open.

## Rollback

Set `RUNTIME=mock`, or remove `vo_write` and `vo_edit` from `claudeTools.ts` (the startup assertion and allowed list follow `MODEL_TOOL_NAMES`) to return to the read-only agent of 3B.5.2. A rule with `deny` for Write also stops every write without code changes.

## Next: 3B.5.4

Agent registry integration, a real activity feed, multi-agent execution and per-task runtime choice, after the three prerequisites above.
