# Milestone 3B.5 — the three prerequisites for real writes: status

Date: 2026-11-03. Branch `chore/3b5-prerequisites`, based on `main` at `1fb866f` (#64). The 3B.5.3 report and the planning document (§13) named three things to do before the Claude agent writes on a workspace that matters.

| # | Prerequisite | Status |
|---|---|---|
| 1 | A first run with a real key and a small budget | **Prepared, not done.** I have no API key, so a person must run it: `scripts/claudeRealRun.ts` and `docs/first-real-run.md` |
| 2 | An independent security review | **Done, and acted on.** Two independent adversarial reviews by a fresh Opus reviewer with no hand in the code; every finding was fixed or recorded; a second review of the fixes; see below |
| 3 | The dedicated-OS-user decision | **Decided and enforced where it can be.** `docs/os-user-hardening.md`; the server now refuses the worst setups and warns about the rest |

**What "independent" means here:** the reviewer is a separate model session with no part in writing the code and a brief to attack it. It is not a human or an outside firm. Treat it as strong evidence, not as a substitute for a person who is paid to find holes.

## 1. First real run (you run it)

Nothing has yet been seen with a real model: not its answers, not its behaviour with the tools, not the cost. Run `ANTHROPIC_API_KEY=... npx tsx scripts/claudeRealRun.ts --injection --budget 0.10` (add `--write` to be shown and approve a write yourself). It works in a temporary folder, spends at most the cap per task, and prints PASS/FAIL for: an answer was produced, no foreign tool was requested, the startup check passed, a file was read through the gate, the spend stayed within the cap, the key is in no log or state, the scratch folder was removed, an injected instruction did not write anything (and whether the model **tried**), and a write happened only as approved. A dry run with a dummy key confirmed the script's own mechanics (it starts a real session, reports the sign-in failure, cleans up, never prints the key). Read `docs/first-real-run.md` first and set a spending limit on the key in the Anthropic console.

## 2. The security review

The first review (`docs/security-review-3b5.md`) read the code adversarially and found **no way for the model to write outside the workspace, change the bytes of a once-approved write, skip approval or the startup check, or make the child run code**. It found:

| Finding | What | Outcome |
|---|---|---|
| **H1 (High)** | "Allow for this task/agent" gave unreviewed writes to every path, including files that tools run later (`package.json` scripts, git hooks, `.claude/settings.json`, CI files), across workspaces, and queued requests were allowed by a newly granted rule | Fixed (below) |
| **M1** | Private-key redaction was bypassed by Read `offset` and Grep content mode | Fixed: whole-file redaction before slicing and searching; PGP and PuTTY keys too |
| **M2** | Unicode case folding (`ſ`) got past the sensitive-name list on case-insensitive file systems | Fixed: one `foldName` used everywhere names are compared |
| **M3** | A workspace could be `$HOME`, the server's own repo, or overlap another; the name list was narrow | Fixed: startup refuses those layouts (claude runtime); list widened |
| **L1** | Unknown secret formats; Grep as a content oracle | Fixed: more formats, grep matches the redacted text only |
| L2, L3, L4, I1-I6 | Event-loop blocking by parallel searches; review does not show an overwrite; audit rotation; informational | Recorded, not fixed (reasons in the review document) |

**How H1 was closed** (four reinforcing changes, each reviewed): (a) files that tools run on their own can only be approved **once**, enforced on the server at ask time and again at use time, and shown that way in the UI. This covers every hidden path segment, `node_modules`, lock files, build, CI, container and editor files, scripts, config files and any file with an execute bit; (b) task and agent permissions made from an approval are **bound to the workspace** they were made in; (c) requests already waiting in the queue are **asked again** instead of being allowed by the rule just granted; (d) because a list of "files tools run" can never be complete, **broad write approvals are off by default** for the Claude runtime: every write or edit needs its own approval unless the owner sets `ALLOW_BROAD_WRITE_SCOPES=yes`.

A second whole-set review of the fixes confirmed M2 and L1 closed and M1, M3 closed with small gaps; it found H1 only partly closed (the file list had large gaps), which produced (d) and a wider list, and it triaged the deferred items. A third, scoped review verified that fix wave: **all items addressed, no new Critical or Important finding**.

Process: one SDD ledger, four tasks plus one fix wave, each with an implementer, a review and, where needed, a fix round; 2155 tests at the end (from 1880 at the start of the branch's work).

## 3. The OS user

Decision and commands: `docs/os-user-hardening.md`. The independent reviewer's assessment: a dedicated user helps only if the **whole server** runs as that user (the file operations run in the server process, not in the Claude child), and it turns any path-check bug from "home and credential disclosure" into "workspace-only"; it does **not** reduce H1, which is about what a person approves. Enforced now (`server/hostSafety.ts`, at every entry point, claude runtime only): refuses root (override `VO_ALLOW_ROOT=yes`), a workspace that contains the project, the user's home, another workspace, or the workspace root itself; warns about a data folder readable by others and credentials in the server user's home (the machine this was built on has `~/.ssh`, and the server said so).

## What is safe to do now, and what is not

- **Reasonable:** writes with approval one at a time (the default), on a workspace that is a plain project folder, run by a dedicated user, after the first real run, with a person reading each approval in full.
- **Not recommended:** `ALLOW_BROAD_WRITE_SCOPES=yes`. The list of files that tools run later is long and will always have gaps; with it on, one approval lets the agent write many things you did not see.
- **Still true:** there is no sandbox (same kernel, network allowed), file contents the model reads are sent to Anthropic, an approver who clicks through without reading defeats the main defence, and the SDK licence and terms review is still open.

## Not fixed, for the record

L2 (a hostile model can stall the server for minutes with parallel searches), L3 (the review does not say that a write overwrites an existing file; exec-bit files are now once-only), L4 (audit rotation can flush old records), the Info items in the review, the project folder being taken from the working directory, the `*rc` rule over-blocking names like `arc` (safe side).
