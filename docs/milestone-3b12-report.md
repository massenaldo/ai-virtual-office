# Milestone 3B.1.2 — Final Security Hardening: Final Report

**Brief:** [`milestone-3b12-plan.md`](milestones/milestone-3b12-plan.md) · **Tasks:** [`milestone-3b12-tasks.md`](milestones/milestone-3b12-tasks.md) · **Date:** 2026-10-31

> **The Claude Agent SDK is not installed or integrated, and no real agent execution exists.** The backend runs the mock runtime only. **Sandbox isolation is not implemented** (`docs/sandbox-architecture.md` is a design, and Docker is not installed on the machine this was built on). `docs/gated-tools.md` and `docs/browser-auth.md` are designs and decisions, not code. Every check below is a policy check on the host.

## 1. Verdict: READY WITH ISSUES

Each phase of the brief is built and tested, the whole milestone had an independent security review, and its High finding (a second URL's password slipping through redaction) is fixed with a test that failed first. It is READY WITH ISSUES because the work that must come before real execution is still open (section 10): gated Write/Edit tools and the sandbox, and a browser login that does not depend on the dev proxy.

The brief's `plan.md` was cut off mid-word at Phase 6. Phase 6 was read as the deferred findings in the 3B.1.1 report (digest visibility, the gap before `perform`, no abort signal) and the same scope limits were assumed (no SDK, no real execution, no sandbox claim).

## 2. Files changed

Stages and PRs: planning #32, stage 1 #33 (disclosure), 2 #34 (tool gate), 3 #35 (auth and proxy), 4 #36 (redaction), 5 #37 (write review), 6 #38 (reliability), 7 this PR.

- **New:** `server/errorCodes.ts`, `server/dataDirLock.ts`, `server/secret.ts`, `scripts/viteProxy.test.ts`, `src/workforce/ui/ApprovalReview.tsx`, tests for each, `server/http/disclosure.test.ts`, `server/http/inputs.test.ts`, `server/toolGate.integration.test.ts`, and the documents `docs/gated-tools.md`, `docs/browser-auth.md`, `docs/milestone-3b12-report.md`.
- **Modified:** `server/{store,audit,config,app,auth,taskManager,toolGate,toolPolicy,redact,workspaces}.ts`, `server/http/{routes,router,inputs,guards}.ts`, `server/runtime/{types,mockProvider,claudeAgent}.ts`, `scripts/{apiProxy,devFull,secretScan,checkSecrets}.ts`, `vite.config.ts`, `src/workforce/{types,operations,storage,view,controller,api,source}.ts`, `src/workforce/remote/{client,commands}.ts`, `src/workforce/ui/AgentDetail.tsx`, `src/styles.css`, `README.md`, `.env.example`.
- **Archived** under `docs/milestones/`: the 3B.1.1 plan and tasks, and this milestone's plan and tasks. Nothing was deleted.

## 3. Information disclosure (stage 1)

- Save and audit failures are codes from a closed list (`EACCES`, `ENOSPC`, …, `write_failed`). `GET /api/health` (open) returns the code only; `GET /api/state` returns a fixed sentence per code; the full message with the path goes only to the server log.
- A runtime start failure is "Runtime failed to start." in state (the real error is logged). The data, working and home folders are hidden as `<data-dir>`, `<cwd>`, `<home>` in runtime output.
- The router no longer logs a query string (it logged the full URL on a 500, which could have carried a token).
- `server/http/disclosure.test.ts` checks 15 open and error responses (health, preflight, 401, 404, 405, 421, 403, 415, 400, 413, 422, 409, a forced 500) for paths, the token and internals.

## 4. Tool gate and digest (stage 2)

- The pending approval carries the action digest (SHA-256 of task, workspace, tool and input). Deciding it must send the same digest or the answer is 409. The card shows the first 12 characters.
- `server/toolGate.integration.test.ts` runs the stale cases through the real task manager, store and workspace on disk: cancel right after approval, task timeout, agent removal, the approval timer; workspace renamed, replaced by a link, a parent turned into an outside link; the request mutated after `use()`, a second request while one is pending; another task's approval id, the same approval twice, an approval after the task ended. `perform` never runs for any of them. These passed on first run, so they are regression coverage.
- `docs/gated-tools.md` (design only): why the SDK's built-in Write and Edit are never used, the `vo_write` and `vo_edit` tools, the descriptor-based `perform` steps (`O_NOFOLLOW`, `nlink` check, same-directory temp file, `fsync`, `rename`, abort signal), error texts without host paths, SDK option changes, a 3B.2 checklist.

## 5. Authentication and proxy (stage 3)

- The dev gate classifies every URL: only the plain `/api/<x>` is forwarded with the token; any variant that reads as the API after case folding, decoding, slash collapsing or dot segments gets a 404 and no token. The proxy key is the regex `^/api/`.
- `scripts/viteProxy.test.ts` runs a real Vite server with the real gate and proxy in front of the real backend, with a real event stream through it (events, a heartbeat, a resume), the attacker-header cases, every URL variant, and no token in any response. It fails against the old proxy code.
- `data/server.lock`: one server per data folder. A second one refuses to start and leaves the first one's token alone; a stale lock is replaced. `Secret` and `ApiToken` print as `[REDACTED]` in every text form; `check:secrets` also flags the `api-token` file name outside the server bundle.
- `docs/browser-auth.md` records the decision: a session cookie after a one-time pairing, before anything leaves this machine, **not built**. It states that `Sec-Fetch-Site` is not authentication against other local programs: while the dev proxy runs, the token protects against web pages and programs talking to the backend directly, not against other local programs on the machine.

## 6. Redaction (stage 4)

JWTs (a linear scan, not a pattern), Slack `xox…` and `xapp-…` tokens, Google `AIza…` keys, PEM private key blocks (also an unterminated or cut block), `mysql -pSECRET` and `sshpass -p`, and URL passwords containing `@` or `/` including several credential URLs in one text (`{"a":"…","b":"postgres://u:p@host"}`). Negative cases keep `ssh -p 22`, `mkdir -p`, `docker run -p`, `find -print`, `host:8080/a/@scope`, `/@vite/client`, `ssh://git@host`, certificates and public keys. Hostile 100 kB inputs stay under 50 ms; a 1 MB `eyJ-` run stays fast. The Slack and Google samples in the tests are built from pieces at run time because GitHub push protection blocked literal samples; the tests were fixed rather than the protection bypassed.

## 7. Large Write/Edit review (stage 5)

A Write or Edit approval carries a `review`: the exact content or change (up to 32 KiB), the relative path, the workspace, size and line count, and the same digest as the approval. It is persisted only with the pending approval and validated on load. Refused as not reviewable, instead of approved: too big, control characters, invisible or reordering characters (bidi, zero-width, line and paragraph separators, byte order mark, soft hyphen, tag characters, variation selectors, Hangul fillers, lone surrogates; this also refuses emoji joined with a zero-width joiner), a secret, the workspace path, or a target path too long for the summary line. The same invisible-character refusal applies to every other approval summary. The UI pane shows every line, numbered, with tabs, trailing spaces and carriage returns marked, rendered as text. Approve is disabled until the pane has been opened; **that is a nudge in the page, not a server rule** (the server only requires the right digest). In a browser check with a gated task, the pane showed the workspace, file, size and digest, Approve was disabled until it was opened, and Deny worked; the workspace stayed empty.

## 8. Reliability (stage 6)

- A file with more than one name (a possible hard link to a file outside the workspace) is refused for Read, Write and Edit; a link made after approval is caught at use time. `GatedAction` carries the task `signal` and the checked relative `paths`, and the gate refuses as cancelled if the signal aborted before `perform`.
- The suppressed-count audit record is written before the first record of any kind in a new window and when the audit log closes. The end-to-end test now checks the audit log, the digest and the review in the event patch.

## 9. Checks and review outcome (2026-10-31)

- `npm test`: 979 tests pass (70 files; the baseline was 822 in 63). `npx tsc -b`: clean. `npm run build` and `npm run server:build`: pass (the 500 kB chunk warning remains). `npm run check:secrets`: no secrets (12 files). `npm audit`: 0 vulnerabilities. `dist/` contains no token and no `api-token`.
- Built bundle smoke test: health has no path; state 401 without the token and 200 with it; a second instance on the same data folder is refused and the first one's token still works; the lock file is mode 600; the token is not in the log; the lock is removed on stop.
- Browser, backend mode: a plain task shows the unchanged approval card and approves; a gated task shows the review pane with Approve disabled until opened, and Deny ends it Failed ("Approval denied (simulated)"); cancel works; after a server restart with a task running the task shows "Interrupted by a server restart", the token rotated (the old one gets 401) and there were no duplicate entries. This time the page had already reconnected when I looked, so I did not observe the Offline pill (it was observed in earlier stages). Browser, `/vo` mock mode: the 3D office, editor and floor plan open, a mock task goes through approval, no review pane, no `/api` calls, console clean.
- **Independent review (Opus, whole milestone):** no Critical. Fixed with tests that failed first: **High** a second URL's password was missed when several URLs share one token with no spaces; **Medium** the lock could be held by two servers (empty lock read as stale, and two takeovers racing), now created atomically with a takeover mutex; invisible and reordering characters beyond bidi were not refused (U+2028/2029 end a line in JavaScript, zero-width, BOM, tags, variation selectors, lone surrogates), now refused in reviews and in every approval summary, and every carriage return is marked; the JWT pattern was quadratic on hostile input (104 ms at 32 KB, 3.6 s at 1 MB), now a linear scan.
- **Ruled on, not fixed:** (M3) the approval summary has the workspace, data, working and home folders replaced by labels after the reviewability check (`rm -rf <cwd>-old` reads like a path inside the project, and a command that literally contains `<workspace>` is ambiguous). Refusing every summary that contains the home or working folder would refuse most real commands, so the replacement stays; the audit log and the path-hiding in runtime output share it. Cost if wrong: a reviewer can misread a path that starts with a hidden folder's text.
- The two documentation overstatements the review found (README on the review's coverage and on the "open first" rule) were corrected.

## 10. Remaining blockers before Milestone 3B.2, and deferred findings

**Must be done before any real execution:**
1. Build the gated in-process Write/Edit tools and move Read, Glob and Grep behind the same pattern (`docs/gated-tools.md`), then the sandbox (`docs/sandbox-architecture.md`), starting with how the server may reach Docker without breaking the no-process-execution guard.
2. A browser login that does not depend on the dev proxy: the session cookie after pairing (`docs/browser-auth.md`), before anything leaves this machine. Until then any local program that can reach port 5173 gets an authenticated path.
3. Decide whether "Approve after opening the pane" should become a server rule (for example a short-lived read receipt bound to the digest).

**Deferred findings (Low, from the review and earlier):**
- A deny without the approval's digest gets the misleading "no longer pending" message instead of a clearer one.
- The review's workspace-path check uses the workspace's real path only (not the configured spelling, the data folder or the home folder), and the audit log's `tool.asked` detail keeps the raw summary with home and data-folder paths (a local file only).
- `mysql -p123456` (digits) is kept because `-p` followed by digits is read as a port; `-p"two words"` redacts only the first word; PGP private key blocks are not recognised.
- Reviews of up to 32 KB sit outside the message and output budgets (bounded, one pending approval per task); `parseReview` does not re-check characters or that the path is relative.
- `GET /api/health` is open and fingerprints version, runtime and state of credentials (no paths or messages).
- Tests: the open-response disclosure test does not cover authenticated state with a review or a failed launch; the proxy variant test checks status and absence of auth rejections but not the gate's own 404 body; the viteProxy test reads a developer's `.env`; the "another task's approval id" case passes on the id mismatch alone.
- A hard-link check cannot see filesystems that always report one link; a window remains between the last check and `perform` until the descriptor-based file operations exist.
- Stage D deferred minors from 3B.1 that are still open (`docs/milestone-3b1-report.md`).
