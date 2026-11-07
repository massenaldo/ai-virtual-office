# Daily Life Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents live an ordinary day on the real Jakarta clock: coffee, chats, lunch and prayer, walking between their desk and the break rooms, with nothing stored and no Claude call.

**Architecture:** A new folder of pure code, `src/office/`, importable by browser and server (no three.js, no React), decides everything from the agents, the layout and the time. The scene receives a function from agent ID and time to a position and action, and calls it per frame, so walking causes no React re-renders. The browser takes its time from the server.

**Tech Stack:** TypeScript, React 19, three 0.174, @react-three/fiber 9, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-office-presence-daily-life-design.md`, sections 4, 6.1, 6.5, 6.7 and 8. This is slice 5 of section 7. The break rooms come from slice 4 (`src/layout/breakAreas.ts`).

## Global Constraints

- **No Claude call, API cost or model session may be created by presence, routine, walking or chat.** Only `/api/state` and config change on the server in this slice; nothing touches a provider.
- Presence is never stored. A page refresh, a second tab and a server restart all show the same office.
- Real clock, `Asia/Jakarta` (fixed UTC+7), whatever timezone the browser is in. Agents work 24/7 and never leave the office.
- Prayer is shown respectfully: "Praying", no comic treatment, no jokes. An agent stands quietly on a mat facing the qibla, a fixed bearing of about 295° from north, where −Z is north. No full prayer movements in this release. Prayer times are labelled exactly: `Approximate; follow your official schedule.`
- Chat is visual only: bubbles holding three dots, never words.
- An active task beats the routine: the agent is at its desk. If a task is running when a break starts, the agent finishes, then takes what is left of the break, or skips it if the time has passed.
- An agent with nowhere to go (no such room, no free spot, no route) stays at its desk and still shows its break status.
- An agent in `error` follows the routine with its badge showing.
- Appearance stays independent of the prayer setting. An agent with `takesPrayerBreaks` off has no prayer events and takes ordinary lunch on Fridays.
- Edit mode hides characters. Floor plan: a coloured dot that moves. The label follows the character. Editing must not get worse.
- Draw rates stay as they are: walking counts as active (30 fps), everything else in a break is idle (5 fps), hidden tab none.
- Holding tasks is slice 6, not this one. Tasks keep starting at once here.
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stacked branches, one per task: `feat/daily-life-schedule`, `feat/daily-life-presence`, `feat/daily-life-clock`, `feat/daily-life-scene`, `feat/daily-life-check`. Every PR targets `main` and includes a screenshot, on mock data only because the repo is public.

## Review Focus

1. A viewer in another timezone, or at a Jakarta day boundary: the schedule follows Jakarta's date and weekday, never the browser's.
2. A layout edited while an event is on (room deleted, chair moved, or fewer spots than agents): the agent stays at its desk with its status, and nothing throws.
3. A task started mid-walk or mid-break: the agent heads back to its desk at once, and a task finishing mid-break gives the remainder of the break, or nothing if it has passed.
4. A tab hidden for an hour, or a reload mid-walk: the character is exactly where the pure function says, with no jump after the first frame and no route animation replay.
5. `VO_DEV_CLOCK` with Claude enabled: the server refuses to start. A missing or malformed clock in `/api/state` from an older server: the browser falls back to its own clock.

---

### Task 1: Jakarta clock, prayer times and the day's schedule

**Files:**
- Create: `src/office/hash.ts`, `src/office/jakartaClock.ts`, `src/office/prayerTimes.ts`, `src/office/schedule.ts`, and a test for each of the last three
- Modify: `src/scene/furnitureModels.ts` (re-export `stableHash` from `src/office/hash.ts`, behaviour unchanged, so `src/office` never imports three), `src/workforce/view.ts`, `src/workforce/ui/AgentDetail.tsx`

**Interfaces:**
- Produces in `jakartaClock.ts`: `type JakartaDay = { year: number; month: number; day: number; weekday: number; key: string }` (weekday 0 is Sunday, key is `2026-11-07`), `jakartaDay(nowMs: number): JakartaDay`, `minutesIntoDay(nowMs: number): number`, `dayStartMs(day: JakartaDay): number`. Use fixed UTC+7 arithmetic, not `Intl`.
- Produces in `prayerTimes.ts`: `type PrayerName = 'subuh' | 'dzuhur' | 'ashar' | 'maghrib' | 'isya'`, `prayerTimes(day: JakartaDay): Record<PrayerName, number>` in minutes since Jakarta midnight
- Produces in `schedule.ts`: `type BreakKind = 'coffee' | 'lunch' | 'prayer' | 'friday'`, `type BreakEvent = { kind: BreakKind; prayer: PrayerName | null; startMs: number; endMs: number; holds: boolean; label: string }`, `daySchedule(agent: { id: string; takesPrayerBreaks: boolean }, day: JakartaDay): BreakEvent[]`, sorted, not overlapping

Chat is not here because it needs two agents. Task 2 owns it.

Prayer times: Jakarta at latitude −6.2, longitude 106.8, UTC+7, using the Indonesian Kemenag method: Subuh at sun −20°, Isya at −18°, Ashar at shadow factor 1, Maghrib at sunset with the standard −0.8333°, plus 2 minutes of ihtiyat on all five. If a fixture is more than 2 minutes out, adjust only the ihtiyat or sunset constant, keep all fixtures within 2 minutes, and report it.

| Event | When | Length | `holds` | `label` |
|---|---|---|---|---|
| `coffee` | 10:30, 15:45, 21:00, plus the offset | 15 min | false | `Coffee` |
| `lunch` | 12:00 plus the offset, Saturday to Thursday. Also Fridays when `takesPrayerBreaks` is off | 60 min | true | `On lunch` |
| `friday` | 11:45 to 13:00 exactly on Fridays when `takesPrayerBreaks` is on, for the whole group with no offset. Replaces that day's Dzuhur and lunch | 75 min | true | `Friday prayer and lunch` |
| `prayer` | Each prayer's time plus the offset, when `takesPrayerBreaks` is on | 15 min | true | `Praying` |

The offset is 0 to 5 whole minutes, from `stableHash(`${id}:${key}:${event}`)`, so agents drift off in ones and twos. Where a prayer overlaps lunch, prayer goes first and lunch takes what's left, keeping lunch's end. A coffee overlapping anything that holds is dropped.

- [ ] **Step 1: Write the failing tests**

```ts
// jakartaClock.test.ts
it('uses Jakarta, not the viewer', ...)               // 2026-11-06T17:30:00Z is 2026-11-07 00:30, a Saturday (6)
it('round-trips dayStartMs', ...)
// prayerTimes.test.ts: published Bimas Islam times via Indonesian media, each within 2 minutes
it.each([
  ['2026-02-19', { subuh: '04:41', dzuhur: '12:10', ashar: '15:20', maghrib: '18:18', isya: '19:28' }],
  ['2026-03-01', { subuh: '04:45', dzuhur: '12:10' }],
  ['2026-05-31', { subuh: '04:36', dzuhur: '11:54' }],
  ['2026-07-31', { subuh: '04:45', dzuhur: '12:03' }],
  ['2026-09-23', { subuh: '04:27', dzuhur: '11:49', ashar: '14:58', maghrib: '17:52', isya: '19:00' }],
])('%s matches a published Jakarta timetable', ...)
// schedule.test.ts
it('has all five prayers, lunch and three coffees on a weekday, with the prayer setting on', ...)
it('with the setting off has no prayers and still has lunch', ...)
it('on a Friday the group shares 11:45 to 13:00, with no separate Dzuhur or lunch', ...)
it('on a Friday with the setting off, ordinary lunch', ...)
it('prayer goes first where it overlaps lunch, and lunch keeps its end', ...)      // force the overlap with a date where Dzuhur falls after 11:45 and offset
it('events never overlap, on every day of a whole year, for many agent ids', ...)
it('holds is true only for lunch, friday and prayer', ...)
it('the same agent and day give the same schedule, and agents differ', ...)
it('takes nothing but the id and the prayer setting', ...)                          // a call with extra fields gives the same result
```

- [ ] **Step 2: Run them to verify they fail**

Run: `rtk proxy npx vitest run src/office`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the three modules**

- [ ] **Step 4: Show the day in the agent panel**

In `view.ts` add `todaySchedule(agent: Agent, nowMs: number): { time: string; label: string }[]`, with times like `12:03` or `11:45–13:00` in Jakarta time. In `AgentDetail.tsx` add a "Today" section listing them, headed `Jakarta time`. Below it, only when `takesPrayerBreaks` is on, the exact text `Prayer times are approximate; follow your official schedule.` Add `view.test.ts` cases for both.

- [ ] **Step 5: Run the full suite and build**

Run: `rtk proxy npm test && rtk proxy npm run build && rtk proxy npm run server:build`
Expected: PASS.

- [ ] **Step 6: Commit** as `feat(office): Jakarta clock, prayer times and the daily schedule`

Screenshot for the PR: the "Today" section for a mock agent, with the setting on.

### Task 2: Routes and presence

**Files:**
- Create: `src/office/walkMap.ts`, `src/office/breakSpots.ts`, `src/office/presence.ts`, and a test for each
- Modify: `src/scene/characterRig.ts` only if it holds a constant that this needs. Don't add scene imports to `src/office`.

**Interfaces:**
- Consumes: Task 1; `seatForDesk` from `src/layout/seats.ts`; `roomRect`, `furnitureRect`, `rotateOffset` from `src/layout/geometry.ts`
- Produces in `walkMap.ts`: `type Point = { x: number; z: number }`, `createWalkMap(layout: OfficeLayout): WalkMap`, `WalkMap.route(from: Point, to: Point): Point[] | null`, `routeLength(route: Point[]): number`, `pointAlong(route: Point[], metres: number): { x: number; z: number; heading: number }`
- Produces in `breakSpots.ts`: `type BreakSpot = Point & { rotation: number; pose: 'sit' | 'stand' }`, `breakSpots(layout: OfficeLayout): { coffee: BreakSpot[]; dining: BreakSpot[]; prayer: BreakSpot[] }`, and `QIBLA_ROTATION = 65`
- Produces in `presence.ts`: `WALK_SPEED = 1.2` (metres per second), `CHAT_MS = 5 * 60_000`, and:

```ts
export type RoutineAgent = { id: string; deskId: string | null; takesPrayerBreaks: boolean; /** When its active task started, or null. */ activeSince: number | null; /** When its last task ended, or null. */ busyUntil: number | null }
export type PresenceState = 'at-desk' | 'walking' | 'chatting' | 'coffee' | 'lunch' | 'praying'
export type Presence = { state: PresenceState; x: number; z: number; rotation: number; pose: 'sit' | 'stand' | 'walk'; label: string | null; bubble: boolean }
export function createRoutine(agents: RoutineAgent[], layout: OfficeLayout): { presenceAt(agentId: string, nowMs: number): Presence | null; chatsOn(day: JakartaDay): { startMs: number; a: string; b: string; x: number; z: number }[] }
```

This adapts the spec's `presenceAt(agent, layout, activeTask, now)`, because a chat depends on a second agent. It stays pure: `createRoutine` only memoises routes and schedules. `presenceAt` returns null for an agent with no desk or a missing desk. `rotation` is in degrees with the rig's convention: 0 faces −Z, and a positive value turns toward −X.

**Walk map.** A grid on `layout.office.gridSize` cells. Blocked: each room's three walled sides, using the room's rotation so the open side stays open (open side is local +Z), and rectangles of `desk`, `meeting-table`, `dining-table`, `kitchen-counter`, `storage-cabinet`, `shelf` and `plant`. Not blocked: `chair`, `meeting-chair`, `dining-chair`, `monitor`, `coffee-machine` and `prayer-mat`, so a character can reach a seat. Search with 8-connected A*, no corner cutting, and shorten the result by line of sight. Start and end points in a blocked cell connect to the nearest free cell. Characters don't avoid each other. Results are cached per from-to pair. Deterministic.

**Spots.** Coffee: standing spots 0.55 m south of the counter, 0.7 m apart along it, facing it. Dining: each `dining-chair` in a `dining` room, at the chair with its rotation, seated. Prayer: each `prayer-mat` in a `prayer` room, at the mat, rotation `QIBLA_ROTATION`, standing. Agents get spots by their index in the ID-sorted agent list, within each list. An index past the end means no spot, so the agent stays at its desk.

**Itinerary.** For one agent on one day, the schedule gives events. The agent walks from its seat to the event's spot starting at the event's start, stays until its end, then walks home. When the next event starts before the walk home would finish, it walks directly to the next spot. Position along a walk is `pointAlong(route, WALK_SPEED * elapsedSeconds)`. A walk longer than the event means no stay, and it goes straight back.

**Priority:**
- `activeSince` not null and before the current break: at the desk, seated, with `label` null.
- `activeSince` during a break: it walks home from where the itinerary had it at `activeSince`, starting then.
- `busyUntil` during a break: the walk to the spot starts at `busyUntil`, or nothing happens if the time left doesn't cover the walk there.
- No route, no room or no spot: seated at the desk, with `state` still the break's and `label` still set.

While walking, `state` is `walking`, and `label` is the event's label on the way there and null on the way home.

**Chat.** Each Jakarta day has 3 chat slots from `stableHash(`chat:${key}:${n}`)`, between 09:00 and 22:00. Each slot pairs agents with the nearest free colleague by desk distance, each agent at most once, keeping 2 to 3 chats per agent per day. Free means no event of its own overlapping the slot, no active task and a route. Meeting point: the midpoint of the two desks' seats, moved to the nearest free cell, with each agent 0.45 m either side, facing each other. `bubble` is true while chatting. Its `label` is `Chatting`.

- [ ] **Step 1: Write the failing tests**

```ts
// walkMap.test.ts
it('every default desk can reach all three break areas, including through the narrow gaps', ...)
it('every desk in a two-desk office with the compact row can reach all three', ...)
it('never crosses a wall or a desk', ...)                                  // sample every 5 cm along many routes
it('enters a room through its open side, for all four rotations', ...)
it('gives null when a target is walled off', ...)
it('the same inputs give the same route', ...)
// breakSpots.test.ts
it('finds a spot per chair, mat and counter place, and none with no room', ...)
it('prayer spots face the qibla', ...)                                     // QIBLA_ROTATION gives a forward vector about 295° from north
// presence.test.ts: clock injected as plain numbers
it('sits at the desk with no event', ...)
it('leaves at the event start, arrives at distance / speed, and stays', ...)
it('is at the same place however it is called: no state between calls', ...) // call in shuffled time order and compare
it('walks directly from prayer to lunch when they run together', ...)
it('an active task keeps the agent at the desk through a break', ...)
it('a task started mid-break walks the agent home from where it was', ...)
it('a task finished mid-break gives the remainder, or nothing if it is too late', ...)
it('more agents than spots: the extras stay at their desks and keep the label', ...)
it('a deleted room or a missing route keeps the agent at its desk with the label', ...)
it('no desk or a missing desk gives null', ...)
it('prayer setting off: never praying, and ordinary lunch on Fridays', ...)
it('two agents meet to chat, facing each other, with bubbles', ...)
it('one agent alone never chats', ...)
it('nobody chats during their own break or with a busy colleague', ...)
it('gives 2 to 3 chats per agent on an ordinary day in the default office', ...)
it('imports neither three nor React', ...)                                  // read the source files, like noRemoteAssets.test.ts
```

- [ ] **Step 2: Run them to verify they fail**

Run: `rtk proxy npx vitest run src/office`
Expected: FAIL for the new files.

- [ ] **Step 3: Implement the three modules**

- [ ] **Step 4: Run the full suite, build, and time it**

Run: `rtk proxy npm test && rtk proxy npm run build`
Expected: PASS. Add a test that all default desks' routes build within 500 ms in total, and a `presenceAt` call takes under 0.1 ms once cached, measured over 14 agents and 1,000 calls.

- [ ] **Step 5: Commit** as `feat(office): routes between desks and break rooms, and pure presence`

Screenshot for the PR: routes drawn over the floor plan, by the controller.

### Task 3: One clock from the server

**Files:**
- Create: `src/office/officeClock.ts`, `src/office/officeClock.test.ts`, `server/officeClock.ts`, `server/officeClock.test.ts`
- Modify: `server/config.ts`, `server/config.test.ts`, `server/http/routes.ts`, `server/http/routes.test.ts`, `server/app.ts`, `src/workforce/api.ts`, `src/workforce/remote/sync.ts`, `src/workforce/remote/sync.test.ts`, `src/workforce/remote/fakes.ts`, `src/workforce/controller.ts`, `src/App.tsx`, `README.md`

**Interfaces:**
- Produces in `src/office/officeClock.ts`: `type OfficeClockInfo = { nowMs: number; speed: number; routine: boolean }`, `type OfficeClock = { now(): number; fromReal(realMs: number): number; routine: boolean }`, `createOfficeClock(info: OfficeClockInfo | null, realNow: () => number): OfficeClock`, and `parseOfficeClockInfo(v: unknown): OfficeClockInfo | null`. With null, it uses real time with the routine on.
- Produces: `StateResponse` gains `office: OfficeClockInfo`. `WorkforceSnapshot` gains `office: OfficeClockInfo | null`. Browser-only demo: null.
- Produces in `server/officeClock.ts`: `parseDevClock(raw: string | undefined): { startMs: number; speed: number } | null | 'invalid'` and `officeClockInfo(config, realNow): OfficeClockInfo`.
- Produces in config: `officeRoutine: boolean` from `OFFICE_ROUTINE` (`off` disables, default on) and `devClock` from `VO_DEV_CLOCK`, with the form `2026-11-09T11:40:00+07:00@60`, meaning that start time and speed. Speed is 1 to 3600.

`VO_DEV_CLOCK` is refused with a config error when Claude is enabled (`claudeEnabled(config)`), and is limited by the existing rule that `HOST` must be loopback. It sets only the office clock: `now()` used for tasks and audit stays real, so it can never affect real work. Add both names to `CONFIG_VARIABLES` and to the README's table.

A small chip in the scene shows the office time as `Jakarta 12:03`, updating once a minute, hidden while editing. With a dev clock it adds `×60`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/office/officeClock.test.ts
it('follows the server, not the local clock', ...)    // local clock 3 hours off gives the server's time
it('runs at the given speed', ...)
it('maps a real time onto office time', ...)
it('falls back to real time on null', ...)
it.each([null, {}, { nowMs: 'x' }, { nowMs: 1, speed: 0, routine: true }, { nowMs: 1, speed: 1 }])('rejects %o', ...)
// server tests
it('/api/state carries the office clock', ...)
it('VO_DEV_CLOCK is refused when Claude is enabled, whichever way it is enabled', ...)
it('a malformed VO_DEV_CLOCK or a speed outside 1 to 3600 is a config error', ...)
it('OFFICE_ROUTINE=off reports routine false', ...)
it('the dev clock changes no task or audit timestamp', ...)
it('state from an older server with no office field still loads', ...)   // sync.test.ts
```

- [ ] **Step 2: Run them to verify they fail**, then **Step 3: Implement**, then **Step 4: Run** `rtk proxy npm test && rtk proxy npm run build && rtk proxy npm run server:build && rtk proxy npm run check:secrets`

- [ ] **Step 5: Commit** as `feat(office): one office clock from the server, with a dev-only speed setting`

Screenshot for the PR: the chip with a dev clock, on the mock runtime.

### Task 4: Characters living the day

**Files:**
- Create: `src/scene/presenceTypes.ts`
- Modify: `src/scene/characterRig.ts`, `src/scene/characterRig.test.ts`, `src/scene/Characters.tsx`, `src/scene/DeskMarkers.tsx`, `src/scene/labels.ts`, `src/scene/labels.test.ts`, `src/scene/OfficeScene.tsx`, `src/workforce/view.ts`, `src/workforce/view.test.ts`, `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `createRoutine`, `Presence` shape, `OfficeClock`
- Produces in `presenceTypes.ts`: `type ScenePresence = { x: number; z: number; rotation: number; pose: 'sit' | 'stand' | 'walk'; activity: 'idle' | 'coffee' | 'eat' | 'chat' | 'pray'; label: string | null; bubble: boolean }` and `type PresenceSource = (id: string) => ScenePresence | null`. The scene never imports `src/office` or workforce types: `App.tsx` adapts one to the other.
- Produces in the rig: `CharacterAction` gains `'walk' | 'coffee' | 'eat' | 'chat' | 'pray'`
- Produces in `view.ts`: `routineAgents(s: WorkforceState, layout: OfficeLayout, clock: OfficeClock): RoutineAgent[]`, using `clock.fromReal` for task times

Action choice per character per frame, first match wins:
1. A task status other than idle sets typing, thinking, waiting or error, as today, when the presence pose is `sit` and the agent is at its desk.
2. `walk` while the pose is `walk`.
3. The activity: `coffee` standing with one forearm raised as if holding a cup, `eat` seated with both hands at the table, `chat` standing with slow small gestures, `pray` standing still with hands relaxed at the sides and head slightly lowered. No bowing, no movement other than breathing.
4. Done, then idle.

An `error` status shows the badge in any action, so `partVisible` gets `'error'` when the status is error. The walk cycle is a slow, natural swing of opposite arm and leg, driven by distance so feet don't slide, with no bobbing.

`Characters` takes `presence: PresenceSource` and, in `useFrame`, reads each character's presence for position, rotation and pose, in place of its fixed seat. `motion.active` is also true while any pose is `walk`. Floor plan dots move too, and the `DrawScheduler` keeps ticking at 5 fps in floor plan while a routine is on, or dots wouldn't move: change `drawRate`'s floor plan rule and its test accordingly, keeping 0 when hidden or editing.

`DeskMarkerTracker` reads the same source for position, and uses `MARKER_HEIGHT` when seated and `STANDING_MARKER_HEIGHT` otherwise. It writes the label text straight to the DOM only when it changes, for example `Atlas · On lunch`, and toggles a three-dot bubble for chat. Task phase labels still win when a task is active.

`Characters` must not rebuild its meshes when presence changes: `characters` stays the identity list from `deskCharacters`, and `presence` is a stable function that changes only when agents, tasks or layout do. `App.tsx` builds it with `useMemo` from `createRoutine(routineAgents(...), layout)`. With `clock.routine` false, it returns each seat.

Desk clicks and character clicks keep working. A click on a character anywhere still opens that agent, because the raycast uses the instance matrices.

- [ ] **Step 1: Write the failing tests**

```ts
// characterRig.test.ts
it('walk swings opposite arm and leg, feet near the floor, head under 1.85', ...)
it('pray stands still apart from breathing, with hands low and no bow', ...)     // spine lean under 0.1
it('coffee, chat and eat keep hands in reach and feet on the floor', ...)
it('the badge shows in any action when the status is error', ...)
// labels.test.ts
it('markerAnchor uses the standing height unless seated', ...)
// view.test.ts
it('routineAgents gives activeSince for an active task and busyUntil for a finished one, in office time', ...)
```

- [ ] **Step 2: Run them to verify they fail**, then **Step 3: Implement**, then **Step 4: Run** `rtk proxy npm test && rtk proxy npm run build`

- [ ] **Step 5: Commit** as `feat(office): characters walk, take breaks and chat through the day`

Screenshots for the PR, by the controller, using `VO_DEV_CLOCK`: walking, lunch, praying and chatting.

### Task 5: Check in a real browser (done by the controller, not an implementer)

Run on a temporary `DATA_DIR` with the mock runtime and `VO_DEV_CLOCK`, never the real `data/`.

- [ ] **A whole day at speed:** at `×60` or faster, on the default office with 14 agents and on a two-desk office with the compact row. Coffee, lunch, all five prayers, a Friday, and chats all happen.
- [ ] **Priority:** start a mock task during lunch: the agent walks home and works. Start one before a break: it stays, then takes the remainder.
- [ ] **Setting off:** an agent with `takesPrayerBreaks` off keeps working through prayer and takes ordinary lunch on Friday.
- [ ] **Nothing stored:** reload mid-walk and open a second tab: same positions. Hide the tab and return: no jump.
- [ ] **Edit mode and floor plan:** characters hidden and editing unaffected. Dots move. Delete a room mid-event: nothing breaks.
- [ ] **Clicks:** click a character mid-walk and at lunch.
- [ ] **No Claude:** with `ENABLE_CLAUDE_RUNTIME=yes` and no task, confirm by a server test that the provider is never called, and that `VO_DEV_CLOCK` is refused.
- [ ] **Cost:** `?stats` with 14 agents, at idle and while walking.
- [ ] **Docs:** the README explains the routine, `OFFICE_ROUTINE` and `VO_DEV_CLOCK`. The roadmap records slice 5 as built, with the owner's review pending. Not complete.
- [ ] Open the PR and ask the owner to watch a day, as section 8 of the spec requires.
