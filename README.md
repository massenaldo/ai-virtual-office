# AI Virtual Office — v0.1.0

A self-hosted, browser-based 3D office prototype built with React, TypeScript, Vite, Three.js, React Three Fiber, and Drei.

## Requirements

- Node.js 22.12 or newer (CI runs 22 and 24)
- npm

## Run locally

```bash
npm install
npm run dev:full
```

Open http://localhost:5173.

`dev:full` runs the backend and the app together on the mock runtime, with no API key and no cost. Agents and the office layout are saved on the server (`data/workforce.json`, `data/layout.json`), so every address shows the same office, and it keeps running until you stop it with Ctrl+C. The first time you open it, a layout already saved in your browser is copied to the server once.

### All the ways to run it

| Command | What it starts |
|---|---|
| `npm run dev` | Frontend only, a browser-only demo with no server: agents are saved in the browser, not on the server |
| `npm run server` | The backend alone, on `127.0.0.1:8787` |
| `npm run dev:full` | The backend and the frontend, with the UI reaching it through the same-origin dev proxy (no setup, no token to copy) |
| `npm run server:build` then `npm run server:start` | The production backend bundle (`dist-server/index.js`, only `node:` imports) |

To use the backend with a separately started frontend, run `npm run server`, then `VITE_WORKFORCE_API_URL=/ npm run dev`. The value `/` means "this page's own origin": the Vite dev server adds the API token on the server side and forwards `/api/*` to the backend (see "API token" below). An invalid value shows "Not configured" instead of falling back to the browser mock, and a direct `http://127.0.0.1:8787` works too once you pair (below).

**Pairing (no proxy).** Start the backend (`npm run server`), then the frontend with `VITE_WORKFORCE_API_URL=http://127.0.0.1:8787 npm run dev` and open the app at the same host name as the backend: with `http://127.0.0.1:8787` only `http://127.0.0.1:5173` works (`http://localhost:5173` can pair but the browser will not keep the session, and the form says so); use the same host name for both. The AI agents panel asks for the API token: paste the contents of `data/api-token` (or your `API_TOKEN`). The server answers with an HttpOnly session cookie, valid 8 hours; the page never keeps the token. Sessions are lost on a backend restart, and the pairing form returns after one. The proxy flow (`dev:full`, or `VITE_WORKFORCE_API_URL=/`) is unchanged and never asks. Details: `docs/browser-auth.md`.

## Open it from a browser (InstaBox)

`npm run start:public` starts the backend and a small password gateway in one process. The gateway serves the built app and forwards `/api/*` (including the live event stream) to the backend, so the whole app is reachable through one address.

1. Build once: `npm run build:public`. It builds the app to call the same-origin `/api` (`VITE_WORKFORCE_API_URL=/`), and writes `dist/`.
2. Choose a password of at least 12 characters, for example `openssl rand -base64 24`. Put it in a file, not on the command line (a command line lands in your shell history): add the line `VO_PASSWORD=<the password>` to `.env` in the project root (it is gitignored), then run `chmod 600 .env`.
3. Run it inside tmux, so it keeps running when you close the terminal:
   ```bash
   tmux new -s vo
   npm run start:public
   ```
   Detach with Ctrl-b d. Come back with `tmux attach -t vo`. Instead of `.env`, you can type the password without echo inside tmux first: `read -rs VO_PASSWORD && export VO_PASSWORD`, then `npm run start:public`.
4. In the InstaBox dashboard, publish port 3000. Open only the HTTPS address InstaBox gives you for that port; the gateway itself speaks plain HTTP, so never send the password over an `http://` address.
5. The browser shows a username and password prompt. Type any username and the password.

| Variable | Default | Meaning |
|---|---|---|
| `VO_PASSWORD` | none, required | The password. At least 12 characters. Read from the environment (or `.env`) only; never printed or logged |
| `PUBLIC_PORT` | `3000` | Port the gateway listens on. If you change it, publish that port instead |
| `PUBLIC_HOST` | `0.0.0.0` | Address the gateway listens on |
| `VO_ALLOW_PUBLIC_CLAUDE` | unset | `yes` allows `RUNTIME=claude` or `ENABLE_CLAUDE_RUNTIME=yes` on the public address (see below) |
| `WORKSPACE_ROOT`, `WORKSPACES`, `DATA_DIR` | as in "Backend" | Passed to the backend, which still reads them as before |

The backend keeps listening on `127.0.0.1:8787` (`HOST`/`PORT`); only the gateway listens on `PUBLIC_HOST:PUBLIC_PORT`. The gateway adds the API token on the server side, so the token never reaches the browser.

**What it protects.** Every request needs the password, including the app files, `/api/health` and the event stream. The comparison is constant-time. Live updates use server-sent events through the same URL, so nothing else needs to be published. `/api/*` requests are only forwarded when the browser marks them same-origin.

**What it does not.** There is one shared password and no per-user accounts or roles: anyone who has it can do everything the app can. Wrong passwords are throttled globally, not per visitor (8 wrong guesses lock everyone out for 5 minutes; requests with no password at all are not counted). So an attacker who keeps sending wrong passwords can keep the owner locked out for as long as they keep it up: every 5 minutes it unlocks, and a few more wrong guesses lock it again. Restarting resets the counter but does not help while they continue. The only fix is to stop the attacker, for example by unpublishing the port in the InstaBox dashboard. Basic auth has no log-out: on a shared computer use a private window. HTTPS comes from InstaBox; do not expose the gateway's port by other means.

**`RUNTIME=claude` and `ENABLE_CLAUDE_RUNTIME=yes` are refused on the public address by default.** The entry script exits with an error. A public page would mean real model spend and file writes reachable from the internet, while the security prerequisites in `docs/milestone-3b5-prerequisites.md` (a real-key run, an independent review, the OS-user decision) are still open. Set `VO_ALLOW_PUBLIC_CLAUDE=yes` only once they are met.

## Features

- **Realistic 3D office**, all built in code with no downloaded models or textures:
  - Soft daylight and interior fill lighting generated in the browser (no HDR download), with soft shadows
  - Floor finishes by department: polished concrete in open areas, carpet tiles in team rooms, light oak in the meeting room and executive office, dark epoxy in the server room
  - Cutaway rooms (no ceilings, open front) with warm-white walls, graphite baseboards, and slim-framed glass partitions
  - Oak desks on graphite frames with keyboard and mouse, ergonomic chairs, slim monitors, a walnut meeting table with meeting chairs, storage cabinets, shelves, and leafy plants in two sizes
  - A few restrained wall details: framed art in the executive office, a whiteboard in the meeting room
- The office stands on one storey of a tower: a warm-concrete floor slab with a visible edge
- Team labels that stay readable in 3D and floor plan
- Orbit, zoom, and pan camera controls; a true top-down floor plan (orthographic, pan and zoom only)
- **Layout editor** (click **Edit layout**):
  - Select rooms and furniture in the scene or in the left-hand list; edit them in the properties panel
  - Drag rooms and furniture on the floor; resize rooms with edge handles in floor plan
  - Grid with snap-to-grid (0.25 m) in floor plan
  - Add rooms from templates and furniture from the palette; rotate (90°), duplicate, delete
  - Rotate a room in 90° steps: its walls, glass, details and furniture turn with it around the room's centre
  - Overlapping or out-of-bounds placement is outlined in red and listed in the properties panel (a warning, not a block)
  - Undo/redo (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z), Delete/Backspace, and Esc to clear the selection or cancel a drag
- **Saving:** the complete layout (rooms, furniture, office settings) is restored on the next start. With `npm run dev:full` it is saved on the server in `data/layout.json`; in the browser-only demo (`npm run dev`) it is stored in the browser's `localStorage` under `ai-virtual-office:layout:v1`. If the server can't be reached, the layout is shown read-only until it reconnects. The status shows Saved, Unsaved changes, or Save failed. You're asked before leaving edit mode or closing the tab with unsaved changes
- **AI agent workforce** (click **AI Agents** in the sidebar). **Tasks are simulated in the browser: nothing calls Claude or any other AI, makes network requests or runs processes.** The panel shows a **Mock mode** badge, demo agents are labelled **Demo**, and simulated task events are labelled **Simulated**.
  - Six demo agents (Project Management, Tech Lead, Backend, Frontend, QA, DevOps) seated at default desks, added once on first start; **Restore demo agents** brings back any you removed
  - Filter agents by department and status; create, edit and remove agents (removing one with task history asks first)
  - Assign one agent per desk from a picker grouped by room, or unassign
  - Start a simulated task: the agent goes Thinking, then Working, then back to Idle when the task completes (about 6 seconds), with an activity timeline. **Cancel task**, and demo buttons for **Simulate waiting** / **Resume** / **Simulate error**
  - In the office: a status marker over each assigned desk (3D and floor plan); the selected agent's desk is outlined and **Focus desk** moves the camera to it; with the panel open, click a desk to open its agent, or click a free desk to assign one
  - Layout editing and the agents panel are separate modes; opening the panel with unsaved layout changes asks you to save or discard first
- Local-only development server bound to 127.0.0.1

## Backend (milestone 3B.1)

A small Node server (`server/`, no framework; the only runtime dependencies are the Claude Agent SDK and `zod`, both used by `RUNTIME=claude`) owns agents, tasks and activity, runs tasks through a runtime provider, and pushes updates to the browser. **The default runtime is the mock.** `RUNTIME=claude` (milestone 3B.5.2) runs a task on the Claude Agent SDK. The agent can answer in text and use **five tools** in the workspace you pick: `vo_read`, `vo_glob` and `vo_grep` to read, and `vo_write` and `vo_edit` to change a file. It cannot run anything. Every tool call goes through the server's own permission rules and approval flow, never the SDK's: reads are allowed by default, **every write or edit waits for a person who sees the whole content and approves exactly that change**, and everything shown is redacted and capped. **Writes are approved one at a time**: "this task" and "this agent" are refused for Write and Edit unless the owner sets `ALLOW_BROAD_WRITE_SCOPES=yes`. The server enforces this; the page only shows it. With the flag on, an approval can cover a task or an agent in one workspace, but a file that tools run on their own (for example `package.json`, scripts, hidden files and folders, `node_modules`) is still approved once. Risk when it is on: a list of such files can never be complete, so a broad approval given for a harmless file can let later writes plant code that runs the next time you use your normal tools. At most `MAX_CONCURRENT_TASKS` (default 2) Claude tasks run at once. It needs `ANTHROPIC_API_KEY` on the server, and the SDK's bundled Claude Code binary (about 320 MB in `node_modules`, so `npm run server:start` needs `node_modules` next to `dist-server`). The agent runs as a child process of the server with the server's privileges: **there is no sandbox**. See `docs/milestone-3b5-1-report.md`, `docs/milestone-3b5-2-report.md` and `docs/milestone-3b5-3-report.md`.

**Mock and Claude side by side.** `ENABLE_CLAUDE_RUNTIME=yes` registers the Claude runtime next to the default one; `RUNTIME` stays the default (`mock` unless you set it). The task form then shows a **Runtime** choice, and each task runs on the runtime it was started with. `RUNTIME=claude` also registers the mock, so the Runtime select appears there too (with Claude as the default). Claude needs the same setup as `RUNTIME=claude` (`ANTHROPIC_API_KEY`, the SDK, a workspace), and the server still refuses a task that names a runtime that is not available. Like `RUNTIME=claude`, `ENABLE_CLAUDE_RUNTIME=yes` is refused on a public address unless `VO_ALLOW_PUBLIC_CLAUDE=yes`. The demo controls (simulate approval, simulate error) are shown only when the default runtime is the mock, because the demo routes exist only then. The cost on a finished Claude task's card is the SDK's own estimate, not a bill.

**Architecture.** The browser's `WorkforceController` has two implementations behind `useWorkforce`: the local one (browser mock) and `RemoteWorkforceController` (REST for commands, server-sent events for updates, snapshot plus replay recovery, reconnect with backoff). The domain model in `src/workforce/` is shared by both sides.

**Environment variables** (copy `.env.example` to `.env`; real environment variables win):

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Where it listens. Loopback only |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Exact browser origins allowed; `none` allows no browser |
| `DATA_DIR` | `./data` | Where `workforce.json` and `audit.log` live |
| `WORKSPACE_ROOT`, `WORKSPACES` | unset | Absolute folder and named workspaces (`id:relative/path`) |
| `RUNTIME` | `mock` | `mock` or `claude` (the Claude Agent SDK with five gated workspace tools, needs `ANTHROPIC_API_KEY`) |
| `TASK_TIMEOUT_MS`, `CANCEL_GRACE_MS`, `APPROVAL_TIMEOUT_MS` | 600000, 5000, 300000 | Task, cancel and approval limits |
| `ALLOWED_TOOLS` | `Read,Glob,Grep,Write,Edit` | Tool allowlist; write, execute and network tools always need approval |
| `MAX_MESSAGE_BYTES`, `MAX_TASK_OUTPUT_BYTES`, `EVENT_BUFFER_SIZE`, `AUDIT_LOG_MAX_BYTES` | 32768, 262144, 500, 5242880 | Output and log limits |
| `ENABLE_CLAUDE_RUNTIME` | no | Only the exact value `yes` registers the Claude runtime next to the mock, chosen per task, while `RUNTIME` stays the default. Needs the same setup as `RUNTIME=claude`; refused on a public address unless `VO_ALLOW_PUBLIC_CLAUDE=yes` |
| `OFFICE_ROUTINE` | `on` | `on` or `off`. `off` keeps every agent at its desk all day. Anything else is a config error |
| `VO_DEV_CLOCK` | unset | Development only: the office clock starts at a time and runs faster, like `2026-11-09T11:40:00+07:00@60` (offset required, speed 1 to 3600). Refused when the Claude runtime is enabled, either way. It changes only the time `/api/state` reports to the browser; tasks, audit, sessions and timeouts keep real time |
| `ANTHROPIC_API_KEY` | unset | Server only, for the Claude runtime (`RUNTIME=claude` or `ENABLE_CLAUDE_RUNTIME=yes`). Held in a wrapper that cannot print; never in a log, event or response; never a frontend variable |
| `ALLOW_BROAD_WRITE_SCOPES` | no | Only the exact value `yes` lets a person approve Write and Edit for a whole task or agent (Claude tasks, on any server where Claude is enabled). Off: every write is approved one at a time, and so is a simulated write approval on a server where Claude is enabled (so a demo approval can never pre-authorise real writes). On: a broad approval can later write files that tools run on their own, such as ones the next `npm test` or editor loads; known cases still need a fresh approval, but the list is not complete |
| `MAX_CONCURRENT_TASKS` | 2 | Most Claude tasks running at once (1 to 32); more are refused with a message. Not applied to the mock |
| `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS`, `CLAUDE_MAX_BUDGET_USD` | Claude Code default, 12, 0.5 | The default model (an agent's own model wins), most model steps and most spend (US dollars, the SDK's own estimate) per task |
| `API_TOKEN` | generated at each start | Token every API request must send as `Authorization: Bearer <token>`. At least 32 characters, no spaces. Server only: never a `VITE_` variable (refused at start) |
| `VITE_WORKFORCE_API_URL` | empty | Frontend only. Empty = browser mock; `/` = same-origin backend through the dev proxy |

**API** (JSON; every route except `GET /api/health` needs `Authorization: Bearer <token>`; every POST/PUT/PATCH/DELETE needs `Content-Type: application/json`, even without a body):

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Runtime, availability, and persistence and audit status as codes (`EACCES`, `ENOSPC`, `write_failed`, …), never messages or paths. The only route that needs no token |
| `GET /api/state` | Full state and `lastEventId` |
| `GET /api/workspaces` | Workspace ids (never paths) |
| `GET /api/events` | Server-sent events; resume with `Last-Event-ID` or `?lastEventId=` |
| `POST /api/agents`, `PATCH` / `DELETE /api/agents/:id` | Create, update, remove an agent |
| `POST /api/agents/:id/clear-error` | Return an agent in `error` with no active task to idle |
| `PUT /api/agents/:id/desk` | Assign or clear a desk |
| `POST /api/agents/:id/tasks` | Start a task (`title`, `description`, optional `workspaceId` and `runtime`) |
| `POST /api/tasks/:id/cancel`, `POST /api/tasks/:id/approval` | Cancel; approve or deny (`approvalId`, `decision`, and the pending approval's `digest` when it has one, or the answer is 409) |
| `POST /api/demo/...` | Mock-only demo controls: request approval, force error, restore demo agents |

**Events.** Ids are `<boot>:<seq>`. Types: `task.queued`, `task.started`, `agent.status_changed`, `agent.message`, `task.progress`, `task.waiting_for_approval`, `task.completed`, `task.failed`, `task.cancelled`, `state.changed`, `state.reset`. Each change event carries a patch of the records it touched. `state.reset` means the client's id is too old, from another server run, or ahead of the server: reload `GET /api/state`.

**Gated file tools.** `server/tools/gatedTools.ts` provides in-process handlers `vo_read`, `vo_glob`, `vo_grep` (fixed-string search only), `vo_write` and `vo_edit` on top of `server/fileOps.ts`, with a sensitive-path denylist (`.env*`, keys, `.git`, `.ssh` and similar) applied in the policy and while listing. They are reachable only through the tool gate and are covered by tests with a fake provider. They are not connected to anything real: there is no SDK, the runtime is the mock only, and nothing on the mock path writes files. See `docs/gated-tools.md` and `docs/milestone-3b4-stage-e-report.md`.

**Security boundaries.** These are policy checks, not an OS sandbox.
- Bound to loopback; `Host` and `Origin` allowlists (421 / 403); JSON-only mutations (415); CORS only for allowed origins; security headers.
- API token: every route except health, including the event stream and requests with no `Origin`, needs the bearer token (401 otherwise). Compared in constant time; never accepted in a URL; never logged, audited, returned or compiled into the bundle (`check:secrets` looks for it).
- Workspaces are named by id; the browser never sends a path. Paths are checked against the workspace real path (symlinks resolved, `..` refused, a path through a regular file refused) and the root stored at startup. Write and Edit always need a workspace; without one the mock demo falls back to the simulated run's own approval.
- Tool gate: a runtime can only use a tool through `ctx.tools.use(request, perform)`. The input is a frozen copy, the approval is for that copy, and a digest of task, workspace, tool and input plus the path and workspace are re-checked right before `perform` runs (otherwise `stale_approval`, audited as `tool.stale`). A Write or Edit approval carries a review: the exact content or change (up to 32 KiB), the workspace, the file and the action digest, shown in a pane with numbered lines and visible tabs, trailing spaces and carriage returns. Anything that cannot be shown whole is refused instead of approved: too big, control characters, invisible or reordering characters (bidi, zero-width, line and paragraph separators, byte order mark, tag characters, variation selectors, lone surrogates; this also refuses emoji joined with a zero-width joiner), a secret, or the workspace path. The same invisible-character refusal applies to every other approval summary. "Approve stays disabled until the pane is opened" is a nudge in the page, not something the server enforces: the server only requires the right digest. Only the mock may raise an approval of its own.
- Tool policy: unknown tools denied; read tools allowed inside a workspace; write, execute and network tools always need a human approval whose summary shows the whole action (otherwise denied); no bypass mode.
- Secrets are redacted from logs, state, events and the audit log (API keys, Bearer and Basic credentials, URL passwords, GitHub, AWS, Slack, Google and JWT tokens, private key blocks, `--password`-style arguments, `curl -u`, `mysql -pSECRET`, `sshpass -p`); workspace paths are hidden in runtime output; `npm run check:secrets` scans the built bundles.
- `data/audit.log` (JSONL, mode 0600, rotated at 5 MB) records lifecycle, tool and rejected-request events, never bodies.

**API token.** Set `API_TOKEN` (32+ characters) or let the server generate a fresh 256-bit token at each start, written to `data/api-token` (mode 0600, git-ignored with `data/`). The audit log records only `auth=configured` or `auth=generated`.
- *Browser:* the dev proxy (`scripts/apiProxy.ts`) runs in Node. For requests the browser marks `Sec-Fetch-Site: same-origin` it replaces any `Authorization` and `Cookie` header with the token and forwards `/api/*`; everything else gets 403. It reads the token on every request, so a backend restart is picked up. It only exists where Vite runs (`dev:full`, `dev` with `VITE_WORKFORCE_API_URL=/`), and any local program that can reach port 5173 can send `Sec-Fetch-Site: same-origin` itself (the header is only trustworthy for browsers) and gets an authenticated path. So while the proxy runs, the token protects the backend from programs that talk to it directly and from web pages, not from other local programs on this machine. The session cookie after a one-time pairing (see "Pairing (no proxy)" above, `server/session.ts`) is the way out of that: it is built, but the proxy flow remains as described. The Vite dev server also refuses to serve the `data/` folder (token, audit log, state). `vite preview` and a VPS need the backend to serve the UI, or the pairing flow, over TLS (the cookie has no `Secure` flag until TLS exists; see `docs/browser-auth.md`).
- *One server per `DATA_DIR`:* the server takes `data/server.lock` and a second server on the same folder refuses to start (a lock left by a crashed process is replaced). The token is wrapped so it cannot be printed.
- *Long term:* [`docs/browser-auth.md`](docs/browser-auth.md) records the decision (session cookie after a one-time pairing, built in stage D) and states that `Sec-Fetch-Site` is not authentication against other local programs.
- *Rotation:* restart the server (generated), or change `API_TOKEN` and restart. A configured token is never written to disk.
- *Other clients:* `curl -H "Authorization: Bearer $(cat data/api-token)" http://127.0.0.1:8787/api/state`.
- `npm run dev` stays browser-only and needs no token.

**Sandbox.** There is none yet: [`docs/sandbox-architecture.md`](docs/sandbox-architecture.md) is a design only (Docker, one workspace mounted, no network, resource limits) with its blockers. No isolation is active.

**Persistence.** `data/workforce.json` and `data/layout.json` (atomic writes, mode 0600; `data/` is ignored by git, so back it up separately). A damaged or newer `layout.json` is copied to `layout.backup.json` (then `.1`, `.2`, ...) and the default layout is shown until the next save. An unreadable file is backed up before a fresh start. When an older schema is migrated, `workforce.v2-backup.json` keeps an untouched copy of the data from before the migration. A task running at shutdown is marked failed with "Interrupted by a server restart". The event buffer is in memory, so a restart makes every old event id a `state.reset`.

## Import agents from role files

You can create agents from Claude-style role files (`.claude/agents/*.md`). Importing needs the server (`npm run dev:full`) and at least one workspace.

1. Set a workspace in `.env` (copy `.env.example` first) and restart the server. `WORKSPACE_ROOT` is an absolute folder and each `WORKSPACES` entry is `id:relative/path` under it:

   ```
   WORKSPACE_ROOT=/Users/me/projects
   WORKSPACES=sandbox:my-project
   ```

2. Put the role files inside that workspace, in `.claude/agents/`, for example `/Users/me/projects/my-project/.claude/agents/backend-engineer.md`.
3. In the AI agents panel choose **Import agents**, check the preview, pick a **department** (there is no default) and press **Import**.

**What is read.** The file's `name`, `description`, `model` and the text after the front matter (the instructions). **Everything else is ignored and listed** as "Ignored: ..." in the preview, including `tools` and `permissionMode`: a file grants no tools or permissions, and the agent's permissions stay where they are. A file can not grant tools and can not restrict them either: `tools: Read, Grep` still leaves an agent that can ask for Write, which needs approval. Text that looks like a secret was replaced with [REDACTED] in the preview and the stored text, so check it before importing (masking can also hit ordinary text such as "Secrets: never commit them"). An over-long description is cut (the preview says so). The preview shows the instructions as plain text. Files are never executed. A file with an invisible or reordering character is refused, naming the line and code point; ordinary emoji are fine.

**Workspace limits.** The workspace folder must already exist. A workspace that contains the folder `DATA_DIR` points to stops the server at start, and the default `DATA_DIR` is inside this repo, so by default that includes the repo and any folder above it. With the Claude runtime on, a workspace that contains this repo, or your home folder, is also refused, so `~/.claude/agents` can not be imported directly: copy those files into a project folder. A `.claude/agents` folder that is a link, or not a real folder, is not read.

**Re-import.** The file's row on the Import screen shows **Re-import** (with the fields that would change) once an agent was imported from it. It updates only description, model and instructions; it never changes the name, role, department or desk you set. If the file changed after you looked at it, nothing is imported and the list is read again.

## Layout data

The scene renders a typed, versioned `OfficeLayout` (`src/layout/types.ts`). It is the single source of truth.

- World units are metres. A room or furniture item's `x`/`z` is the **centre of its footprint** on the floor plane; `width` runs along X and `depth` along Z. Vertical values (`wallHeight`, model heights) are kept separate.
- Rooms are 2–12 m wide and 2–12 m deep and stay inside the 25 × 20 m office.
- Saved data that can't be read (damaged, or from a newer version) is never overwritten silently: the app shows the default layout and copies the old value to a backup before the next save (`ai-virtual-office:layout:v1:backup` in the browser, `data/layout.backup.json` on the server).
- **Reset layout** restores the default office after a confirmation and can be undone.
- **Break areas:** the default office has a kitchen, a dining area and a prayer room. A layout saved before they existed gains them when it loads, if all three fit, and nothing already there moves: the full set in a large office with free space at the default spots, otherwise a compact set beside the existing rooms. The saved file only changes on your next save. If they don't fit, or you remove one later, a notice offers **Add break areas**, which adds what's missing for you to review and save. Deleted rooms never return on their own.

## Agent data

Agents, tasks and recent activity are typed, versioned data in `src/workforce/` (`types.ts`), kept apart from the layout.

- **Storage:** with the backend (`npm run dev:full`) agents are saved on the server in `data/workforce.json`. In the browser-only demo (`npm run dev`) they are saved in `localStorage` key `ai-virtual-office:workforce:v3`, automatically on every change. Agent changes are not part of the layout's undo history and never touch the layout key.
- **Validation:** loading checks every record and every reference (task ↔ agent, activity ↔ agent and task, one agent per desk, one active task per agent). Data that can't be read is copied to `ai-virtual-office:workforce:v3:backup`, a notice is shown, and the panel starts empty; nothing is overwritten without a backup.
- **History:** the newest 300 activity events are kept; tasks are kept.
- **Desks:** an agent refers to a desk by its furniture ID. If that desk is no longer in the layout (deleted, or a different layout), the agent keeps the reference and shows **Workstation unavailable** until you pick another desk.
- **Profile:** besides name, role and department an agent has a description, instructions, a model and a prayer-breaks setting (all editable in the panel). Instructions and model only apply on the Claude runtime. After a task ends an agent returns to Idle; an agent left in Error can be cleared with **Clear error**.
- **Reload:** a task that was running when the page closed is marked failed with "Interrupted by page reload (simulated run)".
- **Runtime boundary:** a `RuntimeProvider` interface (`src/workforce/runtime/types.ts`) separates the app from whatever executes a task. `MockRuntimeProvider` is the browser-timer simulation used today. `ClaudeRuntimeProvider` is a placeholder that only reports "Not available: requires a server-side runtime." A real Claude runtime must run on a server: the browser must never hold Anthropic credentials or API keys, or get shell or process access.

## Development

```bash
npm test        # unit tests (Vitest) for the layout model, storage, history, editor logic, and the agent workforce (operations, storage, mock runtime, controller, view helpers)
npm run build   # type-check and production build
npm run preview # serve the production build at http://127.0.0.1:4173
```

Add `?stats` to the URL (for example http://localhost:5173/?stats) to show a small render read-out over the 3D view: frames per second, CPU time per frame, draw calls and triangles. The 3D view only redraws when something changes, so it reads "idle" while nothing moves. Every agent with a desk appears as a seated character at it, showing its real status; they are drawn at 30 fps while any is acting, 5 fps when all are idle, and not at all while the tab is hidden, so `?stats` is the way to read what that costs.

## Assets and licences

- All 3D geometry, materials and floor textures are generated in code. The project contains no external models, textures or HDR files.
- Fonts: DM Sans and Manrope are bundled through the `@fontsource-variable/dm-sans` and `@fontsource-variable/manrope` packages (SIL Open Font License 1.1). Nothing is loaded from Google Fonts or any other remote host at runtime.

## Known limitations

- A desk, its chair and its monitor are separate items, so they move independently.
- Resize handles are available in floor plan only; in 3D, resize rooms from the properties panel.
- In the browser-only demo the layout is stored per browser and per origin (for example `localhost:5173`). Under `npm run dev:full` it is in `data/layout.json`. `data/` is ignored by git, so back it up separately. There is no live sync between tabs: the last save wins.
- Rooms have no doors and no ceilings, by design: the cutaway keeps every room visible and editable from above.
- Furniture is not instanced: each item draws one mesh per material, so very large layouts (hundreds of items) cost more draw calls. Room shells are merged into one mesh per material.
- Lighting has no real-time ambient occlusion or post-processing; soft contact shadows stand in for it.
- `npm run build` warns that the main JavaScript chunk is larger than 500 kB (three.js); the app is not code-split yet.
- **The mock runtime is the default and simulates work**: its task results are canned text that says so. The Claude runtime (`RUNTIME=claude`) is optional and runs a task on the Claude Agent SDK; it has **no OS-level sandbox** and runs with the server's privileges. Real runs so far are recorded in `docs/first-real-run-safety-checklist.md`, with open checks listed there.
- Backend mode logs in with the API token or a session cookie obtained by pairing with it (8 hours, lost on backend restart), allows one server process per data folder (a lock refuses a second one) and keeps agent data in one JSON file; it is meant for the local machine only. With `RUNTIME=claude` the agent can read, write and edit files in the chosen workspace through the five gated tools, each write after a person approves it (by default; `ALLOW_BROAD_WRITE_SCOPES=yes` lets one approval cover a task or an agent, see the environment table); it cannot run commands. No sandbox exists.
- Design documents: [`docs/gated-tools.md`](docs/gated-tools.md) (in-process Write/Edit tools for the SDK) and [`docs/browser-auth.md`](docs/browser-auth.md) (session cookie) are built; [`docs/sandbox-architecture.md`](docs/sandbox-architecture.md) (Docker) is **not built**.
- In the browser-only demo (`npm run dev`), agent data is per browser and per origin, like the layout: `localhost:5173` and `127.0.0.1:5173` keep separate agents. Under `npm run dev:full` agents are saved on the server.
- One task per agent at a time, with no queue. Finished tasks are never trimmed, only activity is.
- In the floor plan, a room's label can sit over the centre-row desks and hide the selected agent's desk outline; the marker's ring still shows which desk it is.
- Desk clicks in the office have no keyboard equivalent; the desk picker in the agent panel does the same thing.
- In 3D, clicking a wall or glass in front of a desk opens that desk's agent.
- If saved agent data is damaged a second time while an older backup exists, the older backup is kept and the new damaged data is not copied.

## Roadmap

See [`MASTER-ROADMAP.md`](MASTER-ROADMAP.md) for the current status, the owner's decisions and the planned order of work.
