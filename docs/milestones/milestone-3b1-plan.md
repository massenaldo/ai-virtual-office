# Milestone 3B.1 — Real Agent Runtime Foundation

Project: AI Virtual Office  
Repository: https://github.com/massenaldo/ai-virtual-office

Milestones 1, 2, and 3A have been completed:
- Editable 3D office layout.
- Realistic office environment.
- Agent Workforce UI.
- Mock runtime and simulated task lifecycle.

Now prepare the application for real Claude Agent execution.

## Objective

Build the backend foundation for a secure, locally hosted AI agent workforce that can later run on a VPS without changing the frontend architecture.

The selected future runtime is Claude Agent SDK for TypeScript.

This phase establishes the backend, runtime abstraction, task lifecycle, event delivery, and security boundaries.

Do not claim real Claude execution is working until the actual SDK integration has been implemented and tested.

## 1. Audit the existing implementation

Before making changes:
- Inspect the actual repository and current branch.
- Review the completed 3A implementation.
- Inspect agent, task, activity, runtime-provider, and persistence models.
- Identify existing frontend state management and mock runtime interfaces.
- Inspect package.json and existing scripts.
- Run the production build and relevant tests.
- Record existing issues.

Create a concise implementation plan based on actual code.

Do not rewrite the existing frontend or 3D scene.

## 2. Backend architecture

Evaluate the smallest appropriate backend architecture compatible with the existing project.

Preferred direction:
- Separate Node.js + TypeScript backend service.
- REST API for commands and queries.
- Server-Sent Events (SSE) for real-time task and agent updates.
- Runtime provider abstraction.
- Local development configuration.
- Environment-based configuration for future VPS deployment.

Do not introduce unnecessary infrastructure.

Do not add a database, Redis, Docker, or distributed queue unless the existing architecture genuinely requires it. Start with a durable, appropriately scoped local persistence strategy and document its limitations.

## 3. Runtime provider abstraction

Define a clean provider contract that supports:
- Start task.
- Receive execution events.
- Request cancellation.
- Retrieve execution status.
- Retrieve final result.
- Handle runtime failures.
- Associate runtime sessions with workforce tasks.

Keep the existing MockRuntimeProvider functional.

Prepare ClaudeAgentRuntimeProvider as an implementation boundary.

Avoid coupling React components directly to Claude SDK or process execution.

## 4. Task lifecycle

Define consistent lifecycle states.

Include:
- queued
- starting
- running
- waiting_for_approval
- completed
- failed
- cancelling
- cancelled

Map these lifecycle states to the existing agent statuses without breaking the current UI.

Prevent duplicate execution and inconsistent task assignment.

Implement:
- Task IDs.
- Execution IDs.
- Creation timestamps.
- Start and completion timestamps.
- Runtime metadata.
- Error reporting.
- Cancellation handling.
- Task timeout configuration.

## 5. Security foundation

Treat agent execution as a privileged operation.

Implement or establish:
- Workspace allowlisting.
- Path validation and protection against path traversal.
- Explicit tool allowlists.
- No unrestricted host filesystem access.
- No unrestricted shell access.
- No secrets exposed to frontend.
- Backend-only credential handling.
- Task execution timeouts.
- Output size limits.
- Safe process termination.
- Structured audit logs.

Dangerous operations must require explicit human approval.

Do not use dangerously-skip-permissions or equivalent unrestricted permission bypasses.

Never accept arbitrary working directory paths or executable commands directly from browser requests.

## 6. Real-time events

Establish typed events such as:
- task.queued
- task.started
- agent.status_changed
- agent.message
- task.progress
- task.waiting_for_approval
- task.completed
- task.failed
- task.cancelled

Deliver events to the frontend through SSE.

Support reconnection and event IDs where appropriate.

Ensure the frontend can recover current state after disconnecting instead of relying only on transient events.

## 7. Frontend integration

Connect the existing workforce UI to the backend through a service layer.

Preserve:
- Agent registry.
- Desk assignments.
- 3D agent indicators.
- Agent detail panel.
- Task management UI.
- Activity feed.
- Existing layout editor.

Keep the mock runtime available for development and fallback.

Introduce an explicit runtime environment indicator such as Mock or Local Backend.

Do not label a mock task as a real Claude execution.

## 8. Local-first and VPS-ready

Support environment-based configuration for:
- Backend host and port.
- Frontend API URL.
- Workspace root.
- Runtime selection.
- Execution timeout.
- Allowed tools.
- Credential configuration.

Local mode should work on the developer's machine.

Future VPS mode should use the same application-level API and runtime interface.

Do not implement VPS deployment yet.

## 9. Verification

Test:
1. Backend starts independently.
2. Frontend connects to backend.
3. Existing mock runtime still works.
4. Agent and task state remains consistent.
5. SSE delivers events and handles reconnection.
6. Invalid workspace paths are rejected.
7. Unauthorized commands are rejected.
8. Cancellation and timeout behavior work.
9. Existing 3D office and layout editor remain functional.
10. Production build and relevant tests pass.

Run the actual available checks. Do not claim success without execution.

## 10. Scope boundary

This phase must not:
- Pretend Claude is running.
- Launch unrestricted shell commands.
- Expose credentials in browser code.
- Deploy to VPS.
- Introduce multi-user authentication.
- Rewrite the completed 3D scene.
- Remove the existing mock runtime.

## Final report

Report:
- Actual architecture implemented.
- Files created and modified.
- API endpoints.
- Event contracts.
- Security boundaries.
- Persistence approach.
- Build and test results.
- Remaining work before real Claude execution.

Explicitly state whether the Claude Agent SDK is installed or integrated. Do not claim real agent execution if it is not.