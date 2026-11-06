# Step 1: roadmap, tests and CI cleanup

**Goal:** make the project's written status true, make the test suite trustworthy on the owner's Mac and in CI, and record the owner's product decisions, before the character work starts.

**Spec:** none. The owner's decisions are written out in Task 1. This is a small cleanup approved in chat.

**Branch:** `chore/step-1-cleanup`, one PR at the end. The owner merges. Commits use conventional commit messages.

## Global Constraints

- No product behaviour changes except what Task 2's diagnosis justifies.
- Never weaken a security test to get it passing. A timeout may grow only if the scaling assertion it guards stays exactly as strict.
- Do not state anything as verified unless a command output or a named repo doc shows it. Use the roadmap's own status vocabulary (`MASTER-ROADMAP.md` section 7).
- Never read, print or ask for an API key. Do not run `scripts/claudeRealRun.ts`.
- No new runtime dependencies.

## Task 1: Correct the roadmap and README, and record the owner's decisions

**Files:** `MASTER-ROADMAP.md` (currently untracked, add it), `README.md`.

Verified facts to use (as of 2026-11-06):

- `main` is at `1e3af7c`, after PR #69. PR #59 merged the M3B.4 final blockers.
- Real runs passed: `docs/first-real-run-safety-checklist.md` records two `--injection` runs and one `--injection --write` run, about $0.026 estimated each, all in a temporary workspace. The owner approved the write with `y`.
- The owner confirmed on 2026-11-06: the API key has a spending limit set in the console; all three runs used their **normal OS user account, not a dedicated user**. So condition C1 of the checklist was not met. By design those runs only touched a temporary folder. Do not write that this caused no harm, and do not claim which groups that account belongs to.
- Still not observed: console cost for the runs, which model the SDK used, a real rejection, a real cancellation, a sensitive-file write with a real model.
- Agent code today: stable `id`, `deskId`, `status` and a separate task lifecycle (`src/workforce/types.ts`); versioned server store (`server/store.ts`); explicit `removeAgent` (`src/workforce/operations.ts`). The system prompt uses only name and role (`server/runtime/claudePrompt.ts`). Model is one server-wide `CLAUDE_MODEL`. A finished task sets `agentStatus: 'completed'`, a failed one `'error'`, a cancelled one `'idle'` (`src/workforce/operations.ts`).
- The office has no kitchen, dining or prayer areas, no doorways, no characters and no 3D character files. Bash, WebFetch and WebSearch are denied by default (`server/permissions/defaults.ts`). Agent data is one JSON file.

Edits to `MASTER-ROADMAP.md`:

1. Baseline line: `main` at `1e3af7c` after PR #69. Change the "Statuses below" note so it says the status was checked against the repository on 2026-11-06.
2. Status table: M3B.4 final blockers merged in #59, with the merged-`main` rerun status per item 3. M3B.5 is `VERIFIED — REAL RUN`, not `COMPLETE`, because acceptance items remain open. Change M3B.6-onward row to name the new order in item 8.
3. "Required verification": tick "merged". Leave the rerun box unticked for now with a note that Task 3 of this cleanup completes it. Leave the `permission.expired` decision open.
4. Replace the "Important baseline caveat" with an accurate one: what real runs proved and what they did not (the "Still not observed" list), plus the C1 finding. Update the M3B overall status and M3B.5 status lines to match.
5. M3B.5 acceptance: tick the real-run item and the audit-review item. Split the "confirm actual model selection..." item so the allow-path approval is ticked and model selection, usage/console cost, cancellation and rejection stay unticked.
6. First real-run checklist: tick only what is shown: disposable workspace, capped key (owner confirmed 2026-11-06), broad scopes off, public Claude off, concurrency 1, read-only task, approved write task. Leave unticked with a short note: review of existing permission rules (the script used a fresh data folder; required before a real workspace), full verification (cancellation and console cost not observed), revoke/rotate. Add a new unticked item: run as a dedicated non-admin OS user before any real workspace. Note that `docs/os-user-hardening.md` was written for Linux (`adduser`, `/srv`) and needs adapting if the server runs on macOS.
7. M3B.6: add a short "Already in place" list from the agent facts above and shrink the scope to what is missing: agent instructions, per-agent model, `.claude/agents` import, presence states, and the return to idle after a finished or failed task (make it precise: decide how `completed` and `error` settle back to `idle`). Keep the acceptance criteria.
8. Split M3C into **M3C.1 Seated characters** (one stylized character per agent at its desk, idle and working animations driven by real status) and **M3C.2 Office daily life**, with these owner decisions recorded as theirs:
   - Agents only; no character for the owner for now.
   - Style: stylized 3D, modern professional.
   - Routine: work, chat, lunch, work, prayer, coffee in the kitchen. Follows the real clock, timezone `Asia/Jakarta`. Prayer times for Jakarta.
   - Chatting is visual only (characters and speech bubbles); no Claude text, no API calls.
   - A task given during a break waits until the break ends, and the agent visibly shows it is on a break. Mark the urgent-task override as proposed, not decided.
   - Walking agents and a visible prayer are wanted **if the effort is reasonable**; otherwise they go to the next update and are not required now.
   - New needs: kitchen, dining and prayer areas with furniture, doorways or paths between rooms, a schedule, and no model calls for any of it.
   Move walking and navigation here from M3C. Meeting animations stay with M5.
9. M4: add a "Prerequisites" block: safe command running inside an OS-level sandbox (test evidence at the M4 acceptance list is impossible while agents cannot run commands), and a storage decision for projects and dependencies. Note these were moved up from M7. Remove or cross-reference the matching lines in M7. CI moves to done-in-step-1, cross-referenced from M7.
10. Mark M5, M6 and M7 as separate projects to decide on after using M4.
11. Section 4 order: (1) this cleanup, (2) finish the open real-run checks before any real workspace, (3) M3B.6 + M3C.1 as one release using the mock runtime, (4) M3C.2, (5) sandbox, command running, storage decision, then a small M4 with one plan, one handoff, one review, (6) M5, M6, M7 as separate decisions. Keep the parallel-work notes that still apply.
12. Section 5 cost: note the decision stays one backend API key; agent files provide profile and instructions only, and running on a Pro/Max plan is not being pursued now.
13. Section 6: add an unticked item for agents living a daily routine. Section 7: add a line that each milestone gets one plan and one report, with deep reviews reserved for security-sensitive code. Section 8: replace with the new next action (M3B.6 + M3C.1 design). Update "Last roadmap update" if the date differs.

Edits to `README.md`, stale lines only:

- In "Known limitations", replace "**Agents are a simulation**..." and the backend-mode line with what is true now (mock is the default; Claude is optional and has no OS sandbox; session cookie pairing exists). Check `docs/browser-auth.md` and `docs/gated-tools.md` against the code before removing the "none of them built" line; `docs/sandbox-architecture.md` is still not built.
- Fix the line near line 163-165 that says the session cookie is "not built" if the code shows it is (`server/session.ts`).
- Replace "Next milestone" with a pointer to `MASTER-ROADMAP.md`.

Verify: re-read both files for contradictions; `npm run check:secrets` passes. Commit: `docs: add master roadmap with verified status and owner decisions`, plus `docs(readme): remove stale runtime claims` if separate.

## Task 2: Diagnose and fix the two failing tests

**Files:** `server/redact.test.ts`, `server/gateway/proxy.test.ts`, and `server/gateway/*` or `server/redact.ts` only if the diagnosis shows a real defect.

Run `npm ci` first because the branch is newer than the local `node_modules`. Use superpowers:systematic-debugging. Baseline on this Mac (Node 24.14.0): `answers 413 for a body over 1 MiB...` failed with `write EPIPE` in 6 of 6 runs. `finds a JWT anywhere... / costs about linear time on the token formats` hit the 5000 ms timeout in 5 of 6 runs. Neither appeared in the 3B.5 report's run, which was on Linux with Node 22.

For each failure, find the cause and state it with evidence. Also run both files under Node 22 (`npx -y node@22 node_modules/vitest/vitest.mjs run <files>`) to learn whether it is the OS or the Node version.

- **413 / EPIPE:** determine whether the gateway closes the connection before a client can read the 413. If a real client can lose the 413 response, that is a gateway bug: fix the gateway so the client reliably receives it (for example, finish the response and stop reading, without destroying the socket early), and do not forward any of the body. Keep the 1 MiB limit and bounded resource use. If the response is reliably delivered and only the test client's write error is at fault, fix the test client so it still asserts the 413 and that nothing was forwarded.
- **Linear time:** measure which `expectLinear` cases are slow. Determine whether the slowness is real super-linear behaviour in `server/redact.ts` or only total test time. If super-linear, fix `redact.ts`. If it is only total time, give that one test a longer explicit timeout or split it into separate tests. Do not lower the sizes or loosen the ratio in `expectLinear`.

Verify: run both files 5 times in a row with no failures, then the full `npx vitest run` once. Report the counts. Commit: `fix(...)` or `test(...)` per what the diagnosis shows.

## Task 3: Add CI and complete the merged-main verification

**Files:** `.github/workflows/ci.yml` (new), `package.json`, `MASTER-ROADMAP.md`.

1. Workflow on `pull_request` and on `push` to `main`, `ubuntu-latest`, Node matrix 22 and 24, `permissions: contents: read`, `actions/checkout` and `actions/setup-node` with npm cache, pinned to full release tags. Steps: `npm ci`, `npm run build`, `npm test`, `npm run server:build`, `npm run check:secrets`. A separate non-matrix step or job runs `npm audit --audit-level=high`. No secrets are used, and the opt-in real-SDK tests stay skipped.
2. Add `"engines": { "node": ">=20.19" }` to `package.json` if it is absent, matching the README. Run `npm install --package-lock-only` only if the lockfile needs it, and keep the lockfile diff minimal.
3. Run the same commands locally. Record real results in the roadmap's "Required verification" (tests, type check, builds, secret scan, audit). If a command fails, report it and do not tick its box. If audit finds high or critical issues, report them rather than upgrading anything.

Commit: `ci: run build, tests, secret scan and audit on every PR`.
