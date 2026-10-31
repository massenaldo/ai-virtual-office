# AI Virtual Office — Milestone 3B.1.1: Security Hardening & E2E Verification

We have completed the read-only audit of Milestone 3B.1.

Audit verdict: READY WITH ISSUES.

The backend foundation is sound, but several security and test gaps must be addressed before integrating a real Claude Agent runtime.

## Primary objective

Harden the existing backend without breaking:
- The 3D office
- Layout editor
- Agent registry and desk assignments
- Workforce UI
- MockRuntimeProvider
- REST API and SSE
- Existing task lifecycle
- `/vo` startup workflow

## Phase 1 — Close existing security gaps

### 1. Workspace enforcement
- Require a valid workspace for every Write and Edit operation.
- Compare paths against the stored canonical workspace root.
- Resolve and validate paths immediately before file access, not only when an approval decision is made.
- Reject path traversal, symlink escapes, invalid workspace IDs, and paths outside the workspace.
- Do not expose workspace root paths through API responses or frontend state.
- Add regression tests for symlink changes and path changes between approval and execution.

### 2. Secret redaction
Extend the existing redaction layer to cover:
- URL-embedded credentials.
- GitHub tokens, including `ghp_` formats.
- AWS access key identifiers, including `AKIA` formats.
- HTTP Basic authentication credentials.
- `--password` and similar command-line password arguments.
- Existing API keys and common bearer tokens.

Requirements:
- Redact before data reaches API responses, activity feeds, task results, and audit logs.
- Preserve useful diagnostic information without exposing secret values.
- Add positive and negative tests to avoid excessive redaction.

### 3. Tool gate by construction

This is the most important architectural requirement before real runtime integration.

Do not allow a future Claude provider to execute tools independently of the security policy.

Design a gated tool execution interface:
- The runtime receives only the approved/gated tool interface.
- All tool calls must pass through workspace validation and tool policy.
- Write, Edit, Execute, and Network actions require approval according to policy.
- The complete proposed action must be visible before approval.
- Approval must be bound to the exact action, workspace, and task.
- Reject modified or stale actions after approval.
- No bypass mode or unrestricted tool execution.
- Keep MockRuntimeProvider working through the same gate.

Inspect the current architecture before choosing the implementation. Do not create a parallel security system that duplicates existing policy logic.

Document how the future Claude Agent SDK will be connected to this gate, including the SDK permission hooks or tool integration mechanisms required.

### 4. Local API authentication

Implement a startup-generated or configured local API token.

Requirements:
- Token must remain backend-only.
- Never expose it through frontend bundles, logs, state snapshots, or error responses.
- Protect mutating API endpoints and SSE access.
- Support secure frontend-to-backend authentication.
- Avoid putting credentials in URLs.
- Preserve the local development workflow and `/vo` command.
- Document token generation, storage, and rotation.

Do not silently weaken authentication for requests without an Origin header.

## Phase 2 — Sandbox architecture decision

Prepare the real runtime for a Docker-based workspace sandbox.

Do not integrate Claude Agent SDK yet.

Design and document the intended sandbox:
- Non-root container.
- Only the selected workspace is mounted.
- No host filesystem access beyond explicitly mounted workspace data.
- Read-only root filesystem where practical.
- No Docker socket.
- Network disabled by default.
- CPU, memory, process count, output size, and execution time limits.
- Safe container termination and cleanup.
- Explicit environment-variable allowlist.
- No persistent storage of credentials inside the image or container filesystem.

The future Claude runtime must execute inside the isolated environment, not directly with unrestricted host permissions.

For this milestone, document the design and identify any technical blockers. Do not claim that sandbox isolation is active until it is implemented and tested.

## Phase 3 — Real server end-to-end test

Add at least one genuine end-to-end test that:
1. Starts the actual backend server.
2. Connects through the real HTTP API.
3. Authenticates successfully.
4. Submits a mock task.
5. Connects to the real SSE endpoint.
6. Receives task and agent status events.
7. Cancels a task.
8. Verifies the final state.

Also test:
- Unauthorized requests are rejected.
- Invalid workspace paths are rejected.
- SSE reconnection works.
- Existing mock runtime behavior remains intact.

Do not replace all existing tests with mocks. The purpose is to validate the actual server and browser-facing protocol.

## Phase 4 — Compatibility

Run:
- Existing test suite.
- New security tests.
- New E2E test.
- TypeScript checks.
- Frontend build.
- Server build.
- Secret checks.
- npm audit.

Verify that the existing `/vo` workflow still works.

If browser automation is available, test the actual application in a browser. Otherwise clearly report the limitation.

## Strict scope restrictions

- Do NOT install `@anthropic-ai/claude-agent-sdk`.
- Do NOT implement real Claude execution.
- Do NOT enable unrestricted Bash, Write, Edit, or Network access.
- Do NOT deploy to a VPS.
- Do NOT rewrite the 3D scene or layout editor.
- Do NOT remove MockRuntimeProvider.
- Do NOT claim Docker sandbox isolation is implemented if only its architecture has been documented.

## Required final report

Provide:
1. Overall verdict: READY / READY WITH ISSUES / NOT READY.
2. Exact files changed.
3. Workspace validation improvements.
4. Redaction patterns and test coverage.
5. Tool gate architecture and how it will constrain the Claude SDK.
6. Authentication design and frontend integration.
7. Sandbox architecture and remaining implementation work.
8. E2E test results.
9. Build, TypeScript, test, and security check results.
10. Remaining blockers before Milestone 3B.2.

Do not start Milestone 3B.2 automatically.