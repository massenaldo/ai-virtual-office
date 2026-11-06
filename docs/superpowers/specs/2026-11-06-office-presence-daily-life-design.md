# Office presence and daily life: design

Covers roadmap milestones M3B.6, M3C.1 and M3C.2. Date: 2026-11-06. Status: awaiting the owner's approval.

Choices marked **(owner)** are the owner's own decisions. Choices marked **(design call)** were made while writing this and can be overruled.

## 1. Why

The owner wants an office that feels occupied. Agents are colleagues who live there, sitting at their desks when they have nothing to do and living an ordinary day, rather than records that only appear when a task runs. Today an agent shows up as a floating label over a desk.

The day the owner described: working, chatting with others, lunch, working again, praying, going to the kitchen to make a coffee. The joy of the feature is seeing that happen, including seeing an agent on a break when you hand it work.

## 2. Goals

1. Every agent with a desk is visible as a stylized 3D character at that desk, including when idle.
2. Characters show what the agent is really doing: real task status drives their state.
3. Agents work 24/7 **(owner)**, following a daily routine every day on the real clock in Jakarta time, walking between their desk, the kitchen, the dining area and the prayer room.
4. A task given during lunch or prayer waits for the break to end, and the office shows that clearly.
5. Agents have a real profile: instructions and a model choice, which can be imported from `.claude/agents/<role>.md`.

## 3. Non-goals

- A character for the owner **(owner)**. Agents only for now.
- Readable agent conversation **(owner)**. Chat is visual only, with no words from Claude.
- Full prayer movements in this release (see 6.5).
- Meetings and meeting animations (M5), team orchestration (M4), and running on a Pro or Max plan.
- Avatar customization. Appearance comes from the agent's ID.
- Public holidays, Ramadan schedules, and per-agent custom routines.

## 4. Anti-goals

This work has failed, even if it technically functions, if any of these happens:

- **Any Claude call, API cost or model session is created by presence, routine, walking or chat.** Only a real task on the Claude runtime may spend money.
- **An imported agent file grants anything.** A file's `tools` or permission fields must have no effect, and its text must never weaken the fixed safety rules in the system prompt.
- **The routine loses or silently stalls a person's task.** A waiting task must say why and when it will start, stay cancellable, and always start or fail visibly.
- **Editing the layout gets worse.** Characters must not interfere with selecting, dragging or saving.
- **The office turns a laptop's fan on.** The scene currently draws only on demand, so continuous animation is a real cost.
- **Prayer is shown disrespectfully or inaccurately.** No comic treatment, no jokes in the status text, and prayer times are labelled as approximate.

## 5. Constraints from the code as it stands

- `src/scene/OfficeScene.tsx` uses `frameloop="demand"` with 2048 soft shadows, and furniture is not instanced. Today nothing animates.
- Rooms are a cutaway shell with an open front (`src/scene/architecture.ts`), turned by `room.rotation`. **So doorways are not needed:** characters walk in through the open side. Layouts are editable, so routes must be computed from the current layout rather than authored by hand.
- The default office has 10 rooms, 14 desks and 25 × 20 m of floor, with a 0.25 m grid. Stacked rooms on the right leave a gap of only 0.4 m.
- `Agent` (`src/workforce/types.ts`) has a stable ID, `deskId` and `status`, and is saved in a versioned server store (`server/store.ts`), with `WORKFORCE_SCHEMA_VERSION = 2` and an existing migration pattern in `src/workforce/storage.ts`. Layout has `LAYOUT_SCHEMA_VERSION = 1`, saved per browser.
- A finished task leaves the agent `completed` and a failed one leaves it `error`. Neither ever settles (`src/workforce/operations.ts`).
- `server/taskManager.ts` starts a task as soon as it is assigned, and starts its timeout then. Over `MAX_CONCURRENT_TASKS`, it **refuses** a Claude task rather than queueing it.
- The system prompt uses only name and role (`server/runtime/claudePrompt.ts`). The model is one server-wide `CLAUDE_MODEL`.
- `.claude` is treated as a sensitive folder by `server/execSensitive.ts`, for writes; the agent's gated tools can read that folder today, and this design does not change that.
- The project builds its 3D in code with no downloaded assets, and there are no character files. `server/noProcessExecution.test.ts` stays in force.
- `npm run dev:full` runs the backend and the app together, and was confirmed working on 2026-11-06: the page loads, agents can be listed and created through the same-origin proxy, and the backend alone answers 401 without a token. It uses the mock runtime by default, so it costs nothing.
- The office layout is still saved per browser and per address. `localhost:5173` and `127.0.0.1:5173` keep separate layouts, and `dev:full` prints the `127.0.0.1` address. The old `/vo` link used `localhost`.
- Plain `npm run dev`, with no server, stays available as a demo mode, as the roadmap's "mock mode remains useful" asks.

## 6. Design

### 6.0 How the owner reaches the office

**(owner)** The office is a dashboard website the owner opens by URL, where they add, edit and watch their agents. `/vo` is being retired.

- **For now:** run `npm run dev:full` in a terminal and open `http://localhost:5173`. The `localhost` address keeps any layout saved under the old `/vo` link. The server keeps running until the terminal stops it, with no auto-stop on closing the page.
- **Everything is designed for this server-backed mode.** Browser-only `npm run dev` is a secondary demo: it shows characters and the routine but does not hold tasks.
- **Retire `/vo` (slice 0):** remove `.claude/commands/vo.md`, `scripts/vo.sh`, `scripts/voAutoExit.ts` and its test and the wiring in `vite.config.ts`, update the README and the message in `scripts/devFull.ts`, and make `dev:full` print the `localhost` URL.
- **Later, a hosted URL (M7, not this work):** a real address needs the gateway's no-password gap fixed first, plus moving the layout to the server so it isn't per browser, and the sandbox if Claude is enabled there.

### 6.1 Identity versus presence

- **Identity** is stored: the existing agent fields, plus the profile in 6.2.
- **Task status** is stored, as today.
- **Presence** is never stored. It is worked out from the agent, the layout and the current time by one pure function in the shared model, importable by both browser and server: `presenceAt(agent, layout, activeTask, now)`.

Because presence is calculated rather than saved, a page refresh, a second browser tab and a server restart all show the same office, with no state to corrupt and nothing to migrate.

**Priority:** an active task beats the routine, except that lunch and prayer hold a *new* task (6.6). An agent with an active task is at its desk.

Presence states: `at-desk`, `walking`, `chatting`, `coffee`, `lunch`, `praying`. **(design call)** There is no `offline` state, because nothing in this design can make an agent offline.

### 6.2 Agent profile and status (M3B.6)

- Add `description` (bounded plain text, display only), `instructions` (plain text, bounded, for example 8 KB), `model` (nullable, validated with the same rule as `CLAUDE_MODEL`), `takesPrayerBreaks` (boolean, see 6.5) and the import source (nullable) to `Agent`. Schema goes to version 3, with a migration in the existing pattern. `description`, `instructions`, `model` and `takesPrayerBreaks` are editable in the agent form.
- `buildSystemPrompt` includes `instructions` **after** the fixed rules and clearly marked as the role description, with the fixed rules still binding. The per-agent model overrides the server default.
- **Status settling (design call):** a finished task sets the agent to `idle`. The `completed` status is removed, with stored values migrated to `idle`. The character still shows a brief "done" moment, derived from the task's `completedAt`. `error` stays visible until the next task starts or the owner clears it with a small button, and an agent in `error` still follows the routine, with its error badge showing.

### 6.3 Import from `.claude/agents` (M3B.6)

- A read-only server route reads `<workspace>/.claude/agents/*.md` from an allowed workspace, using a narrow new reader. This does not change what the agent's own `vo_*` tools may do with that folder.
- It accepts only `name`, `description` and `model` from the frontmatter and uses the body as `instructions`. Unknown fields, including `tools`, are ignored and shown as ignored. Parsing is plain text with no execution and it does not need the file to be valid YAML, but any top-level line that is not a plain `key: value` pair (apart from comments and the continuation of an open key) refuses the file, so a file can not hide what it asks for. Bad files appear as per-file errors.
- **What an import creates (design call):** a first import always creates a new agent. It never fills in an existing agent that it was not imported into.
    - `name` comes from the file, under the existing validation.
    - `role` starts as the file name made readable and capped at the existing limit, and the person can change it in the preview.
    - `department` has no source in the file, so the person picks it in the preview, as a required choice.
    - `description` is stored as a new profile field for display. It is **never** used as `role` and is not sent in the system prompt, because it describes when to use the agent rather than who it is.
- **Re-import (design call):** each agent records its source file. Re-importing that file shows what would change and overwrites only on confirmation. The file owns only `description`, `model` and `instructions`. Once created, `name`, `role`, `department` and desk belong to the person, and a re-import never changes them. There is no per-field history and no file watching.
- **Prompt safety:** since `name` and `role` can now start from a file and appear in the first sentence of the prompt, both must stay single-line and pass the existing checks, and a hostile-file test covers them as well as `instructions`.
- Import works in the normal server-backed mode. In the browser-only demo the UI says plainly that it needs the server.

### 6.4 Characters (M3C.1)

- **Style (owner):** stylized 3D, modern professional. **(design call)** Built in code with shared geometry, in keeping with the project: rounded, simplified figures in smart-casual office clothes, with no facial detail beyond simple features. Clothing accent uses the agent's department colour. Men and women, skin tone, hair and clothing cut vary, chosen deterministically from the agent's ID. **(owner)** Some women wear a hijab and others do not. Hijab is one option among women's looks, not the default, and appearance says nothing about an agent's prayer setting: the two are chosen separately. Characters need jointed limbs so they can sit, walk and type.
- One character per agent with an existing desk. An agent with no desk or a missing desk has no character, and the panel already flags this.
- **Animation states:** seated idle, typing (`working`), thinking (`thinking`), waiting with a raised hand (`waiting`), error slump with a badge (`error`), and a brief done gesture.
- Clicking a character opens that agent, the same as clicking its desk. Desk clicks keep working. The existing status label stays above the character and follows it as it moves.
- **Edit mode:** characters are hidden, like the markers are today. **Floor plan:** a simple coloured dot that still moves.

### 6.5 Daily life (M3C.2)

**New places.** Add `kitchen`, `dining` and `prayer` as room departments, excluded from the departments an agent can belong to, like `meeting`. Add furniture types such as kitchen counter, coffee machine, dining table, dining chair and prayer mat, built in code. **(design call)** Prayer room, kitchen and dining go in the default layout in the free floor south of the meeting room (roughly x −5.8 to −2.2 and x −0.5 to 4.5, z 3.5 to 8), moving a plant if needed, with the exact placement left to the builder and proved by the existing overlap validation.

**Existing saved layouts.** Layout schema goes to version 2. On load, the new rooms are added to an old layout if they fit without overlapping anything. If they do not fit, the layout is left exactly as saved, and the agents stay at their desks during breaks, with a notice offering "Add break areas" through the editor. A person's layout is never moved around automatically.

**Routine:** real clock, `Asia/Jakarta`, whatever timezone the browser is in. **(owner)** Agents work 24/7: there are no office hours and no days off. The routine runs every day of the week, and at any other time a new task starts at once. Agents never leave the office, and the roadmap's "remain visible" rule holds at all hours.

| Event | When | Duration | Holds a new task? |
|---|---|---|---|
| Coffee | about 10:30, 15:45 and 21:00 **(design call)** | 15 min | No |
| Chat | 2 to 3 short chats between 09:00 and 22:00, with a nearby free colleague **(design call)** | 5 min | No |
| Lunch | 12:00 to 13:00, Saturday to Thursday | 60 min | **Yes (owner)** |
| Friday prayer and lunch | about 11:45 to 13:00, Fridays, replacing that day's Dzuhur and lunch **(owner)** | about 75 min | **Yes (owner)** |
| Subuh, Dzuhur, Ashar, Maghrib, Isya | from that prayer's time today, for agents with `takesPrayerBreaks` **(design call: all five, because agents are there 24/7)** | 15 min | **Yes (owner)** |

- Each agent's times are offset by a small amount chosen from its ID, so they drift off in ones and twos. The schedule for a day is a pure function of the date and agent ID. Where a prayer overlaps lunch, prayer goes first and lunch takes the remaining time. The whole group stays on the same Friday window.
- **Who prays (design call):** the owner pointed out that not everyone is Muslim, so prayer breaks are a setting on each agent, `takesPrayerBreaks`, shown in the agent form as "Takes prayer breaks". It is on by default for new agents and for existing agents after migration, and the owner turns it off where they want. An agent with it off keeps working through prayer times and has no hold then, but still has lunch. On Fridays it takes ordinary lunch from 12:00 to 13:00 instead. The setting is independent of how the character looks.
- **If a task is running when a break starts (design call):** the agent stays and finishes, then takes whatever is left of the break, or skips it if the time has passed.
- **If an agent has nowhere to go** (no such room, no free spot, or no route): it stays at its desk and still shows its break status.
- **Prayer times:** calculated in code for Jakarta (−6.2, 106.8) using the Indonesian Kemenag method (Subuh 20°, Isya 18°). They are shown labelled "approximate; follow your official schedule". The result must be checked against a published Jakarta timetable, within 2 minutes, on several dates across the year.
- **Chat (owner):** visual only. Two characters stand together, facing each other, with speech bubbles that hold no words (for example three dots). No API call.

**Walking (owner: wanted if the effort is reasonable). Included.** **(design call)** A route is a grid search over a map of blocked cells computed from the current layout's walls and furniture, on the existing 0.25 m grid. Position along the route is a pure function of the start time and walking speed, so it stays calculated rather than stored. Characters do not avoid each other; they may pass through each other briefly, which is acceptable at this scale and saves a large amount of work. A test proves that every default desk can reach all three break areas, including through the narrow gaps.

**Prayer (owner: shown if effort is reasonable, otherwise next update).** **(design call)** This release: an agent walks to the prayer room and stands quietly on a mat facing the qibla, with the status "Praying". Full movements are left to the next update, because getting them correct and respectful is a job of its own, and the owner should review them. Facing: the code already treats −Z as north, so the qibla is a fixed bearing of about 295° from north.

**Apart from the prayer setting, every agent follows the same routine (design call).** Other per-agent settings can come later if wanted.

### 6.6 Tasks during breaks

**The server decides.** Holding lives in `TaskManager`, using the shared schedule function. The browser-only demo shows breaks, but its tasks start at once, because the owner no longer uses that mode day to day and building it twice would be wasted effort **(design call)**.

- When a task is created while the agent is on lunch or prayer, it stays `queued` and records the time it will start. Its timeout has not started, and no runtime session or API call exists yet.
- The card and the label show it plainly, for example "On lunch · starts around 13:00".
- A held task can be cancelled, as any queued task can.
- **"Start now" (owner):** a button on the held task ends the hold for that task, and it starts through the normal path right away. The agent's character goes back to its desk, because an active task puts it there.
- At the end of the break it starts through the normal path. **If the Claude limit refuses it, it stays held and tries again**, and shows why. It must never be dropped.
- `OFFICE_ROUTINE=off` disables holding and the routine on the server, and tests inject their clock.

**After a server restart (design call):** a held task **fails visibly** with a clear message, such as "The server restarted while this task was waiting. Start it again." `recoverInterruptedTasks` currently leaves `queued` tasks untouched, so a held task would otherwise be stranded forever, and it must change to cover them. Resuming on its own was rejected because a paid Claude session could then start at boot with nobody watching, possibly days after the request.

**One clock (design call):** since the server decides, the browser takes the time from the server, by reading an offset from the server's state. This keeps the office and the holding in agreement, and also covers a hosted server later.

### 6.7 Performance

- While anything is moving or animating and the tab is visible, the scene draws at a capped rate (for example 30 fps). When every character is seated and idle, it drops to a low rate of a few frames per second, enough for a slight idle movement. When the tab is hidden, it stops.
- Characters use shared geometry, instanced where the builder finds it helps. Use the existing `?stats` overlay to measure before and after.

## 7. How it gets built

One PR per slice, in this order, each usable alone:

0. Retire `/vo` and make `npm run dev:full` the documented way in.
1. Profile, instructions, per-agent model, prayer setting and status settling.
2. `.claude/agents` import.
3. Seated characters and the draw-rate policy.
4. Break areas: rooms, furniture and layout migration.
5. Schedule, prayer times, presence, walking and chat.
6. Holding tasks during breaks, and "Start now".

Slices 1, 2 and 6 change server and security-sensitive behaviour and get Opus reviews. The rest get lighter reviews.

## 8. How we will know it is right

Automated:
- No Claude session is created by presence, routine or chat: with the Claude runtime enabled and no task, the provider is never called.
- Imported `tools` and permission fields change nothing, and fixed prompt rules stay in place with hostile `instructions`.
- The schedule, prayer times and presence are unit tested with an injected clock, across timezones, Fridays, overnight hours, overlap cases and the prayer setting on and off.
- Held-task cases: cancel, "Start now", restart, refused by the Claude limit, and timeout counted only from the real start.
- Migrations from schema 2 and layout schema 1. Every existing test still passes, or is changed for a stated reason.

In a real browser:
- Seated characters on all 14 desks, with the frame rate measured before and after, and editing unaffected.
- A dev-only server setting, `VO_DEV_CLOCK`, sets the office's start time and speed, for example a whole day in a few minutes. Because the browser takes its time from the server, the characters and the holding stay in agreement. It is refused on a public address and refused when the Claude runtime is enabled, so it can never affect real work.

The owner looks at the characters after slice 3, the day after slice 5, and a task waiting out a break after slice 6, because how it feels is the point. All three reviews use `npm run dev:full` with the mock runtime, at no cost.

## 9. Open for the owner

Nothing is blocking. The owner answered the Friday break, "Start now", 24/7 hours and hijab on 2026-11-06. They should check the design calls in 6.2, 6.5 and 6.6, especially all five prayers and the "Takes prayer breaks" setting.

## 10. Left to the builder

Exact joint structure, geometry and colours; exact layout placement; instancing strategy; grid search details; idle animation; routes and file layout; bounds on text fields, within the rules above.
