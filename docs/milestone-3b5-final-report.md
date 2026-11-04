# Milestone 3B.5 — Real Claude Agent runtime: final report

Date: 2026-11-04. Covers PRs #60 to #66 (planning, 3B.5.1 to 3B.5.4, the public gateway and the prerequisites for real writes), merged to `main`; the state described here is `main` at `dc196fb`. Stage reports: `docs/milestone-3b5-planning.md`, `milestone-3b5-1-report.md`, `-2-`, `-3-`, `-4-report.md`, `milestone-3b5-prerequisites.md`.

## 1. Result

A registered agent can now run a real task on the Claude Agent SDK, read and change files in a workspace you pick, and show what it cost, next to the mock runtime, with every file action going through the server's own permission gate. **No real model has run yet.** Everything with Claude was verified against fake SDK sessions, a scripted local API standing in for the model, and the real SDK binary with a dummy key (which ends in a sign-in failure). The first real run needs your API key and is the one open prerequisite.

**Verdict: READY WITH CONDITIONS** for supervised use on a plain project folder. **NOT READY** for unattended use, for a public address with Claude enabled, or for broad write approvals.

## 2. What was built

| Stage | PR | What a person can do / what exists |
|---|---|---|
| Planning | #60 | Audit of the runtime, gate and UI; SDK research; architecture, roadmap, risks (`milestone-3b5-planning.md`) |
| 3B.5.1 SDK foundation | #61 | `RUNTIME=claude` runs one SDK session per task. Text-only agent: no tools, startup check on the session's own tool list, fixed error sentences, minimal child environment, API key in a wrapper that cannot print |
| 3B.5.2 Read-only tools | #62 | `vo_read`, `vo_glob`, `vo_grep` through an in-process MCP server over the gated handlers; `MAX_CONCURRENT_TASKS` (default 2); SDK tool timeout longer than the approval wait; an opt-in test of the real SDK binary against a scripted API |
| 3B.5.3 Gated writes | #63 | `vo_write`, `vo_edit`: every change waits for a person who sees the whole content and approves exactly that action (digest-bound, re-checked at use time) |
| Public gateway | #64 | `npm run start:public`: one password (HTTP Basic, `VO_PASSWORD`), static app, `/api` and the event stream proxied to a loopback-only backend; for an InstaBox published port |
| Prerequisites | #65 | Independent security review and its fixes, host-safety checks, the first-real-run script, the OS-user decision |
| 3B.5.4 Integration | #66 | Mock and Claude side by side, runtime chosen per task, estimated cost on finished tasks, UI for both |

Size: 113 files changed (+8,688 / −320), 36 of them test files; tests went from 1,546 to **2,297** (+751, plus 10 opt-in real-SDK tests).

## 3. How it fits together

```
React UI → RemoteWorkforceController → REST + SSE backend → TaskManager (per-task provider)
  → ClaudeAgentRuntimeProvider → Claude Agent SDK → bundled Claude Code binary (child process, empty cwd, minimal env)
  → in-process MCP tools vo_read/glob/grep/write/edit → ToolGate → permission rules + approval + use-time re-check → fileOps → workspace
```

The model never touches the workspace except through those five tools. The SDK is configured so it has nothing of its own to approve: no built-in tools, only our five pre-approved, `dontAsk` for everything else, a hook that denies any other tool, no settings files, no stored session, and a **startup check that fails the task if the session's own tool list is not exactly ours**. The server's permission engine decides, never the SDK's.

## 4. Security

**Layers:** policy (workspace folders, sensitive-name denylist, symlink/hard-link refusal), permission rules (global/agent/task/once, deny wins), a human approval bound to a SHA-256 digest of the exact action, a use-time re-check, descriptor-checked file operations with temp-file and rename, redaction and caps on everything shown, audit with digest prefixes and action hashes, fixed error sentences, host-safety checks at startup.

**Independent review.** A fresh adversarial reviewer (a separate model session with no hand in the code, not a human) attacked the runtime in three passes (`docs/security-review-3b5.md`). It found no way to write outside the workspace, change an approved write, skip approval or the startup check, or run code. It did find that what an approval **grants** was too broad. All of it was fixed or recorded:

| Finding | Outcome |
|---|---|
| H1: "allow for this task/agent" let later writes through unreviewed, across workspaces, including files tools run later (`package.json`, git hooks, `.claude` settings); queued requests were allowed by a new rule | Files tools run (every hidden segment, `node_modules`, lock/CI/container/config files, exec-bit files) are once-only; grants are bound to their workspace; queued requests are asked again; **broad write approvals are off by default** (`ALLOW_BROAD_WRITE_SCOPES=yes` to opt in) |
| M1/L1: key material leaked through read offsets and grep; unknown secret formats | Whole-file redaction before slicing and searching; more formats incl. PGP and PuTTY keys |
| M2: Unicode lookalikes (`ſ`) bypassed the denylist | One `foldName` for every name comparison |
| M3: a workspace could be `$HOME` or the server's own repo | Startup refuses it; wider denylist |
| Found again in 3B.5.4's final review | A simulated "allow for this agent" approval could pre-authorise real Claude writes: fixed (mock approvals once-only when Claude is registered; every rule records the runtime that made it) |
| L2 event-loop blocking by parallel searches; L3 review does not show an overwrite; L4 audit rotation; Info I1–I6 | Recorded, not fixed (reasons in the review document) |

Every stage also had its own task reviews (Opus for the gate, permission and routing changes, Sonnet for plumbing), fix rounds, and a whole-branch review. Each real defect they found was fixed before merge (for example a process-crashing exception in the gateway proxy, a UI hint that rendered garbled, real work labelled "Simulated").

## 5. What was verified, and with what

| Evidence | What it shows | What it does not |
|---|---|---|
| 2,297 unit/e2e tests (fake SDK sessions, real server, real gate, real files) | Wiring, gate, approvals, digest binding, path swaps between approval and use, refused targets, scopes, redaction, limits | Model behaviour |
| 10 opt-in tests with the **real SDK binary** against a scripted API | Real SDK honours our options (no built-in tools in the model's list, `dontAsk` denies non-approved tools, the tool timeout works, a real tool call goes through the gate, a Bash call by the model runs nothing, cancel stops the child, no scratch folder left) | What Claude would actually do |
| Real SDK + dummy key through the provider | Startup check passes with our full option set; a real 401 maps to a fixed sentence | Real answers, real cost |
| Real browser checks (gateway; mixed runtimes) | Password gate, live updates over SSE, runtime choice, no "Simulated" on real work | |
| Three adversarial security reviews + task reviews | Above | A human penetration test |

## 6. Operating it

- **Enable Claude:** `RUNTIME=claude` (default runtime) or `ENABLE_CLAUDE_RUNTIME=yes` (next to the mock); `ANTHROPIC_API_KEY` on the server only; `WORKSPACE_ROOT` and `WORKSPACES` for the folders it may use.
- **Limits:** `CLAUDE_MAX_TURNS` (12), `CLAUDE_MAX_BUDGET_USD` (0.5 per task, the SDK's own estimate), `MAX_CONCURRENT_TASKS` (2, Claude only), `TASK_TIMEOUT_MS`, `APPROVAL_TIMEOUT_MS`.
- **Safety switches:** `ALLOW_BROAD_WRITE_SCOPES` (off), `VO_ALLOW_ROOT` (off), `VO_ALLOW_PUBLIC_CLAUDE` (off).
- **Public access:** `npm run start:public` with `VO_PASSWORD`; Claude is refused on a public address unless `VO_ALLOW_PUBLIC_CLAUDE=yes`.
- **A dedicated unprivileged OS user** is the decision (`docs/os-user-hardening.md`); the server refuses root and warns about credentials in the user's home.
- **Cost:** shown per finished task as an estimate; `server:start` needs `node_modules` (the SDK keeps its ~317 MB binary there).

## 7. Open items and limits

1. **The first real run** (yours): `scripts/claudeRealRun.ts`, `docs/first-real-run.md`. Until then cost, answer quality and behaviour under injected text are unobserved.
2. **No OS-level sandbox.** The child runs as the server user (same kernel, network allowed). A dedicated user reduces the blast radius; a bubblewrap wrapper via `spawnClaudeCodeProcess` was designed and not built.
3. **File contents the model reads go to Anthropic.** Redaction and the denylist limit what it can read and echo, but they are not a confidentiality boundary.
4. **"Independent" review means a separate model session,** not a human or outside firm.
5. **Rules from before workspace and runtime binding** apply everywhere; the server warns at start, it does not revoke them.
6. **Not fixed:** event-loop blocking by parallel searches (L2), the review does not show that a write overwrites a file (L3), audit rotation (L4), the project folder taken from the working directory, no queue over the Claude limit, no running spend total.
7. **The SDK licence and terms review** is still open.
8. **A person approving without reading defeats the main defence.** This is the real residual risk of letting an agent write.

## 8. Decisions that shaped the milestone

SDK in the backend process (the model loop is already a child), session per task, no resume; the gate is enforced in our tool handlers, not the SDK's callback; the child gets an empty scratch folder, never the workspace; fail closed on any surprise in the session's tool list; broad write scopes off by default because a list of "files tools run" can never be complete; Claude registered only by an explicit setting (never merely because a key exists); the public gateway keeps the backend loopback-only and refuses Claude by default.

## 9. Recommended next steps

1. Run the first real run with a capped key and send me the output.
2. Run the server as the dedicated user, keep `ALLOW_BROAD_WRITE_SCOPES` off, review the rules the start warning lists.
3. Decide on the licence review and, if the agent will touch workspaces that matter, a human security review.
4. Candidates after that: the OS-level sandbox wrapper, a running spend total, a queue over the Claude limit, and fixing L2/L3/L4.
