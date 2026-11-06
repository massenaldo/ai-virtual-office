# AI Virtual Office — Master Roadmap

> **Purpose:** Master plan for evolving the AI Virtual Office from a configurable 3D office into a persistent, collaborative AI-agent workspace with real task execution, live meetings, and a video studio.
>
> **Project repository:** https://github.com/massenaldo/ai-virtual-office  
> **Current baseline:** `main` at `1e3af7c` after PR #69 (Milestone 3B.5 PRs #60–#66, then #67–#69).  
> **Last roadmap update:** 2026-11-06

---

## 1. Product vision

Build a self-hosted, realistic 3D virtual office where AI agents have persistent identities, roles, departments, and workstations. The agents should be able to execute real tasks under controlled permissions, collaborate through an orchestration layer, appear and behave naturally in the 3D office, join live voice meetings, and contribute to video creation and editing workflows.

The office must remain useful even when no agent is executing a task: registered agents should remain visible and idle rather than disappearing when a runtime session ends.

### Guiding principles

1. **Persistent identity, temporary execution:** an agent is a durable workforce entity; a model/runtime session is temporary.
2. **Mock mode remains useful:** the office UI and workforce can be explored without paid model calls.
3. **Security before autonomy:** keep permissions server-authoritative, default-deny, auditable, and scoped.
4. **Local-first, VPS later:** prioritize a straightforward native local development workflow; Docker is not a prerequisite for the initial experience.
5. **No false runtime claims:** distinguish UI simulation, mocked execution, SDK integration tests, and successful real-model execution.
6. **Incremental changes:** audit the current implementation before each milestone; preserve the existing layout editor and 3D office.
7. **Cost visibility:** make model usage, limits, and actual spend understandable before increasing autonomy.

---

## 2. Current status at a glance

Statuses below were checked against the repository on 2026-11-06 (merge state, agent code, README claims); milestones M1 to M3B.4 are still as reported, not re-tested. Items that depend on the owner's own runs or on the Anthropic Console are marked as reported or not observed.

| Milestone | Scope | Reported status |
|---|---|---|
| M1 | Office foundation and layout editor | Complete |
| M2 | Realistic 3D office environment | Complete |
| M3A | Workforce UI and mock runtime | Complete |
| M3B.1 | Runtime backend foundation | Complete |
| M3B.1.1–3B.1.2 | Security hardening and E2E | Complete |
| M3B.4 | Permissions and gated tools | Complete |
| M3B.4 final blockers | Permission reconciliation, scaling test, workspace picker | Merged in #59; the full rerun on merged `main` is still open (to be done after the step 1 cleanup PR merges) |
| M3B.5 | Claude Agent SDK runtime integration | **VERIFIED — REAL RUN** (not `COMPLETE`: acceptance items remain open) |
| M3B.6 + M3C.1 | Agent identity and presence, plus seated characters (one release) | Planned |
| M3C.2 onward | Office daily life, then sandbox and a small M4, then M5–M7 as separate decisions | Planned (order in section 4) |

### Important baseline caveat

Real runs have happened. `docs/first-real-run-safety-checklist.md` records two `--injection` runs and one `--injection --write` run with a real model, about $0.026 estimated each, all in a temporary workspace; the owner approved the write with `y`. Those runs show that the SDK honours our options, that reads go through the gate, and that one approved write was made in a temporary folder.

They did **not** show, and these are still not observed:
- the cost the Anthropic Console shows for the runs;
- which model the SDK actually used;
- a real rejection of a write;
- a real cancellation;
- a write to a sensitive file with a real model.

**Finding C1 (owner-confirmed 2026-11-06).** The API key has a spending limit set in the console. All three runs used the owner's **normal OS user account, not a dedicated user**, so condition C1 of the checklist was not met. By design those runs only touched a temporary folder. Which groups that account belongs to has not been checked here.

Fake-SDK tests and the dummy-key test are still not proof of a real-model run; only the recorded real runs count, and only for what they showed.

---

## 3. Detailed roadmap

## M1 — Office Foundation & Layout Editor

**Status:** Reported complete.

### Objective
Establish the base web application and an editable office layout.

### Scope
- React + TypeScript + Vite application foundation.
- Three.js / React Three Fiber rendering foundation.
- Office layout editor.
- Room and furniture editing.
- Synchronization between floor-plan/layout representation and 3D view.
- Save, reload, undo/redo, and reset workflows, as implemented in the project.
- `/vo` developer command to start the server when needed and open the application.

### Acceptance criteria
- [x] Application starts using the documented local workflow.
- [x] User can edit the office layout.
- [x] Layout changes are reflected in the 3D office.
- [x] Existing editor behavior is preserved in later milestones.

### Notes
Before changing this milestone, inspect the current implementation and tests. Do not rebuild the editor merely to add workforce features.

---

## M2 — Realistic 3D Office Environment

**Status:** Reported complete.

### Objective
Make the office feel like a premium, believable technology-company workspace while preserving browser performance and editor usability.

### Visual direction
- Premium modern technology startup office.
- Industrial-minimalist styling.
- Warm oak/walnut desks and matte-black metal details.
- Ergonomic chairs and realistic workstation equipment.
- Glass meeting-room partitions.
- Neutral or concrete-style flooring.
- Natural daylight, soft shadows, and warm interior lighting.

### Implementation preferences
- Prefer procedural geometry and reusable materials where practical.
- Avoid excessive high-poly assets and unnecessary draw calls.
- Keep the layout editor and object selection/editing usable.
- Preserve responsive performance in the browser.

### Acceptance criteria
- [x] Realistic office environment is present.
- [x] Existing layout editor remains functional.
- [x] Scene remains usable in the target browser and local development setup.

---

## M3A — AI Agent Workforce UI & Mock Runtime

**Status:** Reported complete.

### Objective
Introduce a visible workforce that can be managed independently of real model execution.

### Scope
- Agent registry with stable IDs.
- Agent create, edit, and delete flows.
- Departments and role metadata.
- Agent-to-workstation mapping using actual office/workstation IDs.
- Agent detail panel and 3D selection mapping.
- Statuses such as `idle`, `working`, `thinking`, `waiting`, `error`, and `completed`.
- Task list and activity feed.
- Mock task lifecycle for UI development and demonstrations.
- Clear distinction between mock and real runtime.
- Provider abstraction boundary.
- Versioned and validated persistence, separate from office-layout persistence.

### Acceptance criteria
- [x] Agents can be managed through the workforce UI.
- [x] Agent selection maps to the relevant office representation.
- [x] Mock tasks can demonstrate the task lifecycle.
- [x] Mock execution is not presented as real Claude execution.

---

## M3B — Real Agent Runtime & Security

**Overall status:** SDK integration merged; real runs passed (see the baseline caveat); several acceptance items and the dedicated-OS-user condition remain open.

### M3B.1 — Runtime backend foundation

**Status:** Reported complete.

Established the separate local Node.js/TypeScript backend, REST and SSE communication, runtime-provider abstraction, task lifecycle, event replay, and mock provider.

Reported foundation included:
- Backend listening on loopback.
- REST endpoints for health, state, workspaces, events, and agent/task operations.
- SSE event IDs, replay, heartbeat, slow-client handling, and recovery.
- Task lifecycle and timeout handling.
- Mock runtime provider.
- Typed Claude runtime provider boundary.

### M3B.1.1–3B.1.2 — Security hardening

**Status:** Reported complete and merged through PRs #31–#39.

Reported work included:
- Workspace validation and path checks.
- API Bearer-token protection and Vite development proxy.
- Centralized tool gate and approval digest checks.
- Secret redaction and output limits.
- Safer error handling and audit logging.
- Large-write review UI.
- Reliability fixes and security review.

### M3B.4 — Permission management and gated tools

**Status:** Reported complete; stages A–G merged through PRs #45, #47, #48, #51, #52, #55, #56, and #57.

Reported capabilities:
- Permission rules at global, agent, task, and one-time scopes where supported.
- Allow, deny, ask, revoke, and expiration behavior.
- Server-authoritative permission decisions and audit events.
- Pending approval review with action digest.
- Live permission updates over SSE.
- Permission history and rule revocation.
- Gated file operations and sensitive-path denylist.
- Bash, WebFetch, and WebSearch denied by default; Bash remains denied.
- Workspace picker in task creation, based on the final-blockers report.

### M3B.4 final blockers — merge verification

The final-blockers report described B9/B10 and the workspace picker as complete on a branch based on `main` at `f9c16b6`, with branch tip `a9c3faa`. It explicitly said the final checks still needed to be rerun on merged `main`.

**Required verification before relying on this baseline:**
- [x] Confirm the final-blockers branch/changes are merged to `main` (PR #59, commit `377294f`, an ancestor of `main`).
- [ ] Rerun the full test suite, type checks, builds, secret scan, and dependency audit on merged `main`. Not yet ticked: these ran locally on macOS with Node v24.14.0 only (not Node 22), not from a fresh `npm ci`, on branch `chore/step-1-cleanup` (`main` plus the step 1 cleanup, based on `1bc2ee4`), not on merged `main`. Rerun after the cleanup PR merges.
  - [x] Tests: 109 files passed, 1 skipped; 2303 tests passed, 10 skipped (`npm test`).
  - [x] Type check: `tsc -b` reported no errors.
  - [x] Builds: `npm run build` and `npm run server:build` succeeded.
  - [x] Secret scan: `npm run check:secrets` found no secrets in `dist/` or `dist-server/` (12 files).
  - [x] Dependency audit: `npm audit --audit-level=high` found 0 vulnerabilities.
  - [ ] CI: `.github/workflows/ci.yml` added (build, test, server build, secret scan on Node 22 and 24; separate audit job) but not yet run; CI's first run will be on the PR. Tick this only after a green run. Note on the secret scan: with no key value present in CI it can only match key shapes and variable names, so a pass there is weaker than a local run with the real key set.
- [ ] Decide whether repeated `permission.expired` audit entries across restarts need correction. Still an open decision.

### M3B.5 — Claude Agent SDK integration

**Status:** VERIFIED — REAL RUN. PRs #60–#66 are merged to `main`, followed by the docs and script fixes in #67–#69 (`main` at `1e3af7c`). Three real runs passed; the open items are listed under the acceptance criteria. Not `COMPLETE`.

Reported architecture:

```text
React UI
  -> RemoteWorkforceController
  -> REST / SSE backend
  -> TaskManager
  -> ClaudeAgentRuntimeProvider
  -> Claude Agent SDK
  -> Claude Code child process
  -> in-process MCP tools
  -> ToolGate
  -> permission engine + approval + use-time recheck
  -> workspace file operations
```

The model accesses the selected workspace through the five custom tools:
- `vo_read`
- `vo_glob`
- `vo_grep`
- `vo_write`
- `vo_edit`

The report says built-in SDK tools are disabled, unexpected tools fail closed, and the server permission engine remains authoritative.

#### Runtime configuration reported by the implementation

| Setting | Purpose / reported default |
|---|---|
| `RUNTIME=claude` | Select Claude runtime as the default |
| `ENABLE_CLAUDE_RUNTIME=yes` | Enable Claude alongside mock runtime |
| `ANTHROPIC_API_KEY` | Backend-only Anthropic Console API key |
| `WORKSPACE_ROOT` / `WORKSPACES` | Workspace boundaries |
| `CLAUDE_MAX_TURNS` | 12 |
| `CLAUDE_MAX_BUDGET_USD` | 0.5 SDK-estimated budget per task |
| `MAX_CONCURRENT_TASKS` | 2 |
| `ALLOW_BROAD_WRITE_SCOPES` | Off unless explicitly enabled |
| `VO_ALLOW_ROOT` | Off |
| `VO_ALLOW_PUBLIC_CLAUDE` | Off |

Other controls include task timeout, approval timeout, and public-start configuration. Confirm exact variable names and behavior against the current `.env.example` and runtime configuration before changing them.

**Important:** the `$0.50` task budget is an SDK estimate/control, not a guaranteed hard billing cap. Track actual Anthropic Console usage separately.

#### M3B.5 acceptance criteria

- [x] Claude Agent SDK provider integrated.
- [x] Custom workspace tools and permission checks integrated.
- [x] Mock and Claude providers can coexist as reported.
- [x] Security-focused tests cover tool restrictions, approval, cancellation, and child-process behavior.
- [x] Run a successful task against a real Anthropic model using a capped API key (three runs; the owner confirmed the spending limit on 2026-11-06).
- [x] Approval behavior on the allow path in a real run (the owner approved one write with `y`).
- [ ] Confirm which model the SDK actually used.
- [ ] Confirm input/output usage and the cost the Anthropic Console shows.
- [ ] Confirm cancellation in a real run.
- [ ] Confirm a real rejection of a write.
- [x] Review the first real-run audit before enabling broader usage (`docs/first-real-run-safety-checklist.md`).

#### First real-run safety checklist

- [x] Use a dedicated, disposable test workspace containing non-sensitive files.
- [x] Use a capped/controlled Anthropic Console key or billing limit where available (owner confirmed on 2026-11-06).
- [x] Keep broad write scopes disabled.
- [x] Keep public Claude access disabled.
- [x] Keep concurrency at 1 for the first run.
- [ ] Review existing permission rules, especially rules created before workspace/runtime binding. The script used a fresh data folder, so this is still required before a real workspace.
- [x] Run one small read-only task first.
- [x] Then run one narrowly scoped write task requiring explicit approval.
- [ ] Verify the changed files, audit events, task status, cancellation, and reported cost. Cancellation and console cost were not observed.
- [ ] Revoke test permissions and rotate the test key if it may have been exposed. Still open: neither the revoke nor the rotation is recorded as done or as decided against, so this stays unticked until the owner does one or the other.
- [ ] Run as a dedicated non-admin OS user before any real workspace. (Not done for the first runs, see C1. `docs/os-user-hardening.md` was written for Linux (`adduser`, `/srv`) and needs adapting if the server runs on macOS.)

#### Known limitations and follow-up risks

- No OS-level sandbox has been implemented; host processes running as the same OS user may share access to credentials and data.
- File contents read by the agent are sent to Anthropic; redaction is not a confidentiality boundary.
- Broad write approvals are intentionally restricted by default.
- Some in-flight operations may not stop immediately on permission revocation.
- The report notes event-loop blocking risk for parallel searches, incomplete overwrite review presentation, and audit-log rotation as future work.
- No independent human penetration test was reported.
- SDK license/terms review remains an open operational/legal check.

### M3B.6 — Persistent Agent Identity & Office Presence

**Status:** PLANNED; first half of the next release (with M3C.1).

### Objective
Make agents persistent members of the office, independent of task execution and runtime sessions.

### Problem to solve
A Claude subagent definition in `.claude/agents/*.md` is not automatically a persistent workforce entity. Likewise, completing or disposing of a runtime session should not delete the corresponding office agent.

### Already in place (checked in the repository on 2026-11-06)
- Agents have a stable `id`, a `deskId` and a `status`, and tasks have their own lifecycle (`src/workforce/types.ts`).
- The server store is versioned (`server/store.ts`).
- Removing an agent is an explicit action (`removeAgent` in `src/workforce/operations.ts`).
- The system prompt uses only the agent's name and role (`server/runtime/claudePrompt.ts`).
- The model is one server-wide setting, `CLAUDE_MODEL`.
- A finished task sets the agent's status to `completed`, a failed one to `error`, a cancelled one to `idle` (`src/workforce/operations.ts`).

### Scope (what is missing)
1. **Agent instructions** per agent (today the prompt uses only name and role).
2. **Per-agent model** preference, replacing the single server-wide `CLAUDE_MODEL` as the only choice.
3. **Safe `.claude/agents` import**
   - Read supported frontmatter/metadata and instruction text.
   - Do not execute imported files or treat their content as permission grants.
   - Validate IDs, names, model fields, and allowed metadata.
   - Show import errors rather than silently creating invalid agents.
   - Define how file changes are reconciled with manually edited workforce profiles.
4. **Presence states**
   - `idle`, `working`, `thinking`, `waiting`, `error`, and `offline` (final vocabulary to be agreed).
   - Decide how `completed` and `error` settle back to `idle` after a finished or failed task (when, and whether by time or by user action). Today only a cancelled task returns the agent to `idle`.
   - Runtime session disposal does not remove the agent.
5. **UI**
   - Persistent office roster.
   - Clear distinction between registered, online, busy, and executing.
   - Agent remains visible at its workstation while idle.

### Acceptance criteria
- [ ] Agent identity is stored independently from tasks and runtime sessions.
- [ ] An idle agent remains visible in the 3D office.
- [ ] Task success, failure, timeout, and cancellation do not delete the agent.
- [ ] Refresh and server restart preserve agent identity and workstation assignment.
- [ ] `.claude/agents` import is read-only and cannot grant tools or permissions.
- [ ] Removing an agent is an explicit workforce-management action.
- [ ] No Claude session or API call is created just to keep an agent visible.

### Out of scope
- Real model execution merely to animate an idle character.
- Automatic permission grants based on agent markdown.
- Autonomous multi-agent delegation (covered by M4).

---

## M3C — 3D Characters & Office Daily Life

Split into two releases. M3C.1 ships together with M3B.6; M3C.2 follows.

### M3C.1 — Seated characters

**Status:** PLANNED; ships with M3B.6.

#### Objective
One stylized character per agent, seated at its desk, whose animation follows the agent's real status.

#### Owner decisions (recorded as the owner's)
- Agents only; no character for the owner for now.
- Style: stylized 3D, modern professional.

#### Scope
- One character per registered agent, seated at its assigned workstation.
- Idle and working animations driven by the real agent status.
- Natural transitions between animation states; recovery to a sensible state after cancellation or failure.
- No walking, navigation or meeting animations here (see M3C.2 and M5).

#### Technical direction
- Three.js / React Three Fiber scene integration.
- GLTF/GLB character assets where suitable (the office has no character files today).
- Three.js `AnimationMixer` or an equivalent animation abstraction, with a state machine from workforce events to animation states.
- Keep animation and asset loading efficient; avoid making every idle character expensive to render.

#### Acceptance criteria
- [ ] Every visible registered agent has a stable character identity at its desk.
- [ ] Character animation follows actual agent presence/task state.
- [ ] Idle agents remain at their assigned workstations.
- [ ] Characters do not break layout editing or object selection.
- [ ] Characters recover to a sensible state after task cancellation or runtime failure.
- [ ] Performance remains acceptable with the planned number of agents.

### M3C.2 — Office daily life

**Status:** PLANNED; depends on M3C.1.

#### Objective
Agents live a daily routine in the office, without any model calls.

#### Owner decisions (recorded as the owner's)
- Routine: work, chat, lunch, work, prayer, coffee in the kitchen.
- The routine follows the real clock, timezone `Asia/Jakarta`, with prayer times for Jakarta.
- Chatting is visual only (characters and speech bubbles); no Claude text, no API calls.
- A task given during a break waits until the break ends, and the agent visibly shows it is on a break.
- **Proposed, not decided:** an urgent-task override that interrupts a break.
- Walking agents and a visible prayer are wanted **if the effort is reasonable**; otherwise they go to the next update and are not required now.

#### New needs
- Kitchen, dining and prayer areas with furniture (the office has none today).
- Doorways or paths between rooms (the office has no doorways today).
- A schedule, and no model calls for any of it.
- Walking and navigation/collision handling, moved here from the former M3C. Meeting animations stay with M5.

#### Acceptance criteria
- [ ] Agents follow the routine by the Jakarta clock without any model or API call.
- [ ] A task given during a break waits until the break ends, and the break is visible.
- [ ] Kitchen, dining and prayer areas exist and are editable like other rooms.
- [ ] Walking and prayer: done, or explicitly deferred to the next update.
- [ ] Movement does not break layout editing or object selection.

---

## M4 — Agent Orchestration & Collaboration

**Status:** PLANNED; depends on stable identity and real runtime validation. Start small: one plan, one handoff, one review.

### Prerequisites (moved up from M7)
- Safe command running inside an OS-level sandbox. Test evidence in the acceptance list below is impossible while agents cannot run commands (Bash is denied by default in `server/permissions/defaults.ts`).
- A storage decision for projects and dependencies.

### Objective
Allow agents to collaborate on a project through controlled task decomposition, delegation, and review.

### Scope
1. **Project and task model**
   - Projects, tasks, subtasks, dependencies, priorities, and ownership.
   - Task status and execution history.
2. **Orchestration**
   - Project Manager agent can propose a plan and subtasks.
   - Human can inspect and approve the plan before execution.
   - Tasks can be assigned to specific agents by role/capability.
   - Tech Lead can review implementation or coordinate specialists.
3. **Collaboration**
   - Explicit task handoff and structured messages.
   - Shared task context and artifact references.
   - Dependency-aware scheduling.
   - Avoid unnecessary free-form agent-to-agent loops.
4. **Quality control**
   - Review/check stage before marking a task complete.
   - Test and validation evidence attached to tasks.
   - Human approval for consequential actions.
5. **Reliability**
   - Retry policy with bounded attempts.
   - Timeout and cancellation propagation.
   - Recovery after server restart.
   - Queue visibility and concurrency limits.
6. **Cost control**
   - Model choice by task complexity.
   - Per-task usage and cost.
   - Project-level usage summaries.
   - Limits for turns, tokens/budget estimates, concurrency, and retries.

### Suggested initial departments
- Project Management
- Technical Lead
- Backend Engineering
- Frontend Engineering
- Data Engineering
- UI/UX Design
- QA / Testing

These are suggested workforce roles, not a requirement to run all agents concurrently.

### Acceptance criteria
- [ ] A project can be decomposed into inspectable tasks and dependencies.
- [ ] Human can approve or edit the plan before execution.
- [ ] Tasks can be assigned and handed off between persistent agents.
- [ ] Agent outputs and artifacts are traceable to tasks.
- [ ] Review and test evidence are recorded.
- [ ] Retry, timeout, cancellation, and queue behavior are visible.
- [ ] Cost/usage is visible per task and summarized at project level.
- [ ] No unbounded agent-to-agent loop is possible.

---

## M5 — AI Meeting Room & Live Voice

**Status:** PLANNED; a separate project to decide on after using M4. Depends on persistent agents and a stable orchestration/event model.

### Objective
Allow the user and selected agents to participate in a real-time voice meeting inside the 3D office.

### Scope
- Create a meeting room/session.
- Invite the user and selected agents.
- Real-time voice input/output.
- Speech-to-text and text-to-speech where needed.
- Distinct speaker identity and turn management.
- Meeting transcript.
- Summary, decisions, and action items.
- Optional recording, subject to explicit controls and storage policy.
- 3D character movement into the meeting room and talking/listening states.

### Technology evaluation
Evaluate, rather than assume, the final provider and stack:
- OpenAI Realtime API or another suitable real-time voice provider.
- WebRTC for low-latency media transport.
- LiveKit or a comparable media-server option if multi-party routing is needed.
- STT/TTS alternatives based on language quality, latency, pricing, and deployment needs.

### Acceptance criteria
- [ ] User can start and end a meeting.
- [ ] Selected agents can join under a defined meeting policy.
- [ ] Voice interaction works with acceptable latency.
- [ ] Speaker identity is clear.
- [ ] Transcript, summary, decisions, and action items can be saved.
- [ ] Meeting state is reflected in the 3D office.
- [ ] Recording is off unless explicitly enabled.
- [ ] Usage and cost are measurable.

---

## M6 — AI Video Studio

**Status:** PLANNED; a separate project to decide on after using M4. Can be developed as a separate subsystem after core task/artifact handling is stable.

### Objective
Enable the office workforce to create new videos and edit existing media, then store and manage the resulting assets.

### Scope
1. **Creation**
   - Brief and script generation.
   - Storyboard and scene planning.
   - Motion graphics and animated scenes.
   - Voice-over and subtitles.
   - Music/SFX selection subject to licensing.
2. **Editing**
   - Import existing video.
   - Timeline-based edit instructions.
   - Trim, split, reorder, crop, resize, transitions, overlays, captions, and audio mixing.
   - Versioned edits and render history.
3. **Rendering**
   - Render MP4 and other selected output formats.
   - Background render jobs with progress and retry.
   - Preview and final export.
4. **Storage**
   - Cloud/object storage.
   - Metadata database for projects, assets, versions, and render jobs.
   - Access control, retention, and deletion policy.
5. **Agent integration**
   - Agents create scripts, scenes, edit decision lists, captions, and render instructions.
   - Human reviews the timeline/preview before final export.

### Technology evaluation
- Remotion for programmatic React-based video composition.
- FFmpeg for media processing and transcoding.
- AI video generation APIs where a generated video shot is needed.
- TTS/STT providers for narration and subtitles.
- S3-compatible object storage or another suitable cloud storage provider.
- MCP/tools only where they provide a clear, permissioned integration boundary.

### Acceptance criteria
- [ ] User can create a video project from a brief.
- [ ] User can import and edit an existing video.
- [ ] Timeline or edit instructions are reviewable before rendering.
- [ ] Render jobs run asynchronously and expose progress/errors.
- [ ] Output can be previewed and exported.
- [ ] Assets and versions are stored with access controls.
- [ ] Media API/storage/render costs are visible.

---

## M7 — Deployment, VPS & Production Operations

**Status:** PLANNED; a separate project to decide on after using M4. Local-first development remains the priority until core workflows are validated.

### Objective
Run the office reliably outside the development machine with secure remote access and operational visibility.

### Scope
- VPS sizing and deployment plan.
- Domain and HTTPS.
- Secure remote access and authentication.
- Backend process supervision and restart policy.
- Production database and object storage (the storage decision for projects and dependencies is an M4 prerequisite).
- Agent resource limits and concurrency controls.
- API usage and cost dashboard.
- Structured logs and monitoring.
- Health checks and alerting.
- Automated backups and restore testing.
- Deployment (CD) and rollback procedure. CI is added in step 1 of the cleanup but has not run yet.
- Secret management and key rotation.
- OS-level isolation/sandboxing strategy for production: the sandbox itself is now an M4 prerequisite; M7 covers it only for the VPS.

### Deployment principles
- Keep backend services private by default.
- Do not expose Claude-enabled endpoints publicly without an explicit security review.
- Do not run the service as root.
- Keep API keys out of frontend bundles and browser storage.
- Treat a VPS as a deployment target, not a substitute for permission controls or sandboxing.
- Docker is optional for the initial local workflow; evaluate containers or OS-level sandboxing for production isolation.

### Acceptance criteria
- [ ] Application can be deployed and upgraded repeatably.
- [ ] HTTPS and authentication are enabled.
- [ ] Secrets are stored server-side and can be rotated.
- [ ] Backups and restore are tested.
- [ ] Health checks and logs make failures diagnosable.
- [ ] Usage, concurrency, and cost are observable.
- [ ] Public Claude execution is disabled until the security gate is explicitly passed.
- [ ] A documented incident and rollback procedure exists.

---

## 4. Recommended implementation order

This is the recommended sequence based on dependencies and the status checked on 2026-11-06.

| Order | Work item | Why now |
|---:|---|---|
| 1 | This cleanup (step 1): roadmap and README corrections, a trustworthy test suite, CI, rerun on merged `main` | Establish a trustworthy baseline |
| 2 | Finish the open real-run checks before any real workspace | Model used, console cost, a real rejection and cancellation, sensitive-file write, dedicated OS user, review of existing permission rules |
| 3 | M3B.6 + M3C.1 as one release, using the mock runtime | Persistent agents that are visible, seated and animated, with no paid calls |
| 4 | M3C.2 office daily life | Routine, kitchen, dining and prayer areas, doorways; no model calls |
| 5 | Sandbox, command running, storage decision, then a small M4 with one plan, one handoff, one review | Agents cannot run commands yet; M4 evidence needs them |
| 6 | M5, M6, M7 as separate decisions | Decide after using M4 |

Some work can proceed in parallel:
- M3B.6 + M3C.1 design can proceed while the open real-run checks are being finished.
- M6 can be prototyped independently, but production integration should wait for shared artifact, storage, and job conventions.
- M7 infrastructure research can happen earlier, but public deployment with Claude enabled should remain gated.

---

## 5. Cross-cutting requirements

These requirements apply across milestones.

### Security and permissions
- Server is the authority for permissions.
- Default-deny for tools and sensitive operations.
- Human approval for consequential writes and external actions.
- Approval must be bound to the exact action/content digest.
- Re-check permission at the moment of use.
- Keep audit history for decisions and actions.
- Do not infer permissions from agent prompt files.
- Do not claim workspace path checks are an OS sandbox.
- Add OS-level isolation before unattended or public execution.
- **Open:** a client with no password can make the gateway read and discard a request body of any size (500 MiB measured, 0.43 s), and a trickling no-password client stayed connected for at least 20 s. The 401 path has no byte or drain limit. This was not introduced by the step 1 cleanup branch, and the 8 MiB drain bound (`server/gateway/proxy.ts`) applies only after the password check, so it does not cover this.
- **Open:** HTTP/1.0 clients and pipelined `Connection: close` clients can still lose a 413 response.

### Cost management
- Mock mode must not make Anthropic model calls.
- Idle agent presence must not create model sessions or API calls.
- Use one backend-managed credential unless a deliberate per-user credential model is introduced. Decision: one backend API key stays; agent files provide profile and instructions only; running on a Pro/Max plan is not being pursued now.
- Keep model choice configurable by task/agent.
- Measure actual provider usage; do not rely only on estimates.
- Show per-task usage and cost, plus project totals.
- Bound concurrency, turns, timeouts, retries, and task budgets.
- Do not assume an SDK budget estimate is a guaranteed billing cap.

### Persistence and recovery
- Keep office layout, agent registry, tasks, permissions, meetings, and media metadata as distinct domain concerns.
- Version persisted data and validate it on load.
- Define migration and recovery behavior for schema changes.
- Preserve stable IDs across refreshes and restarts.
- Make destructive actions explicit and auditable.

### UX and observability
- Clearly label mock versus real execution.
- Show agent presence separately from task status.
- Make pending approvals and queued work visible.
- Show why an agent is waiting, offline, or in error.
- Keep activity history understandable and searchable.
- Surface runtime errors without leaking secrets or sensitive paths.

---

## 6. Definition of done for the whole product

The product can be considered at its intended end state when:

- [ ] User can configure and edit a realistic 3D office.
- [ ] Workforce agents have persistent identities, roles, departments, and workstations.
- [ ] Agents remain visible and idle when they have no task.
- [ ] Agents live a daily routine in the office (work, chat, lunch, prayer, coffee) without model calls.
- [ ] Agents can execute real tasks through controlled, permissioned tools.
- [ ] The user can inspect and approve sensitive actions.
- [ ] A project can be decomposed, delegated, executed, reviewed, and tracked.
- [ ] Agent characters move and animate according to real presence/task/meeting states.
- [ ] User and agents can hold live voice meetings and save useful outcomes.
- [ ] User can create and edit videos and manage their assets.
- [ ] The system can be deployed and operated securely with backups, monitoring, and cost controls.
- [ ] Mock execution, SDK test execution, and successful real-model execution are always distinguished accurately.

---

## 7. Milestone change protocol

Before starting each milestone:

1. Inspect the actual repository branch, commit, working tree, and relevant implementation.
2. Read the previous milestone report and identify unresolved items.
3. Confirm dependencies and distinguish completed work from planned work.
4. Write a scoped implementation plan with explicit non-goals.
5. Define acceptance criteria and tests before implementation.
6. Preserve unrelated features, especially the 3D layout editor and existing workforce UI.
7. Implement in small, reviewable stages/PRs.
8. Run tests, type checks, builds, security checks, and relevant browser/E2E tests.
9. Review the diff for unrelated changes, secret exposure, and regressions.
10. Update this roadmap and the milestone report with evidence and remaining limitations.

Each milestone gets one plan and one report. Deep reviews are reserved for security-sensitive code.

### Status vocabulary

Use these labels consistently:
- **PLANNED** — not started.
- **IN PROGRESS** — implementation underway.
- **IMPLEMENTED — NOT VERIFIED** — code exists, required checks have not passed.
- **VERIFIED — MOCK ONLY** — verified with mock/simulated providers only.
- **VERIFIED — SDK TESTS** — SDK integration tested, but no successful real-model task proven.
- **VERIFIED — REAL RUN** — at least one successful real-provider task completed and audited.
- **COMPLETE** — acceptance criteria for the milestone are met and evidence is recorded.
- **BLOCKED** — a dependency, risk, or decision prevents progress.

Do not mark a milestone **COMPLETE** solely because code has merged. Record the test evidence and operational validation that support the status.

---

## 8. Immediate next action

The next practical step is the **design of M3B.6 + M3C.1** (persistent agent identity and presence, plus seated characters, as one release on the mock runtime), after this cleanup and its merged-`main` verification.

The open real-run checks (section 3, M3B.5) must be finished before any real workspace is used, including running as a dedicated non-admin OS user.
