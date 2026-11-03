# Milestone 3B.4 Stage F: Permission UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** A person can review a pending approval, choose its scope (once, this task, this agent), see every permission rule (Global and per agent), revoke one, and see changes live. Closes final-report blocker B5. Frontend only; the server is not changed.

**Architecture:** The remote controller keeps a `permissions` slice (active rules and history) next to the workforce state. It loads over `GET /api/permissions` and `/history` after each snapshot and applies `permission.changed` events from the existing event stream (stage C). Commands are plain REST calls through the existing `ApiClient`. UI is two additions: a permissions panel and a scoped decision block in the existing approval card. Local (mock) mode has no permission engine, so the panel says a backend is required and the approval card keeps Approve / Deny.

**Spec:** `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md` (4.4, 4.5, 4.8). Stage C report: `docs/milestone-3b4-stage-c-report.md`.

## Global Constraints

- Branch `feat/3b4-f-permission-ui`; conventional commits with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- The browser is never an authority: it sends a choice, the server validates (digest, scope, tool ceiling) and the UI shows the server's answer and error text unchanged.
- Scoped allow is offered only where the server accepts it. Execute and network tools show Once only. A write whose review is `null` or has not been opened cannot be approved at any scope (same rule as today's Approve).
- Approval panel keeps the existing "open the full change before approving" gate for every allow choice. Reject is never gated.
- Colour is never the only signal: every state has a text label and an icon. Every control is keyboard reachable with a visible focus and an accessible name.
- 3D scene, layout editor and `MockRuntimeProvider` untouched. No new dependency. No remote assets.
- Verification at the end: `npm test`, `npx tsc -b`, `npm run build`, `npm run check:secrets`, plus a browser check against `npm run dev:full` with screenshots in `docs/screenshots/3b4-f/`.

## Review Focus

1. **Stale approval:** a decision sent after the approval was decided elsewhere shows the server's 409 and does not leave the card stuck busy. Task 4.
2. **Scope offered vs. allowed:** the choices shown for a tool never exceed what the API accepts. Task 4.
3. **Live consistency:** a revoke in another tab, an expiry or a task-end removes the rule from Active and adds it to History without a reload; a gap (`state.reset`) reloads both lists. Task 2.
4. **Hostile text:** rule `reason`, `pathPattern` and `tool` render as React text, never markup. Task 3.
5. **Local mode:** no request to `/api/permissions` is made without a backend. Task 2.

---

### Task 1: Client types, commands and decision scopes

**Files:** Modify `src/workforce/api.ts`, `src/workforce/types.ts`, `src/workforce/controller.ts`, `src/workforce/remote/commands.ts`; Test `src/workforce/remote/commands.test.ts`, `src/workforce/api.test.ts`.

**Interfaces:**
- `ApprovalDecision` widens to `'approve' | 'deny' | 'allow_once' | 'allow_task' | 'allow_agent' | 'reject'`. Legacy values stay valid; local mode keeps using them.
- `ApprovalBody.decision` follows. `decideApproval` is unchanged in shape.
- `RemoteCommands` gains `createPermission(body: CreatePermissionBody): Promise<ActionResult>`, `revokePermission(id): Promise<ActionResult>`, `revokeAgentPermissions(agentId): Promise<ActionResult>`. The ids are `encodeURIComponent`-ed; bodies are ignored (changes arrive as events), except errors, which go back to the caller.
- `allowedScopes(tool: string): ('once' | 'task' | 'agent')[]` in `src/workforce/view.ts`: execute and network tools (`Bash`, `WebFetch`, `WebSearch`) give `['once']`, others all three.

- [ ] Write failing tests: each command sends the right method, path, JSON body and returns the server's error text on 4xx; a hostile id is encoded; `allowedScopes` per tool; legacy approve/deny still typed.
- [ ] Run, expect FAIL. Implement. Run, expect PASS.
- [ ] Commit `feat(workforce): permission commands and scoped decision values`.

### Task 2: Permissions state in the remote controller

**Files:** Modify `src/workforce/remote/remoteController.ts`, `src/workforce/remote/sync.ts`, `src/workforce/useWorkforce.ts`, `src/workforce/api.ts`; Create `src/workforce/permissions.ts`; Test `src/workforce/permissions.test.ts`, `src/workforce/remote/remoteController.test.ts`, `src/workforce/remote/sync.test.ts`.

**Interfaces:**
- `PermissionsState = { active: PermissionRuleView[]; history: PermissionRuleView[]; loaded: boolean }` and a pure `applyPermissionEvent(s, e: PermissionChangedEvent): PermissionsState`: `granted` upserts into active; `revoked | used | ended | expired` moves the rule to history (newest first, capped at 200); an event for an unknown rule is inserted by its `state`.
- `Workforce` gains `permissions: PermissionsState | null` (`null` in local mode) and `actions.createPermission / revokePermission / revokeAgentPermissions` (absent in local mode).
- The sync passes `permission.changed` events through to a new `onPermissionEvent` callback instead of dropping them, and calls `onResync` after every snapshot load (first load, reconnect, `state.reset`). `onResync` loads both lists.

- [ ] Write failing tests: pure reducer cases (grant, revoke, use, expire, unknown rule, history cap, duplicate event); controller loads after the first snapshot, after a reset and after reconnect; a failed list load keeps the old lists and reports once; local mode makes no request and exposes `permissions === null`.
- [ ] Run, expect FAIL. Implement. Run, expect PASS.
- [ ] Commit `feat(workforce): live permissions state from the backend`.

### Task 3: Permissions panel

**Files:** Create `src/workforce/ui/PermissionsPanel.tsx`, `src/workforce/ui/PermissionRuleRow.tsx`; Modify `src/workforce/view.ts`, `src/workforce/ui/WorkforcePanel.tsx`, `src/styles.css`; Test `src/workforce/ui/PermissionsPanel.test.tsx`, `src/workforce/view.test.ts`.

**Interfaces:**
- `WorkforceView` gains `{ kind: 'permissions'; tab: 'global' | string }` (an agent id for an agent tab). The agent list header gets a "Permissions" link.
- Tabs: Global and one per agent. Sections: Active, History. A row shows effect, tool, path pattern, scope, who created it, expiry, reason and a state chip. `permissionStateLabel(state, effect)` gives the text and the icon name: Allowed, Denied, Approval required, Expired, Revoked, Used, Ended. Pending approvals are shown from the workforce state (tasks waiting) at the top with a link to the agent.
- Revoke asks through the existing `openDialog` confirm, names the tool and scope, and shows the server error if refused. "Revoke all for this agent" is on the agent tab only and confirms the count.
- Rules whose `createdBy` is `default` say so; revoking a default is allowed (the engine falls back to default deny) and the confirm says that.

- [ ] Write failing tests: rows and labels for every state; icon plus text, no colour-only state (assert the label text); hostile `reason` such as `<img onerror>` renders as text; revoke confirm then call, cancel does nothing, server error shown; empty states; agent tab filters by `agentId`; keyboard: tabs and buttons reachable, `aria-selected`, focus returns to the trigger after the dialog.
- [ ] Run, expect FAIL. Implement. Run, expect PASS.
- [ ] Commit `feat(workforce): permissions panel with revoke`.

### Task 4: Scoped decision in the approval card; status chip

**Files:** Modify `src/workforce/ui/AgentDetail.tsx`, `src/workforce/view.ts`, `src/styles.css`; Test `src/workforce/ui/AgentDetail.test.tsx` (new), `src/workforce/ui/ApprovalReview.test.tsx`.

**Interfaces:**
- When the workforce is remote, the card shows one radio group (Once, This task, This agent; only `allowedScopes(tool)`) and two buttons: Allow and Reject. Local mode keeps Approve and Deny.
- Allow is disabled until the full change is open (`approveEnabled`), exactly as Approve is today, and while a decision is in flight. The choice resets when the approval id changes.
- The scope sentence names what it grants ("Allow Write for this task only, to any path in workspace X"), taken from the pending approval, not typed by the user.
- A status chip next to the agent's name shows how many permission rules are active for the agent and the next approval state ("Approval required", "Pending"). Text first, icon second.

- [ ] Write failing tests: execute tool offers Once only; a write offers three and Allow stays disabled until the review is opened; each choice sends the right decision value and digest; Reject sends `reject` without opening; a 409 is shown and the buttons come back; the radio resets on a new approval id; local mode still shows Approve / Deny; chip text for no rules, some rules, pending.
- [ ] Run, expect FAIL. Implement. Run, expect PASS.
- [ ] Commit `feat(workforce): choose the scope of an approval`.

### Task 5: Check in a real browser, report

- [ ] `npm test`, `npx tsc -b`, `npm run build`, `npm run check:secrets` all clean; existing UI tests untouched.
- [ ] `npm run dev:full`: create a rule, revoke it, open the same app in a second tab and see it move live, run a simulated approval with each scope, check keyboard use and 360 px width. Screenshots to `docs/screenshots/3b4-f/`.
- [ ] Write `docs/milestone-3b4-stage-f-report.md`: changed files, real counts, security notes (the browser still holds no authority; text rendered as text), rulings, what stage G still needs.
- [ ] Commit `docs: milestone 3B.4 stage F report`.

## Not in this stage

Creating `task` or `once` rules by hand (they come from approvals), editing a rule (revoke and create instead), a local-mode permission engine, an audit log viewer.
