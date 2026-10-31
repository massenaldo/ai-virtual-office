# AI Virtual Office — Milestone 3B.1.2: Final Security Hardening

Milestone 3B.1.1 has been merged into main at commit 1938776.

The implementation report confirms:
- 822 tests passing.
- Tool gate implemented.
- API authentication implemented.
- Real-server E2E tests passing.
- Docker sandbox architecture documented but not implemented.
- No Claude Agent SDK installed.
- No real Claude execution enabled.

## Objective

Close the remaining high-priority security and reliability gaps before beginning real Claude Agent SDK execution.

Audit the actual merged code first. Preserve all existing functionality.

### Phase 1 — Critical information disclosure

1. Fix GET /api/health so raw filesystem paths and internal error details can never appear in responses.
2. Return safe, structured error information only.
3. Add regression tests for save failures and filesystem errors.
4. Check other unauthenticated endpoints for accidental information disclosure.

### Phase 2 — Tool gate reliability

1. Add task-manager integration tests for stale approvals.
2. Test changes to task state, workspace, tool name, and input between approval and execution.
3. Verify that modified or stale actions never reach perform.
4. Verify approval is bound to the exact action and task.
5. Document the custom gated in-process Write/Edit tool design required for the Claude Agent SDK.
6. Do not use SDK built-in Write/Edit tools for future real execution.

### Phase 3 — Authentication and proxy reliability

1. Fix /api prefix edge cases.
2. Add automated tests against a real Vite server and SSE proxy.
3. Review token handling when multiple servers share DATA_DIR.
4. Decide and document the long-term browser authentication approach.
5. Ensure tokens never appear in URLs, logs, frontend bundles, or error messages.

Do not silently treat Sec-Fetch-Site as authentication against untrusted local programs.

### Phase 4 — Secret redaction

Extend coverage for:
- JWTs.
- Slack xox tokens.
- Google AIza keys.
- PEM private keys.
- -p password arguments.
- URL passwords containing @ or /.

Add positive and negative regression tests.

### Phase 5 — Large write approval

Implement a review screen for large Write/Edit operations.

Requirements:
- Show the complete proposed content or diff.
- Clearly identify workspace and target file.
- Bind approval to the exact action digest.
- Never truncate content in a way that hides what is being approved.
- Refuse actions that cannot be safely displayed or reviewed.

### Phase 6 — Deferred reliability issues

Review:
- Digest visibility at approval time.
- Hard